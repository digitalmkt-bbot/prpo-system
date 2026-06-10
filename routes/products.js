// routes/products.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM products ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { code, name, price, unit } = req.body;
      const id = uuid();
      await pool.query(
        'INSERT INTO products (id, code, name, price, unit) VALUES ($1, $2, $3, $4, $5)',
        [id, code, name, price, unit]
      );
      res.status(201).json({ id, code, name, price, unit });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { code, name, price, unit } = req.body;
      const result = await pool.query(
        'UPDATE products SET code = $1, name = $2, price = $3, unit = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
        [code, name, price, unit, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
