/*!
 * WeatherHub（天气汇）数据层 — bridge.js
 * ---------------------------------------------------------------------------
 * 职责：
 *   1) 封装原生桥 window.AndroidApp（httpFetch / getLocation / toast / deviceInfo
 *      / openUrl / log / getLogs），统一返回 Promise，超时与错误结构化；
 *   2) 浏览器（无原生桥）场景回退 fetch()，本机开发时若存在 window.__DEV_PROXY__
 *      则通过 dev-server 代理请求（绕过 CORS）；
 *   3) 因为 SPEC 的 index.html 只加载 bridge / sources / aggregate / location 四个
 *      数据层文件（bridge.js 最先加载），所以 WH 基础模块 cache / settings / utils
 *      也放在本文件，供 ui.js / app.js 使用。
 *
 * 加载方式：普通 <script>（IIFE），不使用 ES module / import / 外部依赖。
 * 对外：window.WH.bridge / window.WH.cache / window.WH.settings / window.WH.utils
 */
(function (global) {
  'use strict';

  var WH = global.WH = global.WH || {};
  var VERSION = '1.0.0';
  WH.version = WH.version || VERSION;

  /* ======================================================================
   * 1. 通用小工具
   * ==================================================================== */

  function isFn(v) { return typeof v === 'function'; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }
  function nowMs() { return Date.now(); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function noop() {}

  function clone(v) {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) {
      if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length; i++) a.push(clone(v[i])); return a; }
      var o = {}; for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]); } return o;
    }
  }

  function extend(target) {
    target = target || {};
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) target[k] = src[k];
      }
    }
    return target;
  }

  function emitEvent(name, detail) {
    try {
      if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent(name, { detail: detail }));
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ======================================================================
   * 2. localStorage 安全封装 + cache
   *    契约键：wh.cache.v1 / wh.city.v1 / wh.settings.v1
   * ==================================================================== */

  var KEYS = {
    cache: 'wh.cache.v1',
    city: 'wh.city.v1',
    cities: 'wh.cities.v1',
    settings: 'wh.settings.v1',
    cmaStation: 'wh.cma.station.v1'
  };

  var memStore = {};
  var LS = null;
  try {
    if (typeof global.localStorage !== 'undefined' && global.localStorage) LS = global.localStorage;
  } catch (e) { LS = null; }
  // 再执行一次可用性探测（隐私模式 / 配额异常时降级到内存）
  if (LS) {
    try {
      LS.setItem('__wh_probe__', '1');
      LS.removeItem('__wh_probe__');
    } catch (e) { LS = null; }
  }

  var storage = {
    get: function (key) {
      try { if (LS) return LS.getItem(key); } catch (e) { /* 降级 */ }
      return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
    },
    set: function (key, value) {
      var str = String(value);
      try { if (LS) { LS.setItem(key, str); return true; } } catch (e) { /* 降级 */ }
      memStore[key] = str;
      return true;
    },
    remove: function (key) {
      try { if (LS) LS.removeItem(key); } catch (e) { /* 忽略 */ }
      delete memStore[key];
    },
    keys: function () {
      var out = [];
      try {
        if (LS) {
          for (var i = 0; i < LS.length; i++) out.push(LS.key(i));
          return out;
        }
      } catch (e) { /* 降级 */ }
      for (var k in memStore) { if (Object.prototype.hasOwnProperty.call(memStore, k)) out.push(k); }
      return out;
    }
  };

  function readJSON(key, fallback) {
    var raw = storage.get(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { storage.set(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function normCacheKey(key) {
    var k = String(key);
    if (k.indexOf('wh.') === 0) return k;
    return 'wh.' + k + '.v1';
  }

  function cityKey(city) {
    if (!city) return '';
    if (city.cmaStationId) return 'cma:' + city.cmaStationId;
    return (city.name || '') + '@' + Number(city.lat).toFixed(2) + ',' + Number(city.lon).toFixed(2);
  }

  var cache = {
    KEYS: KEYS,
    /**
     * load()            -> {city, results, fetchedAt, savedAt}
     * load('wh.xxx.v1') / load('city') -> 对应 localStorage 键的 JSON 值
     */
    load: function (key) {
      if (key !== undefined && key !== null && key !== '') return readJSON(normCacheKey(key), null);
      var stored = readJSON(KEYS.cache, null) || {};
      var city = readJSON(KEYS.city, null);
      return {
        city: city,
        results: Array.isArray(stored.results) ? stored.results : [],
        fetchedAt: isNum(stored.fetchedAt) ? stored.fetchedAt : 0,
        savedAt: isNum(stored.savedAt) ? stored.savedAt : 0
      };
    },
    /** 保存最近一次刷新结果 + 当前城市 */
    save: function (city, results) {
      var ts = nowMs();
      writeJSON(KEYS.cache, {
        results: Array.isArray(results) ? results : [],
        fetchedAt: ts,
        savedAt: ts
      });
      if (city) writeJSON(KEYS.city, city);
      return true;
    },
    /** 清除天气缓存与上次城市（保留设置与已保存城市列表） */
    clear: function () {
      storage.remove(KEYS.cache);
      storage.remove(KEYS.city);
      return true;
    },
    /** 清除全部 wh.* 数据（设置也会重置，调试/重置用） */
    clearAll: function () {
      var keys = storage.keys() || [];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (typeof k === 'string' && k.indexOf('wh.') === 0) storage.remove(k);
      }
      return true;
    },
    getLastCity: function () { return readJSON(KEYS.city, null); },
    setLastCity: function (city) { return city ? writeJSON(KEYS.city, city) : false; },
    /** 已保存城市列表 */
    savedCities: function () {
      var list = readJSON(KEYS.cities, []);
      return Array.isArray(list) ? list : [];
    },
    addSavedCity: function (city) {
      if (!city || !isNum(Number(city.lat)) || !isNum(Number(city.lon))) return false;
      var key = cityKey(city);
      var list = cache.savedCities();
      var next = [];
      for (var i = 0; i < list.length; i++) {
        if (cityKey(list[i]) !== key) next.push(list[i]);
      }
      next.unshift(clone(city));
      if (next.length > 20) next = next.slice(0, 20);
      return writeJSON(KEYS.cities, next);
    },
    removeSavedCity: function (idOrCity) {
      var key = (idOrCity && typeof idOrCity === 'object') ? cityKey(idOrCity) : String(idOrCity || '');
      var list = cache.savedCities();
      var next = [];
      var removed = false;
      for (var i = 0; i < list.length; i++) {
        var k = cityKey(list[i]);
        if (k === key || String(list[i] && list[i].id) === key) { removed = true; } else { next.push(list[i]); }
      }
      if (removed) writeJSON(KEYS.cities, next);
      return removed;
    },
    cityKey: cityKey,
    _storage: storage
  };

  /* ======================================================================
   * 3. settings（单位 / 数据源 / key / 主题 / 自动刷新）
   * ==================================================================== */

  var DEFAULT_ENABLED_SOURCES = ['cma', 'open-meteo', 'metno', 'wttr'];

  var DEFAULT_SETTINGS = {
    unit: 'c',                 // 'c' | 'f'
    windUnit: 'kmh',           // 'kmh' | 'ms'
    enabledSources: DEFAULT_ENABLED_SOURCES.slice(),
    qweatherKey: '',
    owmKey: '',
    qweatherHost: 'devapi.qweather.com',
    theme: 'dark',             // 'dark' | 'light' | 'auto'
    refreshMinutes: 10         // 自动刷新间隔（分钟，1~120）
  };

  function normalizeSettings(input) {
    var out = clone(DEFAULT_SETTINGS);
    if (input && typeof input === 'object') {
      for (var k in DEFAULT_SETTINGS) {
        if (Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined) out[k] = input[k];
      }
    }
    out.unit = (String(out.unit).toLowerCase() === 'f') ? 'f' : 'c';
    out.windUnit = (String(out.windUnit).toLowerCase() === 'ms') ? 'ms' : 'kmh';
    out.theme = (['dark', 'light', 'auto'].indexOf(String(out.theme)) >= 0) ? String(out.theme) : 'dark';
    // 0 = 手动（不自动刷新），其余 1~120 分钟
    var rm = Number(out.refreshMinutes);
    if (!isFinite(rm) || rm < 0) rm = 10;
    out.refreshMinutes = Math.min(120, Math.round(rm));
    out.qweatherKey = String(out.qweatherKey || '').trim();
    out.owmKey = String(out.owmKey || '').trim();
    out.qweatherHost = String(out.qweatherHost || 'devapi.qweather.com').trim() || 'devapi.qweather.com';
    var enabled = [];
    if (Array.isArray(out.enabledSources)) {
      for (var i = 0; i < out.enabledSources.length; i++) {
        var id = String(out.enabledSources[i] || '').trim();
        if (id && enabled.indexOf(id) < 0) enabled.push(id);
      }
    }
    out.enabledSources = enabled;
    return out;
  }

  var settings = {
    DEFAULTS: clone(DEFAULT_SETTINGS),
    get: function () { return normalizeSettings(readJSON(KEYS.settings, null)); },
    set: function (patch) {
      var cur = settings.get();
      var next = normalizeSettings(extend(cur, patch || {}));
      writeJSON(KEYS.settings, next);
      emitEvent('wh:settings', clone(next));
      return next;
    },
    reset: function () {
      storage.remove(KEYS.settings);
      var s = settings.get();
      emitEvent('wh:settings', clone(s));
      return s;
    }
  };

  /* ======================================================================
   * 4. utils（格式化 + 图标 SVG 字符串）
   * ==================================================================== */

  var WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') { var d1 = new Date(v); return isNaN(d1.getTime()) ? null : d1; }
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return null;
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
        var p = s.split('-');
        return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      }
      var t = Date.parse(s);
      if (!isNaN(t)) return new Date(t);
      if (/^\d{1,2}:\d{1,2}/.test(s)) {
        var hm = s.split(':');
        var dd = new Date();
        dd.setHours(Number(hm[0]), Number(hm[1]), 0, 0);
        return dd;
      }
      return null;
    }
    return null;
  }

  function fmtTemp(value, opts) {
    opts = opts || {};
    var v = numOrNull(value);
    if (v === null) return opts.placeholder !== undefined ? opts.placeholder : '--';
    var s = settings.get();
    var unit = opts.unit === 'f' || opts.unit === 'c' ? opts.unit : s.unit;
    if (unit === 'f') v = v * 9 / 5 + 32;
    var digits = opts.digits === undefined ? 0 : opts.digits;
    var num = v.toFixed(digits);
    if (opts.raw === true) return num;
    if (opts.unitChar === true) return num + '°' + (unit === 'f' ? 'F' : 'C');
    return num + '°';
  }

  function fmtWind(value, opts) {
    opts = opts || {};
    var v = numOrNull(value); // 单位：m/s
    if (v === null) return opts.placeholder !== undefined ? opts.placeholder : '--';
    var s = settings.get();
    var unit = opts.unit === 'ms' || opts.unit === 'kmh' ? opts.unit : s.windUnit;
    if (unit === 'ms') {
      var ms = v.toFixed(opts.digits === undefined ? 1 : opts.digits);
      return opts.raw === true ? ms : ms + (opts.noUnit === true ? '' : ' m/s');
    }
    var kmh = (v * 3.6).toFixed(opts.digits === undefined ? 0 : opts.digits);
    return opts.raw === true ? kmh : kmh + (opts.noUnit === true ? '' : ' km/h');
  }

  function fmtTime(value, opts) {
    opts = opts || {};
    var d = toDate(value);
    if (!d) {
      if (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value.trim())) return value.trim().slice(0, 5);
      return opts.placeholder !== undefined ? opts.placeholder : '--';
    }
    var out = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (opts.seconds === true) out += ':' + pad2(d.getSeconds());
    return out;
  }

  function fmtDate(value, opts) {
    opts = opts || {};
    var d = toDate(value);
    if (!d) return opts.placeholder !== undefined ? opts.placeholder : '--';
    var out = '';
    if (opts.year === true) out += d.getFullYear() + '年';
    out += (d.getMonth() + 1) + '月' + d.getDate() + '日';
    if (opts.weekday === true) out += ' 周' + WEEK_CN[d.getDay()];
    return out;
  }

  function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function dayLabel(value, opts) {
    opts = opts || {};
    var d = toDate(value);
    if (!d) return opts.placeholder !== undefined ? opts.placeholder : '';
    var today = startOfLocalDay(new Date());
    var target = startOfLocalDay(d);
    var diff = Math.round((target - today) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === 2) return '后天';
    if (diff === -1) return '昨天';
    return '周' + WEEK_CN[d.getDay()];
  }

  function minutesAgo(value) {
    var d = toDate(value);
    if (!d) return '';
    var diff = nowMs() - d.getTime();
    if (diff < 0) return '刚刚';
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    var days = Math.floor(hours / 24);
    if (days < 7) return days + ' 天前';
    return fmtDate(d);
  }

  // 风向：8 方位中文 + 箭头（16 方位取最近 8 方位）
  var WIND_DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  var WIND_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

  function windDirText(deg) {
    var v = numOrNull(deg);
    if (v === null) return '';
    var idx = Math.round(((v % 360) + 360) % 360 / 45) % 8;
    return WIND_DIRS[idx] + '风';
  }

  function windDirArrow(deg) {
    var v = numOrNull(deg);
    if (v === null) return '';
    var idx = Math.round(((v % 360) + 360) % 360 / 45) % 8;
    return WIND_ARROWS[idx];
  }

  // ---- 天气图标：内联 SVG 字符串（stroke 风格，颜色跟随 currentColor）----
  var ICON_BODIES = {
    'sun': '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.2v2.1M12 19.8v2.1M2.2 12h2.1M19.7 12h2.1M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>',
    'cloud-sun': '<circle cx="8" cy="6.2" r="2.1"/><path d="M8 2.3v1.2M3.9 6.2H2.7M5.1 3.3l-.85-.85M10.9 3.3l.85-.85"/><path d="M19 18.2H9.8a3.5 3.5 0 0 1-.5-6.96A5.15 5.15 0 0 1 18.7 12.5 3.1 3.1 0 0 1 19 18.2z"/>',
    'cloud': '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    'rain': '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/><path d="M8 19.5v2M12 18.5v3M16 19.5v2"/>',
    'heavy-rain': '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/><path d="M7 17.5v3.5M11 17.5v3.5M15 17.5v3.5M19 17.5v3.5"/>',
    'thunder': '<path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9"/><polyline points="13 11 9 17 15 17 11 23"/>',
    'snow': '<path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"/><path d="M8 18v3.5M6.5 19.6l3 1.8M6.5 21.4l3-1.8M16 18v3.5M14.5 19.6l3 1.8M14.5 21.4l3-1.8"/>',
    'fog': '<path d="M4 9h16M3 13h18M6 17h12M9 21h6"/>',
    'dust': '<path d="M3 8h9.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12h13a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 16h6.5"/><path d="M16 8h.01M13.5 16h.01M20 12h.01"/>',
    'shower': '<circle cx="17.2" cy="5.2" r="1.9"/><path d="M17.2 1.8v1.1M20.9 5.2h1.1M19.8 2.6l.8-.8"/><path d="M15 13.6H6.6a3.4 3.4 0 0 1-.4-6.77A5.05 5.05 0 0 1 15.8 8.3 3.1 3.1 0 0 1 15 13.6z"/><path d="M9 17.2l-1 3M14 17.2l-1 3M19 17.2l-1 3"/>',
    'sleet': '<path d="M20 15.58A5 5 0 0 0 18 6h-1.26A8 8 0 1 0 4 14.25"/><path d="M8.5 17.5v3.5M7 18.8l3 1.6M7 20.4l3-1.6"/><path d="M15.5 17.5v3.5"/>',
    'unknown': '<circle cx="12" cy="12" r="9.2"/><path d="M9.6 9.2a2.6 2.6 0 1 1 3.7 2.4c-.8.4-1.3 1.1-1.3 2v.5"/><path d="M12 17.2h.01"/>'
  };

  function iconSvg(name, opts) {
    opts = opts || {};
    var key = String(name || '').toLowerCase();
    var body = ICON_BODIES[key] || ICON_BODIES['unknown'];
    var size = Number(opts.size) || 24;
    var strokeWidth = opts.strokeWidth === undefined ? 2 : opts.strokeWidth;
    var color = opts.color || 'currentColor';
    var cls = opts.className ? ' class="' + String(opts.className).replace(/"/g, '') + '"' : '';
    var extra = opts.style ? ' style="' + String(opts.style).replace(/"/g, '') + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
      ' fill="none" stroke="' + color + '" stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true" focusable="false"' + cls + extra + '>' + body + '</svg>';
  }

  WH.utils = {
    toDate: toDate,
    fmtTemp: fmtTemp,
    fmtWind: fmtWind,
    fmtTime: fmtTime,
    fmtDate: fmtDate,
    dayLabel: dayLabel,
    minutesAgo: minutesAgo,
    windDirText: windDirText,
    windDirArrow: windDirArrow,
    iconSvg: iconSvg,
    iconNames: ['sun', 'cloud-sun', 'cloud', 'rain', 'heavy-rain', 'thunder', 'snow', 'fog', 'dust', 'shower', 'sleet', 'unknown']
  };

  /* ======================================================================
   * 5. 原生桥封装 + 浏览器回退
   * ==================================================================== */

  var DEFAULT_TIMEOUT = 12000;
  var RETRY_DELAY = 300;

  var native = null;
  try {
    if (typeof global.AndroidApp !== 'undefined' && global.AndroidApp) native = global.AndroidApp;
  } catch (e) { native = null; }

  // 异步回调挂起表
  var pendingHttp = {};
  var pendingLocation = {};
  var seq = 0;
  var localLogs = [];

  function pushLocalLog(level, msg) {
    try {
      localLogs.push({ t: nowMs(), level: String(level || 'info'), msg: String(msg || '') });
      if (localLogs.length > 200) localLogs.splice(0, localLogs.length - 200);
    } catch (e) { /* 忽略 */ }
  }

  function parseMaybeJSON(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function normalizeNativeHttp(parsed, startedAt) {
    var status = parsed && isNum(parsed.status) ? parsed.status : 0;
    var body = parsed && typeof parsed.body === 'string' ? parsed.body : '';
    var ms = (parsed && isNum(parsed.ms)) ? parsed.ms : (nowMs() - startedAt);
    var httpOk = status === 0 ? true : (status >= 200 && status < 400);
    var ok = !!(parsed && parsed.ok !== false) && httpOk;
    var out = { ok: ok, status: status, body: body, ms: ms };
    if (parsed && typeof parsed.url === 'string') out.url = parsed.url;
    if (!ok) {
      if (parsed && typeof parsed.error === 'string' && parsed.error) out.error = parsed.error;
      else if (status >= 400) out.error = 'http_' + status;
      else out.error = 'native_error';
    }
    return out;
  }

  function normalizeNativeLocation(parsed) {
    if (!parsed) return { ok: false, error: 'native_error' };
    if (parsed.ok === true && isNum(Number(parsed.lat)) && isNum(Number(parsed.lon))) {
      return {
        ok: true,
        lat: Number(parsed.lat),
        lon: Number(parsed.lon),
        accuracy: numOrNull(parsed.accuracy),
        provider: typeof parsed.provider === 'string' ? parsed.provider : 'native',
        ts: isNum(parsed.ts) ? parsed.ts : nowMs()
      };
    }
    return { ok: false, error: typeof parsed.error === 'string' && parsed.error ? parsed.error : 'unavailable' };
  }

  // 原生异步回调（SPEC 第 5 节）：window.__nativeHttpDone / window.__nativeLocation
  global.__nativeHttpDone = function (reqId, resultJson) {
    var pending = pendingHttp[reqId];
    if (!pending) return;
    delete pendingHttp[reqId];
    if (pending.timer) clearTimeout(pending.timer);
    var parsed = parseMaybeJSON(resultJson);
    pending.resolve(normalizeNativeHttp(parsed, pending.startedAt));
  };

  global.__nativeLocation = function (reqId, resultJson) {
    var pending = pendingLocation[reqId];
    if (!pending) return;
    delete pendingLocation[reqId];
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(normalizeNativeLocation(parseMaybeJSON(resultJson)));
  };

  function isLocalHost() {
    try {
      if (!global.location) return false;
      var h = String(global.location.hostname || '');
      return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]' ||
        /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h);
    } catch (e) { return false; }
  }

  // 浏览器回退：本机开发时通过 dev-server 代理（window.__DEV_PROXY__）绕过 CORS。
  // 支持：字符串 '/__proxy'；或对象 {url|base|prefix, force?}
  function getDevProxy() {
    var p = null;
    try { p = global.__DEV_PROXY__; } catch (e) { p = null; }
    if (!p) return null;
    if (typeof p === 'string') return { base: p, force: false };
    if (typeof p === 'object') {
      var base = p.url || p.base || p.prefix || (p.proxy === true ? '/__proxy' : null);
      if (!base) return null;
      return { base: String(base), force: !!p.force };
    }
    return null;
  }

  function resolveRequestUrl(url) {
    var proxy = getDevProxy();
    if (!proxy) return url;
    if (!isLocalHost() && !proxy.force) return url;
    var base = proxy.base;
    if (base.indexOf('{url}') >= 0) return base.replace('{url}', encodeURIComponent(url));
    if (/[?&=]$/.test(base)) return base + encodeURIComponent(url);
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'url=' + encodeURIComponent(url);
  }

  function classifyFetchError(err) {
    if (!err) return 'network';
    var name = String(err.name || '');
    var msg = String(err.message || '');
    if (name === 'AbortError' || /abort/i.test(msg)) return 'timeout';
    if (/Failed to fetch|NetworkError|network|fetch failed|load failed/i.test(name + ' ' + msg)) return 'network';
    return 'network';
  }

  function normalizeHeaders(headers) {
    var out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (var k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k) && headers[k] !== undefined && headers[k] !== null) {
        out[k] = String(headers[k]);
      }
    }
    return out;
  }

  function browserFetch(url, headers, timeoutMs) {
    var started = nowMs();
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      var ctrl = null;
      function done(r) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      }
      if (typeof global.fetch !== 'function') {
        done({ ok: false, status: 0, body: '', ms: 0, error: 'no_fetch' });
        return;
      }
      var finalUrl = resolveRequestUrl(url);
      try {
        if (typeof AbortController === 'function') ctrl = new AbortController();
        else if (global.AbortController) ctrl = new global.AbortController();
      } catch (e) { ctrl = null; }
      timer = setTimeout(function () {
        try { if (ctrl) ctrl.abort(); } catch (e) { /* 忽略 */ }
        done({ ok: false, status: 0, body: '', ms: nowMs() - started, error: 'timeout' });
      }, Math.max(1000, timeoutMs));
      var init = { method: 'GET', headers: headers || {}, cache: 'no-store', redirect: 'follow', credentials: 'omit' };
      if (ctrl) init.signal = ctrl.signal;
      var p;
      try {
        p = global.fetch(finalUrl, init);
      } catch (e) {
        done({ ok: false, status: 0, body: '', ms: nowMs() - started, error: 'network' });
        return;
      }
      Promise.resolve(p).then(function (res) {
        return Promise.resolve(res.text()).then(function (text) { return { res: res, text: text }; });
      }).then(function (x) {
        var ok = !!x.res.ok;
        done({
          ok: ok,
          status: x.res.status,
          body: x.text || '',
          ms: nowMs() - started,
          url: x.res.url || finalUrl,
          error: ok ? undefined : ('http_' + x.res.status)
        });
      }).catch(function (err) {
        done({ ok: false, status: 0, body: '', ms: nowMs() - started, error: classifyFetchError(err) });
      });
    });
  }

  function nativeHttp(url, headers, timeoutMs) {
    var started = nowMs();
    return new Promise(function (resolve) {
      var reqId = 'h' + (++seq) + '_' + started;
      var guard = timeoutMs + 3000; // 原生自身超时 + 兜底
      var timer = setTimeout(function () {
        if (!pendingHttp[reqId]) return;
        delete pendingHttp[reqId];
        resolve({ ok: false, status: 0, body: '', ms: nowMs() - started, error: 'timeout' });
      }, guard);
      pendingHttp[reqId] = { resolve: resolve, timer: timer, startedAt: started };
      try {
        native.httpFetch(reqId, url, JSON.stringify(headers || {}), Math.round(timeoutMs));
      } catch (e) {
        delete pendingHttp[reqId];
        clearTimeout(timer);
        resolve({ ok: false, status: 0, body: '', ms: nowMs() - started, error: 'native_error' });
      }
    });
  }

  function requestOnce(url, headers, timeoutMs) {
    if (native && isFn(native.httpFetch)) return nativeHttp(url, headers, timeoutMs);
    return browserFetch(url, headers, timeoutMs);
  }

  function retryable(result) {
    if (!result || result.ok) return false;
    var err = String(result.error || '');
    if (err === 'timeout' || err === 'network' || err === 'abort' || err === 'native_error') return true;
    if (isNum(result.status) && result.status >= 500) return true;
    return false;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * GET 请求，统一返回 Promise<{ok,status,body,ms,error?}>（不会 reject）
   * opts: {headers={}, timeout=12000, retries=0}
   */
  function httpGet(url, opts) {
    opts = opts || {};
    var headers = normalizeHeaders(opts.headers);
    var timeout = clamp(Number(opts.timeout) || DEFAULT_TIMEOUT, 1000, 30000);
    var retries = clamp(Math.floor(Number(opts.retries) || 0), 0, 2);
    var attempt = 0;
    function run() {
      attempt++;
      return requestOnce(url, headers, timeout).then(function (res) {
        if (!res || res.ok || attempt > retries || !retryable(res)) return res;
        return delay(RETRY_DELAY * attempt).then(run);
      });
    }
    return run();
  }

  function getNativeLocation(opts) {
    opts = opts || {};
    var timeout = clamp(Number(opts.timeout) || DEFAULT_TIMEOUT, 1000, 25000);
    if (native && isFn(native.getLocation)) {
      var started = nowMs();
      return new Promise(function (resolve) {
        var reqId = 'l' + (++seq) + '_' + started;
        var timer = setTimeout(function () {
          if (!pendingLocation[reqId]) return;
          delete pendingLocation[reqId];
          resolve({ ok: false, error: 'timeout' });
        }, timeout + 4000);
        pendingLocation[reqId] = { resolve: resolve, timer: timer, startedAt: started };
        try {
          native.getLocation(reqId);
        } catch (e) {
          delete pendingLocation[reqId];
          clearTimeout(timer);
          resolve({ ok: false, error: 'native_error' });
        }
      });
    }
    // 浏览器回退：navigator.geolocation（手机 Chrome 预览时可用）
    return new Promise(function (resolve) {
      var geo = global.navigator && global.navigator.geolocation;
      if (!geo || !isFn(geo.getCurrentPosition)) {
        resolve({ ok: false, error: 'unavailable' });
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'timeout' });
      }, timeout);
      function finish(r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
      try {
        geo.getCurrentPosition(function (pos) {
          finish({
            ok: true,
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: numOrNull(pos.coords.accuracy),
            provider: 'browser',
            ts: pos.timestamp || nowMs()
          });
        }, function (err) {
          var code = err && err.code === 1 ? 'permission_denied' : (err && err.code === 3 ? 'timeout' : 'unavailable');
          finish({ ok: false, error: code });
        }, { enableHighAccuracy: false, timeout: timeout, maximumAge: 300000 });
      } catch (e) {
        finish({ ok: false, error: 'unavailable' });
      }
    });
  }

  function deviceInfo() {
    if (native && isFn(native.deviceInfo)) {
      try {
        var parsed = parseMaybeJSON(native.deviceInfo());
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (e) { /* 忽略 */ }
    }
    var nav = global.navigator || {};
    var model = '';
    try {
      if (nav.userAgentData && nav.userAgentData.platform) model = nav.userAgentData.platform;
      else model = nav.platform || nav.userAgent || 'Browser';
    } catch (e) { model = 'Browser'; }
    return {
      model: model,
      android: '',
      appVersion: VERSION,
      screenW: global.innerWidth || 0,
      screenH: global.innerHeight || 0,
      dpr: global.devicePixelRatio || 1
    };
  }

  function toast(msg) {
    var text = String(msg === undefined || msg === null ? '' : msg);
    if (native && isFn(native.toast)) {
      try { native.toast(text); return; } catch (e) { /* 回退 */ }
    }
    pushLocalLog('info', text);
    if (typeof global.document === 'undefined' || !global.document) {
      try { if (typeof console !== 'undefined') console.log('[toast]', text); } catch (e) { /* 忽略 */ }
      return;
    }
    try {
      var doc = global.document;
      var el = doc.getElementById('wh-toast');
      if (!el) {
        el = doc.createElement('div');
        el.id = 'wh-toast';
        el.setAttribute('role', 'status');
        el.style.cssText = 'position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
          'z-index:9999;max-width:82vw;padding:9px 16px;border-radius:999px;background:rgba(20,24,36,.92);' +
          'color:#eef2ff;font:14px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif;text-align:center;' +
          'box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .18s ease;pointer-events:none;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        doc.body.appendChild(el);
      }
      el.textContent = text;
      el.style.opacity = '1';
      if (el.__whTimer) clearTimeout(el.__whTimer);
      el.__whTimer = setTimeout(function () {
        try { el.style.opacity = '0'; } catch (e) { /* 忽略 */ }
      }, 2200);
    } catch (e) { /* 忽略 */ }
  }

  function openUrl(url) {
    var target = String(url || '');
    if (!target) return;
    if (native && isFn(native.openUrl)) {
      try { native.openUrl(target); return; } catch (e) { /* 回退 */ }
    }
    try {
      if (global.open) {
        var win = global.open(target, '_blank', 'noopener,noreferrer');
        if (win) return;
      }
    } catch (e) { /* 忽略 */ }
    try { if (global.location) global.location.href = target; } catch (e) { /* 忽略 */ }
  }

  function log(level, msg) {
    var lv = String(level || 'info');
    var text = String(msg === undefined || msg === null ? '' : msg);
    pushLocalLog(lv, text);
    if (native && isFn(native.log)) {
      try { native.log(lv, text); return; } catch (e) { /* 回退 */ }
    }
    try {
      if (typeof console !== 'undefined') {
        if (lv === 'error' && console.error) console.error('[WH]', text);
        else if (lv === 'warn' && console.warn) console.warn('[WH]', text);
        else if (console.log) console.log('[WH]', text);
      }
    } catch (e) { /* 忽略 */ }
  }

  function getLogs() {
    if (native && isFn(native.getLogs)) {
      try {
        var raw = native.getLogs();
        var parsed = parseMaybeJSON(raw);
        if (parsed) return parsed;
      } catch (e) { /* 忽略 */ }
    }
    return localLogs.slice();
  }

  WH.bridge = {
    available: !!native,
    version: VERSION,
    httpGet: httpGet,
    getNativeLocation: getNativeLocation,
    toast: toast,
    deviceInfo: deviceInfo,
    openUrl: openUrl,
    log: log,
    getLogs: getLogs,
    /** 内部/调试用：当前请求是否走代理 */
    _resolveRequestUrl: resolveRequestUrl,
    _isLocalHost: isLocalHost
  };

  /* ======================================================================
   * 6. 基础导出
   * ==================================================================== */

  WH.cache = cache;
  WH.settings = settings;

  // 兜底：sources.js 加载后会覆盖为完整列表
  WH.meta = WH.meta || { sources: [] };

  log('info', 'WH bridge 初始化完成（原生桥：' + (native ? '可用' : '不可用，浏览器回退') + '）');
})(typeof window !== 'undefined' ? window : globalThis);
