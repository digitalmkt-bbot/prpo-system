// routes/company.js
import { Router } from 'express';

export default function(pool) {
  const router = Router();

  // Get company info
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM company LIMIT 1');
      res.json(result.rows[0] || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update company info
  router.post('/', async (req, res) => {
    try {
      const { name, tax_id, address, phone, email, bank_name, account_no, account_name, vat_rate } = req.body;

      // Get existing or create new
      const existing = await pool.query('SELECT id FROM company LIMIT 1');

      if (existing.rows.length > 0) {
        // Update
        const result = await pool.query(`
          UPDATE company SET
            name = $1, tax_id = $2, address = $3, phone = $4, email = $5,
            bank_name = $6, account_no = $7, account_name = $8, vat_rate = $9,
            updated_at = NOW()
          WHERE id = $10
          RETURNING *
        `, [name, tax_id, address, phone, email, bank_name, account_no, account_name, vat_rate, existing.rows[0].id]);
        res.json(result.rows[0]);
      } else {
        // Create
        const result = await pool.query(`
          INSERT INTO company (name, tax_id, address, phone, email, bank_name, account_no, account_name, vat_rate)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `, [name, tax_id, address, phone, email, bank_name, account_no, account_name, vat_rate]);
        res.status(201).json(result.rows[0]);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
