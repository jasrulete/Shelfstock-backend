import { Router } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/categories - the union of the seeded categories table and any
// category an admin has typed onto a product, so the storefront filter
// always reflects what's actually purchasable.
router.get('/', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT name FROM categories
       UNION
       SELECT DISTINCT category FROM products
       ORDER BY name`
    );
    res.json(result.rows.map((r) => r.name as string));
  } catch (err) {
    console.error('List categories error:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

export default router;
