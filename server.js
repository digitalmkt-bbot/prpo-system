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
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'prpo_system',
});

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
    app.use('/api/company', (await import('./routes/company.js')).default(pool));
    app.use('/api/users', (await import('./routes/users.js')).default(pool));
    app.use('/api/departments', (await import('./routes/departments.js')).default(pool));
    app.use('/api/suppliers', (await import('./routes/suppliers.js')).default(pool));
    app.use('/api/products', (await import('./routes/products.js')).default(pool));
    app.use('/api/approval-matrix', (await import('./routes/approvalMatrix.js')).default(pool));
    app.use('/api/prs', (await import('./routes/purchaseRequests.js')).default(pool));
    app.use('/api/pos', (await import('./routes/purchaseOrders.js')).default(pool));
    app.use('/api/approval', (await import('./routes/approval.js')).default(pool));

    // Static files
    app.use(express.static('public'));

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
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize server:', error);
    process.exit(1);
  }
})();

export { pool };
