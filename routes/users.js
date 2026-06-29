// routes/users.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';

export default function(pool) {
  const router = Router();

  // Ensure extended user columns exist (idempotent)
  pool.query(`ALTER TABLE users
    ADD COLUMN IF NOT EXISTS department_id UUID,
    ADD COLUMN IF NOT EXISTS employee_code VARCHAR(50),
    ADD COLUMN IF NOT EXISTS company VARCHAR(150),
    ADD COLUMN IF NOT EXISTS first_approver VARCHAR(150)`).catch(() => {});

  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT u.id, u.email, u.name, u.role, u.active, u.department_id,
               u.employee_code, u.company, u.first_approver, d.name AS department_name,
               (u.password_hash IS NOT NULL) AS has_password
        FROM users u LEFT JOIN departments d ON u.department_id = d.id
        ORDER BY u.name ASC`);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { email, name, role, password, department_id, employee_code, company, first_approver } = req.body;
      const id = uuid();
      const hash = password ? await bcrypt.hash(password, 10) : null;
      await pool.query(
        `INSERT INTO users (id, email, name, role, password_hash, department_id, employee_code, company, first_approver)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, email, name, role || 'Staff', hash, department_id || null, employee_code || null, company || null, first_approver || null]
      );
      res.status(201).json({ id, email, name, role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { email, name, role, active, password, department_id, employee_code, company, first_approver } = req.body;
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
      }
      const result = await pool.query(
        `UPDATE users SET email = $1, name = $2, role = $3, active = COALESCE($4, active),
           department_id = $5, employee_code = $6, company = $7, first_approver = $8, updated_at = NOW()
         WHERE id = $9 RETURNING id, email, name, role, active, department_id, employee_code, company, first_approver`,
        [email, name, role, active ?? null, department_id || null, employee_code || null, company || null, first_approver || null, req.params.id]
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

  // Admin generates a random temporary password for a user and returns it once (to hand out)
  router.post('/:id/reset-password', async (req, res) => {
    try {
      if (!req.user || req.user.role !== 'Admin') {
        return res.status(403).json({ error: 'เฉพาะ Admin เท่านั้น' });
      }
      // Readable temp password (no ambiguous chars like 0/O, 1/l)
      const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let temp = '';
      for (let i = 0; i < 10; i++) temp += chars[Math.floor(Math.random() * chars.length)];
      const hash = await bcrypt.hash(temp, 10);
      const r = await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING email, name',
        [hash, req.params.id]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
      res.json({ ok: true, email: r.rows[0].email, name: r.rows[0].name, password: temp });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
