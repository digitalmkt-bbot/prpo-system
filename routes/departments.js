// routes/departments.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

export default function(pool) {
  const router = Router();

  // Get all departments
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM departments ORDER BY name ASC'
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get department by ID
  router.get('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM departments WHERE id = $1',
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Department not found' });
      }
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create department
  router.post('/', async (req, res) => {
    try {
      const { code, name, manager_email } = req.body;
      const id = uuid();

      await pool.query(
        'INSERT INTO departments (id, code, name, manager_email, status) VALUES ($1, $2, $3, $4, $5)',
        [id, code, name, manager_email, 'Active']
      );

      res.status(201).json({ id, code, name, manager_email });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update department
  router.put('/:id', async (req, res) => {
    try {
      const { code, name, manager_email, status } = req.body;
      const result = await pool.query(
        'UPDATE departments SET code = $1, name = $2, manager_email = $3, status = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
        [code, name, manager_email, status, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete department
  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM departments WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
