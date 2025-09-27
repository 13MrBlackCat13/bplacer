
const WPLACE_DOMAIN = "bplace.org";
const WPLACE_URL = "https://bplace.org/";
const BACKEND_ORIGIN = "https://backend.bplace.org";
const COOKIE_NAME = "j";
const COOKIE_S_NAME = "s";

async function getCookieJ() {
  console.log("[AUTO-LOGIN EXTENSION] getCookieJ: querying cookie", COOKIE_NAME, "for", WPLACE_URL);
  return new Promise((resolve) => {
    chrome.cookies.get({ url: WPLACE_URL, name: COOKIE_NAME }, (cookie) => {
      if (chrome.runtime.lastError) {
        console.warn("[AUTO-LOGIN EXTENSION] getCookieJ: error:", chrome.runtime.lastError.message);
      }
      console.log("[AUTO-LOGIN EXTENSION] getCookieJ: result:", !!cookie);
      resolve(cookie || null);
    });
  });
}

async function getCookieJAny() {
  // Try backend first (as in LOAD_UNPACKED), then wplace
  const get = (url) => new Promise((resolve) => chrome.cookies.get({ url, name: COOKIE_NAME }, (c) => resolve(c || null)));
  try {
    const backend = await get(BACKEND_ORIGIN + "/");
    if (backend && backend.value) return backend;
  } catch {}
  try {
    const front = await get(WPLACE_URL);
    if (front && front.value) return front;
  } catch {}
  return null;
}

function setPendingToken(token, expirationDate) {
  try { chrome.storage.local.set({ wplacerPendingToken: String(token||''), wplacerPendingExp: expirationDate||null, wplacerPendingTs: Date.now() }); } catch {}
}

// Block-list of tabs after explicit Logout to avoid re-populating storage from cookies
const blockedTabs = new Set();
function isBlockedTab(tabId) { try { return blockedTabs.has(tabId); } catch { return false; } }

function postLogCookieToTab(tabId, value) {
  try {
    if (isBlockedTab(tabId)) return;
    // Store pending so that content script can read immediately on load
    setPendingToken(value, null);
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (val) => { try { console.log('[J COOCKIE]', String(val||'')); } catch (e) {} },
      args: [String(value)]
    });
    // Also update overlay with details (full token; UI truncates via CSS)
    try {
      chrome.tabs.sendMessage(tabId, {
        type: 'wplace:overlay',
        show: true,
        text: 'Authorized',
        auth: 'Authorized',
        token: String(value),
        tokenFull: String(value)
      });
    } catch {}
    // Immediately send token to local server once per token per tab (best effort)
    try { sendTokenToServer(tabId, value, null); } catch {}
  } catch (e) {
    console.warn('[AUTO-LOGIN EXTENSION] postLogCookieToTab: execScript failed', e?.message || e);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'wplace:log-j', value });
    } catch {}
  }
}

async function getLocalServerUrl(path = '') {
  try {
    const { wplacerPort } = await chrome.storage.local.get(['wplacerPort']);
    const port = wplacerPort || 80;
    return `http://127.0.0.1:${port}${path}`;
  } catch {
    return `http://127.0.0.1:80${path}`;
  }
}

async function sendCookieToLocalServer(jValue, sValue, expirationDate) {
  try {
    const url = await getLocalServerUrl('/user');
    const meta = await (async () => {
      try {
        const { profileName, profilePath } = await chrome.storage.local.get(['profileName','profilePath']);
        return { profileName: profileName || null, profilePath: profilePath || null };
      } catch { return { profileName: null, profilePath: null }; }
    })();
    const body = { cookies: { j: jValue }, expirationDate, ...meta };
    if (sValue) body.cookies.s = sValue;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.status;
  } catch (e) {
    console.warn('[AUTO-LOGIN EXTENSION] sendCookieToLocalServer failed', e?.message || e);
    return 0;
  }
}

// Track last logged token per tab (only for console/overlay dedup)
const lastLoggedCookieByTab = new Map();

async function sendTokenToServer(tabId, token, expirationDate) {
  if (!token) return 0;
  let status = 0;
  try {
    const s = await new Promise(r => chrome.cookies.get({ url: BACKEND_ORIGIN + '/', name: COOKIE_S_NAME }, c => r(c||null)));
    status = await sendCookieToLocalServer(token, s?.value || null, expirationDate || null);
    try { chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: (st, tk) => { try { console.log('[J TOKEN SEND]', st, tk ? tk.slice(0,16)+'…' : '') } catch {} }, args: [`status=${status}`, String(token)] }); } catch {}
  } catch (e) {
    try { chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: (m) => { try { console.log('[J TOKEN SEND ERROR]', m); } catch {} }, args: [String(e?.message||'ERR')] }); } catch {}
  }
  try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: status>=200&&status<300 ? 'Authorized' : 'Send failed', auth: status>=200&&status<300 ? 'Authorized' : 'Not authorized', send: status>=200&&status<300 ? 'Success' : 'Failed', token: token, tokenFull: token }); } catch {}
  return status;
}

// React on aborts from content script: try to print cookie if already present
chrome.runtime.onMessage.addListener((msg, sender) => {
  try {
    if (msg && msg.type === 'wplace:abort' && sender && sender.tab && typeof sender.tab.id === 'number') {
      (async () => {
        try {
          const c = await getCookieJAny();
          if (c && c.value) {
            console.log('[AUTO-LOGIN EXTENSION] onMessage: abort received, j cookie present; logging to page');
            postLogCookieToTab(sender.tab.id, c.value);
          } else {
            console.log('[AUTO-LOGIN EXTENSION] onMessage: abort received, j cookie not found');
          }
        } catch {}
      })();
    }
  } catch {}
});

function openOrActivateTab(targetUrl) {
  console.log("[AUTO-LOGIN EXTENSION] openOrActivateTab:", targetUrl);
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const existing = tabs.find((t) => t.url && t.url.startsWith(targetUrl));
      if (existing) {
        console.log("[AUTO-LOGIN EXTENSION] openOrActivateTab: activating existing tab", existing.id);
        chrome.tabs.update(existing.id, { active: true }, (tab) => resolve(tab));
      } else {
        console.log("[AUTO-LOGIN EXTENSION] openOrActivateTab: no existing tab found; will not create new tab (stay in same window)");
        resolve(null);
      }
    });
  });
}

async function waitForCookie(timeoutMs = 180000) {
  console.log("[AUTO-LOGIN EXTENSION] waitForCookie: start, timeoutMs=", timeoutMs);
  const start = Date.now();
  let aborted = false;
  const onAbort = (msg) => {
    if (msg && msg.type === 'wplace:abort') {
      aborted = true;
      console.warn('[AUTO-LOGIN EXTENSION] waitForCookie: abort signal received:', msg.reason);
    }
  };
  chrome.runtime.onMessage.addListener(onAbort);
  while (Date.now() - start < timeoutMs) {
    if (aborted) {
      chrome.runtime.onMessage.removeListener(onAbort);
      return null;
    }
    const cookie = await getCookieJ();
    if (cookie && cookie.value) {
      console.log("[AUTO-LOGIN EXTENSION] waitForCookie: cookie found");
      chrome.runtime.onMessage.removeListener(onAbort);
      return cookie;
    }
    await new Promise((r) => setTimeout(r, 500));
    const elapsed = Date.now() - start;
    if (elapsed % 5000 < 600) {
      console.log("[AUTO-LOGIN EXTENSION] waitForCookie: still waiting...", Math.floor(elapsed / 1000), "s");
    }
  }
  console.warn("[AUTO-LOGIN EXTENSION] waitForCookie: timeout");
  chrome.runtime.onMessage.removeListener(onAbort);
  return null;
}

async function ensureLoggedIn(triggerTabId) {
  console.log("[AUTO-LOGIN EXTENSION] ensureLoggedIn: invoked, triggerTabId=", triggerTabId);
  const existing = await getCookieJ();
  if (existing && existing.value) {
    console.log("[AUTO-LOGIN EXTENSION] ensureLoggedIn: already logged in");
    return { status: "already" };
  }

  function isWplace(url) {
    try { const u = new URL(url); return u.hostname.endsWith(WPLACE_DOMAIN); } catch { return false; }
  }

  // Determine target tab: prefer triggerTabId if it's wplace, else any existing wplace tab
  const targetTab = await new Promise((resolve) => {
    if (typeof triggerTabId === 'number') {
      chrome.tabs.get(triggerTabId, (tab) => {
        if (tab && tab.url && isWplace(tab.url)) resolve(tab); else resolve(null);
      });
    } else resolve(null);
  });

  let wplaceTab = targetTab;
  if (!wplaceTab) {
    wplaceTab = await new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const found = tabs.find((t) => t.url && isWplace(t.url));
        resolve(found || null);
      });
    });
  }

  if (!wplaceTab) {
    console.warn('[AUTO-LOGIN EXTENSION] ensureLoggedIn: no wplace tab found; aborting (no new tab will be created)');
    return { status: 'no_tab' };
  }

  console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: triggering content flow in tab', wplaceTab.id);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise((resolve) => {
      chrome.tabs.sendMessage(wplaceTab.id, { type: 'wplace:start' }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) console.warn('[AUTO-LOGIN EXTENSION] ensureLoggedIn: sendMessage error:', err.message);
        else console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: content response:', resp);
        resolve();
      });
    });
  } catch {}

  // Listen navigation updates lightly to detect redirect back to wplace
  const onUpdated = (tabId, changeInfo, tab) => {
    if (!wplaceTab || tabId !== wplaceTab.id) return;
    if (changeInfo.url && changeInfo.url.startsWith("https://")) {
      console.log("[AUTO-LOGIN EXTENSION] onUpdated: tab navigated:", changeInfo.url);
    }
  };
  chrome.tabs.onUpdated.addListener(onUpdated);

  const cookie = await waitForCookie();
  chrome.tabs.onUpdated.removeListener(onUpdated);

  if (cookie && cookie.value) {
    try {
      const reloadId = (wplaceTab && wplaceTab.id) || triggerTabId;
      if (typeof reloadId === 'number') {
        console.log('[AUTO-LOGIN EXTENSION] ensureLoggedIn: reloading tab', reloadId);
        chrome.tabs.reload(reloadId);
      }
    } catch {}
    return { status: 'ok', cookie: cookie.value };
  }
  console.warn("[AUTO-LOGIN EXTENSION] ensureLoggedIn: cookie not set after waiting");
  throw new Error("cookie_not_set");
}

// Trigger on install and on any visit to bplace.org
chrome.runtime.onInstalled.addListener(() => {
  console.log("[AUTO-LOGIN EXTENSION] onInstalled: creating periodic alarm");
  chrome.alarms.create("wplace-check", { periodInMinutes: 5 });
  // One-time initial send shortly after install
  setTimeout(() => { try { attemptInitialSendOnce(); } catch {} }, 500);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "wplace-check") return;
  console.log("[AUTO-LOGIN EXTENSION] onAlarm: wplace-check fired");
  try { await ensureLoggedIn(); } catch (e) { console.warn("[AUTO-LOGIN EXTENSION] onAlarm: ensureLoggedIn error:", e?.message || e); }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab?.url) return;
  let urlObj;
  try { urlObj = new URL(tab.url); } catch { return; }
  if (!urlObj.hostname.endsWith(WPLACE_DOMAIN)) return;

  // As soon as loading starts, lift any prior logout block for this tab
  if (changeInfo.status === 'loading') {
    try { blockedTabs.delete(tabId); } catch {}
  }

  // Immediate check as soon as loading starts: only show status/overlay/token (no send yet, to avoid double send)
  if (changeInfo.status === 'loading') {
    try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Checking auth…', auth: 'Unknown' }); } catch {}
    try {
      const c0 = await getCookieJAny();
      if (c0 && c0.value) {
        setPendingToken(c0.value, c0.expirationDate);
        postLogCookieToTab(tabId, c0.value);
      }
    } catch {}
    return;
  }

  // On complete, run login flow, show token and SEND (like LOAD_UNPACKED)
  if (changeInfo.status === 'complete') {
    try {
      console.log("[AUTO-LOGIN EXTENSION] tabs.onUpdated: wplace tab completed, tabId=", tabId);
      try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Checking auth…', auth: 'Unknown' }); } catch {}
      try { await ensureLoggedIn(tabId); } catch (e) { console.warn('[AUTO-LOGIN EXTENSION] tabs.onUpdated: ensureLoggedIn error:', e?.message || e); }
      const start = Date.now();
      let sent = false;
      while (Date.now() - start < 5000) {
        try {
          const c = await getCookieJAny();
          if (c && c.value) {
            setPendingToken(c.value, c.expirationDate);
            postLogCookieToTab(tabId, c.value);
            await sendTokenToServer(tabId, c.value, c.expirationDate);
            sent = true; break;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 250));
      }
      if (!sent) {
        try {
          const c = await getCookieJAny();
          if (c && c.value) {
            setPendingToken(c.value, c.expirationDate);
            postLogCookieToTab(tabId, c.value);
            await sendTokenToServer(tabId, c.value, c.expirationDate);
          } else try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Not authorized', auth: 'Not authorized' }); } catch {}
        } catch {}
      }
    } catch {}
  }
});

// Periodic cookie logger every 5s from SW, independent of login flow
setInterval(async () => {
  try {
    const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
    for (const t of tabs || []) {
      try {
        if (!t.url) continue;
        const u = new URL(t.url);
        if (!u.hostname.endsWith(WPLACE_DOMAIN)) continue;
        const c = await getCookieJAny();
        if (c && c.value) {
          const prev = lastLoggedCookieByTab.get(t.id);
          if (prev !== c.value) {
            console.log('[AUTO-LOGIN EXTENSION] periodic cookie log for tab', t.id);
            postLogCookieToTab(t.id, c.value);
            lastLoggedCookieByTab.set(t.id, c.value);
          }
        } else {
          try { chrome.tabs.sendMessage(t.id, { type: 'wplace:overlay', show: true, text: 'Not authorized', auth: 'Not authorized' }); } catch {}
        }
      } catch {}
    }
  } catch {}
}, 5000);

chrome.tabs.onRemoved.addListener((tabId) => {
  try { lastLoggedCookieByTab.delete(tabId); } catch {}
  try { blockedTabs.delete(tabId); } catch {}
});

// Manual overlay button handlers from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!msg || typeof tabId !== 'number') return;
    if (msg.type === 'wplace:sync') {
      (async () => {
        try {
          // If we were blocked but storage does not contain a pending token, lift the block and proceed
          if (isBlockedTab(tabId)) {
            try {
              const { wplacerPendingToken } = await chrome.storage.local.get(['wplacerPendingToken']);
              if (!wplacerPendingToken) blockedTabs.delete(tabId);
            } catch {}
          }
          if (isBlockedTab(tabId)) {
            try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Not authorized', auth: 'Not authorized', token: '-', tokenFull: '-' }); } catch {}
          } else {
            const c = await getCookieJAny();
            if (c && c.value) {
              setPendingToken(c.value, c.expirationDate);
              postLogCookieToTab(tabId, c.value);
            } else {
              try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Not authorized', auth: 'Not authorized' }); } catch {}
            }
          }
        } catch {}
        try { sendResponse && sendResponse({ ok: true }); } catch {}
      })();
      return true;
    }
    if (msg.type === 'wplace:set-port') {
      (async () => {
        try {
          const port = (typeof msg.port === 'number' && msg.port > 0 && msg.port <= 65535) ? msg.port : 80;
          await chrome.storage.local.set({ wplacerPort: port });
          try { sendResponse && sendResponse({ ok: true, port }); } catch {}
        } catch {
          try { sendResponse && sendResponse({ ok: false }); } catch {}
        }
      })();
      return true;
    }
    if (msg.type === 'wplace:logout') {
      (async () => {
        try {
          blockedTabs.add(tabId);
          try {
            const all = await chrome.storage.local.get(null);
            const keys = Object.keys(all || {}).filter((k) => k !== 'profileName');
            if (keys.length > 0) await chrome.storage.local.remove(keys);
          } catch {}
          try { lastLoggedCookieByTab.delete(tabId); } catch {}
        } catch {}
        try {
          chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Not authorized', auth: 'Not authorized', token: '-', tokenFull: '-' });
        } catch {}
        try { sendResponse && sendResponse({ ok: true }); } catch {}
      })();
      return true;
    }
    if (msg.type === 'wplace:set-profile') {
      (async () => {
        try {
          const incomingName = (typeof msg.profileName === 'string') ? msg.profileName.trim() : '';
          const isSeed = !!msg.isSeed;
          const current = await chrome.storage.local.get(['profileName']);
          let toSave = {};
          if (isSeed) {
            if (!current.profileName && incomingName) toSave.profileName = incomingName;
          } else {
            if (typeof msg.profileName !== 'undefined') toSave.profileName = incomingName;
          }
          if (Object.keys(toSave).length > 0) await chrome.storage.local.set(toSave);
          try { sendResponse && sendResponse({ ok: true, ...current, ...toSave }); } catch {}
        } catch {
          try { sendResponse && sendResponse({ ok: false }); } catch {}
        }
      })();
      return true;
    }
    if (msg.type === 'wplace:manual-refresh') {
      (async () => {
        try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Refreshing…' }); } catch {}
        // immediate cookie check
        try {
          const c0 = await getCookieJAny();
          if (c0 && c0.value) postLogCookieToTab(tabId, c0.value);
        } catch {}
        try { await ensureLoggedIn(tabId); } catch {}
        try {
          const c = await getCookieJAny();
          if (c && c.value) {
            setPendingToken(c.value, c.expirationDate);
            postLogCookieToTab(tabId, c.value);
            await sendTokenToServer(tabId, c.value, c.expirationDate);
          } else try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Not authorized', auth: 'Not authorized' }); } catch {}
        } catch {}
        try { sendResponse && sendResponse({ ok: true }); } catch {}
      })();
      return true;
    }
    if (msg.type === 'wplace:manual-send') {
      (async () => {
        try { chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: 'Sending…', send: 'Sending…' }); } catch {}
        let status = 0;
        try {
          const providedToken = typeof msg.token === 'string' && msg.token.trim() ? msg.token.trim() : null;
          if (providedToken) {
            setPendingToken(providedToken, null);
            status = await sendTokenToServer(tabId, providedToken, null);
          } else {
            const j = await new Promise(r => chrome.cookies.get({ url: BACKEND_ORIGIN + '/', name: COOKIE_NAME }, c => r(c||null)));
            if (j && j.value) {
              setPendingToken(j.value, j.expirationDate);
              status = await sendTokenToServer(tabId, j.value, j.expirationDate);
            }
          }
        } catch (e) {
          console.warn('[AUTO-LOGIN EXTENSION] manual-send failed', e?.message || e);
          try { chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: (m) => { try { console.log('[J TOKEN SEND ERROR]', m); } catch {} }, args: [String(e?.message||'ERR')] }); } catch {}
        }
        try {
          const ok = status >= 200 && status < 300;
          chrome.tabs.sendMessage(tabId, { type: 'wplace:overlay', show: true, text: ok ? 'Authorized' : 'Send failed', auth: ok ? 'Authorized' : 'Not authorized', send: ok ? 'Success' : 'Failed' });
        } catch {}
        try { sendResponse && sendResponse({ ok: true, status }); } catch {}
      })();
      return true;
    }
  } catch {}
});

// One-time auto-send after SW starts (first evaluation)
let initialSendDone = false;
async function attemptInitialSendOnce() {
  if (initialSendDone) return;
  initialSendDone = true;
  try {
    const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
    for (const t of tabs || []) {
      try {
        if (!t.url) continue;
        const u = new URL(t.url);
        if (!u.hostname.endsWith(WPLACE_DOMAIN)) continue;
        const j = await getCookieJAny();
        if (j && j.value) {
          setPendingToken(j.value, j.expirationDate);
          postLogCookieToTab(t.id, j.value);
          // attempt a one-time send
          await sendTokenToServer(t.id, j.value, j.expirationDate);
        }
      } catch {}
    }
  } catch {}
}

// schedule an attempt after SW loads
setTimeout(() => { try { attemptInitialSendOnce(); } catch {} }, 700);

// Toolbar action: manual trigger
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const res = await ensureLoggedIn(tab?.id);
    console.log("[AUTO-LOGIN EXTENSION] action.onClicked: result:", res);
  } catch (e) {
    console.warn("[AUTO-LOGIN EXTENSION] action.onClicked: error:", e?.message || e);
  }
});


