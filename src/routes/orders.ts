import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router();

interface CartItemInput {
  productId: number;
  quantity: number;
}

/**
 * POST /api/orders
 * Creates an order from a cart payload: [{ productId, quantity }, ...]
 *
 * All of this runs in a single DB transaction: we look up current prices,
 * insert the order, insert each order_item with price_at_purchase copied
 * from the product's price AT THIS MOMENT, and decrement stock. If any
 * step fails (e.g. insufficient stock) we roll back everything so we never
 * end up with a half-created order.
 */
router.post('/', requireAuth, async (req, res) => {
  const items = req.body?.items as CartItemInput[] | undefined;
  const currency = (req.body?.currency as string | undefined) ?? 'USD';

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must include at least one item' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let total = 0;
    const snapshottedItems: { productId: number; quantity: number; price: number }[] = [];

    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity <= 0) {
        throw { status: 400, message: 'Each item needs a valid productId and quantity' };
      }

      // FOR UPDATE locks the row so two concurrent checkouts can't both
      // read the same stock count and oversell the last unit.
      const productResult = await client.query(
        'SELECT id, price, stock FROM products WHERE id = $1 FOR UPDATE',
        [item.productId]
      );
      const product = productResult.rows[0];

      if (!product) {
        throw { status: 404, message: `Product ${item.productId} not found` };
      }
      if (product.stock < item.quantity) {
        throw { status: 400, message: `Insufficient stock for product ${item.productId}` };
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
      `INSERT INTO orders (user_id, total_amount, currency, status)
       VALUES ($1, $2, $3, 'completed')
       RETURNING *`,
      [req.user!.userId, total.toFixed(2), currency]
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
  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
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

export default router;
