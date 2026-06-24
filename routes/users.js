// routes/users.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';

export default function(pool) {
  const router = Router();

  // Ensure the department link column exists (idempotent)
  pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id UUID').catch(() => {});

  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT u.id, u.email, u.name, u.role, u.active, u.department_id, d.name AS department_name
        FROM users u LEFT JOIN departments d ON u.department_id = d.id
        ORDER BY u.name ASC`);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { email, name, role, password, department_id } = req.body;
      const id = uuid();
      const hash = password ? await bcrypt.hash(password, 10) : null;
      await pool.query(
        'INSERT INTO users (id, email, name, role, password_hash, department_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, email, name, role || 'Viewer', hash, department_id || null]
      );
      res.status(201).json({ id, email, name, role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { email, name, role, active, password, department_id } = req.body;
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
      }
      const result = await pool.query(
        'UPDATE users SET email = $1, name = $2, role = $3, active = COALESCE($4, active), department_id = $5, updated_at = NOW() WHERE id = $6 RETURNING id, email, name, role, active, department_id',
        [email, name, role, active ?? null, department_id || null, req.params.id]
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
