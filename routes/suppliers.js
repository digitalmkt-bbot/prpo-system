// routes/suppliers.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM suppliers ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { code, name, phone, email, address } = req.body;
      const id = uuid();
      await pool.query(
        'INSERT INTO suppliers (id, code, name, phone, email, address) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, code, name, phone, email, address]
      );
      res.status(201).json({ id, code, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { code, name, phone, email, address } = req.body;
      const result = await pool.query(
        'UPDATE suppliers SET code = $1, name = $2, phone = $3, email = $4, address = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
        [code, name, phone, email, address, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
