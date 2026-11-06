'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

// 内存缓存: origin -> { contentType, buffer, fetchedAt }
const memoryCache = new Map();
const MEMORY_LIMIT = 200;

// 常见研发与办公工具的高清品牌矢量图标兜底
const BRAND_SVGS = {
  jira: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path d="M11.53 2c0 2.4-1.97 4.35-4.4 4.35H2.8C2.36 6.35 2 6.7 2 7.15v2.8c0 .45.36.8.8.8h4.33C10.74 10.75 14 7.48 14 3.42V2.8c0-.44-.36-.8-.8-.8h-1.67z" fill="#0052CC"/><path d="M16.53 7c0 2.4-1.97 4.35-4.4 4.35H7.8c-.44 0-.8.35-.8.8v2.8c0 .45.36.8.8.8h4.33C15.74 15.75 19 12.48 19 8.42V7.8c0-.44-.36-.8-.8-.8h-1.67z" fill="#2684FF"/><path d="M21.53 12c0 2.4-1.97 4.35-4.4 4.35H12.8c-.44 0-.8.35-.8.8v2.8c0 .45.36.8.8.8h4.33C20.74 20.75 24 17.48 24 13.42V12.8c0-.44-.36-.8-.8-.8h-1.67z" fill="#0052CC"/></svg>`,
  jenkins: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="11" fill="#D33833"/><path d="M12 4a5 5 0 0 0-4.5 7.2L6 14.5l1.5 1.5 2-1.5A5 5 0 1 0 12 4zm0 2a3 3 0 1 1-2.6 4.5l-.2-.5-.5.2A3 3 0 0 1 12 6zm-2 9l2 2 4-4" fill="#FFFFFF"/></svg>`,
  dingtalk: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><rect width="24" height="24" rx="5" fill="#007FFF"/><path d="M5.5 17.5l8-10.5-2.5 5.5 5.5-2.5-7.5 8.5 1.5-4-5 3z" fill="#FFFFFF"/></svg>`,
  feishu: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><rect width="24" height="24" rx="5" fill="#00D6B9"/><path d="M6 16l4-8 5 4-4 5z" fill="#0055FF"/><path d="M10 12l5-5 3 4-5 5z" fill="#FFFFFF"/></svg>`,
  sheets: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><rect width="24" height="24" rx="4" fill="#0F9D58"/><path d="M6 6h12v12H6z" fill="#FFFFFF"/><path d="M6 10h12M6 14h12M10 6v12M14 6v12" stroke="#0F9D58" stroke-width="1.2"/></svg>`,
  docs: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><rect width="24" height="24" rx="4" fill="#4285F4"/><path d="M7 6h10v12H7z" fill="#FFFFFF"/><path d="M9 9h6M9 12h6M9 15h4" stroke="#4285F4" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  github: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="#24292F"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>`,
  gitlab: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path d="M23.6 9.6l-1.3-4c-.2-.5-.8-.7-1.2-.4l-2.2 1.6L14 3.2c-.3-.8-1.5-.8-1.8 0L9.1 6.8 6.9 5.2c-.4-.3-1.1-.1-1.2.4L4.4 9.6c-.2.5 0 1.1.4 1.4L12 18.5l7.2-7.5c.4-.3.6-.9.4-1.4z" fill="#E24329"/></svg>`,
  globe: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
};

function getFallbackSvg(rawUrl, title = '') {
  const u = (rawUrl || '').toLowerCase();
  const t = (title || '').toLowerCase();
  if (u.includes('jira') || t.includes('jira')) return BRAND_SVGS.jira;
  if (u.includes('jenkins') || u.includes('jinkens') || t.includes('jenkins') || t.includes('jinkens')) return BRAND_SVGS.jenkins;
  if (u.includes('dingtalk') || t.includes('钉钉')) return BRAND_SVGS.dingtalk;
  if (u.includes('feishu') || u.includes('lark') || t.includes('飞书')) return BRAND_SVGS.feishu;
  if (u.includes('sheets.google') || u.includes('spreadsheet') || t.includes('sheets') || t.includes('表格')) return BRAND_SVGS.sheets;
  if (u.includes('docs.google') || t.includes('google docs')) return BRAND_SVGS.docs;
  if (u.includes('github')) return BRAND_SVGS.github;
  if (u.includes('gitlab')) return BRAND_SVGS.gitlab;
  return BRAND_SVGS.globe;
}

function parseOrigin(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

function requestBuffer(targetUrl, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      targetUrl,
      {
        timeout: 3500,
        rejectUnauthorized: false, // 支持公司内部自签证书或内网 HTTPS
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      },
      res => {
        // 重定向处理 (301, 302, 307, 308)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          return resolve(requestBuffer(nextUrl, maxRedirects - 1));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const chunks = [];
        let total = 0;
        res.on('data', chunk => {
          chunks.push(chunk);
          total += chunk.length;
          if (total > 2 * 1024 * 1024) { // 最多读取 2MB
            req.destroy();
            resolve({ contentType: res.headers['content-type'], buffer: Buffer.concat(chunks) });
          }
        });
        res.on('end', () => {
          resolve({ contentType: res.headers['content-type'], buffer: Buffer.concat(chunks) });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * 获取网站真实 Favicon。
 * 策略：
 * 1. 检查内存缓存与磁盘缓存。
 * 2. 尝试拉取 ${origin}/favicon.ico。
 * 3. 失败时尝试从首页 HTML 提取 <link rel="icon">。
 * 4. 写入缓存并返回；彻底失败时返回品牌或通用 SVG。
 */
async function getFavicon(rawUrl, cacheDir, title = '') {
  const origin = parseOrigin(rawUrl);
  if (!origin) {
    return {
      contentType: 'image/svg+xml',
      buffer: Buffer.from(getFallbackSvg(rawUrl, title)),
      source: 'fallback'
    };
  }

  // 1. 检查内存缓存
  if (memoryCache.has(origin)) {
    return memoryCache.get(origin);
  }

  // 2. 检查磁盘缓存
  const hash = crypto.createHash('md5').update(origin).digest('hex');
  const cacheFile = cacheDir ? path.join(cacheDir, `${hash}.bin`) : null;
  const metaFile = cacheDir ? path.join(cacheDir, `${hash}.meta.json`) : null;

  if (cacheFile && metaFile && fs.existsSync(cacheFile) && fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const buf = fs.readFileSync(cacheFile);
      const res = { contentType: meta.contentType || 'image/x-icon', buffer: buf, source: 'disk' };
      memoryCache.set(origin, res);
      return res;
    } catch (_) {
      // 缓存损坏，继续重新拉取
    }
  }

  // 3. 网络拉取尝试 1: 直接获取 /favicon.ico
  let result = null;
  try {
    const icoUrl = `${origin}/favicon.ico`;
    const fetched = await requestBuffer(icoUrl);
    if (fetched && fetched.buffer && fetched.buffer.length > 0) {
      result = {
        contentType: fetched.contentType || 'image/x-icon',
        buffer: fetched.buffer,
        source: 'network'
      };
    }
  } catch (_) {
    // 继续尝试从 HTML 解析
  }

  // 4. 网络拉取尝试 2: 获取首页 HTML 查找 <link rel="icon">
  if (!result) {
    try {
      const pageRes = await requestBuffer(origin);
      if (pageRes && pageRes.buffer) {
        const html = pageRes.buffer.toString('utf8', 0, Math.min(pageRes.buffer.length, 64 * 1024));
        const iconMatch = /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i.exec(html) ||
                          /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i.exec(html);
        if (iconMatch && iconMatch[1]) {
          const resolvedUrl = new URL(iconMatch[1], origin).toString();
          const fetched = await requestBuffer(resolvedUrl);
          if (fetched && fetched.buffer && fetched.buffer.length > 0) {
            result = {
              contentType: fetched.contentType || 'image/x-icon',
              buffer: fetched.buffer,
              source: 'network-html'
            };
          }
        }
      }
    } catch (_) {
      // 忽略
    }
  }

  // 5. 写入缓存（如果获取成功）
  if (result) {
    if (memoryCache.size >= MEMORY_LIMIT) {
      const firstKey = memoryCache.keys().next().value;
      memoryCache.delete(firstKey);
    }
    memoryCache.set(origin, result);

    if (cacheDir) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cacheFile, result.buffer);
        fs.writeFileSync(metaFile, JSON.stringify({
          origin,
          contentType: result.contentType,
          fetchedAt: new Date().toISOString()
        }));
      } catch (_) {}
    }
    return result;
  }

  // 6. 兜底返回高质矢量 SVG
  const fallback = {
    contentType: 'image/svg+xml',
    buffer: Buffer.from(getFallbackSvg(rawUrl, title)),
    source: 'fallback'
  };
  return fallback;
}

module.exports = {
  getFavicon,
  getFallbackSvg,
  parseOrigin,
  BRAND_SVGS
};
