// routes/products.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function(pool) {
  const router = Router();

  // Ensure category column + self-seed products from data/products.json (idempotent)
  (async () => {
    try {
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(200)');
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
      const { code, name, price, unit, category = null } = req.body;
      const id = uuid();
      await pool.query(
        'INSERT INTO products (id, code, name, price, unit, category) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, code, name, price, unit, category]
      );
      res.status(201).json({ id, code, name, price, unit, category });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { code, name, price, unit, category = null } = req.body;
      const result = await pool.query(
        'UPDATE products SET code = $1, name = $2, price = $3, unit = $4, category = $6, updated_at = NOW() WHERE id = $5 RETURNING *',
        [code, name, price, unit, req.params.id, category]
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
