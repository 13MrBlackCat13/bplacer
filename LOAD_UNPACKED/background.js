
const POLL_ALARM_NAME = 'wplacer-poll-alarm';
const COOKIE_ALARM_NAME = 'wplacer-cookie-alarm';
const SAFETY_REFRESH_ALARM_NAME = 'wplacer-safety-refresh-alarm';
const TOKEN_TIMEOUT_ALARM_NAME = 'wplacer-token-timeout-alarm';
const AUTO_RELOAD_ALARM_NAME = 'wplacer-auto-reload-alarm';

const getSettings = async () => {
    const result = await chrome.storage.local.get(['wplacerPort', 'wplacerAutoReload']);

    // Force port to 3001 if it's still set to 80 or 3000
    let port = result.wplacerPort || 3001;
    if (port === 80 || port === 3000) {
        port = 3001;
        // Update stored port
        chrome.storage.local.set({ wplacerPort: 3001 });
        console.log('wplacer: Updated port to 3001');
    }

    console.log(`wplacer: Using port ${port}`);

    return {
        port: port,
        host: '127.0.0.1',
        autoReloadInterval: result.wplacerAutoReload || 0
    };
};

const getServerUrl = async (path = '') => {
    const { host, port } = await getSettings();
    const url = `http://${host}:${port}${path}`;
    console.log(`wplacer: Connecting to ${url}`);
    return url;
};

let LP_ACTIVE = false;
let TOKEN_IN_PROGRESS = false;
let LAST_RELOAD_AT = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
const TOKEN_TIMEOUT_MS = 25000;
let TOKEN_TIMEOUT_ID = null;
const FAST_RETRY_DELAY_MS = 7000;
const FAST_RETRY_MAX = 3;
let fastRetriesLeft = 0;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Auto-reload management
const updateAutoReloadAlarm = async () => {
    try {
        await chrome.alarms.clear(AUTO_RELOAD_ALARM_NAME);
        const settings = await getSettings();
        if (settings.autoReloadInterval > 0) {
            await chrome.alarms.create(AUTO_RELOAD_ALARM_NAME, {
                delayInMinutes: settings.autoReloadInterval / 60,
                periodInMinutes: settings.autoReloadInterval / 60
            });
            console.log(`wplacer: Auto-reload alarm set for ${settings.autoReloadInterval} seconds`);
        } else {
            console.log("wplacer: Auto-reload disabled");
        }
    } catch (error) {
        console.error("wplacer: Failed to update auto-reload alarm:", error);
    }
};

const performAutoReload = async () => {
    try {
        const tabs = await chrome.tabs.query({ url: "https://bplace.org/*" });
        if (tabs && tabs.length > 0) {
            console.log(`wplacer: Auto-reloading ${tabs.length} wplace.live tab(s)`);
            for (const tab of tabs) {
                try {
                    await injectPawtectIntoTab(tab.id);
                    await chrome.tabs.reload(tab.id, { bypassCache: true });
                } catch (error) {
                    console.warn(`wplacer: Failed to reload tab ${tab.id}:`, error);
                }
            }
        }
    } catch (error) {
        console.error("wplacer: Auto-reload failed:", error);
    }
};

async function startLongPoll() {
    if (LP_ACTIVE) return;
    LP_ACTIVE = true;
    while (LP_ACTIVE) {
        try {
            const url = await getServerUrl("/token-needed/long");
            const r = await fetch(url, { cache: "no-store" });
            if (r.ok) {
                const data = await r.json();
                if (data.needed) {
                    await maybeInitiateReload();
                    // start fast retries to avoid long idle gaps
                    fastRetriesLeft = FAST_RETRY_MAX;
                    scheduleFastRetry();
                }
            } else {
                await wait(1000);
            }
        } catch (_) {
            await wait(2000);
        }
    }
}

const clearTokenWait = () => {
    try { if (TOKEN_TIMEOUT_ID) { clearTimeout(TOKEN_TIMEOUT_ID); TOKEN_TIMEOUT_ID = null; } } catch {}
    TOKEN_IN_PROGRESS = false;
    fastRetriesLeft = 0;
};

const maybeInitiateReload = async () => {
    const now = Date.now();
    if (TOKEN_IN_PROGRESS) return;
    if (now - LAST_RELOAD_AT < MIN_RELOAD_INTERVAL_MS) return;
    TOKEN_IN_PROGRESS = true;
    await initiateReload();
    LAST_RELOAD_AT = Date.now();
    try {
        if (TOKEN_TIMEOUT_ID) clearTimeout(TOKEN_TIMEOUT_ID);
    } catch {}
    TOKEN_TIMEOUT_ID = setTimeout(() => {
        console.warn('wplacer: token wait timed out, retrying...');
        clearTokenWait();
        // trigger next cycle quickly
        pollForTokenRequest();
        fastRetriesLeft = FAST_RETRY_MAX;
        scheduleFastRetry();
    }, TOKEN_TIMEOUT_MS);
    // Backup alarm in case service worker sleeps
    try { chrome.alarms.clear(TOKEN_TIMEOUT_ALARM_NAME); } catch {}
    try { chrome.alarms.create(TOKEN_TIMEOUT_ALARM_NAME, { delayInMinutes: 1 }); } catch {}
};

const scheduleFastRetry = () => {
    if (fastRetriesLeft <= 0) return;
    setTimeout(async () => {
        if (fastRetriesLeft <= 0) return;
        if (!TOKEN_IN_PROGRESS) {
            await maybeInitiateReload();
        }
        fastRetriesLeft -= 1;
        if (fastRetriesLeft > 0) scheduleFastRetry();
    }, FAST_RETRY_DELAY_MS);
};

const pollForTokenRequest = async () => {
    console.log("wplacer: Polling server for token request...");
    try {
        const url = await getServerUrl("/token-needed");
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`wplacer: Server poll failed with status: ${response.status}`);
            return;
        }
        const data = await response.json();
        if (data.needed) {
            console.log("wplacer: Server requires a token. Initiating reload.");
            await initiateReload();
            fastRetriesLeft = FAST_RETRY_MAX;
            scheduleFastRetry();
        }
    } catch (error) {
        console.error("wplacer: Could not connect to the server to poll for tokens.", error.message);
    }
};

const injectPawtectIntoTab = async (tabId) => {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
                if (window.__wplacerPawtectHooked) return;
                window.__wplacerPawtectHooked = true;
                const backend = 'https://bplace.org';
                const findPawtectPath = async () => {
                    const cacheKey = 'wplacer_pawtect_path';
                    const cacheTimeKey = 'wplacer_pawtect_cache_time';
                    const cacheExpiry = 5 * 60 * 1000;
                    let pawtectPath = localStorage.getItem(cacheKey);
                    const cacheTime = localStorage.getItem(cacheTimeKey);
                    if (pawtectPath && cacheTime && (Date.now() - parseInt(cacheTime)) < cacheExpiry) return pawtectPath;
                    const links = Array.from(document.querySelectorAll('link[rel="modulepreload"]')).map(l => l.href);
                    for (const url of links) {
                        try {
                            const res = await fetch(url);
                            const text = await res.text();
                            if (text.includes('get_pawtected_endpoint_payload')) {
                                pawtectPath = url;
                                localStorage.setItem(cacheKey, pawtectPath);
                                localStorage.setItem(cacheTimeKey, Date.now().toString());
                                return pawtectPath;
                            }
                        } catch {}
                    }
                    return null;
                };
                const computeInstall = async () => {
                    const pawtectPath = await findPawtectPath();
                    if (!pawtectPath) return;
                    const mod = await import(pawtectPath);
                    const originalFetch = window.fetch.bind(window);
                    const computePawtect = async (url, bodyStr) => {
                        if (!mod || typeof mod._ !== 'function') return null;
                        const wasm = await mod._();
                        try {
                            const me = await fetch(`${backend}/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
                            if (me?.id) {
                                for (const key of Object.keys(mod)) {
                                    const fn = mod[key];
                                    if (typeof fn === 'function') {
                                        try { const s = fn.toString(); if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(s)) { fn(me.id); break; } } catch {}
                                    }
                                }
                            }
                        } catch {}
                        if (typeof mod.r === 'function') mod.r(url);
                        const enc = new TextEncoder();
                        const dec = new TextDecoder();
                        const bytes = enc.encode(bodyStr);
                        const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                        new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                        const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                        let token;
                        if (Array.isArray(out)) { const [ptr,len] = out; token = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len)); try { wasm.__wbindgen_free(ptr, len, 1); } catch {} }
                        else if (typeof out === 'string') token = out;
                        else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') { token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len)); try { wasm.__wbindgen_free(out.ptr, out.len, 1); } catch {} }
                        window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'pixel' }, '*');
                        return token;
                    };
                    window.fetch = async (...args) => {
                        try {
                            const input = args[0];
                            const init = args[1] || {};
                            const req = new Request(input, init);
                            if (req.method === 'POST' && /\/s0\/pixel\//.test(req.url)) {
                                const raw = typeof init.body === 'string' ? init.body : null;
                                if (raw) computePawtect(req.url, raw);
                                else { try { const clone = req.clone(); const text = await clone.text(); computePawtect(req.url, text); } catch {} }
                            }
                        } catch {}
                        return originalFetch(...args);
                    };
                };
                computeInstall().catch(() => {});
            }
        });
    } catch (e) {
        console.warn('wplacer: injectPawtectIntoTab failed', e);
    }
};

const initiateReload = async () => {
    try {
        let tabs = await chrome.tabs.query({ url: "https://bplace.org/*" });
        if (!tabs || tabs.length === 0) {
            console.warn("wplacer: No wplace.live tabs found. Opening a new one for token acquisition.");
            const created = await chrome.tabs.create({ url: "https://bplace.org/" });
            tabs = [created];
        }
        const targetTab = tabs.find(t => t.active) || tabs[0];
        console.log(`wplacer: Preparing tab #${targetTab.id} for token reload (inject pawtect + reload)`);
        try { await injectPawtectIntoTab(targetTab.id); } catch {}
        await wait(150);
        console.log(`wplacer: Sending reload command to tab #${targetTab.id}`);
        try { await chrome.tabs.sendMessage(targetTab.id, { action: "reloadForToken" }); } catch {}
        // Ensure reload even if content script didn't handle the message
        setTimeout(async () => {
            try {
                await chrome.tabs.update(targetTab.id, { active: true });
            } catch {}
            try {
                await chrome.tabs.reload(targetTab.id, { bypassCache: true });
            } catch {
                try {
                    const appended = (targetTab.url || 'https://bplace.org/').replace(/[#?]$/, '');
                    const url = appended + (appended.includes('?') ? '&' : '?') + 'wplacer=' + Date.now();
                    await chrome.tabs.update(targetTab.id, { url });
                } catch {}
            }
            // Second shot after 1.5s if нужно
            setTimeout(async () => {
                try { const t = await chrome.tabs.get(targetTab.id); if (t.status !== 'loading') { await chrome.tabs.reload(targetTab.id, { bypassCache: true }); } } catch {}
            }, 1500);
        }, 200);
    } catch (error) {
        console.error("wplacer: Error sending reload message to tab, falling back to direct reload.", error);
        const tabs = await chrome.tabs.query({ url: "https://bplace.org/*" });
        if (tabs && tabs.length > 0) {
            chrome.tabs.reload((tabs.find(t => t.active) || tabs[0]).id);
        } else {
            await chrome.tabs.create({ url: "https://bplace.org/" });
        }
    }
};

const sendCookie = async (callback) => {
    const getCookie = (details) => new Promise(resolve => chrome.cookies.get(details, cookie => resolve(cookie)));

    console.log("wplacer: Looking for cookies on bplace.org...");

    const [jCookie, cfClearanceCookie] = await Promise.all([
        getCookie({ url: "https://bplace.org", name: "j" }),
        getCookie({ url: "https://bplace.org", name: "cf_clearance" })
    ]);

    console.log("wplacer: Found j cookie:", !!jCookie);
    console.log("wplacer: Found cf_clearance cookie:", !!cfClearanceCookie);

    if (jCookie) {
        console.log("wplacer: j cookie details:", {
            domain: jCookie.domain,
            path: jCookie.path,
            secure: jCookie.secure,
            httpOnly: jCookie.httpOnly
        });

        // Try to find cf_clearance on the same domain as j cookie
        const cfOnJDomain = await getCookie({ url: `https://${jCookie.domain.startsWith('.') ? jCookie.domain.substring(1) : jCookie.domain}`, name: "cf_clearance" });
        console.log("wplacer: cf_clearance on j cookie domain:", !!cfOnJDomain);
        if (cfOnJDomain) {
            console.log("wplacer: cf_clearance details:", {
                domain: cfOnJDomain.domain,
                path: cfOnJDomain.path,
                value: cfOnJDomain.value.substring(0, 20) + "..."
            });
        }
    }

    // ALWAYS get all cookies for debug (not just when jCookie is missing)
    chrome.cookies.getAll({domain: "bplace.org"}, (cookies) => {
        console.log("wplacer: All cookies for bplace.org:", cookies.length);
        cookies.forEach(cookie => console.log(`- ${cookie.name}: ${cookie.domain}${cookie.path} (value: ${cookie.value.substring(0, 20)}...)`));
    });

    // Also try different domain variations
    chrome.cookies.getAll({domain: ".bplace.org"}, (cookies) => {
        console.log("wplacer: All cookies for .bplace.org:", cookies.length);
        cookies.forEach(cookie => console.log(`- ${cookie.name}: ${cookie.domain}${cookie.path} (value: ${cookie.value.substring(0, 20)}...)`));
    });

    // Try getting ALL cookies and filter
    chrome.cookies.getAll({}, (cookies) => {
        const bplaceCookies = cookies.filter(c => c.domain.includes('bplace'));
        console.log("wplacer: All bplace-related cookies found:", bplaceCookies.length);
        bplaceCookies.forEach(cookie => console.log(`- ${cookie.name}: ${cookie.domain}${cookie.path} (value: ${cookie.value.substring(0, 20)}...)`));
    });

    if (!jCookie) {

        chrome.cookies.getAll({domain: "backend.bplace.org"}, (cookies) => {
            console.log("wplacer: All cookies for backend.bplace.org:", cookies.length);
            cookies.forEach(cookie => console.log(`- ${cookie.name}: ${cookie.domain}${cookie.path}`));
        });

        if (callback) callback({ success: false, error: "Cookie 'j' not found. Are you logged in to bplace.org?" });
        return;
    }

    const cookies = { j: jCookie.value };
    if (cfClearanceCookie) cookies.cf_clearance = cfClearanceCookie.value;
    const url = await getServerUrl("/user");

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies, expirationDate: jCookie.expirationDate })
        });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        const userInfo = await response.json();
        if (callback) callback({ success: true, name: userInfo.name });
    } catch (error) {
        if (callback) callback({ success: false, error: "Could not connect to the wplacer server." });
    }
};

const quickLogout = (callback) => {
    const origins = ["https://bplace.org/", "https://bplace.org/"];
    console.log(`wplacer: Clearing browsing data for ${origins.join(', ')}`);
    chrome.browsingData.remove({
        origins: origins
    }, {
        cache: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        pluginData: true,
        serviceWorkers: true,
        webSQL: true
    }, () => {
        if (chrome.runtime.lastError) {
            console.error("wplacer: Error clearing browsing data.", chrome.runtime.lastError);
            if (callback) callback({ success: false, error: "Failed to clear data." });
        } else {
            console.log("wplacer: Browsing data cleared successfully. Reloading wplace.live tabs.");
            chrome.tabs.query({ url: "https://bplace.org/*" }, (tabs) => {
                if (tabs && tabs.length > 0) {
                    tabs.forEach(tab => chrome.tabs.reload(tab.id));
                }
            });
            if (callback) callback({ success: true });
        }
    });
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "sendCookie") {
        sendCookie(sendResponse);
        return true;
    }
    if (request.action === "settingsUpdated") {
        LP_ACTIVE = false;
        setTimeout(startLongPoll, 100);
        updateAutoReloadAlarm();
        if (sendResponse) sendResponse({ ok: true });
        return false;
    }
    if (request.action === "injectPawtect") {
        try {
            if (sender.tab?.id) {
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: () => {
                        if (window.__wplacerPawtectHooked) return;
                        window.__wplacerPawtectHooked = true;

                        const backend = 'https://bplace.org';
                        
                        const findPawtectPath = async () => {
                            const cacheKey = 'wplacer_pawtect_path';
                            const cacheTimeKey = 'wplacer_pawtect_cache_time';
                            const cacheExpiry = 5 * 60 * 1000; // 5 minutes
                            
                            let pawtectPath = localStorage.getItem(cacheKey);
                            const cacheTime = localStorage.getItem(cacheTimeKey);
                            
                            if (pawtectPath && cacheTime && (Date.now() - parseInt(cacheTime)) < cacheExpiry) {
                                return pawtectPath;
                            }
                            
                            console.log("[SEARCHING for Pawtect chunk...]");
                            const links = Array.from(document.querySelectorAll('link[rel="modulepreload"]'))
                                .map(l => l.href);
                            
                            for (const url of links) {
                                try {
                                    const res = await fetch(url);
                                    const text = await res.text();
                                    if (text.includes("get_pawtected_endpoint_payload")) {
                                        pawtectPath = url;
                                        console.log("[FOUND Pawtect chunk]:", url);
                                        localStorage.setItem(cacheKey, pawtectPath);
                                        localStorage.setItem(cacheTimeKey, Date.now().toString());
                                        return pawtectPath;
                                    }
                                } catch (e) {
                                    console.log("Failed to fetch", url, e);
                                }
                            }
                            
                            return null;
                        };
                        
                        const importModule = async () => {
                            try {
                                const pawtectPath = await findPawtectPath();
                                if (!pawtectPath) {
                                    console.warn('pawtect: Could not find Pawtect chunk!');
                                    return null;
                                }
                                
                                try {
                                    console.log("[USING Pawtect path]:", pawtectPath);
                                    return await import(pawtectPath);
                                } catch (e) {
                                    console.log("[PATH FAILED, clearing cache and finding new one]:", e);
                                    localStorage.removeItem('wplacer_pawtect_path');
                                    localStorage.removeItem('wplacer_pawtect_cache_time');
                                    const newPath = await findPawtectPath();
                                    if (newPath) {
                                        return await import(newPath);
                                    }
                                    return null;
                                }
                            } catch (e) {
                                console.warn('pawtect: module import failed', e?.message || e);
                                return null;
                            }
                        };

                        const findSetUserIdFunction = (mod) => {
                            for (const key of Object.keys(mod)) {
                                const fn = mod[key];
                                if (typeof fn === "function") {
                                    try {
                                        const str = fn.toString();
                                        if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(str)) {
                                            return fn;
                                        }
                                    } catch {}
                                }
                            }
                            return null;
                        };

                        const computePawtect = async (url, bodyStr) => {
                            const mod = await importModule();
                            if (!mod || typeof mod._ !== 'function') return null;
                            const wasm = await mod._();
                            try {
                                const me = await fetch(`${backend}/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
                                if (me?.id) {
                                    const setUserIdFn = findSetUserIdFunction(mod);
                                    if (setUserIdFn) {
                                        console.log('Set userId', me.id);
                                        setUserIdFn(me.id);
                                    }
                                }
                            } catch {}
                            if (typeof mod.r === 'function') mod.r(url);
                            const enc = new TextEncoder();
                            const dec = new TextDecoder();
                            const bytes = enc.encode(bodyStr);
                            const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                            new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                            console.log('wplacer: pawtect compute start', { url, bodyLen: bodyStr.length });
                            const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                            let token;
                            if (Array.isArray(out)) {
                                const [outPtr, outLen] = out;
                                token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                try { wasm.__wbindgen_free(outPtr, outLen, 1); } catch {}
                            } else if (typeof out === 'string') {
                                token = out;
                            } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                try { wasm.__wbindgen_free(out.ptr, out.len, 1); } catch {}
                            } else {
                                console.warn('wplacer: unexpected pawtect out shape', typeof out);
                                token = null;
                            }
                            console.log('wplacer: pawtect compute done, tokenLen:', token ? token.length : 0);
                            window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'pixel' }, '*');
                            return token;
                        };

                        const originalFetch = window.fetch.bind(window);
                        window.fetch = async (...args) => {
                            try {
                                const input = args[0];
                                const init = args[1] || {};
                                const req = new Request(input, init);
                                if (req.method === 'POST' && /\/s0\/pixel\//.test(req.url)) {
                                    const raw = typeof init.body === 'string' ? init.body : null;
                                    if (raw) {
                                        console.log('wplacer: hook(fetch) pixel POST detected (init.body)', req.url, 'len', raw.length);
                                        computePawtect(req.url, raw);
                                    } else {
                                        try {
                                            const clone = req.clone();
                                            const text = await clone.text();
                                            console.log('wplacer: hook(fetch) pixel POST detected (clone)', req.url, 'len', text.length);
                                            computePawtect(req.url, text);
                                        } catch {}
                                    }
                                }
                            } catch {}
                            return originalFetch(...args);
                        };
                        try {
                            const origOpen = XMLHttpRequest.prototype.open;
                            const origSend = XMLHttpRequest.prototype.send;
                            XMLHttpRequest.prototype.open = function(method, url) {
                                try {
                                    this.__wplacer_url = new URL(url, location.href).href;
                                    this.__wplacer_method = String(method || '');
                                } catch {}
                                return origOpen.apply(this, arguments);
                            };
                            XMLHttpRequest.prototype.send = function(body) {
                                try {
                                    if ((this.__wplacer_method || '').toUpperCase() === 'POST' && /\/s0\/pixel\//.test(this.__wplacer_url || '')) {
                                        const url = this.__wplacer_url;
                                        const maybeCompute = (raw) => { if (raw && typeof raw === 'string') computePawtect(url, raw); };
                                        if (typeof body === 'string') {
                                            console.log('wplacer: hook(XHR) pixel POST detected (string)', url, 'len', body.length);
                                            maybeCompute(body);
                                        } else if (body instanceof ArrayBuffer) {
                                            try { const s = new TextDecoder().decode(new Uint8Array(body)); console.log('wplacer: hook(XHR) pixel POST detected (ArrayBuffer)', url, 'len', s.length); maybeCompute(s); } catch {}
                                        } else if (body && typeof body === 'object' && 'buffer' in body && body.buffer instanceof ArrayBuffer) {
                                            // e.g., Uint8Array
                                            try { const s = new TextDecoder().decode(new Uint8Array(body.buffer)); console.log('wplacer: hook(XHR) pixel POST detected (TypedArray)', url, 'len', s.length); maybeCompute(s); } catch {}
                                        } else if (body && typeof body.text === 'function') {
                                            // Blob or similar
                                            try { body.text().then(s => { console.log('wplacer: hook(XHR) pixel POST detected (Blob)', url, 'len', (s||'').length); maybeCompute(s); }).catch(() => {}); } catch {}
                                        }
                                    }
                                } catch {}
                                return origSend.apply(this, arguments);
                            };
                        } catch {}
                        console.log('wplacer: pawtect fetch hook installed');
                    }
                });
            }
        } catch (e) {
            console.error('wplacer: failed to inject pawtect hook', e);
        }
        sendResponse({ ok: true });
        return true;
    }
    if (request.action === 'seedPawtect') {
        try {
            if (sender.tab?.id) {
                const bodyStr = String(request.bodyStr || '{"colors":[0],"coords":[1,1],"fp":"seed","t":"seed"}');
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: (rawBody) => {
                        (async () => {
                            try {
                                const backend = 'https://bplace.org';
                                const url = `${backend}/s0/pixel/1/1`;
                                
                                const findPawtectPath = async () => {
                                    const cacheKey = 'wplacer_pawtect_path';
                                    const cacheTimeKey = 'wplacer_pawtect_cache_time';
                                    const cacheExpiry = 5 * 60 * 1000;
                                    
                                    let pawtectPath = localStorage.getItem(cacheKey);
                                    const cacheTime = localStorage.getItem(cacheTimeKey);
                                    
                                    if (pawtectPath && cacheTime && (Date.now() - parseInt(cacheTime)) < cacheExpiry) {
                                        return pawtectPath;
                                    }
                                    
                                    const links = Array.from(document.querySelectorAll('link[rel="modulepreload"]'))
                                        .map(l => l.href);
                                    
                                    for (const url of links) {
                                        try {
                                            const res = await fetch(url);
                                            const text = await res.text();
                                            if (text.includes("get_pawtected_endpoint_payload")) {
                                                pawtectPath = url;
                                                localStorage.setItem(cacheKey, pawtectPath);
                                                localStorage.setItem(cacheTimeKey, Date.now().toString());
                                                return pawtectPath;
                                            }
                                        } catch (e) {}
                                    }
                                    
                                    return null;
                                };
                                
                                const pawtectPath = await findPawtectPath();
                                if (!pawtectPath) return;
                                
                                const mod = await import(pawtectPath);
                                const wasm = await mod._();
                                
                                const findSetUserIdFunction = (mod) => {
                                    for (const key of Object.keys(mod)) {
                                        const fn = mod[key];
                                        if (typeof fn === "function") {
                                            try {
                                                const str = fn.toString();
                                                if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(str)) {
                                                    return fn;
                                                }
                                            } catch {}
                                        }
                                    }
                                    return null;
                                };
                                
                                try {
                                    const me = await fetch(`${backend}/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
                                    if (me?.id) {
                                        const setUserIdFn = findSetUserIdFunction(mod);
                                        if (setUserIdFn) setUserIdFn(me.id);
                                    }
                                } catch {}
                                if (typeof mod.r === 'function') mod.r(url);
                                const enc = new TextEncoder();
                                const dec = new TextDecoder();
                                const bytes = enc.encode(rawBody);
                                const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                                new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                                const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                                let token;
                                if (Array.isArray(out)) {
                                    const [outPtr, outLen] = out;
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                    try { wasm.__wbindgen_free(outPtr, outLen, 1); } catch {}
                                } else if (typeof out === 'string') {
                                    token = out;
                                } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                    try { wasm.__wbindgen_free(out.ptr, out.len, 1); } catch {}
                                }
                                window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'seed' }, '*');
                            } catch {}
                        })();
                    },
                    args: [bodyStr]
                });
            }
        } catch {}
        sendResponse({ ok: true });
        return true;
    }
    if (request.action === 'computePawtectForT') {
        try {
            if (sender.tab?.id) {
                const turnstile = typeof request.bodyStr === 'string' ? (()=>{ try { return JSON.parse(request.bodyStr).t || ''; } catch { return ''; } })() : '';
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: (tValue) => {
                        (async () => {
                            try {
                                const backend = 'https://bplace.org';
                                
                                const findPawtectPath = async () => {
                                    const cacheKey = 'wplacer_pawtect_path';
                                    const cacheTimeKey = 'wplacer_pawtect_cache_time';
                                    const cacheExpiry = 5 * 60 * 1000;
                                    
                                    let pawtectPath = localStorage.getItem(cacheKey);
                                    const cacheTime = localStorage.getItem(cacheTimeKey);
                                    
                                    if (pawtectPath && cacheTime && (Date.now() - parseInt(cacheTime)) < cacheExpiry) {
                                        return pawtectPath;
                                    }
                                    
                                    const links = Array.from(document.querySelectorAll('link[rel="modulepreload"]'))
                                        .map(l => l.href);
                                    
                                    for (const url of links) {
                                        try {
                                            const res = await fetch(url);
                                            const text = await res.text();
                                            if (text.includes("get_pawtected_endpoint_payload")) {
                                                pawtectPath = url;
                                                localStorage.setItem(cacheKey, pawtectPath);
                                                localStorage.setItem(cacheTimeKey, Date.now().toString());
                                                return pawtectPath;
                                            }
                                        } catch (e) {}
                                    }
                                    
                                    return null;
                                };
                                
                                const pawtectPath = await findPawtectPath();
                                if (!pawtectPath) return;
                                
                                const mod = await import(pawtectPath);
                                const wasm = await mod._();
                                
                                const findSetUserIdFunction = (mod) => {
                                    for (const key of Object.keys(mod)) {
                                        const fn = mod[key];
                                        if (typeof fn === "function") {
                                            try {
                                                const str = fn.toString();
                                                if (/[\w$]+\s*\.\s*set_user_id\s*\(/.test(str)) {
                                                    return fn;
                                                }
                                            } catch {}
                                        }
                                    }
                                    return null;
                                };
                                
                                try {
                                    const me = await fetch(`${backend}/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
                                    if (me?.id) {
                                        const setUserIdFn = findSetUserIdFunction(mod);
                                        if (setUserIdFn) setUserIdFn(me.id);
                                    }
                                } catch {}
                                const url = `${backend}/s0/pixel/1/1`;
                                if (typeof mod.r === 'function') mod.r(url);
                                const fp = (window.wplacerFP && String(window.wplacerFP)) || (()=>{
                                    const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
                                })();
                                const rx = Math.floor(Math.random()*1000);
                                const ry = Math.floor(Math.random()*1000);
                                const bodyObj = { colors:[0], coords:[rx,ry], fp, t: String(tValue||'') };
                                const rawBody = JSON.stringify(bodyObj);
                                const enc = new TextEncoder();
                                const dec = new TextDecoder();
                                const bytes = enc.encode(rawBody);
                                const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                                new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                                const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                                let token;
                                if (Array.isArray(out)) {
                                    const [outPtr, outLen] = out;
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                    try { wasm.__wbindgen_free(outPtr, outLen, 1); } catch {}
                                } else if (typeof out === 'string') {
                                    token = out;
                                } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                    try { wasm.__wbindgen_free(out.ptr, out.len, 1); } catch {}
                                }
                                window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'simple' }, '*');
                            } catch {}
                        })();
                    },
                    args: [turnstile]
                });
            }
        } catch {}
        sendResponse({ ok: true });
        return true;
    }
    if (request.action === "quickLogout") {
        quickLogout(sendResponse);
        return true;
    }
    if (request.type === "SEND_TOKEN") {
        getServerUrl("/t").then(url => {
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    t: request.token,
                    pawtect: request.pawtect || null,
                    fp: request.fp || null
                })
            });
        });
        clearTokenWait();
        LAST_RELOAD_AT = Date.now();
    }
    return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    try {
        if (tab.url?.startsWith("https://bplace.org")) {
            if (changeInfo.status === 'loading') {
                // preinstall pawtect early
                injectPawtectIntoTab(tabId).catch(() => {});
            }
            if (changeInfo.status === 'complete') {
                console.log("wplacer: wplace.live tab loaded. Sending cookie.");
                injectPawtectIntoTab(tabId).catch(() => {});
                sendCookie(response => console.log(`wplacer: Cookie send status: ${response.success ? 'Success' : 'Failed'}`));
            }
        }
    } catch {}
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === COOKIE_ALARM_NAME) {
        console.log("wplacer: Periodic alarm triggered. Sending cookie.");
        sendCookie(response => console.log(`wplacer: Periodic cookie refresh: ${response.success ? 'Success' : 'Failed'}`));
    } else if (alarm.name === POLL_ALARM_NAME) {
        if (!LP_ACTIVE) startLongPoll();
        pollForTokenRequest();
    } else if (alarm.name === SAFETY_REFRESH_ALARM_NAME) {
        // Safety net: force refresh wplace tabs every ~45s if not already refreshing
        (async () => {
            try {
                if (TOKEN_IN_PROGRESS) return;
                const now = Date.now();
                if (now - LAST_RELOAD_AT < 45000) return;
                const tabs = await chrome.tabs.query({ url: "https://bplace.org/*" });
                for (const tab of tabs || []) {
                    try {
                        await injectPawtectIntoTab(tab.id);
                        await chrome.tabs.reload(tab.id, { bypassCache: true });
                    } catch {}
                }
                LAST_RELOAD_AT = Date.now();
            } catch {}
        })();
    } else if (alarm.name === TOKEN_TIMEOUT_ALARM_NAME) {
        // Backup timeout: if still waiting, retry (wrap in async IIFE)
        (async () => {
            try {
                if (!TOKEN_IN_PROGRESS) return;
                const now = Date.now();
                if (now - LAST_RELOAD_AT < 45000) return; // already retried recently
                console.warn('wplacer: token wait backup alarm fired, retrying...');
                clearTokenWait();
                await maybeInitiateReload();
            } catch {}
        })();
    } else if (alarm.name === AUTO_RELOAD_ALARM_NAME) {
        // Auto-reload alarm: reload wplace.live tabs periodically
        performAutoReload();
    }
});

const initializeAlarms = () => {
    chrome.alarms.create(POLL_ALARM_NAME, {
        delayInMinutes: 0.1,
        periodInMinutes: 0.75 
    });
    chrome.alarms.create(COOKIE_ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: 20
    });
    chrome.alarms.create(SAFETY_REFRESH_ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: 1
    });
    updateAutoReloadAlarm();
    console.log("wplacer: Alarms initialized.");
};

chrome.runtime.onStartup.addListener(() => {
    console.log("wplacer: Browser startup.");
    initializeAlarms();
    startLongPoll();
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("wplacer: Extension installed/updated.");
    initializeAlarms();
    startLongPoll();
});

startLongPoll();

// Keep service worker alive by periodic no-op
setInterval(() => { try { /* noop tick */ } catch {} }, 30 * 1000);

