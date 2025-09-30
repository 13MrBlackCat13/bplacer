import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { spawn, exec } from "node:child_process";
import path from "node:path";
import express from "express";
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from "cors";
import { CookieJar } from "tough-cookie";
import { gunzip, inflate, brotliDecompress } from "node:zlib";
import { promisify } from "node:util";
import { request } from "undici";
// import { Impit } from "impit";  // Временно отключено
import { Image, createCanvas, loadImage } from "canvas";
import CFClearanceManager from "./cf-clearance-manager.js";

// Временная замена для Impit с использованием fetch с поддержкой CF-Clearance
class MockImpit {
  constructor(options) {
    console.log(`🔥 [DEBUG] MockImpit constructor called with:`, JSON.stringify(options, null, 2));
    this.options = options;
    this.cookieJar = options.cookieJar;
    this.proxyUrl = options.proxyUrl;
    this.userId = options.userId; // Для привязки cf_clearance к пользователю
    this.skipCfClearance = options.skipCfClearance || false; // Skip auto CF-Clearance fetching
    this.userAgent = options.userAgent; // Custom User-Agent
  }

  async fetch(url, options = {}) {
    console.log(`🔥 [DEBUG] MockImpit.fetch called:`, url);

    // Проверяем, нужен ли CF-Clearance для этого URL
    const needsCfClearance = url.includes('bplace.org') && !this.skipCfClearance;

    let cfClearanceData = null;
    if (needsCfClearance) {
      try {
        // Извлекаем информацию о прокси из URL
        let proxyInfo = null;
        if (this.proxyUrl) {
          proxyInfo = this.parseProxyUrl(this.proxyUrl);
          console.log(`🔐 [CF] Proxy info:`, JSON.stringify(proxyInfo, null, 2));
        } else {
          console.log(`🔐 [CF] No proxy configured, using direct connection`);
        }

        console.log(`🔐 [CF] Requesting cf_clearance for userId: ${this.userId}, url: ${url}`);
        // Получаем CF-Clearance токен
        cfClearanceData = await cfClearanceManager.getClearance(proxyInfo, this.userId, url);
        if (cfClearanceData) {
          console.log(`🔐 [CF] Using cf_clearance for ${url}:`, Object.keys(cfClearanceData.cookies || {}).join(', '));
        } else {
          console.log(`⚠️ [CF] No cf_clearance data obtained`);
        }
      } catch (error) {
        console.log(`⚠️ [CF] Failed to get cf_clearance: ${error.message}`);
        console.log(`⚠️ [CF] Stack trace:`, error.stack);
      }
    }

    // Добавляем куки из cookieJar если есть
    if (this.cookieJar) {
      try {
        const cookies = this.cookieJar.getCookiesSync(url);
        if (cookies && cookies.length > 0) {
          const cookieHeader = cookies.map(c => `${c.key}=${c.value}`).join('; ');
          options.headers = options.headers || {};
          options.headers['Cookie'] = cookieHeader;
          console.log(`🔥 [DEBUG] Added cookies from jar:`, cookieHeader);
        }
      } catch (e) {
        console.log(`🔥 [DEBUG] Error getting cookies:`, e.message);
      }
    }

    // Добавляем CF-Clearance куки и User-Agent если получены
    if (cfClearanceData) {
      options.headers = options.headers || {};

      // Добавляем CF-Clearance куки
      const existingCookies = options.headers['Cookie'] || '';
      const cfCookies = Object.entries(cfClearanceData.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');

      if (existingCookies) {
        options.headers['Cookie'] = `${existingCookies}; ${cfCookies}`;
      } else {
        options.headers['Cookie'] = cfCookies;
      }

      // Обновляем User-Agent на тот, что использовался для получения токена
      if (cfClearanceData.userAgent) {
        options.headers['User-Agent'] = cfClearanceData.userAgent;
      }

      console.log(`🔐 [CF] Added cf_clearance cookies and user-agent`);
    }

    // If skipCfClearance is true, use custom User-Agent if provided
    if (this.skipCfClearance && this.userAgent) {
      options.headers = options.headers || {};
      options.headers['User-Agent'] = this.userAgent;
      console.log(`🔐 [CF] Using custom User-Agent: ${this.userAgent.substring(0, 50)}...`);
    }

    console.log(`🔥 [DEBUG] Final headers:`, JSON.stringify(options.headers, null, 2));

    try {
      console.log(`🔥 [MockImpit] Making fetch request to: ${url}`);
      const response = await fetch(url, options);
      console.log(`🔥 [MockImpit] Fetch completed, status: ${response.status}`);

      // Debug: Check for getSetCookie method availability
      if (typeof response.headers.getSetCookie === 'function') {
        const setCookies = response.headers.getSetCookie();
        console.log(`🔥 [MockImpit] getSetCookie() found ${setCookies.length} cookies:`, setCookies.map(c => c.substring(0, 50)));

        // Save all Set-Cookie headers to cookie jar
        if (this.cookieJar && setCookies.length > 0) {
          for (const setCookie of setCookies) {
            try {
              this.cookieJar.setCookieSync(setCookie, url);
              console.log(`🔥 [MockImpit] Saved cookie to jar:`, setCookie.substring(0, 50));
            } catch (cookieErr) {
              console.log(`🔥 [MockImpit] Error saving cookie:`, cookieErr.message);
            }
          }
        }
      }

      // Fallback: Save cookies from Set-Cookie header to cookie jar (old method)
      if (this.cookieJar && response.headers.has('set-cookie')) {
        try {
          const setCookie = response.headers.get('set-cookie');
          console.log(`🔥 [MockImpit] Set-Cookie header found:`, setCookie?.substring(0, 100));
          if (setCookie) {
            // Parse and save cookie to jar
            this.cookieJar.setCookieSync(setCookie, url);
            console.log(`🔥 [MockImpit] Saved cookie to jar`);
          }
        } catch (cookieErr) {
          console.log(`🔥 [MockImpit] Error saving cookie:`, cookieErr.message);
        }
      }

      // Проверяем Cloudflare challenge при 403 ошибке или если есть признаки Cloudflare в ответе
      if (needsCfClearance && (response.status === 403 || response.status === 502 || response.status === 503)) {
        try {
          console.log(`🔥 [MockImpit] Checking for Cloudflare challenge...`);
          // Клонируем response чтобы не сделать body unusable
          const responseClone = response.clone();
          console.log(`🔥 [MockImpit] Response cloned, reading text...`);
          const responseText = await responseClone.text();
          console.log(`🔥 [MockImpit] Response text read, length: ${responseText.length}`);

          // Для 502/503 проверяем только если это действительно Cloudflare, а не просто ошибка сервера
          const isCloudflareChallenge = responseText.includes('cloudflare') ||
                                       responseText.includes('Cloudflare') ||
                                       responseText.includes('Just a moment') ||
                                       responseText.includes('Checking your browser');

          // Для 403 всегда пытаемся обновить токен, для 502/503 только если это Cloudflare
          const shouldRetry = (response.status === 403) ||
                            ((response.status === 502 || response.status === 503) && isCloudflareChallenge);

          if (shouldRetry) {
            console.log(`🚫 [CF] Cloudflare challenge detected (status: ${response.status}), refreshing cf_clearance`);
          } else {
            console.log(`⚠️ [CF] Status ${response.status} but not a Cloudflare challenge (isCloudflare: ${isCloudflareChallenge}), returning original response`);
          }

          if (shouldRetry) {
            // Удаляем недействительный токен из кэша
            let proxyInfo = null;
            if (this.proxyUrl) {
              proxyInfo = this.parseProxyUrl(this.proxyUrl);
            }

            // Удаляем старый токен
            const key = cfClearanceManager.generateCacheKey(proxyInfo, this.userId);
            cfClearanceManager.clearanceCache.delete(key);
            console.log(`🗑️ [CF] Removed invalid cf_clearance token for ${key}`);

            // Принудительно получаем новый токен
            try {
              const newClearanceData = await cfClearanceManager.getClearance(proxyInfo, this.userId, url);
              if (newClearanceData) {
                console.log(`✅ [CF] Successfully obtained new cf_clearance token, retrying request...`);

                // Обновляем заголовки с новым токеном
                options.headers = options.headers || {};

                // Добавляем CF-Clearance куки из cookieJar (если есть)
                let existingCookies = '';
                if (this.cookieJar) {
                  try {
                    const cookies = this.cookieJar.getCookiesSync(url);
                    if (cookies && cookies.length > 0) {
                      existingCookies = cookies.map(c => `${c.key}=${c.value}`).join('; ');
                    }
                  } catch (e) {
                    console.log(`🔥 [DEBUG] Error getting cookies for retry:`, e.message);
                  }
                }

                // Добавляем новые CF-Clearance куки
                const cfCookies = Object.entries(newClearanceData.cookies)
                  .map(([name, value]) => `${name}=${value}`)
                  .join('; ');

                if (existingCookies) {
                  options.headers['Cookie'] = `${existingCookies}; ${cfCookies}`;
                } else {
                  options.headers['Cookie'] = cfCookies;
                }

                // Обновляем User-Agent
                if (newClearanceData.userAgent) {
                  options.headers['User-Agent'] = newClearanceData.userAgent;
                }

                console.log(`🔄 [CF] Retrying request with new cf_clearance token...`);
                const retryResponse = await fetch(url, options);
                console.log(`✅ [CF] Retry completed, status: ${retryResponse.status}`);
                return retryResponse;
              }
            } catch (refreshError) {
              console.log(`❌ [CF] Failed to refresh cf_clearance: ${refreshError.message}`);
            }
          }
        } catch (cloneError) {
          console.log(`⚠️ [CF] Could not check response for Cloudflare: ${cloneError.message}`);
        }
      }

      console.log(`🔥 [MockImpit] Returning response object`);
      return response;
    } catch (error) {
      console.log(`❌ [MockImpit] Fetch error: ${error.message}`);
      throw error;
    }
  }

  // Special method using undici to get Set-Cookie headers (fetch API doesn't expose them)
  async fetchWithCookies(url, options = {}) {
    console.log(`🔥 [MockImpit] fetchWithCookies called: ${url}`);

    // Same logic as fetch() method to add CF-Clearance
    const needsCfClearance = url.includes('bplace.org');
    let cfClearanceData = null;

    if (needsCfClearance) {
      try {
        let proxyInfo = null;
        if (this.proxyUrl) {
          proxyInfo = this.parseProxyUrl(this.proxyUrl);
        }

        cfClearanceData = await cfClearanceManager.getClearance(proxyInfo, this.userId, url);
      } catch (error) {
        console.log(`⚠️ [CF] Failed to get cf_clearance: ${error.message}`);
      }
    }

    // Add cookies from cookieJar
    if (this.cookieJar) {
      try {
        const cookies = this.cookieJar.getCookiesSync(url);
        if (cookies && cookies.length > 0) {
          const cookieHeader = cookies.map(c => `${c.key}=${c.value}`).join('; ');
          options.headers = options.headers || {};
          options.headers['Cookie'] = cookieHeader;
        }
      } catch (e) {
        console.log(`🔥 [DEBUG] Error getting cookies:`, e.message);
      }
    }

    // Add CF-Clearance cookies and User-Agent
    if (cfClearanceData) {
      options.headers = options.headers || {};

      const existingCookies = options.headers['Cookie'] || '';
      const cfCookies = Object.entries(cfClearanceData.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');

      if (existingCookies) {
        options.headers['Cookie'] = `${existingCookies}; ${cfCookies}`;
      } else {
        options.headers['Cookie'] = cfCookies;
      }

      if (cfClearanceData.userAgent) {
        options.headers['User-Agent'] = cfClearanceData.userAgent;
      }
    }

    try {
      const { statusCode, headers, body } = await request(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        maxRedirections: 0 // Don't follow redirects automatically
      });

      console.log(`🔥 [MockImpit] undici request completed, status: ${statusCode}`);
      console.log(`🔥 [MockImpit] Response headers:`, headers);

      // Extract Set-Cookie headers (undici exposes them as array)
      const setCookieHeaders = headers['set-cookie'] || [];
      console.log(`🔥 [MockImpit] Set-Cookie headers from undici:`, setCookieHeaders);

      // Check for Location header (redirect)
      if (headers.location) {
        console.log(`🔥 [MockImpit] Redirect location:`, headers.location);
      }

      // Save cookies to jar
      if (this.cookieJar && setCookieHeaders.length > 0) {
        for (const setCookie of setCookieHeaders) {
          try {
            this.cookieJar.setCookieSync(setCookie, url);
            console.log(`🔥 [MockImpit] Saved cookie to jar:`, setCookie.substring(0, 50));
          } catch (err) {
            console.log(`🔥 [MockImpit] Error saving cookie:`, err.message);
          }
        }
      }

      // Convert body stream to text
      let responseText = '';
      for await (const chunk of body) {
        responseText += chunk.toString();
      }

      return {
        status: statusCode,
        headers: headers,
        text: async () => responseText,
        json: async () => JSON.parse(responseText)
      };
    } catch (error) {
      console.log(`❌ [MockImpit] undici request error: ${error.message}`);
      throw error;
    }
  }

  parseProxyUrl(proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      return {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: parseInt(url.port),
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || '')
      };
    } catch (error) {
      console.log(`❌ [CF] Failed to parse proxy URL: ${error.message}`);
      return null;
    }
  }
}

const Impit = MockImpit;

// Helper function to decompress response based on encoding
const decompressResponse = async (response) => {
  const contentEncoding = response.headers.get('content-encoding');
  const gunzipAsync = promisify(gunzip);
  const inflateAsync = promisify(inflate);
  const brotliDecompressAsync = promisify(brotliDecompress);

  // FIXED: Use the cloned response that was passed to this function
  const buffer = Buffer.from(await response.arrayBuffer());

  console.log(`🔥 [DEBUG] Buffer length: ${buffer.length}`);
  console.log(`🔥 [DEBUG] Buffer first 10 bytes: [${Array.from(buffer.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(', ')}]`);
  console.log(`🔥 [DEBUG] Content-Encoding header: ${contentEncoding}`);

  // Check if buffer looks like compressed data (starts with compression magic bytes)
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isDeflate = buffer.length >= 2 && buffer[0] === 0x78 && (buffer[1] === 0x01 || buffer[1] === 0x9c || buffer[1] === 0xda);
  const isBrotli = buffer.length >= 6 && buffer.slice(0, 6).toString('hex') === '1b0000'; // Basic brotli check

  console.log(`🔥 [DEBUG] Detected compression - gzip: ${isGzip}, deflate: ${isDeflate}, brotli: ${isBrotli}`);

  // Check if buffer contains non-printable bytes (likely compressed)
  const hasNonPrintable = buffer.some(byte => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
  console.log(`🔥 [DEBUG] Buffer has non-printable characters: ${hasNonPrintable}`);

  try {
    // Try gzip first if detected or if content-encoding says so
    if (isGzip || contentEncoding === 'gzip') {
      console.log(`🔥 [DEBUG] Attempting gzip decompression`);
      return (await gunzipAsync(buffer)).toString('utf8');
    }

    // Try deflate
    if (isDeflate || contentEncoding === 'deflate') {
      console.log(`🔥 [DEBUG] Attempting deflate decompression`);
      return (await inflateAsync(buffer)).toString('utf8');
    }

    // Try brotli
    if (isBrotli || contentEncoding === 'br') {
      console.log(`🔥 [DEBUG] Attempting brotli decompression`);
      return (await brotliDecompressAsync(buffer)).toString('utf8');
    }

    // If buffer looks binary/compressed but no magic bytes matched, try all methods
    if (hasNonPrintable) {
      console.log(`🔥 [DEBUG] Buffer contains non-printable characters, trying all decompression methods`);

      // Try gzip
      try {
        const result = (await gunzipAsync(buffer)).toString('utf8');
        console.log(`🔥 [DEBUG] Gzip decompression successful`);
        return result;
      } catch (e) {
        console.log(`🔥 [DEBUG] Gzip failed:`, e.message);
      }

      // Try deflate
      try {
        const result = (await inflateAsync(buffer)).toString('utf8');
        console.log(`🔥 [DEBUG] Deflate decompression successful`);
        return result;
      } catch (e) {
        console.log(`🔥 [DEBUG] Deflate failed:`, e.message);
      }

      // Try brotli
      try {
        const result = (await brotliDecompressAsync(buffer)).toString('utf8');
        console.log(`🔥 [DEBUG] Brotli decompression successful`);
        return result;
      } catch (e) {
        console.log(`🔥 [DEBUG] Brotli failed:`, e.message);
      }
    }

    // Fallback to plain text
    console.log(`🔥 [DEBUG] No compression detected or all methods failed, returning as plain text`);
    return buffer.toString('utf8');

  } catch (error) {
    console.log(`🔥 [DEBUG] Decompression error:`, error.message);
    // Fallback: return as plain text if decompression fails
    return buffer.toString('utf8');
  }
};

// --- Setup __dirname for ES modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Setup Data Directory ---
const dataDir = "./data";
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}
// Heat maps directory
const heatMapsDir = path.join(dataDir, "heat_maps");
if (!existsSync(heatMapsDir)) {
  try { mkdirSync(heatMapsDir, { recursive: true }); } catch (_) { }
}

// CF-Clearance Manager
const cfClearanceManager = new CFClearanceManager(dataDir);

// Запускаем периодическую очистку устаревших токенов
cfClearanceManager.startPeriodicCleanup();

// Очищаем устаревшие токены при запуске
cfClearanceManager.cleanExpiredTokens();

// Auto-start Turnstile Captcha Solver API
let captchaApiProcess = null;
function startCaptchaApi() {
  const captchaApiPath = path.join(process.cwd(), 'autoreg', 'api_server.py');

  // Check if the API server file exists
  if (!existsSync(captchaApiPath)) {
    console.log('⚠️ Captcha API server not found at:', captchaApiPath);
    console.log('   Auto-registration will not work without captcha solver');
    return;
  }

  console.log('🚀 Starting Turnstile Captcha Solver API...');

  captchaApiProcess = spawn('python', ['api_server.py'], {
    cwd: path.join(process.cwd(), 'autoreg'),
    stdio: 'pipe',
    shell: true
  });

  captchaApiProcess.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      console.log(`[Captcha API] ${output}`);
    }
  });

  captchaApiProcess.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (output && !output.includes('WARNING')) {
      console.log(`[Captcha API] ${output}`);
    }
  });

  captchaApiProcess.on('close', (code) => {
    console.log(`⚠️ Captcha API process exited with code ${code}`);
    captchaApiProcess = null;
  });

  captchaApiProcess.on('error', (err) => {
    console.log(`❌ Failed to start Captcha API: ${err.message}`);
    console.log('   Make sure Python and required packages are installed (see autoreg/requirements.txt)');
    captchaApiProcess = null;
  });
}

// Start captcha API on server startup
startCaptchaApi();

// Graceful shutdown handler for captcha API
process.on('SIGINT', () => {
  if (captchaApiProcess) {
    console.log('\n🛑 Stopping Captcha API...');
    captchaApiProcess.kill();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (captchaApiProcess) {
    console.log('\n🛑 Stopping Captcha API...');
    captchaApiProcess.kill();
  }
  process.exit(0);
});

// Backups directories
const backupsRootDir = path.join(dataDir, "backups");
const usersBackupsDir = path.join(backupsRootDir, "users");
const proxiesBackupsDir = path.join(backupsRootDir, "proxies");
try { if (!existsSync(backupsRootDir)) mkdirSync(backupsRootDir, { recursive: true }); } catch (_) { }
try { if (!existsSync(usersBackupsDir)) mkdirSync(usersBackupsDir, { recursive: true }); } catch (_) { }
try { if (!existsSync(proxiesBackupsDir)) mkdirSync(proxiesBackupsDir, { recursive: true }); } catch (_) { }

// --- Live log streaming (SSE) ---
const sseClients = [];
const broadcastLog = (payload) => {
  try {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
      const res = sseClients[i];
      try { res.write(data); } catch { sseClients.splice(i, 1); }
    }
  } catch (_) { }
};

// Keep recent logs in memory for this process session
const RECENT_LOGS_LIMIT = 5000;
const recentLogs = [];

// Helper function to add messages to Live Logs
const addToLiveLogs = (message, category = 'general', level = 'info') => {
  try {
    const obj = { line: message, category, level, ts: new Date().toLocaleString() };
    recentLogs.push(obj); 
    if (recentLogs.length > RECENT_LOGS_LIMIT) recentLogs.shift();
    broadcastLog(obj);
  } catch (_) { }
};

// Track open sockets to allow forced shutdown
const sockets = new Set();

// --- Logging & utils ---
const log = async (id, name, data, error) => {
  const timestamp = new Date().toLocaleString();
  const identifier = `(${name}#${id})`;
  const maskOn = !!(currentSettings && currentSettings.logMaskPii);
  const maskMsg = (msg) => {
    try {
      let s = String(msg || "");
      // (nick#123456) -> (****#****)
      s = s.replace(/\([^)#]+#\d+\)/g, '(****#****)');
      // #11240474 -> #**** (for 3+ digits)
      s = s.replace(/#\d{3,}/g, '#****');
      // tile 1227, 674 -> tile ****, ****
      s = s.replace(/tile\s+\d+\s*,\s*\d+/gi, 'tile ****, ****');
      return s;
    } catch (_) { return String(msg || ""); }
  };
  if (error) {
    const identOut = maskOn ? maskMsg(identifier) : identifier;
    const outLine = `[${timestamp}] ${identOut} ${maskOn ? maskMsg(data) : data}:`;
    console.error(outLine, error);
    const errText = `${error.stack || error.message}`;
    appendFileSync(path.join(dataDir, `errors.log`), `${outLine} ${maskOn ? maskMsg(errText) : errText}\n`);
    try {
      const obj = { line: `${outLine} ${maskOn ? maskMsg(errText) : errText}`, category: "error", level: "error", ts: timestamp };
      recentLogs.push(obj); if (recentLogs.length > RECENT_LOGS_LIMIT) recentLogs.shift();
      broadcastLog(obj);
    } catch (_) { }
  } else {
    try {
      // Category-based filtering (non-error logs only)
      const cat = (() => {
        const s = String(data || "").toLowerCase();
        if (s.includes('token_manager')) return 'tokenManager';
        if (s.includes('cache')) return 'cache';
        if (s.includes('queue') && s.includes('preview')) return 'queuePreview';
        if (s.includes('🧱 painting') || s.includes(' painting (')) return 'painting';
        if (s.includes('start turn')) return 'startTurn';
        if (s.includes('mismatched')) return 'mismatches';
        if (s.includes('estimated time')) return 'estimatedTime';
        return null;
      })();
      const cfg = (currentSettings && currentSettings.logCategories) || {};
      const enabled = (cat == null) ? true : (cfg[cat] !== false);
      if (!enabled) return; // skip suppressed category
      const identOut = maskOn ? maskMsg(identifier) : identifier;
      const outLine = `[${timestamp}] ${identOut} ${maskOn ? maskMsg(data) : data}`;
      console.log(outLine);
      appendFileSync(path.join(dataDir, `logs.log`), `${outLine}\n`);
      try {
        const obj = { line: outLine, category: cat || 'general', level: 'info', ts: timestamp };
        recentLogs.push(obj); if (recentLogs.length > RECENT_LOGS_LIMIT) recentLogs.shift();
        broadcastLog(obj);
      } catch (_) { }
    } catch (_) {
      const identOut = maskOn ? maskMsg(identifier) : identifier;
      const outLine = `[${timestamp}] ${identOut} ${maskOn ? maskMsg(data) : data}`;
      console.log(outLine);
      appendFileSync(path.join(dataDir, `logs.log`), `${outLine}\n`);
      try {
        const obj = { line: outLine, category: 'general', level: 'info', ts: timestamp };
        recentLogs.push(obj); if (recentLogs.length > RECENT_LOGS_LIMIT) recentLogs.shift();
        broadcastLog(obj);
      } catch (_) { }
    }
  }
};



const duration = (durationMs) => {
  if (durationMs <= 0) return "0s";
  const totalSeconds = Math.floor(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Complete Colors / Palette from bplace.org (95 colors) ---
const MASTER_PALETTE = [
  // ID 1-31: Free colors (exactly matching bplace.org)
  [0,0,0],[60,60,60],[120,120,120],[210,210,210],[255,255,255],
  [96,0,24],[237,28,36],[255,127,39],[246,170,9],[249,221,59],[255,250,188],
  [14,185,104],[19,230,123],[135,255,94],[12,129,110],[16,174,166],[19,225,190],
  [40,80,158],[64,147,228],[96,247,242],[107,80,246],[153,177,251],
  [120,12,153],[170,56,185],[224,159,249],[203,0,122],[236,31,128],[243,141,169],
  [104,70,52],[149,104,42],[248,178,119],
  // ID 32-95: Paid colors (exactly matching bplace.org)
  [170,170,170],[165,14,30],[250,128,114],[228,92,26],[214,181,148],[156,132,49],
  [197,173,49],[232,212,95],[74,107,58],[90,148,74],[132,197,115],[15,121,159],
  [187,250,242],[125,199,255],[77,49,184],[74,66,132],[122,113,196],[181,174,241],
  [219,164,99],[209,128,81],[255,197,165],[155,82,73],[209,128,120],[250,182,164],
  [123,99,82],[156,132,107],[51,57,65],[109,117,141],[179,185,209],[109,100,63],
  [148,140,107],[205,197,158],[102,204,255],[91,191,185],[128,0,0],[220,20,60],
  [255,127,80],[240,230,140],[255,219,88],[127,255,0],[191,255,0],
  [46,139,87],[64,224,208],[0,255,255],[135,206,235],[65,105,225],[0,0,128],
  [230,230,250],[255,0,255],[255,119,255],[255,255,240],[189,252,201],[255,102,204],
  [146,73,0],[128,0,32],[255,191,0],[107,142,35],[204,204,255],[42,82,190],
  [64,130,109],[224,176,255],[112,66,20],[0,0,144]
];

// Complete color name mapping for all 95 colors
const colorNames = {
  // Free colors (1-31)
  "0,0,0": "Black", "60,60,60": "Dark Gray", "120,120,120": "Gray", "210,210,210": "Light Gray", "255,255,255": "White",
  "96,0,24": "Deep Red", "237,28,36": "Red", "255,127,39": "Orange", "246,170,9": "Gold", "249,221,59": "Yellow", "255,250,188": "Light Yellow",
  "14,185,104": "Dark Green", "19,230,123": "Green", "135,255,94": "Light Green", "12,129,110": "Dark Teal", "16,174,166": "Teal", "19,225,190": "Light Teal",
  "40,80,158": "Dark Blue", "64,147,228": "Blue", "96,247,242": "Cyan", "107,80,246": "Indigo", "153,177,251": "Light Indigo",
  "120,12,153": "Dark Purple", "170,56,185": "Purple", "224,159,249": "Light Purple", "203,0,122": "Dark Pink", "236,31,128": "Pink", "243,141,169": "Light Pink",
  "104,70,52": "Dark Brown", "149,104,42": "Brown", "248,178,119": "Beige",
  // Paid colors (32-95)
  "170,170,170": "Medium Gray", "165,14,30": "Dark Red", "250,128,114": "Light Red", "228,92,26": "Dark Orange", "214,181,148": "Light Tan", "156,132,49": "Dark Goldenrod",
  "197,173,49": "Goldenrod", "232,212,95": "Light Goldenrod", "74,107,58": "Dark Olive", "90,148,74": "Olive", "132,197,115": "Light Olive", "15,121,159": "Dark Cyan",
  "187,250,242": "Light Cyan", "125,199,255": "Light Blue", "77,49,184": "Dark Indigo", "74,66,132": "Dark Slate Blue", "122,113,196": "Slate Blue", "181,174,241": "Light Slate Blue",
  "219,164,99": "Light Brown", "209,128,81": "Dark Beige", "255,197,165": "Light Beige", "155,82,73": "Dark Peach", "209,128,120": "Peach", "250,182,164": "Light Peach",
  "123,99,82": "Dark Tan", "156,132,107": "Tan", "51,57,65": "Dark Slate", "109,117,141": "Slate", "179,185,209": "Light Slate", "109,100,63": "Dark Stone",
  "148,140,107": "Stone", "205,197,158": "Light Stone", "102,204,255": "#66CCFF", "91,191,185": "Aquamarine", "128,0,0": "Maroon", "220,20,60": "Crimson",
  "255,127,80": "Coral", "240,230,140": "Khaki", "255,219,88": "Mustard", "127,255,0": "Chartreuse", "191,255,0": "Lime",
  "46,139,87": "Sea Green", "64,224,208": "Turquoise", "0,255,255": "Aqua", "135,206,235": "Sky Blue", "65,105,225": "Royal Blue", "0,0,128": "Navy",
  "230,230,250": "Lavender", "255,0,255": "Magenta", "255,119,255": "Fuchsia", "255,255,240": "Ivory", "189,252,201": "Mint", "255,102,204": "Rose",
  "146,73,0": "Saddle Brown", "128,0,32": "Burgundy", "255,191,0": "Amber", "107,142,35": "Olive Drab", "204,204,255": "Periwinkle", "42,82,190": "Cerulean",
  "64,130,109": "Viridian", "224,176,255": "Mauve", "112,66,20": "Sepia", "0,0,144": "Darker Blue"
};

// Mapping real bplace.org color IDs to our palette positions
// This handles cases where site has duplicate colors or different numbering
const BPLACE_ID_TO_PALETTE_INDEX = {
  // Free colors 1-31 map directly
  1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9,
  11: 10, 12: 11, 13: 12, 14: 13, 15: 14, 16: 15, 17: 16, 18: 17, 19: 18, 20: 19,
  21: 20, 22: 21, 23: 22, 24: 23, 25: 24, 26: 25, 27: 26, 28: 27, 29: 28, 30: 29, 31: 30,
  // Paid colors with careful mapping
  32: 31, 33: 32, 34: 33, 35: 34, 36: 35, 37: 36, 38: 37, 39: 38, 40: 39, 41: 40,
  42: 41, 43: 42, 44: 43, 45: 44, 46: 45, 47: 46, 48: 47, 49: 48, 50: 49, 51: 50,
  52: 51, 53: 52, 54: 53, 55: 54, 56: 55, 57: 56, 58: 57, 59: 58, 60: 59, 61: 60,
  62: 61, 63: 62, 64: 63, 65: 64, 66: 65, 67: 66, 68: 67, 69: 33, // Salmon maps to same as Light Red
  70: 68, 71: 69, 72: 70, 73: 71, 74: 72, 75: 73, 76: 74, 77: 75, 78: 76, 79: 77,
  80: 78, 81: 79, 82: 80, 83: 81, 84: 82, 85: 83, 86: 84, 87: 85, 88: 86, 89: 87,
  90: 88, 91: 89, 92: 90, 93: 91, 94: 92, 95: 93 // Darker Blue
};

// Reverse mapping for palette index to site ID
const PALETTE_INDEX_TO_BPLACE_ID = {};
Object.entries(BPLACE_ID_TO_PALETTE_INDEX).forEach(([siteId, paletteIndex]) => {
  if (!PALETTE_INDEX_TO_BPLACE_ID[paletteIndex]) {
    PALETTE_INDEX_TO_BPLACE_ID[paletteIndex] = parseInt(siteId);
  }
});

// All paid colors (IDs 32-95)
const paidColors = new Set([
  "170,170,170", "165,14,30", "250,128,114", "228,92,26", "214,181,148", "156,132,49",
  "197,173,49", "232,212,95", "74,107,58", "90,148,74", "132,197,115", "15,121,159",
  "187,250,242", "125,199,255", "77,49,184", "74,66,132", "122,113,196", "181,174,241",
  "219,164,99", "209,128,81", "255,197,165", "155,82,73", "209,128,120", "250,182,164",
  "123,99,82", "156,132,107", "51,57,65", "109,117,141", "179,185,209", "109,100,63",
  "148,140,107", "205,197,158", "102,204,255", "91,191,185", "128,0,0", "220,20,60",
  "255,127,80", "240,230,140", "255,219,88", "127,255,0", "191,255,0",
  "46,139,87", "64,224,208", "0,255,255", "135,206,235", "65,105,225", "0,0,128",
  "230,230,250", "255,0,255", "255,119,255", "255,255,240", "189,252,201", "255,102,204",
  "146,73,0", "128,0,32", "255,191,0", "107,142,35", "204,204,255", "42,82,190",
  "64,130,109", "224,176,255", "112,66,20", "0,0,144"
]);

// Generate color mappings with new IDs
const basic_colors = {};
const premium_colors = {};
MASTER_PALETTE.forEach((color, index) => {
  const colorKey = color.join(',');
  const colorId = index + 1;
  if (paidColors.has(colorKey)) {
    premium_colors[colorKey] = colorId;
  } else {
    basic_colors[colorKey] = colorId;
  }
});

const pallete = { ...basic_colors, ...premium_colors };
const colorBitmapShift = Object.keys(basic_colors).length + 1;

// --- Charge cache (avoid logging in all users each cycle) ---
const ChargeCache = {
  _m: new Map(),
  REGEN_MS: 30_000,
  SYNC_MS: 8 * 60_000,
  _key(id) { return String(id); },

  has(id) { return this._m.has(this._key(id)); },
  stale(id, now = Date.now()) {
    const u = this._m.get(this._key(id)); if (!u) return true;
    return (now - u.lastSync) > this.SYNC_MS;
  },
  markFromUserInfo(userInfo, now = Date.now()) {
    if (!userInfo?.id || !userInfo?.charges) return;
    const k = this._key(userInfo.id);
    const base = Math.floor(userInfo.charges.count ?? 0);
    const max = Math.floor(userInfo.charges.max ?? 0);
    this._m.set(k, { base, max, lastSync: now });
  },
  predict(id, now = Date.now()) {
    const u = this._m.get(this._key(id)); if (!u) return null;
    const grown = Math.floor((now - u.lastSync) / this.REGEN_MS);
    const count = Math.min(u.max, u.base + Math.max(0, grown));
    return { count, max: u.max, cooldownMs: this.REGEN_MS };
  },
  consume(id, n = 1, now = Date.now()) {
    const k = this._key(id);
    const u = this._m.get(k); if (!u) return;
    const grown = Math.floor((now - u.lastSync) / this.REGEN_MS);
    const avail = Math.min(u.max, u.base + Math.max(0, grown));
    const newCount = Math.max(0, avail - n);
    u.base = newCount;
    u.lastSync = now - ((now - u.lastSync) % this.REGEN_MS);
    this._m.set(k, u);
  },
  clearAll() {
    this._m.clear();
  }
};

let loadedProxies = [];
// map: proxy idx -> timestamp (ms) until which proxy is quarantined (skipped)
const proxyQuarantine = new Map();
const loadProxies = () => {
  const proxyPath = path.join(dataDir, "proxies.txt");
  if (!existsSync(proxyPath)) {
    writeFileSync(proxyPath, "");
    console.log("[SYSTEM] `data/proxies.txt` not found, created an empty one.");
    loadedProxies = [];
    return;
  }

  const raw = readFileSync(proxyPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.replace(/\s+#.*$|\s+\/\/.*$|^\s*#.*$|^\s*\/\/.*$/g, '').trim())
    .filter(Boolean);

  const protoMap = new Map([
    ["http", "http"],
    ["https", "https"],
    ["socks4", "socks4"],
    ["socks5", "socks5"]
  ]);

  const inRange = p => Number.isInteger(p) && p >= 1 && p <= 65535;
  const looksHostname = host => {
    if (!host || typeof host !== "string") return false;
    // IPv4
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
    // Domain
    if (/^[a-zA-Z0-9.-]+$/.test(host)) return true;
    // allow IPv6 content (without brackets) as a last resort
    if (/^[0-9a-fA-F:]+$/.test(host)) return true;
    return false;
  };

  const parseOne = line => {
    // url-like: scheme://user:pass@host:port
    const urlLike = line.match(/^(\w+):\/\//);
    if (urlLike) {
      const scheme = urlLike[1].toLowerCase();
      const protocol = protoMap.get(scheme);
      if (!protocol) return null;
      try {
        const u = new URL(line);
        const host = u.hostname;
        const port = u.port ? parseInt(u.port, 10) : NaN;
        const username = decodeURIComponent(u.username || "");
        const password = decodeURIComponent(u.password || "");
        if (!looksHostname(host) || !inRange(port)) return null;
        return { protocol, host, port, username, password };
      } catch {
        return null;
      }
    }

    // user:pass@host:port (host may be [ipv6])
    const authHost = line.match(/^([^:@\s]+):([^@\s]+)@(.+)$/);
    if (authHost) {
      const username = authHost[1];
      const password = authHost[2];
      const rest = authHost[3];
      const m6 = rest.match(/^\[([^\]]+)\]:(\d+)$/);
      const m4 = rest.match(/^([^:\s]+):(\d+)$/);
      let host = '';
      let port = NaN;
      if (m6) {
        host = m6[1];
        port = parseInt(m6[2], 10);
      } else if (m4) {
        host = m4[1];
        port = parseInt(m4[2], 10);
      } else return null;
      if (!looksHostname(host) || !inRange(port)) return null;
      return { protocol: 'http', host, port, username, password };
    }

    // [ipv6]:port
    const bare6 = line.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bare6) {
      const host = bare6[1];
      const port = parseInt(bare6[2], 10);
      if (!inRange(port)) return null;
      return { protocol: 'http', host, port, username: '', password: '' };
    }

    // host:port
    const bare = line.match(/^([^:\s]+):(\d+)$/);
    if (bare) {
      const host = bare[1];
      const port = parseInt(bare[2], 10);
      if (!looksHostname(host) || !inRange(port)) return null;
      return { protocol: 'http', host, port, username: '', password: '' };
    }

    // user:pass:host:port
    const uphp = line.split(":");
    if (uphp.length === 4 && /^\d+$/.test(uphp[3])) {
      const [username, password, host, portStr] = uphp;
      const port = parseInt(portStr, 10);
      if (looksHostname(host) && inRange(port)) return { protocol: 'http', host, port, username, password };
    }

    return null;
  };

  const seen = new Set();
  const proxies = [];
  for (const line of lines) {
    const p = parseOne(line);
    if (!p) {
      console.log(`[SYSTEM] WARNING: Invalid proxy format skipped: "${line}" - expected format: http://ip:port or user:pass@ip:port`);
      continue;
    }
    const key = `${p.protocol}://${p.username}:${p.password}@${p.host}:${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Assign 1-based index corresponding to order in proxies.txt after filtering
    proxies.push({ ...p, _idx: proxies.length + 1 });
  }
  loadedProxies = proxies;
  if (lines.length > 0 && proxies.length === 0) {
    console.log(`[SYSTEM] ERROR: No valid proxies loaded from ${lines.length} lines - check proxies.txt format`);
  }
  // Reset quarantine on reload to avoid mismatched indices after edits
  try { proxyQuarantine.clear(); } catch (_) { }
};

let nextProxyIndex = 0;
const getNextProxy = () => {
  const { proxyEnabled, proxyRotationMode } = currentSettings || {};
  if (!proxyEnabled || loadedProxies.length === 0) return null;
  const now = Date.now();
  const isUsable = (p) => {
    const index = Number(p._idx) || (loadedProxies.indexOf(p) + 1);
    const until = proxyQuarantine.get(index) || 0;
    return until <= now;
  };

  const buildSel = (p) => {
    let proxyUrl = `${p.protocol}://`;
    if (p.username && p.password) {
      proxyUrl += `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`;
    }
    proxyUrl += `${p.host}:${p.port}`;
    const display = `${p.host}:${p.port}`;
    const index = Number(p._idx) || (loadedProxies.indexOf(p) + 1);
    return { url: proxyUrl, idx: index, display };
  };

  // Try up to N attempts to find a non-quarantined proxy
  const maxAttempts = loadedProxies.length;
  if (proxyRotationMode === "random") {
    for (let i = 0; i < maxAttempts; i++) {
      const randomIndex = Math.floor(Math.random() * loadedProxies.length);
      const proxy = loadedProxies[randomIndex];
      if (isUsable(proxy)) return buildSel(proxy);
    }
  } else {
    for (let i = 0; i < maxAttempts; i++) {
      const proxy = loadedProxies[nextProxyIndex];
      nextProxyIndex = (nextProxyIndex + 1) % loadedProxies.length;
      if (isUsable(proxy)) return buildSel(proxy);
    }
  }
  return null;
};

const quarantineProxy = (idx, minutes = 15, reason = "") => {
  try {
    const ms = Math.max(1, Math.floor(Number(minutes))) * 60 * 1000;
    const until = Date.now() + ms;
    proxyQuarantine.set(idx, until);
    const p = loadedProxies.find(x => (Number(x._idx) || (loadedProxies.indexOf(x) + 1)) === idx);
    const label = p ? `${p.host}:${p.port}` : `#${idx}`;
    log("SYSTEM", "wplacer", `🧯 Quarantining proxy #${idx} (${label}) for ${Math.floor(ms / 60000)}m${reason ? ` — ${reason}` : ''}`);
  } catch (_) { }
};


// --- Suspension error (kept from new version) ---
class SuspensionError extends Error {
  constructor(message, durationMs) {
    super(message);
    this.name = "SuspensionError";
    this.durationMs = durationMs;
    this.suspendedUntil = Date.now() + durationMs;
  }
}

// --- WPlacer with old painting modes ported over ---
class WPlacer {
  constructor(template, coords, settings, templateName, paintTransparentPixels = false, initialBurstSeeds = null, skipPaintedPixels = false, outlineMode = false, userId = null) {
    this.template = template;
    this.templateName = templateName;
    this.coords = coords;
    this.settings = settings;
    this.paintTransparentPixels = !!paintTransparentPixels;

    this.skipPaintedPixels = !!skipPaintedPixels;
    this.outlineMode = !!outlineMode;
    this.userId = userId; // Для привязки cf_clearance к пользователю

    this.cookies = null;
    this.browser = null;
    this.userInfo = null;
    this.tiles = new Map();
    this.token = null;
    this.pawtect = null;
    this._lastTilesAt = 0;

    // burst seeds persistence
    this._burstSeeds = Array.isArray(initialBurstSeeds) ? initialBurstSeeds.map(s => ({ gx: s.gx, gy: s.gy })) : null;
    this._activeBurstSeedIdx = null;
  }

  // Add lightweight cancellation helper that can be set by TemplateManager
  _isCancelled() {
    try { return typeof this.shouldStop === 'function' ? !!this.shouldStop() : false; } catch (_) { return false; }
  }

  async login(cookies) {
    console.log(`🔥 [DEBUG] WPlacer.login() method called with cookies:`, JSON.stringify(cookies, null, 2));
    console.log(`🔥 [DEBUG] WPlacer.userId:`, this.userId);
    this.cookies = cookies;
    const jar = new CookieJar();
    for (const cookie of Object.keys(this.cookies)) {
      const value = `${cookie}=${this.cookies[cookie]}; Path=/`;
      jar.setCookieSync(value, "https://bplace.org");
      jar.setCookieSync(value, "https://bplace.org");
    }
    const impitOptions = {
      cookieJar: jar,
      browser: "chrome",
      ignoreTlsErrors: true,
      userId: this.userId // Передаем userId для CF-Clearance
    };
    const proxySel = getNextProxy();
    if (proxySel) {
      impitOptions.proxyUrl = proxySel.url;
      if (currentSettings.logProxyUsage) {
        log("SYSTEM", "wplacer", `Using proxy #${proxySel.idx}: ${proxySel.display}`);
      }
      try { this._lastProxyIdx = proxySel.idx; } catch (_) { }
    } else if (currentSettings.proxyEnabled && loadedProxies.length === 0) {
      log("SYSTEM", "wplacer", `⚠️ Proxy enabled but no valid proxies loaded - check proxies.txt format`);
    }

    // Используем MockImpit с поддержкой CF-Clearance
    this.browser = new Impit(impitOptions);

    await this.loadUserInfo();
    return this.userInfo;
  }

  async loadUserInfo() {
    const url = "https://bplace.org/me";
    console.log(`🔥 [DEBUG] WPlacer.loadUserInfo() starting, URL: ${url}`);
    console.log(`🔥 [DEBUG] Browser object available:`, !!this.browser);

    // Используем browser.fetch который поддерживает CF-Clearance
    const me = await this.browser.fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "identity", // Force no compression
        "Accept-Language": "ru-UA,ru;q=0.9,en-US;q=0.8,en;q=0.7,ru-RU;q=0.6",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Origin": "https://bplace.org",
        "Pragma": "no-cache",
        "Referer": "https://bplace.org/",
        "Sec-Ch-Ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        "Sec-Ch-Ua-Arch": '"x86"',
        "Sec-Ch-Ua-Bitness": '"64"',
        "Sec-Ch-Ua-Full-Version": '"140.0.7339.208"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Model": '""',
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Ch-Ua-Platform-Version": '"19.0.0"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest"
      },
      redirect: "manual"
    });
    const status = me.status;
    const contentType = (me.headers.get("content-type") || "").toLowerCase();
    const contentEncoding = me.headers.get("content-encoding");

    console.log(`🔥 [DEBUG] Response headers - Content-Type: ${contentType}, Content-Encoding: ${contentEncoding}`);

    // Temporarily disable decompression to fix body reading issue
    console.log(`🔥 [DEBUG] Using direct text response (decompression disabled)`);
    const meClone = me.clone();
    const bodyText = await meClone.text();

    const short = bodyText.substring(0, 200);

    console.log(`🔥 [DEBUG] LoadUserInfo response status: ${status}`);
    console.log(`🔥 [DEBUG] LoadUserInfo response content-type: ${contentType}`);
    console.log(`🔥 [DEBUG] LoadUserInfo response body:`, short);
    if (status === 429) {
      throw new Error("❌ Rate limited (429) - waiting before retry");
    }
    if (status === 502) {
      throw new Error(`❌ Server temporarily unavailable (502) - retrying later`);
    }
    if (status >= 300 && status < 400) {
      const loc = me.headers.get('location') || '';
      throw new Error(`❌ Unexpected redirect (${status})${loc ? ` to ${loc}` : ''}. Likely cookies invalid or blocked by proxy.`);
    }
    if (status === 401 || status === 403) {
      if (/cloudflare|attention required|access denied|just a moment|cf-ray|challenge-form|cf-chl/i.test(bodyText)) {
        // auto-quarantine proxy for a short time to reduce repeated blocks
        try { if (typeof this._lastProxyIdx === 'number') quarantineProxy(this._lastProxyIdx, 20, `cloudflare_block_${status}`); } catch (_) { }
        throw new Error(`❌ Cloudflare blocked the request.`);
      }
      if (contentType.includes("application/json")) {
        try {
          const json = JSON.parse(bodyText);
          if (json?.error) {
            throw new Error(`❌ Authentication failed (${status}): ${String(json.error).slice(0, 180)}...`);
          }
        } catch (_) {
          // fall through to generic with snippet
        }
      }
      throw new Error(`Authentication failed (${status}). Response: "${short}..."`);
    }
    if (contentType.includes("application/json")) {
      let userInfo;
      try {
        userInfo = JSON.parse(bodyText);
      } catch {
        throw new Error(`❌ Failed to parse JSON from /me (status ${status}).`);
      }
      // Treat banned accounts as an error so UI can highlight in red
      if (userInfo && userInfo.banned === true) {
        throw new Error("banned");
      }
      if (userInfo?.error) {
        throw new Error(`❌ (500) Failed to authenticate: "${userInfo.error}". The cookie is likely invalid or expired.`);
      }
      if (userInfo?.id && userInfo?.name) {
        this.userInfo = userInfo;
        // Устанавливаем userId для CF-Clearance если он не был установлен
        if (!this.userId) {
          this.userId = userInfo.id;
        }
        try { ChargeCache.markFromUserInfo(userInfo); } catch { }
        return true;
      }
      throw new Error(`❌ Unexpected JSON from /me (status ${status}): ${JSON.stringify(userInfo).slice(0, 200)}...`);
    }
    if (/error\s*1015/i.test(bodyText) || /rate.?limit/i.test(bodyText)) {
      throw new Error("❌ (1015) You are being rate-limited by the server. Please wait a moment and try again.");
    }
    if (/cloudflare|attention required|access denied|just a moment|cf-ray|challenge-form|cf-chl/i.test(bodyText)) {
      try { if (typeof this._lastProxyIdx === 'number') quarantineProxy(this._lastProxyIdx, 20, 'cloudflare_block_html'); } catch (_) { }
      throw new Error(`❌ Cloudflare blocked the request.`);
    }
    if (/<!doctype html>/i.test(bodyText) || /<html/i.test(bodyText)) {
      throw new Error(`❌ Failed to parse server response (HTML, status ${status}). Likely a login page → cookies invalid or expired. Snippet: "${short}..."`);
    }
    throw new Error(`❌ Failed to parse server response (status ${status}). Response: "${short}..."`);
  }

  async post(url, body) {
    const headers = {
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      "Accept-Language": "ru-UA,ru;q=0.9,en-US;q=0.8,en;q=0.7,ru-RU;q=0.6",
      "Content-Type": "text/plain;charset=UTF-8",
      "Origin": "https://bplace.org",
      "Priority": "u=1, i",
      "Referer": "https://bplace.org/",
      "Sec-Ch-Ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
      "Sec-Ch-Ua-Arch": '"x86"',
      "Sec-Ch-Ua-Bitness": '"64"',
      "Sec-Ch-Ua-Full-Version": '"140.0.7339.208"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Model": '""',
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Ch-Ua-Platform-Version": '"19.0.0"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    };

    // Детальное логирование запроса
    console.log(`🔥 [DEBUG] POST Request to: ${url}`);
    console.log(`🔥 [DEBUG] Request body:`, JSON.stringify(body, null, 2));
    console.log(`🔥 [DEBUG] Request headers:`, JSON.stringify(headers, null, 2));

    // Добавляем куки в заголовки
    const cookieHeader = Object.keys(this.cookies).map(key => `${key}=${this.cookies[key]}`).join('; ');
    headers["Cookie"] = cookieHeader;

    const request = await this.browser.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual"
    });
    const status = request.status;
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    const contentEncoding = request.headers.get("content-encoding");

    console.log(`🔥 [DEBUG] POST Response headers - Content-Type: ${contentType}, Content-Encoding: ${contentEncoding}`);

    // Temporarily disable decompression to fix body reading issue
    console.log(`🔥 [DEBUG] Using direct text response for POST (decompression disabled)`);
    const requestClone = request.clone();
    const text = await requestClone.text();

    // Логирование ответа
    console.log(`🔥 [DEBUG] Response status: ${status}`);
    console.log(`🔥 [DEBUG] Response content-type: ${contentType}`);
    console.log(`🔥 [DEBUG] Response text:`, text.substring(0, 500));
    if (!contentType.includes("application/json")) {
      const short = text.substring(0, 200);
      if (/error\s*1015/i.test(text) || /rate.?limit/i.test(text) || status === 429) {
        throw new Error("❌ (1015) You are being rate-limited. Please wait a moment and try again.");
      }
      if (status === 502) {
        throw new Error(`❌ (502) Bad Gateway: The server is temporarily unavailable. Please try again later.`);
      }
      if (status === 401 || status === 403) {
        return { status, data: { error: "Unauthorized" } };
      }
      return { status, data: { error: `Non-JSON response (status ${status}): ${short}...` } };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status, data: { error: `Invalid JSON (status ${status}).` } };
    }
    return { status, data };
  }

  async loadTiles() {
    this.tiles.clear();
    const [tx, ty, px, py] = this.coords;
    const endPx = px + this.template.width;
    const endPy = py + this.template.height;
    const endTx = tx + Math.floor(endPx / 1000);
    const endTy = ty + Math.floor(endPy / 1000);

    const loadOneTile = async (targetTx, targetTy, allowActivate = true) => {
      try {
        const url = `https://bplace.org/files/s0/tiles/${targetTx}/${targetTy}.png?t=${Date.now()}`;

        // Prepare headers with cf_clearance cookie
        const headers = { Accept: "image/*" };
        const cookieHeader = Object.keys(this.cookies).map(key => `${key}=${this.cookies[key]}`).join('; ');
        if (cookieHeader) {
          headers["Cookie"] = cookieHeader;
        }

        const resp = await fetch(url, { headers });
        if (resp.status === 404) {
          // Tile might be not initialized yet
          if (allowActivate && this.token) {
            try {
              const activated = await this._activateTileIfPossible(targetTx, targetTy);
              if (activated) {
                // brief wait and retry once
                await new Promise((r) => setTimeout(r, 500));
                return loadOneTile(targetTx, targetTy, false);
              }
            } catch (_) {
              // ignore activation failures
            }
          }
          try { log(this.userInfo?.id || "SYSTEM", this.userInfo?.name || "wplacer", `[${this.templateName}] ⚠️ Tile ${targetTx}, ${targetTy} may be inactive (404). Trying to activate and reload...`); } catch (_) {}
          return null;
        }
        if (!resp.ok) return null;
        const buffer = Buffer.from(await resp.arrayBuffer());
        const image = await loadImage(buffer);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const tileData = { width: canvas.width, height: canvas.height, data: Array.from({ length: canvas.width }, () => []) };
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let x = 0; x < canvas.width; x++) {
          for (let y = 0; y < canvas.height; y++) {
            const i = (y * canvas.width + x) * 4;
            const [r, g, b, a] = [d.data[i], d.data[i + 1], d.data[i + 2], d.data[i + 3]];
            tileData.data[x][y] = a === 255 ? (pallete[`${r},${g},${b}`] || 0) : 0;
          }
        }
        return tileData;
      } catch (_) {
        return null;
      }
    };

    const promises = [];
    for (let currentTx = tx; currentTx <= endTx; currentTx++) {
      for (let currentTy = ty; currentTy <= endTy; currentTy++) {
        const p = loadOneTile(currentTx, currentTy).then((tileData) => {
          if (tileData) this.tiles.set(`${currentTx}_${currentTy}`, tileData);
        });
        promises.push(p);
      }
    }
    await Promise.all(promises);
    return true;
  }

  async _activateTileIfPossible(targetTx, targetTy) {
    try {
      const [startTileX, startTileY, startPx, startPy] = this.coords;
      const tileSize = 1000;
      // iterate template area to find any pixel that belongs to this tile
      for (let y = 0; y < this.template.height; y++) {
        for (let x = 0; x < this.template.width; x++) {
          const templateColor = this.template.data?.[x]?.[y];
          if (templateColor == null) continue;
          if (templateColor === 0 && !this.paintTransparentPixels) continue;
          const globalPx = startPx + x;
          const globalPy = startPy + y;
          const tx = startTileX + Math.floor(globalPx / tileSize);
          const ty = startTileY + Math.floor(globalPy / tileSize);
          if (tx !== targetTx || ty !== targetTy) continue;
          const localPx = globalPx % tileSize;
          const localPy = globalPy % tileSize;
          const body = { colors: [templateColor], coords: [localPx, localPy], t: "skip" };
          if (globalThis.__wplacer_last_fp) body.fp = globalThis.__wplacer_last_fp;
          const res = await this._executePaint(targetTx, targetTy, body);
          if (res && res.success && res.painted > 0) {
            try { log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] ℹ️ Tile ${targetTx},${targetTy} might be inactive. Tried to activate by painting 1 pixel.`); } catch (_) {}
            return true;
          }
          return false;
        }
      }
    } catch (_) { }
    return false;
  }

  hasColor(id) {
    if (id < colorBitmapShift) return true; // transparent + basic colors
    return !!(this.userInfo.extraColorsBitmap & (1 << (id - colorBitmapShift)));
  }

  async _executePaint(tx, ty, body) {
    if (body.colors.length === 0) return { painted: 0, success: true };
    const response = await this.post(`https://bplace.org/s0/pixel/${tx}/${ty}`, body);

    if (response.data.painted && response.data.painted === body.colors.length) {
      log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🎨 Painted ${body.colors.length} pixels on tile ${tx}, ${ty}.`);
      try {
        // Heatmap logging: write per-template records
        const entry = Object.entries(templates).find(([tid, t]) => t && t.name === this.templateName && Array.isArray(t.coords) && JSON.stringify(t.coords) === JSON.stringify(this.coords));
        const tpl = entry ? entry[1] : null;
        const tplId = entry ? entry[0] : null;
        if (tpl && tpl.heatmapEnabled) {
          const [TlX, TlY, PxX0, PxY0] = this.coords;
          const date = Date.now();
          const coords = body.coords || [];
          // records are pairs Px X, Px Y (convert to template-local coordinates)
          const startGlobalX = (TlX * 1000) + (PxX0 | 0);
          const startGlobalY = (TlY * 1000) + (PxY0 | 0);
          const pairs = [];
          for (let i = 0; i < coords.length; i += 2) {
            const localPx = coords[i];
            const localPy = coords[i + 1];
            if (typeof localPx === 'number' && typeof localPy === 'number') {
              const globalX = (tx * 1000) + localPx;
              const globalY = (ty * 1000) + localPy;
              const tplX = globalX - startGlobalX; // template-local X
              const tplY = globalY - startGlobalY; // template-local Y
              if (Number.isFinite(tplX) && Number.isFinite(tplY)) {
                pairs.push({ date, "Tl X": TlX, "Tl Y": TlY, "Px X": tplX, "Px Y": tplY });
              }
            }
          }
          if (pairs.length) {
            const idPart = tplId ? String(tplId) : encodeURIComponent(this.templateName);
            const fileName = `${idPart}.jsonl`;
            const filePath = path.join(heatMapsDir, fileName);
            // ensure file exists
            try { if (!existsSync(filePath)) writeFileSync(filePath, ""); } catch (_) { }
            // append as JSONL to avoid memory usage
            const lines = pairs.map(o => JSON.stringify(o)).join("\n") + "\n";
            appendFileSync(filePath, lines);
            // enforce limit by truncating oldest when exceeding lines
            try {
              const limit = Math.max(0, Math.floor(Number(tpl.heatmapLimit || 10000))) || 10000;
              if (limit > 0) {
                const raw = readFileSync(filePath, "utf8");
                const arr = raw.split(/\r?\n/).filter(Boolean);
                if (arr.length > limit) {
                  const keep = arr.slice(arr.length - limit);
                  writeFileSync(filePath, keep.join("\n") + "\n");
                }
              }
            } catch (_) { }
          }
        }
      } catch (_) { }
      return { painted: body.colors.length, success: true };
    } else if (response.status === 401 || response.status === 403) {
      // Authentication expired - mark for cookie refresh
      return { painted: 0, success: false, reason: "auth_expired" };
    } else if (response.status === 451 && response.data.suspension) {
      throw new SuspensionError(`❌ Account is suspended (451).`, response.data.durationMs || 0);
    } else if (response.status === 500) {
      log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] ❌ Server error (500) - waiting before retry...`);
      await sleep(40000);
      return { painted: 0, success: false, reason: "server_error" };
    } else if (response.status === 429 || (response.data.error && response.data.error.includes("Error 1015"))) {
      throw new Error("❌ Rate limited (429/1015) - waiting before retry");
    }
    throw new Error(`❌ Unexpected response for tile ${tx},${ty}: ${JSON.stringify(response)}`);
  }

  // ----- Helpers for "old" painting logic -----
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  _globalXY(p) {
    const [sx, sy] = this.coords;
    return { gx: (p.tx - sx) * 1000 + p.px, gy: (p.ty - sy) * 1000 + p.py };
  }
  _templateRelXY(p) {
    const [sx, sy, spx, spy] = this.coords;
    const gx = (p.tx - sx) * 1000 + p.px;
    const gy = (p.ty - sy) * 1000 + p.py;
    return { x: gx - spx, y: gy - spy };
  }

  _pickBurstSeeds(pixels, k = 2, _ignoredTopFuzz = 5) {
    if (!pixels?.length) return [];
    const pts = pixels.map((p) => this._globalXY(p));

    // Deterministic selection: pick lexicographically smallest point as first
    const firstIdx = (() => {
      let idx = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].gx < pts[idx].gx || (pts[i].gx === pts[idx].gx && pts[i].gy < pts[idx].gy)) idx = i;
      }
      return idx;
    })();

    const seeds = [pts[firstIdx]];
    if (pts.length === 1) return seeds.map((s) => ({ gx: s.gx, gy: s.gy }));

    // Second: farthest from first
    let far = 0, best = -1;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].gx - pts[firstIdx].gx;
      const dy = pts[i].gy - pts[firstIdx].gy;
      const d2 = dx * dx + dy * dy;
      if (d2 > best) { best = d2; far = i; }
    }
    if (!seeds.some((s) => s.gx === pts[far].gx && s.gy === pts[far].gy)) seeds.push(pts[far]);

    // Next: farthest from nearest existing seed (maximin), deterministic
    while (seeds.length < Math.min(k, pts.length)) {
      let bestIdx = -1;
      let bestMinD2 = -1;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (seeds.some((s) => s.gx === p.gx && s.gy === p.gy)) continue;
        let minD2 = Infinity;
        for (const s of seeds) {
          const dx = s.gx - p.gx;
          const dy = s.gy - p.gy;
          const d2 = dx * dx + dy * dy;
          if (d2 < minD2) minD2 = d2;
        }
        if (minD2 > bestMinD2) { bestMinD2 = minD2; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      seeds.push(pts[bestIdx]);
    }

    return seeds.map((s) => ({ gx: s.gx, gy: s.gy }));
  }

  /**
   * Multi-source BFS ordering like in the old version.
   * seeds can be number (count) or array of {gx,gy}.
   */
  _orderByBurst(mismatchedPixels, seeds = 2) {
    if (mismatchedPixels.length <= 2) return mismatchedPixels;

    const [startX, startY] = this.coords;
    const byKey = new Map();
    for (const p of mismatchedPixels) {
      const gx = (p.tx - startX) * 1000 + p.px;
      const gy = (p.ty - startY) * 1000 + p.py;
      p._gx = gx;
      p._gy = gy;
      byKey.set(`${gx},${gy}`, p);
    }

    const useSeeds = Array.isArray(seeds) ? seeds.slice() : this._pickBurstSeeds(mismatchedPixels, seeds);

    // mark used for nearest search
    const used = new Set();
    const nearest = (gx, gy) => {
      let best = null,
        bestD = Infinity,
        key = null;
      for (const p of mismatchedPixels) {
        const k = `${p._gx},${p._gy}`;
        if (used.has(k)) continue;
        const dx = p._gx - gx,
          dy = p._gy - gy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) {
          bestD = d2;
          best = p;
          key = k;
        }
      }
      if (best) used.add(key);
      return best;
    };

    const starts = useSeeds.map((s) => nearest(s.gx, s.gy)).filter(Boolean);

    const visited = new Set();
    const queues = [];
    const speeds = [];
    const prefs = [];

    const randDir = () => [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];

    for (const sp of starts) {
      const k = `${sp._gx},${sp._gy}`;
      if (!visited.has(k)) {
        visited.add(k);
        queues.push([sp]);
        speeds.push(0.7 + Math.random() * 1.1);
        prefs.push(randDir());
      }
    }

    const pickQueue = () => {
      const weights = speeds.map((s, i) => (queues[i].length ? s : 0));
      const sum = weights.reduce((a, b) => a + b, 0);
      if (!sum) return -1;
      let r = Math.random() * sum;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i;
      }
      return weights.findIndex((w) => w > 0);
    };

    const orderNeighbors = (dir) => {
      const base = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      base.sort(
        (a, b) =>
          b[0] * dir[0] +
          b[1] * dir[1] +
          (Math.random() - 0.5) * 0.2 -
          (a[0] * dir[0] + a[1] * dir[1] + (Math.random() - 0.5) * 0.2)
      );
      return base;
    };

    const dash = (from, qi, dir) => {
      const dashChance = 0.45;
      const maxDash = 1 + Math.floor(Math.random() * 3);
      if (Math.random() > dashChance) return;
      let cx = from._gx,
        cy = from._gy;
      for (let step = 0; step < maxDash; step++) {
        const nx = cx + dir[0],
          ny = cy + dir[1];
        const key = `${nx},${ny}`;
        if (!byKey.has(key) || visited.has(key)) break;
        visited.add(key);
        queues[qi].push(byKey.get(key));
        cx = nx;
        cy = ny;
      }
    };

    const out = [];

    while (true) {
      const qi = pickQueue();
      if (qi === -1) break;
      const cur = queues[qi].shift();
      out.push(cur);

      const neigh = orderNeighbors(prefs[qi]);
      let firstDir = null;
      let firstPt = null;

      for (const [dx, dy] of neigh) {
        const nx = cur._gx + dx,
          ny = cur._gy + dy;
        const k = `${nx},${ny}`;
        if (byKey.has(k) && !visited.has(k)) {
          visited.add(k);
          const p = byKey.get(k);
          queues[qi].push(p);
          if (!firstDir) {
            firstDir = [dx, dy];
            firstPt = p;
          }
        }
      }

      if (firstDir) {
        if (Math.random() < 0.85) prefs[qi] = firstDir;
        dash(firstPt, qi, prefs[qi]);
      }
    }

    // pick up isolated areas
    if (out.length < mismatchedPixels.length) {
      for (const p of mismatchedPixels) {
        const k = `${p._gx},${p._gy}`;
        if (!visited.has(k)) {
          visited.add(k);
          const q = [p];
          while (q.length) {
            const c = q.shift();
            out.push(c);
            for (const [dx, dy] of orderNeighbors(randDir())) {
              const nx = c._gx + dx,
                ny = c._gy + dy;
              const kk = `${nx},${ny}`;
              if (byKey.has(kk) && !visited.has(kk)) {
                visited.add(kk);
                q.push(byKey.get(kk));
              }
            }
          }
        }
      }
    }

    // cleanup temp props
    for (const p of out) {
      delete p._gx;
      delete p._gy;
    }
    return out;
  }

  _getMismatchedPixels() {
    const [startX, startY, startPx, startPy] = this.coords;
    const mismatched = [];
    for (let y = 0; y < this.template.height; y++) {
      for (let x = 0; x < this.template.width; x++) {
        const _templateColor = this.template.data[x][y];

        // old behavior: 0 means "transparent pixel" in the template.
        // If paintTransparentPixels is false — we skip those; if true — we try to paint them too.
        if (_templateColor === 0 && !this.paintTransparentPixels) continue;
        if (_templateColor == null) continue;

        // substitute -1 for transparent
        const templateColor = (_templateColor == -1 ? 0 : _templateColor);

        const globalPx = startPx + x;
        const globalPy = startPy + y;
        const targetTx = startX + Math.floor(globalPx / 1000);
        const targetTy = startY + Math.floor(globalPy / 1000);
        const localPx = globalPx % 1000;
        const localPy = globalPy % 1000;

        const neighbors = [
          this.template.data[x - 1]?.[y],
          this.template.data[x + 1]?.[y],
          this.template.data[x]?.[y - 1],
          this.template.data[x]?.[y + 1],
        ];
        const isEdge = neighbors.some((n) => n === 0 || n === undefined);

        const tile = this.tiles.get(`${targetTx}_${targetTy}`);
        if (!tile || !tile.data[localPx]) {
          // Treat missing tile data as mismatch to avoid premature finish
          if (this.hasColor(templateColor)) {
            mismatched.push({ tx: targetTx, ty: targetTy, px: localPx, py: localPy, color: templateColor, isEdge: isEdge });
          }
          continue;
        }

        const tileColor = tile.data[localPx][localPy];

        // Setting to paint "behind" other's artwork, by not painting over already painted pixels.
        const shouldPaint = this.skipPaintedPixels
          ? tileColor === 0
          : templateColor !== tileColor;

        if (shouldPaint && this.hasColor(templateColor)) {
          mismatched.push({ tx: targetTx, ty: targetTy, px: localPx, py: localPy, color: templateColor, isEdge: isEdge });
        }
      }
    }
    return mismatched;
  }

  /**
   * Paint using "old" modes.
   * method is read from settings.drawingMethod in TemplateManager.
   */
  async paint(method = "linear") {
    await this.loadUserInfo();
    if (this._isCancelled()) return 0;

    switch (method) {
      case "linear":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Top to Bottom)...`);
        break;
      case "linear-reversed":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Bottom to Top)...`);
        break;
      case "linear-ltr":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Left to Right)...`);
        break;
      case "linear-rtl":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Right to Left)...`);
        break;
      case "radial-inward":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Radial inward)...`);
        break;
      case "radial-outward":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Radial outward)...`);
        break;
      case "singleColorRandom":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Random Color)...`);
        break;
      case "colorByColor":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Color by Color)...`);
        break;
      case "colors-burst-rare":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Colors burst, rare first)...`);
        break;
      case "random":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Random Scatter)...`);
        break;
      case "burst":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Burst / Multi-source)...`);
        break;
      case "outline-then-burst":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Outline then Burst)...`);
        break;
      case "burst-mixed":
        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🧱 Painting (Burst Mixed)...`);
        break;
      default:
        throw new Error(`Unknown paint method: ${method}`);
    }

    while (true) {

      if (this._isCancelled()) return 0;

      const nowTiles = Date.now();
      const TILES_CACHE_MS = 3000;
      if (nowTiles - this._lastTilesAt >= TILES_CACHE_MS || this.tiles.size === 0) {
        await this.loadTiles();
        this._lastTilesAt = Date.now();
      }
      // Token check removed: no longer needed for new bplace.org (only CF-Clearance and JWT)

      let activeMethod = method;
      if (method === "burst-mixed") {
        const pool = ["outline-then-burst", "burst", "colors-burst-rare"];
        activeMethod = pool[Math.floor(Math.random() * pool.length)];
        try {
          const cfg = (currentSettings && currentSettings.logCategories) || {};
          if (cfg.painting !== false) {
            log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🎲 Mixed mode picked this turn: ${activeMethod}`);
          }
        } catch (_) { }
      }

      // Sei - Moved this below "burst-mixed" check above; Makes more sense in console.
      let mismatchedPixels = this._getMismatchedPixels();
      if (mismatchedPixels.length === 0) return 0;

      log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] Found ${mismatchedPixels.length} mismatched pixels.`);

      // "Outline Mode", an incredibly convenient tool for securing your space before drawing.
      if (this.outlineMode) {
        const edge = mismatchedPixels.filter((p) => p.isEdge);
        if (edge.length > 0) {
          log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] Outlining design first.`);
          mismatchedPixels = edge;
        }
      }
      switch (activeMethod) {
        case "linear-reversed":
          mismatchedPixels.reverse();
          break;

        case "linear-ltr": {
          const [startX, startY] = this.coords;
          mismatchedPixels.sort((a, b) => {
            const aGlobalX = (a.tx - startX) * 1000 + a.px;
            const bGlobalX = (b.tx - startX) * 1000 + b.px;
            if (aGlobalX !== bGlobalX) return aGlobalX - bGlobalX;
            return (a.ty - startY) * 1000 + a.py - ((b.ty - startY) * 1000 + b.py);
          });
          break;
        }

        case "linear-rtl": {
          const [startX, startY] = this.coords;
          mismatchedPixels.sort((a, b) => {
            const aGlobalX = (a.tx - startX) * 1000 + a.px;
            const bGlobalX = (b.tx - startX) * 1000 + b.px;
            if (aGlobalX !== bGlobalX) return bGlobalX - aGlobalX;
            return (a.ty - startY) * 1000 + a.py - ((b.ty - startY) * 1000 + b.py);
          });
          break;
        }

        case "radial-inward": {
          const [sx, sy, spx, spy] = this.coords;
          const cx = spx + (this.template.width - 1) / 2;
          const cy = spy + (this.template.height - 1) / 2;
          const r2 = (p) => {
            const gx = (p.tx - sx) * 1000 + p.px;
            const gy = (p.ty - sy) * 1000 + p.py;
            const dx = gx - cx, dy = gy - cy;
            return dx * dx + dy * dy;
          };
          const ang = (p) => {
            const gx = (p.tx - sx) * 1000 + p.px;
            const gy = (p.ty - sy) * 1000 + p.py;
            return Math.atan2(gy - cy, gx - cx);
          };
          mismatchedPixels.sort((a, b) => {
            const d = r2(b) - r2(a);
            return d !== 0 ? d : (ang(a) - ang(b));
          });
          break;
        }

        case "radial-outward": {
          const [sx, sy, spx, spy] = this.coords;
          const cx = spx + (this.template.width - 1) / 2;
          const cy = spy + (this.template.height - 1) / 2;
          const r2 = (p) => {
            const gx = (p.tx - sx) * 1000 + p.px;
            const gy = (p.ty - sy) * 1000 + p.py;
            const dx = gx - cx, dy = gy - cy;
            return dx * dx + dy * dy;
          };
          const ang = (p) => {
            const gx = (p.tx - sx) * 1000 + p.px;
            const gy = (p.ty - sy) * 1000 + p.py;
            return Math.atan2(gy - cy, gx - cx);
          };
          mismatchedPixels.sort((a, b) => {
            const d = r2(a) - r2(b);
            return d !== 0 ? d : (ang(a) - ang(b));
          });
          break;
        }

        case "singleColorRandom":
        case "colorByColor": {
          const pixelsByColor = mismatchedPixels.reduce((acc, p) => {
            if (!acc[p.color]) acc[p.color] = [];
            acc[p.color].push(p);
            return acc;
          }, {});
          const colors = Object.keys(pixelsByColor);
          if (method === "singleColorRandom") {
            for (let i = colors.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [colors[i], colors[j]] = [colors[j], colors[i]];
            }
          }
          mismatchedPixels = colors.flatMap((color) => pixelsByColor[color]);
          break;
        }

        case "colors-burst-rare": {
          const byColor = mismatchedPixels.reduce((m, p) => {
            (m[p.color] ||= []).push(p);
            return m;
          }, {});
          const colorsAsc = Object.keys(byColor).sort((a, b) => byColor[a].length - byColor[b].length);
          const desired = Math.max(1, Math.min(this.settings?.seedCount ?? 2, 16));
          if (!this._burstSeeds || this._burstSeeds.length !== desired) {
            this._burstSeeds = this._pickBurstSeeds(mismatchedPixels, desired);
            try { const cfg = (currentSettings && currentSettings.logCategories) || {}; if (cfg.painting !== false) { log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 💥 Burst seeds (${desired}): ${JSON.stringify(this._burstSeeds)}`); } } catch (_) { }
          }
          const out = [];
          for (const c of colorsAsc) {
            out.push(...this._orderByBurst(byColor[c], this._burstSeeds));
          }
          mismatchedPixels = out;
          break;
        }

        case "random":
          this._shuffle(mismatchedPixels);
          break;

        case "burst": {
          const desired = Math.max(1, Math.min(this.settings?.seedCount ?? 2, 16));
          if (!this._burstSeeds || this._burstSeeds.length !== desired) {
            this._burstSeeds = this._pickBurstSeeds(mismatchedPixels, desired);
            try { const cfg = (currentSettings && currentSettings.logCategories) || {}; if (cfg.painting !== false) { log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 💥 Burst seeds (${desired}): ${JSON.stringify(this._burstSeeds)}`); } } catch (_) { }
          }
          mismatchedPixels = this._orderByBurst(mismatchedPixels, this._burstSeeds);
          break;
        }

        case "outline-then-burst": {
          const desired = Math.max(1, Math.min(this.settings?.seedCount ?? 2, 16));
          const outline = [];
          const inside = [];

          for (const p of mismatchedPixels) {
            if (p.color === 0) { inside.push(p); continue; }
            const { x, y } = this._templateRelXY(p);
            const w = this.template.width, h = this.template.height;
            const tcol = this.template.data[x][y];

            let isOutline = (x === 0 || y === 0 || x === w - 1 || y === h - 1);
            if (!isOutline) {
              const neigh = [[1, 0], [-1, 0], [0, 1], [0, -1]];
              for (const [dx, dy] of neigh) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) { isOutline = true; break; }
                if (this.template.data[nx][ny] !== tcol) { isOutline = true; break; }
              }
            }
            (isOutline ? outline : inside).push(p);
          }

          const pickRandomSeed = (arr) => {
            const p = arr[Math.floor(Math.random() * arr.length)];
            const { gx, gy } = this._globalXY(p);
            return [{ gx, gy }];
          };

          if (!this._burstSeeds || this._burstSeeds.length !== desired) {
            this._burstSeeds = this._pickBurstSeeds(mismatchedPixels, desired);
            try { const cfg = (currentSettings && currentSettings.logCategories) || {}; if (cfg.painting !== false) { log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 💥 Burst seeds (${desired}): ${JSON.stringify(this._burstSeeds)}`); } } catch (_) { }
          }
          const orderedOutline = outline.length ? this._orderByBurst(outline, this._burstSeeds) : [];
          const orderedInside = inside.length ? this._orderByBurst(inside, this._burstSeeds) : [];

          mismatchedPixels = orderedOutline.concat(orderedInside);
          break;
        }
      }

      const allowedByCharges = Math.max(0, Math.floor(this.userInfo?.charges?.count || 0));
      const maxPerPass = Number.isFinite(this.settings?.maxPixelsPerPass) ? Math.max(0, Math.floor(this.settings.maxPixelsPerPass)) : 0;
      const limit = maxPerPass > 0 ? Math.min(allowedByCharges, maxPerPass) : allowedByCharges;
      if (limit <= 0) {

        return 0;
      }
      const pixelsToPaint = mismatchedPixels.slice(0, limit);
      const bodiesByTile = pixelsToPaint.reduce((acc, p) => {
        const key = `${p.tx},${p.ty}`;
        if (!acc[key]) acc[key] = { colors: [], coords: [] };
        acc[key].colors.push(p.color);
        acc[key].coords.push(p.px, p.py);
        return acc;
      }, {});

      let totalPainted = 0;
      let needsRetry = false;

      for (const tileKey in bodiesByTile) {
        if (this._isCancelled()) { needsRetry = false; break; }
        const [tx, ty] = tileKey.split(",").map(Number);
        const body = { ...bodiesByTile[tileKey], t: "skip" };
        if (globalThis.__wplacer_last_fp) body.fp = globalThis.__wplacer_last_fp;
        const result = await this._executePaint(tx, ty, body);
        if (result.success) {
          totalPainted += result.painted;
        } else {
          // token refresh or temp error — let caller handle
          needsRetry = true;
          break;
        }
      }

      if (this._isCancelled()) return totalPainted;

      if (!needsRetry) {
        this._activeBurstSeedIdx = null; // next turn: pick a new seed
        return totalPainted;
      } else {
        // break and let manager refresh token
        throw new Error("REFRESH_TOKEN");
      }
    }
  }

  async buyProduct(productId, amount, variant) {
    const body = { product: { id: productId, amount } };
    if (typeof variant === "number") body.product.variant = variant;

    const response = await this.post(`https://bplace.org/purchase`, body);

    if (response.status === 200 && response.data && response.data.success === true) {
      let msg = `🛒 Purchase successful for product #${productId} (amount: ${amount})`;
      if (productId === 80) msg = `🛒 Bought ${amount * 30} pixels for ${amount * 500} droplets`;
      else if (productId === 70) msg = `🛒 Bought ${amount} Max Charge Upgrade(s) for ${amount * 500} droplets`;
      else if (productId === 100 && typeof variant === "number") msg = `🛒 Bought color #${variant}`;
      else if (productId === 110 && typeof variant === "number") msg = `🛒 Bought flag #${variant}`;
      log(this.userInfo?.id || "SYSTEM", this.userInfo?.name || "wplacer", `[${this.templateName}] ${msg}`);
      return true;
    }

    if (response.status === 403) {
      const err = new Error("FORBIDDEN_OR_INSUFFICIENT");
      err.code = 403;
      throw err;
    }

    if (response.status === 429 || (response.data?.error && response.data.error.includes("Error 1015"))) {
      throw new Error("(1015) You are being rate-limited while trying to make a purchase. Please wait.");
    }

    throw new Error(`Unexpected response during purchase: ${JSON.stringify(response)}`);
  }

  async equipFlag(flagId) {
    const id = Number(flagId) || 0;
    const url = `https://bplace.org/flag/equip/${id}`;
    const res = await this.post(url, {});
    if (res.status === 200 && res.data && res.data.success === true) {
      if (id === 0) {
        log(this.userInfo?.id || "SYSTEM", this.userInfo?.name || "wplacer", `[${this.templateName}] 🏳️ Unequipped flag`);
      } else {
        log(this.userInfo?.id || "SYSTEM", this.userInfo?.name || "wplacer", `[${this.templateName}] 🏳️ Equipped flag #${id}`);
      }
      return true;
    }
    if (res.status === 403) {
      const err = new Error("FORBIDDEN_OR_INSUFFICIENT");
      err.code = 403;
      throw err;
    }
    if (res.status === 429 || (res.data?.error && res.data.error.includes("Error 1015"))) {
      throw new Error("(1015) You are being rate-limited while trying to equip a flag. Please wait.");
    }
    throw new Error(`Unexpected response during flag equip: ${JSON.stringify(res)}`);
  }

  async pixelsLeft() {
    await this.loadTiles();
    return this._getMismatchedPixels().length;
  }

  async pixelsLeftIgnoringOwnership() {
    await this.loadTiles();
    const [startX, startY, startPx, startPy] = this.coords;
    let count = 0;
    for (let y = 0; y < this.template.height; y++) {
      for (let x = 0; x < this.template.width; x++) {
        const templateColor = this.template.data[x][y];
        if (templateColor == null) continue;
        if (templateColor === 0 && !this.paintTransparentPixels) continue;
        const globalPx = startPx + x;
        const globalPy = startPy + y;
        const targetTx = startX + Math.floor(globalPx / 1000);
        const targetTy = startY + Math.floor(globalPy / 1000);
        const localPx = globalPx % 1000;
        const localPy = globalPy % 1000;
        const tile = this.tiles.get(`${targetTx}_${targetTy}`);
        if (!tile || !tile.data[localPx]) continue;
        const tileColor = tile.data[localPx][localPy];


        const shouldPaint = this.skipPaintedPixels
          ? tileColor === 0
          : templateColor !== tileColor;

        if (shouldPaint) count++;
      }
    }
    return count;
  }

  // Counts mismatches ignoring ownership and skipPaintedPixels setting
  // - Respects transparency: skips templateColor === 0 unless paintTransparentPixels is true
  // - Does NOT check color ownership and does NOT apply skipPaintedPixels logic
  async pixelsLeftRawMismatch() {
    await this.loadTiles();
    const [startX, startY, startPx, startPy] = this.coords;
    let count = 0;
    for (let y = 0; y < this.template.height; y++) {
      for (let x = 0; x < this.template.width; x++) {
        const templateColor = this.template.data[x][y];
        if (templateColor == null) continue;
        if (templateColor === 0 && !this.paintTransparentPixels) continue;
        const globalPx = startPx + x;
        const globalPy = startPy + y;
        const targetTx = startX + Math.floor(globalPx / 1000);
        const targetTy = startY + Math.floor(globalPy / 1000);
        const localPx = globalPx % 1000;
        const localPy = globalPy % 1000;
        const tile = this.tiles.get(`${targetTx}_${targetTy}`);
        if (!tile || !tile.data[localPx]) {
          // Treat missing tile as mismatch so template doesn't finish prematurely
          count++;
          continue;
        }
        const tileColor = tile.data[localPx][localPy];
        if (templateColor !== tileColor) count++;
      }
    }
    return count;
  }

  async mismatchesSummary() {
    await this.loadTiles();
    const [startX, startY, startPx, startPy] = this.coords;
    let total = 0, basic = 0, premium = 0;
    const premiumColors = new Set();
    for (let y = 0; y < this.template.height; y++) {
      for (let x = 0; x < this.template.width; x++) {
        const templateColor = this.template.data[x][y];
        if (templateColor == null) continue;
        if (templateColor === 0 && !this.paintTransparentPixels) continue;
        const globalPx = startPx + x;
        const globalPy = startPy + y;
        const targetTx = startX + Math.floor(globalPx / 1000);
        const targetTy = startY + Math.floor(globalPy / 1000);
        const localPx = globalPx % 1000;
        const localPy = globalPy % 1000;
        const tile = this.tiles.get(`${targetTx}_${targetTy}`);
        let shouldPaint = false;
        if (!tile || !tile.data[localPx]) {
          // Missing tile -> treat as mismatch
          shouldPaint = true;
        } else {
          const tileColor = tile.data[localPx][localPy];
          shouldPaint = this.skipPaintedPixels ? (tileColor === 0) : (templateColor !== tileColor);
        }

        if (shouldPaint) {
          total++;
          // Check if color is premium using the new palette system
          if (templateColor > 0 && templateColor <= MASTER_PALETTE.length) {
            const colorRgb = MASTER_PALETTE[templateColor - 1];
            const colorKey = colorRgb.join(',');
            if (paidColors.has(colorKey)) {
              premium++; premiumColors.add(templateColor);
            } else {
              basic++;
            }
          }
        }
      }
    }
    return { total, basic, premium, premiumColors };
  }
}

// --- Data persistence ---
const loadJSON = (filename) =>
  existsSync(path.join(dataDir, filename)) ? JSON.parse(readFileSync(path.join(dataDir, filename), "utf8")) : {};
const saveJSON = (filename, data) => writeFileSync(path.join(dataDir, filename), JSON.stringify(data, null, 4));

const users = loadJSON("users.json");
const saveUsers = () => saveJSON("users.json", users);

// Active TemplateManagers (in-memory)
const templates = {};
const saveTemplates = () => {
  const templatesToSave = {};
  for (const id in templates) {
    const t = templates[id];
    templatesToSave[id] = {
      name: t.name,
      template: t.template,
      coords: t.coords,
      canBuyCharges: t.canBuyCharges,
      canBuyMaxCharges: t.canBuyMaxCharges,
      autoBuyNeededColors: !!t.autoBuyNeededColors,
      antiGriefMode: t.antiGriefMode,
      userIds: t.userIds,
      paintTransparentPixels: t.paintTransparentPixels,

      skipPaintedPixels: !!t.skipPaintedPixels,
      outlineMode: !!t.outlineMode,
      burstSeeds: t.burstSeeds || null,
      heatmapEnabled: !!t.heatmapEnabled,
      heatmapLimit: Math.max(0, Math.floor(Number(t.heatmapLimit || 10000))),
      autoStart: !!t.autoStart
    };
  }
  saveJSON("templates.json", templatesToSave);
};

// --- Settings ---
let currentSettings = {
  turnstileNotifications: false,
  accountCooldown: 20000,
  purchaseCooldown: 5000,
  keepAliveCooldown: 5000,
  dropletReserve: 0,
  antiGriefStandby: 600000,
  drawingMethod: "linear",
  chargeThreshold: 0.5,
  alwaysDrawOnCharge: false,
  maxPixelsPerPass: 0,
  seedCount: 2,
  proxyEnabled: false,
  proxyRotationMode: "sequential",
  logProxyUsage: false,
  parallelWorkers: 4,
  logCategories: {
    tokenManager: true,
    cache: true,
    queuePreview: false,
    painting: false,
    startTurn: false,
    mismatches: false,
    estimatedTime: false,
  },
  logMaskPii: false
};
if (existsSync(path.join(dataDir, "settings.json"))) {
  currentSettings = { ...currentSettings, ...loadJSON("settings.json") };
}
const saveSettings = () => saveJSON("settings.json", currentSettings);

// --- Server state ---
const activeBrowserUsers = new Set();

// Colors check job progress state
let colorsCheckJob = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: 0,
  finishedAt: 0,
  lastUserId: null,
  lastUserName: null,
  report: []
};

// Purchase color job progress state
let purchaseColorJob = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: 0,
  finishedAt: 0,
  lastUserId: null,
  lastUserName: null
};

// Flags check job progress state
let flagsCheckJob = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: 0,
  finishedAt: 0,
  lastUserId: null,
  lastUserName: null,
  report: []
};

// Purchase flag job progress state
let purchaseFlagJob = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: 0,
  finishedAt: 0,
  lastUserId: null,
  lastUserName: null
};

// Buy Max Upgrades job progress state
let buyMaxJob = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: 0,
  finishedAt: 0,
  lastUserId: null,
  lastUserName: null
};

// Buy Charges job progress state
let buyChargesJob = {
  active: false,
  total: 0,
  completed: 0,
  startedAt: 0,
  finishedAt: 0,
  lastUserId: null,
  lastUserName: null
};

const longWaiters = new Set();
const notifyTokenNeeded = () => {
  for (const fn of Array.from(longWaiters)) {
    try { fn(); } catch { }
  }
  longWaiters.clear();
};


// --- Error logging wrapper ---
function logUserError(error, id, name, context) {
  const message = error?.message || "An unknown error occurred.";

  // Handle proxy connection errors
  if (message.includes("reqwest::Error") || message.includes("hyper_util::client::legacy::Error") ||
    message.includes("Connection refused") || message.includes("timeout") ||
    message.includes("ENOTFOUND") || message.includes("ECONNREFUSED")) {
    log(id, name, `❌ Proxy connection failed - check proxy IP/port or try different proxy (or IP not whitelisted)`);
    return;
  }

  // Handle network-related errors
  if (message.includes("Network error") || message.includes("Failed to fetch") ||
    message.includes("socket hang up") || message.includes("ECONNRESET")) {
    log(id, name, `❌ Network error - check proxy IP/port or try different proxy (or IP not whitelisted)`);
    return;
  }

  // Simplify error messages for common auth issues
  if (message.includes("(401/403)") || /Unauthorized/i.test(message) || /cookies\s+are\s+invalid/i.test(message)) {
    // Log original message to avoid masking connection problems as auth issues
    log(id, name, `❌ ${message}`);
    return;
  }

  if (message.includes("(1015)") || message.includes("rate-limited")) {
    log(id, name, `❌ Rate limited (1015) - waiting before retry`);
    return;
  }

  if (message.includes("(500)") || message.includes("(502)")) {
    log(id, name, `❌ Server error (500/502) - retrying later (maybe need to relogin)`);
    return;
  }

  if (error?.name === "SuspensionError") {
    log(id, name, `🛑 Account suspended (451)`);
    return;
  }

  // For other errors, show simplified message
  const simpleMessage = message.replace(/\([^)]+\)/g, '').replace(/Error:/g, '').trim();
  log(id, name, ` ${simpleMessage}`);
}

// --- Template Manager ---
class TemplateManager {
  constructor(name, templateData, coords, canBuyCharges, canBuyMaxCharges, antiGriefMode, userIds, paintTransparentPixels = false, skipPaintedPixels = false, outlineMode = false) {
    this.name = name;
    this.template = templateData;
    this.coords = coords;
    this.canBuyCharges = !!canBuyCharges;
    this.canBuyMaxCharges = !!canBuyMaxCharges;
    this.autoBuyNeededColors = false;
    this.antiGriefMode = !!antiGriefMode;
    this.userIds = userIds;
    this.userQueue = [...userIds];
    // throttle for opportunistic resync
    this._lastResyncAt = 0;
    this._resyncCooldownMs = 3000;


    this.skipPaintedPixels = !!skipPaintedPixels;
    this.outlineMode = !!outlineMode;
    this.paintTransparentPixels = !!paintTransparentPixels; // NEW: per-template flag like old version
    this.burstSeeds = null; // persist across runs

    // Heatmap settings (per template)
    this.heatmapEnabled = false;
    this.heatmapLimit = 10000; // default limit

    this.running = false;
    this._sleepResolver = null;
    this.status = "Waiting to be started.";
    this.masterId = this.userIds[0];
    this.masterName = users[this.masterId]?.name || "Unknown";

    // visible counters (optional)
    this.totalPixels = this.template?.data ? this.template.data.flat().filter((p) => (this.paintTransparentPixels ? p >= 0 : p > 0)).length : 0;
    this.pixelsRemaining = this.totalPixels;

    // premium colors in template cache
    this.templatePremiumColors = this._computeTemplatePremiumColors();
    // approximate per-user droplets projection
    this.userProjectedDroplets = {}; // userId -> number
    this._premiumsStopLogged = false;

    // Summary throttling to avoid heavy pre-check before every turn
    this._lastSummary = null;
    this._lastSummaryAt = 0;
    this._summaryMinIntervalMs = Math.max(2 * (currentSettings.accountCooldown || 15000), 20000);
    this._lastPaintedAt = 0;
    this._lastRunnerId = null;
    this._lastSwitchAt = 0;
    this._initialScanned = false;
  }
  interruptSleep() {
    try { if (this._sleepResolver) this._sleepResolver(); } catch (_) { }
  }

  async _sleepInterruptible(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    await new Promise((resolve) => {
      this._sleepResolver = resolve;
      setTimeout(resolve, ms);
    });
    this._sleepResolver = null;
  }


  _computeTemplatePremiumColors() {
    try {
      const set = new Set();
      const t = this.template;
      if (!t?.data) return set;
      for (let x = 0; x < t.width; x++) {
        for (let y = 0; y < t.height; y++) {
          const id = t.data?.[x]?.[y] | 0;
          // Check if color ID corresponds to a paid color using the new palette
          if (id > 0 && id <= MASTER_PALETTE.length) {
            const colorRgb = MASTER_PALETTE[id - 1];
            const colorKey = colorRgb.join(',');
            if (paidColors.has(colorKey)) {
              set.add(id);
            }
          }
        }
      }
      return set;
    } catch { return new Set(); }
  }

  _hasPremium(bitmap, cid) {
    // Check if this is a valid bplace.org color ID
    if (!BPLACE_ID_TO_PALETTE_INDEX.hasOwnProperty(cid)) {
      return false;
    }

    // Free colors (1-31) are always available
    if (cid >= 1 && cid <= 31) {
      return true;
    }

    // Convert hex string to BigInt if necessary
    let bitMapBig;
    try {
      if (typeof bitmap === 'string') {
        // Handle hex strings properly - add 0x prefix only if not present
        const hexStr = bitmap.startsWith('0x') ? bitmap : '0x' + bitmap;
        bitMapBig = BigInt(hexStr);
      } else {
        bitMapBig = BigInt(bitmap || 0);
      }
    } catch (e) {
      console.error(`[DEBUG] _hasPremium BigInt conversion error:`, {
        bitmap,
        cid,
        bitmapType: typeof bitmap,
        error: e.message
      });
      return false;
    }

    // For premium colors, find the bit position
    // The bit position corresponds to the premium color index (cid - 32)
    if (cid >= 32 && cid <= 95) {
      const bit = BigInt(cid - 32);
      return (bitMapBig & (BigInt(1) << bit)) !== BigInt(0);
    }

    return false;
  }

  async _tryAutoBuyNeededColors() {
    if (!this.autoBuyNeededColors || !this.templatePremiumColors || this.templatePremiumColors.size === 0) return;

    const reserve = currentSettings.dropletReserve || 0;
    const purchaseCooldown = currentSettings.purchaseCooldown || 5000;
    const COLOR_COST = 2000; // per user note
    const dummyTemplate = { width: 0, height: 0, data: [] };
    const dummyCoords = [0, 0, 0, 0];

    // 1) gather current candidates deterministically with logging per each
    const candidates = [];
    for (const userId of this.userIds) {
      const u = users[userId]; if (!u) continue;
      if (activeBrowserUsers.has(userId)) continue;
      activeBrowserUsers.add(userId);
      const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, this.name);
      try {
        await w.login(u.cookies); await w.loadUserInfo();
        const rec = { id: userId, name: w.userInfo.name, droplets: Number(w.userInfo.droplets || 0), bitmap: w.userInfo.extraColorsBitmap || "0" };
        candidates.push(rec);
      } catch (e) {
        logUserError(e, userId, u?.name || `#${userId}`, "autobuy colors: load info");
      } finally { activeBrowserUsers.delete(userId); }
    }
    if (candidates.length === 0) return;

    // sort by current number of premium colors asc
    const premiumCount = (bitmap) => {
      let c = 0;
      let bitmapBig;
      try {
        if (typeof bitmap === 'string') {
          const hexStr = bitmap.startsWith('0x') ? bitmap : '0x' + bitmap;
          bitmapBig = BigInt(hexStr);
        } else {
          bitmapBig = BigInt(bitmap || 0);
        }
        for (let i = 0; i <= 63; i++) if ((bitmapBig & (BigInt(1) << BigInt(i))) !== BigInt(0)) c++;
        return c;
      } catch (e) {
        console.error(`[DEBUG] premiumCount BigInt conversion error:`, {
          bitmap,
          bitmapType: typeof bitmap,
          error: e.message
        });
        return 0;
      }
    };

    // 2) for each required premium color in ascending order
    const neededColors = Array.from(this.templatePremiumColors).sort((a, b) => a - b);
    let purchasedAny = false;
    const bought = [];
    for (const cid of neededColors) {
      // skip if at least one user already has color (so template can be painted with assignments)
      const someoneHas = candidates.some(c => this._hasPremium(c.bitmap, cid));
      if (someoneHas) continue;

      const ordered = candidates
        .filter(c => (c.droplets - reserve) >= COLOR_COST)
        .sort((a, b) => premiumCount(a.bitmap) - premiumCount(b.bitmap) || (a.droplets - b.droplets));

      if (ordered.length === 0) {
        const needTotal = COLOR_COST + reserve;
        log("SYSTEM", "wplacer", `[${this.name}] ⏭️ Skip auto-buy color #${cid}: insufficient droplets on all assigned accounts (need ${COLOR_COST} + ${reserve}(reserve) = ${needTotal}).`);
        continue; // no funds now → defer
      }

      // try purchase on the most "underprivileged" user
      const buyer = ordered[0];
      if (activeBrowserUsers.has(buyer.id)) continue;
      activeBrowserUsers.add(buyer.id);
      const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, this.name);
      try {
        await w.login(users[buyer.id].cookies);
        await w.loadUserInfo();
        const before = Number(w.userInfo.droplets || 0);
        if ((before - reserve) < COLOR_COST) { /* just in case */ throw new Error("insufficient_droplets"); }
        // if already has (race), skip
        if (this._hasPremium(w.userInfo.extraColorsBitmap || "0", cid)) {
          log(buyer.id, w.userInfo.name, `[${this.name}] ⏭️ Skip auto-buy color #${cid}: account already owns this color.`);
          continue;
        }
        log(buyer.id, w.userInfo.name, `[${this.name}] 💰 Attempting to auto-buy premium color #${cid}. Cost 2000, droplets before: ${before}, reserve: ${reserve}.`);
        await w.buyProduct(100, 1, cid);
        await sleep(purchaseCooldown);
        await w.loadUserInfo().catch(() => { });
        log(buyer.id, w.userInfo.name, `[${this.name}] 🛒 Auto-bought premium color #${cid}. Droplets ${before} → ${w.userInfo?.droplets}`);
        // reflect in candidates for subsequent colors
        buyer.bitmap = w.userInfo.extraColorsBitmap || buyer.bitmap;
        buyer.droplets = Number(w.userInfo?.droplets || (before - COLOR_COST));
        purchasedAny = true;
        bought.push(cid);
      } catch (e) {
        logUserError(e, buyer.id, users[buyer.id].name, `auto-purchase color #${cid}`);
      } finally {
        activeBrowserUsers.delete(buyer.id);
      }
    }
    return { purchased: purchasedAny, bought };
  }

  async handleUpgrades(wplacer) {
    await wplacer.loadUserInfo();

    // 1) Buy Max Charge Upgrades if enabled
    if (this.canBuyMaxCharges) {
      const affordableDroplets = wplacer.userInfo.droplets - currentSettings.dropletReserve;
      const amountToBuy = Math.floor(affordableDroplets / 500);
      if (amountToBuy > 0) {
        log(wplacer.userInfo.id, wplacer.userInfo.name, `💰 Attempting to buy ${amountToBuy} max charge upgrade(s).`);
        try {
          await wplacer.buyProduct(70, amountToBuy);
          await sleep(currentSettings.purchaseCooldown);
          await wplacer.loadUserInfo();
        } catch (error) {
          logUserError(error, wplacer.userInfo.id, wplacer.userInfo.name, "purchase max charge upgrades");
        }
      }
    }

    // 2) Buy Pixel Charges (500) if enabled and affordable
    if (this.canBuyCharges) {
      try {
        const reserve = Number(currentSettings.dropletReserve || 0);
        const droplets = Math.max(0, Number(wplacer?.userInfo?.droplets || 0));
        const affordableDroplets = Math.max(0, droplets - reserve);
        if (affordableDroplets >= 500) {
          const packs = Math.floor(affordableDroplets / 500);
          const target = Math.min(Math.ceil(Math.max(0, this.pixelsRemaining | 0) / 30), packs);
          if (target > 0) {
            log(wplacer.userInfo.id, wplacer.userInfo.name, `💰 Attempting to buy pixel charges (${target}×500) before painting...`);
            await wplacer.buyProduct(80, target);
            await sleep(currentSettings.purchaseCooldown || 0);
            try { await wplacer.loadUserInfo(); } catch (_) { }
          }
        }
      } catch (error) {
        logUserError(error, wplacer.userInfo.id, wplacer.userInfo.name, "purchase pixel charges");
      }
    }
  }

  async _performPaintTurn(wplacer) {
    while (this.running) {
      try {
        // No token needed for new bplace.org - only CF-Clearance and JWT
        wplacer.token = null;
        wplacer.pawtect = null;

        const painted = await wplacer.paint(currentSettings.drawingMethod);
        if(typeof painted === 'number' && painted > 0)
        {
          log(wplacer.userInfo.id, wplacer.userInfo.name, `[${this.name}] ⏰ Estimated time left: ~${this.formatTime((this.pixelsRemaining - painted) / this.userIds.length * 30)}`); //30 seconds for 1 pixel
        }
        // save back burst seeds if used
        this.burstSeeds = wplacer._burstSeeds ? wplacer._burstSeeds.map((s) => ({ gx: s.gx, gy: s.gy })) : null;
        saveTemplates();
        return painted;
      } catch (error) {
        if (error.name === "SuspensionError") {
          const suspendedUntilDate = new Date(error.suspendedUntil).toLocaleString();
          const uid = wplacer.userInfo.id;
          const uname = wplacer.userInfo.name;
          // mark user suspended
          users[uid].suspendedUntil = error.suspendedUntil;
          saveUsers();
          // remove from drawing participants for this template (normalize id types)
          const uidStr = String(uid);
          this.userIds = (this.userIds || []).filter((id) => String(id) !== uidStr);
          this.userQueue = (this.userQueue || []).filter((id) => String(id) !== uidStr);
          try { saveTemplates(); } catch (_) { }
          // log informative message in English
          log(uid, uname, `[${this.name}] 🛑 Account suspended until ${suspendedUntilDate}. Removed from the template list.`);
          return; // end this user's turn
        }
        if (error.message === "REFRESH_TOKEN") {
          log(wplacer.userInfo.id, wplacer.userInfo.name, `[${this.name}] 🔄 Token expired/invalid. Retrying...`);
          await sleep(1000);
          continue;
        }
        // Delegate all errors to unified logger to keep original reason
        logUserError(error, wplacer.userInfo.id, wplacer.userInfo.name, `[${this.name}] paint turn`);
        return 0;
      }
    }
  }

  //Used for time estimation, converting seconds value to more readable format
  formatTime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    let parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    if (m > 0) parts.push(m + "m");
    if (s > 0 || parts.length === 0) parts.push(s + "s");

    return parts.join(" ");
  }

  async start() {
    this.running = true;
    this.status = "Started.";
    log("SYSTEM", "wplacer", `▶️ Starting template "${this.name}"...`);

    try {

      if (!this._initialScanned) {
        const cooldown = Math.max(0, Number(currentSettings.accountCheckCooldown || 0));
        const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
        if (useParallel) {
          const candidates = this.userIds.filter(uid => {
            const rec = users[uid];
            if (!rec) return false;
            if (rec.suspendedUntil && Date.now() < rec.suspendedUntil) return false;
            if (activeBrowserUsers.has(uid)) return false;
            return true;
          });
          const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
          const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
          log("SYSTEM", "wplacer", `[${this.name}] 🔍 Initial scan (parallel): ${candidates.length} accounts (concurrency=${concurrency}, proxies=${loadedProxies.length}).`);
          let index = 0;
          const worker = async () => {
            for (; ;) {
              if (!this.running) break;
              const myIndex = index++;
              if (myIndex >= candidates.length) break;
              const uid = candidates[myIndex];
              const rec = users[uid];
              if (!rec) continue;
              if (activeBrowserUsers.has(uid)) continue;
              activeBrowserUsers.add(uid);
              const w = new WPlacer(this.template, this.coords, currentSettings, this.name, this.paintTransparentPixels, this.burstSeeds);
              try {
                await w.login(rec.cookies); await w.loadUserInfo();
                const cnt = Math.floor(Number(w.userInfo?.charges?.count || 0));
                const mx = Math.floor(Number(w.userInfo?.charges?.max || 0));
                log(w.userInfo.id, w.userInfo.name, `[${this.name}] 🔁 Cache update: charges ${cnt}/${mx}`);
              }
              catch (e) { logUserError(e, uid, rec?.name || `#${uid}`, "initial user scan"); }
              finally { activeBrowserUsers.delete(uid); }
              if (!this.running) break;
              if (cooldown > 0) await this._sleepInterruptible(cooldown);
            }
          };
          await Promise.all(Array.from({ length: concurrency }, () => worker()));
          log("SYSTEM", "wplacer", `[${this.name}] ✅ Initial scan finished (parallel).`);
        } else {
          log("SYSTEM", "wplacer", `[${this.name}] 🔍 Initial scan: starting (${this.userIds.length} accounts). Cooldown=${cooldown}ms`);
          for (const uid of this.userIds) {
            if (!this.running) break;
            const rec = users[uid]; if (!rec) continue;
            if (rec.suspendedUntil && Date.now() < rec.suspendedUntil) continue;
            if (activeBrowserUsers.has(uid)) continue;
            activeBrowserUsers.add(uid);
            const w = new WPlacer(this.template, this.coords, currentSettings, this.name, this.paintTransparentPixels, this.burstSeeds, this.skipPaintedPixels, this.outlineMode);
            try {
              await w.login(rec.cookies); await w.loadUserInfo();
              const cnt = Math.floor(Number(w.userInfo?.charges?.count || 0));
              const mx = Math.floor(Number(w.userInfo?.charges?.max || 0));
              log(w.userInfo.id, w.userInfo.name, `[${this.name}] 🔁 Cache update: charges ${cnt}/${mx}`);
            }
            catch (e) { logUserError(e, uid, rec?.name || `#${uid}`, "initial user scan"); }
            finally { activeBrowserUsers.delete(uid); }
            if (!this.running) break;
            if (cooldown > 0) await this._sleepInterruptible(cooldown);
          }
          log("SYSTEM", "wplacer", `[${this.name}] ✅ Initial scan finished.`);
        }
        this._initialScanned = true;
      }

      while (this.running) {
        // Throttled check of remaining pixels using the master account
        let summaryForTurn = null;
        const needFreshSummary = !this._lastSummary || (Date.now() - this._lastSummaryAt) >= this._summaryMinIntervalMs;
        if (needFreshSummary) {
          const checkWplacer = new WPlacer(this.template, this.coords, currentSettings, this.name, this.paintTransparentPixels, this.burstSeeds, this.skipPaintedPixels, this.outlineMode);
          try {
            await checkWplacer.login(users[this.masterId].cookies);
            const summary = await checkWplacer.mismatchesSummary();
            summaryForTurn = summary;
            this._lastSummary = summary;
            this._lastSummaryAt = Date.now();
            this.pixelsRemaining = summary.total;
            // Initialize and persist shared burst seeds once per template for burst-family modes
            try {
              const burstFamily = new Set(["burst", "colors-burst-rare", "outline-then-burst", "burst-mixed"]);
              if (burstFamily.has(currentSettings.drawingMethod)) {
                const desired = Math.max(1, Math.min(Number(currentSettings?.seedCount ?? 2), 16));
                if (!this.burstSeeds || this.burstSeeds.length !== desired) {
                  const mm = checkWplacer._getMismatchedPixels();
                  if (Array.isArray(mm) && mm.length > 0) {
                    this.burstSeeds = checkWplacer._pickBurstSeeds(mm, desired);
                    saveTemplates();
                  }
                }
              }
            } catch (_) { }
            if (this.autoBuyNeededColors) {
              if (summary.total === 0) {
                // nothing to do
              } else if (summary.basic === 0 && summary.premium > 0) {
                // only premium remain — check funds and stop if none can buy
                // first, try auto-buy immediately to avoid false stop
                let autoRes = { purchased: false, bought: [] };
                try { autoRes = await this._tryAutoBuyNeededColors() || autoRes; } catch (_) { }

                // re-evaluate ability to buy / own after purchases
                const reserve = currentSettings.dropletReserve || 0;
                const dummyTemplate = { width: 0, height: 0, data: [] };
                const dummyCoords = [0, 0, 0, 0];
                let anyCanBuy = false;
                let anyOwnsRemaining = false;
                for (const uid of this.userIds) {
                  if (activeBrowserUsers.has(uid)) continue;
                  activeBrowserUsers.add(uid);
                  const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, this.name);
                  try {
                    await w.login(users[uid].cookies);
                    await w.loadUserInfo();
                    if ((Number(w.userInfo.droplets || 0) - reserve) >= 2000) { anyCanBuy = true; }
                    const bitmap = w.userInfo.extraColorsBitmap || "0";
                    for (const cid of Array.from(summary.premiumColors)) {
                      if (this._hasPremium(bitmap, cid)) { anyOwnsRemaining = true; break; }
                    }
                  }
                  catch { } finally { activeBrowserUsers.delete(uid); }
                  if (anyCanBuy) break;
                }
                if (anyOwnsRemaining) {
                  log("SYSTEM", "wplacer", `[${this.name}] ℹ️ Only premium pixels remain, but some are already owned. Proceeding to paint owned premium while waiting for funds to buy others.`);
                } else if (!anyCanBuy) {
                  const list = Array.from(summary.premiumColors).sort((a, b) => a - b).join(', ');
                  const reserve2 = currentSettings.dropletReserve || 0;
                  const needTotal = 2000 + reserve2;
                  log("SYSTEM", "wplacer", `[${this.name}] ⛔ Template stopped: Only premium pixels remain (${summary.premium} px, colors: ${list}), and none of assigned accounts have enough droplets to purchase (need 2000 + ${reserve2}(reserve) = ${needTotal}).`);
                  this.status = "Finished.";
                  this.running = false;
                  break;
                }
                if (autoRes.purchased) {
                  this.pixelsRemaining = Math.max(1, summary.premium);
                } else {
                  this.pixelsRemaining = summary.premium;
                }
              }
            }
          } catch (error) {
            logUserError(error, this.masterId, this.masterName, "check pixels left");
            await this._sleepInterruptible(60000);
            continue;
          }
        } else {
          summaryForTurn = this._lastSummary;
          this.pixelsRemaining = summaryForTurn?.total ?? this.pixelsRemaining;
        }

        if (this.pixelsRemaining === 0) {
          // Special log: when only premium pixels remain and no funds to auto-buy
          if (this.autoBuyNeededColors && this.templatePremiumColors && this.templatePremiumColors.size > 0) {
            const hasAnyBasic = (() => {
              try {
                const t = this.template;
                for (let x = 0; x < t.width; x++) {
                  for (let y = 0; y < t.height; y++) {
                    const id = t.data?.[x]?.[y] | 0; if (id > 0 && id < 32) return true;
                  }
                }
              } catch { }
              return false;
            })();
            if (!hasAnyBasic) {
              const reserve = currentSettings.dropletReserve || 0;
              const dummyTemplate = { width: 0, height: 0, data: [] };
              const dummyCoords = [0, 0, 0, 0];
              let anyCanBuy = false;
              for (const uid of this.userIds) {
                if (activeBrowserUsers.has(uid)) continue;
                activeBrowserUsers.add(uid);
                const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, this.name);
                try { await w.login(users[uid].cookies); await w.loadUserInfo(); if ((Number(w.userInfo.droplets || 0) - reserve) >= 2000) { anyCanBuy = true; } }
                catch { } finally { activeBrowserUsers.delete(uid); }
                if (anyCanBuy) break;
              }
              if (!anyCanBuy) {
                log("SYSTEM", "wplacer", `[${this.name}] ⛔ Stopping: Only premium pixels remain and none of assigned accounts have enough droplets to purchase required colors.`);
              }
            }
          }
          if (this.antiGriefMode) {
            this.status = "Monitoring for changes.";
            log("SYSTEM", "wplacer", `[${this.name}] 🖼 Template complete. Monitoring... Next check in ${currentSettings.antiGriefStandby / 60000} min.`);
            await this._sleepInterruptible(currentSettings.antiGriefStandby);
            continue;
          } else {
            log("SYSTEM", "wplacer", `[${this.name}] 🖼 Template finished!`);
            this.status = "Finished.";
            this.running = false;
            break;
          }
        }

        if (this.userQueue.length === 0) this.userQueue = [...this.userIds];

        let resyncScheduled = false;
        const nowSel = Date.now();
        let bestUserId = null;
        let bestPredicted = null;
        let msWaitUntilNextUser = null; // Sei - smarter waiting

        const candidates = this.userIds
          .filter((uid) => {
            const rec = users[uid];
            if (!rec) return false;
            if (rec.suspendedUntil && nowSel < rec.suspendedUntil) return false;
            if (rec.authFailureUntil && nowSel < rec.authFailureUntil) return false;
            if (activeBrowserUsers.has(uid)) return false;
            return true;
          })
          .map((uid) => ({ uid, pred: ChargeCache.predict(uid, nowSel) }))
          .map((o) => ({ uid: o.uid, count: Math.floor(o.pred?.count || 0), max: Math.floor(o.pred?.max || 0) }))
          .sort((a, b) => b.count - a.count || b.max - a.max);

        if (candidates.length) {
          const top = candidates.slice(0, Math.min(3, candidates.length)).map(c => `#${c.uid} (${c.count}/${c.max})`).join(', ');
          log("SYSTEM", "wplacer", `[${this.name}] 📊 Queue preview (top): ${top}`);
        } else {
          log("SYSTEM", "wplacer", `[${this.name}] 📊 Queue preview: empty candidates.`);
        }

        for (const { uid: userId } of candidates) {
          const rec = users[userId];
          if (!rec) continue;
          if (rec.suspendedUntil && nowSel < rec.suspendedUntil) continue;
          if (rec.authFailureUntil && nowSel < rec.authFailureUntil) continue;
          if (activeBrowserUsers.has(userId)) continue;

          if (!resyncScheduled && ChargeCache.stale(userId, nowSel) && (nowSel - this._lastResyncAt) >= this._resyncCooldownMs) {
            resyncScheduled = true;
            this._lastResyncAt = nowSel;
            activeBrowserUsers.add(userId);
            const w = new WPlacer(this.template, this.coords, currentSettings, this.name);
            log(userId, rec.name, `[${this.name}] 🔄 Background resync started.`);
            w.login(rec.cookies)
              .then(() => { try { log(userId, rec.name, `[${this.name}] ✅ Background resync finished.`); } catch { } })
              .catch((e) => { logUserError(e, userId, rec.name, "opportunistic resync"); try { log(userId, rec.name, `[${this.name}] ❌ Background resync finished (error). Try to re-add the account.`); } catch { } })
              .finally(() => activeBrowserUsers.delete(userId));
          }

          const p = ChargeCache.predict(userId, nowSel);
          if (!p) continue;
          const threshold = currentSettings.alwaysDrawOnCharge ? 1 : Math.max(1, Math.floor(p.max * currentSettings.chargeThreshold));
          if (Math.floor(p.count) >= threshold) {
            if (!bestPredicted || Math.floor(p.count) > Math.floor(bestPredicted.count)) {
              bestPredicted = p; bestUserId = userId;
            }
          }

          // Sei - if no users are ready, determine the minimum time we need to wait before checking again.
          else {
            const needBeforeReady = Math.floor(p.max * currentSettings.chargeThreshold);
            if (msWaitUntilNextUser == null || msWaitUntilNextUser.timeToReady > Math.floor(needBeforeReady - p.count) * 30_000) {
              msWaitUntilNextUser = {
                'name': rec.name,
                'timeToReady': Math.floor(needBeforeReady - p.count) * 30_000
              };
            }
          }
        }

        const foundUserForTurn = bestUserId;

        if (foundUserForTurn) {
          if (activeBrowserUsers.has(foundUserForTurn)) {
            await sleep(500);
            continue;
          }

          const nowRun = Date.now();
          if (this._lastRunnerId && this._lastRunnerId !== foundUserForTurn) {
            const passed = nowRun - this._lastSwitchAt;
            const ac = currentSettings.accountCooldown || 0;
            if (passed < ac) {
              const remain = ac - passed;
              log("SYSTEM", "wplacer", `[${this.name}] ⏱️ Switching account cooldown: waiting ${duration(remain)}.`);
              await this._sleepInterruptible(remain);
            }
          }
          // Update _lastSwitchAt when switching accounts or on first run
          if (this._lastRunnerId !== foundUserForTurn) {
            this._lastSwitchAt = Date.now();
          }
          activeBrowserUsers.add(foundUserForTurn);
          const wplacer = new WPlacer(this.template, this.coords, currentSettings, this.name, this.paintTransparentPixels, this.burstSeeds, this.skipPaintedPixels, this.outlineMode);
          // Wire cancellation: allow WPlacer to see when manager was stopped
          try { wplacer.shouldStop = () => !this.running; } catch (_) { }
          try {
            const { id, name } = await wplacer.login(users[foundUserForTurn].cookies);
            // Clear auth failure flag on successful login
            if (users[foundUserForTurn].authFailureUntil) {
              delete users[foundUserForTurn].authFailureUntil;
              saveUsers();
            }
            this.status = `Running user ${name}#${id}`;

            await this.handleUpgrades(wplacer);

            const pred = ChargeCache.predict(foundUserForTurn, Date.now());
            if (pred) log(id, name, `[${this.name}] ▶️ Start turn with predicted ${Math.floor(pred.count)}/${pred.max} charges.`);
            const paintedNow = await this._performPaintTurn(wplacer);
            if (typeof paintedNow === 'number' && paintedNow > 0) {
              try { ChargeCache.consume(foundUserForTurn, paintedNow); } catch { }
              this._lastPaintedAt = Date.now();
              if (this._lastSummary) {
                this._lastSummary.total = Math.max(0, (this._lastSummary.total | 0) - paintedNow);
              }
            }
            else {
              try {
                log(id, name, `[${this.name}] ℹ️ Nothing painted. Skipping this turn and retrying soon.`);
              } catch (_) { }
              await this._sleepInterruptible(5000);
            }
            // cache any new seeds
            this.burstSeeds = wplacer._burstSeeds ? wplacer._burstSeeds.map((s) => ({ gx: s.gx, gy: s.gy })) : this.burstSeeds;
            saveTemplates();
            //await this.handleUpgrades(wplacer);
          } catch (error) {
            // Handle authentication errors gracefully
            if (error.message && (error.message.includes("Authentication failed (401)") || error.message.includes("Authentication expired"))) {
              const userName = users[foundUserForTurn]?.name || `#${foundUserForTurn}`;
              log(foundUserForTurn, userName, `[${this.name}] ❌ Authentication failed (401) - skipping user temporarily`);
              
              // Temporarily exclude user from queue for 5 minutes to avoid repeated auth failures
              if (!users[foundUserForTurn].authFailureUntil) {
                users[foundUserForTurn].authFailureUntil = Date.now() + (5 * 60 * 1000); // 5 minutes
                saveUsers();
              }
            } else {
              logUserError(error, foundUserForTurn, users[foundUserForTurn]?.name || `#${foundUserForTurn}`, "perform paint turn");
            }
          } finally {
            activeBrowserUsers.delete(foundUserForTurn);
          }

          if (this._lastRunnerId !== foundUserForTurn) {
            this._lastRunnerId = foundUserForTurn;
            this._lastSwitchAt = Date.now();
          }
        } else {

          try { if (this.autoBuyNeededColors) { await this._tryAutoBuyNeededColors(); } } catch { }

          // Buy charges if allowed (master only)
          if (this.canBuyCharges && !activeBrowserUsers.has(this.masterId)) {
            activeBrowserUsers.add(this.masterId);
            const chargeBuyer = new WPlacer(this.template, this.coords, currentSettings, this.name, this.paintTransparentPixels, this.burstSeeds, this.skipPaintedPixels, this.outlineMode);
            try {
              await chargeBuyer.login(users[this.masterId].cookies);
              const affordableDroplets = chargeBuyer.userInfo.droplets - currentSettings.dropletReserve;
              if (affordableDroplets >= 500) {
                const amountToBuy = Math.min(Math.ceil(this.pixelsRemaining / 30), Math.floor(affordableDroplets / 500));
                if (amountToBuy > 0) {
                  log(this.masterId, this.masterName, `[${this.name}] 💰 Attempting to buy pixel charges...`);
                  await chargeBuyer.buyProduct(80, amountToBuy);
                  await sleep(currentSettings.purchaseCooldown);
                }
              }
            } catch (error) {
              logUserError(error, this.masterId, this.masterName, "attempt to buy pixel charges");
            } finally { activeBrowserUsers.delete(this.masterId); }
          }


          const now2 = Date.now();
          const waits = this.userQueue.map((uid) => {
            const p = ChargeCache.predict(uid, now2);
            if (!p) return 15_000;
            const threshold = currentSettings.alwaysDrawOnCharge ? 1 : Math.max(1, Math.floor(p.max * currentSettings.chargeThreshold));
            const deficit = Math.max(0, threshold - Math.floor(p.count));
            return deficit * (p.cooldownMs || 30_000);
          });

          // Sei - Instead of refreshing every 30 seconds, why don't we only refresh when we need to???
          let waitTime = msWaitUntilNextUser?.timeToReady ?? 10_000;
          // If "Always draw when at least one charge is available" is enabled,
          // do not wait the full predicted time. Recheck within 60s so at least ~2 pixels can restore.
          if (currentSettings.alwaysDrawOnCharge) {
            waitTime = Math.min(waitTime, 60_000);
          }
          //let waitTime = (waits.length ? Math.min(...waits) : 10_000) + 800;
          //const maxWait = Math.max(10_000, Math.floor((currentSettings.accountCooldown || 15000) * 1.5));
          //waitTime = Math.min(waitTime, maxWait);
          this.status = `Waiting for charges.`;
          const nextUserName = msWaitUntilNextUser?.name || 'unknown';
          log("SYSTEM", "wplacer", `[${this.name}] ⏳ No users ready. Waiting for next available user (${nextUserName}): ${duration(waitTime)}.`);
          await this._sleepInterruptible(waitTime);
        }
      }
    } finally {
      if (this.status !== "Finished.") {
        this.status = "Stopped.";
      }
    }
  }
}

// --- Express App ---
const app = express();
app.use(cors());
app.use(express.static("public"));
app.use('/data', express.static('data'));
app.use(express.json({ limit: Infinity }));

// Global error handler for JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('[Express] JSON Parse Error:', err.message);
    console.error('[Express] Request URL:', req.method, req.originalUrl);
    return res.status(400).json({
      error: 'Invalid JSON in request body',
      details: err.message
    });
  }
  next();
});

// SSE endpoint for live logs of current session
app.get("/logs/stream", (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(':ok\n\n');
    try {
      // send backlog first
      const snapshot = recentLogs.slice(-1000);
      for (const item of snapshot) {
        res.write(`data: ${JSON.stringify(item)}\n\n`);
      }
    } catch (_) { }
    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
  } catch (_) { try { res.end(); } catch { } }
});

// Global express error handler (keeps server alive and logs)
app.use((err, req, res, next) => {
  try {
    console.error("[Express] error:", err?.message || err);
    appendFileSync(path.join(dataDir, `errors.log`), `[${new Date().toLocaleString()}] (Express) ${err?.stack || err}\n`);
  } catch (_) { }
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});


// Global storage for manual cookies
let manualCookies = {
  j: null,
  cf_clearance: null
};

// Auto cf token retrieval settings
let autoTokenSettings = {
  enabled: true,
  lastAttempt: 0,
  retryDelay: 5 * 60 * 1000, // 5 minutes between attempts
  isRetrying: false
};

// Function to check if cf_clearance token is valid
async function isCfTokenValid(cfToken) {
  if (!cfToken) return false;

  try {
    const testUrl = 'https://bplace.org/me';
    const response = await fetch(testUrl, {
      headers: {
        'Cookie': `cf_clearance=${cfToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
      }
    });

    // If we get a 403, 502 or 503 or challenge page, token is likely invalid
    if (response.status === 403 || response.status === 502 || response.status === 503) {
      return false;
    }

    return response.ok;
  } catch (error) {
    console.log('🔍 cf_clearance validation failed:', error.message);
    return false;
  }
}

// Function to automatically get cf_clearance token when needed
async function autoGetCfTokenIfNeeded() {
  // Skip if auto token is disabled or already in progress
  if (!autoTokenSettings.enabled || autoTokenSettings.isRetrying) {
    return null;
  }

  // Check if enough time has passed since last attempt
  const now = Date.now();
  if (now - autoTokenSettings.lastAttempt < autoTokenSettings.retryDelay) {
    return null;
  }

  console.log('🤖 Checking if cf_clearance token auto-retrieval is needed...');

  // Check if current token is valid
  const currentToken = manualCookies.cf_clearance || manualCookies.s;
  if (currentToken) {
    const isValid = await isCfTokenValid(currentToken);
    if (isValid) {
      console.log('✅ Current cf_clearance token is still valid');
      return currentToken;
    }
    console.log('❌ Current cf_clearance token is invalid, attempting auto-retrieval...');
  } else {
    console.log('🔍 No cf_clearance token found, attempting auto-retrieval...');
  }

  autoTokenSettings.isRetrying = true;
  autoTokenSettings.lastAttempt = now;

  try {
    const newToken = await getCloudflareToken();
    if (newToken) {
      console.log('✅ Successfully auto-retrieved cf_clearance token');
      autoTokenSettings.isRetrying = false;

      // Interrupt all running template managers to immediately retry with new token
      try {
        let interruptedCount = 0;
        for (const templateId in templates) {
          const manager = templates[templateId];
          if (manager && manager.running && typeof manager.interruptSleep === 'function') {
            manager.interruptSleep();
            interruptedCount++;
          }
        }
        if (interruptedCount > 0) {
          console.log(`🔄 Interrupted ${interruptedCount} running template(s) to retry with new cf_clearance token`);
        }
      } catch (error) {
        console.log('⚠️ Error interrupting templates:', error.message);
      }

      // Notify browser extension about token update
      try {
        // Find any bplace.org tabs and send a refresh notification
        // This will help the extension know to update its cookies
        console.log('📢 Notifying browser extension about token update...');
      } catch (error) {
        console.log('⚠️ Could not notify browser extension:', error.message);
      }

      return newToken;
    } else {
      console.log('❌ Failed to auto-retrieve cf_clearance token');
    }
  } catch (error) {
    console.error('❌ Error in auto cf token retrieval:', error.message);
  }

  autoTokenSettings.isRetrying = false;
  return null;
}

// Centralized function to auto-get token and interrupt running templates
async function autoGetCfTokenAndInterruptQueues() {
  const newToken = await autoGetCfTokenIfNeeded();

  if (newToken) {
    // Token was updated, clear charge cache and interrupt all running template managers
    try {
      // Clear charge cache to force fresh user status checks
      ChargeCache.clearAll();
      console.log('🗑️ Cleared charge cache due to cf_clearance token update');

      // Interrupt all running template managers to immediately retry
      let interruptedCount = 0;
      for (const templateId in templates) {
        const manager = templates[templateId];
        if (manager && manager.running && typeof manager.interruptSleep === 'function') {
          manager.interruptSleep();
          interruptedCount++;
        }
      }
      if (interruptedCount > 0) {
        console.log(`🔄 Interrupted ${interruptedCount} running template(s) due to token update`);
      }
    } catch (error) {
      console.log('⚠️ Error interrupting templates:', error.message);
    }
  }

  return newToken;
}

// Periodic check for token validity (every 10 minutes)
setInterval(async () => {
  if (!autoTokenSettings.enabled) {
    console.log('🕐 [PERIODIC] Auto mode disabled, skipping token check');
    return;
  }

  console.log('🕐 [PERIODIC] Checking cf_clearance token validity...');

  // Очищаем устаревшие токены из CF-Clearance-Manager
  try {
    cfClearanceManager.cleanupExpiredTokens();
  } catch (error) {
    console.log(`❌ [PERIODIC] Error cleaning CF-Clearance cache: ${error.message}`);
  }

  const currentToken = manualCookies.cf_clearance || manualCookies.s;
  if (currentToken) {
    const isValid = await isCfTokenValid(currentToken);
    if (!isValid) {
      console.log('🕐 [PERIODIC] cf_clearance token expired, attempting auto-refresh...');
      await autoGetCfTokenAndInterruptQueues();
    } else {
      console.log('🕐 [PERIODIC] cf_clearance token is still valid');
    }
  } else {
    console.log('🕐 [PERIODIC] No cf_clearance token found, attempting auto-retrieval...');
    await autoGetCfTokenAndInterruptQueues();
  }
}, 10 * 60 * 1000); // 10 minutes

// Log auto token settings on startup
console.log('🤖 Auto cf_clearance token retrieval initialized:');
console.log(`  - Enabled: ${autoTokenSettings.enabled}`);
console.log(`  - Retry delay: ${autoTokenSettings.retryDelay / 1000}s`);
console.log(`  - Periodic check: every 10 minutes`);




// CF-Clearance token retrieval using only CF-Clearance-Scraper
async function getCloudflareToken() {
  console.log('🔄 Starting cf_clearance token retrieval with CF-Clearance-Scraper...');

  try {
    // Use CF-Clearance Manager for token retrieval
    const clearanceData = await cfClearanceManager.getClearance(null, null, 'https://bplace.org');

    if (clearanceData && clearanceData.cf_clearance) {
      console.log('✅ CF-Clearance token retrieved successfully!');
      manualCookies.cf_clearance = clearanceData.cf_clearance;
      return clearanceData.cf_clearance;
    } else {
      console.log('⚠️ No CF-Clearance token obtained (likely no Cloudflare challenge detected)');
      return null;
    }
  } catch (error) {
    // Check if error is due to "No Cloudflare challenge detected"
    if (error.message && error.message.includes('No Cloudflare challenge')) {
      console.log('ℹ️ No Cloudflare challenge present, token not needed');
      return null;
    }
    console.error('❌ Error in CF-Clearance token retrieval:', error.message);
    return null;
  }
}

// Manual cookie input web interface
app.get("/manual-cookies", (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>bplacer - Manual Cookie Input</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a1a; color: #fff; }
        .container { max-width: 800px; margin: 0 auto; }
        .form-group { margin: 20px 0; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input, textarea { width: 100%; padding: 10px; margin-bottom: 10px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; }
        button { background: #007bff; color: white; padding: 12px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
        button:hover { background: #0056b3; }
        .status { padding: 10px; margin: 10px 0; border-radius: 4px; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .current-cookies { background: #333; padding: 15px; border-radius: 4px; margin: 20px 0; }
        .cookie-value { font-family: monospace; background: #222; padding: 5px; border-radius: 3px; word-break: break-all; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 bplacer - Manual Cookie Input</h1>
        <p>Введите куки с сайта bplace.org вручную для обхода проблем с расширением:</p>

        <div class="current-cookies">
            <h3>Текущие куки:</h3>
            <p><strong>j:</strong> <span class="cookie-value">${manualCookies.j || 'не установлен'}</span></p>
            <p><strong>cf_clearance:</strong> <span class="cookie-value">${manualCookies.cf_clearance || 'не установлен'}</span></p>
            <p><strong>Автоматическое получение cf_clearance:</strong> <span class="cookie-value">${autoTokenSettings.enabled ? '✅ включено' : '❌ отключено'}</span></p>
            ${autoTokenSettings.isRetrying ? '<p style="color: orange;">🔄 Получение токена в процессе...</p>' : ''}
        </div>

        <form id="cookieForm">
            <div class="form-group">
                <label for="j">JWT Token (j):</label>
                <textarea id="j" name="j" rows="3" placeholder="eyJhbGciOiJIUzI1NiJ9...">${manualCookies.j || ''}</textarea>
            </div>

            <div class="form-group">
                <label for="cf_clearance">Cloudflare Clearance (cf_clearance):</label>
                <textarea id="cf_clearance" name="cf_clearance" rows="3" placeholder="XRD6.M_2rqolWSf778p...">${manualCookies.cf_clearance || ''}</textarea>
            </div>

            <button type="submit">Сохранить куки</button>
        </form>

        <div style="margin: 20px 0;">
            <button id="autoSetup" style="background: #dc3545; color: white; padding: 12px 25px; border: none; border-radius: 5px; cursor: pointer; margin-right: 10px; font-weight: bold;">
                🚀 АВТОМАТИЧЕСКАЯ УСТАНОВКА CloudFreed
            </button>
            <button id="autoGetToken" style="background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin-right: 10px;">
                🤖 Автоматически получить cf_clearance (CF-Scraper + CloudFreed)
            </button>
            <button id="toggleAutoMode" style="background: ${autoTokenSettings.enabled ? '#dc3545' : '#28a745'}; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin-right: 10px;">
                ${autoTokenSettings.enabled ? '⏹️ Отключить автоматический режим' : '▶️ Включить автоматический режим'}
            </button>
            <button id="forceTokenRefresh" style="background: #ffc107; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin-right: 10px;">
                🔄 Принудительно обновить cf_clearance
            </button>
            <button onclick="window.open('chrome://extensions/', '_blank')" style="background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin-right: 10px;">
                🔧 Открыть chrome://extensions/
            </button>
            <button id="installCfScraper" style="background: #6f42c1; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
                🐍 Установить CF-Clearance-Scraper
            </button>
            <p style="font-size: 14px; color: #666; margin-top: 10px;">
                🚀 <strong>КРАСНАЯ кнопка</strong> - полностью автоматическая установка CloudFreed и открытие всех нужных страниц<br>
                🤖 <strong>ЗЕЛЕНАЯ кнопка</strong> - получить cf_clearance токен (использует CF-Clearance-Scraper + CloudFreed fallback)<br>
                🔧 <strong>СИНЯЯ кнопка</strong> - открыть chrome://extensions/ вручную<br>
                ⚙️ <strong>Автоматический режим</strong> - автоматически проверяет и обновляет cf_clearance токен каждые 10 минут
            </p>
        </div>

        <div id="status"></div>

        <!-- CF-Clearance Management Section -->
        <div style="background: #2d3748; padding: 20px; border-radius: 8px; margin: 20px 0; border: 2px solid #4a5568;">
            <h3 style="color: #63b3ed; margin-top: 0;">🔐 CF-Clearance Token Management</h3>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 15px 0;">
                <div style="background: #1a202c; padding: 15px; border-radius: 6px;">
                    <h4 style="color: #68d391; margin-top: 0;">📊 Статистика токенов</h4>
                    <div id="cf-stats">
                        <p>Загрузка...</p>
                    </div>
                </div>

                <div style="background: #1a202c; padding: 15px; border-radius: 6px;">
                    <h4 style="color: #f6ad55; margin-top: 0;">⚡ Управление</h4>
                    <button id="cf-cleanup" style="background: #e53e3e; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin: 5px; font-size: 14px;">
                        🧹 Очистить устаревшие
                    </button>
                    <button id="cf-refresh-stats" style="background: #3182ce; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin: 5px; font-size: 14px;">
                        🔄 Обновить статистику
                    </button>
                </div>
            </div>

            <div style="background: #1a202c; padding: 15px; border-radius: 6px; margin-top: 15px;">
                <h4 style="color: #9f7aea; margin-top: 0;">📋 Активные токены</h4>
                <div id="cf-tokens" style="max-height: 200px; overflow-y: auto;">
                    <p>Загрузка...</p>
                </div>
            </div>
        </div>

        <h3>Как получить куки с CloudFreed расширением:</h3>

        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0;">
            <h4>📁 Установка CloudFreed расширения:</h4>
            <ol>
                <li>Откройте Chrome и введите в адресной строке: <code>chrome://extensions/</code></li>
                <li>Включите <strong>"Режим разработчика"</strong> (Developer mode) в правом верхнем углу</li>
                <li>Нажмите <strong>"Загрузить распакованное расширение"</strong></li>
                <li>Выберите папку: <code>C:\\Users\\tishka\\WebstormProjects\\bplacer\\CloudFreed_Extension\\CloudFreed_Extension_v1.0.1</code></li>
                <li>Убедитесь что расширение включено</li>
            </ol>
        </div>

        <div style="background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0;">
            <h4>🤖 Автоматическое получение cf_clearance токена:</h4>
            <p><strong>🥇 CF-Clearance-Scraper (основной метод):</strong></p>
            <ul>
                <li>Современный Python-скрипт с поддержкой всех типов Cloudflare challenges</li>
                <li>Работает с JavaScript, managed и interactive challenge</li>
                <li>Более стабильный и надежный чем браузерные расширения</li>
                <li>Требует: Python + папку <code>cf-clearance-scraper</code> с <code>main.py</code></li>
            </ul>
            <p><strong>🥈 CloudFreed Extension (резервный метод):</strong></p>
            <ul>
                <li>Браузерное расширение как fallback если Python-скрипт не работает</li>
                <li>Автоматически запускается если CF-Clearance-Scraper недоступен</li>
            </ul>
        </div>

        <div style="background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0;">
            <h4>🛠️ Установка CF-Clearance-Scraper (рекомендуется для лучшей автоматизации):</h4>
            <ol>
                <li>Клонируйте репозиторий: <code>git clone https://github.com/MatthewZito/CF-Clearance-Scraper.git</code></li>
                <li>Переместите папку в директорию проекта: <code>CF-Clearance-Scraper/</code></li>
                <li>Установите зависимости: <code>cd CF-Clearance-Scraper && pip install -r requirements.txt</code></li>
                <li>Убедитесь, что установлен Google Chrome и Python</li>
                <li>Теперь автоматическое получение токенов будет работать быстрее и надежнее!</li>
            </ol>

            <h4>📖 Получение куков вручную (если автоматика не работает):</h4>
            <ol>
                <li>Откройте новую вкладку и перейдите на <strong>bplace.org</strong></li>
                <li>Войдите в аккаунт и пройдите Cloudflare challenge</li>
                <li>После прохождения капчи нажмите <strong>F12</strong> (DevTools)</li>
                <li>Перейдите на вкладку <strong>Application</strong></li>
                <li>В левом меню: <strong>Storage → Cookies → https://bplace.org</strong></li>
                <li>Скопируйте значения куков <strong>j</strong> и <strong>cf_clearance</strong></li>
                <li>Вставьте их в форму выше и нажмите "Сохранить куки"</li>
            </ol>
        </div>

        <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 10px 0;">
            <h4>⚠️ Если расширение не работает:</h4>
            <ol>
                <li>Проверьте что CloudFreed включен в <code>chrome://extensions/</code></li>
                <li>Обновите страницу bplace.org</li>
                <li>Если капча не решается автоматически - попробуйте вручную</li>
                <li>После прохождения капчи куки будут доступны в DevTools</li>
            </ol>
        </div>
    </div>

    <script>
        document.getElementById('cookieForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const formData = new FormData(e.target);
            const data = {
                j: formData.get('j').trim(),
                cf_clearance: formData.get('cf_clearance').trim()
            };

            try {
                const response = await fetch('/manual-cookies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                const result = await response.text();
                const statusDiv = document.getElementById('status');

                if (response.ok) {
                    statusDiv.innerHTML = '<div class="status success">✅ Куки успешно сохранены!</div>';
                    setTimeout(() => location.reload(), 1500);
                } else {
                    statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${result}</div>\`;
                }
            } catch (error) {
                document.getElementById('status').innerHTML = \`<div class="status error">❌ Ошибка: \${error.message}</div>\`;
            }
        });

        // Automatic CloudFreed setup
        document.getElementById('autoSetup').addEventListener('click', async () => {
            const statusDiv = document.getElementById('status');

            statusDiv.innerHTML = \`
                <div style="background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 15px; border-radius: 5px; margin: 20px 0;">
                    <h4>🚀 Запускаю автоматическую установку...</h4>
                    <p>Сейчас запустится батник-файл, который:</p>
                    <ul>
                        <li>Закроет Chrome</li>
                        <li>Запустит Chrome с CloudFreed расширением</li>
                        <li>Откроет chrome://extensions/, bplace.org и эту страницу</li>
                    </ul>
                    <p><strong>Подождите несколько секунд...</strong></p>
                </div>
            \`;

            try {
                const response = await fetch('/run-cloudfreed-setup', {
                    method: 'POST'
                });

                const result = await response.text();

                if (response.ok) {
                    statusDiv.innerHTML = \`
                        <div style="background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 15px; border-radius: 5px; margin: 20px 0;">
                            <h4>✅ Автоматическая установка запущена!</h4>
                            <p>\${result}</p>
                            <p><strong>Что делать дальше:</strong></p>
                            <ol>
                                <li>Дождитесь открытия Chrome с тремя вкладками</li>
                                <li>На вкладке chrome://extensions/ включите "Режим разработчика"</li>
                                <li>На вкладке bplace.org дождитесь прохождения капчи</li>
                                <li>Скопируйте куки и вставьте в форму выше</li>
                            </ol>
                        </div>
                    \`;
                } else {
                    statusDiv.innerHTML = \`
                        <div style="background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 15px; border-radius: 5px; margin: 20px 0;">
                            <h4>❌ Ошибка автоматической установки</h4>
                            <p>\${result}</p>
                            <p>Попробуйте установить вручную, используя синюю кнопку "Показать инструкции"</p>
                        </div>
                    \`;
                }
            } catch (error) {
                statusDiv.innerHTML = \`
                    <div style="background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <h4>❌ Ошибка</h4>
                        <p>Не удалось запустить автоматическую установку: \${error.message}</p>
                        <p>Попробуйте установить вручную, используя синюю кнопку "Показать инструкции"</p>
                    </div>
                \`;
            }
        });

        // Show CloudFreed instructions
        document.getElementById('autoGetToken').addEventListener('click', async () => {
            const button = document.getElementById('autoGetToken');
            const statusDiv = document.getElementById('status');

            try {
                button.disabled = true;
                button.innerHTML = '🔄 Получаю токен...';
                statusDiv.innerHTML = '<div class="status">🤖 Запускаю Chrome с CloudFreed расширением...</div>';

                const response = await fetch('/auto-get-token', {
                    method: 'POST'
                });

                const result = await response.text();

                if (response.ok) {
                    statusDiv.innerHTML = '<div class="status success">✅ cf_clearance токен получен автоматически!</div>';
                    setTimeout(() => location.reload(), 2000);
                } else {
                    statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${result}</div>\`;
                }
            } catch (error) {
                statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${error.message}</div>\`;
            } finally {
                button.disabled = false;
                button.innerHTML = '🤖 Автоматически установить CloudFreed + получить cf_clearance';
            }
        });

        // Toggle auto mode button
        document.getElementById('toggleAutoMode').addEventListener('click', async function() {
            const button = this;
            button.disabled = true;

            try {
                const response = await fetch('/toggle-auto-mode', { method: 'POST' });
                const result = await response.text();

                if (response.ok) {
                    statusDiv.innerHTML = '<div class="status success">✅ Настройки автоматического режима изменены!</div>';
                    setTimeout(() => location.reload(), 1000);
                } else {
                    statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${result}</div>\`;
                }
            } catch (error) {
                statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${error.message}</div>\`;
            } finally {
                button.disabled = false;
            }
        });

        // Force token refresh button
        document.getElementById('forceTokenRefresh').addEventListener('click', async function() {
            const button = this;
            button.disabled = true;
            button.innerHTML = '🔄 Обновление токена...';

            try {
                const response = await fetch('/force-token-refresh', { method: 'POST' });
                const result = await response.text();

                if (response.ok) {
                    statusDiv.innerHTML = '<div class="status success">✅ cf_clearance токен принудительно обновлен!</div>';
                    setTimeout(() => location.reload(), 2000);
                } else {
                    statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${result}</div>\`;
                }
            } catch (error) {
                statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${error.message}</div>\`;
            } finally {
                button.disabled = false;
                button.innerHTML = '🔄 Принудительно обновить cf_clearance';
            }
        });

        // Install CF-Clearance-Scraper button
        document.getElementById('installCfScraper').addEventListener('click', async function() {
            const button = this;
            button.disabled = true;
            button.innerHTML = '🐍 Устанавливаем CF-Scraper...';

            try {
                const response = await fetch('/install-cf-scraper', { method: 'POST' });
                const result = await response.text();

                if (response.ok) {
                    statusDiv.innerHTML = '<div class="status success">✅ CF-Clearance-Scraper установлен успешно!</div>';
                } else {
                    statusDiv.innerHTML = \`<div class="status error">❌ Ошибка установки: \${result}</div>\`;
                }
            } catch (error) {
                statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${error.message}</div>\`;
            } finally {
                button.disabled = false;
                button.innerHTML = '🐍 Установить CF-Clearance-Scraper';
            }
        });

        // CF-Clearance Management Functions
        async function loadCfStats() {
            try {
                const response = await fetch('/cf-clearance/stats');
                const stats = await response.json();
                document.getElementById('cf-stats').innerHTML = \`
                    <p><strong>Всего токенов:</strong> \${stats.total}</p>
                    <p><strong>Истекают в течение 2ч:</strong> \${stats.expiringSoon}</p>
                \`;
            } catch (error) {
                document.getElementById('cf-stats').innerHTML = '<p style="color: #e53e3e;">Ошибка загрузки статистики</p>';
            }
        }

        async function loadCfTokens() {
            try {
                const response = await fetch('/cf-clearance/list');
                const data = await response.json();
                const tokensDiv = document.getElementById('cf-tokens');

                if (data.tokens.length === 0) {
                    tokensDiv.innerHTML = '<p style="color: #a0aec0;">Нет активных токенов</p>';
                    return;
                }

                const tokensHtml = data.tokens.map(token => {
                    const expiresInHours = Math.floor(token.expiresIn / (1000 * 60 * 60));
                    const expiresInMinutes = Math.floor((token.expiresIn % (1000 * 60 * 60)) / (1000 * 60));
                    const timeColor = expiresInHours < 2 ? '#f56565' : expiresInHours < 6 ? '#ed8936' : '#68d391';

                    return \`
                        <div style="background: #2d3748; padding: 10px; margin: 5px 0; border-radius: 4px; border-left: 4px solid \${timeColor};">
                            <div style="font-family: monospace; font-size: 12px; color: #e2e8f0; margin-bottom: 5px;">
                                <strong>Ключ:</strong> \${token.key}
                            </div>
                            <div style="display: flex; justify-content: space-between; font-size: 12px; color: #a0aec0;">
                                <span>Истекает через: \${expiresInHours}ч \${expiresInMinutes}м</span>
                                <span>Получен: \${new Date(token.obtainedAt).toLocaleString('ru-RU')}</span>
                            </div>
                        </div>
                    \`;
                }).join('');

                tokensDiv.innerHTML = tokensHtml;
            } catch (error) {
                document.getElementById('cf-tokens').innerHTML = '<p style="color: #e53e3e;">Ошибка загрузки токенов</p>';
            }
        }

        // CF-Clearance event listeners
        document.getElementById('cf-cleanup').addEventListener('click', async function() {
            const button = this;
            const originalText = button.innerHTML;
            button.disabled = true;
            button.innerHTML = '🧹 Очистка...';

            try {
                const response = await fetch('/cf-clearance/cleanup', { method: 'POST' });
                const result = await response.json();

                if (response.ok) {
                    statusDiv.innerHTML = '<div class="status success">✅ Устаревшие токены очищены!</div>';
                    loadCfStats();
                    loadCfTokens();
                } else {
                    statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${result.error}</div>\`;
                }
            } catch (error) {
                statusDiv.innerHTML = \`<div class="status error">❌ Ошибка: \${error.message}</div>\`;
            } finally {
                button.disabled = false;
                button.innerHTML = originalText;
            }
        });

        document.getElementById('cf-refresh-stats').addEventListener('click', function() {
            loadCfStats();
            loadCfTokens();
        });

        // Load CF-Clearance data on page load
        loadCfStats();
        loadCfTokens();

        // Auto-refresh CF data every 30 seconds
        setInterval(() => {
            loadCfStats();
            loadCfTokens();
        }, 30000);
    </script>
</body>
</html>`;
  res.send(html);
});

// Save manual cookies
app.post("/manual-cookies", (req, res) => {
  const { j, cf_clearance } = req.body || {};

  if (!j || !cf_clearance) {
    return res.status(400).send("Оба куки (j и cf_clearance) обязательны");
  }

  // Validate JWT format
  if (!j.startsWith('eyJ')) {
    return res.status(400).send("Неверный формат JWT token (j)");
  }

  // Save cookies
  manualCookies.j = j;
  manualCookies.cf_clearance = cf_clearance;

  console.log(`🍪 [MANUAL] Cookies saved manually:`);
  console.log(`🍪 [MANUAL] j: ${j.substring(0, 50)}...`);
  console.log(`🍪 [MANUAL] cf_clearance: ${cf_clearance.substring(0, 50)}...`);

  res.send("Куки сохранены успешно");
});

// Auto-get cf_clearance token endpoint
app.post("/auto-get-token", async (req, res) => {
  try {
    console.log('🚀 Starting automatic cf_clearance token retrieval...');
    const token = await getCloudflareToken();

    if (token) {
      res.send("cf_clearance токен получен успешно");
    } else {
      res.status(500).send("Не удалось получить cf_clearance токен");
    }
  } catch (error) {
    console.error('❌ Error in auto-get-token endpoint:', error.message);
    res.status(500).send(`Ошибка: ${error.message}`);
  }
});

// Toggle auto mode endpoint
app.post("/toggle-auto-mode", (req, res) => {
  try {
    autoTokenSettings.enabled = !autoTokenSettings.enabled;
    console.log(`🔧 Auto cf_clearance mode ${autoTokenSettings.enabled ? 'enabled' : 'disabled'}`);
    res.send(`Автоматический режим ${autoTokenSettings.enabled ? 'включен' : 'отключен'}`);
  } catch (error) {
    console.error('❌ Error toggling auto mode:', error.message);
    res.status(500).send(`Ошибка: ${error.message}`);
  }
});

// Force token refresh endpoint
app.post("/force-token-refresh", async (req, res) => {
  try {
    console.log('🔄 Force refreshing cf_clearance token...');

    // Reset retry timer to allow immediate attempt
    autoTokenSettings.lastAttempt = 0;
    autoTokenSettings.isRetrying = false;

    const token = await getCloudflareToken();

    if (token) {
      res.send("cf_clearance токен принудительно обновлен успешно");
    } else {
      res.status(500).send("Не удалось принудительно обновить cf_clearance токен");
    }
  } catch (error) {
    console.error('❌ Error in force token refresh:', error.message);
    res.status(500).send(`Ошибка: ${error.message}`);
  }
});

// Install CF-Clearance-Scraper endpoint
app.post("/install-cf-scraper", async (req, res) => {
  try {
    console.log('🐍 Installing CF-Clearance-Scraper...');

    const { spawn } = require('child_process');
    const path = require('path');
    const fs = require('fs');

    const batchFile = path.join(__dirname, 'install-cf-scraper.bat');

    if (!fs.existsSync(batchFile)) {
      return res.status(500).send("Файл install-cf-scraper.bat не найден");
    }

    const installProcess = spawn('cmd', ['/c', batchFile], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    installProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      console.log('🐍 [CF-Scraper Install]', text.trim());
    });

    installProcess.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      console.log('🐍 [CF-Scraper Install ERROR]', text.trim());
    });

    installProcess.on('close', (code) => {
      console.log(`🐍 CF-Clearance-Scraper installation finished with code: ${code}`);

      if (code === 0) {
        res.send("CF-Clearance-Scraper установлен успешно!");
      } else {
        res.status(500).send(`Ошибка установки (код ${code}): ${errorOutput || 'Неизвестная ошибка'}`);
      }
    });

    installProcess.on('error', (error) => {
      console.error('❌ Error installing CF-Clearance-Scraper:', error.message);
      res.status(500).send(`Ошибка запуска установки: ${error.message}`);
    });

    // Timeout after 300 seconds (5 minutes)
    setTimeout(() => {
      installProcess.kill();
      res.status(500).send("Установка прервана по таймауту (5 минут)");
    }, 300000);

  } catch (error) {
    console.error('❌ Error in CF-Clearance-Scraper installation:', error.message);
    res.status(500).send(`Ошибка: ${error.message}`);
  }
});


// Test endpoint with automatic token generation and user JWT selection
app.get("/test-bplace", async (req, res) => {
  console.log(`🔥 [TEST] Testing direct request to bplace.org`);

  try {
    // Get first available user's JWT token
    const userIds = Object.keys(users);
    if (userIds.length === 0) {
      return res.status(400).json({
        error: "No users configured. Please add users first."
      });
    }

    const firstUser = users[userIds[0]];
    if (!firstUser.cookies || !firstUser.cookies.j) {
      return res.status(400).json({
        error: "First user has no JWT token. Please ensure user has valid cookies."
      });
    }

    console.log(`🔥 [TEST] Using JWT from user ${userIds[0]} (${firstUser.name || 'unnamed'})`);

    // Get or generate cf_clearance token automatically
    let cfClearanceToken = manualCookies.cf_clearance;

    if (!cfClearanceToken) {
      console.log(`🔥 [TEST] No cf_clearance found, generating automatically...`);
      cfClearanceToken = await getCloudflareToken();

      if (!cfClearanceToken) {
        return res.status(500).json({
          error: "Failed to generate cf_clearance token automatically"
        });
      }
      console.log(`🔥 [TEST] Generated cf_clearance: ${cfClearanceToken.substring(0, 50)}...`);
    }

    const cookies = {
      j: firstUser.cookies.j,
      cf_clearance: cfClearanceToken
    };

    const cookieHeader = Object.keys(cookies).map(key => `${key}=${cookies[key]}`).join('; ');
    console.log(`🔥 [TEST] Cookie header length: ${cookieHeader.length}`);

    const response = await fetch("https://bplace.org/me", {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Cookie": cookieHeader
      }
    });

    console.log(`🔥 [TEST] Response status: ${response.status}`);

    // Try decompression
    let text;
    try {
      const responseClone = response.clone();
      text = await decompressResponse(responseClone);
      console.log(`🔥 [TEST] Decompressed successfully`);
    } catch (error) {
      console.log(`🔥 [TEST] Decompression failed: ${error.message}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      text = buffer.toString('utf8');
    }

    res.json({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      textLength: text.length,
      textPreview: text.substring(0, 200),
      userUsed: `${userIds[0]} (${firstUser.name || 'unnamed'})`,
      cfClearanceGenerated: !manualCookies.cf_clearance
    });

  } catch (error) {
    console.error(`🔥 [TEST] Error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- API: users ---
const getJwtExp = (j) => {
  try {
    const p = j.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
};

// --- API: queue ---
app.get("/queue", async (req, res) => {
  try {
    const now = Date.now();
    const queueData = [];
    let readyCount = 0;
    let totalCount = 0;

    for (const [id, user] of Object.entries(users)) {
      // if (user.disabled) continue;
      
      totalCount++;
      
      const prediction = ChargeCache.predict(id, now);
      const isSuspended = user.suspendedUntil && now < user.suspendedUntil;
      const isActive = activeBrowserUsers.has(id);
      
      let status = 'waiting';
      let cooldownTime = null;
      
      if (isSuspended) {
        status = 'suspended';
        cooldownTime = Math.ceil((user.suspendedUntil - now) / 1000);
      } else if (isActive) {
        status = 'active';
      } else if (prediction) {
        const threshold = currentSettings.alwaysDrawOnCharge ? 1 : Math.max(1, Math.floor(prediction.max * currentSettings.chargeThreshold));
        if (Math.floor(prediction.count) >= threshold) {
          status = 'ready';
          readyCount++;
        } else {
          status = 'cooldown';
          const deficit = Math.max(0, threshold - Math.floor(prediction.count));
          cooldownTime = deficit * (prediction.cooldownMs || 30000) / 1000;
        }
      } else {
        status = 'no-data';
      }

      queueData.push({
        id: id,
        name: user.name || `User #${id}`,
        charges: prediction ? {
          current: Math.floor(prediction.count),
          max: prediction.max,
          percentage: Math.round((prediction.count / prediction.max) * 100)
        } : null,
        status: status,
        cooldownTime: cooldownTime,
        retryCount: user.retryCount || 0,
        maxRetryCount: currentSettings.maxRetryCount,
        lastErrorTime: user.lastErrorTime || null
      });
    }

    queueData.sort((a, b) => {
      // Define priority order: active > ready > cooldown > waiting > suspended > no-data
      const statusPriority = {
        'active': 1,
        'ready': 2,
        'cooldown': 3,
        'waiting': 4,
        'suspended': 5,
        'no-data': 6
      };
      
      const aPriority = statusPriority[a.status] || 7;
      const bPriority = statusPriority[b.status] || 7;
      
      // First sort by status priority
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      
      // Within same status, sort by charges (higher first)
      if (a.charges && b.charges) {
        return b.charges.current - a.charges.current;
      }
      
      // If one has charges and other doesn't, prioritize the one with charges
      if (a.charges && !b.charges) return -1;
      if (!a.charges && b.charges) return 1;
      
      // Finally sort by ID for consistency
      return a.id.localeCompare(b.id);
    });

    res.json({
      success: true,
      data: {
        users: queueData,
        summary: {
          total: totalCount,
          ready: readyCount,
          waiting: queueData.filter(u => u.status === 'waiting').length,
          cooldown: queueData.filter(u => u.status === 'cooldown').length,
          suspended: queueData.filter(u => u.status === 'suspended').length,
          active: queueData.filter(u => u.status === 'active').length,
          noData: queueData.filter(u => u.status === 'no-data').length
        },
        lastUpdate: now,
        settings: {
          chargeThreshold: currentSettings.chargeThreshold,
          alwaysDrawOnCharge: currentSettings.alwaysDrawOnCharge
        }
      }
    });
  } catch (error) {
    logUserError(error, "SYSTEM", "queue-preview", "get queue preview");
    res.status(500).json({ error: "Failed to get queue preview" });
  }
});

app.get("/users", (_, res) => {
  const out = JSON.parse(JSON.stringify(users));
  for (const id of Object.keys(out)) {
    if (!out[id]) continue;
    if (out[id].cookies) delete out[id].cookies;
    if (!out[id].expirationDate && users[id]?.cookies?.j) {
      const exp = getJwtExp(users[id].cookies.j);
      if (exp) out[id].expirationDate = exp;
    }
  }
  res.json(out);
});

// Function to solve Turnstile captcha using local API
async function solveTurnstileCaptcha(url = 'https://bplace.org', sitekey = '0x4AAAAAABzxJUknzE7fFeq5') {
  const captchaApiUrl = 'http://localhost:8080';
  const timeout = 10000;
  const pollInterval = 3000;

  console.log(`🔐 [CAPTCHA] Solving Turnstile captcha for ${url} with sitekey ${sitekey}`);

  try {
    // Request captcha solving
    const requestUrl = `${captchaApiUrl}/turnstile?url=${encodeURIComponent(url)}&sitekey=${encodeURIComponent(sitekey)}`;
    const response = await fetch(requestUrl, { timeout });

    if (response.status !== 202) {
      throw new Error(`Captcha API returned unexpected status: ${response.status}`);
    }

    const taskData = await response.json();
    const taskId = taskData.task_id;
    console.log(`🔐 [CAPTCHA] Task created: ${taskId}`);

    // Poll for result
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const resultUrl = `${captchaApiUrl}/result?id=${encodeURIComponent(taskId)}`;
      const resultResponse = await fetch(resultUrl, { timeout });

      if (resultResponse.status === 202) {
        console.log(`🔐 [CAPTCHA] Still solving... (attempt ${attempt + 1}/${maxAttempts})`);
        continue;
      } else if (resultResponse.status === 200) {
        const result = await resultResponse.json();
        console.log(`🔐 [CAPTCHA] ✅ Captcha solved! Token length: ${result.value?.length || 0}`);
        return result.value;
      } else {
        throw new Error(`Captcha solving failed with status: ${resultResponse.status}`);
      }
    }

    throw new Error('Captcha solving timed out after maximum attempts');
  } catch (error) {
    console.log(`🔐 [CAPTCHA] ❌ Error solving captcha: ${error.message}`);
    throw new Error(`Failed to solve captcha: ${error.message}`);
  }
}

// Global proxy rotation counter for registration
let registrationProxyIndex = 0;

// Function to get next proxy for registration (with rotation)
function getNextProxyForRegistration() {
  if (!loadedProxies || loadedProxies.length === 0) {
    return null;
  }

  const proxy = loadedProxies[registrationProxyIndex % loadedProxies.length];
  registrationProxyIndex++;

  // Build proxy URL string
  let proxyUrl = `${proxy.protocol}://`;
  if (proxy.username && proxy.password) {
    proxyUrl += `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
  }
  proxyUrl += `${proxy.host}:${proxy.port}`;

  return proxyUrl;
}

// Function to register a new account on bplace.org
async function registerAccount(username, password) {
  console.log(`📝 [REGISTER] Attempting to register account: ${username}`);

  try {
    // Select proxy for this registration (will be used for all requests)
    const proxyUrl = getNextProxyForRegistration();
    if (proxyUrl) {
      console.log(`📝 [REGISTER] Using proxy: ${proxyUrl.replace(/:([^:]+)@/, ':***@')}`);
    } else {
      console.log(`📝 [REGISTER] No proxies available, using direct connection`);
    }

    // Try to get cf_clearance token with the selected proxy
    let cfClearanceData = null;
    let clearanceCookie = null;
    const userId = `register_${Date.now()}`;

    try {
      if (proxyUrl) {
        // Parse proxy for cfClearanceManager
        const proxyInfo = MockImpit.prototype.parseProxyUrl(proxyUrl);
        console.log(`📝 [REGISTER] Getting cf_clearance with proxy...`);
        cfClearanceData = await cfClearanceManager.getClearance(proxyInfo, userId, 'https://bplace.org');
      } else {
        console.log(`📝 [REGISTER] Getting cf_clearance without proxy...`);
        cfClearanceData = await cfClearanceManager.getClearance(null, userId, 'https://bplace.org');
      }

      if (cfClearanceData && cfClearanceData.cookies && cfClearanceData.cookies.cf_clearance) {
        clearanceCookie = cfClearanceData.cookies.cf_clearance;
        console.log(`📝 [REGISTER] Got cf_clearance with User-Agent: ${cfClearanceData.userAgent?.substring(0, 50)}...`);
      }
    } catch (error) {
      console.log(`⚠️ [REGISTER] Could not get cf_clearance (no challenge detected?): ${error.message}`);
      console.log(`📝 [REGISTER] Continuing without cf_clearance cookie...`);
    }

    const userAgent = cfClearanceData?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

    // Create MockImpit instance for registration with the SAME proxy
    const jar = new CookieJar();
    if (clearanceCookie) {
      jar.setCookieSync(`cf_clearance=${clearanceCookie}; Path=/`, "https://bplace.org");
    }

    const browser = new MockImpit({
      cookieJar: jar,
      browser: "chrome",
      ignoreTlsErrors: true,
      userId: userId,
      proxyUrl: proxyUrl, // Use the SAME proxy for all requests
      skipCfClearance: true, // Don't auto-fetch cf_clearance, use the one in cookieJar
      userAgent: userAgent // Use User-Agent from CF-Clearance
    });

    // First, get the login page (which contains registration form at #register)
    console.log(`📝 [REGISTER] Getting login page...`);
    const registerPageResponse = await browser.fetch('https://bplace.org/login');

    if (registerPageResponse.status !== 200) {
      throw new Error(`Failed to load login page: ${registerPageResponse.status}`);
    }

    console.log(`📝 [REGISTER] Login page loaded successfully (status: ${registerPageResponse.status})`);

    // Solve Turnstile captcha
    console.log(`📝 [REGISTER] Solving Turnstile captcha...`);
    let captchaToken;
    try {
      captchaToken = await solveTurnstileCaptcha();
      if (!captchaToken) {
        throw new Error("Captcha solver returned empty token");
      }

      // Wait 5 seconds after getting captcha token to avoid rate limiting
      console.log(`📝 [REGISTER] Waiting 15 seconds before submitting...`);
      await new Promise(resolve => setTimeout(resolve, 15000));
    } catch (captchaError) {
      throw new Error(`Captcha solving failed: ${captchaError.message}. Make sure the Python captcha solver is running on http://localhost:8080`);
    }

    // Prepare registration data
    const registrationData = new URLSearchParams({
      username: username,
      password: password,
      confirm: password,
      'cf-turnstile-response': captchaToken
    });

    // Submit registration form
    console.log(`📝 [REGISTER] Submitting registration form...`);
    const registerResponse = await browser.fetch('https://bplace.org/account/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://bplace.org/login',
        'Origin': 'https://bplace.org',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-GB,en;q=0.7',
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      body: registrationData.toString(),
      redirect: 'manual' // Don't follow redirects to capture Set-Cookie
    });

    console.log(`📝 [REGISTER] Registration response status: ${registerResponse.status}`);

    // Check for successful registration (302 redirect means success)
    if (registerResponse.status === 302 || registerResponse.status === 301) {
      console.log(`📝 [REGISTER] Registration successful (redirect detected)`);

      // Try to extract Set-Cookie headers using getSetCookie() method
      try {
        const setCookieHeaders = registerResponse.headers.getSetCookie ? registerResponse.headers.getSetCookie() : [];
        console.log(`📝 [REGISTER] Set-Cookie headers:`, setCookieHeaders);

        // Parse JWT token from Set-Cookie headers
        for (const setCookie of setCookieHeaders) {
          if (setCookie.startsWith('j=')) {
            const jwtMatch = setCookie.match(/^j=([^;]+)/);
            if (jwtMatch && jwtMatch[1]) {
              const jwtToken = jwtMatch[1];
              console.log(`📝 [REGISTER] JWT token found in Set-Cookie: ${jwtToken.substring(0, 50)}...`);

              // Save to cookie jar
              jar.setCookieSync(`j=${jwtToken}; Path=/; HttpOnly`, 'https://bplace.org');

              const result = {
                success: true,
                cookies: {
                  j: jwtToken
                }
              };
              if (clearanceCookie) {
                result.cookies.cf_clearance = clearanceCookie;
              }
              return result;
            }
          }
        }

        // If no JWT in Set-Cookie headers, try to extract from cookie jar
        const cookies = jar.getCookiesSync('https://bplace.org');
        console.log(`📝 [REGISTER] Cookies in jar after registration:`, cookies.map(c => `${c.key}=${c.value.substring(0, 20)}...`));

        for (const cookie of cookies) {
          if (cookie.key === 'j') {
            console.log(`📝 [REGISTER] JWT token found in jar: ${cookie.value.substring(0, 50)}...`);
            const result = {
              success: true,
              cookies: {
                j: cookie.value
              }
            };
            if (clearanceCookie) {
              result.cookies.cf_clearance = clearanceCookie;
            }
            return result;
          }
        }
      } catch (err) {
        console.log(`📝 [REGISTER] Could not extract JWT: ${err.message}`);
      }

      throw new Error("Registration successful but JWT token not found in response");
    }

    // Check for errors in response
    const responseText = await registerResponse.text();
    console.log(`📝 [REGISTER] Response text preview:`, responseText.substring(0, 200));

    // Check for rate limiting
    if (registerResponse.status === 401 || registerResponse.status === 429) {
      if (responseText.includes('Too many requests') || responseText.includes('rate limit')) {
        throw new Error("Rate limited - too many registration attempts. Please wait and try again later.");
      }
    }

    if (responseText.includes('Username already exists') || responseText.includes('already taken')) {
      throw new Error("Username already exists");
    }

    if (responseText.includes('captcha') || responseText.includes('Captcha')) {
      throw new Error("Captcha verification failed");
    }

    throw new Error(`Registration failed with status ${registerResponse.status}`);
  } catch (error) {
    console.log(`📝 [REGISTER] Registration failed for ${username}: ${error.message}`);
    throw error;
  }
}

// Function to refresh JWT token using saved credentials
async function refreshUserToken(userId) {
  const user = users[userId];
  if (!user || !user.credentials) {
    throw new Error("No saved credentials for user");
  }

  console.log(`🔄 [REFRESH] Refreshing token for user ${user.name} (${userId})`);

  try {
    const newCookies = await loginWithCredentials(user.credentials.username, user.credentials.password);

    // Update user cookies
    users[userId].cookies = newCookies;
    users[userId].expirationDate = getJwtExp(newCookies.j);
    saveUsers();

    console.log(`🔄 [REFRESH] Token refreshed successfully for user ${user.name} (${userId})`);
    return newCookies;
  } catch (error) {
    console.log(`🔄 [REFRESH] Failed to refresh token for user ${user.name} (${userId}): ${error.message}`);
    throw error;
  }
}

// Function to login with username/password and get JWT token
async function loginWithCredentials(username, password) {
  console.log(`🔐 [LOGIN] Attempting to login with username: ${username}`);

  try {
    // Get cf_clearance token
    let clearanceCookie = manualCookies.cf_clearance;
    if (!clearanceCookie || !(await isCfTokenValid(clearanceCookie))) {
      console.log('🤖 Getting cf_clearance token for login...');
      const autoToken = await autoGetCfTokenAndInterruptQueues();
      if (autoToken) {
        clearanceCookie = autoToken;
      }
    }

    // Create MockImpit instance for login (with or without cf_clearance)
    const jar = new CookieJar();
    if (clearanceCookie) {
      jar.setCookieSync(`cf_clearance=${clearanceCookie}; Path=/`, "https://bplace.org");
      console.log(`🔐 [LOGIN] Using cf_clearance token for login`);
    } else {
      console.log(`⚠️ [LOGIN] No cf_clearance token available, proceeding without it`);
    }

    const browser = new MockImpit({
      cookieJar: jar,
      browser: "chrome",
      ignoreTlsErrors: true,
      userId: `login_${Date.now()}`, // Temporary userId for login attempt
      skipCfClearance: !clearanceCookie // Skip CF auto-fetch if we don't have a token
    });

    // First, get the login page to check for any CSRF tokens or required fields
    console.log(`🔐 [LOGIN] Getting login page...`);
    const loginPageResponse = await browser.fetch('https://bplace.org/login');

    if (loginPageResponse.status !== 200) {
      throw new Error(`Failed to load login page: ${loginPageResponse.status}`);
    }

    // Prepare login data
    const loginData = new URLSearchParams({
      username: username,
      password: password
    });

    // Submit login form to the correct endpoint (manual redirect to capture Set-Cookie)
    console.log(`🔐 [LOGIN] Submitting login form...`);
    const loginResponse = await browser.fetch('https://bplace.org/account/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://bplace.org/login',
        'Origin': 'https://bplace.org',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      body: loginData.toString(),
      redirect: 'manual' // CHANGED: manual redirect to capture Set-Cookie headers
    });

    console.log(`🔐 [LOGIN] Login response status: ${loginResponse.status}`);

    // Check for successful login (302 redirect means success)
    if (loginResponse.status === 302 || loginResponse.status === 301) {
      console.log(`🔐 [LOGIN] Login successful (redirect detected)`);

      // Try to extract Set-Cookie headers using getSetCookie() method
      try {
        const setCookieHeaders = loginResponse.headers.getSetCookie ? loginResponse.headers.getSetCookie() : [];
        console.log(`🔐 [LOGIN] Set-Cookie headers:`, setCookieHeaders);

        // Parse JWT token from Set-Cookie headers
        for (const setCookie of setCookieHeaders) {
          if (setCookie.startsWith('j=')) {
            const jwtMatch = setCookie.match(/^j=([^;]+)/);
            if (jwtMatch && jwtMatch[1]) {
              const jwtToken = jwtMatch[1];
              console.log(`🔐 [LOGIN] JWT token found in Set-Cookie: ${jwtToken.substring(0, 50)}...`);

              // Save to cookie jar
              jar.setCookieSync(`j=${jwtToken}; Path=/; HttpOnly`, 'https://bplace.org');

              const result = { j: jwtToken };
              if (clearanceCookie) {
                result.cf_clearance = clearanceCookie;
              }
              return result;
            }
          }
        }
      } catch (err) {
        console.log(`🔐 [LOGIN] Error extracting Set-Cookie headers: ${err.message}`);
      }

      throw new Error("Login successful but JWT token not found in Set-Cookie headers");
    }

    // Handle specific error codes
    if (loginResponse.status === 502 || loginResponse.status === 503) {
      throw new Error(`Server temporarily unavailable (${loginResponse.status}). Try again later.`);
    }

    // Check response for error messages
    const responseText = await loginResponse.text();
    console.log(`🔐 [LOGIN] Response text preview:`, responseText.substring(0, 200));

    if (responseText.includes('Invalid username or password') ||
        responseText.includes('invalid credentials') ||
        responseText.includes('Authentication failed')) {
      throw new Error("Invalid username or password");
    }

    if (responseText.includes('cloudflare') || responseText.includes('Cloudflare')) {
      throw new Error("Cloudflare protection detected. Manual intervention may be required.");
    }

    throw new Error(`Login failed with status ${loginResponse.status}`);

  } catch (error) {
    console.log(`🔐 [LOGIN] Login failed for ${username}: ${error.message}`);
    throw error;
  }
}

app.post("/user", async (req, res) => {
  console.log(`🔥 [DEBUG] POST /user received`);
  console.log(`🔥 [DEBUG] Request body:`, JSON.stringify(req.body, null, 2));

  let cookiesToUse = req.body.cookies;
  let credentials = req.body.credentials;

  // Handle login with username/password
  if (credentials && credentials.username && credentials.password) {
    try {
      console.log(`🔐 [LOGIN] Login attempt with credentials for: ${credentials.username}`);
      cookiesToUse = await loginWithCredentials(credentials.username, credentials.password);
    } catch (error) {
      console.log(`🔐 [LOGIN] Login failed: ${error.message}`);
      return res.status(401).json({
        error: `Login failed: ${error.message}`
      });
    }
  }

  // Use manual cookies if no cookies provided in request
  if (!cookiesToUse || !cookiesToUse.j) {
    // Try to auto-get cf_clearance token if needed
    let clearanceCookie = manualCookies.cf_clearance;

    if (!clearanceCookie || !(await isCfTokenValid(clearanceCookie))) {
      console.log('🤖 Attempting to auto-retrieve cf_clearance token...');
      const autoToken = await autoGetCfTokenAndInterruptQueues();
      if (autoToken) {
        clearanceCookie = autoToken;
      }
    }

    if (manualCookies.j && clearanceCookie) {
      console.log(`🍪 [MANUAL] No cookies in request, using manual cookies`);
      cookiesToUse = {
        j: manualCookies.j,
        cf_clearance: clearanceCookie
      };
    } else if (!manualCookies.j) {
      console.log(`❌ [ERROR] No j cookie available. Please login manually first.`);
      return res.status(400).json({
        error: "No j cookie provided. Please login manually first at /manual-cookies"
      });
    } else {
      console.log(`❌ [ERROR] No valid cf_clearance token available after auto-retrieval attempt`);
      return res.status(400).json({
        error: "No valid cf_clearance token available. Auto-retrieval failed. Please try manual input at /manual-cookies"
      });
    }
  }

  const wplacer = new WPlacer();
  try {
    console.log(`🔥 [DEBUG] Attempting login with cookies`);
    const userInfo = await wplacer.login(cookiesToUse);
    const exp = getJwtExp(cookiesToUse.j);
    const profileNameRaw = typeof req.body?.profileName === "string" ? String(req.body.profileName) : "";
    const shortLabelFromProfile = profileNameRaw.trim().slice(0, 40);
    const prev = users[userInfo.id] || {};
    users[userInfo.id] = {
      ...prev,
      name: userInfo.name,
      cookies: cookiesToUse,
      expirationDate: exp || prev?.expirationDate || null
    };
    if (shortLabelFromProfile) {
      users[userInfo.id].shortLabel = shortLabelFromProfile;
    }
    // Save credentials if they were used for login
    if (credentials && credentials.username && credentials.password) {
      users[userInfo.id].credentials = {
        username: credentials.username,
        password: credentials.password
      };
      console.log(`🔐 [LOGIN] Saved credentials for user ${userInfo.name} (${userInfo.id})`);
    }
    saveUsers();
    res.json(userInfo);
  } catch (error) {
    console.log(`🔥 [DEBUG] Error in /user endpoint:`, error.message);
    console.log(`🔥 [DEBUG] Error stack:`, error.stack);
    logUserError(error, "NEW_USER", "N/A", "add new user");
    res.status(500).json({ error: error.message });
  }
});

app.delete("/user/:id", async (req, res) => {
  const userIdToDelete = req.params.id;
  if (!userIdToDelete || !users[userIdToDelete]) return res.sendStatus(400);

  const deletedUserName = users[userIdToDelete].name;
  delete users[userIdToDelete];
  saveUsers();
  log("SYSTEM", "Users", `Deleted user ${deletedUserName}#${userIdToDelete}.`);

  let templatesModified = false;
  for (const templateId in templates) {
    const template = templates[templateId];
    const initialUserCount = template.userIds.length;
    template.userIds = template.userIds.filter((id) => id !== userIdToDelete);

    if (template.userIds.length < initialUserCount) {
      templatesModified = true;
      log("SYSTEM", "Templates", `Removed user ${deletedUserName}#${userIdToDelete} from template "${template.name}".`);
      if (template.masterId === userIdToDelete) {
        template.masterId = template.userIds[0] || null;
        template.masterName = template.masterId ? users[template.masterId].name : null;
      }
      if (template.userIds.length === 0 && template.running) {
        template.running = false;
        log("SYSTEM", "wplacer", `[${template.name}] 🛑 Template stopped because it has no users left.`);
      }
    }
  }
  if (templatesModified) saveTemplates();
  res.sendStatus(200);
});

app.get("/user/status/:id", async (req, res) => {
  console.log("=== USER STATUS ENDPOINT CALLED ===");
  console.log(`🔥 [DEBUG] User status endpoint called for ID: ${req.params.id}`);
  const { id } = req.params;
  console.log(`🔥 [DEBUG] User exists: ${!!users[id]}, Active users: ${activeBrowserUsers.has(id)}`);
  if (!users[id]) {
    console.log(`❌ [DEBUG] User ${id} not found`);
    return res.status(409).json({ error: "User not found" });
  }
  if (activeBrowserUsers.has(id)) {
    console.log(`⚠️ [DEBUG] User ${id} is already active, waiting for completion...`);
    // Wait up to 10 seconds for the user to become available
    let waitTime = 0;
    const maxWait = 10000; // 10 seconds
    const checkInterval = 500; // 500ms

    while (activeBrowserUsers.has(id) && waitTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waitTime += checkInterval;
    }

    if (activeBrowserUsers.has(id)) {
      console.log(`❌ [DEBUG] User ${id} still active after ${maxWait}ms wait`);
      return res.status(409).json({ error: "User is already active" });
    }
    console.log(`✅ [DEBUG] User ${id} became available after ${waitTime}ms wait`);
  }
  activeBrowserUsers.add(id);
  console.log(`🔥 [DEBUG] Creating WPlacer instance for user ${id}`);
  const wplacer = new WPlacer(null, null, null, null, false, null, false, false, id);
  try {
    console.log(`🔥 [DEBUG] Calling wplacer.login() for user ${id}`);
    const userInfo = await wplacer.login(users[id].cookies);
    console.log(`🔥 [DEBUG] wplacer.login() completed successfully for user ${id}`);
    // If banned, return an explicit error with a distinct HTTP status code
    if (userInfo && userInfo.banned === true) {
      return res.status(423).json({ error: "❌ Account is suspended/banned." });
    }
    res.status(200).json(userInfo);
  } catch (error) {
    logUserError(error, id, users[id].name, "validate cookie");
    const msg = String(error && error.message || "error").toLowerCase();
    if (msg.includes("banned")) {
      return res.status(423).json({ error: "❌ Account is suspended/banned." });
    }
    res.status(500).json({ error: error.message });
  } finally {
    activeBrowserUsers.delete(id);
  }
});

// Cleanup expired users (by ids) with backup of users.json
app.post("/users/cleanup-expired", (req, res) => {
  try {
    const removeIds = Array.isArray(req.body?.removeIds) ? req.body.removeIds.map(String) : [];
    if (!removeIds || removeIds.length === 0) return res.status(400).json({ error: "no_selection" });

    // Backup users.json
    try {
      const usersPath = path.join(dataDir, "users.json");
      const backupPath = path.join(
        usersBackupsDir,
        `users.backup-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}.json`
      );
      try { writeFileSync(backupPath, readFileSync(usersPath, "utf8")); } catch (_) { }

      // Remove users
      let removed = 0;
      for (const id of removeIds) {
        if (users[id]) {
          const name = users[id].name;
          delete users[id];
          removed++;
          try { log("SYSTEM", "Users", `Deleted expired user ${name}#${id}.`); } catch (_) { }
        }
      }
      saveUsers();

      // Strip removed users from templates, update master if needed, stop if none
      let templatesModified = false;
      for (const templateId in templates) {
        const template = templates[templateId];
        const before = template.userIds.length;
        template.userIds = template.userIds.filter((uid) => !!users[uid]);
        if (template.userIds.length < before) {
          templatesModified = true;
          if (template.masterId && !users[template.masterId]) {
            template.masterId = template.userIds[0] || null;
            template.masterName = template.masterId ? users[template.masterId].name : null;
          }
          if (template.userIds.length === 0 && template.running) {
            template.running = false;
            try { log("SYSTEM", "wplacer", `[${template.name}] 🛑 Template stopped because it has no users left.`); } catch (_) { }
          }
        }
      }
      if (templatesModified) saveTemplates();

      const remaining = Object.keys(users).length;
      return res.status(200).json({ success: true, removed, remaining, backup: path.basename(backupPath) });
    } catch (e) {
      return res.status(500).json({ error: String(e && e.message || e) });
    }
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
});

// --- API: update user credentials ---
app.put("/user/:id/update-credentials", async (req, res) => {
  const { id } = req.params;
  const { username, password } = req.body || {};

  if (!users[id]) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  try {
    // Update credentials
    users[id].credentials = { username, password };
    saveUsers();

    console.log(`🔐 [UPDATE] Updated credentials for user ${users[id].name} (${id})`);

    res.json({ success: true, message: "Credentials updated successfully" });
  } catch (error) {
    console.error(`Failed to update credentials for user ${id}:`, error.message);
    res.status(500).json({ error: "Failed to update credentials" });
  }
});

// --- API: update user JWT token ---
app.put("/user/:id/update-jwt", async (req, res) => {
  const { id } = req.params;
  const { jwtToken } = req.body || {};

  console.log(`🔥 [DEBUG] /user/${id}/update-jwt endpoint called`);
  console.log(`🔥 [DEBUG] Request body:`, JSON.stringify(req.body, null, 2));
  console.log(`🔥 [DEBUG] jwtToken received:`, jwtToken);
  console.log(`🔥 [DEBUG] jwtToken starts with 'eyJ':`, jwtToken?.startsWith('eyJ'));

  if (!users[id]) {
    console.log(`❌ [DEBUG] User ${id} not found`);
    return res.status(404).json({ error: "User not found" });
  }

  if (!jwtToken || !jwtToken.startsWith('eyJ')) {
    console.log(`❌ [DEBUG] Invalid JWT token format`);
    return res.status(400).json({ error: "Valid JWT token is required" });
  }

  try {
    // Update JWT token
    users[id].cookies = users[id].cookies || {};
    users[id].cookies.j = jwtToken;

    // Update expiration date from JWT
    const exp = getJwtExp(jwtToken);
    if (exp) {
      users[id].expirationDate = exp;
    }

    saveUsers();

    console.log(`🔐 [UPDATE] Updated JWT token for user ${users[id].name} (${id})`);

    res.json({ success: true, message: "JWT token updated successfully" });
  } catch (error) {
    console.error(`Failed to update JWT token for user ${id}:`, error.message);
    res.status(500).json({ error: "Failed to update JWT token" });
  }
});

// --- API: update user profile (name/discord/showLastPixel) ---
app.put("/user/:id/update-profile", async (req, res) => {
  const { id } = req.params;
  if (!users[id] || activeBrowserUsers.has(id)) return res.sendStatus(409);

  // Always send all fields to backend, but validate here
  const name = typeof req.body?.name === "string" ? String(req.body.name).trim() : "";
  const discord = typeof req.body?.discord === "string" ? String(req.body.discord).trim() : "";
  const showLastPixel = typeof req.body?.showLastPixel === "boolean" ? !!req.body.showLastPixel : !!users[id]?.showLastPixel;
  const shortLabelRaw = typeof req.body?.shortLabel === "string" ? String(req.body.shortLabel) : "";
  const shortLabel = shortLabelRaw.trim().slice(0, 40);

  if (name && name.length > 15) return res.status(400).json({ error: "Name must be at most 15 characters" });
  if (discord && discord.length > 15) return res.status(400).json({ error: "Discord must be at most 15 characters" });

  // Always persist local-only field if provided
  if (typeof req.body?.shortLabel === "string") {
    users[id].shortLabel = shortLabel;
  }

  // Determine if remote update is needed
  const willUpdateRemote = (name && name !== users[id].name) || (discord !== users[id].discord) || (showLastPixel !== !!users[id].showLastPixel);

  if (!willUpdateRemote) {
    saveUsers();
    return res.status(200).json({ success: true, localOnly: true });
  }

  activeBrowserUsers.add(id);
  const wplacer = new WPlacer();
  try {
    await wplacer.login(users[id].cookies);
    const payload = { name, discord, showLastPixel };

    const { status, data } = await wplacer.post("https://bplace.org/me/update", payload);
    if (status === 200 && data && data.success) {
      if (typeof name === "string" && name.length) { users[id].name = name; }
      users[id].discord = discord;
      users[id].showLastPixel = !!showLastPixel;
      saveUsers();
      res.status(200).json({ success: true });
      log(id, users[id].name, `Updated profile (${Object.keys(payload).join(", ") || "no changes"}).`);
    } else {
      res.status(status || 500).json(data || { error: "Unknown error" });
    }
  } catch (error) {
    logUserError(error, id, users[id].name, "update profile");
    res.status(500).json({ error: error.message });
  } finally {
    activeBrowserUsers.delete(id);
  }
});

// Open local Brave profile launcher (.bat) by user's shortLabel
app.post("/user/:id/open-profile", (req, res) => {
  try {
    const { id } = req.params;
    const u = users[id];
    if (!u) return res.status(404).json({ error: "user_not_found" });
    const short = String(u.shortLabel || "").trim();
    if (!short) return res.status(400).json({ error: "no_profile_label" });

    // D:\Projects\pixels\wplacer-main\v4\brave\data\launch-{PROFILE}.bat
    const fileName = `launch-${short}.bat`;
    const profilePath = path.resolve(process.cwd(), "..", "brave", "data", fileName);
    if (!existsSync(profilePath)) {
      return res.status(404).json({ error: "bat_not_found", path: profilePath });
    }

    // Robust Windows CMD invocation: call "fullpath.bat" [brave.exe]
    try {
      try { log("SYSTEM", "Profiles", `Launching: ${profilePath}`); } catch(_) {}
      const batDir = path.dirname(profilePath);
      const debug = String(req.query?.debug || "").trim() === "1";

      // Try to detect Brave path and pass as first argument to .bat (so it doesn't rely on default)
      const envPf = process.env["ProgramFiles"] || "C:\\Program Files";
      const envPf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      const envLocal = process.env["LocalAppData"] || "C:\\Users\\%USERNAME%\\AppData\\Local";
      const candidates = [
        path.join(envPf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(envPf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(envLocal, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
      ];
      let braveExe = candidates.find(p => {
        try { return existsSync(p); } catch { return false; }
      }) || "";
      if (braveExe) { try { log("SYSTEM", "Profiles", `Detected Brave: ${braveExe}`); } catch(_) {} }

      const args = [debug ? "/k" : "/c", "call", profilePath];
      if (braveExe) args.push(braveExe);
      const child = spawn(process.env.COMSPEC || "cmd.exe", args, {
        windowsHide: !debug,
        detached: !debug,
        stdio: debug ? "inherit" : "ignore",
        cwd: batDir
      });
      if (!debug) child.unref();
    } catch (e) {
      return res.status(500).json({ error: String(e && e.message || e) });
    }

    return res.status(200).json({ success: true, path: profilePath });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
});

// --- API: alliance join ---
app.post("/user/:id/alliance/join", async (req, res) => {
  const { id } = req.params;
  const { uuid } = req.body || {};
  if (!users[id] || activeBrowserUsers.has(id)) return res.sendStatus(409);
  if (typeof uuid !== 'string' || !uuid.trim()) return res.status(400).json({ error: "uuid_required" });

  activeBrowserUsers.add(id);
  const wplacer = new WPlacer();
  try {
    await wplacer.login(users[id].cookies);
    const url = `https://bplace.org/alliance/join/${encodeURIComponent(uuid.trim())}`;
    const response = await wplacer.browser.fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/json,*/\*",
        Referer: "https://bplace.org/"
      },
      redirect: "manual"
    });
    const status = response.status | 0;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const responseClone = response.clone();
    const text = await responseClone.text();
    if (status >= 200 && status < 400) {
      res.status(200).json({ success: true });
      log(id, users[id].name, `Alliance join OK (uuid=${uuid}, status=${status}, type=${contentType || 'n/a'})`);
      console.log(`[Alliance] join success: user #${id} (${users[id].name}) -> uuid=${uuid} status=${status}`);
    } else {
      const short = String(text || '').slice(0, 200);
      log(id, users[id].name, `Alliance join FAILED (uuid=${uuid}, status=${status}) payload: ${short}`);
      console.error(`[Alliance] join failed: user #${id} (${users[id].name}) uuid=${uuid} status=${status} body: ${short}`);
      res.status(status || 500).json({ error: "alliance_join_failed", status, body: short });
    }
  } catch (error) {
    logUserError(error, id, users[id].name, "alliance join");
    console.error(`[Alliance] join exception: user #${id} (${users[id].name}) uuid=${uuid}:`, error?.message || error);
    res.status(500).json({ error: error.message });
  } finally {
    activeBrowserUsers.delete(id);
  }
});

// --- API: alliance leave ---
app.post("/user/:id/alliance/leave", async (req, res) => {
  const { id } = req.params;
  if (!users[id] || activeBrowserUsers.has(id)) return res.sendStatus(409);

  activeBrowserUsers.add(id);
  const wplacer = new WPlacer();
  try {
    await wplacer.login(users[id].cookies);
    const url = `https://bplace.org/alliance/leave`;
    const response = await wplacer.browser.fetch(url, {
      method: "POST",
      headers: {
        Accept: "*/*",
        Referer: "https://bplace.org/"
      }
    });
    const status = response.status | 0;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const responseClone = response.clone();
    const text = await responseClone.text();
    if (status >= 200 && status < 300) {
      res.status(200).json({ success: true });
      log(id, users[id].name, `Alliance leave OK (status=${status}, type=${contentType || 'n/a'})`);
      console.log(`[Alliance] leave success: user #${id} (${users[id].name}) status=${status}`);
    } else {
      const short = String(text || '').slice(0, 200);
      log(id, users[id].name, `Alliance leave FAILED (status=${status}) payload: ${short}`);
      console.error(`[Alliance] leave failed: user #${id} (${users[id].name}) status=${status} body: ${short}`);
      res.status(status || 500).json({ error: "alliance_leave_failed", status, body: short });
    }
  } catch (error) {
    logUserError(error, id, users[id].name, "alliance leave");
    console.error(`[Alliance] leave exception: user #${id} (${users[id].name}):`, error?.message || error);
    res.status(500).json({ error: error.message });
  } finally {
    activeBrowserUsers.delete(id);
  }
});

// --- API: refresh user JWT token using saved credentials ---
app.post("/user/:id/refresh-token", async (req, res) => {
  const { id } = req.params;

  if (!users[id]) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!users[id].credentials) {
    return res.status(400).json({ error: "No saved credentials for this user" });
  }

  if (activeBrowserUsers.has(id)) {
    return res.status(409).json({ error: "User is currently active in another operation" });
  }

  activeBrowserUsers.add(id);

  try {
    await refreshUserToken(id);
    res.json({
      success: true,
      message: `Token refreshed successfully for ${users[id].name}`,
      expirationDate: users[id].expirationDate
    });
  } catch (error) {
    console.error(`Failed to refresh token for user ${id}:`, error.message);
    res.status(500).json({ error: `Failed to refresh token: ${error.message}` });
  } finally {
    activeBrowserUsers.delete(id);
  }
});

// --- API: refresh tokens for all users with saved credentials ---
app.post("/users/refresh-tokens", async (req, res) => {
  const usersWithCredentials = Object.keys(users).filter(id => users[id].credentials);

  if (usersWithCredentials.length === 0) {
    return res.json({ message: "No users with saved credentials found", refreshed: 0, failed: 0 });
  }

  let refreshed = 0;
  let failed = 0;
  const results = [];

  for (const userId of usersWithCredentials) {
    if (activeBrowserUsers.has(userId)) {
      results.push({ userId, name: users[userId].name, status: "skipped", reason: "User busy" });
      continue;
    }

    activeBrowserUsers.add(userId);

    try {
      await refreshUserToken(userId);
      refreshed++;
      results.push({
        userId,
        name: users[userId].name,
        status: "success",
        expirationDate: users[userId].expirationDate
      });
    } catch (error) {
      failed++;
      results.push({
        userId,
        name: users[userId].name,
        status: "failed",
        error: error.message
      });
    } finally {
      activeBrowserUsers.delete(userId);
    }

    // Small delay between requests to avoid overwhelming the server
    if (userId !== usersWithCredentials[usersWithCredentials.length - 1]) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  res.json({
    message: `Token refresh completed`,
    total: usersWithCredentials.length,
    refreshed,
    failed,
    results
  });
});

// --- API: register new account ---
app.post("/user/register", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: "Username must be between 3 and 20 characters" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    console.log(`📝 [REGISTER API] Registration request for: ${username}`);

    const result = await registerAccount(username, password);

    if (result.success) {
      // Register the account in our system using the obtained JWT token
      const wplacer = new WPlacer();
      const userInfo = await wplacer.login(result.cookies);
      const exp = getJwtExp(result.cookies.j);

      const prev = users[userInfo.id] || {};
      users[userInfo.id] = {
        ...prev,
        name: userInfo.name,
        cookies: result.cookies,
        expirationDate: exp || prev?.expirationDate || null,
        credentials: {
          username: username,
          password: password
        }
      };

      saveUsers();

      console.log(`📝 [REGISTER API] Successfully registered and added user ${userInfo.name} (${userInfo.id})`);

      res.json({
        success: true,
        message: `Account ${username} registered successfully`,
        userInfo: userInfo
      });
    } else {
      res.status(500).json({ error: "Registration failed" });
    }
  } catch (error) {
    console.error(`📝 [REGISTER API] Registration failed for ${username}:`, error.message);

    if (error.message.includes("Username already exists")) {
      res.status(409).json({ error: "Username already exists" });
    } else if (error.message.includes("Captcha solving required")) {
      res.status(501).json({ error: "Captcha solving not implemented yet" });
    } else if (error.message.includes("Invalid username or password format")) {
      res.status(400).json({ error: "Invalid username or password format" });
    } else {
      res.status(500).json({ error: `Registration failed: ${error.message}` });
    }
  }
});

app.post("/users/buy-max-upgrades", async (req, res) => {
  if (buyMaxJob.active) return res.status(409).json({ error: "buy_max_in_progress" });
  const report = [];
  const cooldown = currentSettings.purchaseCooldown || 5000;
  const dummyTemplate = { width: 0, height: 0, data: [] };
  const dummyCoords = [0, 0, 0, 0];
  const userIds = Object.keys(users);

  buyMaxJob = { active: true, total: userIds.length, completed: 0, startedAt: Date.now(), finishedAt: 0, lastUserId: null, lastUserName: null };

  const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
  if (useParallel) {
    const ids = userIds.map(String);
    const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
    const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
    console.log(`[BuyMax] Parallel mode: ${ids.length} users, concurrency=${concurrency}, proxies=${loadedProxies.length}`);
    let index = 0;
    const worker = async () => {
      for (; ;) {
        const i = index++;
        if (i >= ids.length) break;
        const userId = ids[i];
        const urec = users[userId];
        if (!urec) { report.push({ userId, name: `#${userId}`, skipped: true, reason: "unknown_user" }); buyMaxJob.completed++; continue; }
        if (activeBrowserUsers.has(userId)) { report.push({ userId, name: urec.name, skipped: true, reason: "busy" }); buyMaxJob.completed++; continue; }

        activeBrowserUsers.add(userId);
        const wplacer = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "AdminPurchase");
        try {
          await wplacer.login(urec.cookies);
          await wplacer.loadUserInfo();
          buyMaxJob.lastUserId = userId; buyMaxJob.lastUserName = wplacer.userInfo.name;
          const beforeDroplets = wplacer.userInfo.droplets;
          const reserve = currentSettings.dropletReserve || 0;
          const affordable = Math.max(0, beforeDroplets - reserve);
          const amountToBuy = Math.floor(affordable / 500);
          if (amountToBuy > 0) {
            await wplacer.buyProduct(70, amountToBuy);
            report.push({ userId, name: wplacer.userInfo.name, amount: amountToBuy, beforeDroplets, afterDroplets: beforeDroplets - amountToBuy * 500 });
          } else {
            report.push({ userId, name: wplacer.userInfo.name, amount: 0, skipped: true, reason: "insufficient_droplets_or_reserve" });
          }
        } catch (error) {
          logUserError(error, userId, urec.name, "bulk buy max charge upgrades");
          report.push({ userId, name: urec.name, error: error?.message || String(error) });
        } finally {
          activeBrowserUsers.delete(userId);
          buyMaxJob.completed++;
        }
        const cd = Math.max(0, Number(currentSettings.purchaseCooldown || 0));
        if (cd > 0) await sleep(cd);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } else {
    for (let i = 0; i < userIds.length; i++) {
      const userId = userIds[i];
      const urec = users[userId];
      if (!urec) continue;
      if (activeBrowserUsers.has(userId)) { report.push({ userId, name: urec.name, skipped: true, reason: "busy" }); continue; }
      activeBrowserUsers.add(userId);
      const wplacer = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "AdminPurchase");
      try {
        await wplacer.login(urec.cookies); await wplacer.loadUserInfo();
        buyMaxJob.lastUserId = userId; buyMaxJob.lastUserName = wplacer.userInfo.name;
        const beforeDroplets = wplacer.userInfo.droplets;
        const reserve = currentSettings.dropletReserve || 0;
        const affordable = Math.max(0, beforeDroplets - reserve);
        const amountToBuy = Math.floor(affordable / 500);
        if (amountToBuy > 0) {
          await wplacer.buyProduct(70, amountToBuy);
          report.push({ userId, name: wplacer.userInfo.name, amount: amountToBuy, beforeDroplets, afterDroplets: beforeDroplets - amountToBuy * 500 });
        } else {
          report.push({ userId, name: wplacer.userInfo.name, amount: 0, skipped: true, reason: "insufficient_droplets_or_reserve" });
        }
      } catch (error) {
        logUserError(error, userId, urec.name, "bulk buy max charge upgrades");
        report.push({ userId, name: urec.name, error: error?.message || String(error) });
      } finally {
        activeBrowserUsers.delete(userId);
        buyMaxJob.completed++;
      }
      if (i < userIds.length - 1 && cooldown > 0) { await sleep(cooldown); }
    }
  }

  buyMaxJob.active = false; buyMaxJob.finishedAt = Date.now();
  res.json({ ok: true, cooldownMs: cooldown, reserve: currentSettings.dropletReserve || 0, report });
});

// Bulk buy paint charges for all users (uses dropletReserve and purchaseCooldown)
app.post("/users/buy-charges", async (req, res) => {
  if (buyChargesJob.active) return res.status(409).json({ error: "buy_charges_in_progress" });
  const report = [];
  const cooldown = currentSettings.purchaseCooldown || 5000;
  const dummyTemplate = { width: 0, height: 0, data: [] };
  const dummyCoords = [0, 0, 0, 0];
  const userIds = Object.keys(users);

  buyChargesJob = { active: true, total: userIds.length, completed: 0, startedAt: Date.now(), finishedAt: 0, lastUserId: null, lastUserName: null };

  const doOne = async (userId) => {
    const urec = users[userId];
    if (!urec) { report.push({ userId, name: `#${userId}`, skipped: true, reason: "unknown_user" }); buyChargesJob.completed++; return; }
    if (activeBrowserUsers.has(userId)) { report.push({ userId, name: urec.name, skipped: true, reason: "busy" }); buyChargesJob.completed++; return; }

    activeBrowserUsers.add(userId);
    const wplacer = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "AdminPurchaseCharges");
    try {
      await wplacer.login(urec.cookies);
      await wplacer.loadUserInfo();
      buyChargesJob.lastUserId = userId; buyChargesJob.lastUserName = wplacer.userInfo.name;
      const beforeDroplets = Number(wplacer.userInfo.droplets || 0);
      const reserve = Number(currentSettings.dropletReserve || 0);
      const affordable = Math.max(0, beforeDroplets - reserve);
      const amountToBuy = Math.floor(affordable / 500);
      if (amountToBuy > 0) {
        await wplacer.buyProduct(80, amountToBuy);
        report.push({ userId, name: wplacer.userInfo.name, amount: amountToBuy, beforeDroplets, afterDroplets: beforeDroplets - amountToBuy * 500 });
      } else {
        report.push({ userId, name: wplacer.userInfo.name, amount: 0, skipped: true, reason: "insufficient_droplets_or_reserve" });
      }
    } catch (error) {
      logUserError(error, userId, urec.name, "bulk buy paint charges");
      report.push({ userId, name: urec.name, error: error?.message || String(error) });
    } finally {
      activeBrowserUsers.delete(userId);
      buyChargesJob.completed++;
    }
  };

  try {
    const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    if (useParallel) {
      const ids = userIds.map(String);
      const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
      const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
      console.log(`[BuyCharges] Parallel mode: ${ids.length} users, concurrency=${concurrency}, proxies=${loadedProxies.length}`);
      let index = 0;
      const worker = async () => {
        for (;;) {
          const i = index++;
          if (i >= ids.length) break;
          await doOne(ids[i]);
          const cd = Math.max(0, Number(currentSettings.purchaseCooldown || 0));
          if (cd > 0) await sleep(cd);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } else {
      for (let i = 0; i < userIds.length; i++) {
        await doOne(userIds[i]);
        if (i < userIds.length - 1 && cooldown > 0) { await sleep(cooldown); }
      }
    }
    buyChargesJob.active = false; buyChargesJob.finishedAt = Date.now();
    res.json({ ok: true, cooldownMs: cooldown, reserve: currentSettings.dropletReserve || 0, report });
  } catch (e) {
    buyChargesJob.active = false; buyChargesJob.finishedAt = Date.now();
    console.error("buy-charges failed:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/users/purchase-color", async (req, res) => {
  try {
    const { colorId, userIds } = req.body || {};
    const cid = Number(colorId);
    if (!Number.isFinite(cid) || cid < 32 || cid > 95) {
      return res.status(400).json({ error: "colorId must be a premium color id (32..95)" });
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "userIds must be a non-empty array" });
    }

    const cooldown = currentSettings.purchaseCooldown || 5000;
    const reserve = currentSettings.dropletReserve || 0;

    const dummyTemplate = { width: 0, height: 0, data: [] };
    const dummyCoords = [0, 0, 0, 0];

    const report = [];

    if (purchaseColorJob.active) {
      return res.status(409).json({ error: "purchase_in_progress" });
    }
    purchaseColorJob = { active: true, total: userIds.length, completed: 0, startedAt: Date.now(), finishedAt: 0, lastUserId: null, lastUserName: null };

    const hasColor = (bitmap, colorId) => {
      const bit = colorId - 32;
      let bitmapBig;
      try {
        if (typeof bitmap === 'string') {
          const hexStr = bitmap.startsWith('0x') ? bitmap : '0x' + bitmap;
          bitmapBig = BigInt(hexStr);
        } else {
          bitmapBig = BigInt(bitmap || 0);
        }
        return (bitmapBig & (BigInt(1) << BigInt(bit))) !== BigInt(0);
      } catch (e) {
        console.error(`[DEBUG] hasColor BigInt conversion error:`, {
          bitmap,
          colorId,
          bitmapType: typeof bitmap,
          error: e.message
        });
        return false;
      }
    };

    const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    if (useParallel) {
      const ids = userIds.map(String);
      const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
      const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
      console.log(`[ColorPurchase] Parallel mode: ${ids.length} users, concurrency=${concurrency}, proxies=${loadedProxies.length}`);
      let index = 0;
      const worker = async () => {
        for (; ;) {
          const i = index++;
          if (i >= ids.length) break;
          const uid = ids[i];
          const urec = users[uid];
          if (!urec) { report.push({ userId: uid, name: `#${uid}`, skipped: true, reason: "unknown_user" }); continue; }
          if (activeBrowserUsers.has(uid)) { report.push({ userId: uid, name: urec.name, skipped: true, reason: "busy" }); continue; }
          activeBrowserUsers.add(uid);
          const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "ColorPurchase");
          try {
            await w.login(urec.cookies);
            await w.loadUserInfo();
            const name = w.userInfo.name;
            purchaseColorJob.lastUserId = uid; purchaseColorJob.lastUserName = name;
            const beforeBitmap = w.userInfo.extraColorsBitmap || "0";
            const beforeDroplets = Number(w.userInfo.droplets || 0);
            if (hasColor(beforeBitmap, cid)) {
              report.push({ userId: uid, name, skipped: true, reason: "already_has_color" });
            } else {
              try {
                await w.buyProduct(100, 1, cid);
                await w.loadUserInfo().catch(() => { });
                report.push({ userId: uid, name, ok: true, success: true, beforeDroplets, afterDroplets: w.userInfo?.droplets });
              } catch (err) {
                if (err?.code === 403 || /FORBIDDEN_OR_INSUFFICIENT/i.test(err?.message)) {
                  report.push({ userId: uid, name, skipped: true, reason: "forbidden_or_insufficient_droplets" });
                } else if (/(1015)/.test(err?.message)) {
                  report.push({ userId: uid, name, error: "rate_limited" });
                } else {
                  report.push({ userId: uid, name, error: err?.message || "purchase_failed" });
                }
              }
            }
          } catch (e) {
            logUserError(e, uid, urec.name, "purchase color");
            report.push({ userId: uid, name: urec.name, error: e?.message || "login_failed" });
          } finally {
            activeBrowserUsers.delete(uid);
            purchaseColorJob.completed++;
          }
          const cd = Math.max(0, Number(currentSettings.purchaseCooldown || 0));
          if (cd > 0) await sleep(cd);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } else {
      for (let idx = 0; idx < userIds.length; idx++) {
        const uid = String(userIds[idx]);
        const urec = users[uid];
        if (!urec) { report.push({ userId: uid, name: `#${uid}`, skipped: true, reason: "unknown_user" }); continue; }
        if (activeBrowserUsers.has(uid)) { report.push({ userId: uid, name: urec.name, skipped: true, reason: "busy" }); continue; }
        activeBrowserUsers.add(uid);
        const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "ColorPurchase");
        try {
          await w.login(urec.cookies);
          await w.loadUserInfo();
          const name = w.userInfo.name;
          purchaseColorJob.lastUserId = uid; purchaseColorJob.lastUserName = name;
          const beforeBitmap = w.userInfo.extraColorsBitmap || "0";
          const beforeDroplets = Number(w.userInfo.droplets || 0);
          if (hasColor(beforeBitmap, cid)) {
            report.push({ userId: uid, name, skipped: true, reason: "already_has_color" });
          } else {
            try {
              await w.buyProduct(100, 1, cid);
              await sleep(cooldown);
              await w.loadUserInfo().catch(() => { });
              report.push({ userId: uid, name, ok: true, success: true, beforeDroplets, afterDroplets: w.userInfo?.droplets });
            } catch (err) {
              if (err?.code === 403 || /FORBIDDEN_OR_INSUFFICIENT/i.test(err?.message)) {
                report.push({ userId: uid, name, skipped: true, reason: "forbidden_or_insufficient_droplets" });
              } else if (/(1015)/.test(err?.message)) {
                report.push({ userId: uid, name, error: "rate_limited" });
              } else {
                report.push({ userId: uid, name, error: err?.message || "purchase_failed" });
              }
            }
          }
        } catch (e) {
          logUserError(e, uid, urec.name, "purchase color");
          report.push({ userId: uid, name: urec.name, error: e?.message || "login_failed" });
        } finally {
          activeBrowserUsers.delete(uid);
          purchaseColorJob.completed++;
        }
        if (idx < userIds.length - 1 && cooldown > 0) { await sleep(cooldown); }
      }
    }

    purchaseColorJob.active = false; purchaseColorJob.finishedAt = Date.now();
    res.json({ colorId: cid, cooldownMs: cooldown, reserve, report });
  } catch (e) {
    purchaseColorJob.active = false; purchaseColorJob.finishedAt = Date.now();
    console.error("purchase-color failed:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- API: users flags check (parallel with proxies, else sequential) ---
app.post("/users/flags-check", async (req, res) => {
  try {
    if (flagsCheckJob.active) {
      return res.status(409).json({ error: "flags_check_in_progress" });
    }

    const cooldown = currentSettings.accountCheckCooldown || 0;

    const dummyTemplate = { width: 0, height: 0, data: [] };
    const dummyCoords = [0, 0, 0, 0];

    const ids = Object.keys(users);
    flagsCheckJob = {
      active: true,
      total: ids.length,
      completed: 0,
      startedAt: Date.now(),
      finishedAt: 0,
      lastUserId: null,
      lastUserName: null,
      report: []
    };

    const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
    const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
    if (useParallel) {
      console.log(`[FlagsCheck] Parallel: ${ids.length} accounts (concurrency=${concurrency}, proxies=${loadedProxies.length})`);
    } else {
      console.log(`[FlagsCheck] Sequential: ${ids.length} accounts. Cooldown=${cooldown}ms`);
    }

    const workerIds = ids.map(String);

    const doOne = async (uid) => {
      if (!users[uid]) return;
      if (activeBrowserUsers.has(uid)) return;
      activeBrowserUsers.add(uid);
      const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "FlagsCheck");
      try {
        await w.login(users[uid].cookies);
        await w.loadUserInfo();
        const u = w.userInfo || {};
        flagsCheckJob.lastUserId = uid; flagsCheckJob.lastUserName = u.name;
        flagsCheckJob.report.push({
          userId: String(uid),
          name: u.name,
          flagsBitmap: u.flagsBitmap || "",
          equippedFlag: Number(u.equippedFlag || 0),
          droplets: Number(u.droplets || 0)
        });
      } catch (e) {
        logUserError(e, uid, users[uid]?.name || `#${uid}`, "flags check");
        flagsCheckJob.report.push({ userId: String(uid), name: users[uid]?.name || `#${uid}`, error: e?.message || "failed" });
      } finally {
        activeBrowserUsers.delete(uid);
        flagsCheckJob.completed++;
      }
      if (cooldown > 0) await sleep(cooldown);
    };

    if (useParallel) {
      let index = 0;
      const worker = async () => {
        for (;;) {
          const i = index++; if (i >= workerIds.length) break;
          await doOne(workerIds[i]);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } else {
      for (let i = 0; i < workerIds.length; i++) {
        await doOne(workerIds[i]);
      }
    }

    flagsCheckJob.active = false; flagsCheckJob.finishedAt = Date.now();
    const tookMs = (flagsCheckJob.finishedAt - (flagsCheckJob.startedAt || flagsCheckJob.finishedAt));
    const tookS = Math.max(1, Math.round(tookMs / 1000));
    console.log(`[FlagsCheck] Finished: ${flagsCheckJob.completed}/${flagsCheckJob.total} in ${tookS}s.`);
    res.json({ ok: true, ts: flagsCheckJob.finishedAt || Date.now(), cooldownMs: cooldown, report: flagsCheckJob.report });
  } catch (e) {
    flagsCheckJob.active = false; flagsCheckJob.finishedAt = Date.now();
    console.error("flags-check failed:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// progress endpoint for flags-check
app.get("/users/flags-check/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = flagsCheckJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});

// --- API: users purchase flag ---
app.post("/users/purchase-flag", async (req, res) => {
  try {
    const { flagId, userIds } = req.body || {};
    const fid = Number(flagId);
    if (!Number.isFinite(fid) || fid < 1 || fid > 10000) {
      return res.status(400).json({ error: "flagId must be a valid flag id" });
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "userIds must be a non-empty array" });
    }

    const cooldown = currentSettings.purchaseCooldown || 5000;
    const reserve = currentSettings.dropletReserve || 0;
    const FLAG_COST = 20000;

    const dummyTemplate = { width: 0, height: 0, data: [] };
    const dummyCoords = [0, 0, 0, 0];

    const report = [];

    if (purchaseFlagJob.active) {
      return res.status(409).json({ error: "purchase_in_progress" });
    }
    purchaseFlagJob = { active: true, total: userIds.length, completed: 0, startedAt: Date.now(), finishedAt: 0, lastUserId: null, lastUserName: null };

    const decodeFlags = (b64) => {
      if (!b64 || typeof b64 !== 'string') return [];
      try {
        const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
        const L = bytes.length; const ids = [];
        for (let i = 0; i < L; i++) {
          const v = bytes[i]; if (v === 0) continue;
          for (let bit = 0; bit < 8; bit++) if (v & (1 << bit)) ids.push((L - 1 - i) * 8 + bit);
        }
        return ids.sort((a, b) => a - b);
      } catch (_) { return []; }
    };

    const doOne = async (uid) => {
      if (!users[uid]) { report.push({ userId: uid, error: 'not_found' }); purchaseFlagJob.completed++; return; }
      if (activeBrowserUsers.has(uid)) { report.push({ userId: uid, error: 'busy' }); purchaseFlagJob.completed++; return; }
      activeBrowserUsers.add(uid);
      const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "FlagPurchase");
      try {
        await w.login(users[uid].cookies);
        await w.loadUserInfo();
        const name = w.userInfo?.name;
        purchaseFlagJob.lastUserId = uid; purchaseFlagJob.lastUserName = name;
        const beforeDroplets = Number(w.userInfo?.droplets || 0);
        const owned = new Set(decodeFlags(String(w.userInfo?.flagsBitmap || '')));
        if (owned.has(fid)) {
          report.push({ userId: uid, name, skipped: true, reason: 'already_has_flag' });
        } else if (beforeDroplets < FLAG_COST) {
          report.push({ userId: uid, name, skipped: true, reason: 'forbidden_or_insufficient_droplets' });
        } else {
          try {
            // product id 110 per user: flags, variant = flagId
            await w.buyProduct(110, 1, fid);
            await w.loadUserInfo().catch(() => { });
            report.push({ userId: uid, name, ok: true, success: true, beforeDroplets, afterDroplets: w.userInfo?.droplets });
          } catch (err) {
            if (err?.code === 403 || /FORBIDDEN_OR_INSUFFICIENT/i.test(err?.message)) {
              report.push({ userId: uid, name, skipped: true, reason: "forbidden_or_insufficient_droplets" });
            } else if (/(1015)/.test(err?.message)) {
              report.push({ userId: uid, name, error: "rate_limited" });
            } else {
              report.push({ userId: uid, name, error: err?.message || "purchase_failed" });
            }
          }
        }
      } catch (e) {
        logUserError(e, uid, users[uid]?.name || `#${uid}`, "purchase flag");
        report.push({ userId: uid, name: users[uid]?.name || `#${uid}`, error: e?.message || 'login_failed' });
      } finally {
        activeBrowserUsers.delete(uid);
        purchaseFlagJob.completed++;
      }
    };

    const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    if (useParallel) {
      const ids = userIds.map(String);
      const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
      const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
      console.log(`[FlagPurchase] Parallel mode: ${ids.length} users, concurrency=${concurrency}, proxies=${loadedProxies.length}`);
      let index = 0;
      const worker = async () => {
        for (;;) {
          const i = index++;
          if (i >= ids.length) break;
          await doOne(ids[i]);
          const cd = Math.max(0, Number(currentSettings.purchaseCooldown || 0));
          if (cd > 0) await sleep(cd);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } else {
      console.log(`[FlagPurchase] Sequential: ${userIds.length} accounts. Cooldown=${cooldown}ms`);
      for (let idx = 0; idx < userIds.length; idx++) {
        await doOne(String(userIds[idx]));
        if (idx < userIds.length - 1 && cooldown > 0) { await sleep(cooldown); }
      }
    }

    purchaseFlagJob.active = false; purchaseFlagJob.finishedAt = Date.now();
    const tookMs = (purchaseFlagJob.finishedAt - (purchaseFlagJob.startedAt || purchaseFlagJob.finishedAt));
    const tookS = Math.max(1, Math.round(tookMs / 1000));
    console.log(`[FlagPurchase] Finished: ${purchaseFlagJob.completed}/${purchaseFlagJob.total} in ${tookS}s.`);
    res.json({ flagId: fid, cooldownMs: cooldown, reserve, report });
  } catch (e) {
    purchaseFlagJob.active = false; purchaseFlagJob.finishedAt = Date.now();
    console.error("purchase-flag failed:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// progress endpoint for purchase-flag
app.get("/users/purchase-flag/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = purchaseFlagJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});

// --- API: equip/unequip flag for specific user ---
app.post("/user/:id/flag/equip", async (req, res) => {
  const uid = String(req.params.id);
  const fid = Number(req.body?.flagId || 0) || 0;
  if (!users[uid]) return res.sendStatus(404);
  if (activeBrowserUsers.has(uid)) return res.sendStatus(409);
  activeBrowserUsers.add(uid);
  const dummyTemplate = { width: 0, height: 0, data: [] };
  const dummyCoords = [0, 0, 0, 0];
  const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "FlagEquip");
  try {
    await w.login(users[uid].cookies); await w.loadUserInfo();
    await w.equipFlag(fid);
    await w.loadUserInfo().catch(() => {});
    res.json({ success: true, equippedFlag: Number(w.userInfo?.equippedFlag || fid) });
  } catch (e) {
    logUserError(e, uid, users[uid]?.name || `#${uid}`, "equip flag");
    if (e?.code === 403) return res.status(403).json({ error: 'forbidden' });
    res.status(500).json({ error: e?.message || 'failed' });
  } finally {
    activeBrowserUsers.delete(uid);
  }
});

// --- API: users batch equip flag ---
let equipFlagJob = { active: false, total: 0, completed: 0, startedAt: 0, finishedAt: 0, lastUserId: null, lastUserName: null };
app.post("/users/equip-flag", async (req, res) => {
  try {
    const { flagId, userIds } = req.body || {};
    const fid = Number(flagId) || 0;
    if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: "userIds must be a non-empty array" });
    if (equipFlagJob.active) return res.status(409).json({ error: "equip_in_progress" });
    equipFlagJob = { active: true, total: userIds.length, completed: 0, startedAt: Date.now(), finishedAt: 0, lastUserId: null, lastUserName: null };

    const dummyTemplate = { width: 0, height: 0, data: [] };
    const dummyCoords = [0, 0, 0, 0];
    const report = [];
    const cooldown = currentSettings.purchaseCooldown || 0;

    const doOne = async (uid) => {
      if (!users[uid]) { report.push({ userId: uid, error: 'not_found' }); equipFlagJob.completed++; return; }
      if (activeBrowserUsers.has(uid)) { report.push({ userId: uid, error: 'busy' }); equipFlagJob.completed++; return; }
      activeBrowserUsers.add(uid);
      const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "FlagEquipBatch");
      try {
        await w.login(users[uid].cookies); await w.loadUserInfo();
        equipFlagJob.lastUserId = uid; equipFlagJob.lastUserName = w.userInfo?.name;
        await w.equipFlag(fid);
        await w.loadUserInfo().catch(() => {});
        report.push({ userId: uid, name: w.userInfo?.name, ok: true, success: true, equippedFlag: Number(w.userInfo?.equippedFlag || fid) });
      } catch (e) {
        logUserError(e, uid, users[uid]?.name || `#${uid}`, "equip flag batch");
        report.push({ userId: uid, name: users[uid]?.name || `#${uid}`, error: e?.message || 'failed' });
      } finally {
        activeBrowserUsers.delete(uid);
        equipFlagJob.completed++;
      }
    };

    const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    if (useParallel) {
      const ids = userIds.map(String);
      const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
      const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
      console.log(`[FlagEquip] Parallel mode: ${ids.length} users, concurrency=${concurrency}, proxies=${loadedProxies.length}`);
      let index = 0;
      const worker = async () => {
        for (;;) {
          const i = index++;
          if (i >= ids.length) break;
          await doOne(ids[i]);
          const cd = Math.max(0, Number(currentSettings.purchaseCooldown || 0));
          if (cd > 0) await sleep(cd);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } else {
      for (let i = 0; i < userIds.length; i++) {
        await doOne(String(userIds[i]));
        if (i < userIds.length - 1 && cooldown > 0) await sleep(cooldown);
      }
    }

    equipFlagJob.active = false; equipFlagJob.finishedAt = Date.now();
    res.json({ flagId: fid, cooldownMs: cooldown, report });
  } catch (e) {
    equipFlagJob.active = false; equipFlagJob.finishedAt = Date.now();
    res.status(500).json({ error: 'Internal error' });
  }
});
app.get("/users/equip-flag/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = equipFlagJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});

// --- API: users batch unequip flag (flagId=0) ---
let unequipFlagJob = { active: false, total: 0, completed: 0, startedAt: 0, finishedAt: 0, lastUserId: null, lastUserName: null };
app.post("/users/unequip-flag", async (req, res) => {
  try {
    const { userIds } = req.body || {};
    if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: "userIds must be a non-empty array" });
    if (unequipFlagJob.active) return res.status(409).json({ error: "unequip_in_progress" });
    unequipFlagJob = { active: true, total: userIds.length, completed: 0, startedAt: Date.now(), finishedAt: 0, lastUserId: null, lastUserName: null };

    const dummyTemplate = { width: 0, height: 0, data: [] };
    const dummyCoords = [0, 0, 0, 0];
    const report = [];
    const cooldown = currentSettings.purchaseCooldown || 0;

    const doOne = async (uid) => {
      if (!users[uid]) { report.push({ userId: uid, error: 'not_found' }); unequipFlagJob.completed++; return; }
      if (activeBrowserUsers.has(uid)) { report.push({ userId: uid, error: 'busy' }); unequipFlagJob.completed++; return; }
      activeBrowserUsers.add(uid);
      const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "FlagUnequipBatch");
      try {
        await w.login(users[uid].cookies); await w.loadUserInfo();
        unequipFlagJob.lastUserId = uid; unequipFlagJob.lastUserName = w.userInfo?.name;
        await w.equipFlag(0);
        await w.loadUserInfo().catch(() => {});
        report.push({ userId: uid, name: w.userInfo?.name, ok: true, success: true, equippedFlag: Number(w.userInfo?.equippedFlag || 0) });
      } catch (e) {
        logUserError(e, uid, users[uid]?.name || `#${uid}`, "unequip flag batch");
        report.push({ userId: uid, name: users[uid]?.name || `#${uid}`, error: e?.message || 'failed' });
      } finally {
        activeBrowserUsers.delete(uid);
        unequipFlagJob.completed++;
      }
    };

    const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    if (useParallel) {
      const ids = userIds.map(String);
      const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
      const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
      console.log(`[FlagUnequip] Parallel mode: ${ids.length} users, concurrency=${concurrency}, proxies=${loadedProxies.length}`);
      let index = 0;
      const worker = async () => {
        for (;;) {
          const i = index++;
          if (i >= ids.length) break;
          await doOne(ids[i]);
          const cd = Math.max(0, Number(currentSettings.purchaseCooldown || 0));
          if (cd > 0) await sleep(cd);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } else {
      for (let i = 0; i < userIds.length; i++) {
        await doOne(String(userIds[i]));
        if (i < userIds.length - 1 && cooldown > 0) await sleep(cooldown);
      }
    }

    unequipFlagJob.active = false; unequipFlagJob.finishedAt = Date.now();
    res.json({ cooldownMs: cooldown, report });
  } catch (e) {
    unequipFlagJob.active = false; unequipFlagJob.finishedAt = Date.now();
    res.status(500).json({ error: 'Internal error' });
  }
});
app.get("/users/unequip-flag/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = unequipFlagJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});
// --- API: users colors check (parallel with proxies, else sequential) ---
app.post("/users/colors-check", async (req, res) => {
  try {
    if (colorsCheckJob.active) {
      return res.status(409).json({ error: "colors_check_in_progress" });
    }

    const cooldown = currentSettings.accountCheckCooldown || 0;

    const dummyTemplate = { width: 0, height: 0, data: [] };
    const dummyCoords = [0, 0, 0, 0];

    const ids = Object.keys(users);
    colorsCheckJob = {
      active: true,
      total: ids.length,
      completed: 0,
      startedAt: Date.now(),
      finishedAt: 0,
      lastUserId: null,
      lastUserName: null,
      report: []
    };

    const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    if (useParallel) {
      const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
      const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
      console.log(`[ColorsCheck] Parallel: ${ids.length} accounts (concurrency=${concurrency}, proxies=${loadedProxies.length})`);
      let index = 0;
      const worker = async () => {
        for (; ;) {
          const i = index++;
          if (i >= ids.length) break;
          const uid = String(ids[i]);
          const urec = users[uid];
          if (!urec) { continue; }

          colorsCheckJob.lastUserId = uid;
          colorsCheckJob.lastUserName = urec?.name || `#${uid}`;

          if (activeBrowserUsers.has(uid)) {
            colorsCheckJob.report.push({ userId: uid, name: urec.name, skipped: true, reason: "busy" });
            colorsCheckJob.completed++;
            continue;
          }

          activeBrowserUsers.add(uid);
          const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "ColorsCheck");
          try {
            await w.login(urec.cookies);
            await w.loadUserInfo();
            const u = w.userInfo || {};
            const charges = { count: Math.floor(Number(u?.charges?.count || 0)), max: Number(u?.charges?.max || 0) };
            const levelNum = Number(u?.level || 0);
            const level = Math.floor(levelNum);
            const progress = Math.round((levelNum % 1) * 100);
            colorsCheckJob.report.push({ userId: uid, name: u?.name || urec.name, extraColorsBitmap: String(u?.extraColorsBitmap || "0"), droplets: Number(u?.droplets || 0), charges, level, progress, flagsBitmap: String(u?.flagsBitmap || ""), equippedFlag: Number(u?.equippedFlag || 0) });
          } catch (e) {
            logUserError(e, uid, urec.name, "colors check");
            colorsCheckJob.report.push({ userId: uid, name: urec.name, error: e?.message || "login_failed" });
          } finally {
            activeBrowserUsers.delete(uid);
            colorsCheckJob.completed++;
          }
          const cd = Math.max(0, Number(currentSettings.accountCheckCooldown || 0));
          if (cd > 0) await sleep(cd);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } else {
      console.log(`[ColorsCheck] Sequential: ${ids.length} accounts. Cooldown=${cooldown}ms`);
      for (let i = 0; i < ids.length; i++) {
        const uid = String(ids[i]);
        const urec = users[uid];
        if (!urec) { continue; }

        colorsCheckJob.lastUserId = uid;
        colorsCheckJob.lastUserName = urec?.name || `#${uid}`;

        if (activeBrowserUsers.has(uid)) {
          colorsCheckJob.report.push({ userId: uid, name: urec.name, skipped: true, reason: "busy" });
          colorsCheckJob.completed++;
          continue;
        }

        activeBrowserUsers.add(uid);
        const w = new WPlacer(dummyTemplate, dummyCoords, currentSettings, "ColorsCheck");
        try {
          await w.login(urec.cookies);
          await w.loadUserInfo();
          const u = w.userInfo || {};
          const charges = { count: Math.floor(Number(u?.charges?.count || 0)), max: Number(u?.charges?.max || 0) };
          const levelNum = Number(u?.level || 0);
          const level = Math.floor(levelNum);
          const progress = Math.round((levelNum % 1) * 100);
          colorsCheckJob.report.push({ userId: uid, name: u?.name || urec.name, extraColorsBitmap: String(u?.extraColorsBitmap || "0"), droplets: Number(u?.droplets || 0), charges, level, progress, flagsBitmap: String(u?.flagsBitmap || ""), equippedFlag: Number(u?.equippedFlag || 0) });
        } catch (e) {
          logUserError(e, uid, urec.name, "colors check");
          colorsCheckJob.report.push({ userId: uid, name: urec.name, error: e?.message || "login_failed" });
        } finally {
          activeBrowserUsers.delete(uid);
          colorsCheckJob.completed++;
        }

        if (i < ids.length - 1 && cooldown > 0) {
          await sleep(cooldown);
        }
      }
    }

    colorsCheckJob.active = false;
    colorsCheckJob.finishedAt = Date.now();
    console.log(`[ColorsCheck] Finished: ${colorsCheckJob.completed}/${colorsCheckJob.total} in ${duration(colorsCheckJob.finishedAt - colorsCheckJob.startedAt)}.`);

    res.json({ ok: true, ts: colorsCheckJob.finishedAt || Date.now(), cooldownMs: cooldown, report: colorsCheckJob.report });
  } catch (e) {
    colorsCheckJob.active = false;
    colorsCheckJob.finishedAt = Date.now();
    console.error("colors-check failed:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// progress endpoint for colors-check
app.get("/users/colors-check/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = colorsCheckJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});

// progress endpoint for purchase-color
app.get("/users/purchase-color/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = purchaseColorJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});

// progress endpoint for buy-max-upgrades
app.get("/users/buy-max-upgrades/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = buyMaxJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});

// progress endpoint for buy-charges
app.get("/users/buy-charges/progress", (req, res) => {
  const { active, total, completed, startedAt, finishedAt, lastUserId, lastUserName } = buyChargesJob;
  res.json({ active, total, completed, startedAt, finishedAt, lastUserId, lastUserName });
});

// --- API: templates ---
app.get("/templates", (_, res) => {
  const sanitized = {};
  for (const id in templates) {
    const t = templates[id];
    sanitized[id] = {
      name: t.name,
      template: t.template,
      coords: t.coords,
      canBuyCharges: t.canBuyCharges,
      canBuyMaxCharges: t.canBuyMaxCharges,
      autoBuyNeededColors: !!t.autoBuyNeededColors,
      antiGriefMode: t.antiGriefMode,

      skipPaintedPixels: t.skipPaintedPixels,
      outlineMode: t.outlineMode,
      paintTransparentPixels: t.paintTransparentPixels,
      userIds: t.userIds,
      running: t.running,
      status: t.status,
      pixelsRemaining: t.pixelsRemaining,
      totalPixels: t.totalPixels,
      heatmapEnabled: !!t.heatmapEnabled,
      heatmapLimit: Math.max(0, Math.floor(Number(t.heatmapLimit || 10000))),
      autoStart: !!t.autoStart
    };
  }
  res.json(sanitized);
});

app.get("/template/:id", (req, res) => {
  const { id } = req.params;
  const t = templates[id];
  if (!t) return res.sendStatus(404);
  const sanitized = {
    name: t.name,
    template: t.template,
    coords: t.coords,
    canBuyCharges: t.canBuyCharges,
    canBuyMaxCharges: t.canBuyMaxCharges,
    autoBuyNeededColors: !!t.autoBuyNeededColors,
    antiGriefMode: t.antiGriefMode,

    skipPaintedPixels: t.skipPaintedPixels,
    outlineMode: t.outlineMode,
    paintTransparentPixels: t.paintTransparentPixels,
    userIds: t.userIds,
    running: t.running,
    status: t.status,
    pixelsRemaining: t.pixelsRemaining,
    totalPixels: t.totalPixels,
    heatmapEnabled: !!t.heatmapEnabled,
    heatmapLimit: Math.max(0, Math.floor(Number(t.heatmapLimit || 10000))),
    autoStart: !!t.autoStart
  };
  res.json(sanitized);
});

app.post("/template", async (req, res) => {
  const { templateName, template, coords, userIds, canBuyCharges, canBuyMaxCharges, antiGriefMode, paintTransparentPixels, skipPaintedPixels, outlineMode, heatmapEnabled, heatmapLimit, autoStart } = req.body;
  if (!templateName || !template || !coords || !userIds || !userIds.length) return res.sendStatus(400);
  if (Object.values(templates).some((t) => t.name === templateName)) {
    return res.status(409).json({ error: "A template with this name already exists." });
  }
  const templateId = Date.now().toString();
  templates[templateId] = new TemplateManager(
    templateName,
    template,
    coords,
    canBuyCharges,
    canBuyMaxCharges,
    antiGriefMode,
    userIds,
    !!paintTransparentPixels,
    skipPaintedPixels,
    outlineMode
  );
  if (typeof req.body.autoBuyNeededColors !== 'undefined') {
    templates[templateId].autoBuyNeededColors = !!req.body.autoBuyNeededColors;
    if (templates[templateId].autoBuyNeededColors) {
      templates[templateId].canBuyCharges = false;
      templates[templateId].canBuyMaxCharges = false;
    }
  }
  // Heatmap settings
  try {
    templates[templateId].heatmapEnabled = !!heatmapEnabled;
    const lim = Math.max(0, Math.floor(Number(heatmapLimit)));
    templates[templateId].heatmapLimit = lim > 0 ? lim : 10000;
  } catch (_) { templates[templateId].heatmapEnabled = false; templates[templateId].heatmapLimit = 10000; }
  
  // Auto-start setting
  templates[templateId].autoStart = !!autoStart;
  
  saveTemplates();
  res.status(200).json({ id: templateId });
});

app.delete("/template/:id", async (req, res) => {
  const { id } = req.params;
  if (!id || !templates[id] || templates[id].running) return res.sendStatus(400);
  delete templates[id];
  saveTemplates();
  res.sendStatus(200);
});

app.put("/template/edit/:id", async (req, res) => {
  const { id } = req.params;
  if (!templates[id]) return res.sendStatus(404);
  const manager = templates[id];

  const { templateName, coords, userIds, canBuyCharges, canBuyMaxCharges, antiGriefMode, template, paintTransparentPixels, skipPaintedPixels, outlineMode, heatmapEnabled, heatmapLimit, autoStart } = req.body;

  const prevCoords = manager.coords;
  const prevTemplateStr = JSON.stringify(manager.template);

  manager.name = templateName;
  // update coords only if provided as valid array of 4 numbers
  let coordsChanged = false;
  if (Array.isArray(coords) && coords.length === 4) {
    const newCoords = coords.map((n) => Number(n));
    coordsChanged = JSON.stringify(prevCoords) !== JSON.stringify(newCoords);
    manager.coords = newCoords;
  }
  manager.userIds = userIds;
  manager.canBuyCharges = canBuyCharges;
  manager.canBuyMaxCharges = canBuyMaxCharges;
  manager.antiGriefMode = antiGriefMode;
  manager.skipPaintedPixels = skipPaintedPixels;
  manager.outlineMode = outlineMode;
  if (typeof req.body.autoBuyNeededColors !== 'undefined') {
    manager.autoBuyNeededColors = !!req.body.autoBuyNeededColors;
    if (manager.autoBuyNeededColors) {
      manager.canBuyCharges = false;
      manager.canBuyMaxCharges = false;
    }
  }

  if (typeof paintTransparentPixels !== "undefined") {
    manager.paintTransparentPixels = !!paintTransparentPixels;
  }
  // Heatmap settings
  try {
    manager.heatmapEnabled = !!heatmapEnabled;
    const lim = Math.max(0, Math.floor(Number(heatmapLimit)));
    manager.heatmapLimit = lim > 0 ? lim : 10000;
  } catch (_) { }
  
  // Auto-start setting
  if (typeof autoStart !== 'undefined') {
    manager.autoStart = !!autoStart;
  }

  let templateChanged = false;
  if (template) {
    templateChanged = JSON.stringify(template) !== prevTemplateStr;
    manager.template = template;
  }

  manager.masterId = manager.userIds[0];
  manager.masterName = users[manager.masterId]?.name || "Unknown";

  // reset seeds + clear heatmap if image or coords actually changed
  if (templateChanged || coordsChanged) {
    manager.burstSeeds = null;
    // Also clear heatmap history if coordinates changed
    try {
      const filePath = path.join(heatMapsDir, `${id}.jsonl`);
      if (existsSync(filePath)) writeFileSync(filePath, "");
    } catch (_) { }
  }

  // recompute totals
  manager.totalPixels = manager.template?.data
    ? manager.template.data.flat().filter((p) => (manager.paintTransparentPixels ? p >= 0 : p > 0)).length
    : 0;

  // reset remaining counter if template definition changed or totals differ
  try {
    if (!manager.running) {
      manager.pixelsRemaining = manager.totalPixels;
      manager.status = "Waiting to be started.";
    }
  } catch (_) { }

  saveTemplates();
  res.sendStatus(200);
});

// Clear heatmap history for a template
app.delete("/template/:id/heatmap", (req, res) => {
  const { id } = req.params;
  if (!id) return res.sendStatus(400);
  const filePath = path.join(heatMapsDir, `${id}.jsonl`);
  try {
    if (existsSync(filePath)) writeFileSync(filePath, "");
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e && e.message || e) });
  }
});

app.put("/template/:id", async (req, res) => {
  const { id } = req.params;
  if (!id || !templates[id]) return res.sendStatus(400);
  const manager = templates[id];
  if (req.body.running && !manager.running) {
    manager.start().catch((error) => log(id, manager.masterName, "Error starting template", error));
  } else {
    if (manager.running && req.body.running === false) {
      log("SYSTEM", "wplacer", `[${manager.name}] ⏹️ Template manually stopped by user.`);
    }
    manager.running = false;
    try { if (typeof manager.interruptSleep === 'function') manager.interruptSleep(); } catch (_) { }
  }
  res.sendStatus(200);
});

// --- API: settings (now only drawingMethod + seedCount relevant from paint side) ---
app.get("/settings", (_, res) => res.json({ ...currentSettings, proxyCount: loadedProxies.length }));
app.post("/reload-proxies", (req, res) => {
  loadProxies();
  res.status(200).json({ success: true, count: loadedProxies.length });
});
app.get("/test-proxies", async (req, res) => {
  try {
    if (!currentSettings.proxyEnabled || loadedProxies.length === 0) {
      return res.status(400).json({ error: "no_proxies_loaded" });
    }

    const concurrency = Math.max(1, Math.min(32, parseInt(String(req.query.concurrency || "5"), 10) || 5));
    const target = String(req.query.target || "tile").toLowerCase();
    const isMe = target === "me";
    const targetUrl = isMe
      ? "https://bplace.org/me"
      : String(req.query.url || "https://bplace.org/files/s0/tiles/0/0.png");

    const toTest = loadedProxies.map((p, i) => ({
      idx: Number(p._idx) || (i + 1),
      host: p.host,
      port: p.port,
      protocol: p.protocol,
      username: p.username,
      password: p.password
    }));

    const cloudflareRe = /cloudflare|attention required|access denied|just a moment|cf-ray|challenge-form|cf-chl/i;
    const buildProxyUrl = (p) => {
      let s = `${p.protocol}://`;
      if (p.username && p.password) s += `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`;
      s += `${p.host}:${p.port}`;
      return s;
    };

    const results = new Array(toTest.length);
    let cursor = 0;
    const runWorker = async () => {
      while (true) {
        const n = cursor++;
        if (n >= toTest.length) return;
        const item = toTest[n];
        const started = Date.now();
        let outcome = { idx: item.idx, proxy: `${item.host}:${item.port}`, ok: false, status: 0, reason: "", elapsedMs: 0 };
        try {
          const imp = new Impit({ browser: "chrome", ignoreTlsErrors: true, proxyUrl: buildProxyUrl(item), userId: "proxy-test" });
          try { log("SYSTEM", "wplacer", `🧪 Testing proxy #${item.idx} (${item.host}:${item.port}) target=${isMe ? '/me' : '/tile'}`); } catch (_) { }

          const controller = new AbortController();
          const timeoutMs = 10000;
          const t = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const r = await imp.fetch(targetUrl, {
              headers: isMe
                ? {
                  Accept: "application/json, text/plain, */*",
                  "X-Requested-With": "XMLHttpRequest",
                  Referer: "https://bplace.org/",
                  Origin: "https://bplace.org",
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
                  "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
                  "Sec-Fetch-Dest": "empty",
                  "Sec-Fetch-Mode": "cors",
                  "Sec-Fetch-Site": "same-origin"
                }
                : { Accept: "image/*", Referer: "https://bplace.org/" },
              redirect: "manual",
              signal: controller.signal
            });
            clearTimeout(t);
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            if (!isMe) {
              if (r.ok && (ct.includes("image/") || ct.includes("application/octet-stream"))) {
                outcome.ok = true;
                outcome.status = r.status;
                outcome.reason = "ok";
              } else {
                let text = "";
                try { text = await r.text(); } catch (_) { text = ""; }
                if (cloudflareRe.test(text)) {
                  outcome.reason = "cloudflare_block";
                } else if (r.status) {
                  outcome.reason = `http_${r.status}`;
                } else {
                  outcome.reason = (text || "non_image_response").slice(0, 140);
                }
                outcome.status = r.status || 0;
              }
            } else {
              // Strict /me target: OK if reachable without CF challenge (expect 401 JSON or 200 JSON)
              let text = "";
              try { text = await r.text(); } catch (_) { text = ""; }
              if (cloudflareRe.test(text)) {
                outcome.ok = false;
                outcome.reason = "cloudflare_block";
              } else if (r.status >= 300 && r.status < 400) {
                outcome.ok = false;
                outcome.reason = `redirect_${r.status}`;
              } else if (ct.includes("application/json")) {
                outcome.ok = (r.status === 200 || r.status === 401);
                outcome.reason = r.status === 200 ? "ok_me_200" : (r.status === 401 ? "ok_me_401" : `http_${r.status}`);
              } else if (r.status === 403) {
                outcome.ok = false;
                outcome.reason = "http_403";
              } else {
                outcome.ok = false;
                outcome.reason = (text || `http_${r.status || 0}`).slice(0, 140);
              }
              outcome.status = r.status || 0;
            }
          } catch (e) {
            if (String(e && e.name).toLowerCase() === "aborterror") {
              outcome.reason = "timeout";
            } else {
              const msg = String(e && (e.message || e)).toLowerCase();
              if (/econnreset|timeout|timed out|socket hang up|enotfound|econnrefused|reqwest::error|hyper_util/i.test(msg)) {
                outcome.reason = "network_error";
              } else {
                outcome.reason = (e && (e.message || String(e)) || "error").slice(0, 160);
              }
            }
          }
        } catch (e) {
          outcome.reason = (e && (e.message || String(e)) || "error").slice(0, 160);
        } finally {
          outcome.elapsedMs = Date.now() - started;
          results[n] = outcome;
          try {
            const tag = outcome.ok ? 'OK' : 'BLOCKED';
            log("SYSTEM", "wplacer", `🧪 Proxy #${outcome.idx} ${tag} (${outcome.status}) ${outcome.reason}; ${outcome.elapsedMs} ms`);
          } catch (_) { }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, toTest.length) }, () => runWorker()));
    const okCount = results.filter(r => r && r.ok).length;
    const blockedCount = results.length - okCount;
    res.json({ total: results.length, ok: okCount, blocked: blockedCount, results });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

app.get("/test-proxy", async (req, res) => {
  try {
    if (!currentSettings.proxyEnabled || loadedProxies.length === 0) {
      return res.status(400).json({ error: "no_proxies_loaded" });
    }
    const idx = Math.max(1, parseInt(String(req.query.idx || "0"), 10) || 0);
    const target = String(req.query.target || "me").toLowerCase();
    const isMe = target === "me";
    const targetUrl = isMe ? "https://bplace.org/me" : "https://bplace.org/files/s0/tiles/0/0.png";

    const p = loadedProxies.find((x, i) => Number(x._idx) === idx) || loadedProxies[idx - 1];
    if (!p) return res.status(404).json({ error: "proxy_not_found" });

    const cloudflareRe = /cloudflare|attention required|access denied|just a moment|cf-ray|challenge-form|cf-chl/i;
    const buildProxyUrl = (pp) => {
      let s = `${pp.protocol}://`;
      if (pp.username && pp.password) s += `${encodeURIComponent(pp.username)}:${encodeURIComponent(pp.password)}@`;
      s += `${pp.host}:${pp.port}`;
      return s;
    };

    const started = Date.now();
    let outcome = { idx, proxy: `${p.host}:${p.port}`, ok: false, status: 0, reason: "", elapsedMs: 0 };
    try {
      const imp = new Impit({ browser: "chrome", ignoreTlsErrors: true, proxyUrl: buildProxyUrl(p), userId: "proxy-test" });
      try { log("SYSTEM", "wplacer", `🧪 Testing proxy #${idx} (${p.host}:${p.port}) target=${isMe ? '/me' : '/tile'}`); } catch (_) { }
      const controller = new AbortController();
      const timeoutMs = 10000;
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await imp.fetch(targetUrl, {
          headers: isMe
            ? {
              Accept: "application/json, text/plain, */*",
              "X-Requested-With": "XMLHttpRequest",
              Referer: "https://bplace.org/",
              Origin: "https://bplace.org",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
              "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin"
            }
            : { Accept: "image/*", Referer: "https://bplace.org/" },
          redirect: "manual",
          signal: controller.signal
        });
        clearTimeout(t);
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        if (!isMe) {
          if (r.ok && (ct.includes("image/") || ct.includes("application/octet-stream"))) {
            outcome.ok = true;
            outcome.status = r.status;
            outcome.reason = "ok";
          } else {
            let text = "";
            try { text = await r.text(); } catch (_) { text = ""; }
            if (cloudflareRe.test(text)) outcome.reason = "cloudflare_block";
            else if (r.status) outcome.reason = `http_${r.status}`;
            else outcome.reason = (text || "non_image_response").slice(0, 140);
            outcome.status = r.status || 0;
          }
        } else {
          let text = "";
          try { text = await r.text(); } catch (_) { text = ""; }
          if (cloudflareRe.test(text)) { outcome.ok = false; outcome.reason = "cloudflare_block"; }
          else if (r.status >= 300 && r.status < 400) { outcome.ok = false; outcome.reason = `redirect_${r.status}`; }
          else if (ct.includes("application/json")) { outcome.ok = (r.status === 200 || r.status === 401); outcome.reason = r.status === 200 ? "ok_me_200" : (r.status === 401 ? "ok_me_401" : `http_${r.status}`); }
          else if (r.status === 403) { outcome.ok = false; outcome.reason = "http_403"; }
          else { outcome.ok = false; outcome.reason = (text || `http_${r.status || 0}`).slice(0, 140); }
          outcome.status = r.status || 0;
        }
      } catch (e) {
        if (String(e && e.name).toLowerCase() === "aborterror") outcome.reason = "timeout";
        else {
          const msg = String(e && (e.message || e)).toLowerCase();
          if (/econnreset|timeout|timed out|socket hang up|enotfound|econnrefused|reqwest::error|hyper_util/i.test(msg)) outcome.reason = "network_error";
          else outcome.reason = (e && (e.message || String(e)) || "error").slice(0, 160);
        }
      }
    } catch (e) {
      outcome.reason = (e && (e.message || String(e)) || "error").slice(0, 160);
    } finally {
      outcome.elapsedMs = Date.now() - started;
      try {
        const tag = outcome.ok ? 'OK' : 'BLOCKED';
        log("SYSTEM", "wplacer", `🧪 Proxy #${idx} ${tag} (${outcome.status}) ${outcome.reason}; ${outcome.elapsedMs} ms`);
      } catch (_) { }
    }
    res.json(outcome);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

app.post("/proxies/cleanup", (req, res) => {
  try {
    const keepIdx = Array.isArray(req.body?.keepIdx) ? req.body.keepIdx.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0) : null;
    const removeIdx = Array.isArray(req.body?.removeIdx) ? req.body.removeIdx.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0) : null;
    if (!keepIdx && !removeIdx) return res.status(400).json({ error: "no_selection" });

    const proxyPath = path.join(dataDir, "proxies.txt");
    const backupPath = path.join(proxiesBackupsDir, `proxies.backup-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}.txt`);
    try { writeFileSync(backupPath, readFileSync(proxyPath, "utf8")); } catch (_) { }

    const byIdx = new Map();
    for (const p of loadedProxies) {
      const index = Number(p._idx) || (loadedProxies.indexOf(p) + 1);
      byIdx.set(index, p);
    }
    const shouldKeep = (idx) => {
      if (keepIdx) return keepIdx.includes(idx);
      if (removeIdx) return !removeIdx.includes(idx);
      return true;
    };
    const kept = [];
    for (const [idx, p] of byIdx.entries()) {
      if (!shouldKeep(idx)) continue;
      const auth = (p.username && p.password) ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : "";
      kept.push(`${p.protocol}://${auth}${p.host}:${p.port}`);
    }
    writeFileSync(proxyPath, kept.join("\n") + (kept.length ? "\n" : ""));
    loadProxies();
    res.json({ success: true, kept: kept.length, removed: byIdx.size - kept.length, backup: path.basename(backupPath), count: loadedProxies.length });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});
app.put("/settings", (req, res) => {
  const patch = { ...req.body };
  // merge nested logCategories toggles
  if (patch.logCategories && typeof patch.logCategories === 'object') {
    const curr = currentSettings.logCategories || {};
    currentSettings.logCategories = { ...curr, ...patch.logCategories };
    delete patch.logCategories;
  }
  if (typeof patch.logMaskPii !== 'undefined') {
    currentSettings.logMaskPii = !!patch.logMaskPii;
    delete patch.logMaskPii;
  }

  // sanitize seedCount like in old version
  if (typeof patch.seedCount !== "undefined") {
    let n = Number(patch.seedCount);
    if (!Number.isFinite(n)) n = 2;
    n = Math.max(1, Math.min(16, Math.floor(n)));
    patch.seedCount = n;
  }

  // sanitize chargeThreshold
  if (typeof patch.chargeThreshold !== "undefined") {
    let t = Number(patch.chargeThreshold);
    if (!Number.isFinite(t)) t = 0.5;
    t = Math.max(0, Math.min(1, t));
    patch.chargeThreshold = t;
  }

  // sanitize maxPixelsPerPass (0 = unlimited)
  if (typeof patch.maxPixelsPerPass !== "undefined") {
    let m = Number(patch.maxPixelsPerPass);
    if (!Number.isFinite(m)) m = 0;
    m = Math.max(0, Math.floor(m));
    patch.maxPixelsPerPass = m;
  }

  const oldSettings = { ...currentSettings };
  currentSettings = { ...currentSettings, ...patch };
  saveSettings();

  // if cooldown/threshold changed — refresh runtime timers without restart
  const accountCooldownChanged = oldSettings.accountCooldown !== currentSettings.accountCooldown;
  const thresholdChanged = oldSettings.chargeThreshold !== currentSettings.chargeThreshold;
  if (accountCooldownChanged || thresholdChanged) {
    for (const id in templates) {
      const m = templates[id]; if (!m) continue;
      if (typeof m._summaryMinIntervalMs === 'number') {
        const ac = currentSettings.accountCooldown || 0;
        m._summaryMinIntervalMs = Math.max(2 * ac, 5000);
      }
      if (m.running && typeof m.interruptSleep === 'function') m.interruptSleep();
    }
  }

  res.sendStatus(200);
});

// --- API: canvas passthrough (unchanged) ---
app.get("/canvas", async (req, res) => {
  const { tx, ty } = req.query;
  if (isNaN(parseInt(tx)) || isNaN(parseInt(ty))) return res.sendStatus(400);
  try {
    const url = `https://bplace.org/files/s0/tiles/${tx}/${ty}.png`;
    let buffer;

    // Get authentication cookies from any logged-in user or manual cookies
    let authCookies = null;
    if (manualCookies.j && (manualCookies.cf_clearance || manualCookies.s)) {
      // Check if cf_clearance token is still valid, auto-refresh if needed
      let clearanceCookie = manualCookies.cf_clearance || manualCookies.s;

      if (!(await isCfTokenValid(clearanceCookie))) {
        console.log('🤖 [TILES] cf_clearance token invalid, attempting auto-refresh...');
        const autoToken = await autoGetCfTokenAndInterruptQueues();
        if (autoToken) {
          clearanceCookie = autoToken;
        }
      }

      if (clearanceCookie) {
        authCookies = {
          j: manualCookies.j,
          cf_clearance: clearanceCookie
        };
      }
    } else {
      // Try to find cookies from any logged-in user
      const userIds = Object.keys(users);
      for (const userId of userIds) {
        const user = users[userId];
        if (user && user.cookies && user.cookies.j) {
          authCookies = user.cookies;
          break;
        }
      }
    }

    const headers = { Accept: "image/*" };
    if (authCookies) {
      const cookieHeader = Object.keys(authCookies)
        .map(key => `${key}=${authCookies[key]}`)
        .join('; ');
      headers['Cookie'] = cookieHeader;
      console.log(`🔥 [DEBUG] Canvas request with auth cookies for ${url}`);
    } else {
      console.log(`🔥 [DEBUG] Canvas request without auth cookies for ${url}`);
    }

    const useProxy = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
    if (useProxy) {
      // Fetch via Impit to respect proxy settings with authentication
      const impitOptions = { browser: "chrome", ignoreTlsErrors: true, userId: "canvas-fetch" };
      const proxySel = getNextProxy();
      if (proxySel) {
        impitOptions.proxyUrl = proxySel.url;
        if (currentSettings.logProxyUsage) {
          log("SYSTEM", "wplacer", `Using proxy #${proxySel.idx}: ${proxySel.display}`);
        }
      }
      const imp = new Impit(impitOptions);
      const resp = await imp.fetch(url, { headers });
      if (!resp.ok) {
        console.log(`🔥 [DEBUG] Canvas proxy fetch failed: ${resp.status} ${resp.statusText}`);
        if (resp.status === 403) {
          return res.status(403).json({ error: "Access denied by upstream server. Check authentication cookies or CF-Clearance tokens." });
        }
        return res.sendStatus(resp.status);
      }
      const respClone = resp.clone();
      buffer = Buffer.from(await respClone.arrayBuffer());
    } else {
      // Используем MockImpit даже без прокси для поддержки CF-Clearance
      const impitOptions = { browser: "chrome", ignoreTlsErrors: true, userId: "canvas-fetch" };
      const imp = new Impit(impitOptions);
      const response = await imp.fetch(url, { headers });
      if (!response.ok) {
        console.log(`🔥 [DEBUG] Canvas fetch failed: ${response.status} ${response.statusText}`);
        if (response.status === 403) {
          return res.status(403).json({ error: "Access denied by upstream server. Check authentication cookies or CF-Clearance tokens." });
        }
        return res.sendStatus(response.status);
      }
      const responseClone = response.clone();
      buffer = Buffer.from(await responseClone.arrayBuffer());
    }

    res.json({ image: `data:image/png;base64,${buffer.toString("base64")}` });
  } catch (error) {
    console.log(`🔥 [DEBUG] Canvas error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// (heatmap API removed)

// --- API: version check ---
app.get("/version", async (_req, res) => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    const local = String(pkg.version || "0.0.0");
    let latest = local;
    try {
      const r = await fetch("https://raw.githubusercontent.com/13MrBlackCat13/bplacer/main/package.json", { cache: "no-store" });
      if (r.ok) {
        const remote = await r.json();
        latest = String(remote.version || latest);
      }
    } catch (_) { }

    const cmp = (a, b) => {
      const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0, db = pb[i] || 0;
        if (da !== db) return da - db;
      }
      return 0;
    };
    const outdated = cmp(local, latest) < 0;
    res.json({ local, latest, outdated });
  } catch (e) {
    res.status(500).json({ error: "version_check_failed" });
  }
});

// --- API: changelog (local + remote) ---
app.get("/changelog", async (_req, res) => {
  try {
    let local = "";
    try { local = readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8"); } catch (_) { }
    let remote = "";
    try {
      const r = await fetch("https://raw.githubusercontent.com/13MrBlackCat13/bplacer/main/CHANGELOG.md", { cache: "no-store" });
      if (r.ok) remote = await r.text();
    } catch (_) { }
    res.json({ local, remote });
  } catch (e) {
    res.status(500).json({ error: "changelog_fetch_failed" });
  }
});


// --- Keep-Alive (parallel with proxies) ---
const keepAlive = async () => {
  if (activeBrowserUsers.size > 0) {
    log("SYSTEM", "wplacer", "⚙️ Deferring keep-alive check: a browser operation is active.");
    return;
  }

  const allIds = Object.keys(users);
  const candidates = allIds.filter((uid) => {
    if (activeBrowserUsers.has(uid)) return false;
    const rec = users[uid];
    if (!rec) return false;
    if (rec.authFailureUntil && Date.now() < rec.authFailureUntil) return false;
    return true;
  });
  if (candidates.length === 0) {
    log("SYSTEM", "wplacer", "⚙️ Keep-alive: no idle users to check.");
    return;
  }

  const useParallel = !!currentSettings.proxyEnabled && loadedProxies.length > 0;
  if (useParallel) {
    // Run in parallel using a pool roughly equal to proxy count (capped)
    const desired = Math.max(1, Math.floor(Number(currentSettings.parallelWorkers || 0)) || 1);
    const concurrency = Math.max(1, Math.min(desired, loadedProxies.length || desired, 32));
    log("SYSTEM", "wplacer", `⚙️ Performing parallel keep-alive for ${candidates.length} users (concurrency=${concurrency}, proxies=${loadedProxies.length}).`);

    let index = 0;
    const worker = async () => {
      for (; ;) {
        const myIndex = index++;
        if (myIndex >= candidates.length) break;
        const userId = candidates[myIndex];
        if (!users[userId]) continue;
        if (activeBrowserUsers.has(userId)) continue;
        activeBrowserUsers.add(userId);
        const wplacer = new WPlacer();
        try {
          await wplacer.login(users[userId].cookies);
          // Clear auth failure flag on successful keep-alive
          if (users[userId].authFailureUntil) {
            delete users[userId].authFailureUntil;
            saveUsers();
          }
          log(userId, users[userId].name, "✅ Cookie keep-alive successful.");
        } catch (error) {
          // Handle authentication errors in keep-alive
          if (error.message && (error.message.includes("Authentication failed (401)") || error.message.includes("Authentication expired"))) {
            if (!users[userId].authFailureUntil) {
              users[userId].authFailureUntil = Date.now() + (5 * 60 * 1000); // 5 minutes
              saveUsers();
            }
          }
          // Always delegate to unified error logger to keep original messages
          logUserError(error, userId, users[userId].name, "perform keep-alive check");
        } finally {
          activeBrowserUsers.delete(userId);
        }
        const cd = Math.max(0, Number(currentSettings.keepAliveCooldown || 0));
        if (cd > 0) await sleep(cd);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    log("SYSTEM", "wplacer", "✅ Keep-alive check complete (parallel).");
    return;
  }

  // Fallback: sequential with delay between users
  log("SYSTEM", "wplacer", "⚙️ Performing sequential cookie keep-alive check for all users...");
  for (const userId of candidates) {
    if (activeBrowserUsers.has(userId)) {
      log(userId, users[userId].name, "⚠️ Skipping keep-alive check: user is currently busy.");
      continue;
    }
    if (users[userId].authFailureUntil && Date.now() < users[userId].authFailureUntil) {
      log(userId, users[userId].name, "⚠️ Skipping keep-alive check: user has recent auth failure.");
      continue;
    }
    activeBrowserUsers.add(userId);
    const wplacer = new WPlacer();
    try {
      await wplacer.login(users[userId].cookies);
      // Clear auth failure flag on successful keep-alive
      if (users[userId].authFailureUntil) {
        delete users[userId].authFailureUntil;
        saveUsers();
      }
      log(userId, users[userId].name, "✅ Cookie keep-alive successful.");
    } catch (error) {
      // Handle authentication errors in keep-alive
      if (error.message && (error.message.includes("Authentication failed (401)") || error.message.includes("Authentication expired"))) {
        if (!users[userId].authFailureUntil) {
          users[userId].authFailureUntil = Date.now() + (5 * 60 * 1000); // 5 minutes
          saveUsers();
        }
        log(userId, users[userId].name, "🛑 Cookies expired (401/403) - skipping user temporarily");
      } else {
        logUserError(error, userId, users[userId].name, "perform keep-alive check");
      }
    } finally {
      activeBrowserUsers.delete(userId);
    }
    await sleep(currentSettings.keepAliveCooldown);
  }
  log("SYSTEM", "wplacer", "✅ Keep-alive check complete (sequential).");
};

// -- Export JWT Tokens --

app.get('/export-tokens', (req, res) => {
  try {
    const usersPath = path.join(__dirname, 'data', 'users.json');

    if (!fs.existsSync(usersPath)) {
      return res.status(404).send('users.json not found.');
    }

    const rawData = fs.readFileSync(usersPath, 'utf8');
    const users = JSON.parse(rawData);

    // Extract tokens JWT Tokens from each user
    const tokens = Object.values(users)
      .map(user => user.cookies?.j)
      .filter(Boolean)
      .map(s => s.trim());

    if (tokens.length === 0) {
      return res.status(404).send('No tokens found.');
    }

    const textContent = tokens.join('\n');

    // Headers to force download as file.txt
    res.setHeader('Content-Disposition', 'attachment; filename="jwt_tokens.txt"');
    res.setHeader('Content-Type', 'text/plain');
    res.send(textContent);

  } catch (err) {
    console.error('An error ocurred while trying to export tokens:', err);
    res.status(500).send('An error occurred while exporting JWT tokens.');
  }
});

// --- Startup ---
(async () => {
  console.clear();
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  console.log(`\n--- wplacer v${version} made by luluwaffless and jinx | forked/improved by lllexxa | additional improvements by 13MrBlackCat13 ---\n`);
  
  // Add startup message to Live Logs
  addToLiveLogs(`--- wplacer v${version} made by luluwaffless and jinx | forked/improved by lllexxa | additional improvements by 13MrBlackCat13 ---`);

  const loadedTemplates = loadJSON("templates.json");
  for (const id in loadedTemplates) {
    const t = loadedTemplates[id];
    if (t.userIds?.every((uid) => users[uid])) {
      const tm = new TemplateManager(
        t.name,
        t.template,
        t.coords,
        t.canBuyCharges,
        t.canBuyMaxCharges,
        t.antiGriefMode,
        t.userIds,
        !!t.paintTransparentPixels,

        !!t.skipPaintedPixels,
        !!t.outlineMode
      );
      tm.burstSeeds = t.burstSeeds || null;
      tm.autoBuyNeededColors = !!t.autoBuyNeededColors;
      // heatmap settings load
      try {
        tm.heatmapEnabled = !!t.heatmapEnabled;
        const lim = Math.max(0, Math.floor(Number(t.heatmapLimit)));
        tm.heatmapLimit = lim > 0 ? lim : 10000;
      } catch (_) { tm.heatmapEnabled = false; tm.heatmapLimit = 10000; }
      
      // auto-start setting load
      tm.autoStart = !!t.autoStart;
      
      templates[id] = tm;
    } else {
      console.warn(`⚠️ Template "${t.name}" was not loaded because its assigned user(s) no longer exist.`);
    }
  }

  loadProxies();
  console.log(`✅ Loaded ${Object.keys(templates).length} templates, ${Object.keys(users).length} users and ${loadedProxies.length} proxies.`);
  
  // Add loaded data message to Live Logs
  addToLiveLogs(`✅ Loaded ${Object.keys(templates).length} templates, ${Object.keys(users).length} users and ${loadedProxies.length} proxies.`);
  
  const port = Number(process.env.PORT) || 80;
  const host = process.env.HOST || "0.0.0.0";
  const hostname = host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host;

  // Security warning for 0.0.0.0
  if (host === "0.0.0.0") {
    const securityWarning1 = "⚠️  SECURITY WARNING: HOST=0.0.0.0 makes the server accessible from outside your computer!";
    const securityWarning2 = "   For better security, change HOST to 127.0.0.1 in .env file or use run-localhost.bat";
    
    console.log(securityWarning1);
    console.log(securityWarning2);
    console.log("");
    
    // Add security warning to Live Logs
    addToLiveLogs(securityWarning1, 'general', 'warning');
    addToLiveLogs(securityWarning2, 'general', 'warning');
  }

  // Auto token status endpoint
  app.get("/auto-token-status", (req, res) => {
    try {
      const currentToken = manualCookies.cf_clearance || manualCookies.s;
      res.json({
        enabled: autoTokenSettings.enabled,
        isRetrying: autoTokenSettings.isRetrying,
        lastAttempt: autoTokenSettings.lastAttempt,
        hasToken: !!currentToken,
        tokenPreview: currentToken ? currentToken.substring(0, 20) + '...' : null,
        retryDelay: autoTokenSettings.retryDelay
      });
    } catch (error) {
      console.error('❌ Error getting auto token status:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // CF-Clearance Management API endpoints
  app.get("/cf-clearance/stats", (req, res) => {
    try {
      const stats = cfClearanceManager.getStats();
      res.json(stats);
    } catch (error) {
      console.error('❌ Error getting CF-Clearance stats:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/cf-clearance/refresh/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const { proxyUrl } = req.body;

      let proxyInfo = null;
      if (proxyUrl) {
        try {
          const url = new URL(proxyUrl);
          proxyInfo = {
            protocol: url.protocol.replace(':', ''),
            host: url.hostname,
            port: parseInt(url.port),
            username: decodeURIComponent(url.username || ''),
            password: decodeURIComponent(url.password || '')
          };
        } catch (error) {
          return res.status(400).json({ error: 'Invalid proxy URL format' });
        }
      }

      const result = await cfClearanceManager.refreshClearance(proxyInfo, userId);
      if (result) {
        res.json({ success: true, message: 'CF-Clearance token refreshed successfully' });
      } else {
        res.status(500).json({ error: 'Failed to refresh CF-Clearance token' });
      }
    } catch (error) {
      console.error('❌ Error refreshing CF-Clearance:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/cf-clearance/cleanup", (req, res) => {
    try {
      cfClearanceManager.cleanupExpiredTokens();
      res.json({ success: true, message: 'Expired CF-Clearance tokens cleaned up' });
    } catch (error) {
      console.error('❌ Error cleaning up CF-Clearance tokens:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/cf-clearance/list", (req, res) => {
    try {
      const tokens = [];
      for (const [key, value] of cfClearanceManager.clearanceCache.entries()) {
        tokens.push({
          key: key,
          expires: value.expires,
          expiresIn: value.expires ? Math.max(0, value.expires - Date.now()) : 0,
          obtainedAt: value.obtainedAt,
          userAgent: value.userAgent ? value.userAgent.substring(0, 50) + '...' : null
        });
      }
      res.json({ tokens });
    } catch (error) {
      console.error('❌ Error listing CF-Clearance tokens:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Глобальный error handler для отладки
  app.use((error, req, res, next) => {
    console.error(`🔥 [ERROR] Global error handler caught:`, error.message);
    console.error(`🔥 [ERROR] Request URL: ${req.method} ${req.url}`);
    console.error(`🔥 [ERROR] Stack trace:`, error.stack);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  });

  const server = app.listen(port, host, () => {
    const serverMsg1 = `✅ Server listening on http://${hostname}:${port} (${host})`;
    const serverMsg2 = `   Open the web UI in your browser to start!`;
    
    console.log(serverMsg1);
    console.log(serverMsg2);
    
    // Add server startup messages to Live Logs
    addToLiveLogs(serverMsg1);
    addToLiveLogs(serverMsg2);
    
    // Auto-open browser
    const url = `http://${hostname}:${port}`;
    exec(`start ${url}`, (error) => {
      if (error) {
        const browserErrorMsg = `   Failed to auto-open browser. Please open manually: ${url}`;
        console.log(browserErrorMsg);
        // Add browser error message to Live Logs
        addToLiveLogs(browserErrorMsg, 'general', 'warning');
      } else {
        const browserSuccessMsg = `   🌐 Browser auto-opened: ${url}`;
        console.log(browserSuccessMsg);
        // Add browser success message to Live Logs
        addToLiveLogs(browserSuccessMsg);
      }
    });
    
    setInterval(keepAlive, 20 * 60 * 1000);
    
    // Auto-start templates with autoStart enabled (after server is fully started)
    setTimeout(async () => {
      let autoStartedCount = 0;
      for (const [id, template] of Object.entries(templates)) {
        if (template.autoStart && !template.running) {
          try {
            Promise.resolve().then(() => template.start()).catch(err => console.error(`❌ Failed to auto-start template \"${template?.name || 'unknown'}\"`, err));
            autoStartedCount++;
            console.log(`🚀 Auto-started template: ${template.name}`);
          } catch (error) {
            console.error(`❌ Failed to auto-start template "${template.name}":`, error.message);
          }
        }
      }
      if (autoStartedCount > 0) {
        console.log(`✅ Auto-started ${autoStartedCount} template(s)`);
      }
    }, 1000); // Wait 1 second after server start
  });
  try {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  } catch (_) { }
  // Process-level safety nets and graceful shutdown
  try {
    process.on('uncaughtException', (err) => {
      // Avoid logging EPIPE errors to prevent infinite loop
      if (err?.code !== 'EPIPE') {
        try {
          console.error('[Process] uncaughtException:', err?.stack || err);
          appendFileSync(path.join(dataDir, 'errors.log'), `[${new Date().toLocaleString()}] uncaughtException: ${err?.stack || err}\n`);
        } catch (_) { }
      }
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[Process] unhandledRejection:', reason);
      try { appendFileSync(path.join(dataDir, 'errors.log'), `[${new Date().toLocaleString()}] unhandledRejection: ${reason}\n`); } catch (_) { }
    });
    const shutdown = () => {
      console.log('Shutting down server...');
      try { server.close(() => {
          try { for (const s of Array.from(sockets)) { try { s.destroy(); } catch {} } } catch {}
          process.exit(0);
        });
        // Fallback: hard exit after 2s
        setTimeout(() => { try { for (const s of Array.from(sockets)) { try { s.destroy(); } catch {} } } catch {}; process.exit(0); }, 2000);
      } catch (_) { process.exit(0); }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (_) { }
})();