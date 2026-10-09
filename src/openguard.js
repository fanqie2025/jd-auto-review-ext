/**
 * 尽量把页面的"新开标签页"改成原地跳转。
 *
 * ⚠️ **能力边界（2026-10-09 实测更正，别被本文件骗了）**
 * 内容脚本跑在**隔离世界（isolated world）**里 —— 在这里给 `window.open` 赋值，
 * **改不到页面自己那份引用**。所以：
 *   · `target="_blank"` 锚点 → 拦得住（点击监听挂在共享的 DOM 上）；
 *   · 页面自己在脚本里调 `window.open`（新版评价中心的「去评价」就是这种）→ **拦不住**，照样开新标签页。
 * 拦不住**不影响正确性**：那种情况由 content.js 里的「运行权」把控制权交给新标签页，
 * 旧页 2.5 秒内安静停手，不会出现两个页面同时提交。代价是每处理一单多一个标签页。
 *
 * 之所以仍然保留这个文件：
 *   ① `target="_blank"` 那条确实有效；
 *   ② 给页面一个**假窗口对象**，避免页面因为拿到 `null` 报错（这条在隔离世界里其实也只能影响我们自己的调用，
 *      但保留着无害，且与旧行为一致）；
 *   ③ run_at: document_start 保证点击监听最早挂上，且不会受页面后续 DOM 重建影响。
 *
 * 真正的开关：本文件与 content.js 同在隔离世界，所以能直接读 chrome.storage 的 config.blockPopups；
 * 关掉时把原生 open 还原回去（见文件末尾）。
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
