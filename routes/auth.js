// routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../middleware/auth.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = '12h';

export default function (pool) {
  const router = Router();

  // POST /api/auth/login  { email, password }
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' });
      }
      const r = await pool.query(
        'SELECT id, email, name, role, password_hash, active FROM users WHERE lower(email) = lower($1)',
        [email]
      );
      const u = r.rows[0];
      const badCreds = { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };
      if (!u || u.active === false) return res.status(401).json(badCreds);

      const ok = u.password_hash && (await bcrypt.compare(password, u.password_hash));
      if (!ok) return res.status(401).json(badCreds);

      const payload = { id: u.id, email: u.email, name: u.name, role: u.role };
      const token = jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL });
      res.json({ token, user: payload });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/auth/me  (requires Bearer token)
  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // POST /api/auth/change-password  { currentPassword, newPassword }
  router.post('/change-password', requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร' });
      }
      const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      const u = r.rows[0];
      if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

      const ok = u.password_hash && (await bcrypt.compare(currentPassword || '', u.password_hash));
      if (!ok) return res.status(401).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

      const hash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
        hash,
        req.user.id,
      ]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
