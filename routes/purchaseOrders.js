// routes/purchaseOrders.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  // Issue a PO from an approved PR — supplier is chosen at this step
  router.post('/issue', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { pr_no, supplier_id } = req.body || {};
      if (!pr_no || !supplier_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ต้องระบุ pr_no และ supplier_id' });
      }
      const prR = await client.query('SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE', [pr_no]);
      const pr = prR.rows[0];
      if (!pr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบ PR' }); }
      if (pr.status !== 'Approved') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'PR ยังไม่อนุมัติครบ' }); }
      if (pr.po_no) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'PR นี้ออก PO แล้ว: ' + pr.po_no }); }

      const now = new Date();
      const yyyymm = now.toISOString().slice(0, 7).replace('-', '');
      const numR = await client.query('SELECT last_number FROM running_numbers WHERE document_type = $1 FOR UPDATE', ['PO']);
      const next = (numR.rows[0]?.last_number || 0) + 1;
      const po_no = `PO-${yyyymm}-${String(next).padStart(3, '0')}`;
      await client.query('UPDATE running_numbers SET last_number = $1 WHERE document_type = $2', [next, 'PO']);

      const po_id = uuid();
      await client.query(`
        INSERT INTO purchase_orders (id, po_no, date, pr_id, supplier_id, status, total_amount, has_vat)
        VALUES ($1, $2, CURRENT_DATE, $3, $4, 'Active', $5, $6)
      `, [po_id, po_no, pr.id, supplier_id, pr.total_amount, pr.has_vat]);

      await client.query(`
        INSERT INTO po_items (po_id, product_name, description, unit, quantity, unit_price)
        SELECT $1, product_name, description, unit, quantity, unit_price FROM pr_items WHERE pr_id = $2
      `, [po_id, pr.id]);

      await client.query('UPDATE purchase_requests SET po_no = $1, updated_at = NOW() WHERE id = $2', [po_no, pr.id]);
      await client.query('COMMIT');
      res.status(201).json({ ok: true, po_no });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  router.get('/', async (req, res) => {
    try {
      const { status, limit = 100, offset = 0 } = req.query;

      let query = `
        SELECT
          po.id, po.po_no, po.date, po.status, po.total_amount,
          s.name as supplier_name,
          json_agg(json_build_object(
            'product_name', poi.product_name,
            'quantity', poi.quantity,
            'unit_price', poi.unit_price,
            'total_price', poi.total_price
          )) as items
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        LEFT JOIN po_items poi ON po.id = poi.po_id
        WHERE 1=1
      `;
      const params = [];

      if (status) {
        query += ` AND po.status = $${params.length + 1}`;
        params.push(status);
      }

      query += ` GROUP BY po.id, s.name
                 ORDER BY po.created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:poNo', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          po.*,
          s.name as supplier_name, s.address as supplier_address,
          json_agg(json_build_object(
            'product_name', poi.product_name,
            'quantity', poi.quantity,
            'unit_price', poi.unit_price,
            'total_price', poi.total_price
          )) as items
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        LEFT JOIN po_items poi ON po.id = poi.po_id
        WHERE po.po_no = $1
        GROUP BY po.id, s.name, s.address
      `, [req.params.poNo]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'PO not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { status } = req.body;
      const result = await pool.query(
        'UPDATE purchase_orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
