/**
 * WeatherHub QA 浏览器测试公共 harness
 * ------------------------------------------------------------------
 * 被 tools/screenshot.mjs 与 tests/ui-smoke.mjs 复用：
 *   - 自动启动/关闭 tools/dev-server.mjs（也可用 BASE_URL 指向已在跑的实例）
 *   - 启动本机 headless Chromium（playwright-core，aarch64 可用）
 *   - 手机尺寸上下文、页面诊断收集（pageerror/console error/请求）
 *   - 断言与报告工具
 *
 * 环境变量：
 *   BASE_URL   已运行的 dev-server 地址（设置后不再自己起服务，如 http://127.0.0.1:8099）
 *   PORT       自起服务时的端口（默认 8099）
 *   WH_APP_DIR 转发给 dev-server 的静态目录（调试 fixture 用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.PORT || 8099);
export const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36';

export function log(...args) {
  console.log(...args);
}
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 0) 检查 UI 产物是否存在，给出清晰提示 */
export function assertAppReady() {
  const appDir = path.resolve(process.env.WH_APP_DIR || path.join(ROOT, 'app'));
  if (!fs.existsSync(path.join(appDir, 'index.html'))) {
    throw new Error(
      '未找到 ' + path.join(appDir, 'index.html') + '\n' +
      'UI 产物还没生成（ui-dev 负责 app/index.html）。\n' +
      '调试 QA 流水线本身时可临时用: WH_APP_DIR=/tmp/wh-qa-fixture node tools/screenshot.mjs'
    );
  }
  return appDir;
}

/** 1) 启动 dev-server（BASE_URL 已设置则复用） */
export async function startDevServer() {
  const baseUrlEnv = process.env.BASE_URL;
  if (baseUrlEnv) {
    const baseUrl = baseUrlEnv.replace(/\/$/, '');
    await waitForServer(baseUrl, 5000);
    return { baseUrl, spawned: false, stop: async () => {} };
  }
  const appDir = assertAppReady();
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  let exited = false;
  child.on('exit', (code) => { exited = true; });
  const baseUrl = 'http://127.0.0.1:' + PORT;
  try {
    await waitForServer(baseUrl, 15000, () => exited);
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error('dev-server 启动失败（' + e.message + '）。日志：\n' + out);
  }
  const stop = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && !exited; i++) await sleep(100);
    if (!exited) child.kill('SIGKILL');
  };
  process.on('exit', () => { try { child.kill('SIGKILL'); } catch {} });
  return { baseUrl, spawned: true, appDir, stop, logs: () => out };
}

async function waitForServer(baseUrl, timeoutMs, didExit) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (didExit && didExit()) throw new Error('进程提前退出（端口被占用？）');
    try {
      const c = new AbortController();
      const to = setTimeout(() => c.abort(), 1500);
      const res = await fetch(baseUrl + '/__health', { signal: c.signal });
      clearTimeout(to);
      if (res.ok) return;
      lastErr = new Error('health status ' + res.status);
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error('等待 ' + baseUrl + '/__health 超时: ' + (lastErr && lastErr.message));
}

/** 2) 启动 headless chromium */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',   // proot 里 /dev/shm 很小
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-zygote',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--font-render-hinting=none',
];
// 注：实测 aarch64 + proot 下多进程模式内存占用很低且稳定（关闭 context 不崩）；
// --single-process 在关闭 context 时会让整个浏览器退出，故默认关闭，可用 PW_SINGLE_PROCESS=1 打开。
if (process.env.PW_SINGLE_PROCESS === '1') LAUNCH_ARGS.push('--single-process');

export async function launchBrowser() {
  let pw;
  try {
    pw = await import('playwright-core');
  } catch (e) {
    throw new Error(
      '未安装 playwright-core。安装：\n' +
      '  npm i -D playwright-core\n' +
      '  PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \\\n' +
      '    node node_modules/playwright-core/cli.js install chromium-headless-shell\n' +
      '原始错误: ' + e.message
    );
  }
  try {
    return await pw.chromium.launch({ headless: true, args: LAUNCH_ARGS, timeout: 60000 });
  } catch (e) {
    throw new Error(
      'Chromium 启动失败: ' + e.message + '\n' +
      '若提示浏览器不存在，请执行（走 npmmirror 镜像）：\n' +
      '  PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \\\n' +
      '    node node_modules/playwright-core/bin/../cli.js install chromium-headless-shell'
    );
  }
}

/** 3) 手机尺寸页面 + 诊断收集 */
export async function newMobilePage(browser, opts = {}) {
  const width = opts.width || 390;
  const height = opts.height || 844;
  const dpr = opts.dpr || 2;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
    userAgent: opts.userAgent || ANDROID_UA,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeout || 10000);
  const diag = {
    pageErrors: [],
    consoleErrors: [],
    consoleWarnings: [],
    failedRequests: [],
    badResponses: [],
    externalRequests: [],
    requests: [],
  };
  page.on('pageerror', (e) => diag.pageErrors.push(String(e && e.stack ? e.stack.split('\n')[0] : e)));
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') diag.consoleErrors.push(text);
    else if (t === 'warning') diag.consoleWarnings.push(text);
  });
  page.on('pageerror', () => {});
  page.on('requestfailed', (req) => {
    const u = req.url();
    diag.failedRequests.push(u + ' :: ' + (req.failure() && req.failure().errorText));
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !/favicon/.test(res.url())) {
      diag.badResponses.push(res.status() + ' ' + res.url());
    }
  });
  page.on('request', (req) => {
    const u = req.url();
    if (diag.requests.length < 300) diag.requests.push(u);
    if (/^https?:/.test(u) && !/^http:\/\/127\.0\.0\.1:/.test(u) && !/^http:\/\/localhost:/.test(u)) {
      diag.externalRequests.push(u);
    }
  });
  return { context, page, diag };
}

/** 4) 页面就绪：app 有内容 + 出现温度/中文关键文本 */
export async function waitAppReady(page, opts = {}) {
  const timeout = opts.timeout || 20000;
  await page.waitForSelector('#app', { state: 'attached', timeout });
  try {
    await page.waitForFunction(
      () => {
        const app = document.querySelector('#app');
        if (!app) return false;
        const txt = (app.innerText || '').replace(/\s+/g, ' ');
        return txt.length > 40 && (/[*\u00b0\u2103]/.test(txt) || /\d/.test(txt));
      },
      { timeout }
    );
  } catch (e) {
    throw new Error('等待 UI 渲染超时（#app 没出现温度/数据）。当前 body 文本: ' + (await bodyText(page)).slice(0, 300));
  }
  await sleep(opts.settleMs == null ? 600 : opts.settleMs);
}

export async function bodyText(page) {
  try { return await page.evaluate(() => document.body.innerText || ''); } catch { return ''; }
}

/** 5) 底部 tab 点击（兼容 role=tab / button / 文本） */
export async function clickTab(page, name) {
  const candidates = [
    '[role="tab"]:has-text("' + name + '")',
    '[role="tab"] >> text=' + name,
    '[data-tab]:has-text("' + name + '")',
    '[data-tab="' + name + '"]',
    'nav button:has-text("' + name + '")',
    'footer button:has-text("' + name + '")',
    'button:has-text("' + name + '")',
    '.tab:has-text("' + name + '")',
    'text=' + name,
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      const n = await loc.count();
      if (!n) continue;
      if (!(await loc.isVisible())) continue;
      await loc.click({ timeout: 3000 });
      await sleep(420);
      return sel;
    } catch {
      /* 试下一个选择器 */
    }
  }
  throw new Error('找不到底部 tab「' + name + '」的可点击元素');
}

/** 6) 横向溢出检测 */
export async function checkOverflow(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    const inner = window.innerWidth;
    const out = {
      innerWidth: inner,
      scrollWidth: se ? se.scrollWidth : 0,
      overflow: se ? se.scrollWidth > inner + 1 : false,
      offenders: [],
    };
    const all = document.querySelectorAll('body *');
    for (let i = 0; i < all.length && out.offenders.length < 8; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > inner + 1.5 || r.left < -1.5)) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' && r.width <= inner + 2) continue;
        const desc = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
        out.offenders.push(desc + ' right=' + Math.round(r.right) + ' left=' + Math.round(r.left));
      }
    }
    return out;
  });
}

/** 7) 断言/报告 */
export function createReport(title) {
  const items = [];
  return {
    items,
    async check(name, fn) {
      const t0 = Date.now();
      try {
        const info = await fn();
        items.push({ name, status: 'pass', info: info == null ? '' : String(info), ms: Date.now() - t0 });
        log('  PASS  ' + name + (info ? '  (' + info + ')' : ''));
      } catch (e) {
        items.push({ name, status: 'fail', info: e.message, ms: Date.now() - t0 });
        log('  FAIL  ' + name + '  -> ' + e.message);
      }
    },
    warn(name, info) {
      items.push({ name, status: 'warn', info: String(info), ms: 0 });
      log('  WARN  ' + name + '  -> ' + info);
    },
    summary() {
      const fail = items.filter((i) => i.status === 'fail');
      const warn = items.filter((i) => i.status === 'warn');
      log('');
      log('  ' + title + ': ' + items.length + ' 项, PASS ' +
        items.filter((i) => i.status === 'pass').length + ', FAIL ' + fail.length + ', WARN ' + warn.length);
      if (fail.length) {
        log('  失败项:');
        fail.forEach((f) => log('   - ' + f.name + ': ' + f.info));
      }
      return { ok: fail.length === 0, total: items.length, failed: fail.length, warned: warn.length, items };
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
