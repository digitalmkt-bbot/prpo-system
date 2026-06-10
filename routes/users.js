// routes/users.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';

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
      const { email, name, role, password } = req.body;
      const id = uuid();
      const hash = password ? await bcrypt.hash(password, 10) : null;
      await pool.query(
        'INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)',
        [id, email, name, role || 'Viewer', hash]
      );
      res.status(201).json({ id, email, name, role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { email, name, role, active, password } = req.body;
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
      }
      const result = await pool.query(
        'UPDATE users SET email = $1, name = $2, role = $3, active = COALESCE($4, active), updated_at = NOW() WHERE id = $5 RETURNING id, email, name, role, active',
        [email, name, role, active ?? null, req.params.id]
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
