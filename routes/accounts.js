// routes/accounts.js — Chart of Accounts master (seeded from data/chart_of_accounts.json)
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
      await pool.query(`CREATE TABLE IF NOT EXISTS chart_of_accounts (
        id UUID PRIMARY KEY,
        code VARCHAR(30) UNIQUE,
        name VARCHAR(250),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      const c = await pool.query('SELECT COUNT(*)::int n FROM chart_of_accounts');
      if (c.rows[0].n === 0) {
        let data = [];
        try { data = JSON.parse(readFileSync(join(__dirname, '../data/chart_of_accounts.json'), 'utf-8')); } catch {}
        for (const a of data) {
          if (!a.code || !a.name) continue;
          await pool.query(
            'INSERT INTO chart_of_accounts (id, code, name) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING',
            [uuid(), String(a.code).trim(), String(a.name).trim()]
          );
        }
        console.log('Seeded chart_of_accounts:', data.length);
      }
    } catch (e) { console.error('chart_of_accounts seed failed:', e.message); }
  })();

  router.get('/', async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM chart_of_accounts WHERE active <> false ORDER BY code ASC");
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/', async (req, res) => {
    try {
      const { code, name } = req.body;
      if (!code || !name) return res.status(400).json({ error: 'ต้องระบุรหัสและชื่อบัญชี' });
      const id = uuid();
      await pool.query(
        'INSERT INTO chart_of_accounts (id, code, name) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name',
        [id, String(code).trim(), String(name).trim()]
      );
      res.status(201).json({ id, code, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { code, name, active } = req.body;
      const r = await pool.query(
        'UPDATE chart_of_accounts SET code=$1, name=$2, active=COALESCE($3, active) WHERE id=$4 RETURNING *',
        [code, name, active ?? null, req.params.id]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:id', async (req, res) => {
    try { await pool.query('DELETE FROM chart_of_accounts WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
