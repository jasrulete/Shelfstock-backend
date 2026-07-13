import { pool } from '../db';
import { sendWinback } from '../mail';

// Win-back automation: customers whose last order landed 60-120 days ago
// get a single "we miss you" email. 60 days matches the CRM's at-risk
// threshold; the 120-day upper bound keeps the first deploy from blasting
// long-churned customers. A winback_emails row newer than the customer's
// last order means this lapse was already handled.
const BATCH_LIMIT = 50; // safety cap per run, well under Resend's free tier

export async function runWinbackJob(): Promise<void> {
  const storeUrl =
    process.env.STORE_URL ??
    (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',')[0].trim();

  const result = await pool.query(
    `SELECT u.id, u.email, latest.shipping_name
     FROM users u
     JOIN LATERAL (
       SELECT MAX(created_at) AS last_order_at
       FROM orders o
       WHERE o.user_id = u.id AND o.status <> 'cancelled'
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT shipping_name FROM orders
       WHERE user_id = u.id
       ORDER BY created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE u.role = 'customer'
       AND s.last_order_at BETWEEN now() - interval '120 days' AND now() - interval '60 days'
       AND NOT EXISTS (
         SELECT 1 FROM winback_emails w
         WHERE w.user_id = u.id AND w.sent_at > s.last_order_at
       )
     LIMIT $1`,
    [BATCH_LIMIT]
  );

  if (result.rows.length === 0) {
    console.log('Win-back job: no lapsed customers to email');
    return;
  }

  let sent = 0;
  for (const customer of result.rows) {
    // Only record the send if Resend actually accepted it, so a failed
    // send (e.g. unverified domain) is retried on the next run.
    if (await sendWinback(customer.email, customer.shipping_name, storeUrl)) {
      await pool.query('INSERT INTO winback_emails (user_id) VALUES ($1)', [customer.id]);
      sent++;
    }
  }
  console.log(`Win-back job: ${sent}/${result.rows.length} emails sent`);
}

export function startWinbackSchedule(): void {
  if (!process.env.RESEND_API_KEY) {
    console.log('Win-back job disabled (RESEND_API_KEY not set)');
    return;
  }
  const run = () => runWinbackJob().catch((err) => console.error('Win-back job error:', err));
  // Shortly after boot (so a daily Railway redeploy still runs it), then
  // every 24h for long-lived processes.
  setTimeout(run, 15_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}
