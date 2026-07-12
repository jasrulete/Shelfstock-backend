import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { adminOnly } from '../middleware/adminOnly';

const router = Router();

const SEGMENTS = ['vip', 'active', 'new', 'at_risk', 'prospect'] as const;
type Segment = (typeof SEGMENTS)[number];

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// RFM-style segmentation computed live from order history, so a customer's
// segment is always current without any background job keeping it in sync.
// Rules are evaluated top-down, first match wins:
//   prospect - registered but never ordered
//   at_risk  - has ordered, but nothing in the last 60 days
//   vip      - 3+ non-cancelled orders and still active
//   new      - first order within the last 30 days
//   active   - everything else (1-2 orders, recent)
const SEGMENT_CASE = `
  CASE
    WHEN s.orders_count = 0 THEN 'prospect'
    WHEN s.last_order_at < now() - interval '60 days' THEN 'at_risk'
    WHEN s.orders_count >= 3 THEN 'vip'
    WHEN s.first_order_at >= now() - interval '30 days' THEN 'new'
    ELSE 'active'
  END
`;

// Cancelled orders are excluded from every aggregate: a cancelled order's
// stock was restored and its money never collected, so counting it would
// inflate spend and could mislabel a prospect as a customer.
const CUSTOMER_STATS_CTE = `
  WITH stats AS (
    SELECT
      u.id,
      u.email,
      u.created_at,
      COUNT(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS orders_count,
      COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0)::float AS total_spent,
      MIN(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS first_order_at,
      MAX(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS last_order_at
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    WHERE u.role = 'customer'
    GROUP BY u.id
  ),
  segmented AS (
    SELECT s.*, ${SEGMENT_CASE} AS segment
    FROM stats s
  ),
  enriched AS (
    SELECT
      seg.*,
      latest.shipping_name,
      latest.shipping_phone,
      latest.shipping_city
    FROM segmented seg
    LEFT JOIN LATERAL (
      SELECT shipping_name, shipping_phone, shipping_city
      FROM orders
      WHERE user_id = seg.id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest ON true
  )
`;

// GET /api/customers - admin CRM list: every customer with lifetime
// aggregates and a computed segment. Supports ?search= (email or shipping
// name), ?segment=, and the same page/limit pagination as /api/orders.
router.get('/', requireAuth, adminOnly, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const segment = typeof req.query.segment === 'string' ? req.query.segment : '';
  const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));
  const offset = (page - 1) * limit;

  if (segment && !SEGMENTS.includes(segment as Segment)) {
    return res.status(400).json({ error: 'Invalid segment filter' });
  }

  try {
    const values: unknown[] = [];
    const where: string[] = [];
    if (search) {
      values.push(`%${search}%`);
      where.push(`(email ILIKE $${values.length} OR shipping_name ILIKE $${values.length})`);
    }
    if (segment) {
      values.push(segment);
      where.push(`segment = $${values.length}`);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await pool.query(
      `${CUSTOMER_STATS_CTE} SELECT COUNT(*)::int AS total FROM enriched ${whereClause}`,
      values
    );
    const total = countResult.rows[0].total as number;

    values.push(limit, offset);
    const result = await pool.query(
      `${CUSTOMER_STATS_CTE}
       SELECT * FROM enriched
       ${whereClause}
       ORDER BY total_spent DESC, created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    res.json({
      customers: result.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('List customers error:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /api/customers/:id - single-customer profile: the same aggregates as
// the list plus the full order history for the activity timeline.
router.get('/:id', requireAuth, adminOnly, async (req, res) => {
  const customerId = parseId(req.params.id);
  if (customerId === null) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  try {
    const profileResult = await pool.query(
      `${CUSTOMER_STATS_CTE} SELECT * FROM enriched WHERE id = $1`,
      [customerId]
    );
    const profile = profileResult.rows[0];
    if (!profile) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const ordersResult = await pool.query(
      `SELECT
         o.id,
         o.total_amount,
         o.status,
         o.created_at,
         COALESCE(SUM(oi.quantity), 0)::int AS item_count
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [customerId]
    );

    res.json({ ...profile, orders: ordersResult.rows });
  } catch (err) {
    console.error('Get customer error:', err);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

export default router;
