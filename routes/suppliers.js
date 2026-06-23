// routes/suppliers.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  // Make sure the extended supplier columns exist (idempotent)
  async function ensureCols(db) {
    await db.query(`ALTER TABLE suppliers
      ADD COLUMN IF NOT EXISTS tax_id VARCHAR(50),
      ADD COLUMN IF NOT EXISTS contact_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS branch VARCHAR(50),
      ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS business_type VARCHAR(100)`);
  }

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
      await ensureCols(pool);
      const { code, name, phone, email, address, tax_id, contact_type, branch, entity_type, business_type } = req.body;
      const id = uuid();
      await pool.query(
        `INSERT INTO suppliers (id, code, name, phone, email, address, tax_id, contact_type, branch, entity_type, business_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, code, name, phone, email, address, tax_id || null, contact_type || null, branch || null, entity_type || null, business_type || null]
      );
      res.status(201).json({ id, code, name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      await ensureCols(pool);
      const { code, name, phone, email, address, tax_id, contact_type, branch, entity_type, business_type } = req.body;
      const result = await pool.query(
        `UPDATE suppliers SET code=$1, name=$2, phone=$3, email=$4, address=$5,
           tax_id=$6, contact_type=$7, branch=$8, entity_type=$9, business_type=$10, updated_at=NOW()
         WHERE id=$11 RETURNING *`,
        [code, name, phone, email, address, tax_id || null, contact_type || null, branch || null,
         entity_type || null, business_type || null, req.params.id]
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

      await ensureCols(client);
      await client.query('BEGIN');

      const nn = v => { const x = (v == null ? '' : String(v)).trim(); return x || null; };
      let inserted = 0, updated = 0, skipped = 0;
      for (const s of list) {
        const code = (s.code || '').toString().trim();
        const name = (s.name || '').toString().trim();
        if (!code || !name) { skipped++; continue; }
        const r = await client.query(`
          INSERT INTO suppliers (id, code, name, phone, email, address, tax_id, contact_type, branch, entity_type, business_type)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            phone = COALESCE(EXCLUDED.phone, suppliers.phone),
            email = COALESCE(EXCLUDED.email, suppliers.email),
            address = COALESCE(EXCLUDED.address, suppliers.address),
            tax_id = COALESCE(EXCLUDED.tax_id, suppliers.tax_id),
            contact_type = COALESCE(EXCLUDED.contact_type, suppliers.contact_type),
            branch = COALESCE(EXCLUDED.branch, suppliers.branch),
            entity_type = COALESCE(EXCLUDED.entity_type, suppliers.entity_type),
            business_type = COALESCE(EXCLUDED.business_type, suppliers.business_type),
            updated_at = NOW()
          RETURNING (xmax = 0) AS is_insert
        `, [code, name, nn(s.phone), nn(s.email), nn(s.address), nn(s.tax_id),
            nn(s.contact_type), nn(s.branch), nn(s.entity_type), nn(s.business_type)]);
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

  // Admin: delete ALL suppliers. Removes purchase_orders first (they FK-reference suppliers).
  router.post('/admin/clear', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'เฉพาะ Admin เท่านั้น' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM purchase_orders'); // remove FK refs (po_items cascade)
      const r = await client.query('DELETE FROM suppliers');
      await client.query('COMMIT');
      res.json({ ok: true, deletedSuppliers: r.rowCount });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}
