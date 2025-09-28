import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

class CFClearanceManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.clearanceCache = new Map(); // Кэш: "proxy:userId" -> { cf_clearance, userAgent, expires, cookies }
    this.clearanceCacheFile = path.join(dataDir, "cf_clearance_cache.json");
    this.loadCache();
  }

  loadCache() {
    try {
      if (existsSync(this.clearanceCacheFile)) {
        const data = JSON.parse(readFileSync(this.clearanceCacheFile, "utf8"));
        // Загружаем кэш и проверяем срок действия
        for (const [key, value] of Object.entries(data)) {
          if (value.expires && Date.now() < value.expires) {
            this.clearanceCache.set(key, value);
          }
        }
        console.log(`🔐 [CF-Manager] Loaded ${this.clearanceCache.size} valid cf_clearance tokens from cache`);
      }
    } catch (error) {
      console.log(`❌ [CF-Manager] Error loading cache: ${error.message}`);
    }
  }

  saveCache() {
    try {
      const cacheData = {};
      for (const [key, value] of this.clearanceCache.entries()) {
        // Сохраняем только действующие токены
        if (value.expires && Date.now() < value.expires) {
          cacheData[key] = value;
        }
      }
      writeFileSync(this.clearanceCacheFile, JSON.stringify(cacheData, null, 2));
      console.log(`💾 [CF-Manager] Saved ${Object.keys(cacheData).length} cf_clearance tokens to cache`);
    } catch (error) {
      console.log(`❌ [CF-Manager] Error saving cache: ${error.message}`);
    }
  }

  generateCacheKey(proxy, userId) {
    // Создаем уникальный ключ для комбинации прокси + пользователь
    const proxyKey = proxy ? `${proxy.host}:${proxy.port}:${proxy.username || ''}` : "direct";
    return `${proxyKey}:${userId || 'anonymous'}`;
  }

  getCachedClearance(proxy, userId) {
    const key = this.generateCacheKey(proxy, userId);
    const cached = this.clearanceCache.get(key);

    if (cached && cached.expires && Date.now() < cached.expires) {
      console.log(`✅ [CF-Manager] Using cached cf_clearance for ${key}`);
      return cached;
    }

    if (cached) {
      console.log(`⏰ [CF-Manager] Cached cf_clearance expired for ${key}`);
      this.clearanceCache.delete(key);
    }

    return null;
  }

  async getClearance(proxy, userId, targetUrl = "https://bplace.org") {
    // Сначала проверяем кэш
    const cached = this.getCachedClearance(proxy, userId);
    if (cached) {
      return cached;
    }

    // Включаем CF-Clearance-Scraper обратно после исправления Body issues
    console.log(`🔄 [CF-Manager] Obtaining new cf_clearance for proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'direct'}, user: ${userId || 'anonymous'}`);

    try {
      const clearanceData = await this.obtainClearanceFromPython(proxy, targetUrl);

      if (clearanceData && clearanceData.cf_clearance) {
        // Устанавливаем срок действия на 23 часа (Cloudflare токены обычно действуют 24 часа)
        const expires = Date.now() + (23 * 60 * 60 * 1000);

        const cacheEntry = {
          cf_clearance: clearanceData.cf_clearance,
          userAgent: clearanceData.user_agent,
          expires: expires,
          cookies: clearanceData.cookies || {},
          obtainedAt: new Date().toISOString()
        };

        const key = this.generateCacheKey(proxy, userId);
        this.clearanceCache.set(key, cacheEntry);
        this.saveCache();

        console.log(`✅ [CF-Manager] Successfully obtained cf_clearance for ${key}`);
        return cacheEntry;
      }
    } catch (error) {
      console.log(`❌ [CF-Manager] Failed to obtain cf_clearance: ${error.message}`);
    }

    return null;
  }

  async obtainClearanceFromPython(proxy, targetUrl) {
    return new Promise((resolve, reject) => {
      const pythonScript = path.join(this.dataDir, "..", "CF-Clearance-Scraper", "main.py");

      if (!existsSync(pythonScript)) {
        reject(new Error(`CF-Clearance-Scraper main.py not found at ${path.resolve(pythonScript)}`));
        return;
      }

      // Используем только имя файла main.py, так как рабочая директория будет CF-Clearance-Scraper
      const args = ["main.py", targetUrl, "--timeout", "60"];

      // Добавляем прокси если указан
      if (proxy) {
        let proxyUrl = `${proxy.protocol || 'http'}://`;
        if (proxy.username && proxy.password) {
          proxyUrl += `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
        }
        proxyUrl += `${proxy.host}:${proxy.port}`;
        args.push("--proxy", proxyUrl);
      }

      // Получаем все куки, не только cf_clearance
      args.push("--all-cookies");

      const tempFile = path.resolve(this.dataDir, `cf_temp_${Date.now()}.json`);
      args.push("--file", tempFile);

      console.log(`🐍 [CF-Manager] Running Python script: python ${args.join(' ')}`);

      const pythonProcess = spawn("python", args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: path.dirname(pythonScript)
      });

      let stdout = "";
      let stderr = "";

      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      pythonProcess.on("close", (code) => {
        if (code === 0) {
          try {
            // Читаем результат из файла
            if (existsSync(tempFile)) {
              const result = JSON.parse(readFileSync(tempFile, "utf8"));

              // Удаляем временный файл
              try {
                require("fs").unlinkSync(tempFile);
              } catch {}

              // Парсим результат
              const domain = new URL(targetUrl).hostname;

              // Ищем данные по домену или с точкой в начале (.domain)
              let domainData = result[domain] || result[`.${domain}`];

              if (domainData && domainData.length > 0) {
                const latestEntry = domainData[domainData.length - 1];
                resolve({
                  cf_clearance: latestEntry.cf_clearance,
                  user_agent: latestEntry.user_agent,
                  cookies: this.parseCookies(latestEntry.cookies)
                });
              } else {
                reject(new Error(`No clearance data found for domain ${domain} (checked both "${domain}" and ".${domain}")`));
              }
            } else {
              // Пробуем извлечь из stdout если файл не создался
              const cfMatch = stdout.match(/Cookie: cf_clearance=([^\s]+)/);
              const uaMatch = stdout.match(/User agent: (.+)/);

              if (cfMatch && uaMatch) {
                resolve({
                  cf_clearance: cfMatch[1],
                  user_agent: uaMatch[1].trim(),
                  cookies: { cf_clearance: cfMatch[1] }
                });
              } else {
                reject(new Error("Could not extract clearance from output"));
              }
            }
          } catch (error) {
            reject(new Error(`Failed to parse result: ${error.message}`));
          }
        } else {
          reject(new Error(`Python script failed with code ${code}: ${stderr || stdout}`));
        }
      });

      pythonProcess.on("error", (error) => {
        reject(new Error(`Failed to spawn Python process: ${error.message}`));
      });

      // Таймаут на случай зависания
      setTimeout(() => {
        try {
          pythonProcess.kill();
        } catch {}
        reject(new Error("Python script timeout"));
      }, 90000); // 90 секунд
    });
  }

  parseCookies(cookiesArray) {
    const cookies = {};
    if (Array.isArray(cookiesArray)) {
      for (const cookie of cookiesArray) {
        if (cookie.name && cookie.value) {
          cookies[cookie.name] = cookie.value;
        }
      }
    }
    return cookies;
  }

  // Метод для принудительного обновления токена
  async refreshClearance(proxy, userId, targetUrl = "https://bplace.org") {
    const key = this.generateCacheKey(proxy, userId);
    this.clearanceCache.delete(key);
    console.log(`🔄 [CF-Manager] Force refreshing cf_clearance for ${key}`);
    return await this.getClearance(proxy, userId, targetUrl);
  }

  // Метод для очистки устаревших токенов
  cleanupExpiredTokens() {
    const before = this.clearanceCache.size;
    for (const [key, value] of this.clearanceCache.entries()) {
      if (!value.expires || Date.now() >= value.expires) {
        this.clearanceCache.delete(key);
      }
    }
    const after = this.clearanceCache.size;
    if (before !== after) {
      console.log(`🧹 [CF-Manager] Cleaned up ${before - after} expired tokens`);
      this.saveCache();
    }
  }

  // Получить статистику по токенам
  getStats() {
    const total = this.clearanceCache.size;
    let expiringSoon = 0;

    for (const [key, value] of this.clearanceCache.entries()) {
      if (value.expires && (value.expires - Date.now()) < (2 * 60 * 60 * 1000)) { // Истекают в течение 2 часов
        expiringSoon++;
      }
    }

    return { total, expiringSoon };
  }
}

export default CFClearanceManager;