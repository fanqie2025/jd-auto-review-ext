/**
 * 后台服务（MV3 service worker）
 * 只做三件页面里做不到的事：
 *   1. 调大模型（扩展的 host_permissions 让它不受页面 CORS 限制）
 *   2. 抓京东晒单图接口（跨域：comment.m.jd.com 页面上取不到 club.jd.com）
 *   3. 抓 360buyimg 的图片字节并转 base64（页面里 fetch 会被 CORS 挡）
 * 页面里的填写 / 上传 / 点击全部由 content.js 完成。
 *
 * ── 来源与致谢（改动请一并保留本段）────────────────────────────────────────
 * 晒单图接口 `club.jd.com/discussion/getProductPageImageCommentList.action`
 *   与 charmingYouYou/JDAIAutoComment v8.6（MIT，© charmingYouYou）里的同一接口一致；
 * 评价池接口 `club.jd.com/comment/productPageComments.action` 及其参数组合
 *   取自 hezhengtao/jd-smart-assistant v4.1（MIT，© hezhengtao）——「爬好评+晒单图、零 API 费用」的路线也来自它。
 * 完整出处、许可原文与逐条行号见仓库根 THIRD-PARTY-NOTICES.md。本项目仅供个人学习自用。
 * ──────────────────────────────────────────────────────────────────────
 */
importScripts('defaults.js');
importScripts('log.js');
importScripts('netutil.js');
importScripts('textsource.js');

const CONFIG_KEY = 'config';
const LOG_KEY = 'JDAR_LOG';
const LOG_MAX = 800;        // 环形缓冲：最多留 800 条

async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return Object.assign({}, JDAR_DEFAULTS, stored[CONFIG_KEY] || {});
}

/* ---------------- 日志（跨页面续接的唯一写入口） ---------------- */

async function appendLogs(entries) {
  if (!entries || !entries.length) return 0;
  const stored = await chrome.storage.local.get(LOG_KEY);
  let arr = stored[LOG_KEY] || [];
  arr = arr.concat(entries);
  if (arr.length > LOG_MAX) arr = arr.slice(arr.length - LOG_MAX);
  await chrome.storage.local.set({ [LOG_KEY]: arr });
  return arr.length;
}

function logBg(level, msg, data) {
  const L = self.JDAR_LOG;
  const entry = {
    t: Date.now(),
    level: level,
    msg: String(msg == null ? '' : msg),
    data: L ? L.fmtData(data) : '',
    page: 'background'
  };
  try { console.log('[京东自动评价/BG]', L ? L.entryToLine(entry) : (level + ' ' + msg)); } catch (e) { /* ignore */ }
  appendLogs([entry]).catch(function () { /* ignore */ });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error((label || '请求') + '超时')), ms))
  ]);
}

/* ---------------- 编码安全的 JSON 读取 ---------------- */

/**
 * 京东老接口返回 GBK 字节，resp.json() 会按 UTF-8 解出一堆 �（"未知字符"的真身）。
 * 统一走这里：先严格 UTF-8，失败/有替换字符就改 GBK，并记一条日志说明。
 */
async function readJsonSmart(resp, label) {
  const buf = await resp.arrayBuffer();
  const r = self.JDAR_NET.decodeBytes(new Uint8Array(buf));
  if (r.encoding !== 'utf-8' || r.replaced) {
    logBg('warn', '响应不是 UTF-8，已按 GBK 解码', { 接口: label || '', 编码: r.encoding, 替换字符: r.replaced });
  }
  return JSON.parse(r.text);
}

/* ---------------- 1. 大模型 ---------------- */

const normalizeChatUrl = self.JDAR_NET.normalizeChatUrl;
const sanitizeKey = self.JDAR_NET.sanitizeKey;
const assertHeaderSafe = self.JDAR_NET.assertHeaderSafe;

async function llmGenerate({ productName, attempt }) {
  const cfg = await getConfig();
  if (!cfg.apiKey || !String(cfg.apiKey).trim()) {
    throw new Error('还没填 API 密钥（点扩展图标 → 设置）');
  }
  const url = normalizeChatUrl(cfg.apiUrl);
  const key = sanitizeKey(cfg.apiKey);
  assertHeaderSafe(key);
  const min = Number(cfg.minReviewChars) || 60;
  logBg('info', '调用大模型', {
    model: cfg.modelName,
    attempt: attempt || 0,
    url: url,
    urlRewritten: url !== String(cfg.apiUrl || '').trim() ? true : undefined,
    product: (self.JDAR_LOG ? self.JDAR_LOG.tail(productName, 30) : productName)
  });
  const strictHint = (attempt || 0) > 0
    ? '\n\n【字数警告】上一次输出不足 ' + min + ' 字。这次必须写到 70~90 个汉字，' +
      '多用具体细节（材质、尺寸、手感、使用场景）把句子撑开，禁止短句敷衍。'
    : '';

  const body = {
    model: cfg.modelName,
    messages: [{
      role: 'system',
      content: '你是一名真实的网购买家。我刚买了商品，商品全称是:【' + productName + '】。\n\n' +
        '请写一段70到100字的商品评价，严格遵守以下纪律：\n' +
        '1. 必须根据名称推断出它具体是什么东西（比如是保鲜膜、垃圾袋还是零食），然后只评价它该有的特定属性（如保鲜膜就评价粘性/厚度/好撕，垃圾袋评价承重/不漏）。\n' +
        '2. 绝对禁止使用“物流快”、“客服好”、“包装严实”等万能模板废话。\n' +
        '3. 不要把商品全名抄一遍，用“这款”、“这个”代替。\n' +
        '4. 字数必须不少于65个汉字（不足会被打回重写）。直接输出纯文本正文，绝对不要有任何前缀或提示语。' +
        strictHint
    }]
  };

  const resp = await withTimeout(fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify(body)
  }), 60000, '大模型请求');

  const text = await resp.text();
  if (!resp.ok) {
    // 尽量把接口自己的错误说明抠出来（实测 DeepSeek 401 会返回 {"error":{"message":"Authentication Fails…"}}）
    let hint = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      if (j && j.error && j.error.message) hint = j.error.message;
      else if (j && j.message) hint = j.message;
    } catch (e) { /* 不是 JSON 就用原文 */ }
    throw new Error('接口返回 HTTP ' + resp.status + '：' + hint);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('接口返回的不是 JSON：' + text.slice(0, 200)); }
  if (data.error) throw new Error(data.error.message || data.error.code || '接口返回 error');

  const content = data.choices && data.choices.length ? data.choices[0].message.content : '';
  if (!content || content.trim().length <= 5) throw new Error('返回内容过短或为空');
  return { text: content.trim() };
}

/* ---------------- 1.5 探测模型（GET /v1/models） ---------------- */

async function listModels() {
  const cfg = await getConfig();
  const url = self.JDAR_NET.modelsUrlFromChatUrl(cfg.apiUrl);
  if (!url) throw new Error('接口地址没填，没法推模型列表地址');
  const key = sanitizeKey(cfg.apiKey);
  assertHeaderSafe(key);
  const headers = {};
  if (key) headers['Authorization'] = 'Bearer ' + key;

  logBg('info', '探测模型列表', { url: url, hasKey: !!key });
  const resp = await withTimeout(fetch(url, { method: 'GET', headers: headers }), 20000, '模型列表请求');
  const text = await resp.text();
  if (!resp.ok) {
    let hint = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      if (j && j.error && j.error.message) hint = j.error.message;
      else if (j && j.message) hint = j.message;
    } catch (e) { /* 用原文 */ }
    throw new Error('HTTP ' + resp.status + '：' + hint);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('返回的不是 JSON：' + text.slice(0, 200)); }
  const arr = (data && (data.data || data.models)) || [];
  const ids = arr
    .map(function (x) { return (typeof x === 'string') ? x : (x && (x.id || x.model || x.name)); })
    .filter(Boolean);
  logBg('info', '模型列表取回', { count: ids.length, url: url });
  return { url: url, ids: ids };
}

/* ---------------- 2. 晒单图 URL 列表 ---------------- */

async function fetchShandanImages({ productId }) {
  const api = 'https://club.jd.com/discussion/getProductPageImageCommentList.action' +
    '?productId=' + encodeURIComponent(productId) + '&isShadowSku=0&page=1&pageSize=10';
  const resp = await withTimeout(fetch(api, { credentials: 'include' }), 20000, '晒单图接口');
  if (!resp.ok) throw new Error('晒单图接口 HTTP ' + resp.status);
  const data = await readJsonSmart(resp, '晒单图接口');
  const list = (data && data.imgComments && data.imgComments.imgList) || [];
  return { urls: list.map(x => x && x.imageUrl).filter(Boolean) };
}

/* ---------------- 2.5 评价池：文字 + 这条评价自带的图 ---------------- */

// 缩略图换大图；补全 // 开头的协议相对地址
function normalizeImageUrl(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (s.indexOf('//') === 0) s = 'https:' + s;
  else if (!/^https?:\/\//i.test(s)) s = 'https://img30.360buyimg.com/' + s.replace(/^\/+/, '');
  s = s.replace(/\/s\d+x\d+_/i, '/s800x800_');   // s128x96_ / s300x300_ -> s800x800_
  return s;
}

function pickCommentText(vo) {
  if (!vo) return '';
  const raw = vo.vcontent || vo.content || '';
  // 在源头就清洗：还原 &ldquo; 这类字符实体、去标签、去空白、掐句末碎片
  return self.JDAR_TEXT ? self.JDAR_TEXT.cleanReviewText(raw) : String(raw).replace(/\s+/g, '');
}

/**
 * 拉「现成评价池」：同一个 discussionId 归一条，文字取最长的那份，图片全部合并。
 * 两个接口互补：晒单图接口必带图；商品评价接口文字更长、单页更多。
 */
async function fetchReviewPool({ productId, pageSize }) {
  const reviews = new Map();
  const errors = [];
  logBg('info', '开始取评价池', { productId: productId, pageSize: pageSize || 10 });

  const take = (id, content, score, extra, imgs) => {
    const key = String(id || ('x' + reviews.size));
    let r = reviews.get(key);
    if (!r) {
      r = { discussionId: key, content: '', score: 0, creationTime: '', client: '', images: [] };
      reviews.set(key, r);
    }
    if (content && content.length > r.content.length) r.content = content;
    if (score) r.score = Number(score) || r.score;
    if (extra && extra.creationTime) r.creationTime = extra.creationTime;
    if (extra && extra.client) r.client = extra.client;
    (imgs || []).forEach((u) => {
      const n = normalizeImageUrl(u);
      if (n && r.images.indexOf(n) === -1) r.images.push(n);
    });
  };

  // ① 晒单图接口：一条评价 = 多张图 + 该评价全文
  try {
    const api = 'https://club.jd.com/discussion/getProductPageImageCommentList.action' +
      '?productId=' + encodeURIComponent(productId) + '&isShadowSku=0&page=1&pageSize=' + (pageSize || 10);
    const resp = await withTimeout(fetch(api, { credentials: 'include' }), 20000, '晒单图接口');
    if (resp.ok) {
      const data = await readJsonSmart(resp, '晒单图接口');
      const list = (data && data.imgComments && data.imgComments.imgList) || [];
      list.forEach((x) => {
        const vo = x && x.commentVo;
        if (!vo) return;
        take(vo.id || vo.discussionId, pickCommentText(vo), vo.score,
          { creationTime: vo.creationTime, client: vo.userClientShow }, [x.imageUrl]);
      });
    } else {
      errors.push('晒单图接口 HTTP ' + resp.status);
    }
  } catch (e) { errors.push('晒单图接口：' + (e && e.message || e)); }

  // ② 商品评价接口：文字更长、单页更多，且自带 images[]
  try {
    const api = 'https://club.jd.com/comment/productPageComments.action' +
      '?productId=' + encodeURIComponent(productId) + '&score=0&sortType=5&page=0&pageSize=30&isShadowSku=0&fold=1';
    const resp = await withTimeout(fetch(api, { credentials: 'include' }), 20000, '评价接口');
    if (resp.ok) {
      const data = await readJsonSmart(resp, '商品评价接口');
      const list = (data && data.comments) || [];
      list.forEach((c) => {
        take(c.id || c.discussionId, pickCommentText(c), c.score,
          { creationTime: c.creationTime, client: '' },
          (c.images || []).map((i) => i && i.imgUrl));
      });
    } else {
      errors.push('评价接口 HTTP ' + resp.status);
    }
  } catch (e) { errors.push('评价接口：' + (e && e.message || e)); }

  const cfg = await getConfig();
  const minChars = Number(cfg.minReviewChars) || 60;
  const out = Array.from(reviews.values());
  const withImg = out.filter(function (r) { return r.images && r.images.length; }).length;
  const longEnough = out.filter(function (r) { return (r.content || '').length >= minChars; }).length;
  logBg('info', '评价池取回', {
    reviews: out.length, withImages: withImg, longEnough: longEnough,
    errors: errors.length ? errors : undefined
  });
  return { reviews: out, errors: errors };
}

/* ---------------- 3. 图片字节 -> base64 ---------------- */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchImageBase64({ url }) {
  const resp = await withTimeout(fetch(url, { credentials: 'omit' }), 30000, '图片下载');
  if (!resp.ok) throw new Error('图片 HTTP ' + resp.status);
  const buf = await resp.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw new Error('图片为空');
  if (buf.byteLength > 6 * 1024 * 1024) throw new Error('图片超过 6MB，跳过');
  const type = resp.headers.get('content-type') || '';
  logBg('debug', '图片下载完成', { bytes: buf.byteLength, type: type, url: (self.JDAR_LOG ? self.JDAR_LOG.tail(url, 90) : url) });
  return { base64: arrayBufferToBase64(buf), contentType: type, bytes: buf.byteLength };
}

/* ---------------- 4. 测试（设置页按钮用，走的是和实跑完全相同的代码路径） ---------------- */

async function testLlm({ productName }) {
  const started = Date.now();
  const cfg = await getConfig();
  const rawUrl = String(cfg.apiUrl || '').trim();
  const url = normalizeChatUrl(cfg.apiUrl);
  const info = {
    apiUrl: rawUrl,
    url: url || rawUrl,
    urlRewritten: !!url && url !== rawUrl,
    model: cfg.modelName,
    hasKey: !!sanitizeKey(cfg.apiKey),
    minChars: Number(cfg.minReviewChars) || 60
  };
  try {
    const r = await llmGenerate({ productName: productName || '真空保温杯 316不锈钢 500ml', attempt: 0 });
    const text = r.text || '';
    const chars = text.replace(/\s+/g, '').length;
    const ms = Date.now() - started;
    logBg('info', '大模型测试成功', { ms: ms, chars: chars, model: cfg.modelName });
    return { ok: true, ms: ms, chars: chars, passMinChars: chars >= info.minChars, text: text, info: info };
  } catch (e) {
    const ms = Date.now() - started;
    const msg = String((e && e.message) || e);
    logBg('error', '大模型测试失败', { ms: ms, error: msg });
    return { ok: false, ms: ms, error: msg, info: info };
  }
}

async function testPool({ productId }) {
  const started = Date.now();
  try {
    const r = await fetchReviewPool({ productId: String(productId || ''), pageSize: 10 });
    const ms = Date.now() - started;
    const cfg = await getConfig();
    const min = Number(cfg.minReviewChars) || 60;
    const out = r.reviews || [];
    const withImg = out.filter(function (x) { return x.images && x.images.length; }).length;
    const longEnough = out.filter(function (x) { return (x.content || '').length >= min; }).length;
    const sample = out.slice(0, 3).map(function (x) {
      return { 字数: (x.content || '').length, 图: (x.images || []).length, 开头: (x.content || '').slice(0, 40) };
    });

    // 顺带给一份"实际会填进去的文案"预览：走的是和实跑完全相同的组稿逻辑
    let preview = null;
    try {
      if (self.JDAR_TEXT && out.length) {
        const p = self.JDAR_TEXT.pickReviewText(out, min, {
          mode: cfg.textComposeMode || 'merge',
          poolSize: Number(cfg.textPoolSize) || 10,
          maxChars: Number(cfg.textMaxChars) || 120,
          minScore: Number(cfg.minScore == null ? 4 : cfg.minScore)
        });
        preview = {
          source: p.source,
          chars: p.text.length,
          materials: (p.sources || []).length,
          text: p.text
        };
      }
    } catch (e) { preview = null; }

    return {
      ok: true, ms: ms, total: out.length, withImages: withImg, longEnough: longEnough,
      errors: r.errors || [], sample: sample, minChars: min, preview: preview
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String((e && e.message) || e) };
  }
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'getConfig') {
    getConfig().then(cfg => sendResponse({ ok: true, config: cfg })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'llmGenerate') {
    llmGenerate(msg).then(r => sendResponse({ ok: true, text: r.text })).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'fetchShandanImages') {
    fetchShandanImages(msg).then(r => sendResponse({ ok: true, urls: r.urls })).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'fetchReviewPool') {
    fetchReviewPool(msg).then(r => sendResponse({ ok: true, reviews: r.reviews, errors: r.errors }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'fetchImage') {
    fetchImageBase64(msg).then(r => sendResponse({ ok: true, base64: r.base64, contentType: r.contentType })).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'whoami') {
    // 内容脚本拿不到自己的 tabId，只能问后台（sender.tab 里有）
    sendResponse({ ok: true, tabId: (sender && sender.tab) ? sender.tab.id : null });
    return true;
  }

  if (msg.type === 'openOptions') {
    // 内容脚本里没有 chrome.runtime.openOptionsPage（Chrome 只开放一部分 runtime 方法），
    // 必须由后台来开。
    try {
      chrome.runtime.openOptionsPage(function () {
        sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : undefined });
      });
    } catch (e) {
      logBg('error', '打开设置页失败', String(e && e.message || e));
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return true;
  }

  if (msg.type === 'ping') { sendResponse({ ok: true, pong: true }); return true; }

  if (msg.type === 'testLlm') {
    testLlm(msg).then(function (r) { sendResponse(r); }).catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.type === 'testPool') {
    testPool(msg).then(function (r) { sendResponse(r); }).catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.type === 'listModels') {
    const started = Date.now();
    listModels()
      .then(function (r) { sendResponse({ ok: true, ms: Date.now() - started, url: r.url, ids: r.ids }); })
      .catch(function (e) { sendResponse({ ok: false, ms: Date.now() - started, error: String((e && e.message) || e) }); });
    return true;
  }

  if (msg.type === 'log') {
    appendLogs(msg.entries || []).then(function (n) { sendResponse({ ok: true, size: n }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.type === 'getLog') {
    chrome.storage.local.get(LOG_KEY).then(function (o) {
      const arr = o[LOG_KEY] || [];
      sendResponse({ ok: true, entries: msg.limit ? arr.slice(-msg.limit) : arr, total: arr.length });
    }).catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.type === 'clearLog') {
    chrome.storage.local.set({ [LOG_KEY]: [] }).then(function () { sendResponse({ ok: true }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
