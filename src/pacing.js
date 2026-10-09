/**
 * 节奏与风控（纯函数，可单测）
 *   · 随机间隔：永远不要用固定秒数，固定节奏本身就是脚本特征
 *   · 分块打字：像人一样一小段一小段输入，而不是一次性赋值
 *   · 计数校验：读页面自己的「已写 N 字 / N / 500」，确认这一页真的认了我们填的字
 *   · 风控识别：页面出现「正在维修 / 系统繁忙 / 安全验证」就立刻停手
 */
(function (root) {
  'use strict';

  /** min~max 之间的整数（含端点）；传反了自动交换 */
  function randBetween(min, max) {
    let a = Math.round(Number(min));
    let b = Math.round(Number(max));
    if (!isFinite(a)) a = 0;
    if (!isFinite(b)) b = a;
    if (a > b) { const t = a; a = b; b = t; }
    if (a === b) return a;
    return a + Math.floor(Math.random() * (b - a + 1));
  }

  /**
   * 把文字切成 lo~hi 字的小块（模拟打字节奏）。
   * 先按 hi 算出需要几块，再把长度均分并加一点抖动 —— 保证每块都落在 [lo, hi]，
   * 不会出现「最后剩 2 个字」这种明显不像打字的尾巴。
   */
  function splitChunks(text, lo, hi) {
    const s = String(text == null ? '' : text);
    const a = Math.max(1, lo || 6);
    const b = Math.max(a, hi || 14);
    if (!s.length) return [];
    const n = Math.max(1, Math.ceil(s.length / b));
    const out = [];
    let i = 0;
    for (let k = 0; k < n; k++) {
      const remaining = s.length - i;
      const left = n - k;
      if (left <= 1) { out.push(s.slice(i)); break; }
      let want = Math.round(remaining / left) + randBetween(-2, 2);
      want = Math.max(a, Math.min(b, want));
      const maxNow = remaining - a * (left - 1);   // 给后面每块至少留 a 个字
      want = Math.min(want, Math.max(a, maxNow));
      want = Math.max(1, Math.min(want, remaining));
      out.push(s.slice(i, i + want));
      i += want;
    }
    return out.filter(Boolean);
  }

  /**
   * 从页面文字里读字数计数：
   *   新版「已写94个字」 / 老版「0 / 500」
   * 读不到返回 null —— 表示这页没有可读的计数器，不能据此判定失败。
   */
  function parseCountText(text) {
    const t = String(text || '');
    let m = t.match(/已写\s*(\d+)\s*个字/);
    if (m) return Number(m[1]);
    m = t.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return Number(m[1]);
    m = t.match(/已输入\s*(\d+)\s*字/);
    if (m) return Number(m[1]);
    return null;
  }

  /** 页面计数是否认账；读不到计数就当作认账（无法判定时不阻塞流程） */
  function counterAccepted(counter, expected) {
    if (counter == null) return true;
    return Math.abs(Number(counter) - Number(expected)) <= 1;
  }

  /** 京东风控/维护类提示（评价区被软封的原文签名就是这些词） */
  /**
   * 「硬风控」词：正常页面正文里基本不会出现，命中就可疑。
   *
   * ⚠️ 2026-10-09 事故：这里原先还有 `/无法评价/`，而识别是拿**整页文本**去匹配的 ——
   * 发布页正文里只要有一句普通的「无法评价」，整轮就被掐死（日志只有一句"出现风控/维护提示"，
   * 不写命中了哪个词，根本查不出来）。
   * 现在两处改了：① 把「无法评价」挪到 RISK_PATTERNS_WEAK（它本来就该由"这单没法评价"的专门识别负责）；
   *              ② 这些词也不再单独构成停手理由，必须同时有**结构信号**（弹层里出现 / 整页被替换），见 content.js。
   */
  const RISK_PATTERNS = [
    /正在维修/,
    /系统繁忙/,
    /操作过于频繁/,
    /访问受限/,
    /账号异常/,
    /安全验证/,
    /请稍后重试/
  ];

  /**
   * 「弱风控」词：真风控页上一定有，但**正常页面里也会出现**（帮助链接、FAQ、页脚提示……）。
   * 只有在「出现在弹层里」或「整页被替换成短短一句话」时才算数。
   */
  const RISK_PATTERNS_WEAK = [
    /验证码/,
    /图灵/,
    /滑块验证/,
    /拖动滑块/,
    /人机/,
    /无法评价/
  ];

  /** 命中「硬风控」词就返回那个词，没命中返回 ''。返回词而不是 true/false —— 日志里要写清是哪个词 */
  function matchRisk(text) {
    const t = String(text || '');
    if (!t) return '';
    for (let i = 0; i < RISK_PATTERNS.length; i++) {
      const m = t.match(RISK_PATTERNS[i]);
      if (m) return m[0];
    }
    return '';
  }

  /** 命中「弱风控」词就返回那个词，没命中返回 '' */
  function matchRiskWeak(text) {
    const t = String(text || '');
    if (!t) return '';
    for (let i = 0; i < RISK_PATTERNS_WEAK.length; i++) {
      const m = t.match(RISK_PATTERNS_WEAK[i]);
      if (m) return m[0];
    }
    return '';
  }

  /** 兼容老签名：只认「硬风控」词，返回布尔 */
  function looksLikeRiskControl(text) {
    return !!matchRisk(text);
  }

  /** 把毫秒说成人话：45 秒 / 1 分 20 秒 */
  function humanDuration(ms) {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    if (s < 60) return s + ' 秒';
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  /**
   * 配置里的节奏一律以【秒】保存（界面上填的就是秒），代码内部换算成毫秒。
   * 支持小数秒（2.5 → 2500）、字符串数字、缺省兜底；负数/非法一律按兜底或 0 处理。
   */
  function sec2ms(v, dfltSec) {
    // 空值（undefined / null / ''）按「没填」处理，走兜底；0 是有效值（不等待）
    const raw = (v === undefined || v === null || v === '') ? dfltSec : v;
    const n = Number(raw);
    const sec = isFinite(n) ? n : (Number(dfltSec) || 0);
    return Math.max(0, Math.round(sec * 1000));
  }

  /** 旧版把节奏存成毫秒（如 clickDelayMin: 4000），现在统一存秒 */
  const LEGACY_PACING = [
    ['clickDelayMin', 'clickDelayMinSec'], ['clickDelayMax', 'clickDelayMaxSec'],
    ['stepDelayMin', 'stepDelayMinSec'], ['stepDelayMax', 'stepDelayMaxSec'],
    ['orderDelayMin', 'orderDelayMinSec'], ['orderDelayMax', 'orderDelayMaxSec'],
    ['uploadWaitTimeout', 'uploadWaitTimeoutSec']
  ];

  /** 就地迁移旧毫秒字段到秒；返回是否改动过。≥1000 视为毫秒。 */
  function migrateLegacyPacing(cfg, legacyMap) {
    if (!cfg || typeof cfg !== 'object') return false;
    const map = legacyMap || LEGACY_PACING;
    let changed = false;
    map.forEach(function (p) {
      const oldK = p[0], newK = p[1];
      if (cfg[oldK] == null) return;
      const v = Number(cfg[oldK]);
      if (cfg[newK] == null && isFinite(v)) {
        cfg[newK] = (v >= 1000) ? Math.round(v / 100) / 10 : v;   // 4000ms → 4 秒，1500ms → 1.5 秒
      }
      delete cfg[oldK];
      changed = true;
    });
    return changed;
  }

  /**
   * 节奏兜底（就地改 cfg，返回被纠正的项名）：
   *   · 缺值 → 补默认
   *   · 上限 ≤ 0 秒 → 视为配置错误（否则会变成"完全不等待"）→ 整组回默认
   *   · 负数 → 0；min > max → 交换
   */
  function sanitizePacing(cfg, defaults) {
    const D = defaults || {};
    const fixed = [];
    if (!cfg || typeof cfg !== 'object') return fixed;
    [['clickDelayMinSec', 'clickDelayMaxSec'],
     ['stepDelayMinSec', 'stepDelayMaxSec'],
     ['orderDelayMinSec', 'orderDelayMaxSec'],
     ['imgUploadGapMinSec', 'imgUploadGapMaxSec'],
     ['imgUploadWaitMinSec', 'imgUploadWaitMaxSec']].forEach(function (p) {
      let a = Number(cfg[p[0]]);
      let b = Number(cfg[p[1]]);
      const da = Number(D[p[0]]);
      const db = Number(D[p[1]]);
      if (!isFinite(a)) a = isFinite(da) ? da : 0;
      if (!isFinite(b)) b = isFinite(db) ? db : a;
      if (b <= 0) {
        a = isFinite(da) ? da : 0;
        b = isFinite(db) ? db : 0;
        fixed.push(p[0]);
      }
      if (a < 0) { a = 0; fixed.push(p[0]); }
      if (a > b) { const t = a; a = b; b = t; fixed.push(p[0]); }
      cfg[p[0]] = a;
      cfg[p[1]] = b;
    });
    const upRaw = cfg.uploadWaitTimeoutSec;
    const up = Number(upRaw);
    if (!isFinite(up) || up <= 0) {
      cfg.uploadWaitTimeoutSec = Number(D.uploadWaitTimeoutSec) || 15;
      // 只有「填了但填错」才报；压根没填（老配置/首次安装）属于正常补默认
      if (upRaw !== undefined && upRaw !== null && upRaw !== '') fixed.push('uploadWaitTimeoutSec');
    }
    // 后台并发：1~5，非法值回默认（1）
    const mcRaw = cfg.maxConcurrent;
    const mc = Number(mcRaw);
    if (!isFinite(mc) || mc < 1) {
      cfg.maxConcurrent = Number(D.maxConcurrent) || 1;
      if (mcRaw !== undefined && mcRaw !== null && mcRaw !== '') fixed.push('maxConcurrent');
    } else if (mc > 5) {
      cfg.maxConcurrent = 5;
      fixed.push('maxConcurrent');
    } else {
      cfg.maxConcurrent = Math.floor(mc);
    }
    return fixed;
  }

  /**
   * 运行权（lease）判定：同一时刻只允许一个标签页在跑。
   * @returns {'mine'|'take'|'wait'} mine=本来就是我的；take=可以拿；wait=别人正在跑，等着
   */
  function leaseOwner(current, tabId, now, ttl) {
    const t = Number(ttl) || 30000;
    const at = Date.now();
    const n = Number(now) || at;
    if (!current || !current.at) return 'take';
    if (tabId != null && current.tabId === tabId) return 'mine';
    if ((n - Number(current.at)) > t) return 'take';   // 心跳过期 = 驱动页没了，可以接管
    return 'wait';
  }

  /**
   * 运行权槽位判定（同一时刻最多允许 limit 个标签页在跑）。
   * @param {object} slots { tabId: 心跳时间戳 }
   * @returns {{verdict:'mine'|'take'|'wait', live:object, count:number}}
   *   mine = 我已在槽里（续约）；take = 有空位可占；wait = 满员，等着
   */
  function leaseSlots(slots, tabId, now, ttl, limit) {
    const t = Number(ttl) || 30000;
    const n = Number(now) || Date.now();
    const max = Math.max(1, Number(limit) || 1);
    const live = {};
    const src = slots || {};
    Object.keys(src).forEach(function (k) {
      const at = Number(src[k]);
      if (at && (n - at) <= t) live[k] = at;      // 心跳过期的直接丢掉
    });
    const me = String(tabId);
    const count = Object.keys(live).length;
    if (live[me]) return { verdict: 'mine', live: live, count: count };
    if (count < max) return { verdict: 'take', live: live, count: count };
    return { verdict: 'wait', live: live, count: count };
  }

  /**
   * 单轮上限判定：只按「本轮已发几条评价」算（0 = 不限）。返回 '' / 'reviews'
   * 为什么不按订单数：新评价中心是「一个订单一件商品、单独评价」，按条最直观；
   * 老评价页一页可能多件商品，但检查发生在发表前，整单会一起发完、不会被半路截断。
   */
  function runLimitHit(state, limits) {
    const s = state || {};
    const L = limits || {};
    const reviews = Number(s.reviews) || 0;
    const maxReviews = Number(L.maxReviews) || 0;
    if (maxReviews && reviews >= maxReviews) return 'reviews';
    return '';
  }

  /**
   * 从「元素自己 → 各级祖先」的文本列表里，挑出**一张卡片**的文本。
   *
   * 为什么必须有这个上界（2026-10-09 实测事故）：
   *   跳过 1 单时把"列表容器"（装了很多张卡片的那个 div）的文本当成了商品名存成指纹，
   *   那个文本是 3 张卡片拼起来的；下一轮列表页用这条指纹去匹配，**一次误伤 3 张无关卡片**
   *   （把它们的「去评价」全过滤掉），剩下的候选只剩卡片容器本身 —— 点它没有任何反应，
   *   于是"点不动 → 跳过 → 回列表"无限循环，一张评价都发不出去。
   *
   * 判据：文本长度落在 [minLen, maxLen]，并且里面的**标记词**（就是刚点的那个按钮文字，
   * 例如「去评价」）出现次数不超过 markerMax —— 出现两次以上就说明这个节点装了好几张卡片。
   * 按「自己 → 祖先」的顺序找，第一个合格的即为该卡片。
   *
   * @param {string[]} texts 元素自己、父元素、祖父元素……的文本（已归一化）
   * @param {{minLen?:number,maxLen?:number,marker?:string,markerMax?:number}} [opts]
   * @returns {string} 命中的卡片文本；没有合格的（说明已经走到列表容器了）返回 ''
   */
  function pickCardText(texts, opts) {
    const o = opts || {};
    const min = Math.max(1, Number(o.minLen) || 6);
    const max = Math.max(min, Number(o.maxLen) || 400);
    const marker = o.marker ? String(o.marker) : '';
    const hasCap = (o.markerMax != null) && isFinite(Number(o.markerMax));
    const cap = hasCap ? Number(o.markerMax) : 1;
    const list = texts || [];
    for (let i = 0; i < list.length; i++) {
      const t = String(list[i] == null ? '' : list[i]);
      if (t.length < min) continue;
      if (t.length > max) return '';           // 已经比一张卡片还大，再往上只会更大 → 放弃
      if (marker) {
        let n = 0, from = 0;
        for (;;) {
          const at = t.indexOf(marker, from);
          if (at === -1) break;
          n++; from = at + marker.length;
          if (n > cap) break;
        }
        if (n > cap) return '';                // 装了不止一张卡片 → 这就是列表容器，放弃
      }
      return t;
    }
    return '';
  }

  /** 商品名里的"噪音"：空白、标点、括号、引号、斜杠 —— 指纹与卡片比对必须用同一套归一化，
      否则「鲜窝窝酸梅条，150g」这类带逗号的名字存下来的指纹在卡片文本里匹配不上。 */
  const NAME_NOISE = /[\s，。！？；、,.!?;:：()（）\[\]【】/\\|"'“”‘’《》<>+~\-—_]+/g;

  function normalizeName(s) {
    return String(s == null ? '' : s).replace(NAME_NOISE, '');
  }

  /** 商品名指纹：去掉空白/标点后取前 n 个字（默认 12, 最小 4）—— 用来在列表页认出"跳过过的那个商品" */
  function nameKey(s, n) {
    const k = Math.max(4, Number(n) || 12);
    return normalizeName(s).slice(0, k);
  }

  /**
   * 「这一单根本没法评价」的页面文案特征。
   * 为什么单独一份：京东外卖、服务类订单、已评价过的单、活动结束的单，
   * 点进去是一个**没有输入框**的页面 —— 以前会卡在那儿不动，现在认出来直接跳过。
   * 只收明确表达「不能评价」的说法，避免误伤正常的发布页。
   */
  const UNREVIEWABLE_PATTERNS = [
    '暂无可评价', '没有可评价', '无待评价', '暂不支持评价', '不支持评价',
    '不可评价', '无法评价', '不能评价', '已关闭评价', '评价已关闭',
    '该订单已评价', '订单已评价', '已评价过', '评价活动已结束', '评价已结束',
    '该商品不支持评价', '此订单不支持评价', '没有可评价的商品'
  ];

  /**
   * 页面文本里有没有「没法评价」的说法。命中返回命中的那个词，否则 ''。
   * 只在「找不到输入框」时才调用 —— 正常页面就算含这些词也不会被拿来判断。
   */
  function looksUnreviewable(text, patterns) {
    const p = (patterns && patterns.length) ? patterns : UNREVIEWABLE_PATTERNS;
    const t = String(text == null ? '' : text).replace(/\s+/g, '');
    if (!t) return '';
    for (let i = 0; i < p.length; i++) {
      if (t.indexOf(p[i]) !== -1) return p[i];
    }
    return '';
  }

  /** 卡片文本里是否含"跳过过的商品"；names 是 {指纹:1}
      两边都做同一套归一化（去空白+去标点），否则带逗号的商品名会匹配不上 */
  function isSkippedText(cardText, names) {
    const keys = Object.keys(names || {});
    if (!keys.length) return false;
    const t = normalizeName(cardText);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] && t.indexOf(keys[i]) !== -1) return true;
    }
    return false;
  }

  root.JDAR_PACING = {
    randBetween: randBetween,
    splitChunks: splitChunks,
    parseCountText: parseCountText,
    counterAccepted: counterAccepted,
    looksLikeRiskControl: looksLikeRiskControl,
    matchRisk: matchRisk,
    matchRiskWeak: matchRiskWeak,
    humanDuration: humanDuration,
    sec2ms: sec2ms,
    migrateLegacyPacing: migrateLegacyPacing,
    sanitizePacing: sanitizePacing,
    leaseSlots: leaseSlots,
    runLimitHit: runLimitHit,
    nameKey: nameKey,
    normalizeName: normalizeName,
    pickCardText: pickCardText,
    isSkippedText: isSkippedText,
    looksUnreviewable: looksUnreviewable,
    UNREVIEWABLE_PATTERNS: UNREVIEWABLE_PATTERNS,
    LEGACY_PACING: LEGACY_PACING,
    RISK_PATTERNS: RISK_PATTERNS,
    RISK_PATTERNS_WEAK: RISK_PATTERNS_WEAK
  };
})(typeof window !== 'undefined' ? window : globalThis);
