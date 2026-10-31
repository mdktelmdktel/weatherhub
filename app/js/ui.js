/*!
 * WeatherHub（天气汇）— UI 渲染层
 * 纯原生 JS（无模块/无依赖），所有 HTML 由字符串拼接生成；文本一律经 esc() 转义。
 * 对外：window.WH.ui
 */
(function (global) {
  'use strict';

  var WH = global.WH = global.WH || {};
  var U = WH.utils || {};
  var UA = WH.utils || {};

  /* ======================================================================
   * 0. 基础工具
   * ==================================================================== */

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : (def === undefined ? null : def);
  }

  function r1(v) {
    var n = num(v);
    if (n === null) return null;
    return Math.round(n * 10) / 10;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function fmtTemp(v) {
    if (UA.fmtTemp) return UA.fmtTemp(v);
    var n = num(v);
    if (n === null) return '--';
    var unit = 'c';
    try { unit = (WH.settings && WH.settings.get().unit) || 'c'; } catch (e) { unit = 'c'; }
    var out = unit === 'f' ? Math.round(n * 9 / 5 + 32) : Math.round(n);
    return out + '°';
  }

  function fmtTempNum(v) {
    var n = num(v);
    if (n === null) return '--';
    var unit = 'c';
    try { unit = (WH.settings && WH.settings.get().unit) || 'c'; } catch (e) { unit = 'c'; }
    return String(unit === 'f' ? Math.round(n * 9 / 5 + 32) : Math.round(n));
  }

  function fmtWind(v) {
    if (UA.fmtWind) return UA.fmtWind(v);
    var n = num(v);
    if (n === null) return '--';
    var unit = 'kmh';
    try { unit = (WH.settings && WH.settings.get().windUnit) || 'kmh'; } catch (e) { unit = 'kmh'; }
    return unit === 'ms' ? n.toFixed(1) + ' m/s' : Math.round(n * 3.6) + ' km/h';
  }

  function windUnitLabel() {
    var unit = 'kmh';
    try { unit = (WH.settings && WH.settings.get().windUnit) || 'kmh'; } catch (e) { unit = 'kmh'; }
    return unit === 'ms' ? 'm/s' : 'km/h';
  }

  function fmtTime(t) {
    if (UA.fmtTime) return UA.fmtTime(t);
    if (!t) return '--:--';
    var d = new Date(Number(t));
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function minutesAgo(t) {
    if (UA.minutesAgo) return UA.minutesAgo(t);
    var n = num(t);
    if (!n) return '--';
    var m = Math.max(0, Math.round((Date.now() - n) / 60000));
    if (m <= 0) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 1440) return Math.floor(m / 60) + ' 小时前';
    return Math.floor(m / 1440) + ' 天前';
  }

  function windDirText(deg) {
    if (UA.windDirText) return UA.windDirText(deg);
    if (num(deg) === null) return '';
    return '';
  }

  function windDirArrow(deg) {
    if (UA.windDirArrow) return UA.windDirArrow(deg);
    return '';
  }

  function dayLabel(dateStr) {
    if (UA.dayLabel) return UA.dayLabel(dateStr);
    return dateStr || '';
  }

  function iconSvg(name, size) {
    var s = num(size) || 24;
    if (UA.iconSvg) {
      try { return UA.iconSvg(name, { size: s }); } catch (e) { /* 回退 */ }
    }
    var labels = { 'sun': '晴', 'cloud-sun': '多云', 'cloud': '阴', 'rain': '雨', 'heavy-rain': '大雨', 'thunder': '雷', 'snow': '雪', 'fog': '雾', 'dust': '沙尘', 'shower': '阵雨', 'sleet': '雨夹雪', 'unknown': '—' };
    return '<span class="wx-glyph">' + esc(labels[String(name || '').toLowerCase()] || '—') + '</span>';
  }

  function mountIcon(name, cls, size) {
    return '<span class="' + (cls || '') + '">' + iconSvg(name, size) + '</span>';
  }

  /* 通用线条图标（UI 图标，非天气图标） */
  var ICO = {
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    gps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9.5 17H2.5L12 3z"/><path d="M12 9v5"/><path d="M12 17.5v.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
    arrowUpRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.4 2"/></svg>',
    drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.4 6 10.4A6 6 0 0 1 6 13.4C6 9.4 12 3 12 3z"/></svg>',
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 18h7"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 18l4-6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14.7V5a2 2 0 1 1 4 0v9.7a4 4 0 1 1-4 0z"/><path d="M12 17.5v-.01"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"/></svg>',
    sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.01"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8L12 3.6z"/></svg>',
    city: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V8l5-3v16"/><path d="M14 21V11l5-3v13"/></svg>'
  };

  function uiIcon(name) {
    return '<span class="ui-ico" aria-hidden="true">' + (ICO[name] || '') + '</span>';
  }

  /* ======================================================================
   * 1. 天气插画（用于 hero / 状态页）
   * ==================================================================== */

  function artCloud(x, y, scale, cls) {
    return '<g class="' + (cls || '') + '" transform="translate(' + x + ' ' + y + ') scale(' + scale + ')">' +
      '<path d="M32 62c-12 0-21-8.6-21-19.4 0-10.4 8.2-18.9 18.8-19.4C33.6 13.4 42.2 7 52 7c13.2 0 23.9 9.8 24 22.2 0 .7 0 1.4-.1 2.1C81 32.6 85 37.6 85 43c0 10.4-8.6 19-20 19H32z" fill="url(#art-cloud-grad)"/>' +
      '</g>';
  }

  function artSvg(code, isDay) {
    var fam = codeFamily(code);
    var sun = fam === 'clear' || fam === 'partly' || fam === 'shower' || fam === 'dust';
    var night = !isDay;
    var defs = '<defs>' +
      '<linearGradient id="art-cloud-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f8ff" stop-opacity=".98"/><stop offset="1" stop-color="#b9cbe8" stop-opacity=".9"/></linearGradient>' +
      '<linearGradient id="art-cloud-back-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dbe7fb" stop-opacity=".55"/><stop offset="1" stop-color="#94a9cc" stop-opacity=".45"/></linearGradient>' +
      '<radialGradient id="art-sun-grad" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6cf"/><stop offset=".62" stop-color="#ffd25e"/><stop offset="1" stop-color="#ffab35"/></radialGradient>' +
      '<radialGradient id="art-moon-grad" cx="42%" cy="38%" r="62%"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#dbe6ff"/><stop offset="1" stop-color="#a8bce6"/></radialGradient>' +
      '</defs>';
    var out = '<svg class="art art--' + fam + '" viewBox="0 0 160 160" fill="none" style="--sun-x:86px;--sun-y:52px" aria-hidden="true">' + defs;
    // 太阳
    if (sun) {
      var cx = night ? 104 : 86;
      var cy = 52;
      out += '<g class="art-rays" opacity="' + (night ? '0.35' : '0.8') + '">';
      for (var i = 0; i < 8; i++) {
        var a = i * Math.PI / 4;
        var x1 = cx + Math.cos(a) * 28;
        var y1 = cy + Math.sin(a) * 28;
        var x2 = cx + Math.cos(a) * (night ? 34 : 42);
        var y2 = cy + Math.sin(a) * (night ? 34 : 42);
        out += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + (night ? 'rgba(190,205,245,.5)' : 'rgba(255,226,150,.75)') + '" stroke-width="2.6" stroke-linecap="round"/>';
      }
      out += '</g>';
      out += '<circle class="art-sun-core" cx="' + cx + '" cy="' + cy + '" r="' + (fam === 'clear' ? 26 : 21) + '" fill="url(#art-sun-grad)" opacity="' + (fam === 'clear' ? '1' : '0.92') + '"/>';
    }
    if (night && (fam === 'clear' || fam === 'partly')) {
      out += '<circle cx="104" cy="46" r="18" fill="url(#art-moon-grad)"/>' +
        '<circle cx="112" cy="40" r="16" fill="#0a1020" opacity=".0"/>' +
        '<circle class="art-star" cx="42" cy="30" r="1.6" fill="#e8f0ff"/>' +
        '<circle class="art-star-2" cx="66" cy="18" r="1.2" fill="#dce8ff"/>' +
        '<circle class="art-star-3" cx="128" cy="22" r="1.8" fill="#f2f7ff"/>' +
        '<circle class="art-star" cx="30" cy="54" r="1.1" fill="#dfe9ff"/>';
    }
    if (fam === 'cloudy' || fam === 'rain' || fam === 'heavy-rain' || fam === 'thunder' || fam === 'snow' || fam === 'fog' || fam === 'sleet') {
      out += artCloud(46, 26, 0.9, 'art-cloud-back');
    }
    if (fam === 'partly') out += artCloud(30, 44, 1.05, 'art-cloud-front');
    if (fam === 'rain' || fam === 'heavy-rain' || fam === 'shower' || fam === 'thunder' || fam === 'snow' || fam === 'sleet') out += artCloud(38, 52, 1.02, 'art-cloud-front');
    if (fam === 'cloudy') out += artCloud(40, 66, 0.78, 'art-cloud-front');
    if (fam === 'fog') {
      out += '<path class="art-mist" d="M26 98h108M32 112h96M42 126h76" stroke="rgba(226,238,255,.55)" stroke-width="7" stroke-linecap="round"/>';
    }
    if (fam === 'rain' || fam === 'shower') {
      out += '<g stroke="#8fd2ff" stroke-width="4.5" stroke-linecap="round" class="art-drops">' +
        '<line class="art-drop-1" x1="58" y1="90" x2="54" y2="102"/>' +
        '<line class="art-drop-2" x1="80" y1="90" x2="76" y2="102"/>' +
        '<line class="art-drop-3" x1="102" y1="90" x2="98" y2="102"/></g>';
    }
    if (fam === 'heavy-rain') {
      out += '<g stroke="#7cc6ff" stroke-width="4.5" stroke-linecap="round">' +
        '<line class="art-drop-1" x1="52" y1="88" x2="47" y2="102"/><line class="art-drop-2" x1="68" y1="88" x2="63" y2="102"/>' +
        '<line class="art-drop-3" x1="84" y1="88" x2="79" y2="102"/><line class="art-drop-1" x1="100" y1="88" x2="95" y2="102"/>' +
        '<line class="art-drop-2" x1="116" y1="88" x2="111" y2="102"/></g>';
    }
    if (fam === 'thunder') {
      out += '<path class="art-bolt" d="M84 88l-12 24h12l-6 24 22-30H88l8-18z" fill="#ffd84d" stroke="rgba(255,235,150,.55)" stroke-width="1.5"/>';
    }
    if (fam === 'snow') {
      out += '<g fill="#eaf4ff">' +
        '<circle class="art-flake-1" cx="60" cy="96" r="3.6"/><circle class="art-flake-2" cx="82" cy="92" r="3"/>' +
        '<circle class="art-flake-3" cx="104" cy="98" r="4"/><circle class="art-flake-1" cx="120" cy="94" r="2.6"/></g>';
    }
    if (fam === 'sleet') {
      out += '<g stroke="#9fdcff" stroke-width="4" stroke-linecap="round">' +
        '<line class="art-drop-1" x1="62" y1="90" x2="58" y2="101"/><line class="art-drop-2" x1="96" y1="90" x2="92" y2="101"/></g>' +
        '<g fill="#eaf4ff"><circle class="art-flake-2" cx="79" cy="94" r="3.4"/><circle class="art-flake-3" cx="110" cy="97" r="2.8"/></g>';
    }
    if (fam === 'dust') {
      out += '<g fill="rgba(255,214,150,.55)"><circle class="art-dust" cx="40" cy="104" r="2.4"/><circle cx="70" cy="116" r="1.8"/><circle cx="110" cy="108" r="2.2"/><circle cx="130" cy="96" r="1.5"/></g>' +
        '<path d="M30 122c26-8 72-8 100 0" stroke="rgba(255,205,140,.35)" stroke-width="4" stroke-linecap="round"/>';
    }
    out += '</svg>';
    return out;
  }

  function codeFamily(code) {
    var c = num(code, 12);
    if (c === 0) return 'clear';
    if (c === 1) return 'partly';
    if (c === 2) return 'cloudy';
    if (c === 3 || c === 4) return 'rain';
    if (c === 5) return 'heavy-rain';
    if (c === 6) return 'thunder';
    if (c === 7) return 'snow';
    if (c === 8) return 'fog';
    if (c === 9) return 'dust';
    if (c === 10) return 'shower';
    if (c === 11) return 'sleet';
    return 'cloudy';
  }

  function skyFor(code, isDay) {
    var fam = codeFamily(code);
    if (fam === 'clear') return isDay ? 'clear-day' : 'clear-night';
    if (fam === 'partly') return isDay ? 'partly-day' : 'partly-night';
    if (fam === 'rain' || fam === 'shower') return 'rain';
    if (fam === 'heavy-rain') return 'heavy-rain';
    if (fam === 'thunder') return 'thunder';
    if (fam === 'snow') return 'snow';
    if (fam === 'sleet') return 'sleet';
    if (fam === 'fog') return 'fog';
    if (fam === 'dust') return 'dust';
    return 'cloudy';
  }

  function skyDecor(code) {
    var fam = codeFamily(code);
    if (fam === 'rain') return 'wx--rain';
    if (fam === 'heavy-rain') return 'wx--rain wx--rain-strong';
    if (fam === 'shower') return 'wx--rain';
    if (fam === 'thunder') return 'wx--rain wx--rain-strong wx--flash';
    if (fam === 'snow') return 'wx--snow';
    if (fam === 'sleet') return 'wx--snow';
    if (fam === 'fog') return 'wx--fog';
    if (fam === 'dust') return 'wx--dust';
    return '';
  }

  function isNightNow(agg) {
    if (agg && agg.icon && agg.currentIsDay === false) return true;
    var h = new Date().getHours();
    return h < 6 || h >= 19;
  }

  /* ======================================================================
   * 2. 公共小组件
   * ==================================================================== */

  function cityChip(city, onCityClick) {
    var src = (city && city.source) || 'default';
    var badgeCls = src === 'gps' ? 'badge--gps' : (src === 'ip' ? 'badge--ip' : 'badge--manual');
    var badgeTxt = src === 'gps' ? 'GPS' : (src === 'ip' ? 'IP' : (src === 'search' ? '手动' : (src === 'saved' ? '已存' : '默认')));
    var name = (city && city.name) || '定位中…';
    var sub = (city && (city.admin || city.country)) || '';
    return '<button class="city-chip" data-act="go-city" aria-label="切换城市">' +
      '<span class="city-chip__icon">' + ICO.pin + '</span>' +
      '<span class="city-chip__name">' + esc(name) + '</span>' +
      '<span class="badge ' + badgeCls + '">' + esc(badgeTxt) + '</span>' +
      '</button>';
  }

  function topbar(city, opts) {
    opts = opts || {};
    var right = '';
    if (opts.right) right = opts.right;
    else {
      right = '<button class="icon-btn' + (opts.busy ? ' is-busy' : '') + '" data-act="refresh" aria-label="刷新天气">' + ICO.refresh + '</button>';
    }
    return '<div class="topbar"><div class="topbar__left">' + cityChip(city) + '</div><div class="topbar__actions">' + right + '</div></div>';
  }

  function pageHead(title, sub, actions) {
    return '<div class="pagehead"><div><div class="pagehead__title">' + esc(title) + '</div>' +
      (sub ? '<div class="pagehead__sub">' + esc(sub) + '</div>' : '') +
      '</div>' + (actions ? '<div class="topbar__actions">' + actions + '</div>' : '') + '</div>';
  }

  function consensusBadge(agg) {
    if (!agg || !num(agg.consensus)) return '';
    var pct = Math.round(agg.consensus * 100);
    var cls = agg.agreement === 'high' ? 'consensus--high' : (agg.agreement === 'mid' ? 'consensus--mid' : 'consensus--low');
    var label = agg.agreement === 'high' ? '一致' : (agg.agreement === 'mid' ? '较一致' : '有分歧');
    return '<span class="consensus ' + cls + '">' + ICO.check + esc((agg.usedSources || []).length + ' 源综合 · ' + label) + ' <b>' + pct + '%</b></span>';
  }

  function updatedLine(fetchedAt, loading) {
    if (loading) return '<span class="updated"><span class="dot dot--idle dot--live"></span>正在更新…</span>';
    return '<span class="updated"><span class="dot dot--ok"></span>' + esc(minutesAgo(fetchedAt)) + '更新</span>';
  }

  function sectionLabel(text, icon) {
    return '<div class="section-label">' + (icon ? ICO[icon] || '' : '') + esc(text) + '</div>';
  }

  function toastHost() {
    return '<div class="toast-host" id="wh-toast-host" aria-live="polite"></div>';
  }


  /* ======================================================================
   * 3. 逐小时 SVG 曲线
   * ==================================================================== */

  function smoothPath(pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return 'M' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    var d = 'M' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) / 6;
      var c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6;
      var c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ',' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ',' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
    }
    return d;
  }

  function hourlySvg(hourly) {
    var pts = [];
    for (var i = 0; i < (hourly || []).length && i < 24; i++) pts.push(hourly[i]);
    if (!pts.length) return '';
    var n = pts.length;
    var step = 62;
    var padL = 20;
    var padR = 20;
    var width = padL + padR + n * step;
    var height = 216;
    var temps = [];
    for (var j = 0; j < n; j++) { var t = num(pts[j].temp); if (t !== null) temps.push(t); }
    var tMin = temps.length ? Math.min.apply(null, temps) : 0;
    var tMax = temps.length ? Math.max.apply(null, temps) : 1;
    if (tMax - tMin < 3) { tMax += 1.5; tMin -= 1.5; }
    var pad = Math.max(1.5, (tMax - tMin) * 0.16);
    var lo = tMin - pad;
    var hi = tMax + pad;
    var range = Math.max(0.1, hi - lo);
    function tx(i) { return padL + i * step + step / 2; }
    function ty(t) { return 100 - ((t - lo) / range) * 54; }
    var out = '<svg class="hourly__svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="未来24小时温度曲线">';
    out += '<defs>' +
      '<linearGradient id="h-bar-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ecbff"/><stop offset="1" stop-color="#3f86d8"/></linearGradient>' +
      '<linearGradient id="h-area-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.34)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></linearGradient>' +
      '</defs>';
    for (var k = 0; k < n; k++) {
      var hh = new Date(Number(pts[k].t)).getHours();
      if (hh < 6 || hh >= 19) {
        out += '<rect class="h-night" x="' + (tx(k) - step / 2 + 5).toFixed(1) + '" y="28" width="' + (step - 10) + '" height="92" rx="10"/>';
      }
    }
    var gridYs = [ty(hi) + 2, (ty(hi) + ty(lo)) / 2, ty(lo) - 2];
    for (var g = 0; g < gridYs.length; g++) {
      out += '<line class="h-grid" x1="' + (padL - 8) + '" y1="' + gridYs[g].toFixed(1) + '" x2="' + (width - padR + 8) + '" y2="' + gridYs[g].toFixed(1) + '"/>';
    }
    var linePts = [];
    for (var m = 0; m < n; m++) {
      var tv = num(pts[m].temp);
      if (tv === null) continue;
      linePts.push({ x: tx(m), y: ty(tv), i: m, t: tv });
    }
    if (linePts.length) {
      var dLine = smoothPath(linePts);
      var first = linePts[0];
      var last = linePts[linePts.length - 1];
      var dArea = dLine + ' L' + last.x.toFixed(1) + ' 128 L' + first.x.toFixed(1) + ' 128 Z';
      out += '<path class="h-area" d="' + dArea + '" fill="url(#h-area-grad)"/>';
      out += '<path class="h-line-halo" d="' + dLine + '"/>';
      out += '<path class="h-line" d="' + dLine + '"/>';
    }
    for (var q = 0; q < n; q++) {
      var p = pts[q];
      var x = tx(q);
      var temp = num(p.temp);
      var prob = num(p.precipProb);
      var code = num(p.code, 12);
      var iconName = (WH.CODE_META && WH.CODE_META[code] && WH.CODE_META[code].icon) || 'unknown';
      var ic = iconSvg(iconName);
      ic = ic.replace('width="24" height="24"', 'x="' + (x - 11).toFixed(1) + '" y="124" width="22" height="22"');
      ic = ic.replace('<svg ', '<svg style="color:rgba(238,246,255,.9)" ');
      ic = ic.replace(/stroke-width="2([^"]*)"/g, 'stroke-width="1.7$1"');
      out += '<g>' + ic + '</g>';
      if (temp !== null) {
        out += '<text class="h-temp" x="' + x.toFixed(1) + '" y="' + (ty(temp) - 11).toFixed(1) + '" text-anchor="middle">' + esc(fmtTempNum(temp)) + '°</text>';
      }
      if (prob !== null && prob > 0) {
        out += '<text class="h-prob" x="' + x.toFixed(1) + '" y="166" text-anchor="middle">' + Math.round(prob) + '%</text>';
        var bh = Math.max(2, Math.round(prob / 100 * 24));
        out += '<rect class="h-bar" x="' + (x - 4).toFixed(1) + '" y="' + (196 - bh) + '" width="8" height="' + bh + '" rx="2.5"/>';
      }
      var hourTxt = q === 0 ? '现在' : (('0' + new Date(Number(p.t)).getHours()).slice(-2) + '时');
      out += '<text class="' + (q === 0 ? 'h-now' : 'h-hour') + '" x="' + x.toFixed(1) + '" y="212" text-anchor="middle">' + esc(hourTxt) + '</text>';
    }
    if (linePts.length) {
      for (var r = 0; r < linePts.length; r++) {
        var lp = linePts[r];
        if (lp.i === 0) {
          out += '<circle class="h-point h-point--now" cx="' + lp.x.toFixed(1) + '" cy="' + lp.y.toFixed(1) + '" r="4.2"/>';
          out += '<circle class="h-now-ring" cx="' + lp.x.toFixed(1) + '" cy="' + lp.y.toFixed(1) + '" r="8"/>';
        } else {
          out += '<circle class="h-point" cx="' + lp.x.toFixed(1) + '" cy="' + lp.y.toFixed(1) + '" r="2.4"/>';
        }
      }
    }
    out += '</svg>';
    return out;
  }

  function hourlyCard(agg) {
    if (!agg || !agg.hourly || !agg.hourly.length) return '';
    return '<div class="card hourly">' +
      '<div class="card__head"><div class="card__title">' + ICO.clock + '24 小时预报</div>' +
      '<div class="card__extra hourly__legend"><i><span class="lg-line"></span>温度</i><i><span class="lg-bar"></span>降水</i></div></div>' +
      '<div class="hourly__scroll">' + hourlySvg(agg.hourly) + '</div>' +
      '</div>';
  }

  /* ======================================================================
   * 4. 7 天预报
   * ==================================================================== */

  function dailyCard(agg) {
    if (!agg || !agg.daily || !agg.daily.length) return '';
    var days = agg.daily.slice(0, 7);
    var lo = null, hi = null;
    for (var i = 0; i < days.length; i++) {
      var mn = num(days[i].tempMin), mx = num(days[i].tempMax);
      if (mn !== null && (lo === null || mn < lo)) lo = mn;
      if (mx !== null && (hi === null || mx > hi)) hi = mx;
    }
    if (lo === null) lo = 0;
    if (hi === null) hi = 1;
    if (hi - lo < 3) { hi += 1; lo -= 1; }
    var span = Math.max(1, hi - lo);
    var rows = '';
    for (var j = 0; j < days.length; j++) {
      var d = days[j];
      var isToday = j === 0;
      var name = dayLabel(d.date);
      var dateTxt = String(d.date || '').slice(5).replace('-', '/');
      var mn2 = num(d.tempMin), mx2 = num(d.tempMax);
      var left = mn2 === null ? 0 : clamp((mn2 - lo) / span * 100, 0, 100);
      var w = mn2 === null || mx2 === null ? 0 : clamp((mx2 - mn2) / span * 100, 4, 100 - left);
      var prob = num(d.precipProb);
      var iconName = d.icon || ((WH.CODE_META && WH.CODE_META[num(d.code, 12)] && WH.CODE_META[num(d.code, 12)].icon) || 'unknown');
      rows += '<div class="day' + (isToday ? ' day--today' : '') + '">' +
        '<div class="day__when"><div class="day__name">' + esc(name) + '</div><div class="day__date">' + esc(dateTxt) + '</div></div>' +
        '<div class="day__icon">' + iconSvg(iconName, 26) + '</div>' +
        '<div class="day__right">' +
        '<span class="day__prob' + (prob === null || prob <= 0 ? ' is-empty' : '') + '">' + (prob !== null && prob > 0 ? Math.round(prob) + '%' : '0%') + '</span>' +
        '<span class="day__min">' + esc(fmtTempNum(mn2)) + '°</span>' +
        '<span class="day__track"><span class="day__fill" style="left:' + left.toFixed(1) + '%;width:' + w.toFixed(1) + '%"></span></span>' +
        '<span class="day__max">' + esc(fmtTempNum(mx2)) + '°</span>' +
        '</div></div>';
    }
    return '<div class="card daily-card">' +
      '<div class="card__head"><div class="card__title">' + ICO.sun + '7 天预报</div><div class="card__extra">' + (agg.usedSources || []).length + ' 源综合</div></div>' +
      '<div class="daily">' + rows + '</div></div>';
  }

  /* ======================================================================
   * 5. 指标网格
   * ==================================================================== */

  function metricItem(label, icon, value, unit, sub, barPct, barCls) {
    return '<div class="metric">' +
      '<div class="metric__label">' + (ICO[icon] || '') + esc(label) + '</div>' +
      '<div class="metric__value">' + (value === null || value === undefined ? '--' : esc(value)) + (unit ? '<span class="metric__unit">' + esc(unit) + '</span>' : '') + '</div>' +
      '<div class="metric__sub">' + esc(sub || ' ') + '</div>' +
      (barPct === null || barPct === undefined ? '' : '<div class="metric__bar' + (barCls ? ' metric__bar--' + barCls : '') + '"><i style="width:' + clamp(barPct, 0, 100).toFixed(1) + '%"></i></div>') +
      '</div>';
  }

  function metricsGrid(agg) {
    if (!agg) return '';
    var hum = num(agg.humidity);
    var ws = num(agg.windSpeed);
    var pr = num(agg.pressure);
    var uv = num(agg.uvIndex);
    var vis = num(agg.visibility);
    var prec = num(agg.precip);
    var uvLevel = uv === null ? '' : (uv < 3 ? '弱' : (uv < 6 ? '中等' : (uv < 8 ? '强' : (uv < 11 ? '很强' : '极强'))));
    var visLevel = vis === null ? '' : (vis >= 20 ? '极佳' : (vis >= 10 ? '良好' : (vis >= 5 ? '一般' : '较差')));
    var dayProb = agg.daily && agg.daily[0] ? num(agg.daily[0].precipProb) : null;
    var windLabel = windUnitLabel();
    return '<div class="metrics">' +
      metricItem('湿度', 'drop', hum === null ? null : Math.round(hum), '%', hum === null ? '暂无数据' : (hum > 80 ? '潮湿' : (hum < 30 ? '干燥' : '适中')), hum, '') +
      metricItem('风速', 'wind', ws === null ? null : (windLabel === 'm/s' ? ws.toFixed(1) : Math.round(ws * 3.6)), windLabel, (windDirText(agg.windDir) || '风向 --') + ' ' + (windDirArrow(agg.windDir) || ''), ws === null ? null : ws / 15 * 100, '') +
      metricItem('气压', 'gauge', pr === null ? null : Math.round(pr), 'hPa', pr === null ? '暂无数据' : (pr > 1013 ? '高压 · 天气稳定' : '低压 · 可能变化'), pr === null ? null : (pr - 950) / 100 * 100, '') +
      metricItem('紫外线', 'sun', uv === null ? null : uv.toFixed(1), '', uvLevel ? uvLevel + ' · 注意防晒' : '暂无数据', uv === null ? null : uv / 11 * 100, 'warm') +
      metricItem('能见度', 'eye', vis === null ? null : vis.toFixed(1), 'km', visLevel || '暂无数据', vis === null ? null : vis / 20 * 100, 'green') +
      metricItem('降水', 'drop', prec === null ? null : prec.toFixed(1), 'mm', dayProb !== null ? '今日降水概率 ' + Math.round(dayProb) + '%' : '过去一小时降水量', prec === null ? null : prec / 10 * 100, 'purple') +
      '</div>';
  }

  /* ======================================================================
   * 6. 多源对比
   * ==================================================================== */

  function cmpCard(results, agg) {
    if (!results || !results.length || !agg) return '';
    var temps = [];
    var i;
    for (i = 0; i < results.length; i++) {
      if (results[i].status === 'ok' && results[i].current && num(results[i].current.temp) !== null) temps.push(num(results[i].current.temp));
    }
    if (!temps.length) return '';
    var aggTemp = num(agg.temp);
    var lo = Math.min.apply(null, temps.concat(aggTemp === null ? [] : [aggTemp]));
    var hi = Math.max.apply(null, temps.concat(aggTemp === null ? [] : [aggTemp]));
    if (hi - lo < 2) { hi += 1; lo -= 1; }
    var span = Math.max(0.8, hi - lo);
    var aggPct = aggTemp === null ? 50 : clamp((aggTemp - lo) / span * 100, 3, 97);
    var rows = '';
    var failed = [];
    for (i = 0; i < results.length; i++) {
      var r = results[i];
      var meta = r.meta || (WH.sources && WH.sources.META && WH.sources.META[r.id]) || { name: r.id, color: '#8ecbff' };
      if (r.status !== 'ok' || !r.current || num(r.current.temp) === null) {
        if (r.status !== 'ok') failed.push(r);
        continue;
      }
      var t = num(r.current.temp);
      var pct = clamp((t - lo) / span * 100, 3, 97);
      var dev = aggTemp === null ? null : t - aggTemp;
      var devAbs = dev === null ? 99 : Math.abs(dev);
      var devCls = devAbs <= 0.5 ? 'near' : (devAbs <= 2 ? 'mid' : 'far');
      var devTxt = dev === null ? '--' : (dev > 0 ? '+' : '') + dev.toFixed(1) + '°';
      var tTxt = (WH.utils && WH.utils.fmtTemp) ? WH.utils.fmtTemp(t) : fmtTemp(t);
      rows += '<div class="cmp__row">' +
        '<div class="cmp__name"><i style="background:' + esc(meta.color || '#8ecbff') + '"></i><span>' + esc(String(meta.name || r.id).replace(' / Yr', '')) + '</span></div>' +
        '<div class="cmp__track"><div class="cmp__base" style="left:' + aggPct.toFixed(1) + '%"></div><div class="cmp__pt" style="left:' + pct.toFixed(1) + '%;background:' + esc(meta.color || '#8ecbff') + '"></div></div>' +
        '<div class="cmp__val"><span class="cmp__temp">' + esc(tTxt) + '</span><span class="cmp__dev cmp__dev--' + devCls + '">' + esc(devTxt) + '</span></div>' +
        '</div>';
    }
    var foot = '';
    if (failed.length) {
      foot += '<div class="cmp__failed"><span>获取失败：' + esc(failed.map(function (x) { return (x.meta && x.meta.name) || x.id; }).join('、')) + '</span>';
      for (var f = 0; f < failed.length; f++) {
        foot += '<button data-act="retry-source" data-id="' + esc(failed[f].id) + '">重试</button>';
      }
      foot += '</div>';
    }
    var aggTxt = aggTemp === null ? '--' : ((WH.utils && WH.utils.fmtTemp) ? WH.utils.fmtTemp(aggTemp) : fmtTemp(aggTemp));
    return '<div class="card">' +
      '<div class="card__head"><div class="card__title">' + ICO.layers + '多源温度对比</div>' +
      '<div class="card__extra cmp__legend"><i></i>综合值 ' + esc(aggTxt) + '</div></div>' +
      '<div class="cmp">' + rows + '</div>' + foot + '</div>';
  }

  /* ======================================================================
   * 7. 空气质量 & 预警
   * ==================================================================== */

  function aqiLevel(aqi) {
    if (aqi === null) return { label: '--', color: '#94a3b8' };
    if (aqi <= 50) return { label: '优', color: '#4cd964' };
    if (aqi <= 100) return { label: '良', color: '#ffd166' };
    if (aqi <= 150) return { label: '轻度污染', color: '#ff9f43' };
    if (aqi <= 200) return { label: '中度污染', color: '#ff6b6b' };
    if (aqi <= 300) return { label: '重度污染', color: '#a06bff' };
    return { label: '严重污染', color: '#b0415c' };
  }

  function aqiCard(aqi) {
    if (!aqi || num(aqi.usAqi) === null) return '';
    var v = Math.round(num(aqi.usAqi));
    var lv = aqiLevel(v);
    var marker = clamp(v / 500 * 100, 2, 98);
    var chips = '';
    if (num(aqi.pm25) !== null) chips += '<span class="pm">PM2.5 <b>' + Math.round(num(aqi.pm25)) + '</b></span>';
    if (num(aqi.pm10) !== null) chips += '<span class="pm">PM10 <b>' + Math.round(num(aqi.pm10)) + '</b></span>';
    if (num(aqi.ozone) !== null) chips += '<span class="pm">O₃ <b>' + Math.round(num(aqi.ozone)) + '</b></span>';
    if (num(aqi.no2) !== null) chips += '<span class="pm">NO₂ <b>' + Math.round(num(aqi.no2)) + '</b></span>';
    return '<div class="card aqi-card">' +
      '<div class="card__head"><div class="card__title">' + ICO.drop + '空气质量</div><div class="card__extra">' + esc(minutesAgo(aqi.updatedAt)) + '更新</div></div>' +
      '<div class="aqi">' +
      '<div class="aqi__top"><div class="aqi__value">' + v + '</div><div class="aqi__side"><span class="aqi__level" style="color:' + lv.color + ';background:' + lv.color + '22;border:1px solid ' + lv.color + '55">' + esc(lv.label) + '</span><span class="aqi__label">US AQI · 美国标准</span></div></div>' +
      '<div class="aqi__scale"><span class="aqi__marker" style="left:' + marker.toFixed(1) + '%"></span></div>' +
      '<div class="aqi__labels"><span>0</span><span>50</span><span>100</span><span>150</span><span>200</span><span>300</span><span>500</span></div>' +
      '<div class="aqi__pms">' + chips + '</div>' +
      '</div></div>';
  }

  var LEVEL_CN = { blue: '蓝色', yellow: '黄色', orange: '橙色', red: '红色', grey: '灰色', gray: '灰色', white: '白色', black: '黑色' };

  function levelCn(level) {
    var raw = String(level || '').trim();
    if (!raw) return '';
    var lower = raw.toLowerCase();
    if (LEVEL_CN[lower]) return LEVEL_CN[lower];
    return raw;
  }

  function alertCls(level) {
    var s = String(level || '').toLowerCase();
    if (s.indexOf('红') >= 0 || s.indexOf('red') >= 0) return 'alert--red';
    if (s.indexOf('橙') >= 0 || s.indexOf('orange') >= 0) return 'alert--orange';
    if (s.indexOf('黄') >= 0 || s.indexOf('yellow') >= 0) return 'alert--yellow';
    if (s.indexOf('白') >= 0 || s.indexOf('蓝') >= 0 || s.indexOf('blue') >= 0) return 'alert--blue';
    return 'alert--blue';
  }

  function fmtAlertTime(t) {
    if (!t) return '';
    var str = String(t);
    var m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ' 发布';
    var n = Number(t);
    if (isFinite(n) && n > 1000000000) {
      var d = new Date(n);
      return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' 发布';
    }
    return str;
  }

  function alertsList(alerts) {
    if (!alerts || !alerts.length) return '';
    var out = '';
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i] || {};
      out += '<div class="alert ' + alertCls(a.level) + '">' + ICO.alert +
        '<div class="alert__body">' +
        '<div class="alert__top"><span class="alert__title">' + esc(a.title || '气象预警') + '</span>' +
        (a.level ? '<span class="alert__level">' + esc(levelCn(a.level)) + '</span>' : '') + '</div>' +
        (a.text ? '<div class="alert__text">' + esc(a.text) + '</div>' : '') +
        (a.time ? '<div class="alert__time">' + esc(fmtAlertTime(a.time)) + '</div>' : '') +
        '</div></div>';
    }
    return out;
  }

  /* ======================================================================
   * 8. 综合页 Hero + 组装
   * ==================================================================== */

  function hero(agg, city, fetchedAt, loading) {
    if (!agg) return '';
    var temp = num(agg.temp);
    var day0 = agg.daily && agg.daily[0] ? agg.daily[0] : null;
    var hi = day0 ? num(day0.tempMax) : (agg.tempRange ? num(agg.tempRange[1]) : null);
    var lo = day0 ? num(day0.tempMin) : (agg.tempRange ? num(agg.tempRange[0]) : null);
    var isDay = !(new Date().getHours() < 6 || new Date().getHours() >= 19);
    if (agg.currentIsDay === false) isDay = false;
    if (agg.currentIsDay === true) isDay = true;
    var art = artSvg(agg.conditionCode, isDay);
    var condText = agg.conditionText || ((WH.CODE_META && WH.CODE_META[num(agg.conditionCode, 12)]) || {}).name || '';
    return '<div class="hero">' +
      '<div class="hero__main">' +
      '<div class="hero__temp"><span class="hero__num" data-roll="' + (temp === null ? '' : temp) + '">' + esc(fmtTempNum(temp)) + '</span><span class="hero__deg">°</span></div>' +
      '<div class="hero__cond">' + esc(condText) + '</div>' +
      '<div class="hero__range">' +
      (hi !== null ? '<span><b>最高 ' + esc(fmtTempNum(hi)) + '°</b></span>' : '') +
      (lo !== null ? '<span>最低 ' + esc(fmtTempNum(lo)) + '°</span>' : '') +
      (num(agg.feelsLike) !== null ? '<span>体感 ' + esc(fmtTempNum(agg.feelsLike)) + '°</span>' : '') +
      '</div></div>' +
      '<div class="hero__art">' + art + '</div>' +
      '<div class="hero__meta">' + consensusBadge(agg) + updatedLine(fetchedAt, loading) + '</div>' +
      '</div>';
  }

  function staleBanner(savedAt) {
    if (!savedAt) return '';
    var mins = Math.round((Date.now() - savedAt) / 60000);
    if (mins < 30) return '';
    return '<div class="stale-banner">' + ICO.info +
      '<span>当前显示的是 ' + esc(minutesAgo(savedAt)) + '缓存数据，可能已过期。</span>' +
      '<button data-act="refresh">刷新</button></div>';
  }

  function sourcesNote(agg, fetchedAt) {
    return '<div class="set-foot">' + esc((agg.usedSources || []).length) + ' 个平台综合 · 更新于 ' + esc(fmtTime(fetchedAt)) +
      '<br>数据仅供参考 · 来源：中国气象局 / Open-Meteo / MET Norway / wttr.in</div>';
  }

  function renderHome(st) {
    var agg = st.aggregate;
    if (!agg && st.loading) return skeleton();
    if (!agg && st.error) return errorState(st.error);
    if (!agg && st.cachedAgg) agg = st.cachedAgg;
    if (!agg) return skeleton();
    var html = topbar(st.city, { busy: st.loading });
    html += staleBanner(st.cachedSavedAt);
    html += hero(agg, st.city, st.fetchedAt, st.loading);
    html += alertsList(agg.alerts);
    html += hourlyCard(agg);
    html += dailyCard(agg);
    html += sectionLabel('天气详情', 'sliders');
    html += metricsGrid(agg);
    html += aqiCard(agg.aqi || st.aqi);
    html += cmpCard(st.results, agg);
    html += sourcesNote(agg, st.fetchedAt);
    return html;
  }

  /* ======================================================================
   * 9. 平台页
   * ==================================================================== */

  function srcStats(current) {
    if (!current) return '';
    var items = [
      ['体感', num(current.feelsLike) === null ? '--' : fmtTempNum(current.feelsLike) + '°'],
      ['湿度', num(current.humidity) === null ? '--' : Math.round(num(current.humidity)) + '%'],
      ['风速', num(current.windSpeed) === null ? '--' : fmtWind(current.windSpeed)],
      ['气压', num(current.pressure) === null ? '--' : Math.round(num(current.pressure)) + ' hPa'],
      ['紫外线', num(current.uvIndex) === null ? '--' : num(current.uvIndex).toFixed(1)],
      ['能见度', num(current.visibility) === null ? '--' : num(current.visibility).toFixed(1) + ' km']
    ];
    var out = '<div class="src-stats">';
    for (var i = 0; i < items.length; i++) {
      out += '<div class="src-stat"><div class="src-stat__k">' + esc(items[i][0]) + '</div><div class="src-stat__v">' + esc(items[i][1]) + '</div></div>';
    }
    return out + '</div>';
  }

  function srcHourly(hourly) {
    if (!hourly || !hourly.length) return '';
    var out = '<div class="src-hourly">';
    for (var i = 0; i < hourly.length && i < 16; i++) {
      var p = hourly[i];
      var iconName = (WH.CODE_META && WH.CODE_META[num(p.code, 12)] && WH.CODE_META[num(p.code, 12)].icon) || 'unknown';
      var prob = num(p.precipProb);
      out += '<div class="src-hour">' +
        '<span class="src-hour__t">' + esc(i === 0 ? '现在' : fmtTime(p.t)) + '</span>' +
        '<span class="src-hour__i">' + iconSvg(iconName, 18) + '</span>' +
        '<span class="src-hour__temp">' + esc(fmtTempNum(p.temp)) + '°</span>' +
        '<span class="src-hour__p">' + (prob !== null && prob > 0 ? Math.round(prob) + '%' : '&nbsp;') + '</span>' +
        '</div>';
    }
    return out + '</div>';
  }

  function srcMiniDaily(daily) {
    if (!daily || !daily.length) return '';
    var out = '<div class="mini-daily">';
    for (var i = 0; i < daily.length && i < 7; i++) {
      var d = daily[i];
      var iconName = d.icon || ((WH.CODE_META && WH.CODE_META[num(d.code, 12)] && WH.CODE_META[num(d.code, 12)].icon) || 'unknown');
      var prob = num(d.precipProb);
      out += '<div class="mini-day">' +
        '<span class="mini-day__name">' + esc(dayLabel(d.date)) + '</span>' +
        '<span class="mini-day__icon">' + iconSvg(iconName, 19) + '</span>' +
        '<span class="mini-day__text">' + esc(d.text || ((WH.CODE_META && WH.CODE_META[num(d.code, 12)] && WH.CODE_META[num(d.code, 12)].name) || '')) + '</span>' +
        '<span class="mini-day__range">' + esc(fmtTempNum(d.tempMin)) + '° / ' + esc(fmtTempNum(d.tempMax)) + '°' +
        (prob !== null && prob > 0 ? '<span class="mini-day__prob">' + Math.round(prob) + '%</span>' : '') + '</span>' +
        '</div>';
    }
    return out + '</div>';
  }

  function kindBadge(kind) {
    var map = { official: ['官方', 'kind--official'], model: ['模型', 'kind--model'], aggregator: ['聚合', 'kind--aggregator'] };
    var it = map[kind] || ['平台', ''];
    return '<span class="kind ' + it[1] + '">' + it[0] + '</span>';
  }

  function sourceCard(r, st) {
    var meta = r.meta || (WH.sources && WH.sources.META && WH.sources.META[r.id]) || { name: r.id, short: String(r.id).slice(0, 4).toUpperCase(), color: '#8ecbff', kind: 'aggregator' };
    var isOpen = r.status !== 'ok' || !!(st.openSources && st.openSources[r.id]);
    var avatar = '<span class="src-card__avatar" style="background:linear-gradient(140deg,' + esc(meta.color || '#8ecbff') + ',' + esc(shade(meta.color || '#8ecbff')) + ')">' + esc(meta.short || '') + '</span>';
    var head;
    if (r.status === 'ok' && r.current) {
      var temp = num(r.current.temp);
      var cond = r.current.conditionText || ((WH.CODE_META && WH.CODE_META[num(r.current.conditionCode, 12)]) || {}).name || '';
      head = '<button class="src-card__head" data-act="toggle-source" data-id="' + esc(r.id) + '" aria-expanded="' + isOpen + '">' + avatar +
        '<span class="src-card__main"><span class="src-card__name"><strong>' + esc(meta.name || r.id) + '</strong>' + kindBadge(meta.kind) + '</span>' +
        '<span class="src-card__sub"><i style="background:#4cd964"></i>' + esc(cond) + ' · ' + esc(r.ms) + 'ms · ' + esc(minutesAgo(r.fetchedAt)) + '</span></span>' +
        '<span class="src-card__right"><span class="src-card__temp">' + esc(fmtTempNum(temp)) + '°</span><span class="src-card__chevron">' + ICO.chevron + '</span></span></button>';
    } else {
      head = '<div class="src-card__head">' + avatar +
        '<span class="src-card__main"><span class="src-card__name"><strong>' + esc(meta.name || r.id) + '</strong>' + kindBadge(meta.kind) + '</span>' +
        '<span class="src-card__sub"><i style="background:#ff6b6b"></i>' + esc(errText(r.error)) + '</span></span>' +
        '<span class="src-card__right"><span class="src-card__temp src-card__temp--error">失败</span></span></div>';
    }
    var body = '';
    if (r.status === 'ok' && r.current) {
      body = '<div class="src-card__body">' + srcStats(r.current) + srcHourly(r.hourly) + srcMiniDaily(r.daily) +
        '<div class="src-note"><span>来源：' + esc(meta.name || r.id) + ' · 延迟 ' + esc(r.ms) + 'ms</span>' +
        '<button class="btn btn--sm btn--ghost" data-act="open-url" data-url="' + esc(meta.homepage || '') + '">' + ICO.arrowUpRight + '官网</button></div>' +
        '<div class="src-actions"><button class="btn btn--sm btn--ghost" data-act="refresh-source" data-id="' + esc(r.id) + '">' + ICO.refresh + '刷新本平台</button></div>' +
        '</div>';
    } else {
      body = '<div class="src-card__body"><div class="src-error">' + ICO.alert + '<span class="src-error__text">' + esc(errText(r.error)) + '</span></div>' +
        '<div class="src-actions"><button class="btn btn--sm btn--ghost" data-act="refresh-source" data-id="' + esc(r.id) + '">' + ICO.refresh + '重试</button>' +
        (meta.homepage ? '<button class="btn btn--sm btn--ghost" data-act="open-url" data-url="' + esc(meta.homepage) + '">' + ICO.arrowUpRight + '官网</button>' : '') +
        '</div></div>';
    }
    var cls = 'src-card' + (r.status !== 'ok' ? ' src-card--error' : '') + (isOpen ? ' is-open' : '');
    return '<div class="' + cls + '" data-id="' + esc(r.id) + '">' + head +
      '<div class="src-card__expand"><div class="src-card__expandInner">' + body + '</div></div></div>';
  }

  function lockedCard(meta, st) {
    var hasKey = meta.id === 'qweather' ? !!st.settings.qweatherKey : !!st.settings.owmKey;
    return '<div class="src-card src-card--locked" data-id="' + esc(meta.id) + '">' +
      '<div class="src-card__head"><span class="src-card__avatar" style="background:linear-gradient(140deg,#6b7280,#4b5563)">' + esc(meta.short || '') + '</span>' +
      '<span class="src-card__main"><span class="src-card__name"><strong>' + esc(meta.name) + '</strong>' + kindBadge(meta.kind) + '</span>' +
      '<span class="src-card__sub"><i style="background:#9ca3af"></i>' + (hasKey ? '已配置 Key，可在设置里启用' : '需要 API Key 才能启用') + '</span></span>' +
      '<span class="src-card__right"><span class="src-card__temp src-card__temp--error" style="color:var(--ink-4);font-weight:600">未启用</span></span></div>' +
      '<div class="src-locked"><span class="src-locked__hint">' + ICO.lock + ' 在设置页填入 Key 后即可加入综合对比</span>' +
      '<button class="btn btn--sm btn--ghost" data-act="go-settings">去设置</button></div></div>';
  }

  function shade(hex) {
    var h = String(hex || '#8ecbff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16) || 0;
    var g = parseInt(h.slice(2, 4), 16) || 0;
    var b = parseInt(h.slice(4, 6), 16) || 0;
    r = Math.max(0, Math.round(r * 0.55));
    g = Math.max(0, Math.round(g * 0.55));
    b = Math.max(0, Math.round(b * 0.55));
    return '#' + ('0' + r.toString(16)).slice(-2) + ('0' + g.toString(16)).slice(-2) + ('0' + b.toString(16)).slice(-2);
  }

  function errText(err) {
    var map = {
      timeout: '请求超时',
      network: '网络连接失败',
      native_error: '原生请求失败',
      http_400: '接口返回 400',
      http_403: '接口拒绝访问（403）',
      http_404: '接口不存在（404）',
      http_429: '请求过于频繁（429）',
      parse: '数据解析失败',
      bad_data: '数据格式异常',
      no_key: '未配置 API Key',
      disabled: '该平台未启用'
    };
    if (!err) return '未知错误';
    return map[String(err)] || ('获取失败（' + String(err) + '）');
  }

  function sourcesPage(st) {
    var ok = 0, total = 0;
    for (var i = 0; i < (st.results || []).length; i++) { total++; if (st.results[i].status === 'ok') ok++; }
    var html = pageHead('数据平台', ok + '/' + total + ' 个平台可用 · ' + (st.loading ? '更新中…' : minutesAgo(st.fetchedAt) + '更新'),
      '<button class="icon-btn' + (st.loading ? ' is-busy' : '') + '" data-act="refresh" aria-label="刷新全部">' + ICO.refresh + '</button>');
    html += '<div class="sources-summary">' + ICO.info + '<span>综合值为多源中位数（自动剔除离群值），天气现象按权重投票。点开卡片可查看该平台独立数据。</span></div>';
    html += '<div class="src-list">';
    for (var j = 0; j < (st.results || []).length; j++) html += sourceCard(st.results[j], st);
    var locked = [];
    var metas = (WH.meta && WH.meta.sources) || [];
    for (var k = 0; k < metas.length; k++) {
      if (metas[k].requiresKey && (st.settings.enabledSources || []).indexOf(metas[k].id) < 0) locked.push(metas[k]);
    }
    for (var l = 0; l < locked.length; l++) html += lockedCard(locked[l], st);
    html += '</div>';
    return html;
  }

  /* ======================================================================
   * 10. 城市页
   * ==================================================================== */

  function searchResults(list, query, busy) {
    if (busy) return '<div class="search__empty">正在搜索…</div>';
    if (!query) return '';
    if (!list || !list.length) return '<div class="search__empty">没有找到「' + esc(query) + '」，换个写法试试（支持中文/拼音/英文）</div>';
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var sub = [c.admin, c.country].filter(function (x) { return !!x; }).join(' · ');
      out += '<button class="search__item" data-act="pick-city" data-idx="' + i + '">' +
        '<span class="search__item-icon">' + ICO.pin + '</span>' +
        '<span class="search__item-main"><span class="search__item-name">' + esc(c.name) + '</span>' +
        '<span class="search__item-sub">' + esc(sub || (num(c.lat).toFixed(2) + ', ' + num(c.lon).toFixed(2))) + '</span></span>' +
        '<span class="src-card__chevron">' + ICO.chevron + '</span></button>';
    }
    return out;
  }

  var COMMON_CITIES = [
    { name: '北京', lat: 39.9042, lon: 116.4074, admin: '北京', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '54511' },
    { name: '上海', lat: 31.2304, lon: 121.4737, admin: '上海', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '58367' },
    { name: '广州', lat: 23.1291, lon: 113.2644, admin: '广东', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '59287' },
    { name: '深圳', lat: 22.5431, lon: 114.0579, admin: '广东', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '59493' },
    { name: '武汉', lat: 30.5833, lon: 114.2667, admin: '湖北', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '57494' },
    { name: '成都', lat: 30.5728, lon: 104.0668, admin: '四川', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '56294' },
    { name: '杭州', lat: 30.2741, lon: 120.1551, admin: '浙江', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '58457' },
    { name: '西安', lat: 34.3416, lon: 108.9398, admin: '陕西', country: '中国', timezone: 'Asia/Shanghai', cmaStationId: '57036' }
  ];

  function citiesPage(st) {
    var html = pageHead('城市', '已保存 ' + (st.savedCities || []).length + ' 个城市');
    html += '<div class="search"><div class="search__field">' + ICO.search +
      '<input class="search__input" id="wh-search" type="search" placeholder="搜索城市（中文 / 拼音 / 英文）" autocomplete="off" autocorrect="off" spellcheck="false" value="' + esc(st.query || '') + '">' +
      (st.searchBusy ? '<span class="search__spin"></span>' : (st.query ? '<button class="search__clear" data-act="clear-search" aria-label="清空">' + ICO.close + '</button>' : '')) +
      '</div>' +
      (st.query ? '<div class="search__results" id="wh-search-results">' + searchResults(st.searchList, st.query, st.searchBusy) + '</div>' : '') +
      '</div>';
    html += '<div class="card gps-card"><button class="btn btn--primary btn--block" data-act="use-gps">' + ICO.gps + '使用当前定位</button>' +
      '<div class="gps-card__hint">首次使用会申请定位权限；若拒绝或定位失败，会自动回退到 IP 定位。当前城市来源：' +
      esc(st.city && st.city.source === 'gps' ? 'GPS' : (st.city && st.city.source === 'ip' ? 'IP 定位' : (st.city && st.city.source === 'search' ? '手动选择' : '默认城市'))) + '</div></div>';
    var rows = '';
    var saved = st.savedCities || [];
    for (var i = 0; i < saved.length; i++) {
      var c = saved[i];
      var cur = st.city && (Math.abs(num(st.city.lat) - num(c.lat)) < 0.02 && Math.abs(num(st.city.lon) - num(c.lon)) < 0.02);
      rows += '<div class="city-row' + (cur ? ' is-current' : '') + '">' +
        '<button class="city-row__btn" data-act="pick-saved" data-idx="' + i + '">' +
        '<span class="city-row__pin">' + ICO.pin + '</span>' +
        '<span class="city-row__main"><span class="city-row__name"><b>' + esc(c.name) + '</b>' + (cur ? '<span class="city-row__tag">当前</span>' : '') + '</span>' +
        '<span class="city-row__sub">' + esc([c.admin, c.country].filter(function (x) { return !!x; }).join(' · ') || (num(c.lat).toFixed(2) + ', ' + num(c.lon).toFixed(2))) + '</span></span>' +
        '</button><button class="city-row__del" data-act="del-saved" data-idx="' + i + '" aria-label="删除城市">' + ICO.trash + '</button></div>';
    }
    html += '<div class="card city-card"><div class="card__head"><div class="card__title">' + ICO.pin + '已保存城市</div>' +
      '<div class="card__extra">' + saved.length + ' 个</div></div>' +
      '<div class="city-list">' + (saved.length ? rows : '<div class="empty-mini">还没有保存城市，搜索后点击结果即可保存</div>') + '</div></div>';
    html += '<div class="card"><div class="card__head"><div class="card__title">' + ICO.city + '常用城市</div></div><div class="chips">';
    for (var j = 0; j < COMMON_CITIES.length; j++) {
      html += '<button class="chip" data-act="pick-common" data-idx="' + j + '">' + esc(COMMON_CITIES[j].name) + '</button>';
    }
    html += '</div></div>';
    return html;
  }

  /* ======================================================================
   * 11. 设置页
   * ==================================================================== */

  function seg(act, cur, items) {
    var out = '<div class="seg">';
    for (var i = 0; i < items.length; i++) {
      out += '<button class="seg__btn' + (String(items[i][0]) === String(cur) ? ' is-active' : '') + '" data-act="' + act + '" data-v="' + esc(items[i][0]) + '">' + esc(items[i][1]) + '</button>';
    }
    return out + '</div>';
  }

  function toggle(act, id, checked, disabled) {
    return '<button class="switch" role="switch" aria-checked="' + (checked ? 'true' : 'false') + '"' +
      (disabled ? ' aria-disabled="true"' : '') + ' data-act="' + act + '" data-id="' + esc(id) + '" aria-label="切换"></button>';
  }

  function settingsPage(st) {
    var s = st.settings;
    var html = pageHead('设置', '天气汇 v' + esc(WH.version || '1.0.0'));
    // 显示
    html += '<div class="set-group"><div class="set-group__head">' + ICO.sliders + '显示</div>' +
      '<div class="set-block"><div class="set-block__label"><span>温度单位</span><b>' + (s.unit === 'f' ? '华氏度 °F' : '摄氏度 °C') + '</b></div>' +
      seg('set-unit', s.unit, [['c', '°C 摄氏度'], ['f', '°F 华氏度']]) + '</div>' +
      '<div class="set-block"><div class="set-block__label"><span>风速单位</span><b>' + (s.windUnit === 'ms' ? '米/秒' : '公里/小时') + '</b></div>' +
      seg('set-wind', s.windUnit, [['kmh', 'km/h'], ['ms', 'm/s']]) + '</div></div>';
    // 数据源
    html += '<div class="set-group"><div class="set-group__head">' + ICO.layers + '数据源</div>';
    var metas = (WH.meta && WH.meta.sources) || [];
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      var enabled = (s.enabledSources || []).indexOf(m.id) >= 0;
      var disabled = !!m.requiresKey && !(m.id === 'qweather' ? s.qweatherKey : s.owmKey);
      html += '<div class="set-row"><span class="set-row__icon">' + (ICO.layers) + '</span>' +
        '<span class="set-row__main"><span class="set-row__title">' + esc(m.name) + kindBadge(m.kind) + '</span>' +
        '<span class="set-row__sub">' + esc(m.id === 'cma' ? '中国气象局官方站号数据' : (m.id === 'open-meteo' ? 'ECMWF/GFS 模型 · 逐小时' : (m.id === 'metno' ? '挪威气象局 Yr · 逐小时' : (m.id === 'wttr' ? 'World Weather Online 聚合' : (m.requiresKey ? '需在下方填 API Key' : '国际数据源'))))) + '</span></span>' +
        toggle('toggle-enabled', m.id, enabled && !disabled, disabled) + '</div>';
    }
    html += '<div class="set-block"><div class="set-block__label"><span>API Key（可选，仅保存在本机）</span><b>本地存储</b></div>' +
      '<div class="keyfield">' + ICO.lock + '<input class="keyfield__input" id="wh-key-qweather" placeholder="和风天气 API Key（可选）" value="' + esc(s.qweatherKey || '') + '"><button class="keyfield__save" data-act="save-key" data-id="qweather">保存</button></div>' +
      '<div class="keyfield" style="margin-top:8px">' + ICO.lock + '<input class="keyfield__input" id="wh-key-owm" placeholder="OpenWeatherMap API Key（可选）" value="' + esc(s.owmKey || '') + '"><button class="keyfield__save" data-act="save-key" data-id="owm">保存</button></div>' +
      '<div class="key-note">不填也能使用 4 个免 Key 平台。Key 只写入本机 localStorage，不会上传到任何服务器。</div></div></div>';
    // 更新与数据
    html += '<div class="set-group"><div class="set-group__head">' + ICO.clock + '更新与数据</div>' +
      '<div class="set-block"><div class="set-block__label"><span>自动刷新</span><b>' + (s.refreshMinutes === 0 ? '手动' : s.refreshMinutes + ' 分钟') + '</b></div>' +
      seg('set-refresh', s.refreshMinutes, [[0, '手动'], [5, '5 分钟'], [10, '10 分钟'], [30, '30 分钟']]) + '</div>' +
      '<button class="set-row" data-act="clear-cache"><span class="set-row__icon">' + ICO.trash + '</span>' +
      '<span class="set-row__main"><span class="set-row__title">清除天气缓存</span><span class="set-row__sub">删除上次缓存数据与上次城市（保留设置）</span></span>' +
      '<span class="set-row__value">' + ICO.chevron + '</span></button>' +
      '<button class="set-row" data-act="reset-settings"><span class="set-row__icon">' + ICO.refresh + '</span>' +
      '<span class="set-row__main"><span class="set-row__title">恢复默认设置</span><span class="set-row__sub">单位 / 数据源 / 刷新间隔恢复初始值</span></span>' +
      '<span class="set-row__value">' + ICO.chevron + '</span></button></div>';
    // 关于
    var links = '<button class="link-row" data-act="open-url" data-url="https://github.com/mdktelmdktel/weatherhub">' +
      '<i style="background:#8ecbff"></i><span class="link-row__main"><span class="link-row__title">开源仓库 · GitHub</span><span class="link-row__sub">mdktelmdktel/weatherhub</span></span>' + ICO.arrowUpRight + '</button>';
    var homes = [['中国气象局', 'https://weather.cma.cn/'], ['Open-Meteo', 'https://open-meteo.com/'], ['MET Norway', 'https://www.met.no/'], ['wttr.in', 'https://wttr.in/'], ['Open-Meteo 空气质量', 'https://open-meteo.com/en/docs/air-quality-api']];
    for (var h = 0; h < homes.length; h++) {
      links += '<button class="link-row" data-act="open-url" data-url="' + esc(homes[h][1]) + '"><i style="background:#4cd964"></i>' +
        '<span class="link-row__main"><span class="link-row__title">' + esc(homes[h][0]) + '</span><span class="link-row__sub">' + esc(homes[h][1].replace('https://', '')) + '</span></span>' + ICO.arrowUpRight + '</button>';
    }
    html += '<div class="set-group"><div class="set-group__head">' + ICO.info + '关于</div><div class="about">' +
      '<div class="about__brand"><div class="about__logo">' + ICO.sun + '</div><div><div class="about__name">天气汇 · WeatherHub</div>' +
      '<div class="about__ver">v' + esc(WH.version || '1.0.0') + ' · 多源天气聚合</div></div></div>' +
      '<div class="about__desc">自动定位城市，从中国气象局、Open-Meteo、MET Norway、wttr.in 等平台获取天气，综合为一份结果，同时保留各平台独立数据。无广告、无账号、无后端。</div>' +
      '<div class="about__links">' + links + '</div></div></div>';
    html += '<div class="set-foot">数据版权归各平台所有，本应用仅做聚合展示<br>长按顶部状态区可查看原生调试日志</div>';
    return html;
  }

  /* ======================================================================
   * 12. 骨架屏 / 空态 / 错误态 / 外壳
   * ==================================================================== */

  function sk(w, h, extra) {
    return '<div class="sk" style="width:' + (w || '100%') + ';height:' + (h || 14) + 'px;' + (extra || '') + '"></div>';
  }

  function skeleton() {
    var out = '<div class="skeleton">' +
      '<div class="skeleton__hero"><div class="skeleton__col">' + sk('62%', 72) + sk('40%', 16) + sk('52%', 13) + '</div>' +
      '<div class="sk" style="width:104px;height:104px;border-radius:50%"></div></div>' +
      '<div class="skeleton__card">' + sk('34%', 13) + sk('100%', 160) + '</div>' +
      '<div class="skeleton__grid">' +
      '<div class="skeleton__card">' + sk('46%', 12) + sk('70%', 20) + '</div>' +
      '<div class="skeleton__card">' + sk('46%', 12) + sk('70%', 20) + '</div>' +
      '<div class="skeleton__card">' + sk('46%', 12) + sk('70%', 20) + '</div>' +
      '<div class="skeleton__card">' + sk('46%', 12) + sk('70%', 20) + '</div>' +
      '</div></div>';
    return out;
  }

  function errorState(err) {
    var msg = errText(err);
    return '<div class="boot"><div class="boot__panel"><div class="state">' +
      '<div class="state__art">' + artSvg(2, true) + '</div>' +
      '<div class="state__title">天气暂时获取失败</div>' +
      '<div class="state__desc">' + esc(msg) + '。请检查网络后重试；也可稍后下拉刷新。</div>' +
      '<div class="state__actions"><button class="btn btn--primary" data-act="refresh">' + ICO.refresh + '重新加载</button>' +
      '<button class="btn btn--ghost" data-act="go-settings">设置</button></div>' +
      '</div></div></div>';
  }

  function emptyState(title, desc, actions) {
    return '<div class="state">' +
      '<div class="state__art">' + artSvg(2, true) + '</div>' +
      '<div class="state__title">' + esc(title) + '</div>' +
      '<div class="state__desc">' + esc(desc) + '</div>' +
      (actions || '') + '</div>';
  }

  var TABS = [
    ['home', '综合'],
    ['sources', '平台'],
    ['cities', '城市'],
    ['settings', '设置']
  ];

  function tabIcon(id) {
    if (id === 'home') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.2L12 4l8.5 7.2"/><path d="M5.5 9.6V20h13V9.6"/></svg>';
    if (id === 'sources') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>';
    if (id === 'cities') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
  }

  function shell() {
    var pages = '';
    for (var i = 0; i < TABS.length; i++) {
      pages += '<section class="page" id="page-' + TABS[i][0] + '" data-page="' + TABS[i][0] + '"><div class="page__inner"></div></section>';
    }
    var tabs = '';
    for (var j = 0; j < TABS.length; j++) {
      tabs += '<button class="tabbar__item" data-tab="' + TABS[j][0] + '" aria-label="' + TABS[j][1] + '">' + tabIcon(TABS[j][0]) + '<span>' + TABS[j][1] + '</span></button>';
    }
    return '<div class="app" data-sky="clear-night" id="wh-app">' +
      '<div class="sky"><div class="sky__glow sky__glow--a"></div><div class="sky__glow sky__glow--b"></div><div class="wx" id="wh-wx"></div></div>' +
      '<div class="ptr" id="wh-ptr"><span class="ptr__ring"></span><span class="ptr__label">下拉刷新</span></div>' +
      '<div class="pages" id="wh-pages">' + pages + '</div>' +
      '<nav class="tabbar"><div class="tabbar__inner"><span class="tabbar__indicator" id="wh-tab-indicator"></span>' + tabs + '</div></nav>' +
      '<div class="toast-host" id="wh-toast-host" aria-live="polite"></div>' +
      '</div>';
  }

  /* ======================================================================
   * 13. Toast / 弹层
   * ==================================================================== */

  function showToast(msg, type) {
    var host = document.getElementById('wh-toast-host');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast--' + type : '');
    var ico = type === 'error' ? ICO.alert : (type === 'warn' ? ICO.info : ICO.check);
    el.innerHTML = ico + '<span>' + esc(msg) + '</span>';
    host.appendChild(el);
    setTimeout(function () {
      el.className += ' is-leaving';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, 2200);
  }

  function showSheet(opts) {
    closeSheet();
    opts = opts || {};
    var acts = '';
    var actions = opts.actions || [{ label: '知道了', cls: 'btn--primary' }];
    for (var i = 0; i < actions.length; i++) {
      acts += '<button class="btn ' + (actions[i].cls || 'btn--ghost') + '" data-act="' + esc(actions[i].act || 'close-sheet') + '">' + esc(actions[i].label) + '</button>';
    }
    var wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.id = 'wh-sheet';
    wrap.innerHTML = '<div class="sheet__panel"><div class="sheet__title">' + esc(opts.title || '') + '</div>' +
      (opts.desc ? '<div class="sheet__desc">' + esc(opts.desc) + '</div>' : '') +
      '<div class="sheet__actions">' + acts + '</div></div>';
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) closeSheet();
    });
    document.getElementById('wh-app').appendChild(wrap);
  }

  function closeSheet() {
    var el = document.getElementById('wh-sheet');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function setPtr(progress, state) {
    var ptr = document.getElementById('wh-ptr');
    if (!ptr) return;
    if (state === 'spinning') {
      ptr.className = 'ptr is-spinning';
      ptr.style.transform = 'translate3d(-50%, 0, 0)';
      ptr.style.opacity = '1';
      var sl = ptr.querySelector('.ptr__label');
      if (sl) sl.textContent = '刷新中…';
      return;
    }
    if (!progress || progress <= 0) {
      ptr.className = 'ptr';
      ptr.style.opacity = '0';
      ptr.style.transform = 'translate3d(-50%, -58px, 0)';
      return;
    }
    var p = Math.min(1, progress);
    ptr.className = 'ptr is-pulling' + (p >= 1 ? ' is-ready' : '');
    ptr.style.opacity = String(Math.min(1, p * 1.6));
    ptr.style.transform = 'translate3d(-50%, ' + Math.round(-58 + 64 * p) + 'px, 0)';
    ptr.style.setProperty('--ptr-rot', Math.round(p * 320) + 'deg');
    var label = ptr.querySelector('.ptr__label');
    if (label) label.textContent = p >= 1 ? '松开刷新' : '下拉刷新';
  }

  function setSky(sky, decor) {
    var app = document.getElementById('wh-app');
    if (app && sky) app.setAttribute('data-sky', sky);
    var wx = document.getElementById('wh-wx');
    if (wx) wx.className = 'wx' + (decor ? ' ' + decor : '');
  }

  /* ======================================================================
   * 14. 对外导出
   * ==================================================================== */

  WH.ui = {
    version: '1.0.0',
    esc: esc, num: num, r1: r1, clamp: clamp,
    fmtTemp: fmtTemp, fmtTempNum: fmtTempNum, fmtWind: fmtWind, fmtTime: fmtTime,
    minutesAgo: minutesAgo, windDirText: windDirText, windDirArrow: windDirArrow, dayLabel: dayLabel,
    iconSvg: iconSvg, uiIcon: uiIcon, ICO: ICO, windUnitLabel: windUnitLabel,
    codeFamily: codeFamily, skyFor: skyFor, skyDecor: skyDecor, artSvg: artSvg,
    cityChip: cityChip, topbar: topbar, pageHead: pageHead, consensusBadge: consensusBadge,
    updatedLine: updatedLine, sectionLabel: sectionLabel,
    hourlySvg: hourlySvg, hourlyCard: hourlyCard, dailyCard: dailyCard,
    metricsGrid: metricsGrid, cmpCard: cmpCard, aqiCard: aqiCard, alertsList: alertsList,
    hero: hero, staleBanner: staleBanner, renderHome: renderHome,
    sourcesPage: sourcesPage, citiesPage: citiesPage, settingsPage: settingsPage,
    searchResults: searchResults, COMMON_CITIES: COMMON_CITIES,
    skeleton: skeleton, errorState: errorState, emptyState: emptyState,
    shell: shell, TABS: TABS,
    showToast: showToast, showSheet: showSheet, closeSheet: closeSheet,
    setPtr: setPtr, setSky: setSky, toastHost: toastHost
  };

})(typeof window !== 'undefined' ? window : globalThis);
