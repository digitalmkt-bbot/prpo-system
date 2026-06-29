// routes/companies.js — multi-company master (which legal entity a user belongs to)
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function (pool) {
  const router = Router();

  // Ensure table exists + seed the default company once
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS companies (
        id UUID PRIMARY KEY,
        code VARCHAR(50),
        name VARCHAR(200) NOT NULL,
        tax_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`);
      const c = await pool.query('SELECT COUNT(*)::int n FROM companies');
      if (c.rows[0].n === 0) {
        await pool.query('INSERT INTO companies (id, code, name, tax_id) VALUES ($1,$2,$3,$4)',
          [uuid(), 'LA', 'Love Andaman', '0825554000447']);
      }
    } catch (e) {
      console.error('companies init failed:', e.message);
    }
  })();

  router.get('/', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM companies ORDER BY name ASC');
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/', async (req, res) => {
    try {
      const { code, name, tax_id } = req.body;
      if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อบริษัท' });
      const id = uuid();
      await pool.query('INSERT INTO companies (id, code, name, tax_id) VALUES ($1,$2,$3,$4)',
        [id, code || null, name, tax_id || null]);
      res.status(201).json({ id, code, name, tax_id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { code, name, tax_id } = req.body;
      const r = await pool.query(
        'UPDATE companies SET code=$1, name=$2, tax_id=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
        [code || null, name, tax_id || null, req.params.id]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM companies WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
