// routes/requisitions.js — ใบคำขอจัดซื้อ (Purchase Requisition) + เปรียบเทียบราคา (RFQ)
// Pre-PR stage: compare prices across multiple suppliers, pick a winner, then generate a PR.
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { format } from 'date-fns';

export default function (pool) {
  const router = Router();

  // ----- Tables (idempotent, created on boot) -----
  pool.query(`CREATE TABLE IF NOT EXISTS purchase_requisitions (
    id UUID PRIMARY KEY,
    rq_no VARCHAR(50) UNIQUE,
    date DATE,
    department_id UUID,
    requested_by VARCHAR(150),
    requester_name VARCHAR(150),
    requester_phone VARCHAR(50),
    purpose TEXT,
    status VARCHAR(20) DEFAULT 'open',
    selected_supplier_id UUID,
    selected_supplier_name VARCHAR(200),
    pr_no VARCHAR(50),
    items JSONB DEFAULT '[]',
    suppliers JSONB DEFAULT '[]',
    prices JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`).catch(() => {});

  pool.query(`CREATE TABLE IF NOT EXISTS rq_attachments (
    id UUID PRIMARY KEY,
    rq_no VARCHAR(50),
    item_seq INTEGER,
    supplier_seq INTEGER,
    filename VARCHAR(255),
    mimetype VARCHAR(120),
    size INTEGER,
    data TEXT,
    uploaded_by VARCHAR(150),
    created_at TIMESTAMP DEFAULT NOW()
  )`).catch(() => {});

  pool.query("INSERT INTO running_numbers (document_type, prefix, last_number, format_pattern) VALUES ('RQ','RQ',0,'RQ-YYYYMM-000') ON CONFLICT (document_type) DO NOTHING").catch(() => {});

  const SEE_ALL = ['Admin', 'Executive', 'Managing Director', 'Owner', 'Purchase Manager', 'Admin Store'];
  const DEL_ROLES = ['Admin', 'Executive', 'Managing Director', 'Owner', 'Purchase Manager'];

  // ----- List (visibility: senior = all / Manager = own dept / others = own) -----
  router.get('/', async (req, res) => {
    try {
      let q = `SELECT rq.id, rq.rq_no, rq.date, rq.status, rq.requested_by, rq.requester_name,
                 rq.selected_supplier_name, rq.pr_no, rq.purpose, d.name AS department_name,
                 jsonb_array_length(COALESCE(rq.items,'[]'::jsonb)) AS item_count,
                 jsonb_array_length(COALESCE(rq.suppliers,'[]'::jsonb)) AS supplier_count
               FROM purchase_requisitions rq LEFT JOIN departments d ON rq.department_id = d.id WHERE 1=1`;
      const params = [];
      const vrole = req.user?.role;
      if (SEE_ALL.includes(vrole)) { /* all */ }
      else if (vrole === 'Manager') { params.push(req.user?.department_id || '00000000-0000-0000-0000-000000000000'); q += ` AND rq.department_id = $${params.length}`; }
      else { params.push(req.user?.email || ''); q += ` AND lower(rq.requested_by) = lower($${params.length})`; }
      q += ' ORDER BY rq.created_at DESC LIMIT 200';
      const r = await pool.query(q, params);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Detail -----
  router.get('/:rqNo', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT rq.*, d.name AS department_name FROM purchase_requisitions rq LEFT JOIN departments d ON rq.department_id = d.id WHERE rq.rq_no = $1',
        [req.params.rqNo]);
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบใบคำขอจัดซื้อ' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Create -----
  router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { date, department_id = null, requested_by, requester_name = null, requester_phone = null, purpose = null,
        items = [], suppliers = [], prices = {}, selected_supplier_id = null, selected_supplier_name = null } = req.body || {};
      const id = uuid();
      const numR = await client.query('SELECT last_number FROM running_numbers WHERE document_type = $1 FOR UPDATE', ['RQ']);
      const yyyymm = format(new Date(), 'yyyyMM');
      const next = (numR.rows[0]?.last_number || 0) + 1;
      const rq_no = `RQ-${yyyymm}-${String(next).padStart(3, '0')}`;
      await client.query('UPDATE running_numbers SET last_number = $1 WHERE document_type = $2', [next, 'RQ']);
      await client.query(`INSERT INTO purchase_requisitions
        (id, rq_no, date, department_id, requested_by, requester_name, requester_phone, purpose, status,
         selected_supplier_id, selected_supplier_name, items, suppliers, prices)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13)`,
        [id, rq_no, date, department_id, requested_by, requester_name, requester_phone, purpose,
          selected_supplier_id, selected_supplier_name, JSON.stringify(items), JSON.stringify(suppliers), JSON.stringify(prices)]);
      await client.query('COMMIT');
      res.status(201).json({ rq_no });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
    finally { client.release(); }
  });

  // ----- Update (save edits / set selected supplier) -----
  router.put('/:rqNo', async (req, res) => {
    try {
      const { date, department_id = null, requester_name = null, requester_phone = null, purpose = null,
        items, suppliers, prices, selected_supplier_id = null, selected_supplier_name = null, status = null } = req.body || {};
      const r = await pool.query(`UPDATE purchase_requisitions SET
          date = COALESCE($1, date), department_id = $2, requester_name = $3, requester_phone = $4, purpose = $5,
          items = COALESCE($6, items), suppliers = COALESCE($7, suppliers), prices = COALESCE($8, prices),
          selected_supplier_id = $9, selected_supplier_name = $10, status = COALESCE($11, status), updated_at = NOW()
        WHERE rq_no = $12 RETURNING rq_no`,
        [date, department_id, requester_name, requester_phone, purpose,
          items ? JSON.stringify(items) : null, suppliers ? JSON.stringify(suppliers) : null, prices ? JSON.stringify(prices) : null,
          selected_supplier_id, selected_supplier_name, status, req.params.rqNo]);
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบใบคำขอจัดซื้อ' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Mark converted (called after a PR is created from this RQ) -----
  router.post('/:rqNo/convert', async (req, res) => {
    try {
      const { pr_no } = req.body || {};
      await pool.query("UPDATE purchase_requisitions SET status = 'converted', pr_no = $1, updated_at = NOW() WHERE rq_no = $2", [pr_no || null, req.params.rqNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Delete (not after converted) -----
  router.delete('/:rqNo', async (req, res) => {
    try {
      const chk = await pool.query('SELECT status, requested_by FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo]);
      if (!chk.rows[0]) return res.status(404).json({ error: 'ไม่พบใบคำขอจัดซื้อ' });
      if (chk.rows[0].status === 'converted') return res.status(400).json({ error: 'ใบที่สร้าง PR แล้วลบไม่ได้' });
      const isOwner = String(chk.rows[0].requested_by || '').toLowerCase() === String(req.user?.email || '').toLowerCase();
      if (!DEL_ROLES.includes(req.user?.role) && !isOwner) return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบใบคำขอนี้' });
      await pool.query('DELETE FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo]);
      await pool.query('DELETE FROM rq_attachments WHERE rq_no = $1', [req.params.rqNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Attachments (quote files per item × supplier) -----
  router.get('/:rqNo/attachments', async (req, res) => {
    try {
      const r = await pool.query('SELECT id, item_seq, supplier_seq, filename, mimetype, size, uploaded_by, created_at FROM rq_attachments WHERE rq_no = $1 ORDER BY created_at', [req.params.rqNo]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/:rqNo/attachments', async (req, res) => {
    try {
      const { item_seq = null, supplier_seq = null, filename, mimetype = null, data } = req.body || {};
      if (!filename || !data) return res.status(400).json({ error: 'ต้องมีชื่อไฟล์และข้อมูล' });
      const size = Math.round((String(data).length * 3) / 4);
      if (size > 20 * 1024 * 1024) return res.status(413).json({ error: 'ไฟล์ใหญ่เกิน 20MB' });
      const id = uuid();
      await pool.query('INSERT INTO rq_attachments (id, rq_no, item_seq, supplier_seq, filename, mimetype, size, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, req.params.rqNo, item_seq, supplier_seq, filename, mimetype || null, size, data, (req.user && (req.user.name || req.user.email)) || null]);
      res.status(201).json({ id, filename, mimetype, size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/:rqNo/attachments/:id/download', async (req, res) => {
    try {
      const r = await pool.query('SELECT filename, mimetype, data FROM rq_attachments WHERE id = $1 AND rq_no = $2', [req.params.id, req.params.rqNo]);
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบไฟล์' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.delete('/:rqNo/attachments/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rq_attachments WHERE id = $1 AND rq_no = $2', [req.params.id, req.params.rqNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
