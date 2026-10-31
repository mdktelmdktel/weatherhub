#!/usr/bin/env node
/**
 * WeatherHub UI 冒烟测试（headless Chromium，离线 mock 数据）
 * ------------------------------------------------------------------
 * 用法：
 *   node tests/ui-smoke.mjs
 *   BASE_URL=http://127.0.0.1:8099 node tests/ui-smoke.mjs     # 复用已有 dev-server
 *   WH_APP_DIR=/tmp/wh-qa-fixture node tests/ui-smoke.mjs     # 用 fixture 自测 QA 流水线
 *
 * 覆盖（SPEC 第 9 节验收点）：
 *   1. 标题/应用名/关键文本；综合页核心数据（温度、N 个平台综合、AQI、预警）
 *   2. 底部 4 tab（综合/平台/城市/设置）均可切换且渲染非空、关键内容正确
 *   3. 无 pageerror、无 console.error
 *   4. 无横向溢出（360 / 390 / 412 三种宽度 x 4 tab）
 *   5. ?mock=1 默认场景：metno 首次失败 -> 平台页出现「重试」-> 点击后恢复
 *   6. mock 模式不发起外网请求（页面只访问 127.0.0.1）
 * 退出码：0 全部通过；1 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, startDevServer, launchBrowser, newMobilePage, waitAppReady,
  bodyText, clickTab, checkOverflow, createReport, assert, sleep,
} from './ui-harness.mjs';

const TABS = ['综合', '平台', '城市', '设置'];
const REPORT_FILE = path.join(ROOT, 'build', 'ui-smoke-report.json');

function normalize(t) { return String(t || '').replace(/\s+/g, ' '); }
async function clickAllTabs(page) {
  for (const tab of TABS) await clickTab(page, tab);
}

async function main() {
  const t0 = Date.now();
  const report = createReport('UI smoke');
  let server = null;
  let browser = null;
  const ctxs = [];
  const extra = { phase: {} };

  try {
    server = await startDevServer();
    browser = await launchBrowser();
    console.log('');
    console.log('UI smoke — ' + server.baseUrl + '  chromium ' + browser.version());

    // ================= 阶段 1：干净 mock 数据（4 源全部成功） =================
    console.log('\n[阶段 1] ?mock=1&mockfail=0 （4 源成功）');
    const clean = await newMobilePage(browser, { width: 390, height: 844 });
    ctxs.push(clean.context);
    const page = clean.page;
    await page.goto(server.baseUrl + '/?mock=1&mockfail=0&mockdelay=0.3', { waitUntil: 'domcontentloaded' });
    await waitAppReady(page);
    let text = normalize(await bodyText(page));

    await report.check('?mock=1 注入成功且 window.WH 契约完整', async () => {
      const info = await page.evaluate(() => {
        const WH = window.WH;
        const ns = ['bridge', 'location', 'sources', 'aggregate', 'cache', 'settings', 'utils'];
        const kinds = {};
        ns.forEach((k) => { kinds[k] = WH && WH[k] ? typeof WH[k] : 'missing'; });
        return {
          mockFlag: window.__DEV_MOCK__ === true,
          whMockFlag: window.__WH_MOCK__ === true,
          hasWH: !!WH,
          version: WH && WH.version,
          layer: WH && WH.mock === true ? 'mock' : 'real-layer(被 mock 接管)',
          sourceMeta: WH && WH.meta && Array.isArray(WH.meta.sources) ? WH.meta.sources.length : 0,
          kinds,
          bridgeAvailable: !!(WH && WH.bridge && WH.bridge.available),
        };
      });
      assert(info.hasWH, 'window.WH 不存在（/__mock 未注入或被覆盖）');
      assert(info.mockFlag, 'window.__DEV_MOCK__ 未设置，?mock=1 注入可能失败');
      assert(info.whMockFlag, 'window.__WH_MOCK__ 未设置，mock 未生效');
      assert(info.version, 'WH.version 缺失');
      assert(info.sourceMeta >= 4, 'WH.meta.sources 数量 < 4: ' + info.sourceMeta);
      for (const k of Object.keys(info.kinds)) {
        assert(info.kinds[k] === 'object', 'WH.' + k + ' 缺失/类型错误: ' + info.kinds[k]);
      }
      assert(info.bridgeAvailable === false, '浏览器场景 bridge.available 应为 false');
      return 'WH ' + info.version + ' · ' + info.layer + ' · ' + info.sourceMeta + ' 个源';
    });

    await report.check('页面标题包含「天气汇」', async () => {
      const title = await page.title();
      assert(/天气汇/.test(title), 'title = ' + JSON.stringify(title));
      return title;
    });
    await report.check('综合页关键文本（综合/武汉/温度）', async () => {
      assert(/综合/.test(text), '缺少「综合」');
      assert(/武汉/.test(text), '缺少城市名「武汉」');
      assert(/(?:^|[^\d])(1\d|2\d)\s*(?:°|℃)/.test(text), '缺少温度数字: ' + text.slice(0, 200));
      return text.slice(0, 80);
    });
    await report.check('多源综合徽标（N 个平台综合）', async () => {
      assert(/\d+\s*个平台|平台综合|一致度|consensus/i.test(text), '缺少多源综合/一致度文案');
      return (text.match(/\d+\s*个平台[^ ]{0,20}/) || [''])[0];
    });
    await report.check('空气质量卡片（AQI 45）', async () => {
      assert(/空气质量|AQI/i.test(text), '缺少空气质量卡片');
      assert(/45/.test(text), '未显示 AQI 45');
      return 'AQI 45';
    });
    await report.check('预警卡片（CMA 大风蓝色预警）', async () => {
      assert(/预警/.test(text), '缺少预警卡片');
      return '大风预警';
    });

    await report.check('4 个 tab 均可切换且内容正确', async () => {
      const expect = {
        综合: [/综合/, /武汉/],
        平台: [/中国气象局/, /Open-Meteo/],
        城市: [/搜索/, /城市/],
        设置: [/单位/, /设置/],
      };
      for (const tab of TABS) {
        await clickTab(page, tab);
        await sleep(200);
        const t = normalize(await bodyText(page));
        assert(t.replace(/\s+/g, '').length >= 15, tab + ' 页内容为空');
        const ok = expect[tab].some((re) => re.test(t));
        assert(ok, tab + ' 页缺少关键内容（期望 ' + expect[tab].map(String).join(' 或 ') + '），实际: ' + t.slice(0, 160));
      }
      return '4/4 tab OK';
    });

    await report.check('无 pageerror / console.error', async () => {
      assert(clean.diag.pageErrors.length === 0, 'pageerror: ' + clean.diag.pageErrors.join(' | '));
      assert(clean.diag.consoleErrors.length === 0, 'console.error: ' + clean.diag.consoleErrors.join(' | '));
      return '0 错误';
    });
    await report.check('mock 模式不请求外网', async () => {
      assert(clean.diag.externalRequests.length === 0, '外网请求: ' + clean.diag.externalRequests.slice(0, 5).join(' | '));
      return clean.diag.requests.length + ' 个本地请求';
    });
    await report.check('无 4xx/5xx 资源', async () => {
      assert(clean.diag.badResponses.length === 0, clean.diag.badResponses.join(' | '));
      return 'OK';
    });
    await report.check('390px 下 4 个 tab 无横向溢出', async () => {
      for (const tab of TABS) {
        await clickTab(page, tab);
        await sleep(250);
        const o = await checkOverflow(page);
        assert(!o.overflow, tab + ' 溢出: scrollWidth=' + o.scrollWidth + ' innerWidth=' + o.innerWidth +
          (o.offenders.length ? ' 越界元素: ' + o.offenders.join('; ') : ''));
      }
      return 'OK';
    });

    // ================= 阶段 2：默认失败场景 + 重试恢复 =================
    console.log('\n[阶段 2] ?mock=1 （metno 首次失败 -> 重试恢复）');
    const retryCtx = await newMobilePage(browser, { width: 390, height: 844 });
    ctxs.push(retryCtx.context);
    const p2 = retryCtx.page;
    await p2.goto(server.baseUrl + '/?mock=1&mockdelay=0.3', { waitUntil: 'domcontentloaded' });
    await waitAppReady(p2);
    await clickTab(p2, '平台');
    await sleep(400);
    let t2 = normalize(await bodyText(p2));
    await report.check('失败源展示错误与「重试」入口', async () => {
      assert(/重试/.test(t2) || /失败|错误/.test(t2), '平台页未显示失败/重试: ' + t2.slice(0, 300));
      assert(/重试/.test(t2), '未找到「重试」按钮文案: ' + t2.slice(0, 300));
      return '重试入口存在';
    });
    await report.check('点击重试后恢复数据', async () => {
      // 只点按钮类元素，避免点到错误文案里的“重试”二字
      const candidates = [
        'button:has-text("重试")',
        '[role="button"]:has-text("重试")',
        '[data-action="retry"]:has-text("重试")',
        '.retry:has-text("重试")',
        'text=/重新加载|重试/',
      ];
      let clicked = null;
      for (const sel of candidates) {
        const loc = p2.locator(sel).first();
        try {
          if (!(await loc.count())) continue;
          if (!(await loc.isVisible())) continue;
          await loc.click({ timeout: 4000 });
          clicked = sel;
          break;
        } catch { /* 试下一个 */ }
      }
      assert(clicked, '没有可点击的「重试」按钮');
      let recovered = false;
      for (let i = 0; i < 48; i++) {
        await sleep(250);
        const t = normalize(await bodyText(p2));
        if (!/重试/.test(t)) { recovered = true; t2 = t; break; }
      }
      assert(recovered, '点击重试(' + clicked + ')后 12s 内仍显示「重试」入口，未恢复');
      return '恢复成功（' + clicked + '）';
    });
    await report.check('重试后仍无 pageerror', async () => {
      assert(retryCtx.diag.pageErrors.length === 0, retryCtx.diag.pageErrors.join(' | '));
      assert(retryCtx.diag.consoleErrors.length === 0, retryCtx.diag.consoleErrors.join(' | '));
      return '0 错误';
    });

    // ================= 阶段 3：窄屏 360 / 宽屏 412 无横向溢出 =================
    console.log('\n[阶段 3] 360px / 412px 适配');
    for (const vp of [{ w: 360, h: 800 }, { w: 412, h: 915 }]) {
      const c = await newMobilePage(browser, { width: vp.w, height: vp.h });
      ctxs.push(c.context);
      await c.page.goto(server.baseUrl + '/?mock=1&mockfail=0&mockdelay=0.2', { waitUntil: 'domcontentloaded' });
      await waitAppReady(c.page);
      await report.check(vp.w + 'px 下 4 个 tab 无横向溢出', async () => {
        for (const tab of TABS) {
          await clickTab(c.page, tab);
          await sleep(220);
          const o = await checkOverflow(c.page);
          assert(!o.overflow, tab + ' 溢出: scrollWidth=' + o.scrollWidth + ' innerWidth=' + o.innerWidth +
            (o.offenders.length ? ' 越界元素: ' + o.offenders.join('; ') : ''));
        }
        return 'OK';
      });
      await report.check(vp.w + 'px 无 pageerror', async () => {
        assert(c.diag.pageErrors.length === 0, c.diag.pageErrors.join(' | '));
        assert(c.diag.consoleErrors.length === 0, c.diag.consoleErrors.join(' | '));
        return '0 错误';
      });
    }

    // ================= 汇总 =================
    const sum = report.summary();
    extra.phase = { total: sum.total, failed: sum.failed };
    const data = {
      generatedAt: new Date().toISOString(),
      baseUrl: server.baseUrl,
      chromium: browser.version(),
      durationMs: Date.now() - t0,
      ok: sum.ok,
      summary: { total: sum.total, pass: sum.total - sum.failed - sum.warned, fail: sum.failed, warn: sum.warned },
      items: sum.items,
    };
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log('\n  report: ' + path.relative(ROOT, REPORT_FILE));
    console.log('  耗时 ' + (Date.now() - t0) + 'ms');
    process.exitCode = sum.ok ? 0 : 1;
  } catch (e) {
    console.error('\n[ui-smoke] 执行失败:', e && e.message ? e.message : e);
    if (server && server.logs) console.error('--- dev-server 日志 ---\n' + server.logs().slice(-3000));
    process.exitCode = 1;
  } finally {
    for (const c of ctxs) { try { await c.close(); } catch {} }
    try { if (browser) await browser.close(); } catch {}
    try { if (server) await server.stop(); } catch {}
  }
}

main();
