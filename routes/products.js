// routes/products.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Friendly Thai messages for common DB errors
const dbError = (res, err, code) => {
  if (err.code === '23505') return res.status(409).json({ error: `รหัสสินค้า "${code}" มีอยู่แล้วในระบบ — ใช้รหัสอื่น หรือค้นหาแล้วกด "แก้ไข" รายการเดิม` });
  if (err.code === '22001') return res.status(400).json({ error: 'ข้อความยาวเกินกำหนด (รหัสไม่เกิน 100 ตัวอักษร)' });
  if (err.code === '22P02') return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง (เช่น ราคา ต้องเป็นตัวเลข)' });
  return res.status(500).json({ error: err.message });
};

export default function(pool) {
  const router = Router();

  // Ensure category column + self-seed products from data/products.json (idempotent)
  (async () => {
    try {
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(200)');
      await pool.query('ALTER TABLE products ALTER COLUMN code TYPE VARCHAR(100)').catch(() => {});
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()').catch(() => {});
      let data = [];
      try { data = JSON.parse(readFileSync(join(__dirname, '../data/products.json'), 'utf-8')); } catch {}
      if (!data.length) return;
      // Import only rows whose code is not already present (idempotent, safe on reboot)
      const existing = await pool.query('SELECT code FROM products WHERE code IS NOT NULL');
      const have = new Set(existing.rows.map(r => String(r.code)));
      let added = 0;
      for (const p of data) {
        const code = String(p.code || '').trim();
        if (!code || have.has(code) || !p.name) continue;
        await pool.query(
          'INSERT INTO products (id, code, name, price, unit, category) VALUES ($1,$2,$3,$4,$5,$6)',
          [uuid(), code, String(p.name).trim(), 0, String(p.unit || '').trim() || null, String(p.category || '').trim() || null]
        );
        have.add(code); added++;
      }
      if (added) console.log('Seeded products:', added);
    } catch (e) { console.error('products seed failed:', e.message); }
  })();

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
      let { code, name, price, unit, category = null } = req.body || {};
      code = String(code || '').trim(); name = String(name || '').trim();
      if (!code || !name) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อสินค้า' });
      price = Number(price) || 0;
      const id = uuid();
      await pool.query(
        'INSERT INTO products (id, code, name, price, unit, category) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, code, name, price, unit || null, category || null]
      );
      res.status(201).json({ id, code, name, price, unit, category });
    } catch (err) {
      dbError(res, err, String((req.body && req.body.code) || "").trim());
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      let { code, name, price, unit, category = null } = req.body || {};
      code = String(code || '').trim(); name = String(name || '').trim();
      if (!code || !name) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อสินค้า' });
      price = Number(price) || 0;
      const result = await pool.query(
        'UPDATE products SET code = $1, name = $2, price = $3, unit = $4, category = $6, updated_at = NOW() WHERE id = $5 RETURNING *',
        [code, name, price, unit || null, req.params.id, category || null]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'ไม่พบสินค้านี้ (อาจถูกลบไปแล้ว) — รีเฟรชหน้าแล้วลองใหม่' });
      res.json(result.rows[0]);
    } catch (err) {
      dbError(res, err, String((req.body && req.body.code) || "").trim());
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
