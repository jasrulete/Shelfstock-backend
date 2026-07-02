import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { adminOnly } from '../middleware/adminOnly';

const router = Router();

const SORTABLE_COLUMNS = new Set(['price', 'name', 'created_at']);

/**
 * GET /api/products
 * Query params: search, category, minPrice, maxPrice, sort, order, page, limit
 *
 * Pagination is done in SQL with LIMIT/OFFSET rather than fetching every row
 * and slicing in JS. That keeps memory flat and query time proportional to
 * the page size regardless of how large the products table gets.
 */
router.get('/', async (req, res) => {
  try {
    const {
      search,
      category,
      minPrice,
      maxPrice,
      sort = 'created_at',
      order = 'desc',
      page = '1',
      limit = '12',
    } = req.query as Record<string, string | undefined>;

    const sortColumn = SORTABLE_COLUMNS.has(sort ?? '') ? sort : 'created_at';
    const sortOrder = order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? '12', 10) || 12));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`name ILIKE $${values.length}`);
    }
    if (category) {
      values.push(category);
      conditions.push(`category = $${values.length}`);
    }
    if (minPrice) {
      values.push(Number(minPrice));
      conditions.push(`price >= $${values.length}`);
    }
    if (maxPrice) {
      values.push(Number(maxPrice));
      conditions.push(`price <= $${values.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products ${whereClause}`,
      values
    );
    const total = countResult.rows[0].total as number;

    values.push(limitNum, offset);
    const dataResult = await pool.query(
      `SELECT id, name, description, price, category, stock, image_url, created_at
       FROM products
       ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    res.json({
      products: dataResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('List products error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get product error:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

router.post('/', requireAuth, adminOnly, async (req, res) => {
  const { name, description, price, category, stock, image_url } = req.body ?? {};

  if (!name || price === undefined || !category) {
    return res.status(400).json({ error: 'name, price, and category are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (name, description, price, category, stock, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, description ?? null, price, category, stock ?? 0, image_url ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put('/:id', requireAuth, adminOnly, async (req, res) => {
  const { name, description, price, category, stock, image_url } = req.body ?? {};

  try {
    const result = await pool.query(
      `UPDATE products
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           price = COALESCE($3, price),
           category = COALESCE($4, category),
           stock = COALESCE($5, stock),
           image_url = COALESCE($6, image_url)
       WHERE id = $7
       RETURNING *`,
      [name, description, price, category, stock, image_url, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/:id', requireAuth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

export default router;
