#!/usr/bin/env node
/**
 * WeatherHub 手机尺寸截图流水线（headless Chromium / aarch64 可用）
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/screenshot.mjs                     # 自起 dev-server，390x844 + 412x915 各截 4 个 tab
 *   BASE_URL=http://127.0.0.1:8099 node tools/screenshot.mjs   # 复用已在跑的服务
 *   SHOT_TABS=综合,平台 node tools/screenshot.mjs               # 只截部分 tab
 *   SHOT_QUERY="mock=1&mockfail=0&mockdelay=0.2" ...            # 自定义 URL 参数
 *
 * 输出（build/ 已被 git 忽略）：
 *   build/shots/{综合,平台,城市,设置}.png        # 390x844 @2x
 *   build/shots/412x915/{综合,平台,城市,设置}.png
 *   build/shots/manifest.json                    # 文件清单/尺寸/渲染信息
 *
 * 退出码：0 成功；非 0 = 页面报错/关键内容缺失/tab 找不到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startDevServer, launchBrowser, newMobilePage, waitAppReady, bodyText, clickTab, sleep } from '../tests/ui-harness.mjs';

const TABS = (process.env.SHOT_TABS || '综合,平台,城市,设置').split(',').map((s) => s.trim()).filter(Boolean);
const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, root: true },
  { name: '412x915', width: 412, height: 915, root: false },
];
const QUERY = process.env.SHOT_QUERY || 'mock=1&mockfail=0';
const OUT_DIR = path.resolve(process.env.SHOTS_DIR || path.join(ROOT, 'build', 'shots'));
const KEY_TEXT = ['综合'];

function fmtBytes(n) {
  return n > 1024 * 1024 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB';
}

async function main() {
  const t0 = Date.now();
  const outFiles = [];
  let server = null;
  let browser = null;
  const problems = [];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    server = await startDevServer();
    console.log('[shot] dev-server:', server.baseUrl, server.spawned ? '(已自动启动)' : '(复用已有)');
    browser = await launchBrowser();
    console.log('[shot] chromium:', browser.version());

    for (const vp of VIEWPORTS) {
      const dir = vp.root ? OUT_DIR : path.join(OUT_DIR, vp.name);
      fs.mkdirSync(dir, { recursive: true });
      const { context, page, diag } = await newMobilePage(browser, { width: vp.width, height: vp.height, dpr: 2 });
      const url = server.baseUrl + '/?' + QUERY;
      console.log('[shot]', vp.name, '->', url);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitAppReady(page);
      try { await page.evaluate(() => (document.fonts ? document.fonts.ready : undefined)); } catch { /* ignore */ }

      const text = await bodyText(page);
      if (!/天气汇/.test(text) && !/天气汇/.test(await page.title())) {
        problems.push('页面缺少应用名「天气汇」：title=' + (await page.title()));
      }

      for (const tab of TABS) {
        // 每个 tab 都点击一次（含默认的「综合」），顺便验证 tab 切换交互可用
        try {
          await clickTab(page, tab);
        } catch (e) {
          problems.push('tab「' + tab + '」点击失败: ' + e.message);
          break;
        }
        await sleep(300);
        const tabText = await bodyText(page);
        if (tabText.replace(/\s+/g, '').length < 20) {
          problems.push('tab「' + tab + '」内容为空');
        }
        const file = path.join(dir, tab + '.png');
        await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
        const st = fs.statSync(file);
        outFiles.push({ viewport: vp.name, tab, file: path.relative(ROOT, file), bytes: st.size });
        console.log('  ✓ ' + path.relative(ROOT, file) + '  ' + fmtBytes(st.size) + '  [' + tabText.replace(/\s+/g, ' ').slice(0, 60) + ']');
      }

      if (diag.pageErrors.length) problems.push(vp.name + ' pageerror: ' + diag.pageErrors.join(' | '));
      if (diag.consoleErrors.length) problems.push(vp.name + ' console.error: ' + diag.consoleErrors.join(' | '));
      if (diag.failedRequests.length) problems.push(vp.name + ' 请求失败: ' + diag.failedRequests.slice(0, 5).join(' | '));
      await context.close();
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      url: server.baseUrl + '/?' + QUERY,
      query: QUERY,
      chromium: browser.version(),
      viewports: VIEWPORTS.map((v) => v.name),
      tabs: TABS,
      files: outFiles,
      problems,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    console.log('');
    console.log('[shot] 完成：' + outFiles.length + ' 张截图 / ' + (Date.now() - t0) + 'ms -> ' + path.relative(ROOT, OUT_DIR));
    if (problems.length) {
      console.error('[shot] 发现问题:');
      problems.forEach((p) => console.error('  - ' + p));
      process.exitCode = 1;
    } else {
      console.log('[shot] 页面无 pageerror / console.error，截图目录: ' + OUT_DIR);
    }
  } catch (e) {
    console.error('[shot] 失败:', e && e.message ? e.message : e);
    if (server && server.logs) console.error('--- dev-server 日志 ---\n' + server.logs().slice(-3000));
    process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { if (server) await server.stop(); } catch {}
  }
}

main();
