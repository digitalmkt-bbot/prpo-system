// routes/purchaseOrders.js
import { Router } from 'express';

export default function(pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const { status, limit = 100, offset = 0 } = req.query;

      let query = `
        SELECT
          po.id, po.po_no, po.date, po.status, po.total_amount,
          s.name as supplier_name,
          json_agg(json_build_object(
            'product_name', poi.product_name,
            'quantity', poi.quantity,
            'unit_price', poi.unit_price,
            'total_price', poi.total_price
          )) as items
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        LEFT JOIN po_items poi ON po.id = poi.po_id
        WHERE 1=1
      `;
      const params = [];

      if (status) {
        query += ` AND po.status = $${params.length + 1}`;
        params.push(status);
      }

      query += ` GROUP BY po.id, s.name
                 ORDER BY po.created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:poNo', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          po.*,
          s.name as supplier_name, s.address as supplier_address,
          json_agg(json_build_object(
            'product_name', poi.product_name,
            'quantity', poi.quantity,
            'unit_price', poi.unit_price,
            'total_price', poi.total_price
          )) as items
        FROM purchase_orders po
        LEFT JOIN suppliers s ON po.supplier_id = s.id
        LEFT JOIN po_items poi ON po.id = poi.po_id
        WHERE po.po_no = $1
        GROUP BY po.id, s.name, s.address
      `, [req.params.poNo]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'PO not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { status } = req.body;
      const result = await pool.query(
        'UPDATE purchase_orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
