/**
 * 网络小工具（纯函数，可单测）
 * 这两个坑都是实测踩出来的：
 *   ① 接口地址只填到 /v1（如 https://api.deepseek.com/v1），fetch 会 404 → 自动补 /chat/completions
 *   ② 密钥里混进中文/全角字符时，fetch 直接抛 "String contains non ISO-8859-1 code point"，
 *      而且完全看不出是哪个字符 → 提前拦下来并指名道姓
 */
(function (root) {
  'use strict';

  /** 只填到 /v1（或只填域名）也能用：自动补成 /v1/chat/completions */
  function normalizeChatUrl(input) {
    let s = String(input == null ? '' : input).trim().replace(/\s+/g, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    const m = s.match(/^(https?:\/\/[^/?#]+)([^?#]*)([\s\S]*)$/i);
    if (!m) return s;
    const origin = m[1];
    let path = (m[2] || '').replace(/\/+$/, '');
    const rest = m[3] || '';
    if (!/\/chat\/completions$/i.test(path)) {
      if (/\/v\d+$/i.test(path)) path += '/chat/completions';
      else if (path === '') path = '/v1/chat/completions';
      else if (/\/chat$/i.test(path)) path = path.replace(/\/chat$/i, '/chat/completions');
      else path += '/chat/completions';
    }
    return origin + path + rest;
  }

  /** 去掉零宽字符 / 换行 / 首尾空白（从网页复制密钥时经常带进来） */
  function sanitizeKey(k) {
    return String(k == null ? '' : k)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\r\n\t]/g, '')
      .trim();
  }

  /** 由对话地址推出模型列表地址：…/v1/chat/completions → …/v1/models */
  function modelsUrlFromChatUrl(chatUrl) {
    const u = normalizeChatUrl(chatUrl);
    if (!u) return '';
    return u.replace(/\/chat\/completions(\?[\s\S]*)?$/i, '/models$1');
  }

  /**
   * HTTP 请求头只能是 ISO-8859-1。密钥里有非 ASCII 字符时提前报错，并指出是第几个、哪个字符。
   * @returns {string} 出错时抛 Error；没问题返回空串
   */
  function assertHeaderSafe(key) {
    const s = String(key == null ? '' : key);
    const bad = s.match(/[^\x20-\x7E]/);
    if (bad) {
      const idx = s.indexOf(bad[0]);
      const cp = bad[0].codePointAt(0).toString(16).toUpperCase();
      throw new Error('密钥里有非 ASCII 字符：第 ' + (idx + 1) + ' 个是「' + bad[0] + '」(U+' + cp + ')。' +
        'HTTP 请求头只允许 ISO-8859-1，请重新复制纯英文数字的密钥（注意别把中文说明/全角空格一起粘进来）。');
    }
    return '';
  }

  /**
   * 字节 → 文本。京东那些老接口（club.jd.com/comment/... 、discussion/...）返回的是 **GBK**，
   * 直接 resp.json() 按 UTF-8 硬解会得到一串 �（实测就是这个现象）。
   * 先把字节按 UTF-8 严格解，失败或出现替换字符就改用 GBK。
   */
  function decodeBytes(bytes) {
    const buf = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
    const bad = function (s) { return (s.match(/\uFFFD/g) || []).length; };
    let text = '';
    let encoding = 'utf-8';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try { text = new TextDecoder('gbk').decode(buf); encoding = 'gbk'; }
      catch (e2) { text = new TextDecoder('utf-8').decode(buf); }
    }
    if (bad(text) > 0) {
      try {
        const alt = new TextDecoder('gbk').decode(buf);
        if (bad(alt) < bad(text)) { text = alt; encoding = 'gbk'; }
      } catch (e) { /* 环境不支持 gbk 就保持原样 */ }
    }
    return { text: text, encoding: encoding, replaced: bad(text) };
  }

  root.JDAR_NET = {
    normalizeChatUrl: normalizeChatUrl,
    modelsUrlFromChatUrl: modelsUrlFromChatUrl,
    sanitizeKey: sanitizeKey,
    assertHeaderSafe: assertHeaderSafe,
    decodeBytes: decodeBytes
  };
})(typeof self !== 'undefined' ? self : globalThis);
