// Content script for bplace.org to initiate login flow when requested
console.log('[AUTO-LOGIN EXTENSION] wplace.js loaded');
// Seed profileName from URL query if present (first time only)
(function seedProfileFromQuery(){
  try {
    const u = new URL(location.href);
    const qName = (u.searchParams.get('profileName') || '').trim();
    if (qName) {
      chrome.runtime.sendMessage({ type: 'wplace:set-profile', profileName: qName, isSeed: true }, (resp) => {
        try { if (resp && resp.ok) console.log('[AUTO-LOGIN EXTENSION] profileName seeded from URL'); } catch {}
      });
      try {
        window.__wplaceSeedName = qName;
        // Ensure overlay exists and set the input immediately (with retry in case input appears later)
        try { ensureOverlay(); } catch {}
        const tryPrefill = () => {
          const el = document.getElementById('wplace-profile-name');
          if (el && typeof el.value === 'string') { el.value = qName; return true; }
          return false;
        };
        if (!tryPrefill()) {
          let tries = 0; // try up to 5 times (5s)
          const iv = setInterval(() => {
            if (tryPrefill() || ++tries > 5) clearInterval(iv);
          }, 1000);
        }
      } catch {}
    }
  } catch {}
})();
// Simple overlay UI for status and actions
function ensureOverlay() {
  if (document.getElementById('wplace-overlay')) return document.getElementById('wplace-overlay');
  const wrap = document.createElement('div');
  wrap.id = 'wplace-overlay';
  wrap.style.position = 'fixed';
  wrap.style.inset = '0';
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'flex-start';
  wrap.style.justifyContent = 'center';
  wrap.style.paddingTop = '40px';
  wrap.style.zIndex = '2147483647';
  wrap.style.pointerEvents = 'none';

  const panel = document.createElement('div');
  panel.style.minWidth = '520px';
  panel.style.maxWidth = '90vw';
  panel.style.background = 'rgba(17,17,17,0.92)';
  panel.style.color = '#fff';
  panel.style.borderRadius = '14px';
  panel.style.boxShadow = '0 10px 32px rgba(0,0,0,0.45)';
  panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif';
  panel.style.pointerEvents = 'auto';
  panel.style.padding = '20px 24px';

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <div style="font-weight:700;font-size:18px;">WPlace AutoLogin</div>
      <div id="wplace-status" style="margin-left:auto;font-weight:600;color:#8be28b;">Idle</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;font-size:14px;">
      <div>Auth: <span id="wplace-auth">Unknown</span></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span>Token:</span>
        <span id="wplace-token" style="width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;">-</span>
        <button id="wplace-btn-copy" title="Copy token" style="padding:4px 8px;border-radius:6px;border:none;background:#374151;color:#fff;font-weight:600;cursor:pointer;">Copy</button>
      </div>
      <div>Send: <span id="wplace-send">-</span></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span>Port:</span>
        <input id="wplace-port" type="number" min="1" max="65535" placeholder="80" style="width:100px;padding:6px 8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;" />
        <button id="wplace-save-port" style="padding:6px 10px;border-radius:6px;border:none;background:#4b5563;color:#fff;font-weight:600;cursor:pointer;">Save</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <span>Profile name:</span>
        <input id="wplace-profile-name" type="text" placeholder="e.g. test1" style="width:16rem;padding:6px 8px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#e5e7eb;" />
        <button id="wplace-save-profile" style="padding:6px 10px;border-radius:6px;border:none;background:#4b5563;color:#fff;font-weight:600;cursor:pointer;">Save profile</button>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px;">
      <button id="wplace-btn-refresh" style="padding:8px 12px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer;">Refresh token</button>
      <button id="wplace-btn-send" style="padding:8px 12px;border-radius:8px;border:none;background:#10b981;color:#fff;font-weight:600;cursor:pointer;">Send token</button>
      <button id="wplace-btn-logout" style="padding:8px 12px;border-radius:8px;border:none;background:#ef4444;color:#fff;font-weight:600;cursor:pointer;">Clear all</button>
      <button id="wplace-btn-hide" style="padding:8px 12px;border-radius:8px;border:none;background:#6b7280;color:#fff;font-weight:600;cursor:pointer;margin-left:auto;">Hide</button>
    </div>
  `;

  wrap.appendChild(panel);
  document.documentElement.appendChild(wrap);

  document.getElementById('wplace-btn-hide').onclick = () => wrap.remove();
  // Load port from storage
  try {
    chrome.storage.local.get(['wplacerPort'], (res) => {
      const p = (res && res.wplacerPort) ? String(res.wplacerPort) : '80';
      const el = document.getElementById('wplace-port');
      if (el) el.value = p;
    });
  } catch {}
  // Prefill profile name: URL seed has priority, then storage
  try {
    const seed = (typeof window.__wplaceSeedName === 'string' && window.__wplaceSeedName.trim()) ? window.__wplaceSeedName.trim() : '';
    const nameEl = document.getElementById('wplace-profile-name');
    if (nameEl && seed) nameEl.value = seed;
    chrome.storage.local.get(['profileName'], (res) => {
      try {
        const stored = res && res.profileName ? String(res.profileName) : '';
        if (nameEl && !nameEl.value && stored) nameEl.value = stored;
      } catch {}
    });
  } catch {}
  // Copy token button
  document.getElementById('wplace-btn-copy').onclick = async () => {
    try {
      const full = window.__wplaceTokenFull || (document.getElementById('wplace-token')?.textContent || '').trim();
      await navigator.clipboard.writeText(full);
      const btn = document.getElementById('wplace-btn-copy');
      if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(()=>{ btn.textContent = old; }, 1200); }
    } catch {}
  };
  document.getElementById('wplace-btn-refresh').onclick = () => {
    chrome.runtime.sendMessage({ type: 'wplace:manual-refresh' });
  };
  document.getElementById('wplace-btn-send').onclick = () => {
    const full = window.__wplaceTokenFull || (document.getElementById('wplace-token')?.textContent || '').trim();
    chrome.runtime.sendMessage({ type: 'wplace:manual-send', token: String(full || '') });
  };
  document.getElementById('wplace-btn-logout').onclick = async () => {
    try {
      overlayUpdate({ status: 'Logging out…' });
      // Ask background to clear storage and block re-population for this tab
      try { chrome.runtime.sendMessage({ type: 'wplace:logout' }); } catch {}
      const focusXPath = '/html/body/div/div[1]/div[2]/div/div[1]/div/div[1]';
      const menuXPath = '/html/body/div/div[1]/div[2]/div/div[1]/div';
      const logoutXPath = '/html/body/div/div[1]/div[2]/div/div[1]/div/div[2]/section[2]/button[2]';

      // Ensure :focus on requested element
      try {
        const focusEl = await waitForXPath(focusXPath, 2000);
        if (focusEl && typeof focusEl.focus === 'function') { try { focusEl.tabIndex = focusEl.tabIndex || -1; } catch {}; focusEl.focus({ preventScroll: false }); }
      } catch {}

      // Step 1: open/expand menu
      const menuBtn = await waitForXPath(menuXPath, 8000);
      if (menuBtn) {
        console.log('[AUTO-LOGIN EXTENSION] logout: clicking menu button');
        menuBtn.click();
        await new Promise(r => setTimeout(r, 400));
      } else {
        console.warn('[AUTO-LOGIN EXTENSION] logout: menu button not found');
      }

      // Step 2: click Logout
      const btn = await waitForXPath(logoutXPath, 8000);
      if (btn) {
        console.log('[AUTO-LOGIN EXTENSION] logout: clicking logout button');
        btn.click();
        // Ensure overlay reflects cleared state
        overlayUpdate({ status: 'Logout clicked', auth: 'Not authorized', token: '-', send: '-' });
      } else {
        console.warn('[AUTO-LOGIN EXTENSION] logout: logout button not found');
        overlayUpdate({ status: 'Logout button not found' });
      }
    } catch (e) {
      console.warn('[AUTO-LOGIN EXTENSION] logout error:', e);
      overlayUpdate({ status: 'Logout failed' });
    }
  };
  document.getElementById('wplace-save-port').onclick = () => {
    try {
      const val = parseInt(document.getElementById('wplace-port').value, 10);
      chrome.runtime.sendMessage({ type: 'wplace:set-port', port: isFinite(val) && val > 0 ? val : 80 });
    } catch {}
  };
  // Load and save profile meta (do not overwrite non-empty input)
  try {
    chrome.storage.local.get(['profileName'], (res) => {
      try {
        const nameEl = document.getElementById('wplace-profile-name');
        const stored = res && res.profileName ? String(res.profileName) : '';
        if (nameEl && !nameEl.value && stored) nameEl.value = stored;
      } catch {}
    });
  } catch {}
  document.getElementById('wplace-save-profile').onclick = () => {
    try {
      const name = (document.getElementById('wplace-profile-name')?.value || '').trim();
      chrome.runtime.sendMessage({ type: 'wplace:set-profile', profileName: name }, (resp) => {
        try {
          const err = chrome.runtime.lastError;
          if (err) { overlayUpdate({ status: 'Save failed' }); return; }
          if (resp && resp.ok) overlayUpdate({ status: 'Profile saved' }); else overlayUpdate({ status: 'Save failed' });
        } catch {}
      });
    } catch {}
  };
  return wrap;
}

function overlayUpdate(fields) {
  ensureOverlay();
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  if (fields && typeof fields === 'object') {
    if ('status' in fields) setText('wplace-status', fields.status);
    if ('auth' in fields) setText('wplace-auth', fields.auth);
    if ('token' in fields) setText('wplace-token', fields.token);
    if ('send' in fields) {
      setText('wplace-send', fields.send);
      try {
        const sendEl = document.getElementById('wplace-send');
        if (sendEl) {
          const val = String(fields.send || '').toLowerCase();
          if (val === 'success') sendEl.style.color = '#8be28b';
          else if (val === 'failed' || val.includes('fail')) sendEl.style.color = '#ef4444';
          else sendEl.style.color = '';
        }
      } catch {}
    }
    if ('tokenFull' in fields && typeof fields.tokenFull === 'string') {
      try { window.__wplaceTokenFull = fields.tokenFull; } catch {}
    }
  }
  try { window.__wplaceLastOverlayUpdate = Date.now(); } catch {}
}

function hasTokenDisplayed() {
  try {
    const el = document.getElementById('wplace-token');
    const text = el && (el.textContent || '').trim();
    return !!(text && text !== '-');
  } catch { return false; }
}

function readPendingAndUpdate() {
  try {
    chrome.storage.local.get(['wplacerPendingToken','wplacerPendingExp','wplacerPendingTs'], (res) => {
      try {
        const token = res && res.wplacerPendingToken;
        if (token) {
          overlayUpdate({ auth: 'Authorized', token: String(token), tokenFull: String(token) });
        }
      } catch {}
    });
  } catch {}
}

function requestSyncFromBackground() {
  try { chrome.runtime.sendMessage({ type: 'wplace:sync' }, () => {}); } catch {}
}

function earlySync() {
  try {
    ensureOverlay();
    overlayUpdate({ status: 'Checking auth…', auth: 'Unknown' });
    readPendingAndUpdate();
    requestSyncFromBackground();
  } catch {}
}

function lateSync() {
  try {
    if (!hasTokenDisplayed()) {
      overlayUpdate({ status: 'Checking auth…' });
      requestSyncFromBackground();
    }
  } catch {}
}

// Kick off early overlay + sync as soon as the script runs
try { earlySync(); } catch {}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => { try { earlySync(); } catch {} }, { once: true });
  window.addEventListener('load', () => { try { lateSync(); } catch {} }, { once: true });
} else {
  setTimeout(() => { try { lateSync(); } catch {} }, 0);
}

function x(xpath, root=document) {
  try {
    const r = root.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return r.singleNodeValue || null;
  } catch (e) {
    console.warn('[AUTO-LOGIN EXTENSION] XPath error for', xpath, e);
    return null;
  }
}

async function waitForXPath(xpath, timeoutMs) {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    const node = x(xpath);
    if (node) return node;
    await new Promise(r => setTimeout(r, 250));
    if (Date.now() - lastLog > 3000) {
      console.log('[AUTO-LOGIN EXTENSION] waitForXPath: waiting for', xpath, Math.floor((Date.now()-start)/1000)+'s');
      lastLog = Date.now();
    }
  }
  return null;
}

function findClickable(selectorOrText) {
  // Try CSS selector first
  try {
    const el = document.querySelector(selectorOrText);
    if (el) return el;
  } catch {}
  // Fallback: search buttons/links by text
  const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const lower = selectorOrText.toLowerCase();
  return candidates.find((el) => (el.textContent || '').trim().toLowerCase().includes(lower)) || null;
}

async function tryOpenLogin() {
  console.log('[AUTO-LOGIN EXTENSION] tryOpenLogin: searching login trigger');
  // If token already present on overlay, skip login
  if (hasTokenDisplayed()) {
    console.log('[AUTO-LOGIN EXTENSION] tryOpenLogin: token already displayed, skip');
    return false;
  }
  // Primary: exact XPath provided by user
  const xpathBtn = '/html/body/div/div[1]/div[2]/div/button';
  let btn = x(xpathBtn);
  if (!btn) btn = await waitForXPath(xpathBtn, 20000);
  if (!btn) {
    // Fallback by class
    btn = document.querySelector('button.btn.btn-primary.shadow-xl');
  }
  if (btn) { console.log('[AUTO-LOGIN EXTENSION] tryOpenLogin: clicking login button'); btn.click(); return true; }
  console.warn('[AUTO-LOGIN EXTENSION] tryOpenLogin: login trigger not found, assuming user is logged in; stopping');
  try { chrome.runtime.sendMessage({ type: 'wplace:abort', reason: 'login_button_not_found_assume_logged_in' }); } catch {}
  return false;
}

async function tryClickGoogle() {
  console.log('[AUTO-LOGIN EXTENSION] tryClickGoogle: waiting for google link after captcha');
  // If token already present on overlay, skip
  if (hasTokenDisplayed()) {
    console.log('[AUTO-LOGIN EXTENSION] tryClickGoogle: token already displayed, skip');
    return false;
  }
  // Wait up to 40s for captcha solve and link to appear
  const xpathA = '/html/body/div/dialog[1]/div/div/div/form/div/a[1]';
  const link = await waitForXPath(xpathA, 40000);
  if (link && link.href) {
    console.log('[AUTO-LOGIN EXTENSION] tryClickGoogle: link found, waiting 2000ms before navigating');
    await new Promise(r => setTimeout(r, 1000));
    console.log('[AUTO-LOGIN EXTENSION] tryClickGoogle: navigating to', link.href);
    try { window.location.href = link.href; } catch { link.click(); }
    return true;
  }
  console.warn('[AUTO-LOGIN EXTENSION] tryClickGoogle: link not found within 40s, aborting');
  try { chrome.runtime.sendMessage({ type: 'wplace:abort', reason: 'google_link_timeout_20s' }); } catch {}
  return false;
}

async function startLoginFlow() {
  console.log('[AUTO-LOGIN EXTENSION] startLoginFlow: begin');
  // If token already present on overlay, stop the flow immediately
  if (hasTokenDisplayed()) {
    console.log('[AUTO-LOGIN EXTENSION] startLoginFlow: token already displayed, stop flow');
    return;
  }
  // Step 1: open login UI if needed
  const opened = await tryOpenLogin();
  if (!opened) { console.log('[AUTO-LOGIN EXTENSION] startLoginFlow: stop (no login button)'); return; }
  // Small wait for modal to render
  await new Promise((r) => setTimeout(r, 600));
  // Step 2: click Google login
  await tryClickGoogle();
  console.log('[AUTO-LOGIN EXTENSION] startLoginFlow: done');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'wplace:start') {
    console.log('[AUTO-LOGIN EXTENSION] onMessage: wplace:start received');
    overlayUpdate({ status: 'Starting…' });
    // If token already present on overlay, do not start
    if (hasTokenDisplayed()) { sendResponse && sendResponse({ ok: true, skipped: true }); return true; }
    startLoginFlow().then(() => sendResponse({ ok: true })).catch((e) => {
      console.warn('[AUTO-LOGIN EXTENSION] startLoginFlow error:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  if (msg && msg.type === 'wplace:log-j') {
    try {
      console.log('[J COOCKIE]', String(msg.value || ''));
      overlayUpdate({ auth: 'Authorized', token: (msg.value ? String(msg.value) : '-'), tokenFull: String(msg.value||'') });
      sendResponse && sendResponse({ ok: true });
    } catch {}
    return false;
  }
  if (msg && msg.type === 'wplace:overlay') {
    try {
      if (msg.show) overlayUpdate({ status: msg.text || 'Working…' }); else overlayUpdate({ status: 'Idle' });
      if (typeof msg.auth === 'string') overlayUpdate({ auth: msg.auth });
      if (typeof msg.send === 'string') overlayUpdate({ send: msg.send });
      if (typeof msg.token === 'string') overlayUpdate({ token: msg.token });
      if (typeof msg.tokenFull === 'string') overlayUpdate({ tokenFull: msg.tokenFull });
    } catch {}
    return false;
  }
});

// Optional auto-start on load after a short delay, but skip if token already displayed
setTimeout(() => {
  try {
    if (hasTokenDisplayed()) { console.log('[AUTO-LOGIN EXTENSION] auto-start skipped (token present)'); return; }
    console.log('[AUTO-LOGIN EXTENSION] auto-start kickoff');
    startLoginFlow();
  } catch (e) { console.warn('[AUTO-LOGIN EXTENSION] auto-start error', e); }
}, 800);


