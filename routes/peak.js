// routes/peak.js
// Push an issued PO from PR/PO into PEAK as a Draft purchase order (ใบสั่งซื้อ · ฉบับร่าง).
//
// Mapping relies on codes that already line up on both sides:
//   suppliers.code   -> contactCode   (e.g. A-008)
//   products.code    -> productCode   (e.g. KL-SUKL-0001)
// Nothing is matched by name against PEAK, so a rename on either side can't
// silently attach the wrong vendor or product.

import { Router } from 'express';
import peak from '../lib/peak.js';

const { isPeakConfigured, peakConfigStatus, createPurchaseOrders,
        createTransactionClassification, vatRateToType, toPeakDate } = peak;

export default function (pool) {
  const router = Router();

  const SYNC_ROLES = ['Admin', 'Purchase Manager', 'Admin Store'];
  const canSync = (req) => SYNC_ROLES.includes(req.user?.role);

  // Columns that record the PEAK side of the link (idempotent)
  pool.query(`ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS peak_code       VARCHAR(60),
    ADD COLUMN IF NOT EXISTS peak_id         VARCHAR(60),
    ADD COLUMN IF NOT EXISTS peak_status     VARCHAR(30),
    ADD COLUMN IF NOT EXISTS peak_doc_link   TEXT,
    ADD COLUMN IF NOT EXISTS peak_synced_at  TIMESTAMP,
    ADD COLUMN IF NOT EXISTS peak_error      TEXT`).catch(() => {});

  // Line items keep the product code they were issued with, so a later rename
  // in the Products master can't change what a historical PO pushed to PEAK.
  pool.query('ALTER TABLE po_items ADD COLUMN IF NOT EXISTS product_code VARCHAR(60)')
    .then(() => pool.query(`
      UPDATE po_items i SET product_code = p.code
      FROM products p
      WHERE i.product_code IS NULL AND p.name = i.product_name`))
    .catch(() => {});

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // ---- Load a PO with everything the mapper needs ----
  async function loadPO(poNo) {
    const r = await pool.query(`
      SELECT po.*, s.code AS supplier_code, s.name AS supplier_name, s.tax_id AS supplier_tax_id,
             pr.pr_no AS source_pr_no
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_requests pr ON po.pr_id = pr.id
      WHERE po.po_no = $1`, [poNo]);
    const po = r.rows[0];
    if (!po) return null;

    // COALESCE lets a line fall back to the Products master when product_code
    // was never stamped on it (rows issued before this feature existed).
    const items = await pool.query(`
      SELECT i.product_name, i.description, i.unit, i.quantity, i.unit_price,
             i.discount, i.vat_rate, i.account_code,
             COALESCE(i.product_code, p.code) AS product_code
      FROM po_items i
      LEFT JOIN products p ON p.name = i.product_name
      WHERE i.po_id = $1
      ORDER BY i.created_at`, [po.id]);
    po.items = items.rows.filter((i) => i && i.product_name);
    return po;
  }

  // ---- PR/PO -> PEAK payload ----
  function buildPayload(po) {
    const warnings = [];

    if (!po.supplier_code) {
      warnings.push({ level: 'error', message: `ผู้ขาย "${po.supplier_name || '-'}" ไม่มี Code — ตั้ง Code ให้ตรงกับ contactCode ใน PEAK ก่อน` });
    }
    if (!po.items.length) {
      warnings.push({ level: 'error', message: 'PO นี้ไม่มีรายการสินค้า' });
    }

    const products = po.items.map((it, idx) => {
      const line = {
        description: (it.description || it.product_name || '').slice(0, 1000),
        quantity: Number(it.quantity) || 0,
        price: Number(it.unit_price) || 0,
        vatType: vatRateToType(it.vat_rate),
      };
      const disc = r2(it.discount);
      if (disc > 0) line.discount = String(disc);

      if (it.product_code) {
        line.productCode = it.product_code;
      } else if (it.account_code) {
        // No product master match — fall back to the chart of accounts so the
        // document still posts, and flag it for review.
        line.accountCode = it.account_code;
        warnings.push({ level: 'warn', message: `รายการที่ ${idx + 1} "${it.product_name}" ไม่พบรหัสสินค้า ใช้รหัสบัญชี ${it.account_code} แทน` });
      } else {
        warnings.push({ level: 'error', message: `รายการที่ ${idx + 1} "${it.product_name}" ไม่มีทั้งรหัสสินค้าและรหัสบัญชี — PEAK จะไม่รับ` });
      }
      return line;
    });

    const doc = {
      issuedDate: toPeakDate(po.date) || toPeakDate(new Date()),
      contactCode: po.supplier_code || undefined,
      // Our PO number rides along as the reference so the two systems stay
      // traceable in both directions. PEAK still issues its own document number.
      reference: po.po_no,
      remark: [po.note, po.source_pr_no ? `อ้างอิง ${po.source_pr_no}` : '']
        .filter(Boolean).join(' · ')
        .slice(0, 1000) || undefined,
      taxStatus: po.price_type === 'inclusive' ? peak.TAX_STATUS.INCLUDE : peak.TAX_STATUS.EXCLUDE,
      status: 'Draft',
      products,
    };

    if (String(process.env.PEAK_SEND_DOC_CODE || '') === 'true') doc.code = po.po_no;

    const docDisc = r2(po.doc_discount);
    if (docDisc > 0) doc.discountTotal = String(docDisc);

    const tags = String(po.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.length) doc.tags = tags;

    return { doc, warnings };
  }

  // Department / Branch / Program are separate PEAK objects, applied after the
  // document exists. Best-effort: PEAK only exposes this on the new platform,
  // so a failure here is reported but never fails the sync.
  async function applyClassifications(po, docCode, docId) {
    const wanted = [
      ['DEPARTMENT', po.cat_department],
      ['BRANCH', po.cat_branch],
      ['PROGRAM', po.cat_program],
    ].filter(([, v]) => v);
    if (!wanted.length || String(process.env.PEAK_SYNC_CLASSIFICATION || '') !== 'true') return [];

    const notes = [];
    for (const [groupCode, itemNumber] of wanted) {
      try {
        const res = await createTransactionClassification({
          transactionCode: docCode, transactionId: docId,
          groupCode, itemNumber, percent: 100,
        });
        if (String(res?.resCode) !== '200') {
          notes.push({ level: 'warn', message: `ติด ${groupCode} ไม่สำเร็จ: ${res?.resDesc || 'ไม่ทราบสาเหตุ'}` });
        }
      } catch (e) {
        notes.push({ level: 'warn', message: `ติด ${groupCode} ไม่สำเร็จ: ${e.message}` });
      }
    }
    return notes;
  }

  // ---- GET /api/peak/status : is the integration wired up? ----
  router.get('/status', (req, res) => {
    if (!canSync(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
    res.json({ configured: isPeakConfigured(), ...peakConfigStatus() });
  });

  // ---- GET /api/peak/pos/:poNo/preview : dry run, nothing is sent ----
  router.get('/pos/:poNo/preview', async (req, res) => {
    if (!canSync(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ส่งข้อมูลเข้า PEAK' });
    try {
      const po = await loadPO(req.params.poNo);
      if (!po) return res.status(404).json({ error: 'ไม่พบ PO' });
      const { doc, warnings } = buildPayload(po);
      res.json({
        po_no: po.po_no,
        already_synced: Boolean(po.peak_code),
        peak_code: po.peak_code || null,
        peak_doc_link: po.peak_doc_link || null,
        blocking: warnings.some((w) => w.level === 'error'),
        warnings,
        payload: { peakPurchaseOrders: { purchaseOrders: [doc] } },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- POST /api/peak/pos/:poNo/sync : create the draft in PEAK ----
  router.post('/pos/:poNo/sync', async (req, res) => {
    if (!canSync(req)) return res.status(403).json({ error: 'ไม่มีสิทธิ์ส่งข้อมูลเข้า PEAK' });
    if (!isPeakConfigured()) {
      return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า PEAK API บนเซิร์ฟเวอร์', config: peakConfigStatus() });
    }

    const force = String(req.query.force || req.body?.force || '') === 'true';
    try {
      const po = await loadPO(req.params.poNo);
      if (!po) return res.status(404).json({ error: 'ไม่พบ PO' });

      // Sending twice would leave two drafts in PEAK for one PO, and nothing in
      // PEAK links them — so this is refused unless explicitly overridden.
      if (po.peak_code && !force) {
        return res.status(409).json({
          error: `PO นี้ส่งเข้า PEAK แล้ว (${po.peak_code})`,
          peak_code: po.peak_code,
          peak_doc_link: po.peak_doc_link,
        });
      }

      const { doc, warnings } = buildPayload(po);
      const blocking = warnings.filter((w) => w.level === 'error');
      if (blocking.length) {
        return res.status(400).json({ error: blocking.map((w) => w.message).join(' | '), warnings });
      }

      const { doc: created, envelope } = await createPurchaseOrders([doc]);

      // PEAK answers HTTP 200 even when the document was rejected; resCode is the
      // real outcome, so it has to be checked explicitly.
      if (String(created.resCode) !== '200') {
        const msg = created.resDesc || envelope.resDesc || 'PEAK ปฏิเสธเอกสาร';
        await pool.query('UPDATE purchase_orders SET peak_error = $1, peak_synced_at = NOW() WHERE id = $2', [msg, po.id]);
        return res.status(422).json({ error: msg, warnings, peak_response: created });
      }

      const classNotes = await applyClassifications(po, created.code, created.id);

      // A total that drifts from ours means the tax/discount mapping is off —
      // surface it rather than letting accounting find it later.
      const ours = r2(po.total_amount);
      const theirs = r2(created.netAmount);
      if (ours && Math.abs(ours - theirs) > 0.01) {
        warnings.push({ level: 'warn', message: `ยอดไม่ตรงกัน: PR/PO ${ours.toLocaleString()} vs PEAK ${theirs.toLocaleString()} — ตรวจการตั้งค่าภาษี/ส่วนลด` });
      }

      await pool.query(`
        UPDATE purchase_orders
        SET peak_code = $1, peak_id = $2, peak_status = $3, peak_doc_link = $4,
            peak_synced_at = NOW(), peak_error = NULL, updated_at = NOW()
        WHERE id = $5`,
        [created.code || null, created.id || null, created.status || 'Draft',
         created.documentLink || created.onlineViewLink || null, po.id]);

      res.json({
        ok: true,
        po_no: po.po_no,
        peak_code: created.code,
        peak_id: created.id,
        peak_status: created.status,
        peak_doc_link: created.documentLink || created.onlineViewLink || null,
        net_amount: created.netAmount,
        warnings: [...warnings, ...classNotes],
      });
    } catch (e) {
      try {
        await pool.query('UPDATE purchase_orders SET peak_error = $1 WHERE po_no = $2', [e.message, req.params.poNo]);
      } catch { /* logging the failure must not mask it */ }
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
