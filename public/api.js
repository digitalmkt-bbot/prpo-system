/**
 * API Integration for PR/PO System (Railway Backend)
 * Replace google.script.run with fetch-based API calls
 */

// Configuration
const API_BASE = window.location.origin + '/api';

class PROPOApi {
  /**
   * Make API request
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {string} endpoint - API endpoint path
   * @param {object} data - Request body (optional)
   */
  // ---- Auth token helpers ----
  getToken() {
    return localStorage.getItem('prpo_token');
  }
  setToken(t) {
    if (t) localStorage.setItem('prpo_token', t);
    else localStorage.removeItem('prpo_token');
  }
  getStoredUser() {
    try { return JSON.parse(localStorage.getItem('prpo_user') || 'null'); }
    catch { return null; }
  }

  async request(method, endpoint, data = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (data) options.body = JSON.stringify(data);

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, options);

      // Token missing/expired -> force re-login
      if (response.status === 401) {
        this.setToken(null);
        localStorage.removeItem('prpo_user');
        if (typeof window.showLogin === 'function') window.showLogin();
        throw new Error('กรุณาเข้าสู่ระบบใหม่');
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      return result;
    } catch (error) {
      console.error(`API Error [${method} ${endpoint}]:`, error);
      throw error;
    }
  }

  // ========== AUTH ==========
  async login(email, password) {
    const res = await this.request('POST', '/auth/login', { email, password });
    this.setToken(res.token);
    localStorage.setItem('prpo_user', JSON.stringify(res.user));
    return res.user;
  }

  async me() {
    const res = await this.request('GET', '/auth/me');
    return res.user;
  }

  async changePassword(currentPassword, newPassword) {
    return this.request('POST', '/auth/change-password', { currentPassword, newPassword });
  }

  logout() {
    this.setToken(null);
    localStorage.removeItem('prpo_user');
  }

  // ========== PURCHASE REQUESTS ==========
  async getPRs(filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    if (filters.department_id) params.append('department_id', filters.department_id);
    return this.request('GET', `/prs?${params}`);
  }

  async getPRDetail(prNo) {
    return this.request('GET', `/prs/${prNo}`);
  }

  async savePR(pr) {
    return this.request('POST', '/prs', pr);
  }

  async deletePR(prNo) {
    return this.request('DELETE', `/prs/${prNo}`);
  }

  // ========== APPROVAL WORKFLOW (Phase 3) ==========
  async getApprovalSteps(prNo) {
    return this.request('GET', `/approval/steps/${prNo}`);
  }

  async getApprovalStatus(prNo) {
    return this.request('GET', `/approval/status/${prNo}`);
  }

  async getMyApprovalsNeeded(userEmail) {
    return this.request('GET', `/approval/my-approvals/${userEmail}`);
  }

  async approvePR(prNo, approverEmail, approverName, comment = '') {
    return this.request('POST', `/approval/approve/${prNo}`, {
      approverEmail,
      approverName,
      comment
    });
  }

  async rejectPR(prNo, approverEmail, approverName, comment = '') {
    return this.request('POST', `/approval/reject/${prNo}`, {
      approverEmail,
      approverName,
      comment
    });
  }

  // ========== SUPPLIERS ==========
  async getSuppliers() {
    return this.request('GET', '/suppliers');
  }

  async saveSupplier(supplier) {
    if (supplier.id) {
      return this.request('PUT', `/suppliers/${supplier.id}`, supplier);
    }
    return this.request('POST', '/suppliers', supplier);
  }

  async deleteSupplier(id) {
    return this.request('DELETE', `/suppliers/${id}`);
  }

  async importSuppliers(suppliers) {
    return this.request('POST', '/suppliers/import', { suppliers });
  }

  // ========== PRODUCTS ==========
  async getProducts() {
    return this.request('GET', '/products');
  }

  async saveProduct(product) {
    if (product.id) {
      return this.request('PUT', `/products/${product.id}`, product);
    }
    return this.request('POST', '/products', product);
  }

  async deleteProduct(id) {
    return this.request('DELETE', `/products/${id}`);
  }

  // ========== DEPARTMENTS ==========
  async getDepartments() {
    return this.request('GET', '/departments');
  }

  async saveDepartment(dept) {
    if (dept.id) {
      return this.request('PUT', `/departments/${dept.id}`, dept);
    }
    return this.request('POST', '/departments', dept);
  }

  async deleteDepartment(id) {
    return this.request('DELETE', `/departments/${id}`);
  }

  // ========== APPROVAL MATRIX ==========
  async getApprovalMatrix() {
    return this.request('GET', '/approval-matrix');
  }

  async saveApprovalMatrix(rule) {
    if (rule.id) {
      return this.request('PUT', `/approval-matrix/${rule.id}`, rule);
    }
    return this.request('POST', '/approval-matrix', rule);
  }

  async deleteApprovalMatrix(id) {
    return this.request('DELETE', `/approval-matrix/${id}`);
  }

  // ========== PURCHASE ORDERS ==========
  async getPOs(filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    return this.request('GET', `/pos?${params}`);
  }

  async getPODetail(poNo) {
    return this.request('GET', `/pos/${poNo}`);
  }

  async issuePO(payload) {
    return this.request('POST', '/pos/issue', payload);
  }

  async updatePOStatus(id, status) {
    return this.request('PUT', `/pos/${id}`, { status });
  }

  async updatePO(poNo, payload) {
    return this.request('PUT', `/pos/${encodeURIComponent(poNo)}/full`, payload);
  }

  // ========== COMPANY ==========
  async getCompanyInfo() {
    return this.request('GET', '/company');
  }

  async saveCompanyInfo(company) {
    return this.request('POST', '/company', company);
  }

  // ========== USERS ==========
  async getUsers() {
    return this.request('GET', '/users');
  }

  async saveUser(user) {
    if (user.id) {
      return this.request('PUT', `/users/${user.id}`, user);
    }
    return this.request('POST', '/users', user);
  }

  async deleteUser(id) {
    return this.request('DELETE', `/users/${id}`);
  }

  // ========== PURCHASE TYPES ==========
  async getPurchaseTypes() {
    return this.request('GET', '/purchase-types');
  }
  async savePurchaseType(name) {
    return this.request('POST', '/purchase-types', { name });
  }
  async deletePurchaseType(id) {
    return this.request('DELETE', `/purchase-types/${id}`);
  }

  // ========== DASHBOARD STATS ==========
  async getDashboardStats(filters = {}) {
    const p = new URLSearchParams();
    if (filters.from) p.append('from', filters.from);
    if (filters.to) p.append('to', filters.to);
    if (filters.status) p.append('status', filters.status);
    const qs = p.toString();
    return this.request('GET', '/stats/dashboard' + (qs ? '?' + qs : ''));
  }

  // ========== HEALTH CHECK ==========
  async healthCheck() {
    try {
      const response = await fetch(`${window.location.origin}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Create and export API instance
const api = new PROPOApi();
window.api = api;
