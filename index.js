require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cron = require("node-cron");
const { Resend } = require("resend");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Config ----------
const DATABASE_URL = process.env.DATABASE_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "info@cal.marketing";
const FROM_EMAIL = process.env.FROM_EMAIL || "CAL Marketing <info@cal.marketing>";
const ABANDONMENT_MINUTES = parseInt(process.env.ABANDONMENT_MINUTES || "30", 10);
const APPLY_URL = process.env.APPLY_URL || "https://cal.marketing/qualify";

if (!DATABASE_URL) console.error("[FATAL] DATABASE_URL is not set.");
if (!RESEND_API_KEY) console.error("[FATAL] RESEND_API_KEY is not set.");

// This connects to a self-managed Postgres container on Railway's private
// network, which does not have SSL enabled. Only turn SSL on if the
// connection string explicitly asks for it.
const useSSL = /sslmode=require/i.test(DATABASE_URL || "");
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

const resend = new Resend(RESEND_API_KEY);

app.use((req, res, next) => {
  // Funnel lives on a different domain (cal.marketing) than this API
  // (railway.app), so the browser requires explicit CORS headers.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// ---------- Boot: run migrations ----------
async function runMigrations() {
  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(migrationsDir).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
    console.log(`[migrations] applied ${file}`);
  }
}

// ---------- Health check ----------
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ---------- Email templates ----------
function fieldRow(label, value) {
  return `<li><strong>${label}:</strong> ${value || "—"}</li>`;
}

async function submissionEmailHtml(lead) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p><strong>✅ New CAL Marketing qualifier application submitted.</strong></p>
      <ul>
        ${fieldRow("Business name", lead.business_name)}
        ${fieldRow("Email", lead.email)}
        ${fieldRow("Phone", lead.phone)}
        ${fieldRow("Time in business", lead.time_in_business)}
        ${fieldRow("Monthly budget", lead.budget)}
        ${fieldRow("Marketing struggle", lead.marketing_struggle)}
        ${fieldRow("State", lead.state)}
      </ul>
    </div>
  `;
}

async function nurtureEmailHtml(businessName) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p>Hey${businessName ? " " + businessName : ""},</p>
      <p>You started the CAL Marketing qualifier application but didn't finish — curious what happened.</p>
      <p>If you're serious about growing, this is where you pick back up:</p>
      <p><a href="${APPLY_URL}" style="color: #d9a90f; font-weight: bold;">${APPLY_URL}</a></p>
      <p>No pressure — just didn't want you to miss it.</p>
    </div>
  `;
}

async function internalAlertHtml(lead) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p>This lead started the CAL Marketing qualifier but hasn't submitted after ${ABANDONMENT_MINUTES} minutes:</p>
      <ul>
        ${fieldRow("Business name", lead.business_name)}
        ${fieldRow("Email", lead.email)}
        ${fieldRow("Phone", lead.phone)}
        ${fieldRow("Time in business", lead.time_in_business)}
        ${fieldRow("Monthly budget", lead.budget)}
        ${fieldRow("Marketing struggle", lead.marketing_struggle)}
        ${fieldRow("State", lead.state)}
      </ul>
      <p>Reach out if you want to help them across the line.</p>
    </div>
  `;
}

// ---------- POST /api/lead ----------
// Handles two cases via the `completed` flag:
//  - completed=false (or omitted): partial/early capture — fired as soon as
//    a valid email is typed, so we have something to retarget with even if
//    they bail before hitting the final Submit button.
//  - completed=true: fired on actual form submission. Marks the lead
//    submitted and fires the internal notification email immediately —
//    no third-party webhook needed since our own frontend is the source
//    of truth for completion.
app.post("/api/lead", async (req, res) => {
  try {
    const {
      business_name,
      time_in_business,
      budget,
      marketing_struggle,
      state,
      email,
      phone,
      completed
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const isCompleted = Boolean(completed);

    const { rows } = await pool.query(
      `INSERT INTO leads (business_name, time_in_business, budget, marketing_struggle, state, email, phone, status, notified, created_at, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, NOW(), $9)
       ON CONFLICT (email) DO UPDATE SET
         business_name = EXCLUDED.business_name,
         time_in_business = EXCLUDED.time_in_business,
         budget = EXCLUDED.budget,
         marketing_struggle = EXCLUDED.marketing_struggle,
         state = EXCLUDED.state,
         phone = EXCLUDED.phone,
         status = CASE WHEN $8 = 'submitted' THEN 'submitted' ELSE leads.status END,
         submitted_at = CASE WHEN $8 = 'submitted' AND leads.status != 'submitted' THEN NOW() ELSE leads.submitted_at END
       RETURNING *, (xmax = 0) AS inserted`,
      [
        business_name || null,
        time_in_business || null,
        budget || null,
        marketing_struggle || null,
        state || null,
        normalizedEmail,
        phone || null,
        isCompleted ? "submitted" : "pending",
        isCompleted ? new Date().toISOString() : null
      ]
    );

    const lead = rows[0];
    const justSubmitted = isCompleted && lead.status === "submitted";

    // Only send the submission email the first time this lead is marked
    // submitted (avoids double-sends on retries/duplicate clicks).
    if (justSubmitted) {
      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: NOTIFY_EMAIL,
          subject: `New application: ${lead.business_name || lead.email}`,
          html: await submissionEmailHtml(lead)
        });
      } catch (sendErr) {
        console.error("[/api/lead] failed to send submission email:", sendErr);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[/api/lead] error:", err);
    // Funnel UX should not break even if lead capture fails server-side.
    res.status(200).json({ ok: false });
  }
});

// ---------- Abandonment check (runs every 5 min) ----------
async function runAbandonmentCheck() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leads
       WHERE status = 'pending'
         AND notified = FALSE
         AND created_at < NOW() - ($1 || ' minutes')::interval`,
      [ABANDONMENT_MINUTES]
    );

    if (rows.length === 0) return;

    console.log(`[abandonment] found ${rows.length} lead(s) to notify`);

    for (const lead of rows) {
      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: lead.email,
          subject: "Didn't finish your application?",
          html: await nurtureEmailHtml(lead.business_name)
        });

        await resend.emails.send({
          from: FROM_EMAIL,
          to: NOTIFY_EMAIL,
          subject: `Application not finished: ${lead.business_name || lead.email}`,
          html: await internalAlertHtml(lead)
        });

        await pool.query(`UPDATE leads SET notified = TRUE WHERE id = $1`, [lead.id]);
        console.log(`[abandonment] notified for lead id=${lead.id} (${lead.email})`);
      } catch (sendErr) {
        console.error(`[abandonment] failed to notify lead id=${lead.id}:`, sendErr);
        // Leave notified = FALSE so it retries on the next cron tick.
      }
    }
  } catch (err) {
    console.error("[abandonment] query error:", err);
  }
}

// Every 5 minutes
cron.schedule("*/5 * * * *", runAbandonmentCheck);

// ---------- Boot ----------
runMigrations()
  .then(() => {
    app.listen(PORT, () => console.log(`CAL Marketing backend listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error("[FATAL] migration failed, not starting server:", err);
    process.exit(1);
  });
