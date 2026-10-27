import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import pkg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';

const { Pool } = pkg;
dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Database Connection
// Prefer Railway's standard DATABASE_URL connection string when available,
// otherwise fall back to individual DB_* variables (local development).
let pool;
if (process.env.DATABASE_URL) {
  const url = process.env.DATABASE_URL;
  const isInternal =
    url.includes('.railway.internal') ||
    url.includes('localhost') ||
    url.includes('127.0.0.1');
  pool = new Pool({
    connectionString: url,
    ssl: isInternal ? false : { rejectUnauthorized: false },
  });
} else {
  pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'prpo_system',
  });
}

// Test DB Connection
pool.on('connect', () => {
  console.log('✅ Database connected');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
});

// Routes and Server Setup (async IIFE)
(async () => {
  try {
    // Auth middleware + public auth routes
    const { requireAuth } = await import('./middleware/auth.js');

    // --- Schema bootstrap: purchase_types master data (idempotent) ---
    await pool.query(`
      CREATE TABLE IF NOT EXISTS purchase_types (
        id     SERIAL PRIMARY KEY,
        name   VARCHAR(120) UNIQUE NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        sort   INTEGER NOT NULL DEFAULT 0
      );
    `);
    await pool.query(`
      INSERT INTO purchase_types (name, sort) VALUES
        ('ซื้อทั่วไป', 1),
        ('บริการ / จ้างเหมา', 2),
        ('วัสดุสิ้นเปลือง', 3),
        ('ครุภัณฑ์', 4)
      ON CONFLICT (name) DO NOTHING;
    `);

    app.use('/api/auth', (await import('./routes/auth.js')).default(pool));

    // Write guard: anyone logged in may READ master data; only these roles may create/update/delete it.
    const writeGuard = (roles, label) => (req, res, next) =>
      (req.method === 'GET' || roles.includes(req.user?.role)) ? next()
        : res.status(403).json({ error: `ไม่มีสิทธิ์แก้ไข${label} (เฉพาะ ${roles.join(' / ')})` });
    const MASTER = ['Admin', 'Purchase Manager'];
    const MASTER_STORE = ['Admin', 'Purchase Manager', 'Admin Store'];

    // Protected data routes (require a valid Bearer token)
    app.use('/api/company', requireAuth, writeGuard(MASTER, 'ข้อมูลบริษัท'), (await import('./routes/company.js')).default(pool));
    app.use('/api/companies', requireAuth, writeGuard(MASTER, 'ข้อมูลบริษัท'), (await import('./routes/companies.js')).default(pool));
    app.use('/api/accounts', requireAuth, writeGuard(MASTER, 'ผังบัญชี'), (await import('./routes/accounts.js')).default(pool));
    app.use('/api/po-categories', requireAuth, writeGuard(MASTER, 'หมวด PO'), (await import('./routes/poCategories.js')).default(pool));
    app.use('/api/users', requireAuth, writeGuard(['Admin'], 'ผู้ใช้งาน'), (await import('./routes/users.js')).default(pool));
    app.use('/api/departments', requireAuth, writeGuard(MASTER, 'แผนก'), (await import('./routes/departments.js')).default(pool));
    app.use('/api/suppliers', requireAuth, writeGuard(MASTER_STORE, 'ผู้ขาย'), (await import('./routes/suppliers.js')).default(pool));
    app.use('/api/products', requireAuth, writeGuard(MASTER_STORE, 'สินค้า'), (await import('./routes/products.js')).default(pool));
    app.use('/api/approval-matrix', requireAuth, writeGuard(MASTER, 'สายอนุมัติ'), (await import('./routes/approvalMatrix.js')).default(pool));
    app.use('/api/requisitions', requireAuth, (await import('./routes/requisitions.js')).default(pool));
    app.use('/api/prs', requireAuth, (await import('./routes/purchaseRequests.js')).default(pool));
    app.use('/api/pos', requireAuth, (await import('./routes/purchaseOrders.js')).default(pool));
    app.use('/api/approval', requireAuth, (await import('./routes/approval.js')).default(pool));
    app.use('/api/stats', requireAuth, (await import('./routes/stats.js')).default(pool));
    app.use('/api/purchase-types', requireAuth, writeGuard(MASTER, 'ประเภทการจัดซื้อ'), (await import('./routes/purchaseTypes.js')).default(pool));

    // Static files — disable caching for HTML/JS so deploys show immediately (no hard-refresh needed)
    app.use(express.static('public', {
      setHeaders: (res, path) => {
        if (path.endsWith('.html') || path.endsWith('.js')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      }
    }));

    // Health check
    app.get('/api/health', (req, res) => {
      res.json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: 'Route not found', path: req.path });
    });

    // Error handler
    app.use((err, req, res, next) => {
      console.error('Error:', err);
      res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
        timestamp: new Date().toISOString(),
      });
    });

    // Start server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize server:', error);
    process.exit(1);
  }
})();

export { pool };
