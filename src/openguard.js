/**
 * 最早的一次 window.open 拦截 —— 必须跑在页面自己的脚本之前（manifest 里 run_at: document_start）。
 *
 * 为什么不能像以前那样在 content.js（document_idle）里替换：
 *   京东的评价中心是 SPA，它在启动时就把 window.open 存进了自己的变量（`const open = window.open` 之类）。
 *   等我们到 document_idle 才替换 window.open 时，页面早就在用那份**原生引用**了 ——
 *   于是「去评价」照样开新标签页；而老标签页只会看到"本页没跳转"，白等 8 秒、多攒一个标签页、
 *   还要走一轮"交出运行权 → 等别的标签页接手"。（2026-10-09 实测日志确认）
 * content script 的 document_start 早于页面任何脚本执行，这时替换才真正拦得住。
 *
 * 语义与以前完全一致：拿到的是**假窗口对象**，页面不会因为拿到 null 报错，
 * `w.location = url` / `w.location.href = url` 都变成**当前页跳转**。设置页关掉「把页面的新开标签页
 * 改成原地跳转」（config.blockPopups = false）时，会把原生 open 还原回去。
 */
(function () {
  'use strict';
  if (window.__JDAR_OPEN_GUARD__) return;
  window.__JDAR_OPEN_GUARD__ = true;

  const nativeOpen = window.open;
  window.__JDAR_NATIVE_OPEN__ = nativeOpen;

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

  window.open = function (url) {
    let target = '';
    try { target = String((url && url.href) || url || ''); } catch (e) { target = ''; }
    try { if (typeof window.__JDAR_ON_OPEN__ === 'function') window.__JDAR_ON_OPEN__(target); } catch (e) { }
    if (target) setTimeout(function () { try { location.href = target; } catch (e) { } }, 0);
    return fakeWindow(target);
  };

  // 页面里合法的 target="_blank" 锚点也一起中和成同页跳转
  try {
    document.addEventListener('click', function (ev) {
      let n = ev.target, depth = 0;
      while (n && n.tagName && n.tagName !== 'A' && depth < 6) { n = n.parentElement; depth++; }
      if (!n || !n.tagName || n.tagName !== 'A') return;
      if (String(n.target || '').toLowerCase() !== '_blank') return;
      const href = n.href;
      if (!href) return;
      ev.preventDefault();
      try { if (typeof window.__JDAR_ON_OPEN__ === 'function') window.__JDAR_ON_OPEN__(href); } catch (e) { }
      location.href = href;
    }, true);
  } catch (e) { /* ignore */ }

  // 配置里关掉了这个开关 → 立刻还原原生 open（配置读回来前的这一小段仍按"拦截"走，可接受）
  try {
    chrome.storage.local.get('config', function (o) {
      const cfg = (o && o.config) || {};
      if (cfg.blockPopups === false) {
        try { window.open = nativeOpen; window.__JDAR_OPEN_GUARD__ = false; } catch (e) { }
      }
    });
  } catch (e) { /* ignore */ }
})();
