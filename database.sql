-- PR/PO Procurement System - PostgreSQL Schema
-- Version 1.0 (Phase 1-3)

-- Company Settings
CREATE TABLE IF NOT EXISTS company (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  tax_id VARCHAR(50),
  address TEXT,
  phone VARCHAR(20),
  email VARCHAR(255),
  bank_name VARCHAR(255),
  account_no VARCHAR(50),
  account_name VARCHAR(255),
  vat_rate DECIMAL(5,2) DEFAULT 7.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  role VARCHAR(50) NOT NULL DEFAULT 'Viewer', -- Admin, Manager, Purchasing, Viewer
  password_hash VARCHAR(255),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Departments
CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  manager_email VARCHAR(255),
  status VARCHAR(50) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(12,2),
  unit VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Approval Matrix
CREATE TABLE IF NOT EXISTS approval_matrix (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL REFERENCES departments(id),
  min_amount DECIMAL(12,2) DEFAULT 0,
  max_amount DECIMAL(12,2) DEFAULT 999999999,
  approval_step INTEGER NOT NULL,
  approver_role VARCHAR(50),
  approver_email VARCHAR(255),
  status VARCHAR(50) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(department_id, min_amount, max_amount, approval_step)
);

-- PR (Purchase Request)
CREATE TABLE IF NOT EXISTS purchase_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_no VARCHAR(50) NOT NULL UNIQUE,
  date DATE NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  department_id UUID REFERENCES departments(id),
  status VARCHAR(50) DEFAULT 'Pending', -- Pending, Approved, Rejected
  total_amount DECIMAL(12,2),
  has_vat BOOLEAN DEFAULT false,
  requested_by VARCHAR(255),
  approved_by VARCHAR(255),
  po_no VARCHAR(50),

  -- Phase 3: Approval Workflow
  current_approval_step INTEGER DEFAULT 1,
  total_approval_steps INTEGER DEFAULT 1,
  approval_comments TEXT,
  approval_chain JSONB DEFAULT '[]'::jsonb,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PR Items (Line Items)
CREATE TABLE IF NOT EXISTS pr_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  product_name VARCHAR(255),
  quantity DECIMAL(10,2) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  total_price DECIMAL(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PO (Purchase Order)
CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no VARCHAR(50) NOT NULL UNIQUE,
  date DATE NOT NULL,
  pr_id UUID REFERENCES purchase_requests(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  status VARCHAR(50) DEFAULT 'Active', -- Active, Completed, Cancelled
  total_amount DECIMAL(12,2),
  has_vat BOOLEAN DEFAULT false,
  file_link TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PO Items (Line Items)
CREATE TABLE IF NOT EXISTS po_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_name VARCHAR(255),
  quantity DECIMAL(10,2) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  total_price DECIMAL(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Approval History
CREATE TABLE IF NOT EXISTS approval_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(50), -- PR, PO
  document_no VARCHAR(50),
  approver_email VARCHAR(255),
  approver_name VARCHAR(255),
  action VARCHAR(50), -- Approve, Reject, Step Approve, Final Approve
  comment TEXT,
  status_before VARCHAR(50),
  status_after VARCHAR(50),
  action_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Running Numbers (Document Sequence)
CREATE TABLE IF NOT EXISTS running_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(50) NOT NULL UNIQUE, -- PR, PO
  prefix VARCHAR(50),
  last_number INTEGER DEFAULT 0,
  year INTEGER,
  month INTEGER,
  format_pattern VARCHAR(50),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_pr_status ON purchase_requests(status);
CREATE INDEX idx_pr_department ON purchase_requests(department_id);
CREATE INDEX idx_pr_supplier ON purchase_requests(supplier_id);
CREATE INDEX idx_pr_created ON purchase_requests(created_at);
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_approval_history_doc ON approval_history(document_type, document_no);
CREATE INDEX idx_approval_matrix_dept ON approval_matrix(department_id);
CREATE INDEX idx_users_email ON users(email);

-- Initial data
INSERT INTO company (name, vat_rate) VALUES ('บริษัท ตัวอย่าง จำกัด', 7.00)
ON CONFLICT DO NOTHING;

INSERT INTO running_numbers (document_type, prefix, last_number, format_pattern) VALUES
('PR', 'PR', 0, 'PR-YYYYMM-000'),
('PO', 'PO', 0, 'PO-YYYYMM-000')
ON CONFLICT DO NOTHING;
