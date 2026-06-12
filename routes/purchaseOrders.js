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
      const {
        pr_no, supplier_id, reference = null, note = null,
        contact_name = null, contact_phone = null, contact_email = null,
        wht_amount = 0, items: bodyItems, pr_item_ids = [],
      } = req.body || {};
      if (!pr_no || !supplier_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ต้องระบุ pr_no และ supplier_id' });
      }
      const prR = await client.query('SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE', [pr_no]);
      const pr = prR.rows[0];
      if (!pr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบ PR' }); }
      if (pr.status !== 'Approved') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'PR ยังไม่อนุมัติครบ' }); }

      // Items: use edited items from the form, else fall back to copying PR items
      let items = Array.isArray(bodyItems) && bodyItems.length ? bodyItems
        : (await client.query("SELECT product_name, description, unit, quantity, unit_price FROM pr_items WHERE pr_id = $1 AND COALESCE(item_status,'approved') <> 'rejected' ORDER BY created_at", [pr.id]))
            .rows.map(r => ({ ...r, discount: 0, vat_rate: pr.has_vat ? 7 : 0 }));
      items = items.filter(it => it && it.product_name);

      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      let subtotal = 0, vat_amount = 0;
      items.forEach(it => {
        const base = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0) - (Number(it.discount) || 0);
        subtotal += base;
        vat_amount += base * (Number(it.vat_rate) || 0) / 100;
      });
      subtotal = r2(subtotal); vat_amount = r2(vat_amount);
      const total = r2(subtotal + vat_amount);
      const wht = r2(wht_amount);
      const net = r2(total - wht);

      const now = new Date();
      const yyyymm = now.toISOString().slice(0, 7).replace('-', '');
      const numR = await client.query('SELECT last_number FROM running_numbers WHERE document_type = $1 FOR UPDATE', ['PO']);
      const next = (numR.rows[0]?.last_number || 0) + 1;
      const po_no = `PO-${yyyymm}-${String(next).padStart(3, '0')}`;
      await client.query('UPDATE running_numbers SET last_number = $1 WHERE document_type = $2', [next, 'PO']);

      const po_id = uuid();
      await client.query(`
        INSERT INTO purchase_orders
          (id, po_no, date, pr_id, supplier_id, status, total_amount, has_vat,
           reference, note, contact_name, contact_phone, contact_email,
           subtotal, vat_amount, wht_amount, net_amount, issued_by)
        VALUES ($1,$2,CURRENT_DATE,$3,$4,'Active',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [po_id, po_no, pr.id, supplier_id, total, vat_amount > 0, reference, note,
          contact_name, contact_phone, contact_email, subtotal, vat_amount, wht, net,
          (req.user && (req.user.name || req.user.email)) || null]);

      for (const it of items) {
        await client.query(`
          INSERT INTO po_items (po_id, product_name, description, unit, quantity, unit_price, discount, vat_rate)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [po_id, it.product_name, it.description || null, it.unit || null,
            it.quantity || 0, it.unit_price || 0, it.discount || 0, it.vat_rate ?? (pr.has_vat ? 7 : 0)]);
      }

      // Mark the issued PR items so they are not issued again (enables multiple POs per PR)
      if (Array.isArray(pr_item_ids) && pr_item_ids.length) {
        await client.query('UPDATE pr_items SET po_no = $1 WHERE id = ANY($2::uuid[]) AND pr_id = $3', [po_no, pr_item_ids, pr.id]);
      }
      await client.query('UPDATE purchase_requests SET po_no = COALESCE(po_no, $1), updated_at = NOW() WHERE id = $2', [po_no, pr.id]);
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
          s.code as supplier_code, s.name as supplier_name, s.address as supplier_address,
          s.tax_id as supplier_tax_id, s.phone as supplier_phone, s.email as supplier_email,
          json_agg(json_build_object(
            'product_name', poi.product_name,
            'description', poi.description,
            'unit', poi.unit,
            'quantity', poi.quantity,
            'unit_price', poi.unit_price,
            'discount', poi.discount,
            'vat_rate', poi.vat_rate
          ) ORDER BY poi.created_at) as items
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        LEFT JOIN po_items poi ON po.id = poi.po_id
        WHERE po.po_no = $1
        GROUP BY po.id, s.code, s.name, s.address, s.tax_id, s.phone, s.email
      `, [req.params.poNo]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'PO not found' });
      }
      const po = result.rows[0];
      const co = await pool.query('SELECT name, tax_id, address, phone, email FROM company LIMIT 1');
      po.company = co.rows[0] || {};
      res.json(po);
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

  // Full update of an issued PO: header + items, with totals recalculated
  router.put('/:poNo/full', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const {
        supplier_id, reference = null, note = null,
        contact_name = null, contact_phone = null, contact_email = null,
        wht_amount = 0, items: bodyItems,
      } = req.body || {};

      const poR = await client.query('SELECT * FROM purchase_orders WHERE po_no = $1 FOR UPDATE', [req.params.poNo]);
      const po = poR.rows[0];
      if (!po) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบ PO' }); }

      const items = (Array.isArray(bodyItems) ? bodyItems : []).filter(it => it && it.product_name);
      if (!items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ต้องมีรายการอย่างน้อย 1 รายการ' }); }

      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      let subtotal = 0, vat_amount = 0;
      items.forEach(it => {
        const base = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0) - (Number(it.discount) || 0);
        subtotal += base;
        vat_amount += base * (Number(it.vat_rate) || 0) / 100;
      });
      subtotal = r2(subtotal); vat_amount = r2(vat_amount);
      const total = r2(subtotal + vat_amount);
      const wht = r2(wht_amount);
      const net = r2(total - wht);

      await client.query(`
        UPDATE purchase_orders SET
          supplier_id = COALESCE($1, supplier_id),
          reference = $2, note = $3,
          contact_name = $4, contact_phone = $5, contact_email = $6,
          subtotal = $7, vat_amount = $8, wht_amount = $9, total_amount = $10,
          net_amount = $11, has_vat = $12, updated_at = NOW()
        WHERE id = $13
      `, [supplier_id || null, reference, note, contact_name, contact_phone, contact_email,
          subtotal, vat_amount, wht, total, net, vat_amount > 0, po.id]);

      await client.query('DELETE FROM po_items WHERE po_id = $1', [po.id]);
      for (const it of items) {
        await client.query(`
          INSERT INTO po_items (po_id, product_name, description, unit, quantity, unit_price, discount, vat_rate)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [po.id, it.product_name, it.description || null, it.unit || null,
            it.quantity || 0, it.unit_price || 0, it.discount || 0, it.vat_rate ?? 0]);
      }

      await client.query('COMMIT');
      res.json({ ok: true, po_no: po.po_no });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}
