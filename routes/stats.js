// routes/stats.js — dashboard analytics aggregates (with date/status filter)
import { Router } from 'express';

const PR_STATUSES = ['Pending', 'Approved', 'Rejected'];
const PO_STATUSES = ['Active', 'Completed', 'Cancelled'];

export default function (pool) {
  const router = Router();

  router.get('/dashboard', async (req, res) => {
    try {
      const { from, to, status } = req.query;

      // Build filter conditions for a table alias + its allowed status list
      const buildFilter = (alias, allowed) => {
        const cond = [];
        const params = [];
        if (from) { params.push(from); cond.push(`${alias}.date >= $${params.length}`); }
        if (to) { params.push(to); cond.push(`${alias}.date <= $${params.length}`); }
        if (status && allowed.includes(status)) { params.push(status); cond.push(`${alias}.status = $${params.length}`); }
        return { cond, params, where: cond.length ? 'WHERE ' + cond.join(' AND ') : '' };
      };

      const section = async (table, alias, joinTable, joinCol, joinName, allowed) => {
        const f = buildFilter(alias, allowed);
        const out = {};

        const tot = await pool.query(`SELECT COUNT(*)::int c, COALESCE(SUM(${alias}.total_amount),0)::float s FROM ${table} ${alias} ${f.where}`, f.params);
        out.total_count = tot.rows[0].c;
        out.total_amount = tot.rows[0].s;

        out.status = {};
        (await pool.query(`SELECT ${alias}.status, COUNT(*)::int c FROM ${table} ${alias} ${f.where} GROUP BY ${alias}.status`, f.params))
          .rows.forEach(r => { out.status[r.status] = r.c; });

        // daily: default last 14 days if no explicit date range
        const byDayCond = (from || to) ? f.cond : [`${alias}.date >= CURRENT_DATE - INTERVAL '13 days'`, ...f.cond];
        const byDayWhere = byDayCond.length ? 'WHERE ' + byDayCond.join(' AND ') : '';
        out.by_day = (await pool.query(`SELECT to_char(${alias}.date,'YYYY-MM-DD') d, COUNT(*)::int c, COALESCE(SUM(${alias}.total_amount),0)::float a FROM ${table} ${alias} ${byDayWhere} GROUP BY d ORDER BY d`, f.params)).rows;

        out.top = (await pool.query(`
          SELECT COALESCE(j.name,'(ไม่ระบุ)') name, COUNT(*)::int c, COALESCE(SUM(${alias}.total_amount),0)::float a
          FROM ${table} ${alias} LEFT JOIN ${joinTable} j ON ${alias}.${joinCol} = j.id
          ${f.where} GROUP BY j.name ORDER BY a DESC LIMIT 5`, f.params)).rows;

        return { f, out };
      };

      // PR section (top by department)
      const prS = await section('purchase_requests', 'pr', 'departments', 'department_id', 'name', PR_STATUSES);
      prS.out.recent = (await pool.query(`
        SELECT pr.pr_no no, to_char(pr.date,'YYYY-MM-DD') date, pr.status, pr.total_amount::float total_amount, d.name party
        FROM purchase_requests pr LEFT JOIN departments d ON pr.department_id = d.id
        ${prS.f.where} ORDER BY pr.created_at DESC LIMIT 6`, prS.f.params)).rows;

      // PO section (top by supplier)
      const poS = await section('purchase_orders', 'po', 'suppliers', 'supplier_id', 'name', PO_STATUSES);
      poS.out.recent = (await pool.query(`
        SELECT po.po_no no, to_char(po.date,'YYYY-MM-DD') date, po.status, po.total_amount::float total_amount, s.name party
        FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
        ${poS.f.where} ORDER BY po.created_at DESC LIMIT 6`, poS.f.params)).rows;

      res.json({ pr: prS.out, po: poS.out });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
