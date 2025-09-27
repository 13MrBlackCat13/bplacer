// Inject a minimal page with Turnstile widget to obtain a token, then message SW
console.log('[AUTO-LOGIN EXTENSION] inject-turnstile.js loaded');

(function() {
  try {
    // Handle backend auth error page: {"error":"Invalid captcha. Try again.","status":400}
    if (location.pathname.startsWith('/auth/google')) {
      const handle = () => {
        try {
          const text = (document.body && document.body.innerText || '').trim();
          if (text.startsWith('{') && text.endsWith('}')) {
            try {
              const json = JSON.parse(text);
              if (json && typeof json.error === 'string' && /invalid captcha/i.test(json.error)) {
                console.warn('[AUTO-LOGIN EXTENSION] auth/google: invalid captcha, returning to bplace.org');
                location.href = 'https://bplace.org/';
                return;
              }
            } catch {}
          }
        } catch (e) {
          console.warn('[AUTO-LOGIN EXTENSION] auth/google parse error', e);
        }
      };
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(handle, 50);
      } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(handle, 0), { once: true });
      }
      return;
    }

    const sitekey = '0x4AAAAAABpHqZ-6i7uL0nmG';
    const origin = location.origin;
    const id = 'cf-turnstile-response';

    function ensureScript(onReady) {
      if (window.turnstile && window.turnstile.render) { onReady(); return; }
      const existing = document.getElementById('cf-turnstile-lib');
      if (existing) { existing.addEventListener('load', onReady, { once: true }); return; }
      const s = document.createElement('script');
      s.id = 'cf-turnstile-lib';
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      s.addEventListener('load', onReady, { once: true });
      document.documentElement.appendChild(s);
    }

    function renderWidget() {
      if (document.getElementById('wplace-turnstile')) return;
      const container = document.createElement('div');
      container.id = 'wplace-turnstile';
      container.className = 'cf-turnstile';
      container.setAttribute('data-sitekey', sitekey);
      container.style.position = 'fixed';
      container.style.bottom = '16px';
      container.style.right = '16px';
      container.style.zIndex = '2147483647';
      container.style.background = 'white';
      container.style.padding = '6px';
      container.style.borderRadius = '8px';
      document.body.appendChild(container);

      const tryRender = () => {
        try {
          if (window.turnstile && window.turnstile.render) {
            console.log('[AUTO-LOGIN EXTENSION] turnstile.render start');
            window.turnstile.render('#wplace-turnstile', {
              sitekey,
              callback: (token) => {
                console.log('[AUTO-LOGIN EXTENSION] Turnstile token received');
                chrome.runtime.sendMessage({ type: 'turnstile:token', token, origin });
              }
            });
            return true;
          }
        } catch (e) {
          console.warn('[AUTO-LOGIN EXTENSION] turnstile.render error', e);
        }
        return false;
      };

      if (!tryRender()) {
        let tries = 0;
        const iv = setInterval(() => {
          tries += 1;
          if (tryRender() || tries > 40) clearInterval(iv);
        }, 250);
      }
    }

    const ready = () => { try { renderWidget(); } catch (e) { console.warn('[AUTO-LOGIN EXTENSION] renderWidget error', e); } };
    ensureScript(ready);
    // If body not ready yet, also wait for DOMContentLoaded to ensure container mounts
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
      window.addEventListener('DOMContentLoaded', () => { try { renderWidget(); } catch {} }, { once: true });
    }
  } catch (e) {
    console.warn('[AUTO-LOGIN EXTENSION] inject-turnstile exception', e);
  }
})();


