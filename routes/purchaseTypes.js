// routes/purchaseTypes.js — manage "ประเภทการจัดซื้อ" master data
import { Router } from 'express';

export default function (pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const r = await pool.query('SELECT id, name, active, sort FROM purchase_types WHERE active = true ORDER BY sort, name');
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/', async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อประเภท' });
      const max = await pool.query('SELECT COALESCE(MAX(sort),0)+1 s FROM purchase_types');
      const r = await pool.query('INSERT INTO purchase_types (name, sort) VALUES ($1, $2) RETURNING id, name', [name.trim(), max.rows[0].s]);
      res.status(201).json(r.rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ error: 'มีประเภทนี้อยู่แล้ว' });
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { name, active } = req.body || {};
      const r = await pool.query('UPDATE purchase_types SET name = COALESCE($1,name), active = COALESCE($2,active) WHERE id = $3 RETURNING *', [name, active, req.params.id]);
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM purchase_types WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
