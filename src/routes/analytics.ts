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

export default router;
