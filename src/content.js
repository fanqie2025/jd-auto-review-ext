/**
 * 内容脚本：负责页面上的全部操作
 *   · 悬浮面板（开始 / 暂停）
 *   · 生成 ≥60 字评价（大模型，经后台调用）
 *   · 抓晒单图 → 重编码成真 JPEG → 注入 input[type=file] 上传
 *   · 打五星、点发表、翻下一单
 * 两条链路都支持：
 *   老：club.jd.com/myJdcomments/{myJdcomment.action, orderVoucher.action, saveCommentSuccess}
 *   新：comment.m.jd.com/pc-static/{center, publish}
 * 默认【试跑】：填字 + 打星 + 配图，但不点「发表」。
 *
 * ── 来源与致谢（改动请一并保留本段）────────────────────────────────────────
 * 本文件是老链路部分**移植自** charmingYouYou/JDAIAutoComment v8.6（MIT，© charmingYouYou）：
 *   老链路三条 URL（myJdcomment.action / orderVoucher.action / saveCommentSuccess）、
 *   商品名与 SKU 取 `.p-name a`、上传完成判据数 `img[src*="imageUpload"]`、
 *   正文框 `.f-textarea textarea`、五星 `.star5`，以及"一个按钮控制开始/暂停"的闭环交互。
 * 新评价中心的选择器**参考自** liu-ws/Haoping（好评）v0.1.0（MIT，© 2026 好评 contributors）：
 *   URL 判定 `pc-static/{center,publish}`、`.scoreBox-conter-score-star-box-item`、
 *   `.rate-publish-submit-button`。
 * 「填字要分块打字 + 填完读页面计数复核」的结论来自 Fzuim/jd-review-bot-skill 的踩坑记录。
 * 完整出处、许可原文与"哪些是原创"（以及逐条对应的**行号**）见仓库根 THIRD-PARTY-NOTICES.md。
 * 本项目仅供个人学习自用，禁止商用与自媒体转载。
 * ──────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';
  if (window.__JDAR_EXT_LOADED__) return;
  window.__JDAR_EXT_LOADED__ = true;

  const LOOP_KEY = 'JDAR_RUNNING';
  const DONE_KEY = 'JDAR_DONE_COUNT';
  /** 扩展版本：面板和日志里都显示，用来确认页面里跑的是不是最新脚本 */
  const EXT_VERSION = (function () {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  })();
  let CFG = Object.assign({}, window.JDAR_DEFAULTS || {});
  let running = false;
  let currentStep = null;
  let resumeAction = null;
  let CONTEXT_DEAD = false;   // 扩展被重新加载后，老页面里的脚本会失效
  let pendingReviewCount = 1; // 本次发表会产生几条评价（一个订单可能含多件商品）
  let MY_TAB = null;          // 本标签页 id（问后台拿）—— 用来做"一次只允许一个标签页在跑"
  let STOP_THIS_TAB = false;  // 本页已把运行权交出去，不再操作（避免两单同时提交）
  let $ = window.jQuery;

  const PACING = window.JDAR_PACING || {};
  /** 随机间隔：所有等待都走这里，绝不出现固定秒数 */
  const rnd = (a, b) => (PACING.randBetween ? PACING.randBetween(a, b) : (Number(a) || 0));
  /** 配置里节奏一律是【秒】，代码内部换算成毫秒（换算逻辑在 pacing.js，有单测） */
  const sec2ms = (v, dfltSec) => (PACING.sec2ms ? PACING.sec2ms(v, dfltSec) : (Number(v) || Number(dfltSec) || 0) * 1000);
  const msClick = () => rnd(sec2ms(CFG.clickDelayMinSec, 4), sec2ms(CFG.clickDelayMaxSec, 9));
  const msStep = () => rnd(sec2ms(CFG.stepDelayMinSec, 2), sec2ms(CFG.stepDelayMaxSec, 4));
  const msOrder = () => rnd(sec2ms(CFG.orderDelayMinSec, 25), sec2ms(CFG.orderDelayMaxSec, 60));
  /** 同一单内步骤之间的随机停顿 */
  const stepSleep = () => new Promise((r) => setTimeout(r, msStep()));

  /* ==================== 页面判定 ==================== */

  const isNewHost = () => /(^|\.)comment\.m\.jd\.com$/.test(location.hostname);
  const isNewPublishPage = () => isNewHost() && /\/pc-static\/publish/.test(location.pathname);
  const isNewCenterList = () => isNewHost() && /\/pc-static\/center/.test(location.pathname);
  const isOldListPage = () => /\/myJdcomments\/myJdcomment\.action/.test(location.pathname);
  const isOldSuccessPage = () => /\/myJdcomments\/saveCommentSuccess/.test(location.pathname);
  const isOldReviewPage = () => /\/myJdcomments\/orderVoucher/.test(location.pathname);

  /* ==================== 与后台通信 ==================== */

  function bg(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; reject(new Error('后台无响应（扩展可能被重新加载，刷新页面即可）')); }
      }, timeoutMs || 70000);
      try {
        chrome.runtime.sendMessage(Object.assign({ type: type }, payload || {}), function (resp) {
          if (done) return;
          done = true; clearTimeout(timer);
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            const m = lastErr.message || '扩展通道错误';
            // 扩展被「重新加载」后，老页面里的脚本就死了（chrome.* 全部失效）——
            // 这是最容易让人以为"点了没反应"的情况，必须说清楚。
            if (/context invalidated|Extension context|message port closed|Receiving end does not exist/i.test(m)) {
              CONTEXT_DEAD = true;
              setStatusText('扩展刚被重新加载过，本页面里的旧脚本已失效 —— 请按 F5 刷新本页面再试。', '#e4393c');
              console.warn('[京东自动评价] 扩展上下文已失效，需要刷新页面');
            }
            reject(new Error(m));
            return;
          }
          if (!resp) { reject(new Error('后台没有返回')); return; }
          if (resp.ok === false) { reject(new Error(resp.error || '后台报错')); return; }
          resolve(resp);
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  const storageGet = (k) => new Promise((r) => {
    try { chrome.storage.local.get(k, (o) => r(o ? o[k] : null)); } catch (e) { r(null); }
  });
  const storageSet = (o) => { try { chrome.storage.local.set(o); } catch (e) { /* ignore */ } };

  /* ==================== 日志（面板可见 + 落盘跨页续接 + 可导出） ==================== */

  const RUN_KEY = 'JDAR_RUN_PROFILE';
  let RUN_PROFILE = null;
  let displayLines = [];

  function log(level, msg, data) {
    const lineStr = window.JDAR_LOG
      ? window.JDAR_LOG.line(level, msg, data)
      : ('[' + level + '] ' + msg);
    try { console.log('[京东自动评价]', lineStr); } catch (e) { /* ignore */ }
    displayLines.push(lineStr);
    if (displayLines.length > 400) displayLines = displayLines.slice(-300);
    renderLog();
    try {
      chrome.runtime.sendMessage({
        type: 'log',
        entries: [{
          t: Date.now(),
          level: level,
          msg: String(msg == null ? '' : msg),
          data: window.JDAR_LOG ? window.JDAR_LOG.fmtData(data) : '',
          page: location.host + location.pathname
        }]
      }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* ignore */ }
  }
  const logInfo = (m, d) => log('info', m, d);
  const logWarn = (m, d) => log('warn', m, d);
  const logErr = (m, d) => log('error', m, d);

  function renderLog() {
    const el = document.getElementById('jdar-log');
    if (!el) return;
    el.textContent = displayLines.slice(-200).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  function logText() {
    return [
      '# 京东自动评价 · 日志导出',
      '# 时间：' + new Date().toLocaleString(),
      '# 页面：' + location.href,
      '# 模式：' + (CFG.dryRun ? '试跑（不提交）' : '真实提交') +
        ' / 文案来源=' + (CFG.textSource || 'offline') +
        ' / 单轮上限=' + (Number(CFG.maxPerRun) || 0) +
        (RUN_PROFILE ? ' / 快捷运行档=' + JSON.stringify(RUN_PROFILE) : ''),
      ''
    ].concat(displayLines).join('\n');
  }

  function downloadLog() {
    try {
      const blob = new Blob([logText()], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jdar-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 3000);
      updateStatus('日志已导出（看浏览器下载目录）', 'green');
    } catch (e) { updateStatus('导出日志失败：' + (e && e.message || e), '#e4393c'); }
  }

  function copyLog() {
    const txt = logText();
    const fallback = function () {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        updateStatus('日志已复制到剪贴板', 'green');
      } catch (e) { updateStatus('复制失败，请改用「下载」', '#e4393c'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { updateStatus('日志已复制到剪贴板', 'green'); }, fallback);
    } else { fallback(); }
  }

  // 把之前页面写下的日志读回来显示（评价流程会跨 club.jd.com / comment.m.jd.com 好几页）
  function loadPersistedLog() {
    return bg('getLog', { limit: 60 }, 8000).then(function (r) {
      const lines = (r.entries || []).map(function (e) {
        return window.JDAR_LOG ? window.JDAR_LOG.entryToLine(e) : (e.msg || '');
      });
      if (lines.length) {
        displayLines = lines.concat(['===== 本页 ' + location.host + location.pathname + ' =====']);
        renderLog();
      }
      logInfo('页面脚本已加载', { 版本: 'v' + EXT_VERSION, 页面: location.pathname });
      logInfo('页面载入', {
        url: location.href,
        mode: CFG.dryRun ? 'dry-run' : 'REAL-SUBMIT',
        maxPerRun: Number(CFG.maxPerRun) || 0,
        textSource: CFG.textSource || 'offline'
      });
    }).catch(function () { /* 读不到就算了，不影响流程 */ });
  }

  /* ---------- 运行档（模式 / 上限）与设置页配置的关系 ----------
     · 面板改的是「本次运行」：存 RUN_KEY，跨页面有效
     · 点面板「保存」才写回设置页配置，成为以后的默认
     · SAVED_MODE 记住设置页里的值，用来显示「与设置页一致 / 有未保存改动」 */

  let SAVED_MODE = null;

  function applyRunProfileToCfg() {
    if (!RUN_PROFILE || typeof RUN_PROFILE !== 'object') return;
    CFG.dryRun = !!RUN_PROFILE.dryRun;
    if (RUN_PROFILE.maxPerRun != null) CFG.maxPerRun = Number(RUN_PROFILE.maxPerRun) || 0;
  }

  function reloadConfig() {
    return bg('getConfig', {}, 10000).then(function (r) {
      const raw = Object.assign({}, (r && r.config) || {});
      if (PACING.migrateLegacyPacing && PACING.migrateLegacyPacing(raw)) {
        try { chrome.storage.local.set({ config: raw }); } catch (e) { /* ignore */ }
        logInfo('已把旧版「毫秒」节奏自动迁移为「秒」');
      }
      CFG = Object.assign({}, window.JDAR_DEFAULTS, raw);
      const fixed = PACING.sanitizePacing ? PACING.sanitizePacing(CFG, window.JDAR_DEFAULTS) : [];
      if (fixed.length) logWarn('节奏配置有问题，已自动纠正', { 项: fixed.join(',') });
      SAVED_MODE = { dryRun: !!CFG.dryRun, maxPerRun: Number(CFG.maxPerRun) || 0 };
      applyRunProfileToCfg();
    }).catch(function () { /* 读不到就沿用当前值 */ });
  }

  function renderModeLine() {
    const $sim = $('#jdar-mode button[data-mode="sim"]');
    const $real = $('#jdar-mode button[data-mode="real"]');
    if (!$sim.length) return;
    const isSim = !!CFG.dryRun;

    $sim.toggleClass('is-active', isSim).removeClass('is-real');
    $real.toggleClass('is-active', !isSim).toggleClass('is-real', !isSim);

    const capEl = document.getElementById('jdar-cap');
    if (capEl && document.activeElement !== capEl) capEl.value = String(Number(CFG.maxPerRun) || 0);

    const capNow = Number(CFG.maxPerRun) || 0;
    const dirty = !SAVED_MODE || SAVED_MODE.dryRun !== isSim || SAVED_MODE.maxPerRun !== capNow;
    const $d = $('#jdar-dirty');
    $d.text(dirty ? '本次：' + (isSim ? '模拟' : '真实') + ' · 上限 ' + (capNow ? capNow + ' 条评价' : '不限') +
      '　（改了未保存）' : '与设置页一致')
      .css('color', dirty ? '#b7791f' : '#6b727b');

    $('#jdar-modeinfo').text(isSim
      ? '模拟：只填正文/星级/图片，不点发表'
      : '真实：会点发表，评价不可撤销');
  }

  function loadRunProfile() {
    return storageGet(RUN_KEY).then(function (p) {
      if (p && typeof p === 'object') {
        RUN_PROFILE = p;
        applyRunProfileToCfg();
        logInfo('沿用上次的运行档', p);
      }
    });
  }

  /* ==================== 基础工具 ==================== */

  function countChars(s) { return String(s || '').replace(/\s+/g, '').length; }

  function padToMinChars(text) {
    const min = Number(CFG.minReviewChars) || 60;
    const tail = CFG.fallbackTail;
    let out = String(text || '').trim();
    let guard = 0;
    while (countChars(out) < min && guard < 4) {
      out = out.replace(/[。！!？?，,；;]*$/, '') + '。' + tail;
      guard++;
    }
    return out;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ==================== 面板 UI ==================== */

  function createUI() {
    const html = '' +
      '<div id="jdar-ui">' +
      '  <div class="jdar-head" id="jdar-title">' +
      '    <span class="jdar-dot"></span>' +
      '    <span class="jdar-title">京东自动评价</span>' +
      '    <span class="jdar-tag">v' + EXT_VERSION + ' · 测试版</span>' +
      '    <button type="button" class="jdar-headbtn jdar-star" id="jdar-star" title="觉得好用？到 GitHub 给个 Star ⭐">⭐</button>' +
      '    <button type="button" class="jdar-headbtn" id="jdar-open-opt" title="打开扩展设置页">设置</button>' +
      '  </div>' +
      '  <div class="jdar-body">' +
      '  <div class="jdar-row">' +
      '    <span class="jdar-label">模式</span>' +
      '    <div class="jdar-seg" id="jdar-mode">' +
      '      <button type="button" data-mode="sim">模拟</button>' +
      '      <button type="button" data-mode="real">真实</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="jdar-row">' +
      '    <span class="jdar-label">上限</span>' +
      '    <input type="number" class="jdar-cap" id="jdar-cap" min="0" max="99" step="1" value="5" title="本次最多发表几条评价，0 = 不限" />' +
      '    <span class="jdar-unit">条评价（0 = 不限）</span>' +
      '    <span style="flex:1 1 auto"></span>' +
      '    <button type="button" class="jdar-btn jdar-sm" id="jdar-save">保存</button>' +
      '  </div>' +
      '  <div class="jdar-meta" id="jdar-dirty" style="margin:-4px 0 10px"></div>' +
      '  <div class="jdar-meta" id="jdar-modeinfo"></div>' +
      '  <div class="jdar-meta" id="jdar-pacing"></div>' +
      '  <button type="button" class="jdar-btn jdar-primary jdar-block" id="jdar-btn-toggle">开始</button>' +
      '  <div style="height:10px"></div>' +
      '  <div id="jdar-status">状态：等待页面加载...</div>' +
      '  <div class="jdar-logbar">' +
      '    <span class="jdar-label">日志</span>' +
      '    <span style="flex:1 1 auto"></span>' +
      '    <button type="button" class="jdar-link" id="jdar-log-toggle">收起</button>' +
      '    <button type="button" class="jdar-link" id="jdar-log-copy">复制</button>' +
      '    <button type="button" class="jdar-link" id="jdar-log-save">下载</button>' +
      '    <button type="button" class="jdar-link" id="jdar-log-clear">清空</button>' +
      '  </div>' +
      '  <pre id="jdar-log"></pre>' +
      '  </div>' +
      '</div>';
    $('body').append(html);
    applyPanelPos();
    applyPanelTheme();
    makeDraggable($('#jdar-ui'));

    $('#jdar-btn-toggle').on('click', function () {
      if (running) {
        setRunning(false);
        updateStatus('⏸ 已暂停：当前步骤做完就停。', '#e8a33d');
      } else {
        if (!checkConfig()) return;
        setRunning(true);
        storageSet({ [DONE_KEY]: 0 });       // 新的一轮，重新计条数
        resetSkipState();                    // 跳过记录也清零
        logInfo('点击开始', {
          模式: CFG.dryRun ? '模拟' : '真实',
          上限: Number(CFG.maxPerRun) || 0,
          文案来源: CFG.textSource || 'offline'
        });
        renderPacingLine();
        renderModeLine();
        updateStatus('▶ 开始执行...', 'blue');
        const fn = resumeAction || currentStep;
        resumeAction = null;
        if (fn) fn();
      }
    });

    // 模式：只有「模拟 / 真实」两个
    $('#jdar-mode').on('click', 'button', function (e) {
      e.preventDefault();
      setMode($(this).attr('data-mode') === 'sim');
    });
    // 上限条数：面板里直接填
    $('#jdar-cap').on('change', function () { setCap(this.value); });
    // 保存：把「模式 + 上限」写回设置页（作为以后默认）
    $('#jdar-save').on('click', function () {
      saveRunToConfig().then(function (ok) {
        if (ok) {
          updateStatus('✅ 已保存为默认：' + (CFG.dryRun ? '模拟' : '真实') +
            ' · 上限 ' + ((Number(CFG.maxPerRun) || 0) ? (CFG.maxPerRun + ' 单') : '不限'), 'green');
        } else {
          updateStatus('保存失败（读不到设置），请到设置页里改。', '#e4393c');
        }
        renderModeLine();
      });
    });

    $('#jdar-log-toggle').on('click', function (e) {
      e.preventDefault();
      const el = document.getElementById('jdar-log');
      if (!el) return;
      const hidden = el.classList.toggle('is-hidden');
      $(this).text(hidden ? '展开' : '收起');
    });
    $('#jdar-log-copy').on('click', function (e) { e.preventDefault(); copyLog(); });
    $('#jdar-log-save').on('click', function (e) { e.preventDefault(); downloadLog(); });
    $('#jdar-log-clear').on('click', function (e) {
      e.preventDefault();
      displayLines = [];
      renderLog();
      bg('clearLog', {}, 8000).catch(function () { /* ignore */ });
      updateStatus('日志已清空', 'green');
    });
    $('#jdar-open-opt').on('mousedown', function (e) { e.stopPropagation(); });   // 别触发拖面板
    $('#jdar-open-opt').on('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openOptionsPage();
    });
    $('#jdar-star').on('mousedown', function (e) { e.stopPropagation(); });
    $('#jdar-star').on('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openRepoPage('');
    });
    renderToggleBtn();
  }

  /* ---------- 模式 / 上限 / 保存（面板上的三个可操作项） ----------
     语义：面板改的是「本次运行」（跨页面有效，存 RUN_KEY）；
     点「保存」才写回设置页配置，成为以后的默认。 */

  function persistRunState() {
    RUN_PROFILE = { dryRun: !!CFG.dryRun, maxPerRun: Number(CFG.maxPerRun) || 0, at: Date.now() };
    storageSet({ [RUN_KEY]: RUN_PROFILE });
  }

  function setMode(wantSim, silent) {
    const dry = !!wantSim;
    if (!dry && !silent) {
      if (!window.confirm('切到「真实」：跑起来会真的发表评价，京东评价发布后不能修改。\n\n确定吗？')) {
        renderModeLine();
        return;
      }
    }
    CFG.dryRun = dry;
    persistRunState();
    renderModeLine();
    renderPacingLine();
    logInfo('模式改为', { 模式: dry ? '模拟' : '真实' });
    if (!silent) {
      updateStatus(dry ? '模式：模拟（只填不提交）' : '模式：真实（会真的发表）', dry ? 'blue' : '#e4393c');
    }
  }

  function setCap(n) {
    let v = Number(n);
    if (!isFinite(v) || v < 0) v = 0;
    v = Math.min(99, Math.floor(v));
    CFG.maxPerRun = v;
    persistRunState();
    renderModeLine();
    renderPacingLine();
    logInfo('上限条数改为', v ? (v + ' 单') : '不限');
  }

  /** 把面板上的「模式 + 上限」写回设置页配置（合并，不动其它字段） */
  function saveRunToConfig() {
    return new Promise(function (res) {
      try {
        chrome.storage.local.get('config', function (o) {
          const cfg = Object.assign({}, (o && o.config) || {});
          cfg.dryRun = !!CFG.dryRun;
          cfg.maxPerRun = Number(CFG.maxPerRun) || 0;
          chrome.storage.local.set({ config: cfg }, function () {
            if (chrome.runtime.lastError) { res(false); return; }
            SAVED_MODE = { dryRun: cfg.dryRun, maxPerRun: cfg.maxPerRun };
            logInfo('已保存为默认', { 模式: cfg.dryRun ? '模拟' : '真实', 上限: cfg.maxPerRun });
            res(true);
          });
        });
      } catch (e) { res(false); }
    });
  }

  /** 打开扩展设置页（面板标题栏的「设置」按钮）—— 必须让后台去开，内容脚本没这个 API */
  function openOptionsPage() {
    const fail = function (why) {
      logWarn('打开设置页失败', why || '');
      updateStatus('打不开设置页：点浏览器工具栏上的扩展图标，或到 chrome://extensions 点本扩展的「扩展选项」。', '#e4393c');
    };
    try {
      chrome.runtime.sendMessage({ type: 'openOptions' }, function (resp) {
        if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message); return; }
        if (!resp || resp.ok !== true) { fail(resp && resp.error); return; }
        logInfo('已请求后台打开设置页');
      });
    } catch (e) { fail(String(e && e.message || e)); }
  }

  /**
   * 打开项目在 GitHub 上的页面（面板标题栏的「⭐ Star」）。
   * 为什么必须交给后台开：① 内容脚本没有 chrome.tabs；② 页面的 window.open 被我们换成了原地跳转，
   * 自己开标签页会变成"把京东页面顶掉"。后台只放行白名单里的地址，不是一个任意跳转的口子。
   */
  const REPO_URL = 'https://github.com/fanqie2025/jd-auto-review-ext';
  function openRepoPage(what) {
    const url = what ? (REPO_URL + what) : REPO_URL;
    try {
      chrome.runtime.sendMessage({ type: 'openUrl', url: url }, function (resp) {
        if (chrome.runtime.lastError) {
          logWarn('打开 GitHub 失败', chrome.runtime.lastError.message);
          updateStatus('打开 GitHub 失败，手动访问：' + REPO_URL, '#b7791f');
          return;
        }
        if (!resp || resp.ok !== true) {
          logWarn('打开 GitHub 被拒', (resp && resp.error) || '');
          updateStatus('打开 GitHub 失败，手动访问：' + REPO_URL, '#b7791f');
          return;
        }
        logInfo('已在新标签页打开 GitHub', { url: url });
        updateStatus('⭐ 谢谢！新标签页已打开 GitHub —— 右上角点一下 Star 就行。', 'green');
      });
    } catch (e) {
      logWarn('打开 GitHub 抛错', String(e && e.message || e));
      updateStatus('打开 GitHub 失败，手动访问：' + REPO_URL, '#b7791f');
    }
  }

  /* ---------- 运行权（lease）：同一时刻只允许一个标签页在跑 ----------
     为什么必须有：点「去评价」如果开在新标签页，老标签页会以为"没跳转"继续点下一个，
     结果多个发布页同时在跑 —— 表现就是"两单一起打开、同时上传、同时提交"。
     规则：谁拿到 lease 谁才是"驱动页"；其他页只显示面板、不操作。
     驱动页每 10 秒续约，30 秒没续约视为失效（驱动页被关了），其他页可接管。 */

  const LEASE_KEY = 'JDAR_LEASE';   // { slots: { tabId: 心跳时间 } }
  const LEASE_TTL = 30000;
  let leaseTimer = null;

  /** 允许几个标签页同时跑（设置页「后台并发」，默认 1） */
  function leaseLimit() { return Math.max(1, Number(CFG.maxConcurrent) || 1); }

  function tryAcquireLease() {
    return new Promise(function (res) {
      try {
        chrome.storage.local.get(LEASE_KEY, function (o) {
          const cur = (o && o[LEASE_KEY]) || {};
          const slots = cur.slots || {};
          const now = Date.now();
          const r = PACING.leaseSlots
            ? PACING.leaseSlots(slots, MY_TAB, now, LEASE_TTL, leaseLimit())
            : { verdict: (Object.keys(slots).length < 1 ? 'take' : 'wait'), live: slots };
          if (r.verdict === 'wait') { res(false); return; }
          const next = Object.assign({}, r.live || {});
          next[String(MY_TAB)] = now;
          chrome.storage.local.set({ [LEASE_KEY]: { slots: next } }, function () {
            if (r.verdict === 'take') {
              logInfo('取得运行权', { 本页tabId: MY_TAB, 当前并发: Object.keys(next).length, 并发上限: leaseLimit() });
            }
            res(true);
          });
        });
      } catch (e) { res(true); }   // 读不到就放行，别把功能卡死
    });
  }

  function renewLease() {
    try {
      chrome.storage.local.get(LEASE_KEY, function (o) {
        const cur = (o && o[LEASE_KEY]) || {};
        const slots = Object.assign({}, cur.slots || {});
        const now = Date.now();
        slots[String(MY_TAB)] = now;
        Object.keys(slots).forEach(function (k) {      // 顺手清掉过期槽位
          if (now - Number(slots[k]) > LEASE_TTL) delete slots[k];
        });
        chrome.storage.local.set({ [LEASE_KEY]: { slots: slots } });
      });
    } catch (e) { /* ignore */ }
  }

  function releaseLease() {
    try {
      chrome.storage.local.get(LEASE_KEY, function (o) {
        const cur = (o && o[LEASE_KEY]) || {};
        const slots = Object.assign({}, cur.slots || {});
        delete slots[String(MY_TAB)];
        chrome.storage.local.set({ [LEASE_KEY]: { slots: slots } });
      });
    } catch (e) { /* ignore */ }
  }

  function startLeaseTimer() {
    if (leaseTimer) return;
    leaseTimer = setInterval(function () { if (running && !STOP_THIS_TAB) renewLease(); }, 10000);
  }

  /** 我是不是驱动页？不是就只显示不操作，并轮询等待接管 */
  function canDrive(cb) {
    if (STOP_THIS_TAB) { cb(false); return; }
    tryAcquireLease().then(function (yes) {
      if (!yes) {
        setStatusText('已有 ' + leaseLimit() + ' 个标签页在跑（并发上限），本页只显示、不操作、不提交。', '#b7791f');
        startFollowerWatch();
        cb(false);
        return;
      }
      startLeaseTimer();
      cb(true);
    });
  }

  function startFollowerWatch() {
    if (window.__JDAR_FOLLOW__) return;
    window.__JDAR_FOLLOW__ = true;
    let tries = 0;
    const iv = setInterval(function () {
      tries++;
      if (!running || STOP_THIS_TAB) { clearInterval(iv); window.__JDAR_FOLLOW__ = false; return; }
      if (tries > 12) {                       // ~30 秒还没轮到我
        clearInterval(iv);
        window.__JDAR_FOLLOW__ = false;
        setStatusText('另一个标签页正在跑这一轮，本页保持不操作。想在本页跑就刷新本页。', '#b7791f');
        return;
      }
      tryAcquireLease().then(function (yes) {
        if (!yes) return;
        clearInterval(iv);
        window.__JDAR_FOLLOW__ = false;
        logInfo('接管运行权，继续跑', { 本页tabId: MY_TAB });
        dispatch();
      });
    }, 2500);
  }

  /* 说明：以前这里有个 yieldToOtherTab()——点了卡片没跳转就交出运行权、本页停手。
     问题是「外卖单 / 服务单」点不动时就没人接手，整轮就这么停在那儿。
     现在换成 handleListClickFailed()：先让权，8 秒没人接手就当作"这点不进去"跳过、继续跑。
     真正防"两单同时提交"的仍然是发布页的 canDrive() 检查，这里让权不影响那个保护。 */

  /* ---------- 面板位置：默认左下角，可拖动，位置记住 ----------
     原来固定在右上角，正好压住新评价中心右侧那一列「去评价」按钮 —— 用户点不到、我也点不到。 */

  const POS_KEY = 'JDAR_PANEL_POS';

  /* ---------- 面板配色：跟页面 / 浅色 / 深色 ----------
     京东页面是白底，深色面板太突兀，所以默认「跟页面走」（浅底→浅色面板）。 */

  function pageIsDark() {
    try {
      const bgOf = function (el) {
        if (!el) return '';
        return window.getComputedStyle(el).backgroundColor || '';
      };
      const parse = function (s) {
        const m = String(s || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return null;
        const p = m[1].split(',').map(function (x) { return parseFloat(x); });
        if (p.length < 3 || !isFinite(p[0])) return null;
        const a = (p.length > 3 && isFinite(p[3])) ? p[3] : 1;
        return { r: p[0], g: p[1], b: p[2], a: a };
      };
      let c = parse(bgOf(document.body));
      if (!c || c.a < 0.2) c = parse(bgOf(document.documentElement));
      if (!c) return false;
      const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
      return lum < 0.5;
    } catch (e) { return false; }
  }

  function applyPanelTheme() {
    const $ui = $('#jdar-ui');
    if (!$ui.length) return;
    const mode = CFG.panelTheme || 'auto';
    const dark = (mode === 'dark') || (mode === 'auto' && pageIsDark());
    $ui.toggleClass('jdar-dark', dark);
  }

  function applyPanelPos() {
    storageGet(POS_KEY).then(function (p) {
      if (!p || typeof p !== 'object') return;
      const $ui = $('#jdar-ui');
      if (!$ui.length) return;
      const left = Math.max(0, Math.min(Math.max(0, window.innerWidth - 160), Number(p.left) || 16));
      const top = Math.max(0, Math.min(Math.max(0, window.innerHeight - 80), Number(p.top) || 16));
      $ui.css({ left: left + 'px', top: top + 'px', bottom: 'auto', right: 'auto' });
    });
  }

  function makeDraggable($panel) {
    if (!$panel.length) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    $panel.on('mousedown', '#jdar-title', function (e) {
      const r = $panel[0].getBoundingClientRect();
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      $panel.css({ left: r.left + 'px', top: r.top + 'px', bottom: 'auto', right: 'auto' });
      e.preventDefault();
    });
    $(document).on('mousemove.jdarDrag', function (e) {
      if (!dragging) return;
      const nl = Math.max(0, Math.min(Math.max(0, window.innerWidth - 140), ox + (e.clientX - sx)));
      const nt = Math.max(0, Math.min(Math.max(0, window.innerHeight - 50), oy + (e.clientY - sy)));
      $panel.css({ left: nl + 'px', top: nt + 'px' });
    });
    $(document).on('mouseup.jdarDrag', function () {
      if (!dragging) return;
      dragging = false;
      const r = $panel[0].getBoundingClientRect();
      storageSet({ [POS_KEY]: { left: Math.round(r.left), top: Math.round(r.top) } });
    });
  }

  function renderToggleBtn() {
    const $b = $('#jdar-btn-toggle');
    if (!$b.length) return;
    $b.text(running ? '暂停' : '开始').toggleClass('is-running', !!running);
  }

  function renderPacingLine() {
    const $p = $('#jdar-pacing');
    if (!$p.length) return;
    const dur = (ms) => (PACING.humanDuration ? PACING.humanDuration(ms) : Math.round((Number(ms) || 0) / 1000) + ' 秒');
    const mc = Number(CFG.maxConcurrent) || 1;
    $p.text('节奏（设置页）：每步 ' + dur(sec2ms(CFG.clickDelayMinSec, 4)) + '~' + dur(sec2ms(CFG.clickDelayMaxSec, 9)) +
      ' · 首单不等 · 两单之间 ' + dur(sec2ms(CFG.orderDelayMinSec, 25)) + '~' + dur(sec2ms(CFG.orderDelayMaxSec, 60)) +
      ' · 并发 ' + mc + (mc > 1 ? '（已开并发 ⚠ 风险）' : '（关闭）') +
      (CFG.riskStop ? ' · 遇风控停手' : ''));
  }

  function updateStatus(text, color) {
    $('#jdar-status').text('状态：' + text).css('color', color || '#666');
    // 状态栏的每一句话同时进日志（红色=error，橙色=warn，其余=info），省得漏记
    const lv = (color === '#e4393c') ? 'error' : (color === '#f0ad4e' ? 'warn' : 'info');
    log(lv, text);
  }

  function setRunning(v) {
    running = v;
    storageSet({ [LOOP_KEY]: v });
    if (!v) releaseLease();          // 停了就把运行权交出去
    renderToggleBtn();
  }

  /* ---------- 单轮限单：到量自动停，避免一口气刷完 ---------- */

  function getDoneCount() {
    return new Promise(function (res) {
      try { chrome.storage.local.get(DONE_KEY, function (o) { res((o && o[DONE_KEY]) || 0); }); }
      catch (e) { res(0); }
    });
  }

  function bumpDone(by) {
    const n = Math.max(1, Number(by) || 1);   // 一个订单可能含多件商品 → 一次发表产出多条评价
    try {
      chrome.storage.local.get(DONE_KEY, function (o) {
        chrome.storage.local.set({ [DONE_KEY]: ((o && o[DONE_KEY]) || 0) + n });
      });
    } catch (e) { /* ignore */ }
  }

  /** 上限就是「本轮已发几条评价」，到量就停（新评价中心一单一件商品，老评价页一页可能多件） */
  function capReached(cb) {
    const max = Number(CFG.maxPerRun) || 0;
    if (!max) { cb(false); return; }
    getDoneCount().then(function (n) {
      if (n >= max) {
        setRunning(false);
        updateStatus('🛑 已达上限（已发 ' + n + ' 条 / 上限 ' + max + ' 条），停手。' +
          '要再跑就点「开始」（会重新计一轮）。', '#e4393c');
        logWarn('发表前拦下：已达条数上限', { 已发评价: n, 上限: max });
        cb(true);
        return;
      }
      cb(false);
    });
  }

  function checkRunLimit(onOk) {
    const max = Number(CFG.maxPerRun) || 0;
    getDoneCount().then(function (n) {
      if (max && n >= max) {
        setRunning(false);
        updateStatus('🛑 本轮已发 ' + n + ' 条评价（上限 ' + max + ' 条），已自动停下。' +
          '建议隔几小时或隔夜再跑，别一口气刷完。', '#e4393c');
        logWarn('触发条数上限', { 已发评价: n, 上限: max });
        return;
      }
      if (max) updateStatus('本轮进度 ' + n + '/' + max + ' 条评价。', 'blue');
      onOk(n);   // 把「本轮已发几条」交给调用方：首单不该套用"两单之间休息"
    });
  }

  /** 两单之间的等待：首单用普通点击间隔，之后才用长休息 */
  function orderGapText(done) {
    const first = !done;
    const gap = first ? msClick() : msOrder();
    const dur = PACING.humanDuration ? PACING.humanDuration(gap) : Math.round(gap / 1000) + ' 秒';
    return { gap: gap, dur: dur, first: first };
  }

  function haltIfPaused(resumeFn) {
    if (!running) {
      resumeAction = resumeFn;
      updateStatus('⏸ 已暂停。点「开始」从当前步骤继续。', '#e4393c');
      return true;
    }
    return false;
  }

  function checkConfig() {
    const mode = CFG.textSource || 'offline';
    if (mode === 'ai' && (!CFG.apiKey || !String(CFG.apiKey).trim())) {
      updateStatus('❌ 文案来源选的是「只用 AI」，但还没填 API 密钥：点面板上的「设置」填一次。', '#e4393c');
      return false;
    }
    return true;
  }

  /* ==================== 点击相关 ==================== */

  function $clickableByText(text, contains) {
    return $('a, button, span, div, input').filter(':visible').filter(function () {
      const $t = $(this);
      const raw = $t.is('input') ? ($t.val() || '') : $t.clone().children().remove().end().text();
      const t = (raw || '').trim();
      return contains ? t.indexOf(text) !== -1 : t === text;
    });
  }

  function forceSameTabNav(el) {
    let node = el;
    while (node && node !== document.body) {
      const tag = node.tagName;
      if (tag === 'A' || tag === 'FORM') node.setAttribute('target', '_self');
      node = node.parentNode;
    }
  }

  /* ---------- 把 window.open 换成"原地跳转"（持久安装） ----------
     为什么必须这么做：扩展发出的点击不是"用户手势"，页面里任何 window.open（包括
     点击后异步调的）都会被 Chrome 弹窗拦截器挡掉 —— 地址栏右侧出现"已拦截弹窗"图标，
     表现就是"点了没反应"。所以我们在页面里提前把 window.open 换掉：
     页面照样拿到一个窗口句柄（不会因为拿到 null 报错），但最终都变成当前页跳转。 */

  let OPEN_GUARDED = false;
  let ORIG_OPEN = null;

  function fakeWindow(target) {
    const url = target || '';
    const loc = {
      href: url,
      replace: function (u) { location.href = u || url; },
      assign: function (u) { location.href = u || url; },
      reload: function () { location.reload(); },
      toString: function () { return url; }
    };
    const win = {
      closed: false,
      close: function () { },
      focus: function () { },
      blur: function () { },
      print: function () { },
      postMessage: function () { },
      document: document,
      name: '',
      opener: null
    };
    try {
      Object.defineProperty(win, 'location', {
        get: function () { return loc; },
        set: function (v) { location.href = (v && v.href) || v || url; },
        configurable: true
      });
    } catch (e) { win.location = loc; }
    return win;
  }

  function installOpenGuard() {
    // 正常情况：src/openguard.js 已经在 document_start 装好了 —— 必须那么早，
    // 否则拦不住页面在启动时缓存起来的原生 window.open 引用（2026-10-09 实测：晚了就每单开一个新标签页）。
    // 这里只登记一个日志回调，让"拦到 window.open"这件事也能进面板日志。
    if (window.__JDAR_OPEN_GUARD__) {
      window.__JDAR_ON_OPEN__ = function (target) {
        logInfo('拦到 window.open，改成原地跳转', {
          url: window.JDAR_LOG ? window.JDAR_LOG.tail(String(target), 80) : String(target)
        });
      };
      return;
    }
    if (OPEN_GUARDED) return;
    if (CFG.blockPopups === false) { uninstallOpenGuard(); return; }
    try {
      ORIG_OPEN = window.open;
      window.open = function (url) {
        const target = url || '';
        logInfo('拦到 window.open，改成原地跳转', {
          url: window.JDAR_LOG ? window.JDAR_LOG.tail(String(target), 80) : String(target)
        });
        if (target) setTimeout(function () { try { location.href = target; } catch (e) { } }, 0);
        return fakeWindow(target);
      };
      OPEN_GUARDED = true;
      logInfo('已安装弹窗拦截（window.open → 原地跳转）');
    } catch (e) { /* ignore */ }
  }

  function uninstallOpenGuard() {
    // 必须还原成**原生** open：openguard.js 把原生引用存在 __JDAR_NATIVE_OPEN__ 里。
    // 否则这里会把我们自己的假 open 当成"原生"还原回去，设置页那个开关就失效了。
    try {
      const native = window.__JDAR_NATIVE_OPEN__ || ORIG_OPEN;
      if (native) window.open = native;
      window.__JDAR_OPEN_GUARD__ = false;
    } catch (e) { /* ignore */ }
    OPEN_GUARDED = false;
  }

  function withOpenGuard(fn) {
    installOpenGuard();
    fn();
  }

  function autoClickAfter(getEl, label, delay, onNotFound) {
    delay = (delay == null) ? msClick() : delay;
    let remain = Math.ceil(delay / 1000);
    if (remain > 0) updateStatus(label + '：' + remain + ' 秒后自动点击...', 'blue');

    const timer = setInterval(function () {
      remain--;
      if (remain > 0) setStatusText(label + '：' + remain + ' 秒后自动点击...', 'blue');
    }, 1000);

    setTimeout(function () {
      clearInterval(timer);
      if (haltIfPaused(function () { autoClickAfter(getEl, label, 0, onNotFound); })) return;
      const $el = getEl();
      if ($el && $el.length > 0) {
        updateStatus(label + '：已自动点击 ✅', 'green');
        try {
          forceSameTabNav($el[0]);
          withOpenGuard(function () { $el[0].click(); });
        } catch (e) {
          updateStatus('单标签导航中和失败，退回普通点击：' + e, 'red');
          $el[0].click();
        }
      } else {
        updateStatus(label + '：没找到可点的元素，流程已停。', 'red');
        if (onNotFound) onNotFound();
      }
    }, delay);
  }

  /* ==================== 打字 / 风控（慢，但稳） ==================== */

  // 读页面自己的字数计数（新版「已写94个字」/ 老版「0 / 500」）；读不到返回 null
  function readPageCounter(scopeEl) {
    let scope = document.body;
    try {
      if (scopeEl && scopeEl.closest) {
        scope = scopeEl.closest('.rate-comment, .f-textarea, .comment-form, form') || document.body;
      }
    } catch (e) { scope = document.body; }
    return PACING.parseCountText ? PACING.parseCountText((scope && scope.innerText) || '') : null;
  }

  // 页面是否出现风控/维护提示（评价区被软封的原文签名）
  function riskDetected(scopeEl) {
    if (!CFG.riskStop) return false;
    if (!PACING.looksLikeRiskControl) return false;
    let scope = document.body;
    try {
      if (scopeEl && scopeEl.closest) {
        scope = scopeEl.closest('.rate-comment, .f-textarea, .comment-form, form') || document.body;
      }
    } catch (e) { scope = document.body; }
    return PACING.looksLikeRiskControl(((scope && scope.innerText) || '').slice(0, 4000));
  }

  function stopForRisk(where) {
    setRunning(false);
    updateStatus('🛑 ' + (where || '页面') + '出现风控/维护提示，已立刻停手。' +
      '⚠️ 千万别反复重试（重试只会延长封锁），隔几小时或隔夜再跑。', '#e4393c');
  }

  // 一次性赋值 + 事件（新版评价中心实测可用）
  function setValueOnce(el, text) {
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 分块「打字」：execCommand('insertText') 逐块插入，触发真实 input 事件
  function typeInChunks(el, text, onDone) {
    const chunks = PACING.splitChunks ? PACING.splitChunks(text, 6, 14) : [text];
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    let i = 0;
    const next = function () {
      if (i >= chunks.length) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (onDone) onDone();
        return;
      }
      const chunk = chunks[i++];
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, chunk); } catch (e) { inserted = false; }
      if (!inserted) {
        el.value += chunk;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (i % 3 === 0 || i === chunks.length) {
        updateStatus('正在像人一样逐字输入… ' + Math.round((i / chunks.length) * 100) + '%', 'blue');
      }
      setTimeout(next, rnd(80, 260));
    };
    next();
  }

  /**
   * 填正文，并且【确认页面认账】：
   *   ① 先一次性赋值（快）→ ② 读页面自己的字数计数，对不上就改成分块打字重填
   * 两种方式都填不进（计数仍是 0）时会明确报出来，交人工处理，不会闷头提交。
   */
  function fillReview(el, text, onDone) {
    const len = countChars(text);
    setValueOnce(el, text);

    const counter = readPageCounter(el);
    const accepted = PACING.counterAccepted ? PACING.counterAccepted(counter, len) : true;
    logInfo('填字校验', { 我们填: len, 页面计数: counter, 页面认账: accepted, input: (el.tagName || '') + (el.className ? '.' + String(el.className).split(' ')[0] : '') });

    if (accepted) {
      if (counter != null) updateStatus('页面已确认收到 ' + len + ' 字 ✅', 'green');
      stepSleep().then(function () { if (onDone) onDone(); });
      return;
    }

    logWarn('页面计数对不上，改用逐块打字重填', { 页面计数: counter, 我们填: len });
    updateStatus('页面计数（' + (counter == null ? '读不到' : counter) + '）与我们填入的 ' + len +
      ' 字对不上，改成逐块打字重填…', '#f0ad4e');
    typeInChunks(el, text, function () {
      const c2 = readPageCounter(el);
      if (PACING.counterAccepted && !PACING.counterAccepted(c2, len)) {
        updateStatus('⚠️ 逐字输入后页面计数仍是 ' + c2 + '（我们填了 ' + len + ' 字），请人工看一眼输入框再决定要不要继续。', '#e4393c');
      } else {
        updateStatus('逐字输入完成，页面已确认 ' + len + ' 字 ✅', 'green');
      }
      stepSleep().then(function () { if (onDone) onDone(); });
    });
  }

  /* ---------- 倒计时 / 找最里层可点元素 / 点了必须真的跳转 ---------- */

  // 只改界面文字，不写日志（倒计时每秒钟一次，全写日志会把日志刷爆）
  function setStatusText(text, color) {
    $('#jdar-status').text('状态：' + text).css('color', color || '#666');
  }

  function countdownThen(ms, label, done) {
    let remain = Math.ceil(ms / 1000);
    if (remain > 0) setStatusText(label + '：' + remain + ' 秒后自动点击...', 'blue');
    const timer = setInterval(function () {
      remain--;
      if (remain > 0) setStatusText(label + '：' + remain + ' 秒后自动点击...', 'blue');
    }, 1000);
    setTimeout(function () { clearInterval(timer); done(); }, ms);
  }

  function normText(s) { return String(s == null ? '' : s).replace(/\s+/g, '').trim(); }

  function isVisibleEl(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  /**
   * 找「含该文案、且没有子元素也含该文案」的元素（即最里层），按面积从小到大排。
   * 只按直接文本匹配会漏（文案常包在 span 里）；只按 textContent 匹配又会点到整张卡。
   */
  function innermostByText(text, exact) {
    const all = document.querySelectorAll('a, button, span, div, p, i, em, strong, label');
    const out = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!isVisibleEl(el)) continue;
      const t = normText(el.textContent);
      if (!t) continue;
      const hit = exact ? (t === text) : (t.indexOf(text) !== -1);
      if (!hit) continue;
      let hasInner = false;
      for (let j = 0; j < el.children.length; j++) {
        const ct = normText(el.children[j].textContent);
        if (ct && (exact ? ct === text : ct.indexOf(text) !== -1)) { hasInner = true; break; }
      }
      if (hasInner) continue;
      out.push(el);
    }
    out.sort(function (a, b) {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    return out;
  }

  /** 可点候选：最里层的目标 + 它往上几层祖先（有些卡片的 onClick 挂在祖先上） */
  function clickCandidates(text) {
    const list = [];
    const push = function (el) { if (el && list.indexOf(el) === -1) list.push(el); };
    // 只有当祖先"还像一张卡片"时才收它 —— 标记词出现两次以上就是装很多张卡片的列表容器，
    // 点它不会有任何反应（2026-10-09 实测：被过滤后它成了 cands[0]，点了没反应，整轮卡死）
    const likeOneCard = function (el) {
      if (!PACING.pickCardText) return true;
      return !!PACING.pickCardText([normText(el.textContent)], { minLen: 2, maxLen: 400, marker: text, markerMax: 1 });
    };
    innermostByText(text, false).slice(0, 3).forEach(function (el) {
      push(el);
      let p = el.parentElement, depth = 0;
      while (p && depth < 4 && p !== document.body) {
        if (!likeOneCard(p)) break;
        push(p); p = p.parentElement; depth++;
      }
    });
    return list;
  }

  /** 依次点候选，每次点完等 2.5 秒看 URL 变没变（默认只试 1 个：多试会开出一堆标签页） */
  function clickUntilNavigates(candidates, label, onFail, maxAttempts) {
    const limit = Math.max(1, Number(maxAttempts) || 1);
    const before = location.href;
    let i = 0;
    const attempt = function () {
      if (i >= candidates.length || i >= limit) {
        // 用 WARN 不用 ERROR：这**不一定是故障** —— 页面很可能把跳转开在了新标签页里，
        // 由调用方（handleListClickFailed）去判断"是不是故障"。以前记成 ERROR，日志看着像崩了。
        logWarn(label + '：点了候选，本页没有跳转', { href: location.href, 试了几个: i });
        if (onFail) onFail();
        return;
      }
      const el = candidates[i++];
      logInfo(label + '：尝试点击', {
        第几个: i,
        标签: el.tagName,
        类名: String(el.className || '').slice(0, 60),
        文本: window.JDAR_LOG ? window.JDAR_LOG.tail(normText(el.textContent), 30) : ''
      });
      try {
        forceSameTabNav(el);
        withOpenGuard(function () { el.click(); });
      } catch (e) {
        logWarn(label + '：点击抛错', String(e && e.message || e));
      }
      setTimeout(function () {
        if (location.href !== before) { logInfo(label + '：已跳转 ✅', { href: location.href }); return; }
        attempt();
      }, 2500);
    };
    attempt();
  }

  /* ---------- 「这单没法评价 / 没配到图」时的处理：跳过 / 暂停 / 无图也发 ---------- */

  const SKIP_KEY = 'JDAR_SKIP';
  let skipNames = {};        // 本轮跳过过的商品名指纹（没法评价的 + 没配到图的都记这里）
  let skipStreak = 0;        // 连续"没配到图"几单（连续太多就停手，避免在同一个商品上绕圈）
  let oldProductName = '';   // 老评价页当前处理的商品名/编码（跳过时用）
  let oldProductSku = '';
  const MAX_SKIP_STREAK = 3;

  /** 没法评价 / 没配到图时怎么办：skip（跳过，默认）/ pause（停下等人）/ publish（无图也发） */
  function noImageAction() {
    const v = CFG.noImageAction;
    if (v === 'skip' || v === 'pause' || v === 'publish') return v;
    // 兼容旧配置：requireImage=false 曾经表示「无图也发」
    return (CFG.requireImage === false) ? 'publish' : 'skip';
  }

  function loadSkipState() {
    return storageGet(SKIP_KEY).then(function (s) {
      const o = (s && typeof s === 'object') ? s : {};
      skipNames = (o.names && typeof o.names === 'object') ? o.names : {};
      skipStreak = Number(o.streak) || 0;
    });
  }

  function saveSkipState() {
    storageSet({ [SKIP_KEY]: { names: skipNames, streak: skipStreak, at: Date.now() } });
  }

  function resetSkipState() {
    skipNames = {};
    skipStreak = 0;
    saveSkipState();
    clearLastCard();
  }

  /** 元素自己 + 各级祖先的文本（已归一化），给 pickCardText 用 */
  function ancestorTexts(el, maxDepth) {
    const out = [];
    let node = el, depth = 0;
    const limit = Number(maxDepth) || 8;
    while (node && node !== document.body && depth < limit) {
      out.push(normText(node.textContent));
      node = node.parentElement;
      depth++;
    }
    return out;
  }

  /**
   * 取出"这一张卡片"的文本（跳过指纹用）。marker 就是刚点的按钮文字（如「去评价」）。
   *
   * ⚠️ 2026-10-09 事故：以前这里只要祖先文本 ≥6 字就返回，结果一路走到了**装很多张卡片的列表容器**，
   * 把 3 张卡片拼起来的文本当成了"商品名"存进 skipNames → 下一轮一次误伤 3 张无关卡片 → 整轮卡死。
   * 现在交给纯函数 PACING.pickCardText：长度 + 标记词出现次数双重设限，走到容器就返回 ''（宁可不记指纹）。
   */
  function cardText(el, marker) {
    if (PACING.pickCardText) {
      return PACING.pickCardText(ancestorTexts(el, 8), { minLen: 6, maxLen: 400, marker: marker || '', markerMax: 1 });
    }
    return normText(el && el.textContent);
  }

  /** 列表页里"跳过过的商品"就别再点了，否则会一直绕回同一个商品 */
  function isSkippedCard(el, marker) {
    if (!Object.keys(skipNames).length) return false;
    const card = cardText(el, marker);
    if (!card) return false;        // 认不出单张卡片（已经走到列表容器）→ 不做匹配，避免误伤一片
    return !!(PACING.isSkippedText && PACING.isSkippedText(card, skipNames));
  }

  function filterSkipped(cands, marker) {
    const all = cands || [];
    const keep = all.filter(function (el) { return !isSkippedCard(el, marker); });
    if (keep.length !== all.length) {
      logInfo('列表页跳过了 ' + (all.length - keep.length) + ' 个"已经跳过过"的商品');
    }
    return keep;
  }

  function goBackToList() {
    const url = isNewHost()
      ? 'https://comment.m.jd.com/pc-static/center'
      : 'https://club.jd.com/myJdcomments/myJdcomment.action?sort=0';
    logInfo('跳过后回列表页继续', { url: url });
    setTimeout(function () { location.href = url; }, rnd(2500, 5000));
  }

  /**
   * 跳过这一单：不发表、**不计入上限**、回列表继续下一单。
   *
   * reason = 'unreviewable'（外卖/服务单、卡片点不进去、页面明说不能评价）
   *          → **不计入**"连续没配到图"计数：这是订单本身的性质，不是出故障；
   *            而且每张卡片这一轮只会被点一次（回来时被 filterSkipped 过滤掉），不会绕圈。
   * reason = 'noImage'（一张图都没配到）
   *          → 计入连续计数，连续 MAX_SKIP_STREAK 单就停手（多半是图片池空了 / 上传入口变了）。
   *
   * keyLen：跳过指纹取多少字。商品名用默认 12；整张卡片文本用 40（更精确，避免误伤同类目商品）。
   */
  function skipThisOrder(name, sku, reason, keyLen) {
    const why = (reason === 'unreviewable') ? '这单无法评价' : '没配到图';
    const len = Number(keyLen) || 12;
    const key = PACING.nameKey ? PACING.nameKey(name, len) : String(name || '').slice(0, len);
    if (key) skipNames[key] = 1;
    if (reason !== 'unreviewable') skipStreak++;
    saveSkipState();
    clearLastCard();          // 这一张卡片已经处理完了
    logWarn('跳过这一单（' + why + '）', {
      商品: name || '', sku: sku || '', 原因: why,
      已跳过商品数: Object.keys(skipNames).length,
      连续没配到图: skipStreak,
      计入上限: '否'
    });
    if (reason !== 'unreviewable' && skipStreak >= MAX_SKIP_STREAK) {
      setRunning(false);
      updateStatus('⏭ 连续 ' + skipStreak + ' 单都没配到图，已停下（多半是图片池空了，或上传入口变了）。' +
        '可到设置页把「没法评价 / 没配到图时」改成「无图也发表」，或稍后再跑。', '#e4393c');
      return;
    }
    updateStatus('⏭ ' + why + '，已跳过（不计入上限），继续下一单…', '#b7791f');
    goBackToList();
  }

  /** 当前页面文本有没有明说"不能评价"（外卖/服务单、已评价过的单、活动结束） */
  function unreviewableHere() {
    try {
      const t = document.body ? (document.body.innerText || '') : '';
      return (PACING.looksUnreviewable ? PACING.looksUnreviewable(t) : '') || '';
    } catch (e) { return ''; }
  }

  /** 找不到输入框时统一走这里：页面明说不能评价 → 跳过；含糊不清 → 停下问人（不瞎猜） */
  function bailNoBox(name, sku, resumeFn, where) {
    const hit = unreviewableHere();
    if (hit) {
      logWarn('这个订单无法评价（页面文案命中）', { 命中: hit, 位置: where, url: location.href });
      skipThisOrder(name || '', sku || '', 'unreviewable');
      return true;
    }
    setRunning(false);
    if (resumeFn) resumeAction = resumeFn;
    updateStatus('❌ ' + where + '没找到评价输入框，页面也没说"不能评价"，已停下请人工看一眼（可能是页面没加载完，或京东又改版了）。', '#e4393c');
    return false;
  }

  /**
   * 列表页点了卡片但本页没跳转。两种可能：
   *   ① 页面把「去评价」开在了新标签页 —— 由那个标签页接手（所以先交出运行权）
   *   ② 这种单根本点不进去（外卖单、服务单、已评价的单）—— 跳过它，回列表继续
   *
   * 节奏：2.5 秒先看一眼（新标签页通常 1 秒内就把租约接走了，这时**安静停手**即可，
   * 不该报错、也不该白等满 8 秒）；真没人接手，再等 5.5 秒后判定 ② 并跳过。
   */
  function handleListClickFailed(label, cardEl) {
    const name = cardText(cardEl, label);
    STOP_THIS_TAB = true;
    releaseLease();

    // 认不出是哪张卡片 → **不记指纹、也不跳过**：记错了会一次误伤一整片卡片（2026-10-09 事故）。
    // 宁可停下让人看一眼，也不要一边误伤一边空转。
    if (!name) {
      setRunning(false);
      logWarn('点了列表卡片但本页没跳转，且认不出是哪张卡片 → 不记指纹、停下', {
        按钮: label, 类名: String((cardEl && cardEl.className) || '').slice(0, 60), 本页tabId: MY_TAB
      });
      updateStatus('点了「' + label + '」没反应，又认不出是哪张卡片，已停下避免空转。' +
        '刷新页面再点「开始」；若每单都这样，把面板日志下载发我。', '#e4393c');
      return;
    }

    logWarn('点了列表卡片但本页没跳转', {
      按钮: label, 卡片: name.slice(0, 40), 本页tabId: MY_TAB
    });
    updateStatus('点了「' + label + '」但本页没跳转，先交出运行权（若开了新标签页，由那个标签页继续）…', '#b7791f');
    setTimeout(function () {
      if (!running) return;
      tryAcquireLease().then(function (yes) {
        if (!yes) {
          logInfo('已有其他标签页接手（页面把「去评价」开在了新标签页），本页保持停手');
          return;
        }
        // 租约还空着：再给 5.5 秒（合计约 8 秒），仍然没人接手才判定"点不进去"
        setTimeout(function () {
          if (!running) return;
          tryAcquireLease().then(function (yes2) {
            if (!yes2) { logInfo('已有其他标签页接手，本页保持停手'); return; }
            STOP_THIS_TAB = false;
            startLeaseTimer();
            logInfo('没有标签页接手 → 判定这一单点不进去，跳过它', { 卡片: name.slice(0, 40) });
            skipThisOrder(name, '', 'unreviewable', 40);
          });
        }, 5500);
      });
    }, 2500);
  }

  /* ---------- 「我上一次点的是哪张卡片」：跨页面记住，兜住"点进去发现没法评价" ----------
     外卖单 / 服务单 / 已评价过的单，点进去常常落到一个我们不认识的页面。
     光看那个页面认不出是哪个商品，所以在点卡片之前先把卡片指纹存下来。 */

  const LASTCARD_KEY = 'JDAR_LASTCARD';
  const LASTCARD_TTL = 180000;   // 3 分钟：超过就当过期，免得旧指纹误伤别的页面
  let lastCardText = '';
  let lastCardAt = 0;

  function loadLastCard() {
    return storageGet(LASTCARD_KEY).then(function (v) {
      const o = (v && typeof v === 'object') ? v : {};
      lastCardText = String(o.text || '');
      lastCardAt = Number(o.at) || 0;
    });
  }

  function rememberCard(cardEl, marker) {
    const t = cardText(cardEl, marker);
    lastCardText = t ? t.slice(0, 160) : '';
    lastCardAt = lastCardText ? Date.now() : 0;
    storageSet({ [LASTCARD_KEY]: { text: lastCardText, at: lastCardAt } });
  }

  function clearLastCard() {
    lastCardText = '';
    lastCardAt = 0;
    storageSet({ [LASTCARD_KEY]: { text: '', at: 0 } });
  }

  /** 刚点过卡片、又落在一个不认识的页面上吗？（3 分钟内才算） */
  function justClickedUnknownCard() {
    return !!lastCardText && (Date.now() - lastCardAt) < LASTCARD_TTL;
  }

  /* ==================== 评价正文生成 ==================== */

  function generateReview(productName, successCallback, errorCallback, attempt) {
    attempt = attempt || 0;
    const min = Number(CFG.minReviewChars) || 60;
    bg('llmGenerate', { productName: productName, attempt: attempt }).then(function (r) {
      const review = (r.text || '').trim();
      const len = countChars(review);
      if (len >= min) { successCallback(review); return; }

      if (attempt < (Number(CFG.minReviewRetry) || 0)) {
        updateStatus('本次只写了 ' + len + ' 字（要求 ≥' + min + '），自动重试 ' + (attempt + 1) + '/' + CFG.minReviewRetry + '...', '#f0ad4e');
        generateReview(productName, successCallback, errorCallback, attempt + 1);
        return;
      }
      const padded = padToMinChars(review);
      updateStatus('模型连续 ' + (attempt + 1) + ' 次不足 ' + min + ' 字，已补通用结尾兜底（共 ' + countChars(padded) + ' 字）。', '#f0ad4e');
      successCallback(padded);
    }).catch(function (e) {
      errorCallback(String(e && e.message || e));
    });
  }

  /* ==================== 文案来源：现成评价 / 混合 / AI ==================== */

  const poolCache = {};        // sku -> Promise<reviews[]>
  const reviewBySku = {};      // sku -> 本次选中用来填字的评价（用于「文图一致」）
  const usedReviewIds = {};    // 本轮已经用过的评价，避免同一轮重复用同一条

  function ensurePool(sku) {
    if (!sku) return Promise.resolve([]);
    if (!poolCache[sku]) {
      updateStatus('正在取该商品的现成评价（图 + 文）...', 'blue');
      poolCache[sku] = bg('fetchReviewPool', { productId: sku }, 45000)
        .then(function (r) {
          const list = r.reviews || [];
          const withImg = list.filter(function (x) { return x.images && x.images.length; }).length;
          logInfo('评价池就绪', {
            总数: list.length,
            带图: withImg,
            接口报错: (r.errors && r.errors.length) ? r.errors : undefined
          });
          return list;
        })
        .catch(function (e) {
          logWarn('取评价池失败', String(e && e.message || e));
          return [];
        });
    }
    return poolCache[sku];
  }

  /**
   * 最后一道防线：万一还有 &ldquo; / &#123; 这类没还原的字符实体残留，
   * 就地再清洗一次并记日志（正常情况下前面已经洗干净，这里只是不会再漏）。
   */
  function finalizeText(t) {
    let s = String(t == null ? '' : t);
    if (!s) return s;
    if (/&[a-zA-Z]{2,20};?|&#\d+;?|&#x[0-9a-fA-F]+;?/.test(s) && window.JDAR_TEXT) {
      const before = s;
      s = window.JDAR_TEXT.cleanReviewText(s);
      logWarn('文案里检测到未还原的字符实体，已就地二次清洗', {
        原字数: countChars(before),
        处理后: countChars(s)
      });
    }
    return s;
  }

  /**
   * 取一条 ≥minReviewChars 的文案。
   * onDone(text, review)：review 为文案来源那条评价（可能为 null），配图时优先用它自带的图。
   */
  /* ---------- 文案记忆（跨页面）：拼过的句子 + 最近发过的正文，用来"尽量不重复" ---------- */

  const TEXT_MEM_KEY = 'JDAR_TEXT_MEMORY';

  function loadTextMemory() {
    return storageGet(TEXT_MEM_KEY).then(function (m) {
      const mem = (m && typeof m === 'object') ? m : {};
      return {
        sentences: (mem.sentences && typeof mem.sentences === 'object') ? mem.sentences : {},
        texts: Array.isArray(mem.texts) ? mem.texts.slice(-10) : []
      };
    });
  }

  function saveTextMemory(mem) {
    const keys = Object.keys(mem.sentences);
    if (keys.length > 300) {                 // 只留最近 300 个句子指纹，别让存储无限涨
      const keep = {};
      keys.slice(-300).forEach(function (k) { keep[k] = 1; });
      mem.sentences = keep;
    }
    storageSet({ [TEXT_MEM_KEY]: { sentences: mem.sentences, texts: mem.texts.slice(-10), at: Date.now() } });
  }

  /** 与最近发过的正文比对句子重合度，≥50% 视为太像 */
  function tooSimilar(text, recent) {
    if (!window.JDAR_TEXT || !window.JDAR_TEXT.sentenceOverlap) return false;
    const list = recent || [];
    for (let i = 0; i < list.length; i++) {
      if (window.JDAR_TEXT.sentenceOverlap(text, list[i]) >= 0.5) return true;
    }
    return false;
  }

  function getReviewText(productName, sku, onDone, onFail) {
    const mode = CFG.textSource || 'offline';
    const min = Number(CFG.minReviewChars) || 60;
    // 所有出口都过一遍 finalizeText，保证填进页面的绝不含实体
    const _done = onDone;
    onDone = function (t, r) { _done(finalizeText(t), r); };

    if (mode === 'ai') { generateReview(productName, onDone, onFail); return; }

    ensurePool(sku).then(function (reviews) {
      return loadTextMemory().then(function (mem) {
        reviews.forEach(function (r) { r.used = !!usedReviewIds[r.discussionId]; });

        // 组稿：与最近发过的太像就重抽素材再拼（最多 3 次）
        let attempt = 0;
        let picked = null;
        while (attempt < 3) {
          picked = window.JDAR_TEXT.pickReviewText(reviews, min, {
            mode: CFG.textComposeMode || 'merge',
            poolSize: Number(CFG.textPoolSize) || 10,
            maxChars: Number(CFG.textMaxChars) || 120,
            minScore: Number(CFG.minScore == null ? 4 : CFG.minScore),
            usedSentences: mem.sentences,
            usedReviewIds: usedReviewIds
          });
          if (picked.source === 'template') break;
          if (!tooSimilar(picked.text, mem.texts)) break;
          attempt++;
          logWarn('组稿结果与最近发过的太像，重新抽素材组稿', { 第几次: attempt });
        }

        if (picked.source === 'single' || picked.source === 'merged') {
          if (picked.review) usedReviewIds[picked.review.discussionId] = true;
          (picked.sentences || []).forEach(function (s) {
            const k = window.JDAR_TEXT.sentenceKey(s);
            if (k) mem.sentences[k] = 1;
          });
          (picked.sources || []).forEach(function (id) { usedReviewIds[id] = true; });
          if (picked.source === 'merged') mem.texts.push(picked.text);
          saveTextMemory(mem);

          const srcCount = (picked.sources || []).length || 1;
          logInfo('文案选定', {
            来源: picked.source === 'single' ? '单条现成评价（整条）' : '多条组稿（新拼的）',
            字数: countChars(picked.text),
            用了几条素材: srcCount,
            避开重复重抽: attempt > 0 ? (attempt + ' 次') : undefined,
            开头: window.JDAR_LOG ? window.JDAR_LOG.tail(picked.text, 40) : ''
          });
          updateStatus(picked.source === 'merged'
            ? ('文案：' + srcCount + ' 条好评组稿成新评价（' + countChars(picked.text) + ' 字）')
            : ('文案：用现成评价整条（' + countChars(picked.text) + ' 字）'), 'green');
          onDone(picked.text, picked.review);
          return;
        }

        // 现成素材凑不出目标字数
        if (mode === 'hybrid' && CFG.apiKey) {
          updateStatus('现成评价凑不出 ' + min + ' 字，改用 AI 生成...', '#f0ad4e');
          generateReview(productName, onDone, onFail);
          return;
        }
        const tpl = window.JDAR_TEXT.pickTemplate(min, CFG.fallbackTail);
        updateStatus('现成评价不足 ' + min + ' 字，用内置模板兜底（' + countChars(tpl) + ' 字）。', '#f0ad4e');
        onDone(tpl, null);
      });
    }).catch(function (e) {
      if (mode === 'hybrid' && CFG.apiKey) { generateReview(productName, onDone, onFail); return; }
      onFail(String(e && e.message || e));
    });
  }

  /* ==================== 配图 ==================== */

  function fetchShandanImages(sku) {
    return bg('fetchShandanImages', { productId: sku }, 25000)
      .then(function (r) { return r.urls || []; })
      .catch(function (e) { console.warn('[京东自动评价] 晒单图接口失败：', e); return []; });
  }

  function blobToJpegFile(blob, name) {
    return new Promise(function (resolve, reject) {
      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(objUrl);
        let w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { reject(new Error('图片尺寸为 0')); return; }
        const MAX = 1920;
        if (Math.max(w, h) > MAX) {
          const s = MAX / Math.max(w, h);
          w = Math.round(w * s); h = Math.round(h * s);
        }
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        cv.toBlob(function (jpg) {
          jpg ? resolve(new File([jpg], name, { type: 'image/jpeg' })) : reject(new Error('toBlob 失败'));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(objUrl); reject(new Error('图片解码失败')); };
      img.src = objUrl;
    });
  }

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
  }

  // 下载一张晒单图 -> 真 JPEG File（CDN 常按内容协商返回 webp，京东按 magic bytes 校验会拒收）
  function fetchImageFile(url, name) {
    let u = url.indexOf('//') === 0 ? 'https:' + url : url;
    u = u.replace(/\.dpg(\?|$)/, '$1');
    return bg('fetchImage', { url: u }, 40000).then(function (r) {
      return blobToJpegFile(base64ToBlob(r.base64, r.contentType), name);
    });
  }

  function injectFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach(function (f) { dt.items.add(f); });
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 老评价页：一个页面可能有多件商品，靠 .btn-upload(#image-upload-<sku>) 与 input 的几何重叠定位
  function findFileInputForSku(sku) {
    const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'));
    if (inputs.length <= 1) return inputs[0] || null;
    const span = document.getElementById('image-upload-' + sku);
    if (!span) return inputs[0];
    const r = span.getBoundingClientRect();
    let best = inputs[0], bestArea = -1;
    inputs.forEach(function (inp) {
      const ir = inp.getBoundingClientRect();
      const ox = Math.max(0, Math.min(r.right, ir.right) - Math.max(r.left, ir.left));
      const oy = Math.max(0, Math.min(r.bottom, ir.bottom) - Math.max(r.top, ir.top));
      const area = ox * oy;
      if (area > bestArea) { bestArea = area; best = inp; }
    });
    return best;
  }

  // 老评价页：收集本页商品（sku + 对应 file input）
  function collectProductsOld() {
    const seen = {}, products = [];
    document.querySelectorAll('.p-name a').forEach(function (a) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/item\.jd\.com\/(\d+)\.html/);
      if (m && !seen[m[1]]) {
        seen[m[1]] = 1;
        products.push({
          sku: m[1],
          name: (a.textContent || '').trim(),      // 记下商品名，跳过后好认
          input: findFileInputForSku(m[1])
        });
      }
    });
    return products;
  }

  // 取哪几张图：默认「整个评价池随机」，可选「优先文案那条评价的图」
  const usedImageUrls = {};   // 同一轮内已用过的图（避免跨单重复，降低图片查重）

  function shuffleArr(a) {
    const arr = (a || []).slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // 张数：默认随机（京东要求 ≥2），也可固定
  function wantImageCount() {
    if (CFG.imgRandomCount === false) return Math.max(1, Number(CFG.imgPerProduct) || 2);
    const lo = Math.max(1, Number(CFG.imgCountMin) || 2);
    const hi = Math.max(lo, Number(CFG.imgCountMax) || lo);
    return rnd(lo, hi);
  }

  function collectImageUrls(reviews, picked, want) {
    const mode = CFG.imgSourceMode || 'random';
    const avoid = CFG.avoidReuseImage !== false;
    const out = [];
    const tryPush = function (arr, ignoreUsed) {
      shuffleArr(arr).forEach(function (u) {
        if (!u || out.length >= want) return;
        if (out.indexOf(u) !== -1) return;
        if (avoid && !ignoreUsed && usedImageUrls[u]) return;
        out.push(u);
      });
    };

    if (mode === 'same' && picked) tryPush(picked.images, false);

    const rest = shuffleArr((reviews || []).slice());
    rest.forEach(function (r) {
      if (out.length >= want) return;
      if (mode === 'same' && picked && r.discussionId === picked.discussionId) return;
      tryPush(r.images, false);
    });

    // 全被「不重复用图」挡掉时放宽一次，保证这一单一定有图
    if (out.length < want) {
      if (mode === 'same' && picked) tryPush(picked.images, true);
      rest.forEach(function (r) { if (out.length < want) tryPush(r.images, true); });
    }
    return out;
  }

  /**
   * 分批注入图片，每批之间随机停顿 —— 模拟人手一张张选文件。
   * 一次性把 3 张塞进去 = 3 个上传请求在 1 秒内齐发，最像脚本。
   */
  function injectInBatches(input, files, sku) {
    const mode = CFG.imgUploadMode || 'human';
    const per = Math.max(1, Math.min(files.length, Number(CFG.imgUploadBatch) || 1));
    if (mode === 'instant' || files.length <= 1) {
      injectFiles(input, files);
      logInfo('图片一次注入', { 张数: files.length });
      updateStatus('sku ' + sku + ' 已注入 ' + files.length + ' 张买家秀图，上传中...', 'green');
      return Promise.resolve(files.length);
    }
    let i = 0;
    const next = function () {
      if (i >= files.length) return Promise.resolve(files.length);
      const batch = files.slice(i, i + per);
      i += batch.length;
      injectFiles(input, batch);
      logInfo('注入图片（分批）', { 第几张: i + '/' + files.length, 本批: batch.length });
      updateStatus('sku ' + sku + ' 已注入第 ' + i + '/' + files.length + ' 张，上传中...', 'green');
      if (i >= files.length) return Promise.resolve(files.length);
      const gap = rnd(sec2ms(CFG.imgUploadGapMinSec, 1.5), sec2ms(CFG.imgUploadGapMaxSec, 4));
      updateStatus('等 ' + (PACING.humanDuration ? PACING.humanDuration(gap) : Math.round(gap / 1000) + ' 秒') +
        ' 再注入下一张（模拟手动一张张选）…', 'blue');
      return sleep(gap).then(next);
    };
    return next();
  }

  // 一个商品：取买家秀图 -> 重编码成真 JPEG -> 注入上传；返回成功注入张数
  function uploadForProduct(p) {
    const want = wantImageCount();
    updateStatus('配图：本次随机取 ' + want + ' 张（' + (CFG.imgSourceMode === 'same' ? '优先文案同源' : '整个评价池随机') + '）...', 'blue');

    const doUpload = function (urls) {
      if (!urls || !urls.length) {
        updateStatus('sku ' + p.sku + ' 没抓到买家秀图，跳过配图', '#e4393c');
        return 0;
      }
      const picks = urls.slice(0, want);
      logInfo('准备注入图片', {
        sku: p.sku,
        选了几张: picks.length,
        文图同源: !!(p.review && picks[0] && (p.review.images || []).indexOf(picks[0]) !== -1),
        首个: window.JDAR_LOG ? window.JDAR_LOG.tail(picks[0], 80) : picks[0]
      });
      const tasks = picks.map(function (u, i) {
        return fetchImageFile(u, 'jdar_' + p.sku + '_' + i + '.jpg').catch(function (e) {
          console.warn('[京东自动评价] 取图失败：', u, e);
          return null;
        });
      });
      return Promise.all(tasks).then(function (files) {
        files = files.filter(Boolean);
        if (!files.length || !p.input) {
          updateStatus('sku ' + p.sku + ' 配图没成功（input=' + (!!p.input) + '，files=' + files.length + '）', '#e4393c');
          return 0;
        }
        return injectInBatches(p.input, files, p.sku).then(function (n) {
          picks.forEach(function (u) { usedImageUrls[u] = true; });   // 本轮不再重复用这几张
          return n;
        });
      });
    };

    return ensurePool(p.sku).then(function (reviews) {
      const urls = collectImageUrls(reviews, p.review, want);
      if (urls.length) return doUpload(urls);
      // 评价池里没图 → 回退到老的晒单图接口
      return fetchShandanImages(p.sku).then(function (fallback) { return doUpload(fallback); });
    });
  }

  function waitUploads(min, timeout) {
    return new Promise(function (resolve) {
      const start = Date.now();
      const iv = setInterval(function () {
        const n = document.querySelectorAll('img[src*="imageUpload"]').length;
        if (n >= min || (Date.now() - start) > timeout) { clearInterval(iv); resolve(n); }
      }, 600);
    });
  }

  /* ==================== 发表 ==================== */

  function publishStep() {
    if (haltIfPaused(publishStep)) return;
    if (CFG.dryRun) {
      setRunning(false);
      bumpDone(pendingReviewCount);
      updateStatus('🧪 模拟模式：正文/星级/配图都已填好，**没有点「发表」**。要看正式效果请在面板把模式切成「真实」。', '#e4393c');
      return;
    }
    if (riskDetected()) { stopForRisk('评价页'); return; }
    // 发表前确认自己仍是驱动页（避免两个标签页同时提交）
    canDrive(function (yes) {
      if (!yes) { logWarn('本页不是驱动页，取消提交'); return; }
      capReached(function (stop) {
        if (stop) return;
        const wait = msStep() + 2000;
        logInfo('准备点发表（老评价页）', { 等待毫秒: wait, 本次条数: pendingReviewCount, url: location.pathname });
        updateStatus((PACING.humanDuration ? PACING.humanDuration(wait) : Math.round(wait / 1000) + ' 秒') + '后点「发表」...', 'blue');
        autoClickAfter(resolveOldPublishBtn, '自动发表评价', wait);
        bumpDone(pendingReviewCount);
      });
    });
  }

  function resolveOldPublishBtn() {
    let $btn = $clickableByText('发表', false);
    if ($btn.length === 0) $btn = $clickableByText('发表', true);
    return $btn.first();
  }

  /* ==================== 老链路：评价页 ==================== */

  function uploadImagesThenPublish() {
    if (haltIfPaused(uploadImagesThenPublish)) return;
    if (!CFG.enableImage) { publishStep(); return; }

    const products = collectProductsOld();
    if (!products.length) { publishStep(); return; }
    oldProductName = products[0].name || '';
    oldProductSku = products[0].sku || '';
    products.forEach(function (p) { p.review = reviewBySku[p.sku] || null; });

    let expected = 0;
    const chain = products.reduce(function (prev, p) {
      return prev.then(function () {
        if (!running) {
          resumeAction = uploadImagesThenPublish;
          updateStatus('⏸ 已暂停。', '#e4393c');
          throw 'PAUSED';
        }
        return uploadForProduct(p).then(function (n) { expected += n; });
      });
    }, Promise.resolve());

    chain.then(function () {
      if (expected > 0) {
        updateStatus('共注入 ' + expected + ' 张图，等上传完成...', 'blue');
        return waitUploads(expected, sec2ms(CFG.uploadWaitTimeoutSec, 15));
      }
      const act = noImageAction();
      if (act === 'pause') {
        setRunning(false);
        resumeAction = uploadImagesThenPublish;
        updateStatus('❌ 一张图都没配到，已按设置暂停。点「开始」可重试；到设置页把「没配到图时」改成「跳过」就不会卡住。', '#e4393c');
        throw 'PAUSED_NO_IMAGE';
      }
      if (act === 'skip') {
        skipThisOrder(oldProductName || '', oldProductSku || '', 'noImage');
        throw 'PAUSED_NO_IMAGE';   // 复用同一个"到这里为止"的短路
      }
      // act === 'publish' → 无图也照发，直接往下走
    }).then(function () {
      publishStep();
    }).catch(function (e) {
      if (e === 'PAUSED' || e === 'PAUSED_NO_IMAGE') return;
      updateStatus('配图出问题，跳过配图直接发表：' + e, 'red');
      publishStep();
    });
  }

  function processNextItem(index) {
    const $textareas = $('.f-textarea textarea').filter(':visible');
    const $names = $('.p-name').filter(':visible');

    if (index >= $textareas.length) {
      $('.star5:visible').click();
      if (CFG.enableImage) {
        updateStatus('✅ 评价已生成并打五星，开始自动配图...', 'green');
        uploadImagesThenPublish();
      } else {
        updateStatus('✅ 评价生成完毕，已打五星，准备自动发表...', 'green');
        publishStep();
      }
      return;
    }

    if (haltIfPaused(function () { processNextItem(index); })) return;

    const nameNode = $names.eq(index);
    const $link = nameNode.find('a');
    const productName = $link.text().trim() || nameNode.text().trim() || '未知商品';
    const skuMatch = ($link.attr('href') || '').match(/item\.jd\.com\/(\d+)\.html/);
    const sku = skuMatch ? skuMatch[1] : '';
    const shortName = productName.length > 15 ? productName.substring(0, 15) + '...' : productName;

    updateStatus('正在生成 ' + (index + 1) + '/' + $textareas.length + '：' + shortName, 'blue');

    getReviewText(productName, sku, function (review, pickedReview) {
      if (sku && pickedReview) reviewBySku[sku] = pickedReview;
      const $target = $textareas.eq(index);
      if ($target.length === 0) { updateStatus('找不到评价输入框。', '#e4393c'); return; }
      fillReview($target[0], review, function () {
        if (riskDetected($target[0])) { stopForRisk('评价页'); return; }
        updateStatus('第 ' + (index + 1) + ' 条已填入（' + countChars(review) + ' 字）', 'green');
        processNextItem(index + 1);
      });
    }, function (errMsg) {
      setRunning(false);
      resumeAction = function () { processNextItem(index); };
      updateStatus('❌ 第 ' + (index + 1) + ' 个商品生成失败：' + errMsg + '。已暂停，排查后点「开始」重试。', '#e4393c');
    });
  }

  function startOldReview() {
    if (!checkConfig()) return;
    const $textareas = $('.f-textarea textarea').filter(':visible');
    if ($textareas.length === 0) {
      // 老链路也可能点进来发现这单不能评价（已评价过 / 活动结束）
      const nm = $('.p-name').first().text().trim() || oldProductName || '';
      bailNoBox(nm, oldProductSku || '', startOldReview, '老评价页');
      return;
    }
    // 一个订单可能含多件商品：这一页有几个输入框 = 这次发表会产出几条评价
    pendingReviewCount = Math.max(1, $textareas.length);
    logInfo('本单商品数（= 将产生的评价条数）', { 条数: pendingReviewCount });
    updateStatus('检测到 ' + $textareas.length + ' 个商品，开始处理...', 'blue');
    processNextItem(0);
  }

  // 老链路：我的评价列表页 —— 点第一条「评价」
  function oldListStep() {
    checkRunLimit(function (done) {
      const g = orderGapText(done);
      updateStatus(g.first
        ? ('第 1 单：' + g.dur + ' 后开始（首单不套用"两单之间休息"）。')
        : ('本单结束。按防风控节奏休息 ' + g.dur + ' 再进下一单，期间什么都不点。'), 'blue');
      countdownThen(g.gap, g.first ? '开始第 1 单' : '进入下一单评价', function () {
        if (haltIfPaused(oldListStep)) return;
        const $btn = $('.operate').find('a, button, span').filter(':visible').filter(function () {
          return normText($(this).clone().children().remove().end().text()) === '评价';
        });
        let cands = $btn.length ? [$btn[0]] : [];
        if (!cands.length) cands = filterSkipped(clickCandidates('去评价').concat(clickCandidates('评价')), '评价');
        if (!cands.length) {
          setRunning(false);
          updateStatus('🎉 待评价列表已空，循环结束。⭐ 觉得好用的话，点标题栏的 ⭐ 给个 Star。', 'green');
          return;
        }
        rememberCard(cands[0], '评价');   // 先记下这张卡片：万一跳过去是个"没法评价"的页面，才知道该跳过谁
        clickUntilNavigates(cands, '进入下一单评价', function () {
          handleListClickFailed('评价', cands[0]);
        }, 1);
      });
    });
  }

  function oldSuccessStep() {
    skipStreak = 0;              // 成功发表了一条 → 连续跳过计数清零
    saveSkipState();
    clearLastCard();
    autoClickAfter(function () {
      return $clickableByText('返回待评价列表', true).first();
    }, '返回待评价列表');
  }

  /* ==================== 新链路：评价中心 ==================== */

  function newCenterListStep() {
    if (!CFG.supportNewCenter) { updateStatus('已关闭新评价中心支持。', '#e4393c'); return; }
    checkRunLimit(function (done) {
      const g = orderGapText(done);
      updateStatus(g.first
        ? ('第 1 单：' + g.dur + ' 后开始（首单不套用"两单之间休息"）。')
        : ('本单结束。按防风控节奏休息 ' + g.dur + ' 再进下一单，期间什么都不点。'), 'blue');
      countdownThen(g.gap, g.first ? '开始第 1 单' : '进入下一单评价（新评价中心）', function () {
        if (haltIfPaused(newCenterListStep)) return;
        const cands = filterSkipped(clickCandidates('去评价'), '去评价');
        if (!cands.length) {
          setRunning(false);
          updateStatus('🎉 新评价中心没有待评价卡片了，循环结束。⭐ 觉得好用的话，点标题栏的 ⭐ 给个 Star。', 'green');
          return;
        }
        rememberCard(cands[0], '去评价');   // 先记下这张卡片：万一跳过去是个"没法评价"的页面，才知道该跳过谁
        clickUntilNavigates(cands, '进入下一单评价（新评价中心）', function () {
          handleListClickFailed('去评价', cands[0]);
        }, 1);
      });
    });
  }

  function newPublishFillStars() {
    try {
      const desc = $('.scoreBox-conter-score-star-desc');
      const texts = [];
      for (let i = 0; i < desc.length; i++) texts.push(($(desc[i]).text() || '').trim());
      if (texts.length && texts.every(function (t) { return t === '非常好' || t === '非常满意'; })) {
        updateStatus('新发布页评分默认已是满分，跳过点击（少一次动作 = 少一分风控信号）。', 'blue');
        return;
      }
      const boxes = $('.scoreBox-conter-score-star-box');
      let clicked = 0;
      for (let i = 0; i < boxes.length; i++) {
        const items = $(boxes[i]).find('.scoreBox-conter-score-star-box-item');
        if (items.length) { $(items[items.length - 1]).trigger('click'); clicked++; }
      }
      if (clicked) updateStatus('已把 ' + clicked + ' 个评分维度点成满分。', 'blue');
    } catch (e) {
      console.warn('[京东自动评价] 处理星级出错：', e);
    }
  }

  function newPublishStep() {
    if (!checkConfig()) return;
    if (haltIfPaused(newPublishStep)) return;

    const params = new URLSearchParams(location.search);
    const sku = params.get('skuId') || '';
    const productName = $('.rate-comment-goods-title').first().text().trim() ||
      $('img[alt]').first().attr('alt') || document.title;

    // 这个发布页有几个商品？>1 说明是「一起评 / 合并评价」，一次发布会产出多条评价
    const boxes = $('textarea.rate-comment-content-textarea');
    pendingReviewCount = Math.max(1, boxes.length);
    if (boxes.length > 1) {
      setRunning(false);
      logWarn('发布页含多个商品（合并评价），当前版本一次只处理 1 个，已停手', { 商品数: boxes.length, url: location.href });
      updateStatus('⚠️ 这个发布页有 ' + boxes.length + ' 个商品（一起评/合并评价）。为了不发出半截评价，已停手 —— ' +
        '把面板日志下载发我，我加上多商品支持。', '#e4393c');
      return;
    }

    updateStatus('新发布页：' + (productName.length > 18 ? productName.slice(0, 18) + '...' : productName), 'blue');

    getReviewText(productName, sku, function (review, pickedReview) {
      // 配图 → 发表：都要等「正文填好且页面认账」之后才做
      const afterText = function () {
        const afterImage = function () {
          if (CFG.dryRun) {
            setRunning(false);
            bumpDone(pendingReviewCount);
            updateStatus('🧪 模拟模式：正文/星级/配图都已填好，**没有点「发布」**。要到面板把模式切成「真实」才会提交。', '#e4393c');
            return;
          }
          if (riskDetected()) { stopForRisk('发布页'); return; }
          // 提交前确认自己仍是驱动页（避免两个标签页同时提交）
          canDrive(function (yes) {
            if (!yes) { logWarn('本页不是驱动页，取消提交'); return; }
            capReached(function (stop) {
            if (stop) return;
            const $btn = $('.rate-publish-submit-button').first().length
              ? $('.rate-publish-submit-button').first()
              : $clickableByText('发布', true).first();
            if ($btn.length === 0) { updateStatus('没找到「发布」按钮。', '#e4393c'); return; }
            const wait = msStep() + 2000;
            updateStatus((PACING.humanDuration ? PACING.humanDuration(wait) : Math.round(wait / 1000) + ' 秒') + '后点「发布」...', 'blue');
            setTimeout(function () {
              forceSameTabNav($btn[0]);
              withOpenGuard(function () { $btn[0].click(); });
              updateStatus('已点「发布」，等页面反馈...', 'green');
              bumpDone(pendingReviewCount);
              setTimeout(function () {
                const body = document.body.innerText || '';
                const okText = /评价成功|发布成功|提交成功/.test(body);
                logInfo('发布后页面反馈', {
                  命中成功文案: okText,
                  片段: window.JDAR_LOG ? window.JDAR_LOG.tail(body, 120) : '',
                  url: location.href
                });
                if (PACING.looksLikeRiskControl && PACING.looksLikeRiskControl(body)) { stopForRisk('发布之后'); return; }
                if (okText) {
                  skipStreak = 0;          // 成功发表了一条 → 连续跳过计数清零
                  saveSkipState();
                  clearLastCard();         // 这一张卡片已经成功发完了
                  updateStatus('✅ 发布成功，回评价中心继续下一单。', 'green');
                  setTimeout(function () { location.href = 'https://comment.m.jd.com/pc-static/center'; }, rnd(2500, 5000));
                } else {
                  setRunning(false);
                  updateStatus('⚠️ 点了发布但没看到成功提示，已暂停，请人工看一眼页面。', '#e4393c');
                }
              }, rnd(7000, 12000));
            }, wait);
            });     // capReached
          });       // canDrive
        };

        if (!CFG.enableImage) { afterImage(); return; }

        const input = document.querySelector('input.uploadAddInput[type="file"]') ||
          document.querySelector('input[type="file"]');
        const p = { sku: sku, input: input, review: pickedReview };
        uploadForProduct(p).then(function (n) {
          if (n > 0) {
            const wait = rnd(sec2ms(CFG.imgUploadWaitMinSec, 8), sec2ms(CFG.imgUploadWaitMaxSec, 15));
            updateStatus('已注入 ' + n + ' 张图，等上传完成（随机 ' +
              (PACING.humanDuration ? PACING.humanDuration(wait) : Math.round(wait / 1000) + ' 秒') + '）...', 'blue');
            logInfo('等图片上传完成', { 张数: n, 等待毫秒: wait });
            return sleep(wait);
          }
          const act = noImageAction();
          if (act === 'pause') {
            setRunning(false);
            resumeAction = newPublishStep;
            updateStatus('❌ 一张图都没配到，已按设置暂停（点「开始」重试，或到设置页把「没配到图时」改成「跳过」）。', '#e4393c');
            throw 'PAUSED_NO_IMAGE';
          }
          if (act === 'skip') {
            skipThisOrder(productName, sku, 'noImage');
            throw 'PAUSED_NO_IMAGE';
          }
          // act === 'publish' → 无图也照发
        }).then(function () { afterImage(); }).catch(function (e) {
          if (e === 'PAUSED_NO_IMAGE' || e === 'PAUSED') return;
          updateStatus('配图出问题，跳过配图继续：' + e, 'red');
          afterImage();
        });
      };

      // 1) 正文（填完必须确认页面认账）
      const $box = $('textarea.rate-comment-content-textarea').first();
      if ($box.length === 0) {
        // 外卖/服务/已评价的单点进来就是这个样子：页面明说不能评价 → 跳过；说不清 → 停下问人
        bailNoBox(productName, sku, newPublishStep, '新发布页');
        return;
      }
      fillReview($box[0], review, function () {
        if (riskDetected($box[0])) { stopForRisk('发布页'); return; }
        updateStatus('正文已填入（' + countChars(review) + ' 字）', 'green');
        newPublishFillStars();   // 2) 星级（新版默认就是满分，通常不动）
        afterText();
      });
    }, function (errMsg) {
      setRunning(false);
      updateStatus('❌ 生成评价失败：' + errMsg + '。已暂停，点「开始」重试。', '#e4393c');
    });
  }

  /* ==================== 入口 ==================== */

  function dispatch() {
    if (CONTEXT_DEAD) {
      setStatusText('扩展刚被重新加载过，本页面里的旧脚本已失效 —— 按 F5 刷新本页面再用。', '#e4393c');
      return;
    }
    if (STOP_THIS_TAB) {
      setStatusText('本页已把运行权交给其他标签页，不再操作。', '#b7791f');
      return;
    }
    if (isNewPublishPage()) currentStep = newPublishStep;
    else if (isNewCenterList()) currentStep = newCenterListStep;
    else if (isOldSuccessPage()) currentStep = oldSuccessStep;
    else if (isOldListPage()) currentStep = oldListStep;
    else if (isOldReviewPage()) currentStep = startOldReview;
    else currentStep = null;

    if (!currentStep) {
      /* 刚点过一张卡片、结果落到一个我们不认识的页面上 —— 外卖单 / 服务单 / 已评价过的单就是这样。
         人已经点出去了，回头也只能靠"上一张卡片指纹"知道该跳过谁。 */
      if (running && justClickedUnknownCard()) {
        const hit = unreviewableHere();
        logWarn('进入了不认识的页面（刚点过一张卡片），按"这单无法评价"处理', {
          url: location.href,
          命中不能评价文案: hit || '(没有)',
          上一张卡片: lastCardText.slice(0, 40)
        });
        skipThisOrder(lastCardText, '', 'unreviewable', 40);
        return;
      }
      updateStatus('当前页面不是支持的评价页（老评价页 / 我的评价列表 / 评价中心 / 新发布页）。', '#e4393c');
      return;
    }
    if (running) {
      // 先确认自己是"驱动页"：同一时刻只允许一个标签页操作，避免多单同时提交
      canDrive(function (yes) {
        if (!yes) return;
        // 进任何一步之前先确认没到上限（双保险：列表步骤 + 发表步骤也各挡一道）
        capReached(function (stop) {
          if (stop) return;
          if (currentStep === startOldReview || currentStep === newPublishStep) {
            const wait = rnd(3000, 8000);
            updateStatus('循环中，随机等 ' + Math.round(wait / 1000) + ' 秒再开始这一单…', 'blue');
            setTimeout(function () { if (running) currentStep(); }, wait);
          } else {
            currentStep();
          }
        });
      });
    } else {
      updateStatus('点「开始」启动 / 继续自动评价循环。', 'blue');
    }
  }

  function init() {
    $ = window.jQuery;
    if (!$) { console.error('[京东自动评价] jQuery 没加载，扩展无法运行'); return; }

    // 页面级异常也记进日志，方便回看
    try {
      window.addEventListener('error', function (ev) {
        logErr('页面脚本错误', { msg: (ev && ev.message) || '', src: (ev && ev.filename) || '', line: (ev && ev.lineno) || 0 });
      });
      window.addEventListener('unhandledrejection', function (ev) {
        logErr('未处理的 Promise 异常', String((ev && ev.reason) || ''));
      });
    } catch (e) { /* ignore */ }

    createUI();
    renderPacingLine();
    renderModeLine();
    // 页面一加载就把 window.open 换成原地跳转：必须赶在页面异步调它之前装上
    installOpenGuard();

    // 设置页一保存，面板立刻同步刷新（同一份配置，不用刷新京东页面）
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes || !changes.config) return;
        logInfo('检测到设置页已保存，面板同步刷新');
        reloadConfig().then(function () {
          renderPacingLine();
          renderModeLine();
          applyPanelTheme();
        });
      });
    } catch (e) { /* ignore */ }

    bg('whoami', {}, 5000).then(function (r) {
      MY_TAB = (r && r.tabId != null) ? r.tabId : null;
      logInfo('本页标签 id', { tabId: MY_TAB });
    }).catch(function () { /* 拿不到就按 null 走 */ }).then(function () {
      return reloadConfig();
    }).catch(function (e) {
      console.warn('[京东自动评价] 读配置失败，用默认值：', e);
    }).then(function () {
      return loadRunProfile();
    }).then(function () {
      return loadSkipState();     // 跳过记录跨页面保留（连续跳过 3 单才停手）
    }).then(function () {
      return loadLastCard();      // 上一次点的是哪张卡片（点进去没法评价时用来跳过它）
    }).then(function () {
      // 配置读回来了：blockPopups 关掉的话把 window.open 还原回去
      if (CFG.blockPopups === false) uninstallOpenGuard(); else installOpenGuard();
      return storageGet(LOOP_KEY);
    }).then(function (v) {
      running = !!v;
      if (CFG.dryRun === undefined) CFG.dryRun = true;
      renderToggleBtn();
      renderPacingLine();
      renderModeLine();
      applyPanelTheme();     // 配置读回来了，按 panelTheme 定最终配色
      return loadPersistedLog();
    }).then(function () {
      dispatch();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
