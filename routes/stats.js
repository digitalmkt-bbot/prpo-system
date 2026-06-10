// routes/stats.js — dashboard analytics aggregates
import { Router } from 'express';

export default function (pool) {
  const router = Router();

  router.get('/dashboard', async (req, res) => {
    try {
      const pr = {};
      const prTot = await pool.query('SELECT COUNT(*)::int c, COALESCE(SUM(total_amount),0)::float s FROM purchase_requests');
      pr.total_count = prTot.rows[0].c;
      pr.total_amount = prTot.rows[0].s;

      pr.status = {};
      (await pool.query('SELECT status, COUNT(*)::int c FROM purchase_requests GROUP BY status')).rows
        .forEach(r => { pr.status[r.status] = r.c; });

      pr.by_day = (await pool.query(`
        SELECT to_char(date,'YYYY-MM-DD') d, COUNT(*)::int c, COALESCE(SUM(total_amount),0)::float a
        FROM purchase_requests
        WHERE date >= CURRENT_DATE - INTERVAL '13 days'
        GROUP BY d ORDER BY d
      `)).rows;

      pr.top_departments = (await pool.query(`
        SELECT COALESCE(d.name,'(ไม่ระบุ)') name, COUNT(*)::int c, COALESCE(SUM(pr.total_amount),0)::float a
        FROM purchase_requests pr LEFT JOIN departments d ON pr.department_id = d.id
        GROUP BY d.name ORDER BY a DESC LIMIT 5
      `)).rows;

      pr.recent = (await pool.query(`
        SELECT pr.pr_no, to_char(pr.date,'YYYY-MM-DD') date, pr.status, pr.total_amount::float total_amount, d.name department_name
        FROM purchase_requests pr LEFT JOIN departments d ON pr.department_id = d.id
        ORDER BY pr.created_at DESC LIMIT 6
      `)).rows;

      const po = {};
      const poTot = await pool.query('SELECT COUNT(*)::int c, COALESCE(SUM(total_amount),0)::float s FROM purchase_orders');
      po.total_count = poTot.rows[0].c;
      po.total_amount = poTot.rows[0].s;

      po.status = {};
      (await pool.query('SELECT status, COUNT(*)::int c FROM purchase_orders GROUP BY status')).rows
        .forEach(r => { po.status[r.status] = r.c; });

      po.by_day = (await pool.query(`
        SELECT to_char(date,'YYYY-MM-DD') d, COUNT(*)::int c, COALESCE(SUM(total_amount),0)::float a
        FROM purchase_orders
        WHERE date >= CURRENT_DATE - INTERVAL '13 days'
        GROUP BY d ORDER BY d
      `)).rows;

      po.top_suppliers = (await pool.query(`
        SELECT COALESCE(s.name,'(ไม่ระบุ)') name, COUNT(*)::int c, COALESCE(SUM(po.total_amount),0)::float a
        FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
        GROUP BY s.name ORDER BY a DESC LIMIT 5
      `)).rows;

      po.recent = (await pool.query(`
        SELECT po.po_no, to_char(po.date,'YYYY-MM-DD') date, po.status, po.total_amount::float total_amount, s.name supplier_name
        FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
        ORDER BY po.created_at DESC LIMIT 6
      `)).rows;

      res.json({ pr, po });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
