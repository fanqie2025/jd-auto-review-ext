/**
 * 日志模块（纯函数，可单测）
 * 日志要能跨页面续接 —— 评价流程会在 club.jd.com / comment.m.jd.com 之间跳好几页，
 * 单页内存里的日志一跳就没了，所以统一落 chrome.storage.local（由 background 负责追加）。
 */
(function (root) {
  'use strict';

  const MAX_DATA = 600;      // 单条附加数据最大长度
  const MAX_LINE = 900;      // 单条日志最大长度

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function hhmmss(d) {
    const t = d instanceof Date ? d : new Date();
    return pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
  }

  /** 压成一行、去掉换行、超长截断 */
  function tail(text, n) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const k = n || 60;
    return s.length > k ? s.slice(0, k) + '…' : s;
  }

  function fmtData(data) {
    if (data === undefined || data === null) return '';
    let s;
    try {
      s = (typeof data === 'string') ? data : JSON.stringify(data);
    } catch (e) {
      s = String(data);
    }
    if (!s) return '';
    s = s.replace(/\s+/g, ' ');
    return s.length > MAX_DATA ? s.slice(0, MAX_DATA) + '…' : s;
  }

  /** [12:34:56] INFO  消息  {数据} */
  function line(level, msg, data, date) {
    const lv = String(level || 'info').toUpperCase();
    let body = '[' + hhmmss(date) + '] ' + (lv + '    ').slice(0, 5) + ' ' + String(msg == null ? '' : msg);
    const d = fmtData(data);
    if (d) body += '  ' + d;
    return body.length > MAX_LINE ? body.slice(0, MAX_LINE) + '…' : body;
  }

  /** 把 stderr 里的 entry 还原成一行文本（导出用） */
  function entryToLine(entry) {
    if (!entry) return '';
    const t = entry.t ? new Date(entry.t) : new Date();
    return line(entry.level || 'info', entry.msg || '', entry.data || '', t) +
      (entry.page ? '  @' + entry.page : '');
  }

  function errInfo(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    return (e.name ? e.name + ': ' : '') + (e.message || String(e));
  }

  root.JDAR_LOG = {
    MAX_DATA: MAX_DATA,
    MAX_LINE: MAX_LINE,
    hhmmss: hhmmss,
    tail: tail,
    fmtData: fmtData,
    line: line,
    entryToLine: entryToLine,
    errInfo: errInfo
  };
})(typeof window !== 'undefined' ? window : globalThis);
