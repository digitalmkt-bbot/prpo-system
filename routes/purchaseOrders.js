// routes/purchaseOrders.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  // Only these roles may view / issue / edit Purchase Orders
  const PO_ROLES = ['Admin', 'Purchase Manager', 'Admin Store'];
  const canPO = (req) => PO_ROLES.includes(req.user?.role);

  // Extra document fields (idempotent)
  pool.query(`ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS quotation_no VARCHAR(80),
    ADD COLUMN IF NOT EXISTS invoice_no VARCHAR(80),
    ADD COLUMN IF NOT EXISTS tax_no VARCHAR(80),
    ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(200)`).catch(() => {});
  // PEAK-style fields: categorization, price type, doc discount, tags, draft
  pool.query(`ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS cat_department VARCHAR(150),
    ADD COLUMN IF NOT EXISTS cat_branch VARCHAR(150),
    ADD COLUMN IF NOT EXISTS cat_program VARCHAR(150),
    ADD COLUMN IF NOT EXISTS price_type VARCHAR(20) DEFAULT 'exclusive',
    ADD COLUMN IF NOT EXISTS doc_discount NUMERIC(14,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tags VARCHAR(300),
    ADD COLUMN IF NOT EXISTS is_draft BOOLEAN DEFAULT false`).catch(() => {});
  pool.query("ALTER TABLE po_items ADD COLUMN IF NOT EXISTS account_code VARCHAR(40)").catch(() => {});
  // Attachments stored inline (base64) — avoids external object storage
  pool.query(`CREATE TABLE IF NOT EXISTS po_attachments (
    id UUID PRIMARY KEY,
    po_no VARCHAR(50),
    filename VARCHAR(255),
    mimetype VARCHAR(120),
    size INTEGER,
    data TEXT,
    uploaded_by VARCHAR(150),
    created_at TIMESTAMP DEFAULT NOW()
  )`).catch(() => {});

  // Issue a PO from an approved PR — supplier is chosen at this step
  router.post('/issue', async (req, res) => {
    if (!canPO(req)) return res.status(403).json({ error: 'เฉพาะ Purchase Manager / Admin Store เท่านั้นที่ออก PO ได้' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const {
        pr_no, supplier_id, reference = null, note = null,
        contact_name = null, contact_phone = null, contact_email = null,
        wht_amount = 0, items: bodyItems, pr_item_ids = [], pr_line_qty = [], issue_date = null,
        quotation_no = null, invoice_no = null, tax_no = null, payment_terms = null,
        cat_department = null, cat_branch = null, cat_program = null,
        price_type = 'exclusive', doc_discount = 0, tags = null, is_draft = false,
      } = req.body || {};
      if (!pr_no || !supplier_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ต้องระบุ pr_no และ supplier_id' });
      }
      const prR = await client.query('SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE', [pr_no]);
      const pr = prR.rows[0];
      if (!pr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบ PR' }); }
      // PO can be issued once step 3 (Managing Director) is passed — even while Owner (step 4) is still pending
      const PO_AFTER_STEP = 3;
      if (pr.status === 'Rejected') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'PR ถูกปฏิเสธ' }); }
      if (pr.current_approval_step <= PO_AFTER_STEP) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ต้องผ่านอนุมัติขั้นที่ 3 (Managing Director) ก่อนจึงออก PO ได้' }); }

      // Items: use edited items from the form, else fall back to copying PR items
      let items = Array.isArray(bodyItems) && bodyItems.length ? bodyItems
        : (await client.query("SELECT product_name, description, unit, quantity, unit_price FROM pr_items WHERE pr_id = $1 AND COALESCE(item_status,'approved') <> 'rejected' ORDER BY created_at", [pr.id]))
            .rows.map(r => ({ ...r, discount: 0, vat_rate: pr.has_vat ? 7 : 0 }));
      items = items.filter(it => it && it.product_name);

      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const priceType = price_type === 'inclusive' ? 'inclusive' : 'exclusive';
      let subtotal = 0, vat_amount = 0;
      items.forEach(it => {
        const gross = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0) - (Number(it.discount) || 0);
        const rate = Number(it.vat_rate) || 0;
        if (priceType === 'inclusive') {
          const base = rate ? gross / (1 + rate / 100) : gross;
          subtotal += base; vat_amount += gross - base;
        } else {
          subtotal += gross; vat_amount += gross * rate / 100;
        }
      });
      subtotal = r2(subtotal); vat_amount = r2(vat_amount);
      const docDisc = r2(doc_discount);
      const total = r2(subtotal + vat_amount - docDisc);
      const wht = r2(wht_amount);
      const net = r2(total - wht);
      const poStatus = is_draft ? 'Draft' : 'Active';

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
           subtotal, vat_amount, wht_amount, net_amount, issued_by,
           quotation_no, invoice_no, tax_no, payment_terms,
           cat_department, cat_branch, cat_program, price_type, doc_discount, tags, is_draft)
        VALUES ($1,$2,COALESCE($29::date, CURRENT_DATE),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
      `, [po_id, po_no, pr.id, supplier_id, poStatus, total, vat_amount > 0, reference, note,
          contact_name, contact_phone, contact_email, subtotal, vat_amount, wht, net,
          (req.user && (req.user.name || req.user.email)) || null,
          quotation_no, invoice_no, tax_no, payment_terms,
          cat_department, cat_branch, cat_program, priceType, docDisc, tags, !!is_draft, issue_date || null]);

      for (const it of items) {
        await client.query(`
          INSERT INTO po_items (po_id, product_name, description, unit, quantity, unit_price, discount, vat_rate, account_code)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [po_id, it.product_name, it.description || null, it.unit || null,
            it.quantity || 0, it.unit_price || 0, it.discount || 0, it.vat_rate ?? (pr.has_vat ? 7 : 0), it.account_code || null]);
      }

      // Partial ordering: increment issued_qty per PR line; mark po_no only when fully issued.
      if (Array.isArray(pr_line_qty) && pr_line_qty.length) {
        for (const l of pr_line_qty) {
          if (!l || !l.id) continue;
          const qy = Number(l.quantity) || 0;
          if (qy <= 0) continue;
          await client.query(
            `UPDATE pr_items
             SET issued_qty = LEAST(COALESCE(issued_qty,0) + $1, quantity),
                 po_no = CASE WHEN COALESCE(issued_qty,0) + $1 >= quantity THEN $2 ELSE po_no END
             WHERE id = $3 AND pr_id = $4`,
            [qy, po_no, l.id, pr.id]);
        }
      } else if (Array.isArray(pr_item_ids) && pr_item_ids.length) {
        // Backward-compat: mark selected lines fully issued
        await client.query('UPDATE pr_items SET issued_qty = quantity, po_no = $1 WHERE id = ANY($2::uuid[]) AND pr_id = $3', [po_no, pr_item_ids, pr.id]);
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
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ดูใบสั่งซื้อ (PO)' });
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
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ดูใบสั่งซื้อ (PO)' });
    try {
      const result = await pool.query(`
        SELECT
          po.*,
          s.code as supplier_code, s.name as supplier_name, s.address as supplier_address,
          s.tax_id as supplier_tax_id, s.phone as supplier_phone, s.email as supplier_email,
          pr.pr_no as source_pr_no,
          json_agg(json_build_object(
            'product_name', poi.product_name,
            'description', poi.description,
            'unit', poi.unit,
            'quantity', poi.quantity,
            'unit_price', poi.unit_price,
            'discount', poi.discount,
            'vat_rate', poi.vat_rate,
            'account_code', poi.account_code
          ) ORDER BY poi.created_at) as items
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        LEFT JOIN purchase_requests pr ON po.pr_id = pr.id
        LEFT JOIN po_items poi ON po.id = poi.po_id
        WHERE po.po_no = $1
        GROUP BY po.id, s.code, s.name, s.address, s.tax_id, s.phone, s.email, pr.pr_no
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
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขใบสั่งซื้อ (PO)' });
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
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขใบสั่งซื้อ (PO)' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const {
        supplier_id, reference = null, note = null,
        contact_name = null, contact_phone = null, contact_email = null,
        wht_amount = 0, items: bodyItems, date = null,
        quotation_no = null, invoice_no = null, tax_no = null, payment_terms = null,
        cat_department = null, cat_branch = null, cat_program = null,
        price_type = 'exclusive', doc_discount = 0, tags = null, is_draft = null,
      } = req.body || {};

      const poR = await client.query('SELECT * FROM purchase_orders WHERE po_no = $1 FOR UPDATE', [req.params.poNo]);
      const po = poR.rows[0];
      if (!po) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบ PO' }); }

      const items = (Array.isArray(bodyItems) ? bodyItems : []).filter(it => it && it.product_name);
      if (!items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ต้องมีรายการอย่างน้อย 1 รายการ' }); }

      const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const priceType = price_type === 'inclusive' ? 'inclusive' : 'exclusive';
      let subtotal = 0, vat_amount = 0;
      items.forEach(it => {
        const gross = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0) - (Number(it.discount) || 0);
        const rate = Number(it.vat_rate) || 0;
        if (priceType === 'inclusive') {
          const base = rate ? gross / (1 + rate / 100) : gross;
          subtotal += base; vat_amount += gross - base;
        } else {
          subtotal += gross; vat_amount += gross * rate / 100;
        }
      });
      subtotal = r2(subtotal); vat_amount = r2(vat_amount);
      const docDisc = r2(doc_discount);
      const total = r2(subtotal + vat_amount - docDisc);
      const wht = r2(wht_amount);
      const net = r2(total - wht);

      await client.query(`
        UPDATE purchase_orders SET
          supplier_id = COALESCE($1, supplier_id),
          reference = $2, note = $3,
          contact_name = $4, contact_phone = $5, contact_email = $6,
          subtotal = $7, vat_amount = $8, wht_amount = $9, total_amount = $10,
          net_amount = $11, has_vat = $12, date = COALESCE($13::date, date),
          quotation_no = $15, invoice_no = $16, tax_no = $17, payment_terms = $18,
          cat_department = $19, cat_branch = $20, cat_program = $21,
          price_type = $22, doc_discount = $23, tags = $24,
          is_draft = COALESCE($25, is_draft), status = CASE WHEN $25 = false THEN 'Active' ELSE status END,
          updated_at = NOW()
        WHERE id = $14
      `, [supplier_id || null, reference, note, contact_name, contact_phone, contact_email,
          subtotal, vat_amount, wht, total, net, vat_amount > 0, date || null, po.id,
          quotation_no, invoice_no, tax_no, payment_terms,
          cat_department, cat_branch, cat_program, priceType, docDisc, tags,
          (is_draft === null ? null : !!is_draft)]);

      await client.query('DELETE FROM po_items WHERE po_id = $1', [po.id]);
      for (const it of items) {
        await client.query(`
          INSERT INTO po_items (po_id, product_name, description, unit, quantity, unit_price, discount, vat_rate, account_code)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [po.id, it.product_name, it.description || null, it.unit || null,
            it.quantity || 0, it.unit_price || 0, it.discount || 0, it.vat_rate ?? 0, it.account_code || null]);
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

  // Admin: wipe all transactions (PR + PO) and reset running numbers — for clearing test data
  router.post('/admin/cleanup', async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'เฉพาะ Admin เท่านั้น' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const po = await client.query('DELETE FROM purchase_orders');
      const pr = await client.query('DELETE FROM purchase_requests');
      await client.query("UPDATE running_numbers SET last_number = 0 WHERE document_type IN ('PR','PO')");
      await client.query('COMMIT');
      res.json({ ok: true, deletedPOs: po.rowCount, deletedPRs: pr.rowCount });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ===== Attachments (stored as base64 in DB) =====
  router.get('/:poNo/attachments', async (req, res) => {
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ดูใบสั่งซื้อ (PO)' });
    try {
      const r = await pool.query(
        'SELECT id, filename, mimetype, size, uploaded_by, created_at FROM po_attachments WHERE po_no=$1 ORDER BY created_at',
        [req.params.poNo]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/:poNo/attachments', async (req, res) => {
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขใบสั่งซื้อ (PO)' });
    try {
      const { filename, mimetype, data } = req.body || {};
      if (!filename || !data) return res.status(400).json({ error: 'ต้องมีชื่อไฟล์และข้อมูล' });
      const size = Math.round((String(data).length * 3) / 4); // approx bytes from base64
      if (size > 20 * 1024 * 1024) return res.status(413).json({ error: 'ไฟล์ใหญ่เกิน 20MB' });
      const id = uuid();
      await pool.query(
        'INSERT INTO po_attachments (id, po_no, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, req.params.poNo, filename, mimetype || null, size, data, (req.user && (req.user.name || req.user.email)) || null]);
      res.status(201).json({ id, filename, mimetype, size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:poNo/attachments/:id/download', async (req, res) => {
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ดูใบสั่งซื้อ (PO)' });
    try {
      const r = await pool.query('SELECT filename, mimetype, data FROM po_attachments WHERE id=$1 AND po_no=$2',
        [req.params.id, req.params.poNo]);
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบไฟล์' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:poNo/attachments/:id', async (req, res) => {
    if (!canPO(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขใบสั่งซื้อ (PO)' });
    try {
      await pool.query('DELETE FROM po_attachments WHERE id=$1 AND po_no=$2', [req.params.id, req.params.poNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
