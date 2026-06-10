// routes/approvalMatrix.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          am.id, am.department_id, am.min_amount, am.max_amount,
          am.approval_step, am.approver_role, am.approver_email, am.status,
          d.name as department_name
        FROM approval_matrix am
        LEFT JOIN departments d ON am.department_id = d.id
        ORDER BY d.name, am.approval_step ASC
      `);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { department_id, min_amount, max_amount, approval_step, approver_role, approver_email } = req.body;
      const id = uuid();

      await pool.query(`
        INSERT INTO approval_matrix
        (id, department_id, min_amount, max_amount, approval_step, approver_role, approver_email, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [id, department_id, min_amount, max_amount, approval_step, approver_role, approver_email, 'Active']);

      res.status(201).json({ id, department_id, approval_step });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { min_amount, max_amount, approver_email, approver_role, status } = req.body;
      const result = await pool.query(`
        UPDATE approval_matrix
        SET min_amount = $1, max_amount = $2, approver_email = $3,
            approver_role = $4, status = $5, updated_at = NOW()
        WHERE id = $6
        RETURNING *
      `, [min_amount, max_amount, approver_email, approver_role, status, req.params.id]);

      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM approval_matrix WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
