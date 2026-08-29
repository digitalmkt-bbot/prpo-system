// lib/peak.js
// PEAK Open API client — auth, signing, and the calls PR/PO needs.
//
// Auth model (per PEAK docs):
//   1. POST /api/v1/ClientToken with { PeakClientToken: { connectId, password } }
//      -> returns a Client Token valid for 24h. Cache it, don't re-request per call.
//   2. Every call carries 4 headers:
//        Time-Stamp     yyyyMMddHHmmss in UTC+0
//        Time-Signature HMAC-SHA1(Time-Stamp) with connectId as the secret key
//        Client-Token   from step 1
//        User-Token     issued by PEAK, identifies which business (กิจการ) to act on
//
// Env vars:
//   PEAK_CONNECT_ID          required
//   PEAK_PASSWORD            required
//   PEAK_USER_TOKEN          required
//   PEAK_API_BASE            default https://api.peakaccount.com
//                            UAT:   https://peakengineapidev.azurewebsites.net
//   PEAK_SIGNATURE_ENCODING  base64 (default) | hex  -- see note below
//   PEAK_TIMEOUT_MS          default 30000
//
// NOTE ON SIGNATURE ENCODING: the docs say "HMAC-SHA1 encrypted Time-Stamp" without
// stating the digest encoding. Base64 is what PEAK's Postman pre-request script uses,
// so it is the default here. If you get a signature error, flip PEAK_SIGNATURE_ENCODING
// to `hex` — that is the only knob you should need.

import crypto from 'crypto';

const BASE = (process.env.PEAK_API_BASE || 'https://api.peakaccount.com').replace(/\/+$/, '');
const CONNECT_ID = process.env.PEAK_CONNECT_ID || '';
const PASSWORD = process.env.PEAK_PASSWORD || '';
const USER_TOKEN = process.env.PEAK_USER_TOKEN || '';
const SIG_ENCODING = (process.env.PEAK_SIGNATURE_ENCODING || 'base64').toLowerCase();
const TIMEOUT_MS = Number(process.env.PEAK_TIMEOUT_MS || 30000);

export function isPeakConfigured() {
  return Boolean(CONNECT_ID && PASSWORD && USER_TOKEN);
}

export function peakConfigStatus() {
  return {
    base: BASE,
    connectId: CONNECT_ID ? 'set' : 'MISSING',
    password: PASSWORD ? 'set' : 'MISSING',
    userToken: USER_TOKEN ? 'set' : 'MISSING',
    signatureEncoding: SIG_ENCODING,
  };
}

// yyyyMMddHHmmss in UTC+0 — PEAK rejects local-time stamps.
function utcStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds())
  );
}

function sign(stamp) {
  return crypto.createHmac('sha1', CONNECT_ID).update(stamp).digest(SIG_ENCODING === 'hex' ? 'hex' : 'base64');
}

async function httpJson(path, { method = 'POST', body = null, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error(`PEAK HTTP ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      err.body = json || text;
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`PEAK request timed out after ${TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Client Token cache (24h TTL, refreshed 30 min early) ----
let tokenCache = { token: null, expiresAt: 0 };

export async function getClientToken(force = false) {
  if (!isPeakConfigured()) throw new Error('PEAK API ยังไม่ได้ตั้งค่า (PEAK_CONNECT_ID / PEAK_PASSWORD / PEAK_USER_TOKEN)');
  const now = Date.now();
  if (!force && tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

  const stamp = utcStamp();
  const res = await httpJson('/api/v1/ClientToken', {
    body: { PeakClientToken: { connectId: CONNECT_ID, password: PASSWORD } },
    headers: { 'Time-Stamp': stamp, 'Time-Signature': sign(stamp) },
  });
  const t = res?.PeakClientToken || res?.peakClientToken || {};
  if (String(t.resCode) !== '200' || !t.token) {
    throw new Error(`ขอ Client Token ไม่สำเร็จ: ${t.resDesc || JSON.stringify(res).slice(0, 300)}`);
  }
  tokenCache = { token: t.token, expiresAt: now + 23.5 * 60 * 60 * 1000 };
  return t.token;
}

// Authenticated call. Retries once on an auth-looking failure with a fresh token,
// because a cached token can expire mid-flight.
async function peakCall(path, { method = 'POST', body = null, query = null } = {}) {
  const run = async (force) => {
    const clientToken = await getClientToken(force);
    const stamp = utcStamp();
    const qs = query
      ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString()
      : '';
    return httpJson(path + qs, {
      method,
      body,
      headers: {
        'Time-Stamp': stamp,
        'Time-Signature': sign(stamp),
        'Client-Token': clientToken,
        'User-Token': USER_TOKEN,
      },
    });
  };
  try {
    return await run(false);
  } catch (e) {
    if (e.status === 401 || e.status === 403 || /token/i.test(e.message || '')) return run(true);
    throw e;
  }
}

// ---- Numeric code maps (from PEAK "Numeric Code" reference) ----
export const TAX_STATUS = { EXCLUDE: 0, INCLUDE: 1 };
export const VAT_TYPE = { NONE: 1, ZERO: 2, SEVEN: 3 };
export const TRANSACTION_TYPE = { PURCHASE_ORDER: 201, EXPENSE: 202 };

// PR/PO stores a VAT *rate* (0 or 7). PEAK wants a vatType enum.
// A 0 rate in PR/PO means "ไม่มี VAT", which is NONE (1), not VAT 0% (2).
export function vatRateToType(rate) {
  const r = Number(rate) || 0;
  if (r === 7) return VAT_TYPE.SEVEN;
  if (r === 0 && String(process.env.PEAK_ZERO_VAT_AS_ZERO_RATED || '') === 'true') return VAT_TYPE.ZERO;
  return VAT_TYPE.NONE;
}

// PEAK dates are yyyyMMdd strings.
export function toPeakDate(d) {
  if (!d) return null;
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

// ---- Endpoints ----

/**
 * Create one or more purchase orders.
 * @param {Array<object>} purchaseOrders  Transactions objects per PEAK's schema
 * @returns {object} the first purchaseOrders entry, plus the envelope
 */
export async function createPurchaseOrders(purchaseOrders) {
  const res = await peakCall('/api/v1/PurchaseOrders', {
    body: { peakPurchaseOrders: { purchaseOrders } },
  });
  // PEAK answers HTTP 200 even for business errors — the real status is in resCode.
  const body = res?.PeakPurchaseOrders || res?.peakPurchaseOrders || {};
  const list = body.purchaseOrders || [];
  const first = list[0] || {};
  return { envelope: body, doc: first, raw: res };
}

export async function getClassificationGroups() {
  const res = await peakCall('/api/v1/Classification', { method: 'GET' });
  return res?.PeakClassifications || res?.peakClassifications || res || {};
}

/**
 * Tag an existing document with one classification group (Department / Branch / Program).
 * One call per group. Best-effort: PEAK only supports this on the new platform.
 */
export async function createTransactionClassification({ transactionCode, transactionId, groupCode, itemNumber, percent = 100 }) {
  return peakCall('/api/v1/Classification/transaction', {
    body: {
      peakClassifications: {
        transactionId: transactionId || undefined,
        transactionCode: transactionCode || undefined,
        transactionType: TRANSACTION_TYPE.PURCHASE_ORDER,
        classifications: {
          classificationGroupCode: groupCode,
          classificationItemList: [{ number: String(itemNumber), percent: Number(percent) }],
        },
      },
    },
  });
}

export default {
  isPeakConfigured,
  peakConfigStatus,
  getClientToken,
  createPurchaseOrders,
  getClassificationGroups,
  createTransactionClassification,
  vatRateToType,
  toPeakDate,
  TAX_STATUS,
  VAT_TYPE,
  TRANSACTION_TYPE,
};
