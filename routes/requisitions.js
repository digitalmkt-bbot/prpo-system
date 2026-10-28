// routes/requisitions.js — ขอใบเสนอราคา (Purchase Requisition) + เปรียบเทียบราคา (RFQ)
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

  // Review by Purchase Manager: open (= waiting review) → approved | returned (fix & resubmit) | rejected; approved → converted (PR issued)
  setTimeout(() => {
    for (const col of ['review_note TEXT', 'reviewed_by VARCHAR(150)', 'reviewed_at TIMESTAMP', "history JSONB DEFAULT '[]'"])
      pool.query(`ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }, 1500);

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
  )`).catch(() => {})
    // per-item files (many per item, keyed by a stable item uid) + who uploaded them — after the table exists
    .then(() => pool.query('ALTER TABLE rq_attachments ADD COLUMN IF NOT EXISTS item_uid VARCHAR(40)')).catch(() => {})
    .then(() => pool.query('ALTER TABLE rq_attachments ADD COLUMN IF NOT EXISTS uploaded_email VARCHAR(150)')).catch(() => {});

  pool.query("INSERT INTO running_numbers (document_type, prefix, last_number, format_pattern) VALUES ('RQ','RQ',0,'RQ-YYYYMM-000') ON CONFLICT (document_type) DO NOTHING").catch(() => {});

  const SEE_ALL = ['Admin', 'Executive', 'Managing Director', 'Owner', 'Purchase Manager', 'Admin Store'];
  const DEL_ROLES = ['Admin', 'Executive', 'Managing Director', 'Owner', 'Purchase Manager'];
  // Only purchasing may enter supplier quotes / pick the winner / issue the PR from a requisition
  const QUOTE_ROLES = ['Admin', 'Purchase Manager'];
  const canQuote = (req) => QUOTE_ROLES.includes(req.user?.role);
  const who = (req) => (req.user && (req.user.name || req.user.email)) || null;
  const histEntry = (req, action, reason = '') => JSON.stringify([{ action, reason: reason || '', by: who(req), email: req.user?.email || null, at: new Date().toISOString() }]);
  // requester may edit / attach only while it is waiting review or sent back
  const OWNER_EDITABLE = ['open', 'returned'];

  // ----- List (visibility: senior = all / Manager = own dept / others = own) -----
  router.get('/', async (req, res) => {
    try {
      let q = `SELECT rq.id, rq.rq_no, rq.date, rq.status, rq.requested_by, rq.requester_name, rq.updated_at, rq.review_note,
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
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบขอใบเสนอราคา' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Create -----
  router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { date, department_id = null, requested_by, requester_name = null, requester_phone = null, purpose = null,
        items = [], selected_supplier_id = null } = req.body || {};
      let { suppliers = [], prices = {}, selected_supplier_name = null } = req.body || {};
      if (!canQuote(req)) { suppliers = []; prices = {}; selected_supplier_name = null; }
      const requested_by_safe = req.user?.email || requested_by || null;
      const id = uuid();
      const numR = await client.query('SELECT last_number FROM running_numbers WHERE document_type = $1 FOR UPDATE', ['RQ']);
      const yyyymm = format(new Date(), 'yyyyMM');
      const next = (numR.rows[0]?.last_number || 0) + 1;
      const rq_no = `RQ-${yyyymm}-${String(next).padStart(3, '0')}`;
      await client.query('UPDATE running_numbers SET last_number = $1 WHERE document_type = $2', [next, 'RQ']);
      await client.query(`INSERT INTO purchase_requisitions
        (id, rq_no, date, department_id, requested_by, requester_name, requester_phone, purpose, status,
         selected_supplier_id, selected_supplier_name, items, suppliers, prices, history)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$14)`,
        [id, rq_no, date, department_id, requested_by_safe, requester_name, requester_phone, purpose,
          selected_supplier_id, selected_supplier_name, JSON.stringify(items), JSON.stringify(suppliers), JSON.stringify(prices), histEntry(req, 'submit')]);
      await client.query('COMMIT');
      res.status(201).json({ rq_no });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
    finally { client.release(); }
  });

  // ----- Update (save edits / set selected supplier) -----
  router.put('/:rqNo', async (req, res) => {
    try {
      const cur = await pool.query('SELECT status, requested_by, suppliers, prices, selected_supplier_id, selected_supplier_name FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'ไม่พบขอใบเสนอราคา' });
      const st = cur.rows[0].status;
      if (st === 'converted') return res.status(400).json({ error: 'ใบนี้ออก PR แล้ว แก้ไขไม่ได้' });
      if (st === 'rejected') return res.status(400).json({ error: 'ใบนี้ไม่ได้รับการอนุมัติ (ปิดแล้ว) แก้ไขไม่ได้ — สร้างขอใบเสนอราคาใหม่' });
      const isOwner = String(cur.rows[0].requested_by || '').toLowerCase() === String(req.user?.email || '').toLowerCase();
      if (!canQuote(req) && !isOwner) return res.status(403).json({ error: 'แก้ไขได้เฉพาะผู้ขอหรือฝ่ายจัดซื้อ' });
      if (!canQuote(req) && !OWNER_EDITABLE.includes(st)) return res.status(403).json({ error: 'ฝ่ายจัดซื้ออนุมัติใบนี้แล้ว — แก้ไขไม่ได้ หากต้องการเปลี่ยนแปลงโปรดติดต่อ Purchase Manager' });
      const resubmit = !canQuote(req) && st === 'returned';
      let { date, department_id = null, requester_name = null, requester_phone = null, purpose = null,
        items, suppliers, prices, selected_supplier_id = null, selected_supplier_name = null } = req.body || {};
      const status = resubmit ? 'open' : null; // requester fixing a returned request → back to review
      if (!canQuote(req)) { // requester: keep purchasing's quotes untouched
        suppliers = null; prices = null;
        selected_supplier_id = cur.rows[0].selected_supplier_id; selected_supplier_name = cur.rows[0].selected_supplier_name;
      }
      const r = await pool.query(`UPDATE purchase_requisitions SET
          date = COALESCE($1, date), department_id = $2, requester_name = $3, requester_phone = $4, purpose = $5,
          items = COALESCE($6, items), suppliers = COALESCE($7, suppliers), prices = COALESCE($8, prices),
          selected_supplier_id = $9, selected_supplier_name = $10, status = COALESCE($11, status), updated_at = NOW(),
          history = CASE WHEN $11::text = 'open' THEN COALESCE(history, '[]'::jsonb) || $13::jsonb ELSE history END
        WHERE rq_no = $12 RETURNING rq_no`,
        [date, department_id, requester_name, requester_phone, purpose,
          items ? JSON.stringify(items) : null, suppliers ? JSON.stringify(suppliers) : null, prices ? JSON.stringify(prices) : null,
          selected_supplier_id, selected_supplier_name, status, req.params.rqNo, histEntry(req, 'resubmit')]);
      if (!r.rows[0]) return res.status(404).json({ error: 'ไม่พบขอใบเสนอราคา' });
      res.json({ ok: true, status: status || st });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Purchase Manager review: approve / return (fix & resubmit) / reject -----
  router.post('/:rqNo/review', async (req, res) => {
    try {
      if (!canQuote(req)) return res.status(403).json({ error: 'เฉพาะ Purchase Manager อนุมัติขอใบเสนอราคาได้' });
      const { action, reason = '' } = req.body || {};
      const MAP = { approve: 'approved', return: 'returned', reject: 'rejected' };
      if (!MAP[action]) return res.status(400).json({ error: 'action ต้องเป็น approve / return / reject' });
      if (action !== 'approve' && !String(reason).trim()) return res.status(400).json({ error: action === 'return' ? 'กรุณาระบุเหตุผลที่ตีกลับ' : 'กรุณาระบุเหตุผลที่ไม่อนุมัติ' });
      const cur = (await pool.query('SELECT status FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo])).rows[0];
      if (!cur) return res.status(404).json({ error: 'ไม่พบขอใบเสนอราคา' });
      if (cur.status === 'converted') return res.status(400).json({ error: 'ใบนี้ออก PR แล้ว' });
      if (cur.status === 'rejected') return res.status(400).json({ error: 'ใบนี้ไม่อนุมัติไปแล้ว' });
      if (action === 'approve' && cur.status === 'returned') return res.status(400).json({ error: 'ใบนี้ถูกตีกลับ — รอผู้ขอแก้ไขและส่งกลับก่อน' });
      await pool.query(`UPDATE purchase_requisitions SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW(),
          history = COALESCE(history, '[]'::jsonb) || $4::jsonb WHERE rq_no = $5`,
        [MAP[action], String(reason).trim() || null, who(req), histEntry(req, action, String(reason).trim()), req.params.rqNo]);
      res.json({ ok: true, status: MAP[action] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Mark converted (called after a PR is created from this RQ) -----
  router.post('/:rqNo/convert', async (req, res) => {
    try {
      if (!canQuote(req)) return res.status(403).json({ error: 'เฉพาะฝ่ายจัดซื้อ (Purchase Manager) ออก PR จากขอใบเสนอราคาได้' });
      const { pr_no } = req.body || {};
      const cs = (await pool.query('SELECT status FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo])).rows[0];
      if (cs && !['approved', 'converted'].includes(cs.status)) return res.status(400).json({ error: 'ขอใบเสนอราคายังไม่ได้รับการอนุมัติ' });
      await pool.query("UPDATE purchase_requisitions SET status = 'converted', pr_no = $1, updated_at = NOW() WHERE rq_no = $2", [pr_no || null, req.params.rqNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Delete (not after converted) -----
  router.delete('/:rqNo', async (req, res) => {
    try {
      const chk = await pool.query('SELECT status, requested_by FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo]);
      if (!chk.rows[0]) return res.status(404).json({ error: 'ไม่พบขอใบเสนอราคา' });
      if (chk.rows[0].status === 'converted') return res.status(400).json({ error: 'ใบที่สร้าง PR แล้วลบไม่ได้' });
      const isOwner = String(chk.rows[0].requested_by || '').toLowerCase() === String(req.user?.email || '').toLowerCase();
      if (!DEL_ROLES.includes(req.user?.role) && !isOwner) return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบขอใบเสนอราคานี้' });
      await pool.query('DELETE FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo]);
      await pool.query('DELETE FROM rq_attachments WHERE rq_no = $1', [req.params.rqNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- Attachments (quote files per item × supplier) -----
  router.get('/:rqNo/attachments', async (req, res) => {
    try {
      const r = await pool.query('SELECT id, item_seq, item_uid, supplier_seq, filename, mimetype, size, uploaded_by, uploaded_email, created_at FROM rq_attachments WHERE rq_no = $1 ORDER BY created_at', [req.params.rqNo]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/:rqNo/attachments', async (req, res) => {
    try {
      const { item_seq = null, item_uid = null, supplier_seq = null, filename, mimetype = null, data } = req.body || {};
      if (!filename || !data) return res.status(400).json({ error: 'ต้องมีชื่อไฟล์และข้อมูล' });
      const rq = (await pool.query('SELECT status, requested_by FROM purchase_requisitions WHERE rq_no = $1', [req.params.rqNo])).rows[0];
      if (!rq) return res.status(404).json({ error: 'ไม่พบขอใบเสนอราคา' });
      const isOwner = String(rq.requested_by || '').toLowerCase() === String(req.user?.email || '').toLowerCase();
      if (supplier_seq != null) {
        if (!canQuote(req)) return res.status(403).json({ error: 'เฉพาะฝ่ายจัดซื้อแนบใบเสนอราคาได้' });
      } else {
        if (!item_uid) return res.status(400).json({ error: 'ไม่ระบุรายการที่จะแนบไฟล์' });
        if (!canQuote(req) && !(isOwner && OWNER_EDITABLE.includes(rq.status))) return res.status(403).json({ error: 'แนบไฟล์ได้เฉพาะผู้ขอ (ขณะรอตรวจหรือถูกตีกลับ) หรือฝ่ายจัดซื้อ' });
      }
      const size = Math.round((String(data).length * 3) / 4);
      if (size > 20 * 1024 * 1024) return res.status(413).json({ error: 'ไฟล์ใหญ่เกิน 20MB' });
      const id = uuid();
      await pool.query('INSERT INTO rq_attachments (id, rq_no, item_seq, item_uid, supplier_seq, filename, mimetype, size, data, uploaded_by, uploaded_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [id, req.params.rqNo, item_seq, item_uid, supplier_seq, filename, mimetype || null, size, data, (req.user && (req.user.name || req.user.email)) || null, req.user?.email || null]);
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
      if (!canQuote(req)) {
        const a = (await pool.query('SELECT a.uploaded_email, rq.status FROM rq_attachments a JOIN purchase_requisitions rq ON rq.rq_no = a.rq_no WHERE a.id = $1 AND a.rq_no = $2', [req.params.id, req.params.rqNo])).rows[0];
        const mine = a && String(a.uploaded_email || '').toLowerCase() === String(req.user?.email || '').toLowerCase();
        if (!mine || !OWNER_EDITABLE.includes(a.status)) return res.status(403).json({ error: 'ลบได้เฉพาะไฟล์ของตัวเอง (ก่อนออก PR) หรือฝ่ายจัดซื้อ' });
      }
      await pool.query('DELETE FROM rq_attachments WHERE id = $1 AND rq_no = $2', [req.params.id, req.params.rqNo]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
