// routes/users.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT id, email, name, role, active FROM users ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { email, name, role } = req.body;
      const id = uuid();
      await pool.query(
        'INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)',
        [id, email, name, role || 'Viewer']
      );
      res.status(201).json({ id, email, name, role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { email, name, role, active } = req.body;
      const result = await pool.query(
        'UPDATE users SET email = $1, name = $2, role = $3, active = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
        [email, name, role, active, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
