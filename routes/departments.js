// routes/departments.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

// Canonical structure: 17 departments grouped into 7 divisions.
// `oldName` lets us rename an existing department (keeping its id, so linked PRs stay intact).
const DEPTS = [
  { code: 'SEC',  name: 'SECRETARY',            division: 'Executive Office' },
  { code: 'HR',   name: 'HUMAN RESOURCES',      division: 'Human Resources' },
  { code: 'ACC',  name: 'ACCOUNTING & FINANCE', division: 'Finance & Procurement' },
  { code: 'PUR',  name: 'PURCHASE',             division: 'Finance & Procurement' },
  { code: 'MKT',  name: 'MARKETING',            division: 'Marketing & Communications' },
  { code: 'BD',   name: 'BUSINESS DEVELOPMENT', division: 'Marketing & Communications' },
  { code: 'PR',   name: 'PUBLIC RELATIONS',     division: 'Marketing & Communications' },
  { code: 'GFX',  name: 'GRAPHIC',              division: 'Marketing & Communications' },
  { code: 'SA',   name: 'SALES AGENT',          division: 'Sales & Reservation' },
  { code: 'SONL', name: 'SALE ONLINE',          division: 'Sales & Reservation' },
  { code: 'RSV',  name: 'RESERVATION',          division: 'Sales & Reservation' },
  { code: 'SRV',  name: 'SERVICE',              division: 'Operations & Service' },
  { code: 'MEC',  name: 'MECHANIC',             division: 'Operations & Service' },
  { code: 'PKTP', name: 'PHUKET PIER',          division: 'Piers', oldName: 'PHUKET PORT' },
  { code: 'TLP',  name: 'TAP LAMU PIER',        division: 'Piers', oldName: 'TAP LAMU PORT' },
  { code: 'RNGP', name: 'RANONG PIER',          division: 'Piers', oldName: 'RANONG PORT' },
  { code: 'TLPS', name: 'TAP LAMU PIER SHOP',   division: 'Piers' },
];

// Fixed display order of the 7 divisions
export const DIVISIONS = [
  'Executive Office', 'Human Resources', 'Finance & Procurement',
  'Marketing & Communications', 'Sales & Reservation', 'Operations & Service', 'Piers',
];

export default function (pool) {
  const router = Router();

  // One-time, idempotent normalization to the canonical 17 departments / 7 divisions
  (async () => {
    try {
      await pool.query('ALTER TABLE departments ADD COLUMN IF NOT EXISTS division VARCHAR(100)');
      for (const d of DEPTS) {
        // Rename an existing department in place (preserves id + linked PRs)
        if (d.oldName) {
          await pool.query(
            `UPDATE departments SET name = $1 WHERE name = $2 AND NOT EXISTS (SELECT 1 FROM departments WHERE name = $1)`,
            [d.name, d.oldName]
          );
        }
        // Set code + division on the (correctly named) row, else insert a new one
        const u = await pool.query(
          `UPDATE departments SET code = $1, division = $2, status = COALESCE(status, 'Active'), updated_at = NOW() WHERE name = $3`,
          [d.code, d.division, d.name]
        );
        if (u.rowCount === 0) {
          await pool.query(
            `INSERT INTO departments (id, code, name, division, status) VALUES ($1, $2, $3, $4, 'Active')`,
            [uuid(), d.code, d.name, d.division]
          );
        }
      }
    } catch (e) {
      console.error('Department normalization failed:', e.message);
    }
  })();

  // Get all departments
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get department by ID
  router.get('/:id', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM departments WHERE id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Department not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create department
  router.post('/', async (req, res) => {
    try {
      const { code, name, manager_email, division } = req.body;
      const id = uuid();
      await pool.query(
        'INSERT INTO departments (id, code, name, manager_email, division, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, code, name, manager_email || null, division || null, 'Active']
      );
      res.status(201).json({ id, code, name, manager_email, division });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update department
  router.put('/:id', async (req, res) => {
    try {
      const { code, name, manager_email, status, division } = req.body;
      const result = await pool.query(
        'UPDATE departments SET code = $1, name = $2, manager_email = $3, status = $4, division = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
        [code, name, manager_email || null, status || 'Active', division || null, req.params.id]
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
