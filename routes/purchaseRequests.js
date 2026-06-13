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
          COUNT(*) FILTER (WHERE pri.id IS NOT NULL AND COALESCE(pri.item_status,'approved') <> 'rejected' AND pri.po_no IS NULL) AS unissued_count,
          json_agg(json_build_object(
            'product_name', pri.product_name,
            'quantity', pri.quantity,
            'unit_price', pri.unit_price,
            'total_price', pri.total_price
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
          (SELECT json_agg(json_build_object('po_no', po.po_no, 'supplier', sup.name, 'total', po.total_amount) ORDER BY po.created_at)
             FROM purchase_orders po LEFT JOIN suppliers sup ON po.supplier_id = sup.id
             WHERE po.pr_id = pr.id) as pos,
          json_agg(json_build_object(
            'id', pri.id,
            'product_name', pri.product_name,
            'description', pri.description,
            'unit', pri.unit,
            'quantity', pri.quantity,
            'unit_price', pri.unit_price,
            'total_price', pri.total_price,
            'item_status', pri.item_status,
            'po_no', pri.po_no
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

      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create new PR
  router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const {
        date, supplier_id = null, department_id, items, has_vat,
        requested_by, requester_name = null, needed_date = null,
        purchase_type = null, purpose = null,
      } = req.body;
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

      // Fixed 3-step approval chain for every PR (Manager → Executive → Managing Director)
      const totalSteps = 3;

      // Create PR (supplier chosen later at the PO stage)
      await client.query(`
        INSERT INTO purchase_requests
        (id, pr_no, date, supplier_id, department_id, status, total_amount, has_vat,
         requested_by, current_approval_step, total_approval_steps, approval_chain,
         requester_name, needed_date, purchase_type, purpose)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        pr_id, pr_no, date, supplier_id, department_id, 'Pending',
        total, has_vat, requested_by, 1, totalSteps, '[]',
        requester_name, needed_date || null, purchase_type, purpose
      ]);

      // Add items (total_price is a generated column — do not insert it)
      for (const item of items) {
        await client.query(`
          INSERT INTO pr_items
          (pr_id, product_name, description, unit, quantity, unit_price)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [pr_id, item.product_name, item.description || null, item.unit || null, item.quantity, item.unit_price]);
      }

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
        'SELECT id, status FROM purchase_requests WHERE pr_no = $1',
        [prNo]
      );

      if (prResult.rows.length === 0) {
        return res.status(404).json({ error: 'PR not found' });
      }

      if (prResult.rows[0].status !== 'Pending') {
        return res.status(400).json({ error: 'Can only delete pending PRs' });
      }

      await pool.query('DELETE FROM purchase_requests WHERE pr_no = $1', [prNo]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
