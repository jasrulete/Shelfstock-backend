import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { adminOnly } from '../middleware/adminOnly';
import { OrderStatus } from '../types';

const router = Router();

interface CartItemInput {
  productId: number;
  quantity: number;
}

const ORDER_STATUSES: OrderStatus[] = ['pending', 'shipped', 'completed', 'cancelled'];

function parseId(raw: string): number | null {
  // Reject "12abc", floats, negatives - anything that isn't a plain
  // positive integer - so bad ids become a 400/404, never a pg error 500.
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function cleanShippingField(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen ? trimmed : null;
}

/**
 * POST /api/orders
 * Creates an order from a cart payload plus shipping details:
 * { items: [{ productId, quantity }], shipping: { name, phone, address, city } }
 *
 * All of this runs in a single DB transaction: we look up current prices,
 * insert the order, insert each order_item with price_at_purchase copied
 * from the product's price AT THIS MOMENT, and decrement stock. If any
 * step fails (e.g. insufficient stock) we roll back everything so we never
 * end up with a half-created order.
 *
 * Totals are always computed and stored in USD - the frontend's currency
 * selector is a display-time conversion only. Trusting a client-sent
 * currency here would let one order say "PHP 44.49" for a USD total and
 * make analytics SUMs meaningless.
 */
router.post('/', requireAuth, async (req, res) => {
  const items = req.body?.items as CartItemInput[] | undefined;
  const shipping = req.body?.shipping ?? {};

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must include at least one item' });
  }
  if (items.length > 100) {
    return res.status(400).json({ error: 'Too many items in one order' });
  }

  const shippingName = cleanShippingField(shipping.name, 120);
  const shippingPhone = cleanShippingField(shipping.phone, 40);
  const shippingAddress = cleanShippingField(shipping.address, 300);
  const shippingCity = cleanShippingField(shipping.city, 120);

  if (!shippingName || !shippingPhone || !shippingAddress || !shippingCity) {
    return res
      .status(400)
      .json({ error: 'Shipping name, phone, address, and city are required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let total = 0;
    const snapshottedItems: { productId: number; quantity: number; price: number }[] = [];

    for (const item of items) {
      if (
        !Number.isSafeInteger(item?.productId) ||
        item.productId <= 0 ||
        !Number.isSafeInteger(item?.quantity) ||
        item.quantity <= 0
      ) {
        throw { status: 400, message: 'Each item needs a valid productId and a whole-number quantity' };
      }

      // FOR UPDATE locks the row so two concurrent checkouts can't both
      // read the same stock count and oversell the last unit.
      const productResult = await client.query(
        'SELECT id, name, price, stock FROM products WHERE id = $1 FOR UPDATE',
        [item.productId]
      );
      const product = productResult.rows[0];

      if (!product) {
        throw { status: 404, message: `Product ${item.productId} not found` };
      }
      if (product.stock < item.quantity) {
        throw {
          status: 400,
          message: `Insufficient stock for "${product.name}" (only ${product.stock} left)`,
        };
      }

      const price = Number(product.price);
      total += price * item.quantity;
      snapshottedItems.push({ productId: item.productId, quantity: item.quantity, price });

      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [
        item.quantity,
        item.productId,
      ]);
    }

    const orderResult = await client.query(
      `INSERT INTO orders
         (user_id, total_amount, currency, status, payment_method,
          shipping_name, shipping_phone, shipping_address, shipping_city)
       VALUES ($1, $2, 'USD', 'pending', 'cod', $3, $4, $5, $6)
       RETURNING *`,
      [req.user!.userId, total.toFixed(2), shippingName, shippingPhone, shippingAddress, shippingCity]
    );
    const order = orderResult.rows[0];

    for (const item of snapshottedItems) {
      // price_at_purchase is copied from the product row we just read, not
      // a reference to products.price. Later price changes on the product
      // will never retroactively alter this order's total.
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase)
         VALUES ($1, $2, $3, $4)`,
        [order.id, item.productId, item.quantity, item.price.toFixed(2)]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(order);
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err?.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// GET /api/orders - admin-only list of ALL orders (paginated, optional
// status filter) for the fulfillment dashboard.
router.get('/', requireAuth, adminOnly, async (req, res) => {
  const status = req.query.status as string | undefined;
  const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));
  const offset = (page - 1) * limit;

  if (status && !ORDER_STATUSES.includes(status as OrderStatus)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  try {
    const values: unknown[] = [];
    let whereClause = '';
    if (status) {
      values.push(status);
      whereClause = `WHERE o.status = $${values.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM orders o ${whereClause}`,
      values
    );
    const total = countResult.rows[0].total as number;

    values.push(limit, offset);
    const result = await pool.query(
      `SELECT o.*, u.email AS user_email
       FROM orders o
       JOIN users u ON u.id = o.user_id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    res.json({
      orders: result.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('List all orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/orders/my - the query itself is scoped to req.user.id, so there
// is no way for this handler to accidentally return another user's orders.
router.get('/my', requireAuth, async (req, res) => {
  try {
    const ordersResult = await pool.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user!.userId]
    );

    const orders = ordersResult.rows;
    if (orders.length === 0) {
      return res.json([]);
    }

    const orderIds = orders.map((o) => o.id);
    const itemsResult = await pool.query(
      `SELECT oi.*, p.name AS product_name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ANY($1::int[])`,
      [orderIds]
    );

    const itemsByOrder = new Map<number, unknown[]>();
    for (const item of itemsResult.rows) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push(item);
      itemsByOrder.set(item.order_id, list);
    }

    res.json(orders.map((o) => ({ ...o, items: itemsByOrder.get(o.id) ?? [] })));
  } catch (err) {
    console.error('List my orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/orders/:id - row-level authorization: the JWT proves who the
// user is, but we STILL explicitly check req.user.id === order.user_id
// before returning anything. A valid token alone must never be sufficient
// to read another user's order.
router.get('/:id', requireAuth, async (req, res) => {
  const orderId = parseId(req.params.id);
  if (orderId === null) {
    return res.status(404).json({ error: 'Order not found' });
  }

  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      // 404, not 403 - we don't want to confirm to a stranger that an
      // order id exists at all.
      return res.status(404).json({ error: 'Order not found' });
    }

    const itemsResult = await pool.query(
      `SELECT oi.*, p.name AS product_name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [order.id]
    );

    res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * PATCH /api/orders/:id/status - admin-only order lifecycle management.
 *
 * Cancelling an order restores the stock it reserved, inside the same
 * transaction that flips the status. 'cancelled' is terminal: once stock
 * has been restored, allowing the order back out of 'cancelled' would
 * double-count inventory.
 */
router.patch('/:id/status', requireAuth, adminOnly, async (req, res) => {
  const orderId = parseId(req.params.id);
  if (orderId === null) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const status = req.body?.status as OrderStatus | undefined;
  if (!status || !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [
      orderId,
    ]);
    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cancelled orders cannot change status' });
    }

    if (status === 'cancelled') {
      await client.query(
        `UPDATE products p
         SET stock = p.stock + oi.quantity
         FROM order_items oi
         WHERE oi.order_id = $1 AND oi.product_id = p.id`,
        [orderId]
      );
    }

    const updated = await client.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, orderId]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Failed to update order status' });
  } finally {
    client.release();
  }
});

export default router;
