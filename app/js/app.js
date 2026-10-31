/*!
 * WeatherHub（天气汇）— 应用控制器
 * 负责：状态、路由、定位、刷新、自动刷新、缓存、设置、下拉刷新、事件委托
 */
(function (global) {
  'use strict';

  var WH = global.WH = global.WH || {};
  var UI = WH.ui;
  var doc = global.document;
  if (!UI) { try { console.error('[WH] ui.js 未加载'); } catch (e) {} return; }

  var TABS = ['home', 'sources', 'cities', 'settings'];

  var state = {
    tab: 'home',
    city: null,
    results: [],
    aggregate: null,
    aqi: null,
    fetchedAt: 0,
    cachedSavedAt: 0,
    loading: false,
    error: '',
    settings: null,
    query: '',
    searchList: [],
    searchBusy: false,
    savedCities: [],
    openSources: {},
    dirty: { home: false, sources: false, cities: false, settings: false },
    _pendingRefresh: false,
    _autoTimer: null,
    _rollRaf: null,
    _searchTimer: null,
    _buf: 0
  };

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  function loadSettings() {
    try { return WH.settings.get(); } catch (e) {
      return { unit: 'c', windUnit: 'kmh', enabledSources: ['cma', 'open-meteo', 'metno', 'wttr'], qweatherKey: '', owmKey: '', qweatherHost: 'devapi.qweather.com', theme: 'dark', refreshMinutes: 10 };
    }
  }

  function saveSettings(patch) {
    try { state.settings = WH.settings.set(patch) || loadSettings(); } catch (e) { state.settings = loadSettings(); }
    return state.settings;
  }

  function defaultCity() {
    try { if (WH.location && WH.location.defaultCity) return WH.location.defaultCity(); } catch (e) {}
    return { id: 'default-wuhan', name: '武汉', admin: '湖北', country: '中国', lat: 30.5833, lon: 114.2667, timezone: 'Asia/Shanghai', cmaStationId: '57494', source: 'default' };
  }

  function isDayNow() {
    var h = new Date().getHours();
    return h >= 6 && h < 19;
  }

  /** “武汉市/北京市” -> “武汉/北京”，更符合界面习惯 */
  function normalizeCityName(name) {
    var s = String(name || '').trim();
    if (/^[\u4e00-\u9fa5]{2,8}市$/.test(s)) s = s.slice(0, -1);
    return s || '当前位置';
  }

  /* ======================================================================
   * 渲染
   * ==================================================================== */

  function setSky() {
    var agg = state.aggregate;
    var code = agg ? agg.conditionCode : 2;
    var day = isDayNow();
    if (agg && agg.currentIsDay === false) day = false;
    UI.setSky(UI.skyFor(code, day), UI.skyDecor(code));
  }

  function renderTabbar() {
    var items = $$('.tabbar__item');
    for (var i = 0; i < items.length; i++) {
      var active = items[i].getAttribute('data-tab') === state.tab;
      items[i].classList[active ? 'add' : 'remove']('is-active');
      if (active) items[i].setAttribute('aria-current', 'page'); else items[i].removeAttribute('aria-current');
    }
    var ind = $('#wh-tab-indicator');
    var idx = TABS.indexOf(state.tab);
    if (ind) ind.style.setProperty('--tab', String(idx < 0 ? 0 : idx));
  }

  function pageEl(tab) { return doc.getElementById('page-' + tab); }
  function pageInner(tab) { var p = pageEl(tab); return p ? p.querySelector('.page__inner') : null; }

  function renderPage(tab) {
    var inner = pageInner(tab);
    if (!inner) return;
    if (tab === 'home') inner.innerHTML = UI.renderHome(state);
    else if (tab === 'sources') inner.innerHTML = UI.sourcesPage(state);
    else if (tab === 'cities') inner.innerHTML = UI.citiesPage(state);
    else if (tab === 'settings') inner.innerHTML = UI.settingsPage(state);
  }

  function markDirty(tab) {
    if (!state.dirty) state.dirty = {};
    state.dirty[tab] = true;
    if (state.tab === tab) {
      renderPage(tab);
      state.dirty[tab] = false;
    }
  }

  function activatePage(tab) {
    var pages = $$('.page');
    for (var i = 0; i < pages.length; i++) {
      var on = pages[i].getAttribute('data-page') === tab;
      pages[i].classList[on ? 'add' : 'remove']('is-active');
      if (on) {
        pages[i].classList.add('page-enter');
        var el = pages[i];
        setTimeout(function () { el.classList.remove('page-enter'); }, 900);
      }
    }
  }

  function switchTab(tab, force) {
    if (TABS.indexOf(tab) < 0) return;
    var changed = state.tab !== tab;
    state.tab = tab;
    if (changed || force || (state.dirty && state.dirty[tab])) { renderPage(tab); if (state.dirty) state.dirty[tab] = false; }
    // 只保留当前页的 DOM，避免隐藏页里的按钮/链接干扰测试与无障碍
    if (!state.dirty) state.dirty = {};
    for (var ti = 0; ti < TABS.length; ti++) {
      var other = TABS[ti];
      if (other === tab) continue;
      var oInner = pageInner(other);
      if (oInner) oInner.innerHTML = '';
      state.dirty[other] = true;
    }
    renderTabbar();
    activatePage(tab);
    setSky();
    if (tab === 'home' && !state.loading) animateRoll();
  }

  function renderAll() {
    if (!state.dirty) state.dirty = {};
    state.dirty.home = true;
    state.dirty.sources = true;
    state.dirty.cities = true;
    state.dirty.settings = true;
    renderPage(state.tab);
    state.dirty[state.tab] = false;
    renderTabbar();
    setSky();
    if (state.tab === 'home' && !state.loading) animateRoll();
  }

  function animateRoll() {
    var el = $('.hero__num');
    if (!el || !el.getAttribute) return;
    var target = parseFloat(el.getAttribute('data-roll'));
    if (!isFinite(target)) return;
    if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (state._rollRaf) { try { global.cancelAnimationFrame(state._rollRaf); } catch (e) {} state._rollRaf = null; }
    var start = 0;
    var dur = 760;
    var t0 = Date.now();
    function tick() {
      var p = Math.min(1, (Date.now() - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var v = start + (target - start) * eased;
      el.textContent = String(Math.round(v));
      if (p < 1) {
        state._rollRaf = global.requestAnimationFrame ? global.requestAnimationFrame(tick) : setTimeout(tick, 40);
      } else {
        el.textContent = String(Math.round(target));
        state._rollRaf = null;
      }
    }
    tick();
  }

  /* ======================================================================
   * 数据加载
   * ==================================================================== */

  function setLoading(on) {
    state.loading = !!on;
    markDirty('home');
    markDirty('sources');
  }

  function readCached() {
    try {
      var c = WH.cache.load();
      return c && c.results && c.results.length ? c : null;
    } catch (e) { return null; }
  }

  function buildAggregate(results, city, aqi) {
    try { return WH.aggregate.build(results, city, { aqi: aqi }); } catch (e) {
      try { WH.bridge.log('error', '聚合失败：' + (e && e.message)); } catch (e2) {}
      return null;
    }
  }

  function cityKey(c) {
    if (!c) return '';
    return String(c.name || '') + '@' + Number(c.lat).toFixed(3) + ',' + Number(c.lon).toFixed(3);
  }

  function refresh(opts) {
    opts = opts || {};
    if (state.loading) { state._pendingRefresh = true; return Promise.resolve(); }
    if (!state.city) state.city = defaultCity();
    var targetCity = state.city;
    var targetKey = cityKey(targetCity);
    setLoading(true);
    var ids = (state.settings && state.settings.enabledSources) || [];
    var t0 = Date.now();
    return WH.sources.fetchAll(targetCity, { ids: ids, timeoutMs: opts.timeoutMs || 15000, aqi: true }).then(function (all) {
      if (cityKey(state.city) !== targetKey) {
        // 城市在请求期间变了：丢弃旧结果
        state._pendingRefresh = true;
        return;
      }
      var aqi = all.aqi || null;
      state.results = all.results || [];
      state.aqi = aqi;
      state.fetchedAt = all.fetchedAt || Date.now();
      state.aggregate = buildAggregate(state.results, targetCity, aqi);
      state.error = '';
      if (!state.openSources || !Object.keys(state.openSources).length) {
        for (var oi = 0; oi < state.results.length; oi++) {
          if (state.results[oi].status === 'ok') { state.openSources[state.results[oi].id] = true; break; }
        }
      }
      state.cachedSavedAt = 0;
      try { WH.cache.save(targetCity, state.results); } catch (e) {}
      try {
        var okN = 0;
        for (var i = 0; i < state.results.length; i++) if (state.results[i].status === 'ok') okN++;
        WH.bridge.log('info', '刷新完成：' + okN + '/' + state.results.length + ' 源可用，耗时 ' + (Date.now() - t0) + 'ms');
      } catch (e) {}
    }).catch(function (err) {
      state.error = (err && (err.code || err.message)) || 'network';
      try { WH.bridge.log('error', '刷新失败：' + state.error); } catch (e) {}
      UI.showToast('刷新失败：' + UI.esc(state.error), 'error');
    }).then(function () {
      setLoading(false);
      markDirty('home');
      markDirty('sources');
      setSky();
      if (state.tab === 'home') animateRoll();
      scheduleAutoRefresh();
      if (state._pendingRefresh) {
        state._pendingRefresh = false;
        return refresh({ background: true });
      }
    });
  }

  function refreshSource(id) {
    if (!state.city || !id) return;
    UI.showToast('正在刷新 ' + id + '…');
    WH.sources.fetchOne(id, state.city).then(function (r) {
      var replaced = false;
      for (var i = 0; i < state.results.length; i++) {
        if (state.results[i].id === id) { state.results[i] = r; replaced = true; break; }
      }
      if (!replaced) state.results.push(r);
      state.aggregate = buildAggregate(state.results, state.city, state.aqi);
      try { WH.cache.save(state.city, state.results); } catch (e) {}
      markDirty('home');
      markDirty('sources');
      setSky();
      if (r.status === 'ok') UI.showToast('已更新 ' + id, 'ok');
      else UI.showToast(id + ' 刷新失败', 'error');
    }).catch(function () {
      UI.showToast(id + ' 刷新失败', 'error');
    });
  }

  /* ======================================================================
   * 定位
   * ==================================================================== */

  function persistCity(city) {
    if (!city) return;
    if (city.name) city.name = normalizeCityName(city.name);
    state.city = city;
    try {
      WH.cache.setLastCity(city);
      WH.cache.addSavedCity(city);
      state.savedCities = WH.cache.savedCities();
    } catch (e) {}
  }

  function cityMoved(oldCity, newCity) {
    if (!newCity) return false;
    if (!oldCity) return true;
    if (oldCity.source === 'search' && newCity.source !== 'gps') return false;
    var dLat = Math.abs(Number(oldCity.lat || 0) - Number(newCity.lat || 0));
    var dLon = Math.abs(Number(oldCity.lon || 0) - Number(newCity.lon || 0));
    return dLat > 0.05 || dLon > 0.05;
  }

  function locateAndRefresh() {
    if (!WH.location || !WH.location.autoDetect) { refresh(); return; }
    state.loading = true;
    markDirty('home');
    var city = defaultCity();
    WH.location.autoDetect().then(function (detected) {
      if (detected && detected.name) city = detected;
      persistCity(city);
      state.loading = false;
      return refresh();
    }).catch(function () {
      persistCity(city);
      state.loading = false;
      return refresh();
    });
  }

  function autoLocateInBackground() {
    if (!WH.location || !WH.location.autoDetect) return;
    WH.location.autoDetect().then(function (detected) {
      if (detected && detected.name && cityMoved(state.city, detected)) {
        persistCity(detected);
        refresh();
      } else if (detected && detected.name && (!state.city || state.city.source === 'default')) {
        persistCity(detected);
      }
    }).catch(function () {});
  }

  function useGps() {
    if (!WH.location || !WH.location.autoDetect) { UI.showToast('当前环境不支持定位', 'warn'); return; }
    UI.showToast('正在获取定位…');
    WH.location.autoDetect({ gpsTimeout: 14000 }).then(function (city) {
      if (!city || !city.name) { UI.showToast('定位失败，已保留当前城市', 'error'); return; }
      var same = !cityMoved(state.city, city);
      persistCity(city);
      renderPage('cities');
      if (city.source === 'gps' || city.source === 'ip') {
        UI.showToast('已定位到 ' + city.name + '（' + (city.source === 'gps' ? 'GPS' : 'IP') + '）', 'ok');
      } else {
        UI.showToast('定位不可用，已使用 ' + city.name, 'warn');
      }
      if (!same || !state.aggregate) refresh();
    }).catch(function () {
      UI.showToast('定位失败，请检查权限或网络', 'error');
    });
  }

  function chooseCity(city) {
    if (!city) return;
    var c = {};
    for (var k in city) { if (Object.prototype.hasOwnProperty.call(city, k)) c[k] = city[k]; }
    c.source = c.source || 'search';
    c.id = c.id || ('city-' + Number(c.lat).toFixed(3) + '-' + Number(c.lon).toFixed(3));
    persistCity(c);
    state.query = '';
    state.searchList = [];
    try { UI.closeSheet(); } catch (e) {}
    switchTab('home');
    refresh();
    UI.showToast('已切换到 ' + (c.name || '城市'), 'ok');
  }

  /* ======================================================================
   * 搜索
   * ==================================================================== */

  function renderCitiesFocus() {
    renderPage('cities');
    if (!state._searchFocused) return;
    var input = doc.getElementById('wh-search');
    if (!input) return;
    try {
      input.focus();
      var len = input.value.length;
      input.setSelectionRange(len, len);
    } catch (e) {}
  }

  function doSearch(q) {
    state.query = String(q || '');
    if (!state.query) {
      state.searchList = [];
      state.searchBusy = false;
      renderCitiesFocus();
      return;
    }
    state.searchBusy = true;
    renderCitiesFocus();
    if (!WH.location || !WH.location.search) {
      state.searchBusy = false;
      state.searchList = [];
      renderCitiesFocus();
      return;
    }
    WH.location.search(state.query).then(function (list) {
      state.searchList = Array.isArray(list) ? list : [];
      state.searchBusy = false;
      renderCitiesFocus();
    }).catch(function () {
      state.searchList = [];
      state.searchBusy = false;
      renderCitiesFocus();
    });
  }

  /* ======================================================================
   * 设置动作
   * ==================================================================== */

  function afterSettingsChange() {
    if (!state.dirty) state.dirty = {};
    state.dirty.home = true;
    state.dirty.sources = true;
    state.dirty.settings = true;
    switchTab(state.tab, true);
    scheduleAutoRefresh();
  }

  function toggleEnabledSource(id) {
    var list = (state.settings.enabledSources || []).slice();
    var idx = list.indexOf(id);
    if (idx >= 0) {
      if (list.length <= 1) { UI.showToast('至少保留一个数据源', 'warn'); return; }
      list.splice(idx, 1);
    } else {
      var meta = null;
      var metas = (WH.meta && WH.meta.sources) || [];
      for (var i = 0; i < metas.length; i++) if (metas[i].id === id) meta = metas[i];
      if (meta && meta.requiresKey) {
        var key = id === 'qweather' ? state.settings.qweatherKey : state.settings.owmKey;
        if (!key) { UI.showToast('请先在下方填入该平台的 API Key', 'warn'); return; }
      }
      list.push(id);
    }
    saveSettings({ enabledSources: list });
    afterSettingsChange();
    UI.showToast('数据源已更新，正在刷新…', 'ok');
    refresh();
  }

  function saveApiKey(id) {
    var input = doc.getElementById(id === 'qweather' ? 'wh-key-qweather' : 'wh-key-owm');
    var val = input ? String(input.value || '').trim() : '';
    var patch = {};
    if (id === 'qweather') patch.qweatherKey = val; else patch.owmKey = val;
    saveSettings(patch);
    var list = (state.settings.enabledSources || []).slice();
    if (val && list.indexOf(id) < 0) list.push(id);
    if (!val) {
      var idx = list.indexOf(id);
      if (idx >= 0) list.splice(idx, 1);
    }
    saveSettings({ enabledSources: list });
    afterSettingsChange();
    UI.showToast(val ? '已保存 Key 并启用平台' : '已清除 Key', 'ok');
    refresh();
  }

  function clearCache() {
    try { WH.cache.clear(); } catch (e) {}
    state.results = [];
    state.aggregate = null;
    state.aqi = null;
    state.fetchedAt = 0;
    state.cachedSavedAt = 0;
    UI.closeSheet();
    renderAll();
    UI.showToast('缓存已清除', 'ok');
    refresh();
  }

  function resetSettings() {
    try {
      if (WH.settings.reset) WH.settings.reset();
      else if (WH.settings.set) WH.settings.set({ unit: 'c', windUnit: 'kmh', enabledSources: ['cma', 'open-meteo', 'metno', 'wttr'], qweatherKey: '', owmKey: '', refreshMinutes: 10 });
    } catch (e) {}
    state.settings = loadSettings();
    afterSettingsChange();
    UI.showToast('已恢复默认设置', 'ok');
    refresh();
  }

  function saveKeyFromInputsIfFocused() {
    try {
      var q = doc.getElementById('wh-key-qweather');
      var o = doc.getElementById('wh-key-owm');
      var patch = {};
      if (q && q.value.trim() !== (state.settings.qweatherKey || '')) patch.qweatherKey = q.value.trim();
      if (o && o.value.trim() !== (state.settings.owmKey || '')) patch.owmKey = o.value.trim();
      if (patch.qweatherKey !== undefined || patch.owmKey !== undefined) saveSettings(patch);
    } catch (e) {}
  }

  /* ======================================================================
   * 自动刷新
   * ==================================================================== */

  function scheduleAutoRefresh() {
    if (state._autoTimer) { clearTimeout(state._autoTimer); state._autoTimer = null; }
    var mins = Number(state.settings && state.settings.refreshMinutes);
    if (!mins || mins <= 0) return;
    state._autoTimer = setTimeout(function () {
      if (doc.hidden) { scheduleAutoRefresh(); return; }
      if (!state.loading) refresh({ background: true });
      else scheduleAutoRefresh();
    }, mins * 60000);
  }

  /* ======================================================================
   * 事件
   * ==================================================================== */

  function findAct(e) {
    var node = e.target;
    while (node && node !== doc) {
      if (node.getAttribute && node.getAttribute('data-act')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function handleClick(e) {
    var tabItem = e.target && e.target.closest ? e.target.closest('.tabbar__item') : null;
    if (tabItem) {
      var tab = tabItem.getAttribute('data-tab');
      if (tab) { switchTab(tab); 
        if (tab === 'cities') { renderPage('cities'); }
        if (tab === 'settings') { renderPage('settings'); }
        return; }
    }
    var el = findAct(e);
    if (!el) {
      if (e.target && e.target.closest && !e.target.closest('.sheet')) UI.closeSheet();
      return;
    }
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id') || '';
    var idx = parseInt(el.getAttribute('data-idx') || '-1', 10);
    var v = el.getAttribute('data-v') || '';
    var url = el.getAttribute('data-url') || '';

    switch (act) {
      case 'refresh': refresh(); break;
      case 'retry': refresh(); break;
      case 'go-city': switchTab('cities'); renderPage('cities'); break;
      case 'go-settings': switchTab('settings'); renderPage('settings'); break;
      case 'retry-source': case 'refresh-source': refreshSource(id); break;
      case 'toggle-source':
        state.openSources[id] = !state.openSources[id];
        renderPage('sources');
        break;
      case 'open-url': if (url) { try { WH.bridge.openUrl(url); } catch (err) {} } break;
      case 'use-gps': useGps(); break;
      case 'pick-city':
        if (state.searchList && state.searchList[idx]) chooseCity(state.searchList[idx]);
        break;
      case 'pick-saved':
        if (state.savedCities && state.savedCities[idx]) chooseCity(state.savedCities[idx]);
        break;
      case 'pick-common':
        if (UI.COMMON_CITIES && UI.COMMON_CITIES[idx]) {
          var c = UI.COMMON_CITIES[idx];
          chooseCity({ id: 'common-' + c.name, name: c.name, admin: c.admin, country: c.country, lat: c.lat, lon: c.lon, timezone: c.timezone, cmaStationId: c.cmaStationId, source: 'search' });
        }
        break;
      case 'del-saved':
        if (state.savedCities && state.savedCities[idx]) {
          try { WH.cache.removeSavedCity(state.savedCities[idx].id || state.savedCities[idx]); } catch (err) {}
          state.savedCities = (function () { try { return WH.cache.savedCities(); } catch (err) { return []; } })();
          renderPage('cities');
          UI.showToast('已删除', 'ok');
        }
        break;
      case 'clear-search':
        state.query = '';
        state.searchList = [];
        state._searchFocused = true;
        renderCitiesFocus();
        break;
      case 'set-unit': saveSettings({ unit: v === 'f' ? 'f' : 'c' }); afterSettingsChange(); break;
      case 'set-wind': saveSettings({ windUnit: v === 'ms' ? 'ms' : 'kmh' }); afterSettingsChange(); break;
      case 'set-refresh': saveSettings({ refreshMinutes: Number(v) || 0 }); scheduleAutoRefresh(); renderPage('settings'); UI.showToast(Number(v) ? '自动刷新：每 ' + v + ' 分钟' : '自动刷新已关闭', 'ok'); break;
      case 'toggle-enabled': toggleEnabledSource(id); break;
      case 'save-key': saveKeyFromInputsIfFocused(); saveApiKey(id); break;
      case 'clear-cache':
        UI.showSheet({ title: '清除天气缓存？', desc: '将删除上次缓存的天气数据与上次城市，已保存城市列表与设置会保留。', actions: [{ label: '取消', cls: 'btn--ghost', act: 'close-sheet' }, { label: '清除', cls: 'btn--danger', act: 'confirm-clear' }] });
        break;
      case 'confirm-clear': clearCache(); break;
      case 'reset-settings':
        UI.showSheet({ title: '恢复默认设置？', desc: '单位、数据源、API Key、刷新间隔都会恢复初始值。', actions: [{ label: '取消', cls: 'btn--ghost', act: 'close-sheet' }, { label: '恢复', cls: 'btn--danger', act: 'confirm-reset' }] });
        break;
      case 'confirm-reset': UI.closeSheet(); resetSettings(); break;
      case 'close-sheet': UI.closeSheet(); break;
      default: break;
    }
  }

  function handleInput(e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'wh-search') {
      state._searchFocused = true;
      if (state._searchTimer) clearTimeout(state._searchTimer);
      var val = t.value;
      state._searchTimer = setTimeout(function () { doSearch(val); }, 320);
    }
  }

  function handleFocus(e) {
    var t = e.target;
    if (t && t.id === 'wh-search') { state._searchFocused = true; }
  }

  function handleBlur(e) {
    var t = e.target;
    if (t && t.id === 'wh-search') { state._searchFocused = false; }
  }

  /* 下拉刷新 */
  var ptr = { active: false, startY: 0, dist: 0, page: null };

  function pageOf(target) {
    var n = target;
    while (n && n !== doc) {
      if (n.classList && n.classList.contains('page')) return n;
      n = n.parentNode;
    }
    return null;
  }

  function onTouchStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    if (doc.getElementById('wh-sheet')) return;
    var page = pageOf(e.target);
    if (!page || page.scrollTop > 2) return;
    ptr.active = true;
    ptr.page = page;
    ptr.startY = e.touches[0].clientY;
    ptr.dist = 0;
  }

  function onTouchMove(e) {
    if (!ptr.active || !e.touches || e.touches.length !== 1) return;
    var y = e.touches[0].clientY - ptr.startY;
    if (y <= 0) {
      if (ptr.dist > 0) { ptr.dist = 0; UI.setPtr(0); }
      return;
    }
    if (ptr.page && ptr.page.scrollTop > 2) { ptr.active = false; UI.setPtr(0); return; }
    var dist = Math.min(130, y * 0.55);
    ptr.dist = dist;
    if (dist > 4) UI.setPtr(dist / 90);
  }

  function onTouchEnd() {
    if (!ptr.active) return;
    var trigger = ptr.dist >= 82;
    ptr.active = false;
    ptr.page = null;
    if (trigger && !state.loading) {
      UI.setPtr(1, 'spinning');
      refresh().then(function () { setTimeout(function () { UI.setPtr(0); }, 320); });
      UI.showToast('正在刷新…');
    } else {
      UI.setPtr(0);
    }
    ptr.dist = 0;
  }

  function bindEvents() {
    doc.addEventListener('click', handleClick, false);
    doc.addEventListener('input', handleInput, false);
    doc.addEventListener('focusin', handleFocus, false);
    doc.addEventListener('focusout', handleBlur, false);
    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchmove', onTouchMove, { passive: true });
    doc.addEventListener('touchend', onTouchEnd, { passive: true });
    doc.addEventListener('touchcancel', function () { ptr.active = false; UI.setPtr(0); }, { passive: true });
    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) return;
      var mins = Number(state.settings && state.settings.refreshMinutes) || 0;
      if (mins > 0 && state.fetchedAt && Date.now() - state.fetchedAt > mins * 60000 && !state.loading) refresh({ background: true });
      else scheduleAutoRefresh();
    }, false);
    if (global.addEventListener) {
      global.addEventListener('online', function () {
        if (!state.aggregate && !state.loading) refresh({ background: true });
      }, false);
    }
    global.__onBackPressed = function () {
      var sheet = doc.getElementById('wh-sheet');
      if (sheet) { UI.closeSheet(); return true; }
      if (state.tab !== 'home') { switchTab('home'); return true; }
      return false;
    };
    global.addEventListener('error', function (ev) {
      try { WH.bridge.log('error', 'JS错误：' + (ev && ev.message) + ' @' + (ev && ev.filename) + ':' + (ev && ev.lineno)); } catch (e) {}
    }, false);
  }

  /* ======================================================================
   * 启动
   * ==================================================================== */

  function boot() {
    var root = doc.getElementById('app');
    if (!root) { try { console.error('[WH] #app 不存在'); } catch (e) {} return; }
    root.innerHTML = UI.shell();
    state.settings = loadSettings();
    try { state.savedCities = WH.cache.savedCities(); } catch (e) { state.savedCities = []; }
    state.city = defaultCity();
    var cached = readCached();
    if (cached) {
      if (cached.city) state.city = cached.city;
      state.results = cached.results;
      state.fetchedAt = cached.fetchedAt;
      state.cachedSavedAt = cached.savedAt || cached.fetchedAt;
      state.aqi = null;
      state.aggregate = buildAggregate(state.results, state.city, null);
    }
    bindEvents();
    if (!state.dirty) state.dirty = {};
    state.dirty.home = true;
    state.dirty.cities = true;
    state.dirty.settings = true;
    switchTab('home', true);
    setSky();
    if (cached) {
      refresh();
      setTimeout(autoLocateInBackground, 600);
    } else {
      locateAndRefresh();
    }
    scheduleAutoRefresh();
    try { WH.bridge.log('info', 'App 启动：' + (state.city && state.city.name) + ' / 缓存=' + (cached ? '有' : '无')); } catch (e) {}
  }

  WH.app = {
    state: state,
    boot: boot,
    refresh: refresh,
    refreshSource: refreshSource,
    switchTab: switchTab,
    useGps: useGps,
    chooseCity: chooseCity,
    doSearch: doSearch
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, false);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
