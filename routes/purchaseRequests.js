// routes/purchaseRequests.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { format } from 'date-fns';
import { th } from 'date-fns/locale/index.js';

export default function(pool) {
  const router = Router();

  // Ensure per-item approval status + per-item issued-PO columns exist
  pool.query("ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS item_status VARCHAR(20) DEFAULT 'approved'").catch(() => {});
  pool.query("ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS po_no VARCHAR(50)").catch(() => {});
  // Product code + category (auto-filled from product master when a coded product is picked)
  pool.query("ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS code VARCHAR(80)").catch(() => {});
  pool.query("ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS category VARCHAR(200)").catch(() => {});
  // Quantity already issued onto PO(s) — enables partial ordering (เหลือ = quantity - issued_qty)
  pool.query("ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS issued_qty NUMERIC DEFAULT 0").catch(() => {});
  // Designated first approver (Manager email) copied from the creator at PR creation; null = auto (same-dept manager)
  pool.query("ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS first_approver VARCHAR(150)").catch(() => {});
  // Requester contact phone + delivery location
  pool.query("ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS requester_phone VARCHAR(50)").catch(() => {});
  pool.query("ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS delivery_location VARCHAR(150)").catch(() => {});
  // Phase 2: mandatory item detail fields + "already purchased" flag (needs evidence)
  for (const col of ['brand VARCHAR(150)', 'model VARCHAR(150)', 'size VARCHAR(150)', 'spec TEXT', 'usage_location VARCHAR(200)', 'already_done BOOLEAN DEFAULT false', 'item_seq INTEGER']) {
    pool.query(`ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  pool.query("ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS source_rq_no VARCHAR(50)").catch(() => {});
  pool.query(`CREATE TABLE IF NOT EXISTS pr_attachments (
    id UUID PRIMARY KEY, pr_no VARCHAR(50), item_seq INTEGER, kind VARCHAR(30) DEFAULT 'evidence',
    filename VARCHAR(255), mimetype VARCHAR(120), size INTEGER, data TEXT,
    uploaded_by VARCHAR(150), created_at TIMESTAMP DEFAULT NOW())`).catch(() => {});

  // Required per-item details (use "-" when not applicable)
  const REQUIRED = [['brand', 'ยี่ห้อ'], ['model', 'รุ่น'], ['size', 'ไซส์/ขนาด'], ['spec', 'สเปก'], ['usage_location', 'ลำเรือ/สถานที่ใช้งาน']];
  const missingFields = (it) => REQUIRED.filter(([k]) => !String(it[k] ?? '').trim()).map(([, l]) => l);

  // Get all PRs with optional filters
  router.get('/', async (req, res) => {
    try {
      const { status, department_id, supplier_id, limit = 100, offset = 0 } = req.query;

      let query = `
        SELECT
          pr.id, pr.pr_no, pr.date, pr.status,
          pr.total_amount, pr.has_vat, pr.requested_by, pr.po_no,
          pr.current_approval_step, pr.total_approval_steps,
          s.name as supplier_name, d.name as department_name,
          COUNT(*) FILTER (WHERE pri.id IS NOT NULL AND COALESCE(pri.item_status,'approved') <> 'rejected' AND COALESCE(pri.issued_qty,0) < pri.quantity) AS unissued_count,
          json_agg(json_build_object(
            'id', pri.id,
            'product_name', pri.product_name,
            'description', pri.description,
            'unit', pri.unit,
            'code', pri.code,
            'category', pri.category,
            'quantity', pri.quantity,
            'issued_qty', COALESCE(pri.issued_qty, 0),
            'unit_price', pri.unit_price,
            'total_price', pri.total_price,
            'item_status', pri.item_status,
            'po_no', pri.po_no,
            'brand', pri.brand, 'model', pri.model, 'size', pri.size, 'spec', pri.spec,
            'usage_location', pri.usage_location, 'already_done', pri.already_done, 'item_seq', pri.item_seq
          )) as items
        FROM purchase_requests pr
        LEFT JOIN suppliers s ON pr.supplier_id = s.id
        LEFT JOIN departments d ON pr.department_id = d.id
        LEFT JOIN pr_items pri ON pr.id = pri.pr_id
        WHERE 1=1
      `;
      const params = [];

      if (status) {
        query += ` AND pr.status = $${params.length + 1}`;
        params.push(status);
      }
      if (department_id) {
        query += ` AND pr.department_id = $${params.length + 1}`;
        params.push(department_id);
      }
      if (supplier_id) {
        query += ` AND pr.supplier_id = $${params.length + 1}`;
        params.push(supplier_id);
      }

      // Visibility: company-wide (senior) / own department (Manager) / own PRs only (Staff)
      const SEE_ALL_PR = ['Admin', 'Executive', 'Managing Director', 'Owner', 'Purchase Manager', 'Admin Store'];
      const vrole = req.user?.role;
      if (SEE_ALL_PR.includes(vrole)) {
        // sees everything — no extra filter
      } else if (vrole === 'Manager') {
        params.push(req.user?.department_id || '00000000-0000-0000-0000-000000000000');
        query += ` AND pr.department_id = $${params.length}`;
      } else {
        params.push(req.user?.email || '');
        query += ` AND lower(pr.requested_by) = lower($${params.length})`;
      }

      query += ` GROUP BY pr.id, s.name, d.name
                 ORDER BY pr.created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get PR by number
  router.get('/:prNo', async (req, res) => {
    try {
      const { prNo } = req.params;
      const result = await pool.query(`
        SELECT
          pr.*,
          s.name as supplier_name, s.address as supplier_address,
          d.name as department_name,
          COALESCE(pr.source_rq_no, (SELECT rq.rq_no FROM purchase_requisitions rq WHERE rq.pr_no = pr.pr_no ORDER BY rq.updated_at DESC LIMIT 1)) as linked_rq_no,
          (SELECT json_agg(json_build_object('po_no', po.po_no, 'supplier', sup.name, 'total', po.total_amount) ORDER BY po.created_at)
             FROM purchase_orders po LEFT JOIN suppliers sup ON po.supplier_id = sup.id
             WHERE po.pr_id = pr.id) as pos,
          json_agg(json_build_object(
            'id', pri.id,
            'product_name', pri.product_name,
            'description', pri.description,
            'unit', pri.unit,
            'code', pri.code,
            'category', pri.category,
            'quantity', pri.quantity,
            'issued_qty', COALESCE(pri.issued_qty, 0),
            'unit_price', pri.unit_price,
            'total_price', pri.total_price,
            'item_status', pri.item_status,
            'po_no', pri.po_no,
            'brand', pri.brand, 'model', pri.model, 'size', pri.size, 'spec', pri.spec,
            'usage_location', pri.usage_location, 'already_done', pri.already_done, 'item_seq', pri.item_seq
          ) ORDER BY pri.created_at) as items
        FROM purchase_requests pr
        LEFT JOIN suppliers s ON pr.supplier_id = s.id
        LEFT JOIN departments d ON pr.department_id = d.id
        LEFT JOIN pr_items pri ON pr.id = pri.pr_id
        WHERE pr.pr_no = $1
        GROUP BY pr.id, s.name, s.address, d.name
      `, [prNo]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'PR not found' });
      }

      // Visibility: company-wide (senior) / own department (Manager) / own PRs only (Staff)
      const SEE_ALL_PR = ['Admin', 'Executive', 'Managing Director', 'Owner', 'Purchase Manager', 'Admin Store'];
      const pr = result.rows[0];
      const vrole = req.user?.role;
      const myEmail = String(req.user?.email || '').toLowerCase();
      let allowed = SEE_ALL_PR.includes(vrole);
      // Manager: own department OR explicitly assigned as this PR's first approver
      if (!allowed && vrole === 'Manager') {
        allowed = String(pr.department_id) === String(req.user?.department_id)
          || String(pr.first_approver || '').toLowerCase() === myEmail;
      }
      // The creator can always view their own PR (covers Staff and any role)
      if (!allowed) allowed = String(pr.requested_by || '').toLowerCase() === myEmail;
      if (!allowed) return res.status(403).json({ error: 'ไม่มีสิทธิ์ดูใบขอซื้อนี้' });

      res.json(pr);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create new PR
  router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let {
        date, supplier_id = null, department_id, items, has_vat,
        requested_by, requester_name = null, needed_date = null,
        purchase_type = null, purpose = null,
        requester_phone = null, delivery_location = null, source_rq_no = null,
      } = req.body;
      if (!Array.isArray(items) || !items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ต้องมีรายการอย่างน้อย 1 รายการ' }); }
      for (let i = 0; i < items.length; i++) {
        const miss = missingFields(items[i]);
        if (miss.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: `รายการที่ ${i + 1} (${items[i].product_name || '-'}) ยังไม่กรอก: ${miss.join(', ')}` }); }
      }
      // Who is the requester? Always the logged-in user — except when purchasing issues a PR from a requisition,
      // in which case the PR belongs to the original requester (so visibility + approval routing follow them).
      let requesterEmail = req.user?.email || null;
      let requesterUserId = req.user?.id || null;
      let rqRow = null;
      if (source_rq_no) {
        if (!['Admin', 'Purchase Manager'].includes(req.user?.role)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'เฉพาะฝ่ายจัดซื้อ (Purchase Manager) ออก PR จากใบคำขอได้' }); }
        const rq = await client.query('SELECT * FROM purchase_requisitions WHERE rq_no = $1 FOR UPDATE', [source_rq_no]);
        rqRow = rq.rows[0];
        if (!rqRow) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบใบคำขอ ' + source_rq_no }); }
        if (rqRow.status === 'converted') { await client.query('ROLLBACK'); return res.status(400).json({ error: `ใบคำขอ ${source_rq_no} ออก PR ไปแล้ว (${rqRow.pr_no || '-'})` }); }
        if (rqRow.department_id) department_id = rqRow.department_id;
        if (!requester_name && rqRow.requester_name) requester_name = rqRow.requester_name;
        if (!requester_phone && rqRow.requester_phone) requester_phone = rqRow.requester_phone;
        if (rqRow.requested_by) {
          requesterEmail = rqRow.requested_by;
          const ru = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [rqRow.requested_by]);
          requesterUserId = ru.rows[0]?.id || null;
        }
      }
      const pr_id = uuid();

      // Generate PR Number
      const numResult = await client.query(
        'SELECT last_number FROM running_numbers WHERE document_type = $1 FOR UPDATE',
        ['PR']
      );

      const now = new Date();
      const yyyymm = format(now, 'yyyyMM');
      const lastNum = numResult.rows[0]?.last_number || 0;
      const nextNum = lastNum + 1;
      const pr_no = `PR-${yyyymm}-${String(nextNum).padStart(3, '0')}`;

      // Update running number
      await client.query(
        'UPDATE running_numbers SET last_number = $1 WHERE document_type = $2',
        [nextNum, 'PR']
      );

      // Calculate total and approval steps
      let total = 0;
      items.forEach(item => {
        total += (parseFloat(item.quantity) * parseFloat(item.unit_price));
      });

      // 2-step approval chain: Manager → (Executive OR Managing Director, final); PO issuable once Approved
      const totalSteps = 2; // Manager → Executive / Managing Director (final)

      // Resolve the creator's designated first approver (null = auto / same-dept manager)
      let firstApprover = null;
      let creatorRole = req.user?.role || '';
      try {
        const ur = await client.query('SELECT first_approver, role FROM users WHERE id = $1', [requesterUserId]);
        firstApprover = ur.rows[0]?.first_approver || null;
        creatorRole = ur.rows[0]?.role || (rqRow ? 'Staff' : creatorRole);
      } catch { /* ignore */ }

      // If a Manager creates the PR, skip the Manager step and go straight to the final step (Executive / MD).
      let startStep = 1;
      if (creatorRole === 'Manager') startStep = 2; // Manager's own PR goes straight to the final step (Executive / MD)

      // Create PR (supplier chosen later at the PO stage)
      await client.query(`
        INSERT INTO purchase_requests
        (id, pr_no, date, supplier_id, department_id, status, total_amount, has_vat,
         requested_by, current_approval_step, total_approval_steps, approval_chain,
         requester_name, needed_date, purchase_type, purpose, first_approver,
         requester_phone, delivery_location, source_rq_no)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      `, [
        pr_id, pr_no, date, supplier_id, department_id, 'Pending',
        total, has_vat, requesterEmail, startStep, totalSteps, '[]',
        requester_name, needed_date || null, purchase_type, purpose, firstApprover,
        requester_phone, delivery_location, source_rq_no
      ]);

      // Add items (total_price is a generated column — do not insert it)
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await client.query(`
          INSERT INTO pr_items
          (pr_id, product_name, description, unit, quantity, unit_price, code, category,
           brand, model, size, spec, usage_location, already_done, item_seq)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [pr_id, item.product_name, item.description || null, item.unit || null, item.quantity, item.unit_price, item.code || null, item.category || null,
            String(item.brand).trim(), String(item.model).trim(), String(item.size).trim(), String(item.spec).trim(), String(item.usage_location).trim(),
            !!item.already_done, i]);
      }

      if (rqRow) await client.query("UPDATE purchase_requisitions SET status = 'converted', pr_no = $1, updated_at = NOW() WHERE rq_no = $2", [pr_no, source_rq_no]);
      await client.query('COMMIT');
      res.status(201).json({ pr_no, total, totalSteps });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Delete PR (only if Pending)
  router.delete('/:prNo', async (req, res) => {
    try {
      const { prNo } = req.params;

      const prResult = await pool.query(
        'SELECT id, status, requested_by FROM purchase_requests WHERE pr_no = $1',
        [prNo]
      );

      if (prResult.rows.length === 0) {
        return res.status(404).json({ error: 'PR not found' });
      }

      if (prResult.rows[0].status !== 'Pending') {
        return res.status(400).json({ error: 'Can only delete pending PRs' });
      }

      // Only the creator or an authorized role may delete a pending PR
      const DELETE_ROLES = ['Admin', 'Executive', 'Managing Director', 'Owner', 'Purchase Manager'];
      const vrole = req.user?.role;
      const isOwner = String(prResult.rows[0].requested_by || '').toLowerCase() === String(req.user?.email || '').toLowerCase();
      if (!DELETE_ROLES.includes(vrole) && !isOwner) {
        return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบใบขอซื้อนี้' });
      }

      await pool.query('DELETE FROM purchase_requests WHERE pr_no = $1', [prNo]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ----- PR attachments (evidence bills / quotes) -----
  router.get('/:prNo/attachments', async (req, res) => {
    try {
      const r = await pool.query('SELECT id, item_seq, kind, filename, mimetype, size, uploaded_by, created_at FROM pr_attachments WHERE pr_no = $1 ORDER BY created_at', [req.params.prNo]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/:prNo/attachments', async (req, res) => {
    try {
      const { item_seq = null, kind = 'evidence', filename, mimetype = null, data } = req.body || {};
      if (!filename || !data) return res.status(400).json({ error: 'ต้องมีชื่อไฟล์และข้อมูล' });
      const size = Math.round((String(data).length * 3) / 4);
      if (size > 20 * 1024 * 1024) return res.status(413).json({ error: 'ไฟล์ใหญ่เกิน 20MB' });
      const id = uuid();
      await pool.query('INSERT INTO pr_attachments (id, pr_no, item_seq, kind, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, req.params.prNo, item_seq, kind, filename, mimetype, size, data, (req.user && (req.user.name || req.user.email)) || null]);
      res.status(201).json({ id, filename, size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/:prNo/attachments/:id/download', async (req, res) => {
    try {
      const r = await pool.query('SELECT filename, mimetype, data FROM pr_attachments WHERE id = $1 AND pr_no = $2', [req.params.id, req.params.prNo]);
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบไฟล์' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.delete('/:prNo/attachments/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM pr_attachments WHERE id = $1 AND pr_no = $2', [req.params.id, req.params.prNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
