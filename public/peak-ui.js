/**
 * public/peak-ui.js — "ส่งเข้า PEAK" button for the PO detail dialog.
 *
 * Kept out of index.html on purpose: that file is large and edited often, so
 * bolting UI onto it invites merge conflicts. This wraps showPODetail instead
 * and appends its own button after the dialog renders.
 */
(function () {
  'use strict';

  function canSync() {
    const u = (window.api && api.getStoredUser && api.getStoredUser()) || {};
    return ['admin', 'purchase manager', 'admin store', 'purchasing']
      .includes(String(u.role || '').toLowerCase());
  }

  function syncedBadge(code, link) {
    return `<a class="btn secondary" style="border-color:#2563eb;color:#2563eb;text-decoration:none"
              href="${link || '#'}" target="_blank" rel="noopener">✅ อยู่ใน PEAK แล้ว · ${code}</a>`;
  }

  function syncButton(poNo) {
    return `<button class="btn secondary" style="border-color:#2563eb;color:#2563eb"
              onclick="syncPOToPeak('${poNo}')">📤 ส่งเข้า PEAK (ฉบับร่าง)</button>`;
  }

  function setWrap(html) {
    const w = document.getElementById('peak-sync-wrap');
    if (w) w.innerHTML = html;
  }

  async function syncPOToPeak(poNo) {
    const busy = (t) => setWrap(`<button class="btn secondary" disabled>${t}</button>`);
    try {
      // Preview first so mapping problems surface before anything is created
      // in the accounting system.
      busy('กำลังตรวจสอบ...');
      const pv = await api.peakPreview(poNo);

      const errs = (pv.warnings || []).filter((w) => w.level === 'error');
      if (errs.length) {
        alert('ส่งเข้า PEAK ไม่ได้:\n\n• ' + errs.map((w) => w.message).join('\n• '));
        throw new Error('__handled__');
      }

      const doc = pv.payload.peakPurchaseOrders.purchaseOrders[0];
      const warns = (pv.warnings || []).filter((w) => w.level === 'warn');
      const msg =
        `ส่ง ${poNo} เข้า PEAK เป็นใบสั่งซื้อ "ฉบับร่าง"\n` +
        `ผู้ขาย: ${doc.contactCode}\n` +
        `รายการ: ${doc.products.length}\n` +
        (warns.length ? `\n⚠️ ข้อควรระวัง:\n• ${warns.map((w) => w.message).join('\n• ')}\n` : '') +
        `\nยืนยันหรือไม่?`;
      if (!confirm(msg)) throw new Error('__handled__');

      busy('กำลังส่ง...');
      const res = await api.peakSyncPO(poNo);
      toast(`ส่งเข้า PEAK สำเร็จ · ${res.peak_code} (ฉบับร่าง)`);
      if (res.warnings && res.warnings.length) {
        console.warn('PEAK sync warnings:', res.warnings);
        toast(`มีข้อควรระวัง ${res.warnings.length} ข้อ — ดู Console`, true);
      }
      setWrap(syncedBadge(res.peak_code, res.peak_doc_link));
      if (typeof loadPOs === 'function') loadPOs();
    } catch (e) {
      if (e.message !== '__handled__') toast('ส่งเข้า PEAK ไม่สำเร็จ: ' + e.message, true);
      setWrap(syncButton(poNo));
    }
  }
  window.syncPOToPeak = syncPOToPeak;

  async function injectButton(poNo) {
    const overlay = document.getElementById('po-detail-overlay');
    if (!overlay || overlay.style.display === 'none') return;
    const actions = overlay.querySelector('.detail-actions');
    if (!actions || actions.querySelector('#peak-sync-wrap')) return;
    if (!canSync()) return;

    const span = document.createElement('span');
    span.id = 'peak-sync-wrap';
    // Sits before the print/close buttons so the primary actions stay rightmost.
    actions.insertBefore(span, actions.firstChild);
    span.innerHTML = '<button class="btn secondary" disabled>...</button>';

    try {
      const pv = await api.peakPreview(poNo);
      span.innerHTML = pv.already_synced
        ? syncedBadge(pv.peak_code, pv.peak_doc_link)
        : syncButton(poNo);
    } catch {
      // PEAK not configured, or no permission — leave the dialog untouched.
      span.remove();
    }
  }

  // Wrap showPODetail once the app's own script has defined it.
  function hook() {
    if (typeof window.showPODetail !== 'function' || window.showPODetail.__peakWrapped) return false;
    const orig = window.showPODetail;
    const wrapped = async function (poNo) {
      const r = await orig.apply(this, arguments);
      injectButton(poNo);
      return r;
    };
    wrapped.__peakWrapped = true;
    window.showPODetail = wrapped;
    return true;
  }

  if (!hook()) {
    const t = setInterval(() => { if (hook()) clearInterval(t); }, 200);
    setTimeout(() => clearInterval(t), 15000);
  }
})();
