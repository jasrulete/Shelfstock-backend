import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { adminOnly } from '../middleware/adminOnly';

const router = Router();

// All three endpoints below use SQL aggregates (SUM/COUNT/GROUP BY) rather
// than pulling every order into Node and reducing it in JavaScript. That
// keeps response time roughly constant as the orders table grows, and lets
// Postgres use its indexes instead of us re-implementing a scan by hand.

router.get('/summary', requireAuth, adminOnly, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(total_amount), 0)::float AS total_revenue,
        COUNT(*)::int AS total_orders
      FROM orders
      WHERE status = 'completed'
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

router.get('/revenue-over-time', requireAuth, adminOnly, async (req, res) => {
  const interval = (req.query.interval as string) === 'month' ? 'month' : 'day';
  try {
    const result = await pool.query(
      `SELECT
         date_trunc($1, created_at) AS period,
         SUM(total_amount)::float AS revenue,
         COUNT(*)::int AS orders
       FROM orders
       WHERE status = 'completed'
       GROUP BY period
       ORDER BY period ASC`,
      [interval]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Revenue over time error:', err);
    res.status(500).json({ error: 'Failed to fetch revenue over time' });
  }
});

router.get('/top-products', requireAuth, adminOnly, async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? '5', 10) || 5));
  try {
    const result = await pool.query(
      `SELECT
         p.id,
         p.name,
         SUM(oi.quantity)::int AS units_sold,
         SUM(oi.quantity * oi.price_at_purchase)::float AS revenue
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'completed'
       GROUP BY p.id, p.name
       ORDER BY units_sold DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Top products error:', err);
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});

// Operational alerts for the dashboard: products about to sell out. The
// default threshold matches the storefront's "Only X left!" badge (<= 5).
router.get('/low-stock', requireAuth, adminOnly, async (req, res) => {
  const threshold = Math.min(50, Math.max(0, parseInt((req.query.threshold as string) ?? '5', 10) || 5));
  try {
    const result = await pool.query(
      `SELECT id, name, stock
       FROM products
       WHERE stock <= $1
       ORDER BY stock ASC, name ASC
       LIMIT 20`,
      [threshold]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Low stock error:', err);
    res.status(500).json({ error: 'Failed to fetch low stock products' });
  }
});

// Orders stuck in 'pending' - for COD, a forgotten pending order is lost
// revenue, so anything older than the cutoff is surfaced on the dashboard.
router.get('/stale-orders', requireAuth, adminOnly, async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt((req.query.days as string) ?? '7', 10) || 7));
  try {
    const result = await pool.query(
      `SELECT o.id, o.total_amount, o.created_at, u.email AS user_email
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.status = 'pending' AND o.created_at < now() - make_interval(days => $1)
       ORDER BY o.created_at ASC
       LIMIT 20`,
      [days]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Stale orders error:', err);
    res.status(500).json({ error: 'Failed to fetch stale orders' });
  }
});

// Customer KPIs for the dashboard. Repeat rate is repeat buyers over all
// buyers (not all users), so signups that never ordered don't dilute it.
router.get('/customers', requireAuth, adminOnly, async (_req, res) => {
  try {
    const result = await pool.query(`
      WITH buyer_orders AS (
        SELECT user_id, COUNT(*)::int AS orders_count
        FROM orders
        WHERE status <> 'cancelled'
        GROUP BY user_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE role = 'customer') AS total_customers,
        (SELECT COUNT(*)::int FROM users
         WHERE role = 'customer' AND created_at >= now() - interval '30 days') AS new_customers,
        (SELECT COUNT(*)::int FROM buyer_orders) AS buyers,
        (SELECT COUNT(*)::int FROM buyer_orders WHERE orders_count >= 2) AS repeat_buyers
    `);
    const row = result.rows[0];
    res.json({
      total_customers: row.total_customers,
      new_customers: row.new_customers,
      repeat_rate: row.buyers > 0 ? row.repeat_buyers / row.buyers : 0,
    });
  } catch (err) {
    console.error('Customer analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch customer analytics' });
  }
});

export default router;
