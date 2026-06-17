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

        // daily: continuous series (fills empty days with 0) — default last 14 days, or the chosen range
        const dayParams = [];
        let startSql, endSql;
        if (from) { dayParams.push(from); startSql = `$${dayParams.length}::date`; } else { startSql = "CURRENT_DATE - INTERVAL '13 days'"; }
        if (to) { dayParams.push(to); endSql = `$${dayParams.length}::date`; } else { endSql = 'CURRENT_DATE'; }
        let statusJoin = '';
        if (status && allowed.includes(status)) { dayParams.push(status); statusJoin = ` AND ${alias}.status = $${dayParams.length}`; }
        out.by_day = (await pool.query(`
          SELECT to_char(gs.d,'YYYY-MM-DD') d, COUNT(${alias}.id)::int c, COALESCE(SUM(${alias}.total_amount),0)::float a
          FROM generate_series(${startSql}, ${endSql}, INTERVAL '1 day') gs(d)
          LEFT JOIN ${table} ${alias} ON ${alias}.date = gs.d::date${statusJoin}
          GROUP BY gs.d ORDER BY gs.d
        `, dayParams)).rows;

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

      // Product report (by individual product name) — combines PR + PO items, respects date/status filter
      const prodParams = [];
      const mkWhere = (alias, allowed) => {
        const cond = [];
        if (from) { prodParams.push(from); cond.push(`${alias}.date >= $${prodParams.length}`); }
        if (to) { prodParams.push(to); cond.push(`${alias}.date <= $${prodParams.length}`); }
        if (status && allowed.includes(status)) { prodParams.push(status); cond.push(`${alias}.status = $${prodParams.length}`); }
        return cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      };
      const wPr = mkWhere('pr', PR_STATUSES);
      const wPo = mkWhere('po', PO_STATUSES);
      const prod = (await pool.query(`
        SELECT name, SUM(total)::float AS value, COUNT(*)::int AS orders, SUM(qty)::float AS qty
        FROM (
          SELECT btrim(pri.product_name) AS name, COALESCE(pri.total_price,0) AS total, COALESCE(pri.quantity,0) AS qty
          FROM pr_items pri JOIN purchase_requests pr ON pri.pr_id = pr.id ${wPr}
          UNION ALL
          SELECT btrim(poi.product_name) AS name, COALESCE(poi.total_price,0) AS total, COALESCE(poi.quantity,0) AS qty
          FROM po_items poi JOIN purchase_orders po ON poi.po_id = po.id ${wPo}
        ) x
        WHERE COALESCE(name,'') <> ''
        GROUP BY name
      `, prodParams)).rows;
      const products = {
        by_value: [...prod].sort((a, b) => b.value - a.value).slice(0, 8),
        by_orders: [...prod].sort((a, b) => b.orders - a.orders).slice(0, 8),
      };

      res.json({ pr: prS.out, po: poS.out, products });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
