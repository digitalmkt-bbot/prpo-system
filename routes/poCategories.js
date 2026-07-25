// routes/poCategories.js — PO categorization groups (แผนก / สาขา / โปรแกรม)
// Seeded from data/po_categories.json (the แผนก / department dimension)
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function (pool) {
  const router = Router();

  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS po_categories (
        id UUID PRIMARY KEY,
        grp VARCHAR(20) DEFAULT 'department',
        code VARCHAR(40),
        name VARCHAR(200),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      const c = await pool.query("SELECT COUNT(*)::int n FROM po_categories WHERE grp='department'");
      if (c.rows[0].n === 0) {
        let data = [];
        try { data = JSON.parse(readFileSync(join(__dirname, '../data/po_categories.json'), 'utf-8')); } catch {}
        for (const x of data) {
          if (!x.name) continue;
          await pool.query('INSERT INTO po_categories (id, grp, code, name) VALUES ($1,$2,$3,$4)',
            [uuid(), 'department', String(x.code || '').trim() || null, String(x.name).trim()]);
        }
        console.log('Seeded po_categories (department):', data.length);
      }
    } catch (e) { console.error('po_categories seed failed:', e.message); }
  })();

  router.get('/', async (req, res) => {
    try {
      const grp = req.query.group || null;
      const r = grp
        ? await pool.query('SELECT * FROM po_categories WHERE grp=$1 AND active<>false ORDER BY name ASC', [grp])
        : await pool.query('SELECT * FROM po_categories WHERE active<>false ORDER BY grp, name ASC');
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/', async (req, res) => {
    try {
      const { grp = 'department', code = null, name } = req.body;
      if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อ' });
      const id = uuid();
      await pool.query('INSERT INTO po_categories (id, grp, code, name) VALUES ($1,$2,$3,$4)',
        [id, grp, code || null, name]);
      res.status(201).json({ id, grp, code, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { grp, code, name, active } = req.body;
      const r = await pool.query(
        'UPDATE po_categories SET grp=COALESCE($1,grp), code=$2, name=$3, active=COALESCE($4,active) WHERE id=$5 RETURNING *',
        [grp || null, code || null, name, active ?? null, req.params.id]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:id', async (req, res) => {
    try { await pool.query('DELETE FROM po_categories WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
