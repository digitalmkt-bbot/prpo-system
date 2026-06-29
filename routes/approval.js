// routes/approval.js - Phase 3: Full Approval Workflow
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();
  // 4-step approval chain (role required at each step). PO can be issued once step 3 (MD) is passed.
  const APPROVAL_CHAIN = ['Manager', 'Executive', 'Managing Director', 'Owner'];
  const PO_AFTER_STEP = 3; // after Managing Director (step 3), PO can be issued (Owner step 4 still proceeds)
  const APPROVER_ROLES = ['Admin', 'Manager', 'Executive', 'Managing Director', 'Owner'];
  // Required role for a given 1-based step (Admin can act on any step)
  const roleForStep = (step) => APPROVAL_CHAIN[step - 1] || null;

  // Get approval steps for a PR
  router.get('/steps/:prNo', async (req, res) => {
    try {
      const { prNo } = req.params;

      // Get PR details
      const prResult = await pool.query(`
        SELECT id, department_id, total_amount FROM purchase_requests WHERE pr_no = $1
      `, [prNo]);

      if (prResult.rows.length === 0) {
        return res.status(404).json({ error: 'PR not found' });
      }

      const pr = prResult.rows[0];

      // Get approval matrix rules
      const stepsResult = await pool.query(`
        SELECT * FROM approval_matrix
        WHERE department_id = $1
        AND min_amount <= $2
        AND max_amount >= $2
        ORDER BY approval_step ASC
      `, [pr.department_id, pr.total_amount]);

      res.json(stepsResult.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get approval status for a PR
  router.get('/status/:prNo', async (req, res) => {
    try {
      const { prNo } = req.params;

      const prResult = await pool.query(`
        SELECT * FROM purchase_requests WHERE pr_no = $1
      `, [prNo]);

      if (prResult.rows.length === 0) {
        return res.status(404).json({ error: 'PR not found' });
      }

      const pr = prResult.rows[0];
      const approvalChain = pr.approval_chain || [];

      // Get approval steps
      const stepsResult = await pool.query(`
        SELECT * FROM approval_matrix
        WHERE department_id = $1
        AND min_amount <= $2
        AND max_amount >= $2
        ORDER BY approval_step ASC
      `, [pr.department_id, pr.total_amount]);

      const steps = stepsResult.rows;
      const nextStep = steps[pr.current_approval_step - 1];

      res.json({
        pr_no: prNo,
        status: pr.status,
        currentStep: pr.current_approval_step,
        totalSteps: pr.total_approval_steps,
        approvalChain,
        completedApprovals: approvalChain.length,
        isPending: pr.status === 'Pending',
        nextApprovalStep: nextStep,
        steps
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get my approvals needed (PRs waiting for current user)
  router.get('/my-approvals/:userEmail', async (req, res) => {
    try {
      // Role-based: only Manager and above see pending approvals
      if (!APPROVER_ROLES.includes(req.user?.role)) {
        return res.json([]);
      }
      const result = await pool.query(`
        SELECT
          pr.pr_no, pr.date, pr.status, pr.total_amount,
          pr.current_approval_step, pr.total_approval_steps,
          pr.department_id, d.name as department_name
        FROM purchase_requests pr
        LEFT JOIN departments d ON pr.department_id = d.id
        WHERE pr.status = 'Pending'
        ORDER BY pr.created_at ASC
      `);
      // Admin sees all; others see only PRs whose current step matches their role.
      // Manager is additionally scoped to their own department.
      const isAdmin = req.user.role === 'Admin';
      const isManager = req.user.role === 'Manager';
      const rows = result.rows
        .filter(r => isAdmin || roleForStep(r.current_approval_step) === req.user.role)
        .filter(r => !isManager || String(r.department_id) === String(req.user.department_id))
        .map(r => ({ ...r, required_role: roleForStep(r.current_approval_step) }));
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Approve at current step
  router.post('/approve/:prNo', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { prNo } = req.params;
      const { comment, itemStatuses } = req.body;
      const approverEmail = req.user.email;
      const approverName = req.user.name || req.user.email;

      // Only Manager and above can approve
      if (!APPROVER_ROLES.includes(req.user.role)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'คุณไม่มีสิทธิ์อนุมัติ (ต้องเป็น Manager ขึ้นไป)' });
      }

      // Get PR and validation
      const prResult = await client.query(
        'SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE',
        [prNo]
      );

      if (prResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'PR not found' });
      }

      const pr = prResult.rows[0];

      if (pr.status !== 'Pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'PR is not pending' });
      }

      // Enforce the role required for the current approval step (Admin can act on any step)
      const requiredRole = roleForStep(pr.current_approval_step);
      if (req.user.role !== 'Admin' && req.user.role !== requiredRole) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: `ขั้นที่ ${pr.current_approval_step} ต้องอนุมัติโดย ${requiredRole}` });
      }
      // Manager can only approve PRs of their own department
      if (req.user.role === 'Manager' && String(pr.department_id) !== String(req.user.department_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Manager อนุมัติได้เฉพาะแผนกของตนเองเท่านั้น' });
      }

      // Apply per-item approve/reject decisions (if provided) and recompute total
      if (Array.isArray(itemStatuses) && itemStatuses.length) {
        for (const it of itemStatuses) {
          const st = it.status === 'rejected' ? 'rejected' : 'approved';
          await client.query('UPDATE pr_items SET item_status = $1 WHERE id = $2 AND pr_id = $3', [st, it.id, pr.id]);
        }
        const sumR = await client.query(
          "SELECT COALESCE(SUM(total_price),0) AS t FROM pr_items WHERE pr_id = $1 AND COALESCE(item_status,'approved') <> 'rejected'",
          [pr.id]
        );
        await client.query('UPDATE purchase_requests SET total_amount = $1 WHERE id = $2', [sumR.rows[0].t, pr.id]);
      }

      // Update approval chain
      const approvalChain = pr.approval_chain || [];
      approvalChain.push({
        step: pr.current_approval_step,
        role: requiredRole,
        approver: approverEmail,
        approverName: approverName || approverEmail,
        approveTime: new Date().toISOString(),
        comment: comment || ''
      });

      const nextStep = pr.current_approval_step + 1;

      // Check if final approval
      const isFinalApproval = nextStep > pr.total_approval_steps;

      if (isFinalApproval) {
        // Mark approved. PO is issued separately by Purchasing (supplier chosen at that step).
        await client.query(`
          UPDATE purchase_requests
          SET status = $1, approved_by = $2,
              current_approval_step = $3, approval_chain = $4, updated_at = NOW()
          WHERE pr_no = $5
        `, ['Approved', approverEmail, nextStep, JSON.stringify(approvalChain), prNo]);

        // Log approval history
        await client.query(`
          INSERT INTO approval_history
          (document_type, document_no, approver_email, approver_name, action, comment,
           status_before, status_after)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, ['PR', prNo, approverEmail, approverName, 'Final Approve', comment,
            'Pending', 'Approved']);

        await client.query('COMMIT');
        res.json({
          ok: true,
          message: 'PR อนุมัติครบแล้ว — พร้อมออก PO',
          status: 'Approved'
        });
      } else {
        await client.query(`
          UPDATE purchase_requests
          SET current_approval_step = $1, approval_chain = $2, updated_at = NOW()
          WHERE pr_no = $3
        `, [nextStep, JSON.stringify(approvalChain), prNo]);

        // Log approval history
        await client.query(`
          INSERT INTO approval_history
          (document_type, document_no, approver_email, approver_name, action, comment,
           status_before, status_after)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, ['PR', prNo, approverEmail, approverName, 'Step Approve', comment,
            'Pending', 'Pending']);

        await client.query('COMMIT');
        const justPassedPO = pr.current_approval_step === PO_AFTER_STEP;
        res.json({
          ok: true,
          message: justPassedPO
            ? `อนุมัติขั้นที่ ${pr.current_approval_step} (Managing Director) แล้ว — ออก PO ได้เลย (ส่งต่อขั้น ${nextStep} Owner)`
            : `อนุมัติขั้นที่ ${pr.current_approval_step} แล้ว — ส่งต่อขั้นที่ ${nextStep}/${pr.total_approval_steps}`,
          po_ready: nextStep > PO_AFTER_STEP
        });
      }
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Reject at current step
  router.post('/reject/:prNo', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { prNo } = req.params;
      const { comment } = req.body;
      const approverEmail = req.user.email;
      const approverName = req.user.name || req.user.email;

      // Only Manager and above can reject
      if (!APPROVER_ROLES.includes(req.user.role)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ปฏิเสธ (ต้องเป็น Manager ขึ้นไป)' });
      }

      // Get PR
      const prResult = await client.query(
        'SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE',
        [prNo]
      );

      if (prResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'PR not found' });
      }

      const pr = prResult.rows[0];

      // Only the role for the current step (or Admin) can reject
      const rejectRole = roleForStep(pr.current_approval_step);
      if (req.user.role !== 'Admin' && req.user.role !== rejectRole) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: `ขั้นที่ ${pr.current_approval_step} ปฏิเสธได้โดย ${rejectRole} เท่านั้น` });
      }
      // Manager can only reject PRs of their own department
      if (req.user.role === 'Manager' && String(pr.department_id) !== String(req.user.department_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Manager ปฏิเสธได้เฉพาะแผนกของตนเองเท่านั้น' });
      }

      if (pr.status !== 'Pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'PR is not pending' });
      }

      // Update PR status
      await client.query(`
        UPDATE purchase_requests
        SET status = $1, updated_at = NOW()
        WHERE pr_no = $2
      `, ['Rejected', prNo]);

      // Log approval history
      await client.query(`
        INSERT INTO approval_history
        (document_type, document_no, approver_email, approver_name, action, comment,
         status_before, status_after)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, ['PR', prNo, approverEmail, approverName, 'Reject', comment,
          'Pending', 'Rejected']);

      await client.query('COMMIT');
      res.json({ ok: true, message: 'PR rejected' });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Helper function to generate PO number
  async function generatePONumber(client) {
    const now = new Date();
    const yyyymm = now.toISOString().slice(0, 7).replace('-', '');
    const numResult = await client.query(
      'SELECT last_number FROM running_numbers WHERE document_type = $1 FOR UPDATE',
      ['PO']
    );

    const lastNum = numResult.rows[0]?.last_number || 0;
    const nextNum = lastNum + 1;
    const po_no = `PO-${yyyymm}-${String(nextNum).padStart(3, '0')}`;

    await client.query(
      'UPDATE running_numbers SET last_number = $1 WHERE document_type = $2',
      [nextNum, 'PO']
    );

    return po_no;
  }

  return router;
}
