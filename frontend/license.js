/* ============================================================
   LICENSE — screen wala hissa
   - License nahi / roka gaya / internet 3 din se nahi / ghadi galat -> poori screen pe lock
   - Expiry se 7 din pehle peela banner
   - Expiry ke baad: laal banner, Excel / PDF / Print pe "Payment due" popup
   ============================================================ */
(function () {
  const BASE = location.protocol.startsWith('http') ? '' : 'http://localhost:4000';
  const LOCKED = ['none', 'suspended', 'offline', 'clock'];
  const dmy = (iso) => (iso || '').split('-').reverse().join('/');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let LIC = null;

  const css = document.createElement('style');
  css.textContent = `
  .lic-ov{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.97);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit}
  .lic-box{background:#fff;color:#111;border-radius:14px;max-width:400px;width:100%;padding:26px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .lic-box h2{margin:0 0 6px;font-size:20px}.lic-box p{margin:0 0 14px;color:#555;font-size:14px;line-height:1.5}
  .lic-box input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ccc;border-radius:8px;margin-bottom:10px;font-size:15px}
  .lic-box button{width:100%;padding:11px;border:0;border-radius:8px;background:#e11d2a;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .lic-box button.sec{background:#eee;color:#111;margin-top:8px}
  .lic-box button:disabled{opacity:.6;cursor:wait}
  .lic-err{color:#b91c1c;font-size:13px;min-height:18px;margin-bottom:6px}
  .lic-sup{font-size:13px;color:#333;background:#f5f5f5;border-radius:8px;padding:8px 10px;margin-top:12px}
  .lic-ban{padding:8px 14px;font-size:13px;font-weight:600;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap}
  .lic-ban.warn{background:#fef3c7;color:#92400e}.lic-ban.exp{background:#fee2e2;color:#991b1b}`;
  document.head.appendChild(css);

  // ---------- poori screen ka lock ----------
  function lockScreen(s) {
    let ov = document.getElementById('licOv');
    if (!ov) { ov = document.createElement('div'); ov.id = 'licOv'; ov.className = 'lic-ov'; document.body.appendChild(ov); }
    const sup = s.support ? `<div class="lic-sup">Sahayata / Renew: <b>${esc(s.support)}</b></div>` : '';
    if (s.state === 'none') {
      ov.innerHTML = `<div class="lic-box"><h2>🔐 License chalu karein</h2>
        <p>Dealer Console ki taraf se mila <b>License ID</b> aur <b>Password</b> daalein. Ye license isi computer se jud jayega.</p>
        <input id="licId" placeholder="License ID" autocomplete="username">
        <input id="licPw" type="password" placeholder="Password" autocomplete="current-password">
        <div class="lic-err" id="licErr">${esc(s.lastError || s.msg || '')}</div>
        <button id="licGo">Chalu karein</button>${sup}</div>`;
      const go = async () => {
        const b = document.getElementById('licGo'), e = document.getElementById('licErr');
        const login = document.getElementById('licId').value.trim(), password = document.getElementById('licPw').value;
        if (!login || !password) { e.textContent = 'ID aur password dono daalein'; return; }
        b.disabled = true; b.textContent = 'Check ho raha hai…'; e.textContent = '';
        try {
          const r = await fetch(BASE + '/api/license/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) });
          const j = await r.json().catch(() => ({}));
          if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status);
          location.reload();
        } catch (x) { e.textContent = x.message; b.disabled = false; b.textContent = 'Chalu karein'; }
      };
      document.getElementById('licGo').onclick = go;
      document.getElementById('licPw').onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
      setTimeout(() => document.getElementById('licId')?.focus(), 50);
      return;
    }
    const head = { suspended: '⛔ License roka gaya hai', offline: '📶 Internet chahiye', clock: '🕒 Computer ka samay galat hai' }[s.state];
    const body = { suspended: 'Is dealer ka license abhi band hai. Renew / chalu karwane ke liye sampark karein.', offline: s.msg, clock: s.msg }[s.state];
    ov.innerHTML = `<div class="lic-box"><h2>${head}</h2><p>${esc(body)}</p>
      <div class="lic-err" id="licErr"></div><button id="licRe">🔄 Dobara check karein</button>${sup}</div>`;
    document.getElementById('licRe').onclick = async () => {
      const b = document.getElementById('licRe'); b.disabled = true; b.textContent = 'Check ho raha hai…';
      const r = await fetch(BASE + '/api/license/refresh', { method: 'POST' }).then((x) => x.json()).catch(() => null);
      if (r?.license && !LOCKED.includes(r.license.state)) return location.reload();
      if (r?.license) { lockScreen(r.license); document.getElementById('licErr').textContent = 'Abhi bhi nahi hua — internet / samay check karein'; }
      else { b.disabled = false; b.textContent = '🔄 Dobara check karein'; document.getElementById('licErr').textContent = 'Server se jawab nahi'; }
    };
  }

  // ---------- banner ----------
  function banner(cls, html) {
    let b = document.getElementById('licBan');
    if (!b) { b = document.createElement('div'); b.id = 'licBan'; const host = document.querySelector('.main') || document.body; host.insertBefore(b, host.firstChild); }
    b.className = 'lic-ban ' + cls; b.innerHTML = html;
  }

  // ---------- payment due ----------
  function paymentDue() {
    let ov = document.getElementById('licPay'); if (ov) ov.remove();
    ov = document.createElement('div'); ov.id = 'licPay'; ov.className = 'lic-ov';
    ov.innerHTML = `<div class="lic-box"><h2>💳 Payment due</h2>
      <p>License <b>${dmy(LIC?.expDate)}</b> ko khatam ho gaya. Excel / PDF / Print aur Sync renew ke baad chalenge.<br>Tab tak sirf ${dmy(LIC?.expDate)} tak ka data dikh raha hai.</p>
      ${LIC?.support ? `<div class="lic-sup">Renew ke liye: <b>${esc(LIC.support)}</b></div>` : ''}
      <button class="sec" id="licPayX" style="margin-top:14px">Theek hai</button></div>`;
    document.body.appendChild(ov);
    document.getElementById('licPayX').onclick = () => ov.remove();
  }
  const isExpired = () => LIC && LIC.state === 'expired';

  // Excel / PDF / Print rok do (expiry ke baad)
  function guardExports() {
    const wrap = (obj, name) => {
      const orig = obj && obj[name]; if (typeof orig !== 'function' || orig.__lic) return;
      const f = function () { if (isExpired()) { paymentDue(); return null; } return orig.apply(this, arguments); };
      f.__lic = true; obj[name] = f;
    };
    wrap(window, 'exportReport'); wrap(window, 'open'); wrap(window, 'print');
    if (window.XLSX) { wrap(window.XLSX, 'writeFile'); wrap(window.XLSX, 'writeFileXLSX'); }
  }

  function apply(s) {
    LIC = s; window.DC_LICENSE = s;
    // sidebar me dealer ka naam (license wala) + tab ka title
    if (s.name) { const el = document.getElementById('dealerName'); if (el) { el.textContent = s.name; el.title = s.dealer ? 'Dealer code ' + s.dealer : ''; } document.title = 'Dealer Console — ' + s.name; }
    if (LOCKED.includes(s.state)) return lockScreen(s);
    document.getElementById('licOv')?.remove();
    if (s.state === 'expired') {
      banner('exp', `⛔ License ${dmy(s.expDate)} ko khatam — sirf ${dmy(s.expDate)} tak ka data dikh raha hai · Sync / Excel / PDF / Print band${s.support ? ' · Renew: ' + esc(s.support) : ''}`);
      const rb = document.createElement('button'); rb.textContent = '🔄 Renew ho gaya? Check karo';
      rb.style.cssText = 'border:0;border-radius:6px;padding:4px 10px;background:#991b1b;color:#fff;cursor:pointer;font-weight:600';
      rb.onclick = async () => { rb.disabled = true; rb.textContent = 'Check…'; const r = await ofetch(BASE + '/api/license/refresh', { method: 'POST' }).then((x) => x.json()).catch(() => null);
        if (r?.license?.state === 'active') location.reload(); else { rb.disabled = false; rb.textContent = 'Abhi renew nahi hua — dobara check'; } };
      document.getElementById('licBan').appendChild(rb);
      guardExports();
      if (sessionStorageGet('licPayShown') !== '1') { paymentDue(); sessionStorageSet('licPayShown', '1'); }
    } else if (s.warn) {
      banner('warn', `⚠ License ${s.daysLeft} din me khatam (${dmy(s.expDate)}) — samay pe renew karwa lein${s.support ? ' · ' + esc(s.support) : ''}`);
    } else document.getElementById('licBan')?.remove();
  }
  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }

  // server 402 bole to turant dikhao
  const ofetch = window.fetch.bind(window);
  window.fetch = async function (...a) {
    const r = await ofetch(...a);
    if (r.status === 402) {
      r.clone().json().then((j) => {
        if (j?.license) apply(j.license);
        if (j?.error === 'payment_due') paymentDue();
      }).catch(() => {});
    }
    return r;
  };

  const load = () => ofetch(BASE + '/api/license/status').then((r) => (r.ok ? r.json() : null)).then((s) => s && apply(s)).catch(() => {});
  load();
  setInterval(load, 10 * 60e3);   // har 10 min — expiry beech me ho jaye to bhi pakde
})();