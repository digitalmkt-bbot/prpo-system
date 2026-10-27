// routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../middleware/auth.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = '12h';

// One-time admin password recovery (no admin left who can reset).
// Set Railway variables ADMIN_RECOVERY_EMAIL (optional, default below) + ADMIN_RECOVERY_PASSWORD, redeploy,
// log in, then DELETE both variables. Each distinct value is applied only once (fingerprint stored),
// so a later password change is never overwritten by a leftover variable.
async function applyAdminRecovery(pool) {
  const pw = process.env.ADMIN_RECOVERY_PASSWORD;
  if (!pw) return;
  const email = (process.env.ADMIN_RECOVERY_EMAIL || 'digital.mkt@loveandaman.com').trim().toLowerCase();
  try {
    if (pw.length < 8) { console.warn('⚠️ ADMIN_RECOVERY_PASSWORD ignored: must be at least 8 characters'); return; }
    await pool.query('CREATE TABLE IF NOT EXISTS app_flags (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW())');
    const { createHash } = await import('crypto');
    const fp = createHash('sha256').update(email + '|' + pw).digest('hex');
    const done = await pool.query("SELECT value FROM app_flags WHERE key = 'admin_recovery_fp'");
    if (done.rows[0] && done.rows[0].value === fp) { console.warn('⚠️ ADMIN_RECOVERY_PASSWORD already applied — please delete it from Railway variables'); return; }
    const hash = await bcrypt.hash(pw, 10);
    const r = await pool.query("UPDATE users SET password_hash = $1, role = 'Admin', active = true, updated_at = NOW() WHERE lower(email) = $2 RETURNING email", [hash, email]);
    if (!r.rows[0]) { console.warn('⚠️ Admin recovery: user not found: ' + email); return; }
    await pool.query("INSERT INTO app_flags (key, value, updated_at) VALUES ('admin_recovery_fp', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [fp]);
    console.log('🔑 Admin password recovered for ' + email + ' — now DELETE ADMIN_RECOVERY_PASSWORD from Railway variables');
  } catch (e) { console.error('Admin recovery failed:', e.message); }
}

export default function (pool) {
  const router = Router();
  applyAdminRecovery(pool);

  // POST /api/auth/login  { email, password }
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' });
      }
      const r = await pool.query(
        'SELECT id, email, name, role, password_hash, active, department_id FROM users WHERE lower(email) = lower($1)',
        [email]
      );
      const u = r.rows[0];
      const badCreds = { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };
      if (!u || u.active === false) return res.status(401).json(badCreds);

      const ok = u.password_hash && (await bcrypt.compare(password, u.password_hash));
      if (!ok) return res.status(401).json(badCreds);

      const payload = { id: u.id, email: u.email, name: u.name, role: u.role, department_id: u.department_id || null };
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
      if (!ok) return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

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
