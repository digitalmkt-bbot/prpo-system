// routes/approval.js - Phase 3: Full Approval Workflow
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

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
      const { userEmail } = req.params;

      const result = await pool.query(`
        SELECT
          pr.pr_no, pr.date, pr.status, pr.total_amount,
          pr.current_approval_step, pr.total_approval_steps,
          s.name as supplier_name,
          am.approval_step
        FROM purchase_requests pr
        LEFT JOIN suppliers s ON pr.supplier_id = s.id
        LEFT JOIN approval_matrix am ON pr.department_id = am.department_id
        WHERE pr.status = 'Pending'
        AND pr.total_amount BETWEEN am.min_amount AND am.max_amount
        AND am.approval_step = pr.current_approval_step
        AND am.approver_email = $1
        ORDER BY pr.created_at ASC
      `, [userEmail]);

      res.json(result.rows);
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
      const { approverEmail, approverName, comment } = req.body;

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

      // Verify approver
      const approverCheck = await client.query(`
        SELECT * FROM approval_matrix
        WHERE department_id = $1
        AND approval_step = $2
        AND approver_email = $3
        AND min_amount <= $4
        AND max_amount >= $4
      `, [pr.department_id, pr.current_approval_step, approverEmail, pr.total_amount]);

      if (approverCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not authorized to approve this PR at this step' });
      }

      // Update approval chain
      const approvalChain = pr.approval_chain || [];
      approvalChain.push({
        step: pr.current_approval_step,
        approver: approverEmail,
        approverName: approverName || approverEmail,
        approveTime: new Date().toISOString(),
        comment: comment || ''
      });

      const nextStep = pr.current_approval_step + 1;

      // Check if final approval
      const isFinalApproval = nextStep > pr.total_approval_steps;

      if (isFinalApproval) {
        // Auto-generate PO
        const poNum = await generatePONumber(client);

        await client.query(`
          UPDATE purchase_requests
          SET status = $1, approved_by = $2, po_no = $3,
              current_approval_step = $4, approval_chain = $5, updated_at = NOW()
          WHERE pr_no = $6
        `, ['Approved', approverEmail, poNum, nextStep, JSON.stringify(approvalChain), prNo]);

        // Create PO
        await client.query(`
          INSERT INTO purchase_orders
          (id, po_no, date, pr_id, supplier_id, status, total_amount, has_vat)
          SELECT $1, $2, CURRENT_DATE, id, supplier_id, $3, total_amount, has_vat
          FROM purchase_requests WHERE pr_no = $4
        `, [uuid(), poNum, 'Active', prNo]);

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
          message: 'PR approved! PO created.',
          poNo: poNum
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
        res.json({
          ok: true,
          message: `Step ${pr.current_approval_step} approved. Moving to step ${nextStep}/${pr.total_approval_steps}`
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
      const { approverEmail, approverName, comment } = req.body;

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
