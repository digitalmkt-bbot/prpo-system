// routes/suppliers.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM suppliers ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { code, name, phone, email, address } = req.body;
      const id = uuid();
      await pool.query(
        'INSERT INTO suppliers (id, code, name, phone, email, address) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, code, name, phone, email, address]
      );
      res.status(201).json({ id, code, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { code, name, phone, email, address } = req.body;
      const result = await pool.query(
        'UPDATE suppliers SET code = $1, name = $2, phone = $3, email = $4, address = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
        [code, name, phone, email, address, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk import / upsert suppliers from Excel (matched by code)
  router.post('/import', async (req, res) => {
    const client = await pool.connect();
    try {
      const list = Array.isArray(req.body?.suppliers) ? req.body.suppliers : [];
      if (!list.length) return res.status(400).json({ error: 'ไม่มีข้อมูลให้นำเข้า' });

      await client.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_id VARCHAR(50)');
      await client.query('BEGIN');

      let inserted = 0, updated = 0, skipped = 0;
      for (const s of list) {
        const code = (s.code || '').toString().trim();
        const name = (s.name || '').toString().trim();
        if (!code || !name) { skipped++; continue; }
        const phone = (s.phone || '').toString().trim() || null;
        const email = (s.email || '').toString().trim() || null;
        const address = (s.address || '').toString().trim() || null;
        const tax_id = (s.tax_id || '').toString().trim() || null;
        const r = await client.query(`
          INSERT INTO suppliers (id, code, name, phone, email, address, tax_id)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
          ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            phone = COALESCE(EXCLUDED.phone, suppliers.phone),
            email = COALESCE(EXCLUDED.email, suppliers.email),
            address = COALESCE(EXCLUDED.address, suppliers.address),
            tax_id = COALESCE(EXCLUDED.tax_id, suppliers.tax_id),
            updated_at = NOW()
          RETURNING (xmax = 0) AS is_insert
        `, [code, name, phone, email, address, tax_id]);
        if (r.rows[0]?.is_insert) inserted++; else updated++;
      }

      await client.query('COMMIT');
      res.json({ ok: true, inserted, updated, skipped, total: list.length });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}
