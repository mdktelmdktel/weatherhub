/*!
 * WeatherHub（天气汇）数据层 — sources.js
 * ---------------------------------------------------------------------------
 * 6 个平台适配器（CMA / Open-Meteo / MET Norway / wttr.in / 和风天气 / OWM），
 * 统一归一化为 SPEC 第 6 节的 Current / HourPoint / DayPoint / SourceResult 模型。
 *
 * 关键约定：
 *   - fetchAll 内部并发 ≤3，每个源独立 try/catch，单源失败绝不抛异常；
 *   - 所有请求 12s 超时 + 1 次重试（wttr 等易失败源）；
 *   - 单位：°C / % / m/s / hPa / km / mm / 0-360° / UV 指数；
 *   - CMA 必须先经 /api/autocomplete 拿 stationId（结果按名称缓存）；
 *   - 天气码映射见下方 WMO_MAP / CMA_MAP / mapMetno / WTTR_MAP / mapOwm / textToCode，
 *     统一码见 SPEC CODES（0..12），每个码带中文名与 icon 名。
 *
 * 加载方式：普通 <script>（IIFE），无 ES module / 外部依赖。
 */
(function (global) {
  'use strict';

  var WH = global.WH = global.WH || {};

  /* ======================================================================
   * 0. 常量
   * ==================================================================== */

  var MAX_CONCURRENCY = 3;              // 同时进行的网络请求（含 AQI）
  var DEFAULT_REQUEST_TIMEOUT = 12000;  // 单次请求超时（SPEC 第 2 节）
  var MAX_HOURLY_HOURS = 48;            // 逐时最多保留 48h
  var MAX_DAILY_DAYS = 7;               // 7 天预报

  // 统一天气现象码（SPEC 第 6 节，冻结）
  var CODES = {
    CLEAR: 0, PARTLY: 1, CLOUDY: 2, LIGHT_RAIN: 3, RAIN: 4, HEAVY_RAIN: 5,
    THUNDER: 6, SNOW: 7, FOG: 8, DUST: 9, SHOWER: 10, SLEET: 11, UNKNOWN: 12
  };

  // 每个 code 的中文名与 icon 名
  var CODE_META = {
    0: { name: '晴', icon: 'sun' },
    1: { name: '多云', icon: 'cloud-sun' },
    2: { name: '阴', icon: 'cloud' },
    3: { name: '小雨', icon: 'rain' },
    4: { name: '中雨', icon: 'rain' },
    5: { name: '大雨', icon: 'heavy-rain' },
    6: { name: '雷阵雨', icon: 'thunder' },
    7: { name: '雪', icon: 'snow' },
    8: { name: '雾', icon: 'fog' },
    9: { name: '沙尘', icon: 'dust' },
    10: { name: '阵雨', icon: 'shower' },
    11: { name: '雨夹雪', icon: 'sleet' },
    12: { name: '未知', icon: 'unknown' }
  };

  // 平台元信息（SourceMeta）
  var META = [
    {
      id: 'cma', name: '中国气象局', short: 'CMA', color: '#2f80ed',
      homepage: 'https://weather.cma.cn/', kind: 'official',
      note: '官方实况与 7 天预报（含气象预警）'
    },
    {
      id: 'open-meteo', name: 'Open-Meteo', short: 'OM', color: '#f2994a',
      homepage: 'https://open-meteo.com/', kind: 'model',
      note: '欧洲模型集合，逐时预报'
    },
    {
      id: 'metno', name: 'MET Norway / Yr', short: 'MET', color: '#17a2b8',
      homepage: 'https://www.met.no/', kind: 'model',
      note: '挪威气象研究所，逐时+10 天'
    },
    {
      id: 'wttr', name: 'wttr.in', short: 'WTTR', color: '#9b51e0',
      homepage: 'https://wttr.in/', kind: 'aggregator',
      note: 'World Weather Online 聚合'
    },
    {
      id: 'qweather', name: '和风天气', short: 'QWeather', color: '#27ae60',
      homepage: 'https://www.qweather.com/', kind: 'official', requiresKey: true,
      note: '需在设置中填写 API Key'
    },
    {
      id: 'owm', name: 'OpenWeatherMap', short: 'OWM', color: '#eb5757',
      homepage: 'https://openweathermap.org/', kind: 'aggregator', requiresKey: true,
      note: '需在设置中填写 API Key'
    }
  ];

  var META_BY_ID = {};
  for (var mi = 0; mi < META.length; mi++) META_BY_ID[META[mi].id] = META[mi];

  WH.meta = WH.meta || {};
  WH.meta.sources = META;
  WH.CODES = CODES;
  WH.CODE_META = CODE_META;
  WH.CODES_META = CODE_META;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }
  function round1(v) { return v === null || v === undefined ? null : Math.round(v * 10) / 10; }
  function round0(v) { return v === null || v === undefined ? null : Math.round(v); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function nowMs() { return Date.now(); }
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
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }
  function metaById(id) {
    if (!id) return null;
    return META_BY_ID[String(id)] || null;
  }
  function codeName(code) {
    var m = CODE_META[code];
    return m ? m.name : CODE_META[12].name;
  }
  function codeIcon(code) {
    var m = CODE_META[code];
    return m ? m.icon : CODE_META[12].icon;
  }
  function codeFamily(code) {
    if (code === CODES.LIGHT_RAIN || code === CODES.RAIN || code === CODES.HEAVY_RAIN || code === CODES.SHOWER) return 'rain';
    if (code === CODES.THUNDER) return 'thunder';
    if (code === CODES.SNOW) return 'snow';
    if (code === CODES.SLEET) return 'sleet';
    if (code === CODES.FOG) return 'fog';
    if (code === CODES.DUST) return 'dust';
    if (code === CODES.CLEAR || code === CODES.PARTLY || code === CODES.CLOUDY) return 'cloud';
    return 'unknown';
  }

  // 结构化错误
  function whError(message, code) {
    var e;
    try { e = new Error(message); } catch (err) { e = { message: message }; }
    e.code = code || 'error';
    e.isWhError = true;
    return e;
  }

  function friendlyError(err) {
    if (!err) return '请求失败';
    if (err.isWhError && err.message) return err.message;
    if (err.message) return err.message;
    return String(err);
  }

  /* ======================================================================
   * 1. 时间 / 时区工具
   * ==================================================================== */

  var HAS_INTL = false;
  try { HAS_INTL = (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'); } catch (e) { HAS_INTL = false; }

  /** 指定时刻 ts 在 tz 时区相对 UTC 的偏移（毫秒，东八区 = +8h） */
  function tzOffsetMs(ts, tz) {
    if (!tz) return -new Date(ts).getTimezoneOffset() * 60000;
    if (HAS_INTL) {
      try {
        var dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
        var parts = dtf.formatToParts(new Date(ts));
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].type === 'timeZoneName') {
            var v = parts[i].value;
            if (v === 'GMT' || v === 'UTC') return 0;
            var m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(v);
            if (m) {
              var sign = m[1] === '-' ? -1 : 1;
              var h = parseInt(m[2], 10) || 0;
              var mm = parseInt(m[3] || '0', 10) || 0;
              return sign * (h * 60 + mm) * 60000;
            }
          }
        }
      } catch (e) { /* 回退 */ }
    }
    try { return -new Date(ts).getTimezoneOffset() * 60000; } catch (e2) { return 0; }
  }

  /** 时区本地墙上时间 → epoch ms */
  function wallToEpoch(y, mo, d, h, mi, tz) {
    var guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, 0);
    var off = tzOffsetMs(guess, tz);
    var t = guess - off;
    var off2 = tzOffsetMs(t, tz);
    if (off2 !== off) t = guess - off2;
    return t;
  }

  /** 解析 "YYYY-MM-DD HH:mm[:ss]" / "YYYY/MM/DD HH:mm" / ISO 字符串为 epoch */
  function parseWallTime(str, tz) {
    if (str === null || str === undefined || str === '') return null;
    var s = String(str).trim();
    if (!s) return null;
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      var pt = Date.parse(s);
      if (!isNaN(pt)) return pt;
    }
    var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) return wallToEpoch(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), tz);
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  /** 时区本地日期 YYYY-MM-DD */
  function dateInTz(ts, tz) {
    var d = new Date(ts);
    if (tz && HAS_INTL) {
      try {
        var parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(d);
        var y = '', mo = '', da = '';
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].type === 'year') y = parts[i].value;
          else if (parts[i].type === 'month') mo = parts[i].value;
          else if (parts[i].type === 'day') da = parts[i].value;
        }
        if (y && mo && da) return y + '-' + mo + '-' + da;
      } catch (e) { /* 回退 */ }
    }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 时区本地小时（0-23） */
  function hourInTz(ts, tz) {
    if (tz && HAS_INTL) {
      try {
        var parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, hour: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date(ts));
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].type === 'hour') {
            var h = parseInt(parts[i].value, 10);
            if (isFinite(h)) return h === 24 ? 0 : h;
          }
        }
      } catch (e) { /* 回退 */ }
    }
    return new Date(ts).getHours();
  }

  /** "2026/10/31" -> "2026-10-31" */
  function normDateStr(str) {
    if (!str) return '';
    var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(String(str).trim());
    if (!m) return '';
    return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
  }

  function isDayByHour(ts, tz) {
    var h = hourInTz(ts, tz);
    return h >= 6 && h < 18;
  }

  /** 体感温度近似（Steadman 公式：temp + 湿度项 - 风速项），用于未提供体感的源 */
  function apparentTemp(tempC, humidity, windMs) {
    var t = numOrNull(tempC);
    if (t === null) return null;
    var rh = numOrNull(humidity);
    var ws = numOrNull(windMs);
    if (rh === null) rh = 60;
    if (ws === null) ws = 0;
    var e = (rh / 100) * 6.105 * Math.exp(17.27 * t / (237.7 + t));
    return Math.round((t + 0.33 * e - 0.70 * ws - 4.00) * 10) / 10;
  }

  /* ======================================================================
   * 2. HTTP / JSON
   * ==================================================================== */

  function reqTimeout(opts) {
    var t = Number((opts && opts.timeoutMs) || DEFAULT_REQUEST_TIMEOUT);
    if (!isFinite(t) || t <= 0) t = DEFAULT_REQUEST_TIMEOUT;
    return clamp(t, 4000, DEFAULT_REQUEST_TIMEOUT);
  }

  function httpErrorText(status) {
    if (status === 401 || status === 403) return '接口拒绝访问（' + status + '）';
    if (status === 404) return '接口不存在（404）';
    if (status === 429) return '请求过于频繁（429）';
    if (status >= 500) return '服务暂不可用（' + status + '）';
    return '请求失败（' + status + '）';
  }

  /** 请求并解析 JSON；失败抛结构化错误 */
  function requestJSON(url, opts) {
    opts = opts || {};
    var timeout = opts.timeout || DEFAULT_REQUEST_TIMEOUT;
    var retries = opts.retries === undefined ? 1 : opts.retries;
    return WH.bridge.httpGet(url, { headers: opts.headers, timeout: timeout, retries: retries })
      .then(function (res) {
        if (!res || !res.ok) {
          var status = res && res.status ? res.status : 0;
          var code = (res && res.error) || 'http_' + status;
          if (code === 'timeout') throw whError('请求超时（' + Math.round(timeout / 1000) + 's）', 'timeout');
          if (code === 'network') throw whError('网络不可达', 'network');
          if (code === 'no_fetch') throw whError('当前环境不支持网络请求', 'no_fetch');
          if (status >= 400) throw whError(httpErrorText(status), 'http_' + status);
          throw whError('请求失败（' + code + '）', code);
        }
        try {
          return JSON.parse(res.body);
        } catch (e) {
          throw whError('返回数据格式异常', 'parse');
        }
      });
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ======================================================================
   * 3. 天气码映射表（完整）
   * ==================================================================== */

  // 3.1 WMO weather_code（Open-Meteo）
  var WMO_MAP = {
    0: CODES.CLEAR, 1: CODES.PARTLY, 2: CODES.PARTLY, 3: CODES.CLOUDY,
    45: CODES.FOG, 48: CODES.FOG,
    51: CODES.LIGHT_RAIN, 53: CODES.LIGHT_RAIN, 55: CODES.LIGHT_RAIN,
    56: CODES.SLEET, 57: CODES.SLEET,
    61: CODES.LIGHT_RAIN, 63: CODES.RAIN, 65: CODES.HEAVY_RAIN,
    66: CODES.SLEET, 67: CODES.SLEET,
    71: CODES.SNOW, 73: CODES.SNOW, 75: CODES.SNOW, 77: CODES.SNOW,
    80: CODES.SHOWER, 81: CODES.SHOWER, 82: CODES.HEAVY_RAIN,
    85: CODES.SNOW, 86: CODES.SNOW,
    95: CODES.THUNDER, 96: CODES.THUNDER, 99: CODES.THUNDER
  };

  function mapWmo(code) {
    var n = numOrNull(code);
    if (n === null) return CODES.UNKNOWN;
    var v = WMO_MAP[Math.round(n)];
    return v === undefined ? CODES.UNKNOWN : v;
  }

  // 3.2 CMA 天气码（domain 与 dayCode / nightCode 一致）
  var CMA_MAP = {
    0: CODES.CLEAR, 1: CODES.PARTLY, 2: CODES.CLOUDY, 3: CODES.SHOWER,
    4: CODES.THUNDER, 5: CODES.THUNDER, 6: CODES.SLEET,
    7: CODES.LIGHT_RAIN, 8: CODES.RAIN, 9: CODES.HEAVY_RAIN, 10: CODES.HEAVY_RAIN,
    11: CODES.HEAVY_RAIN, 12: CODES.HEAVY_RAIN,
    13: CODES.SNOW, 14: CODES.SNOW, 15: CODES.SNOW, 16: CODES.SNOW, 17: CODES.SNOW,
    18: CODES.FOG, 19: CODES.SLEET, 20: CODES.DUST,
    21: CODES.RAIN, 22: CODES.RAIN, 23: CODES.HEAVY_RAIN, 24: CODES.HEAVY_RAIN, 25: CODES.HEAVY_RAIN,
    26: CODES.SNOW, 27: CODES.SNOW, 28: CODES.SNOW,
    29: CODES.DUST, 30: CODES.DUST, 31: CODES.DUST,
    32: CODES.FOG, 45: CODES.FOG, 49: CODES.FOG,
    53: CODES.DUST, 54: CODES.DUST, 55: CODES.DUST, 56: CODES.DUST,
    57: CODES.FOG, 58: CODES.FOG,
    301: CODES.SHOWER, 302: CODES.THUNDER,
    99: CODES.UNKNOWN
  };

  function mapCma(code) {
    var n = numOrNull(code);
    if (n === null) return CODES.UNKNOWN;
    var v = CMA_MAP[Math.round(n)];
    return v === undefined ? CODES.UNKNOWN : v;
  }

  // 3.3 MET Norway symbol_code（前缀规则，兼容 _day/_night/_polartwilight 后缀）
  function mapMetno(symbolCode) {
    if (!symbolCode) return CODES.UNKNOWN;
    var s = String(symbolCode).toLowerCase();
    var base = s.split('_')[0];
    if (base.indexOf('thunder') >= 0) return CODES.THUNDER;
    if (base.indexOf('sleet') >= 0) return CODES.SLEET;
    if (base.indexOf('snow') >= 0) return CODES.SNOW;
    if (base.indexOf('rainshowers') >= 0) return CODES.SHOWER;
    if (base.indexOf('rain') >= 0) {
      if (base.indexOf('heavy') >= 0) return CODES.HEAVY_RAIN;
      if (base.indexOf('light') >= 0) return CODES.LIGHT_RAIN;
      return CODES.RAIN;
    }
    if (base.indexOf('partlycloudy') >= 0) return CODES.PARTLY;
    if (base.indexOf('cloudy') >= 0) return CODES.CLOUDY;
    if (base.indexOf('clearsky') >= 0 || base === 'clear' || base === 'sun') return CODES.CLEAR;
    if (base.indexOf('fair') >= 0) return CODES.PARTLY;
    if (base.indexOf('fog') >= 0) return CODES.FOG;
    return CODES.UNKNOWN;
  }

  // 3.4 wttr.in / WWO weatherCode
  var WTTR_MAP = {
    113: CODES.CLEAR, 116: CODES.PARTLY, 119: CODES.CLOUDY, 122: CODES.CLOUDY,
    143: CODES.FOG, 149: CODES.DUST,
    176: CODES.LIGHT_RAIN, 179: CODES.SNOW, 182: CODES.SLEET, 185: CODES.SLEET,
    200: CODES.THUNDER, 227: CODES.SNOW, 230: CODES.SNOW,
    248: CODES.FOG, 260: CODES.FOG,
    263: CODES.LIGHT_RAIN, 266: CODES.LIGHT_RAIN, 281: CODES.SLEET, 284: CODES.SLEET,
    293: CODES.LIGHT_RAIN, 296: CODES.LIGHT_RAIN, 299: CODES.RAIN, 302: CODES.RAIN,
    305: CODES.HEAVY_RAIN, 308: CODES.HEAVY_RAIN,
    311: CODES.SLEET, 314: CODES.SLEET, 317: CODES.SLEET, 320: CODES.SLEET,
    323: CODES.SNOW, 326: CODES.SNOW, 329: CODES.SNOW, 332: CODES.SNOW, 335: CODES.SNOW, 338: CODES.SNOW,
    350: CODES.SLEET,
    353: CODES.SHOWER, 356: CODES.SHOWER, 359: CODES.HEAVY_RAIN,
    362: CODES.SLEET, 365: CODES.SLEET,
    368: CODES.SNOW, 371: CODES.SNOW,
    374: CODES.SLEET, 377: CODES.SLEET,
    386: CODES.THUNDER, 389: CODES.THUNDER, 392: CODES.THUNDER, 395: CODES.THUNDER
  };

  function mapWttr(code) {
    var n = numOrNull(code);
    if (n === null) return CODES.UNKNOWN;
    var v = WTTR_MAP[Math.round(n)];
    return v === undefined ? CODES.UNKNOWN : v;
  }

  // 3.5 OpenWeatherMap weather id（2xx 雷 / 3xx 毛毛雨 / 5xx 雨 / 6xx 雪 / 7xx 大气 / 8xx 晴云）
  function mapOwm(id) {
    var n = numOrNull(id);
    if (n === null) return CODES.UNKNOWN;
    n = Math.round(n);
    if (n >= 200 && n < 300) return CODES.THUNDER;
    if (n === 511) return CODES.SLEET;
    if (n >= 300 && n < 400) return CODES.LIGHT_RAIN;
    if (n >= 500 && n < 600) {
      if (n === 500) return CODES.LIGHT_RAIN;
      if (n === 501) return CODES.RAIN;
      if (n === 502 || n === 503 || n === 504) return CODES.HEAVY_RAIN;
      if (n === 520 || n === 521) return CODES.SHOWER;
      if (n === 522 || n === 531) return CODES.HEAVY_RAIN;
      return CODES.RAIN;
    }
    if (n >= 600 && n < 700) {
      if (n === 611 || n === 612 || n === 613 || n === 615 || n === 616) return CODES.SLEET;
      return CODES.SNOW;
    }
    if (n >= 700 && n < 800) {
      if (n === 741) return CODES.FOG;
      if (n === 701 || n === 711 || n === 721 || n === 731 || n === 751 || n === 761 || n === 762) return CODES.DUST;
      if (n === 771) return CODES.HEAVY_RAIN;
      if (n === 781) return CODES.THUNDER;
      return CODES.FOG;
    }
    if (n === 800) return CODES.CLEAR;
    if (n === 801 || n === 802) return CODES.PARTLY;
    if (n === 803 || n === 804) return CODES.CLOUDY;
    return CODES.UNKNOWN;
  }

  // 3.6 和风天气 icon code（数字）
  var QWEATHER_ICON_MAP = {
    100: CODES.CLEAR, 101: CODES.PARTLY, 102: CODES.PARTLY, 103: CODES.PARTLY, 104: CODES.CLOUDY,
    150: CODES.CLEAR, 151: CODES.PARTLY, 152: CODES.PARTLY, 153: CODES.PARTLY, 154: CODES.CLOUDY,
    300: CODES.SHOWER, 301: CODES.HEAVY_RAIN, 302: CODES.THUNDER, 303: CODES.THUNDER, 304: CODES.THUNDER,
    305: CODES.LIGHT_RAIN, 306: CODES.RAIN, 307: CODES.HEAVY_RAIN, 308: CODES.HEAVY_RAIN,
    309: CODES.LIGHT_RAIN, 310: CODES.HEAVY_RAIN, 311: CODES.HEAVY_RAIN, 312: CODES.HEAVY_RAIN,
    313: CODES.SLEET, 314: CODES.RAIN, 315: CODES.RAIN, 316: CODES.HEAVY_RAIN, 317: CODES.HEAVY_RAIN,
    318: CODES.HEAVY_RAIN, 399: CODES.RAIN,
    400: CODES.SNOW, 401: CODES.SNOW, 402: CODES.SNOW, 403: CODES.SNOW,
    404: CODES.SLEET, 405: CODES.SLEET, 406: CODES.SLEET, 407: CODES.SNOW,
    408: CODES.SNOW, 409: CODES.SNOW, 410: CODES.SNOW, 499: CODES.SNOW,
    500: CODES.FOG, 501: CODES.FOG, 502: CODES.DUST, 503: CODES.DUST, 504: CODES.DUST,
    505: CODES.DUST, 506: CODES.DUST, 507: CODES.DUST, 508: CODES.DUST, 509: CODES.FOG,
    510: CODES.FOG, 511: CODES.DUST, 512: CODES.DUST, 513: CODES.DUST, 514: CODES.FOG, 515: CODES.FOG,
    900: CODES.CLEAR, 901: CODES.CLEAR, 999: CODES.UNKNOWN
  };

  function mapQweather(iconCode, text) {
    var icon = numOrNull(iconCode);
    if (icon !== null) {
      var v = QWEATHER_ICON_MAP[Math.round(icon)];
      if (v !== undefined) return v;
    }
    return textToCode(text);
  }

  // 3.7 中文天气文案 → 统一码（用于没有数值码的源 / 兜底）
  function textToCode(text) {
    var s = String(text || '');
    if (!s) return CODES.UNKNOWN;
    if (/雷/.test(s)) return CODES.THUNDER;
    if (/雨夹雪|冻雨|冰粒|冻毛毛雨|雨雪/.test(s)) return CODES.SLEET;
    if (/雪/.test(s)) return CODES.SNOW;
    if (/暴雨|大暴雨|特大暴雨|大雨/.test(s)) return CODES.HEAVY_RAIN;
    if (/中雨/.test(s)) return CODES.RAIN;
    if (/小雨|毛毛雨|细雨|微雨/.test(s)) return CODES.LIGHT_RAIN;
    if (/阵雨/.test(s)) return CODES.SHOWER;
    if (/雨/.test(s)) return CODES.RAIN;
    if (/霾/.test(s)) return CODES.DUST;
    if (/雾/.test(s)) return CODES.FOG;
    if (/沙|尘/.test(s)) return CODES.DUST;
    if (/阴/.test(s)) return CODES.CLOUDY;
    if (/多云|少云|晴间|局部多云|大部分多云/.test(s)) return CODES.PARTLY;
    if (/晴|clear|sunny/i.test(s)) return CODES.CLEAR;
    // 英文文案兜底（wttr / OWM 等）
    if (/thunder|storm/i.test(s)) return CODES.THUNDER;
    if (/sleet|freezing rain|ice pellet/i.test(s)) return CODES.SLEET;
    if (/snow|blizzard/i.test(s)) return CODES.SNOW;
    if (/torrential|heavy rain/i.test(s)) return CODES.HEAVY_RAIN;
    if (/drizzle|light rain|patchy rain/i.test(s)) return CODES.LIGHT_RAIN;
    if (/shower/i.test(s)) return CODES.SHOWER;
    if (/rain/i.test(s)) return CODES.RAIN;
    if (/haze|smoke|dust|sand/i.test(s)) return CODES.DUST;
    if (/fog|mist/i.test(s)) return CODES.FOG;
    if (/overcast/i.test(s)) return CODES.CLOUDY;
    if (/partly|mostly cloudy/i.test(s)) return CODES.PARTLY;
    if (/cloudy/i.test(s)) return CODES.CLOUDY;
    if (/clear|sunny/i.test(s)) return CODES.CLEAR;
    return CODES.UNKNOWN;
  }

  /* ======================================================================
   * 4. 公共模型辅助
   * ==================================================================== */

  function makeHourPoint(t, temp, precipProb, precip, code, text) {
    var c = (code === null || code === undefined || code === CODES.UNKNOWN) ? null : code;
    return {
      t: t,
      temp: round1(numOrNull(temp)),
      precipProb: round0(numOrNull(precipProb)),
      precip: round1(numOrNull(precip)),
      code: c,
      text: c === null ? (text || '') : codeName(c)
    };
  }

  function makeDayPoint(date, tempMax, tempMin, code, text, extra) {
    var c = (code === null || code === undefined) ? CODES.UNKNOWN : code;
    var p = {
      date: date,
      tempMax: round1(numOrNull(tempMax)),
      tempMin: round1(numOrNull(tempMin)),
      code: c,
      text: text || codeName(c),
      icon: codeIcon(c),
      precipProb: round0(numOrNull(extra && extra.precipProb)),
      precipSum: round1(numOrNull(extra && extra.precipSum)),
      sunrise: (extra && extra.sunrise !== undefined) ? extra.sunrise : null,
      sunset: (extra && extra.sunset !== undefined) ? extra.sunset : null,
      windMax: round1(numOrNull(extra && extra.windMax)),
      uvMax: round1(numOrNull(extra && extra.uvMax))
    };
    return p;
  }

  function makeCurrent(partial) {
    var code = (partial.conditionCode === null || partial.conditionCode === undefined) ? CODES.UNKNOWN : partial.conditionCode;
    return {
      temp: round1(numOrNull(partial.temp)),
      feelsLike: round1(numOrNull(partial.feelsLike)),
      conditionCode: code,
      conditionText: partial.conditionText || codeName(code),
      icon: codeIcon(code),
      humidity: round0(numOrNull(partial.humidity)),
      windSpeed: round1(numOrNull(partial.windSpeed)),
      windDir: round0(numOrNull(partial.windDir)),
      windDirText: partial.windDirText || '',
      windGust: round1(numOrNull(partial.windGust)),
      pressure: round0(numOrNull(partial.pressure)),
      visibility: round1(numOrNull(partial.visibility)),
      uvIndex: round1(numOrNull(partial.uvIndex)),
      precip: round1(numOrNull(partial.precip)),
      cloudCover: round0(numOrNull(partial.cloudCover)),
      isDay: partial.isDay === undefined ? true : !!partial.isDay,
      observedAt: isNum(partial.observedAt) ? partial.observedAt : nowMs()
    };
  }

  function trimHourly(list, now, maxHours) {
    var start = Math.floor(now / 3600000) * 3600000;
    var end = start + (maxHours || MAX_HOURLY_HOURS) * 3600000;
    var seen = {};
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var p = list[i];
      if (!p || !isNum(p.t)) continue;
      if (p.t < start || p.t > end) continue;
      var key = Math.floor(p.t / 3600000);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(p);
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function trimDaily(list, city) {
    var tz = (city && city.timezone) || '';
    var today = dateInTz(nowMs(), tz);
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var d = list[i];
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) continue;
      if (d.date < today) continue;
      out.push(d);
    }
    out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    return out.slice(0, MAX_DAILY_DAYS);
  }

  /* ======================================================================
   * 5. CMA 站点解析 / autocomplete 缓存
   * ==================================================================== */

  var CMA_BASE = 'https://weather.cma.cn';
  var stationMem = null;

  function loadStationCache() {
    if (stationMem) return stationMem;
    stationMem = {};
    try {
      var raw = WH.cache && WH.cache._storage ? WH.cache._storage.get(WH.cache.KEYS.cmaStation) : null;
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') stationMem = parsed;
      }
    } catch (e) { stationMem = {}; }
    return stationMem;
  }

  function saveStationCache() {
    try {
      if (WH.cache && WH.cache._storage) {
        WH.cache._storage.set(WH.cache.KEYS.cmaStation, JSON.stringify(stationMem || {}));
      }
    } catch (e) { /* 忽略 */ }
  }

  function parseCmaAutocomplete(json) {
    var out = [];
    var arr = json && json.data;
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (typeof item === 'string') {
        var parts = item.split('|');
        if (parts.length >= 2 && parts[0]) {
          out.push({
            stationId: String(parts[0]).trim(),
            name: String(parts[1] || '').trim(),
            enName: String(parts[2] || '').trim(),
            country: String(parts[3] || '').trim()
          });
        }
      } else if (item && typeof item === 'object') {
        var id = item.stationId || item.id || item.stationid;
        var name = item.name || item.city;
        if (id && name) {
          out.push({
            stationId: String(id).trim(),
            name: String(name).trim(),
            enName: String(item.enName || item.pinyin || '').trim(),
            country: String(item.country || '').trim()
          });
        }
      }
    }
    return out;
  }

  function normName(s) {
    return String(s || '')
      .replace(/[\s·]/g, '')
      .replace(/(特别行政区|自治州|自治县|地区|市辖区|新区|林区|矿区|市|县|旗|区|镇)$/, '');
  }

  function matchCmaStation(list, query) {
    var qRaw = String(query || '').trim();
    var q = normName(qRaw);
    var qLower = qRaw.toLowerCase();
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var score = -1;
      var name = normName(e.name);
      var en = String(e.enName || '').toLowerCase();
      if (e.name === qRaw) score = 120;
      else if (name === q) score = 110;
      else if (en && (en === qLower || en === q)) score = 100;
      else if (name && q && (name.indexOf(q) === 0 || q.indexOf(name) === 0)) score = 70;
      else if (en && qLower && en.indexOf(qLower) === 0) score = 60;
      else if (name && q && name.indexOf(q) > 0) score = 40;
      if (score < 0) continue;
      if (e.country === '中国') score += 5;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  /**
   * 解析城市对应的 CMA 站点号（带内存 + localStorage 缓存）。
   * @returns Promise<string|null>
   */
  function resolveStationId(name, timeoutMs) {
    var q = String(name || '').trim();
    if (!q) return Promise.resolve(null);
    var cache = loadStationCache();
    var hit = cache[q];
    if (hit && isNum(hit.ts)) {
      var ttl = hit.id ? 30 * 86400000 : 86400000;
      if (nowMs() - hit.ts < ttl) return Promise.resolve(hit.id || null);
    }
    return requestJSON(CMA_BASE + '/api/autocomplete?q=' + encodeURIComponent(q), {
      timeout: timeoutMs || 8000,
      retries: 0,
      headers: { 'Accept': 'application/json' }
    }).then(function (json) {
      var list = parseCmaAutocomplete(json);
      var matched = matchCmaStation(list, q);
      var id = matched ? matched.stationId : null;
      cache[q] = { id: id, ts: nowMs() };
      saveStationCache();
      return id;
    }).catch(function () { return null; });
  }

  /* ======================================================================
   * 6. 各平台适配器
   * ==================================================================== */

  // 6.1 中国气象局
  function fetchCma(city, opts) {
    var timeout = reqTimeout(opts);
    var headers = {
      'Accept': 'application/json',
      'Referer': 'https://weather.cma.cn/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) WeatherHub/1.0'
    };
    function doFetch(stationId) {
      var nowUrl = CMA_BASE + '/api/now/' + encodeURIComponent(stationId);
      var viewUrl = CMA_BASE + '/api/weather/view?stationid=' + encodeURIComponent(stationId);
      var reqOpts = { timeout: timeout, retries: 1, headers: headers };
      return Promise.all([
        requestJSON(nowUrl, reqOpts),
        requestJSON(viewUrl, reqOpts)
      ]).then(function (arr) {
        var nowJson = arr[0] || {};
        var viewJson = arr[1] || {};
        if (nowJson.code !== undefined && nowJson.code !== 0) {
          throw whError('CMA 实况接口返回异常', 'cma_code');
        }
        var nowData = nowJson.data || {};
        var viewData = viewJson.data || {};
        var now = nowData.now || viewData.now || {};
        var location = nowData.location || viewData.location || {};
        var dailyRaw = Array.isArray(viewData.daily) ? viewData.daily : [];
        var alarms = collectCmaAlarms(nowData.alarm, viewData.alarm);
        var tz = 'Asia/Shanghai';
        var today = dailyRaw[0] || {};
        var isDay = isDayByHour(nowMs(), tz);
        var rawCode = isDay ? today.dayCode : today.nightCode;
        var rawText = isDay ? today.dayText : today.nightText;
        var code = mapCma(rawCode);
        if (code === CODES.UNKNOWN && rawText) code = textToCode(rawText);
        var daily = [];
        for (var i = 0; i < dailyRaw.length; i++) {
          var d = dailyRaw[i] || {};
          var date = normDateStr(d.date);
          if (!date) continue;
          var dCode = mapCma(d.dayCode);
          if (dCode === CODES.UNKNOWN && d.dayText) dCode = textToCode(d.dayText);
          var dp = makeDayPoint(date, d.high, d.low, dCode, d.dayText, {
            sunrise: null, sunset: null, precipProb: null, precipSum: null,
            windMax: parseCmaWindScale(d.dayWindScale), uvMax: null
          });
          dp.nightText = d.nightText || '';
          dp.nightCode = mapCma(d.nightCode);
          if (dp.nightCode === CODES.UNKNOWN && d.nightText) dp.nightCode = textToCode(d.nightText);
          dp.windDir = d.dayWindDirection || '';
          daily.push(dp);
        }
        var current = makeCurrent({
          temp: now.temperature,
          feelsLike: now.feelst,
          conditionCode: code,
          conditionText: code !== CODES.UNKNOWN ? codeName(code) : (rawText || ''),
          humidity: now.humidity,
          windSpeed: now.windSpeed,
          windDir: now.windDirectionDegree,
          windDirText: now.windDirection || '',
          pressure: now.pressure,
          precip: now.precipitation,
          isDay: isDay,
          observedAt: parseWallTime(nowData.lastUpdate || viewData.lastUpdate, tz)
        });
        return {
          current: current,
          hourly: [],
          daily: trimDaily(daily, city),
          alerts: alarms,
          rawLocationName: location.name || location.path || ''
        };
      });
    }
    var stationPromise = city && city.cmaStationId
      ? Promise.resolve(String(city.cmaStationId))
      : resolveStationId(city && city.name, timeout);
    return stationPromise.then(function (stationId) {
      if (!stationId) throw whError('未匹配到 CMA 站点编号', 'no_station');
      return doFetch(stationId);
    });
  }

  function parseCmaWindScale(scale) {
    // "3~4级" -> 3（取起始级数），"微风" -> null
    var m = /(\d+)/.exec(String(scale || ''));
    if (!m) return null;
    var level = parseInt(m[1], 10);
    if (!isFinite(level)) return null;
    // 蒲福风级中值 → m/s 近似（仅用于日预报的风速上限展示）
    var table = { 1: 1.2, 2: 2.6, 3: 4.5, 4: 6.7, 5: 9.3, 6: 11.7, 7: 14.3, 8: 17.2, 9: 20.3, 10: 23.6, 11: 27.2, 12: 32.7 };
    return table[level] || null;
  }

  function collectCmaAlarms() {
    var out = [];
    var seen = {};
    for (var a = 0; a < arguments.length; a++) {
      var arr = arguments[a];
      if (!Array.isArray(arr)) continue;
      for (var i = 0; i < arr.length; i++) {
        var item = arr[i];
        if (!item) continue;
        var title = item.title || item.name || item.type || item.alert || '';
        var text = item.text || item.content || item.description || item.detail || item.message || '';
        var level = item.level || item.severity || item.color || '';
        if (!level) {
          var mm = /(蓝色|黄色|橙色|红色|蓝色预警|黄色预警|橙色预警|红色预警)/.exec(String(title) + String(text));
          if (mm) level = mm[1];
        }
        var time = item.time || item.publishTime || item.publish_time || item.issuetime || item.updateTime || item.date || '';
        var key = String(title) + '|' + String(time);
        if (seen[key]) continue;
        seen[key] = true;
        if (!title && !text) continue;
        out.push({
          title: String(title || '气象预警'),
          level: String(level || ''),
          text: String(text || ''),
          time: String(time || '')
        });
      }
    }
    return out;
  }

  // 6.2 Open-Meteo
  function fetchOpenMeteo(city, opts) {
    var timeout = reqTimeout(opts);
    var lat = Number(city.lat);
    var lon = Number(city.lon);
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) +
      '&longitude=' + lon.toFixed(4) +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility' +
      '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max' +
      '&timezone=auto&forecast_days=7&wind_speed_unit=ms';
    return requestJSON(url, { timeout: timeout, retries: 1 }).then(function (j) {
      var offsetSec = isNum(j.utc_offset_seconds) ? j.utc_offset_seconds : 0;
      function wallEpoch(s) {
        var ts = parseWallTime(s, 'UTC');
        if (ts === null) return null;
        return ts - offsetSec * 1000;
      }
      var cur = j.current || {};
      var dailyRaw = j.daily || {};
      var dailyCodes = dailyRaw.weather_code || [];
      var dailyUv = dailyRaw.uv_index_max || [];
      var current = makeCurrent({
        temp: cur.temperature_2m,
        feelsLike: cur.apparent_temperature,
        conditionCode: mapWmo(cur.weather_code),
        conditionText: codeName(mapWmo(cur.weather_code)),
        humidity: cur.relative_humidity_2m,
        windSpeed: cur.wind_speed_10m,
        windDir: cur.wind_direction_10m,
        pressure: cur.pressure_msl,
        visibility: cur.visibility === null || cur.visibility === undefined ? null : numOrNull(cur.visibility) / 1000,
        uvIndex: numOrNull(dailyUv[0]),
        precip: cur.precipitation,
        cloudCover: cur.cloud_cover,
        isDay: cur.is_day === 1 || cur.is_day === true,
        observedAt: wallEpoch(cur.time)
      });
      var hourly = [];
      var h = j.hourly || {};
      var times = h.time || [];
      for (var i = 0; i < times.length; i++) {
        var t = wallEpoch(times[i]);
        if (t === null) continue;
        var code = mapWmo((h.weather_code || [])[i]);
        hourly.push(makeHourPoint(
          t,
          (h.temperature_2m || [])[i],
          (h.precipitation_probability || [])[i],
          (h.precipitation || [])[i],
          code,
          codeName(code)
        ));
      }
      var daily = [];
      var dTimes = dailyRaw.time || [];
      for (var k = 0; k < dTimes.length; k++) {
        var date = normDateStr(dTimes[k]);
        if (!date) continue;
        var dCode = mapWmo(dailyCodes[k]);
        daily.push(makeDayPoint(
          date,
          (dailyRaw.temperature_2m_max || [])[k],
          (dailyRaw.temperature_2m_min || [])[k],
          dCode,
          codeName(dCode),
          {
            precipProb: (dailyRaw.precipitation_probability_max || [])[k],
            precipSum: (dailyRaw.precipitation_sum || [])[k],
            sunrise: wallEpoch((dailyRaw.sunrise || [])[k]),
            sunset: wallEpoch((dailyRaw.sunset || [])[k]),
            windMax: (dailyRaw.wind_speed_10m_max || [])[k],
            uvMax: (dailyRaw.uv_index_max || [])[k]
          }
        ));
      }
      return {
        current: current,
        hourly: trimHourly(hourly, nowMs()),
        daily: trimDaily(daily, city),
        rawLocationName: ''
      };
    });
  }

  // 6.3 MET Norway / Yr
  function fetchMetno(city, opts) {
    var timeout = reqTimeout(opts);
    var url = 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' +
      Number(city.lat).toFixed(4) + '&lon=' + Number(city.lon).toFixed(4);
    return requestJSON(url, {
      timeout: timeout,
      retries: 1,
      headers: {
        'User-Agent': 'WeatherHub/1.0 (github.com/deepseek-weatherhub/weatherhub)',
        'Accept': 'application/json'
      }
    }).then(function (j) {
      var timeseries = (j.properties && j.properties.timeseries) || [];
      if (!timeseries.length) throw whError('MET Norway 返回空数据', 'empty');
      var tz = (city && city.timezone) || 'UTC';
      var now = nowMs();
      function pointDetails(p) {
        var d = (p.data && p.data.instant && p.data.instant.details) || {};
        return d;
      }
      function symbolOf(p) {
        var d = p.data || {};
        if (d.next_1_hours && d.next_1_hours.summary) return d.next_1_hours.summary.symbol_code;
        if (d.next_6_hours && d.next_6_hours.summary) return d.next_6_hours.summary.symbol_code;
        if (d.next_12_hours && d.next_12_hours.summary) return d.next_12_hours.summary.symbol_code;
        return '';
      }
      function precipOf(p) {
        var d = p.data || {};
        if (d.next_1_hours && d.next_1_hours.details) return numOrNull(d.next_1_hours.details.precipitation_amount);
        if (d.next_6_hours && d.next_6_hours.details) {
          var v = numOrNull(d.next_6_hours.details.precipitation_amount);
          return v === null ? null : v / 6;
        }
        return null;
      }
      function probOf(p) {
        var d = p.data || {};
        var n6 = d.next_6_hours && d.next_6_hours.details;
        var n1 = d.next_1_hours && d.next_1_hours.details;
        var v = null;
        if (n6) v = numOrNull(n6.probability_of_precipitation);
        if (v === null && n1) v = numOrNull(n1.probability_of_precipitation);
        return v;
      }
      var first = timeseries[0];
      var fd = pointDetails(first);
      var fSym = symbolOf(first);
      var fCode = mapMetno(fSym);
      var fIsDay = /_night/.test(String(fSym)) ? false : (/_day/.test(String(fSym)) ? true : isDayByHour(now, tz));
      var current = makeCurrent({
        temp: fd.air_temperature,
        feelsLike: apparentTemp(fd.air_temperature, fd.relative_humidity, fd.wind_speed),
        conditionCode: fCode,
        conditionText: codeName(fCode),
        humidity: fd.relative_humidity,
        windSpeed: fd.wind_speed,
        windDir: fd.wind_from_direction,
        pressure: fd.air_pressure_at_sea_level,
        precip: precipOf(first),
        cloudCover: fd.cloud_area_fraction,
        isDay: fIsDay,
        observedAt: parseWallTime(first.time, 'UTC')
      });
      // 逐时
      var hourly = [];
      for (var i = 0; i < timeseries.length; i++) {
        var p = timeseries[i];
        var t = parseWallTime(p.time, 'UTC');
        if (t === null) continue;
        var d = pointDetails(p);
        var sym = symbolOf(p);
        var code = mapMetno(sym);
        hourly.push(makeHourPoint(t, d.air_temperature, probOf(p), precipOf(p), code, codeName(code)));
      }
      // 无 daily：按本地日期聚合
      var byDate = {};
      for (var q = 0; q < timeseries.length; q++) {
        var pt = timeseries[q];
        var tq = parseWallTime(pt.time, 'UTC');
        if (tq === null) continue;
        var date = dateInTz(tq, tz);
        var dd = pointDetails(pt);
        var temp = numOrNull(dd.air_temperature);
        if (!byDate[date]) byDate[date] = { codes: [], temps: [], precipSum: 0, probMax: null, windMax: null };
        var bucket = byDate[date];
        if (temp !== null) bucket.temps.push(temp);
        var sym2 = symbolOf(pt);
        var c2 = mapMetno(sym2);
        if (c2 !== CODES.UNKNOWN) bucket.codes.push(c2);
        var pr = precipOf(pt);
        if (pr !== null) bucket.precipSum += pr;
        var pp = probOf(pt);
        if (pp !== null) bucket.probMax = bucket.probMax === null ? pp : Math.max(bucket.probMax, pp);
        var ws = numOrNull(dd.wind_speed);
        if (ws !== null) bucket.windMax = bucket.windMax === null ? ws : Math.max(bucket.windMax, ws);
      }
      var daily = [];
      var dates = Object.keys(byDate).sort();
      for (var di = 0; di < dates.length; di++) {
        var b = byDate[dates[di]];
        if (!b.temps.length) continue;
        var vote = {};
        for (var ci = 0; ci < b.codes.length; ci++) vote[b.codes[ci]] = (vote[b.codes[ci]] || 0) + 1;
        var bestCode = CODES.UNKNOWN;
        var bestCount = 0;
        for (var key in vote) {
          if (vote[key] > bestCount) { bestCount = vote[key]; bestCode = Number(key); }
        }
        daily.push(makeDayPoint(dates[di], Math.max.apply(null, b.temps), Math.min.apply(null, b.temps), bestCode, codeName(bestCode), {
          precipProb: b.probMax,
          precipSum: b.precipSum,
          windMax: b.windMax
        }));
      }
      return {
        current: current,
        hourly: trimHourly(hourly, nowMs()),
        daily: trimDaily(daily, city),
        rawLocationName: ''
      };
    });
  }

  // 6.4 wttr.in
  function parseWttrObs(str, tz) {
    var s = String(str || '').trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s);
    if (!m) return null;
    var h = +m[4];
    var ap = (m[6] || '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return wallToEpoch(+m[1], +m[2], +m[3], h, +m[5], tz);
  }

  function parseWttrClock(str, dateStr, tz) {
    var m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(str || '').trim());
    if (!m) return null;
    var h = +m[1];
    var ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    var dm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr || ''));
    if (!dm) return null;
    return wallToEpoch(+dm[1], +dm[2], +dm[3], h, +m[2], tz);
  }

  function fetchWttr(city, opts) {
    var timeout = reqTimeout(opts);
    var tz = (city && city.timezone) || '';
    var url = 'https://wttr.in/' + Number(city.lat).toFixed(4) + ',' + Number(city.lon).toFixed(4) + '?format=j1';
    return requestJSON(url, {
      timeout: timeout,
      retries: 1,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
        'Accept': 'application/json'
      }
    }).then(function (j) {
      var cc = (j.current_condition && j.current_condition[0]) || {};
      var code = mapWttr(cc.weatherCode);
      if (code === CODES.UNKNOWN) {
        var desc = (cc.weatherDesc && cc.weatherDesc[0] && cc.weatherDesc[0].value) ||
          (cc.lang_zh && cc.lang_zh[0] && cc.lang_zh[0].value) ||
          (cc['lang_zh-cn'] && cc['lang_zh-cn'][0] && cc['lang_zh-cn'][0].value) || '';
        code = textToCode(desc);
      }
      var isDay = cc.isday === '1' || cc.isday === 1 || isDayByHour(nowMs(), tz);
      var current = makeCurrent({
        temp: cc.temp_C,
        feelsLike: cc.FeelsLikeC,
        conditionCode: code,
        conditionText: codeName(code),
        humidity: cc.humidity,
        windSpeed: numOrNull(cc.windspeedKmph) === null ? null : numOrNull(cc.windspeedKmph) / 3.6,
        windDir: cc.winddirDegree,
        windGust: numOrNull(cc.WindGustKmph) === null ? null : numOrNull(cc.WindGustKmph) / 3.6,
        pressure: cc.pressure,
        visibility: cc.visibility,
        uvIndex: cc.uvIndex,
        precip: cc.precipMM,
        cloudCover: cc.cloudcover,
        isDay: isDay,
        observedAt: parseWttrObs(cc.localObsDateTime, tz)
      });
      var hourly = [];
      var daily = [];
      var days = j.weather || [];
      for (var i = 0; i < days.length; i++) {
        var d = days[i] || {};
        var date = normDateStr(d.date);
        if (!date) continue;
        var astro = d.astronomy && d.astronomy[0] ? d.astronomy[0] : {};
        var dayCodes = [];
        var hh = d.hourly || [];
        var hPrecipSum = 0;
        var hProbMax = null;
        var hWindMax = null;
        var hUv = numOrNull(d.uvIndex);
        for (var k = 0; k < hh.length; k++) {
          var hp = hh[k] || {};
          var minutes = numOrNull(hp.time);
          if (minutes === null) continue;
          var t = wallToEpoch(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), Math.floor(minutes / 60), minutes % 60, tz);
          if (t === null) continue;
          var hCode = mapWttr(hp.weatherCode);
          if (hCode === CODES.UNKNOWN) {
            var hDesc = (hp.weatherDesc && hp.weatherDesc[0] && hp.weatherDesc[0].value) ||
              (hp['lang_zh-cn'] && hp['lang_zh-cn'][0] && hp['lang_zh-cn'][0].value) || '';
            hCode = textToCode(hDesc);
          }
          if (hCode !== CODES.UNKNOWN) dayCodes.push(hCode);
          var hpProb = numOrNull(hp.chanceofrain);
          if (hpProb !== null) hProbMax = hProbMax === null ? hpProb : Math.max(hProbMax, hpProb);
          var hpPrecip = numOrNull(hp.precipMM);
          if (hpPrecip !== null) hPrecipSum += hpPrecip;
          var hw = numOrNull(hp.windspeedKmph);
          var hwMs = hw === null ? null : hw / 3.6;
          if (hwMs !== null) hWindMax = hWindMax === null ? hwMs : Math.max(hWindMax, hwMs);
          hourly.push(makeHourPoint(t, hp.tempC, hpProb, hpPrecip, hCode, codeName(hCode)));
        }
        var dayCode = CODES.UNKNOWN;
        if (dayCodes.length) {
          var counts = {};
          var bestC = 0;
          for (var ci = 0; ci < dayCodes.length; ci++) {
            counts[dayCodes[ci]] = (counts[dayCodes[ci]] || 0) + 1;
            if (counts[dayCodes[ci]] > bestC) { bestC = counts[dayCodes[ci]]; dayCode = dayCodes[ci]; }
          }
        }
        daily.push(makeDayPoint(date, d.maxtempC, d.mintempC, dayCode, codeName(dayCode), {
          precipProb: hProbMax,
          precipSum: hPrecipSum,
          sunrise: parseWttrClock(astro.sunrise, date, tz),
          sunset: parseWttrClock(astro.sunset, date, tz),
          windMax: hWindMax,
          uvMax: hUv
        }));
      }
      var nearest = (j.nearest_area && j.nearest_area[0]) || {};
      var areaName = nearest.areaName && nearest.areaName[0] ? nearest.areaName[0].value : '';
      return {
        current: current,
        hourly: trimHourly(hourly, nowMs()),
        daily: trimDaily(daily, city),
        rawLocationName: areaName || ''
      };
    });
  }

  // 6.5 和风天气（可选 key）
  function fetchQweather(city, opts) {
    var settings = WH.settings ? WH.settings.get() : {};
    var key = String(settings.qweatherKey || '').trim();
    if (!key) return Promise.reject(whError('未配置和风天气 API Key', 'no_key'));
    var host = String(settings.qweatherHost || 'devapi.qweather.com').trim();
    var timeout = reqTimeout(opts);
    var loc = Number(city.lon).toFixed(4) + ',' + Number(city.lat).toFixed(4);
    var base = 'https://' + host + '/v7/weather/';
    var common = '&key=' + encodeURIComponent(key) + '&lang=zh';
    var nowUrl = base + 'now?location=' + encodeURIComponent(loc) + common;
    var dailyUrl = base + '7d?location=' + encodeURIComponent(loc) + common;
    return Promise.all([
      requestJSON(nowUrl, { timeout: timeout, retries: 1 }),
      requestJSON(dailyUrl, { timeout: timeout, retries: 1 })
    ]).then(function (arr) {
      var nowJson = arr[0] || {};
      var dailyJson = arr[1] || {};
      if (String(nowJson.code) !== '200') throw whError('和风天气返回错误：' + (nowJson.code || 'unknown'), 'qweather_code');
      var now = nowJson.now || {};
      var code = mapQweather(now.icon, now.text);
      var current = makeCurrent({
        temp: now.temp,
        feelsLike: now.feelsLike,
        conditionCode: code,
        conditionText: codeName(code),
        humidity: now.humidity,
        windSpeed: numOrNull(now.windSpeed) === null ? null : numOrNull(now.windSpeed) / 3.6,
        windDir: now.wind360,
        windDirText: now.windDir || '',
        pressure: now.pressure,
        visibility: now.vis,
        precip: now.precip,
        cloudCover: now.cloud,
        isDay: now.icon ? numOrNull(now.icon) < 150 : isDayByHour(nowMs(), city.timezone),
        observedAt: parseWallTime(now.obsTime, city.timezone)
      });
      var daily = [];
      var arr2 = Array.isArray(dailyJson.daily) ? dailyJson.daily : [];
      for (var i = 0; i < arr2.length; i++) {
        var d = arr2[i] || {};
        var date = normDateStr(d.fxDate);
        if (!date) continue;
        var dCode = mapQweather(d.iconDay, d.textDay);
        daily.push(makeDayPoint(date, d.tempMax, d.tempMin, dCode, d.textDay, {
          precipProb: null,
          precipSum: d.precip,
          sunrise: parseWallTime(date + ' ' + (d.sunrise || ''), city.timezone),
          sunset: parseWallTime(date + ' ' + (d.sunset || ''), city.timezone),
          windMax: numOrNull(d.windSpeedDay) === null ? null : numOrNull(d.windSpeedDay) / 3.6,
          uvMax: d.uvIndex
        }));
      }
      return {
        current: current,
        hourly: [],
        daily: trimDaily(daily, city),
        rawLocationName: ''
      };
    });
  }

  // 6.6 OpenWeatherMap（可选 key）
  function fetchOwm(city, opts) {
    var settings = WH.settings ? WH.settings.get() : {};
    var key = String(settings.owmKey || '').trim();
    if (!key) return Promise.reject(whError('未配置 OpenWeatherMap API Key', 'no_key'));
    var timeout = reqTimeout(opts);
    var lat = Number(city.lat).toFixed(4);
    var lon = Number(city.lon).toFixed(4);
    var nowUrl = 'https://api.openweathermap.org/data/2.5/weather?lat=' + lat + '&lon=' + lon +
      '&appid=' + encodeURIComponent(key) + '&units=metric&lang=zh_cn';
    var fcUrl = 'https://api.openweathermap.org/data/2.5/forecast?lat=' + lat + '&lon=' + lon +
      '&appid=' + encodeURIComponent(key) + '&units=metric&lang=zh_cn';
    return Promise.all([
      requestJSON(nowUrl, { timeout: timeout, retries: 1 }),
      requestJSON(fcUrl, { timeout: timeout, retries: 1 })
    ]).then(function (arr) {
      var nowJson = arr[0] || {};
      var fcJson = arr[1] || {};
      var main = nowJson.main || {};
      var wind = nowJson.wind || {};
      var clouds = nowJson.clouds || {};
      var w0 = (nowJson.weather && nowJson.weather[0]) || {};
      var offsetSec = isNum(nowJson.timezone) ? nowJson.timezone : 0;
      var dt = isNum(nowJson.dt) ? nowJson.dt * 1000 : nowMs();
      var localHour = new Date(dt + offsetSec * 1000).getUTCHours();
      var isDay = localHour >= 6 && localHour < 18;
      function owmPrecip(o, key2) {
        if (!o) return null;
        var rain = o.rain || {};
        var snow = o.snow || {};
        var v = numOrNull(rain[key2]);
        if (v === null) v = numOrNull(rain['3h']);
        if (v === null) v = numOrNull(snow[key2]);
        if (v === null) v = numOrNull(snow['3h']);
        return v;
      }
      var current = makeCurrent({
        temp: main.temp,
        feelsLike: main.feels_like,
        conditionCode: mapOwm(w0.id),
        conditionText: codeName(mapOwm(w0.id)),
        humidity: main.humidity,
        windSpeed: wind.speed,
        windDir: wind.deg,
        windGust: wind.gust,
        pressure: main.pressure,
        visibility: numOrNull(nowJson.visibility) === null ? null : numOrNull(nowJson.visibility) / 1000,
        precip: owmPrecip(nowJson, '1h'),
        cloudCover: clouds.all,
        isDay: isDay,
        observedAt: dt
      });
      var hourly = [];
      var list = Array.isArray(fcJson.list) ? fcJson.list : [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i] || {};
        var t = isNum(item.dt) ? item.dt * 1000 : null;
        if (t === null) continue;
        var w = (item.weather && item.weather[0]) || {};
        var code = mapOwm(w.id);
        hourly.push(makeHourPoint(t, item.main && item.main.temp, item.pop === undefined ? null : item.pop * 100,
          owmPrecip(item, '3h'), code, codeName(code)));
      }
      // 3h 步长聚合为 daily
      var byDate = {};
      for (var k = 0; k < list.length; k++) {
        var it = list[k] || {};
        if (!isNum(it.dt)) continue;
        var tms = it.dt * 1000;
        var date = dateInTz(tms, city.timezone);
        var temp = numOrNull(it.main && it.main.temp);
        if (!byDate[date]) byDate[date] = { temps: [], codes: [], precipSum: 0, popMax: null, windMax: null };
        var b = byDate[date];
        if (temp !== null) b.temps.push(temp);
        var w2 = (it.weather && it.weather[0]) || {};
        var c2 = mapOwm(w2.id);
        if (c2 !== CODES.UNKNOWN) b.codes.push(c2);
        var pr = owmPrecip(it, '3h');
        if (pr !== null) b.precipSum += pr;
        var pop = numOrNull(it.pop);
        if (pop !== null) b.popMax = b.popMax === null ? pop * 100 : Math.max(b.popMax, pop * 100);
        var ws = numOrNull(it.wind && it.wind.speed);
        if (ws !== null) b.windMax = b.windMax === null ? ws : Math.max(b.windMax, ws);
      }
      var daily = [];
      var dates = Object.keys(byDate).sort();
      for (var di = 0; di < dates.length; di++) {
        var bb = byDate[dates[di]];
        if (!bb.temps.length) continue;
        var counts = {};
        var bestCode = CODES.UNKNOWN;
        var bestCount = 0;
        for (var ci = 0; ci < bb.codes.length; ci++) {
          counts[bb.codes[ci]] = (counts[bb.codes[ci]] || 0) + 1;
          if (counts[bb.codes[ci]] > bestCount) { bestCount = counts[bb.codes[ci]]; bestCode = bb.codes[ci]; }
        }
        daily.push(makeDayPoint(dates[di], Math.max.apply(null, bb.temps), Math.min.apply(null, bb.temps), bestCode, codeName(bestCode), {
          precipProb: bb.popMax,
          precipSum: bb.precipSum,
          windMax: bb.windMax
        }));
      }
      return {
        current: current,
        hourly: trimHourly(hourly, nowMs()),
        daily: trimDaily(daily, city),
        rawLocationName: nowJson.name || ''
      };
    });
  }

  /* ======================================================================
   * 7. 空气质量（Open-Meteo CAMS）
   * ==================================================================== */

  function fetchAqi(lat, lon, opts) {
    opts = opts || {};
    var timeout = clamp(Number(opts.timeoutMs) || DEFAULT_REQUEST_TIMEOUT, 4000, DEFAULT_REQUEST_TIMEOUT);
    var url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + Number(lat).toFixed(4) +
      '&longitude=' + Number(lon).toFixed(4) +
      '&current=pm2_5,pm10,us_aqi,european_aqi,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide&timezone=auto';
    return requestJSON(url, { timeout: timeout, retries: 0 }).then(function (j) {
      var c = j && j.current;
      if (!c) return null;
      var usAqi = numOrNull(c.us_aqi);
      var pm25 = numOrNull(c.pm2_5);
      if (usAqi === null && pm25 === null) return null;
      var offsetSec = isNum(j.utc_offset_seconds) ? j.utc_offset_seconds : 0;
      var updatedAt = null;
      var t = parseWallTime(c.time, 'UTC');
      if (t !== null) updatedAt = t - offsetSec * 1000;
      return {
        usAqi: usAqi === null ? null : round0(usAqi),
        pm25: round1(pm25),
        pm10: round1(numOrNull(c.pm10)),
        ozone: round1(numOrNull(c.ozone)),
        no2: round1(numOrNull(c.nitrogen_dioxide)),
        so2: round1(numOrNull(c.sulphur_dioxide)),
        co: round1(numOrNull(c.carbon_monoxide)),
        europeanAqi: c.european_aqi === undefined ? null : round0(numOrNull(c.european_aqi)),
        updatedAt: updatedAt || nowMs(),
        source: 'open-meteo-cams'
      };
    }).catch(function () { return null; });
  }

  /* ======================================================================
   * 8. fetchOne / fetchAll（并发池）
   * ==================================================================== */

  var ADAPTERS = {
    'cma': fetchCma,
    'open-meteo': fetchOpenMeteo,
    'metno': fetchMetno,
    'wttr': fetchWttr,
    'qweather': fetchQweather,
    'owm': fetchOwm
  };

  function keyForSource(id) {
    var s = WH.settings ? WH.settings.get() : {};
    if (id === 'qweather') return String(s.qweatherKey || '').trim();
    if (id === 'owm') return String(s.owmKey || '').trim();
    return 'always';
  }

  function getEnabledIds() {
    var s = WH.settings ? WH.settings.get() : {};
    var enabled = Array.isArray(s.enabledSources) && s.enabledSources.length
      ? s.enabledSources.slice()
      : ['cma', 'open-meteo', 'metno', 'wttr'];
    var out = [];
    for (var i = 0; i < enabled.length; i++) {
      var id = String(enabled[i] || '').trim();
      var meta = metaById(id);
      if (!meta) continue;
      if (meta.requiresKey && !keyForSource(id)) continue;
      if (out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  function errorResult(id, startedAt, err) {
    var meta = metaById(id) || {
      id: id, name: id, short: id, color: '#888', homepage: '', kind: 'aggregator'
    };
    var msg = friendlyError(err);
    var res = {
      id: id,
      meta: meta,
      status: 'error',
      error: msg,
      ms: nowMs() - startedAt,
      fetchedAt: nowMs()
    };
    if (err && err.code) res.errorCode = err.code;
    return res;
  }

  /** 拉取单个平台；无论成功失败都 resolve，不 reject */
  function fetchOne(id, city, opts) {
    var startedAt = nowMs();
    var key = String(id || '').trim();
    var meta = metaById(key);
    if (!meta) {
      return Promise.resolve(errorResult(key || 'unknown', startedAt, whError('未知数据源：' + key, 'unknown_source')));
    }
    var adapter = ADAPTERS[key];
    if (!adapter) {
      return Promise.resolve(errorResult(key, startedAt, whError('该数据源暂未适配', 'no_adapter')));
    }
    if (!city || !isNum(Number(city.lat)) || !isNum(Number(city.lon))) {
      return Promise.resolve(errorResult(key, startedAt, whError('城市坐标无效', 'bad_city')));
    }
    var callOpts = { timeoutMs: (opts && opts.timeoutMs) || 15000 };
    return Promise.resolve().then(function () {
      return adapter(city, callOpts);
    }).then(function (partial) {
      if (!partial) throw whError('数据为空', 'empty');
      if (isEmpty(partial.current ? [] : null) && !partial.current && isEmpty(partial.hourly) && isEmpty(partial.daily)) {
        throw whError('数据为空', 'empty');
      }
      var result = {
        id: key,
        meta: meta,
        status: 'ok',
        ms: nowMs() - startedAt,
        fetchedAt: nowMs(),
        current: partial.current || null,
        hourly: Array.isArray(partial.hourly) ? partial.hourly : [],
        daily: Array.isArray(partial.daily) ? partial.daily : [],
        rawLocationName: partial.rawLocationName || ''
      };
      if (partial.alerts && partial.alerts.length) result.alerts = partial.alerts;
      return result;
    }).catch(function (err) {
      return errorResult(key, startedAt, err);
    });
  }

  /** 并发池：最多 limit 个任务同时执行；返回与 tasks 顺序一致的结果数组 */
  function runPool(tasks, limit) {
    return new Promise(function (resolve) {
      var total = tasks.length;
      if (!total) { resolve([]); return; }
      var results = new Array(total);
      var next = 0;
      var active = 0;
      var done = 0;
      function launch() {
        while (active < limit && next < total) {
          (function (index) {
            active++;
            next++;
            Promise.resolve().then(tasks[index]).then(function (value) {
              results[index] = value;
            }, function (err) {
              results[index] = { __error: err };
            }).then(function () {
              active--;
              done++;
              if (done === total) resolve(results);
              else launch();
            });
          })(next);
        }
      }
      launch();
    });
  }

  function dedupeIds(ids) {
    var out = [];
    for (var i = 0; i < (ids || []).length; i++) {
      var id = String(ids[i] || '').trim();
      if (id && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  /**
   * 拉取多个平台 + AQI
   * @returns Promise<{city, fetchedAt, results:SourceResult[], aqi:AqiResult|null}>
   */
  function fetchAll(city, opts) {
    opts = opts || {};
    if (!city || !isNum(Number(city.lat)) || !isNum(Number(city.lon))) {
      return Promise.reject(whError('城市坐标无效', 'bad_city'));
    }
    var timeoutMs = clamp(Number(opts.timeoutMs) || 15000, 4000, 30000);
    var ids = (opts.ids && opts.ids.length) ? dedupeIds(opts.ids) : getEnabledIds();
    var tasks = [];
    for (var i = 0; i < ids.length; i++) {
      (function (id) {
        tasks.push(function () { return fetchOne(id, city, { timeoutMs: timeoutMs }); });
      })(ids[i]);
    }
    var aqiIndex = -1;
    if (opts.aqi !== false) {
      aqiIndex = tasks.length;
      tasks.push(function () { return fetchAqi(city.lat, city.lon, { timeoutMs: timeoutMs }); });
    }
    return runPool(tasks, MAX_CONCURRENCY).then(function (settled) {
      var results = [];
      for (var k = 0; k < ids.length; k++) {
        var r = settled[k];
        if (!r || (r.__error !== undefined)) {
          results.push(errorResult(ids[k], nowMs(), (r && r.__error) || whError('未知错误', 'unknown')));
        } else {
          results.push(r);
        }
      }
      var aqi = null;
      if (aqiIndex >= 0) {
        var a = settled[aqiIndex];
        if (a && !a.__error && a.usAqi !== undefined && a.usAqi !== null) aqi = a;
      }
      return {
        city: city,
        fetchedAt: nowMs(),
        results: results,
        aqi: aqi
      };
    });
  }

  /* ======================================================================
   * 9. 对外导出
   * ==================================================================== */

  WH.sources = {
    fetchAll: fetchAll,
    fetchOne: fetchOne,
    fetchAqi: fetchAqi,
    getEnabledIds: getEnabledIds,
    resolveStationId: resolveStationId,
    meta: META,
    META: META,
    CODES: CODES,
    CODE_META: CODE_META,
    codeName: codeName,
    codeIcon: codeIcon,
    codeFamily: codeFamily,
    textToCode: textToCode
  };

})(typeof window !== 'undefined' ? window : globalThis);
