/**
 * 文案引擎：把「已评价过的真实评价」变成一条 ≥N 字的评价，不调用大模型。
 *   ① 单条就够长 → 直接用
 *   ② 不够 → 从多条评价里抽句、打乱、拼到够（不是整条照抄，降低被判定重复的概率）
 *   ③ 都不行 → 内置模板兜底
 * 同时负责质量过滤：去水军叠字、去默认好评、去超短、去链接和表情。
 *
 * 纯函数，无浏览器依赖 —— 可以在 Node 里直接单测（见 _update_tmp/textsource.test.mjs）。
 */
(function (root) {
  'use strict';

  /** 明显的系统/水军文案 */
  const BOILERPLATE = [
    /此用户未填写评价内容/,
    /此用户没有填写评价/,
    /评价方未及时做出评价/,
    /系统默认好评/,
    /默认好评/,
    /^很好?$/,
    /^不错$/
  ];

  /** 水军特征：叠字、连续重复、纯语气词堆砌 */
  const WATER = [
    /很很/, /好好好/, /棒棒棒/, /特别特别/, /非常非常非常/,
    /(.)\1{4,}/,            // 同一个字连续 5 次以上
    /[哈嘿嘻]{4,}/,
    /^[好棒赞顶支持加油嗯啊哦哈\s，。！~～]+$/
  ];

  /** 内置兜底模板（每条都 ≥60 字，且与具体商品无关） */
  const TEMPLATES = [
    '收到货第一时间就拆开了，包装很规整没有挤压变形，实物和页面描述基本一致。用下来这段时间整体感受比较稳定，做工细节处理得到位，日常使用完全够用，价格也合适，属于会再次回购的类型。',
    '下单后发货很快，到手检查了一圈没有磕碰和瑕疵，配件也都齐全。实际使用的手感和预期差不多，操作简单上手快，该有的功能都有，性价比在同价位里算不错，用着挺满意的。',
    '整体用下来没什么槽点，做工和细节都在预期之上。安装和上手都不费劲，说明书写得也清楚，日常场景用起来很顺手，希望后续能再优化一下细节，总体是值得推荐的一款。'
  ];

  /** 命名字符实体 → 真字符（京东返回的评价里会出现 &ldquo; &rdquo; &nbsp; 这类东西，
   *  直接发出去就是一串"未知字符"，必须先还原成 “ ” 空格 等真字符） */
  const ENTITY_MAP = {
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
    times: '×', divide: '÷', copy: '©', reg: '®', trade: '™', deg: '°',
    laquo: '«', raquo: '»', sect: '§', permil: '‰',
    euro: '€', yen: '¥', pound: '£', cent: '¢'
  };

  function decodeEntities(s) {
    let t = String(s == null ? '' : s);
    // 分号可有可无：粘贴/截断经常把 &rdquo 的 ; 丢掉
    t = t.replace(/&([a-zA-Z]+);?/g, function (m, name) {
      const key = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITY_MAP, key) ? ENTITY_MAP[key] : m;
    });
    t = t.replace(/&#(\d+);?/g, function (m, n) {
      const code = Number(n);
      return (code > 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : m;
    });
    t = t.replace(/&#[xX]([0-9a-fA-F]+);?/g, function (m, h) {
      const code = parseInt(h, 16);
      return (code > 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : m;
    });
    // 兜底：认不出来的实体形态一律丢掉，别把 &xxx; 发出去
    t = t.replace(/&[a-zA-Z]{2,20};/g, '');
    return t;
  }

  /** 去掉 HTML 标签（京东的 content 里偶尔夹 <br/> <p> 之类） */
  function stripTags(s) {
    return String(s == null ? '' : s)
      .replace(/<br\s*\/?>/gi, '。')
      .replace(/<\/(p|div|li|tr)>/gi, '。')
      .replace(/<[^>]{0,200}>/g, '');
  }

  /**
   * 掐掉句末标点之后的"尾巴"。
   * 京东有些评价正文末尾会粘上短碎片（如「…好滋味！有未知自负」里的后 5 个字），
   * 只保留到最后一个句末标点；尾巴太长（>30 字）说明本来就是没标点的正文，原样保留。
   */
  function trimToSentences(text, maxTail) {
    const t = String(text == null ? '' : text);
    const limit = maxTail == null ? 30 : maxTail;
    let last = -1;
    for (let i = t.length - 1; i >= 0; i--) {
      if ('。！？；!?;'.indexOf(t[i]) !== -1) { last = i; break; }
    }
    if (last === -1) return t;
    const tail = t.slice(last + 1);
    return tail.length <= limit ? t.slice(0, last + 1) : t;
  }

  /** 去空白、去链接、去表情、去异常标点 */
  function cleanReviewText(s) {
    let t = String(s == null ? '' : s);
    // 顺序很重要：
    //   ① 先去标签 ② 还原字符实体（否则 &ldquo; 会当成正文发出去）
    //   ③ 去掉链接（必须赶在压空白之前，否则 URL 会和后文粘一起被 \S+ 吃掉）
    //   ④ 去 emoji ⑤ 压空白 ⑥ 掐掉句末之后的碎片尾巴
    t = stripTags(t);
    t = decodeEntities(t);
    t = t.replace(/https?:\/\/\S+/g, '');
    t = t.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');       // 代理对（emoji）
    t = t.replace(/[\u2600-\u27BF\uFE0F\u2B00-\u2BFF]/g, '');    // 杂项符号
    t = t.replace(/\s+/g, '');
    t = t.replace(/[~～]{2,}/g, '～');
    t = t.replace(/([！!？?。，,；;]){2,}/g, '$1');
    t = t.replace(/^[，。、,.!！?？;；:：\s]+/, '');
    t = trimToSentences(t);
    return t.trim();
  }

  /** 质量过滤 */
  function isQualityText(text, score, minScore) {
    const t = String(text || '');
    if (!t) return false;
    if (t.length < 15) return false;                            // 太短没有信息量
    if (score != null && Number(score) > 0 && Number(score) < (minScore == null ? 4 : minScore)) return false;
    for (const r of BOILERPLATE) if (r.test(t)) return false;
    for (const r of WATER) if (r.test(t)) return false;
    return true;
  }

  /** 按句切分（中英文句末标点都算） */
  function splitSentences(text) {
    const out = String(text || '').match(/[^。！？；!?;]+[。！？；!?;]?/g) || [];
    return out.map((s) => s.trim()).filter(Boolean);
  }

  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 把多条评价的句子抽出来、打乱、拼到 minChars 以上 */
  function mergeSentences(candidates, minChars, rnd, allowSameId) {
    const pool = [];
    (candidates || []).forEach((c, ci) => {
      const text = cleanReviewText(c && c.content);
      splitSentences(text).forEach((s) => {
        const len = s.length;
        if (len < 10 || len > 70) return;                       // 太短的没信息，太长的容易一眼看出是整段抄
        pool.push({ id: (c && c.discussionId) || ('c' + ci), s });
      });
    });
    if (!pool.length) return null;

    shuffle(pool, rnd);
    const seenSentence = new Set();
    const seenId = new Set();
    let out = '';
    for (const item of pool) {
      if (out.length >= minChars) break;
      if (seenSentence.has(item.s)) continue;
      if (!allowSameId && seenId.has(item.id)) continue;        // 默认不连续用同一条评价的句子
      seenSentence.add(item.s);
      seenId.add(item.id);
      out += item.s;
    }
    return out.length >= minChars ? out : null;
  }

  /** 句子指纹：去掉标点/数字后取前 10 字 —— 用来判断"这句是不是已经用过/近似" */
  function sentenceKey(s) {
    return String(s == null ? '' : s).replace(/[，。！？；、,.!?;:：\s\d]/g, '').slice(0, 10);
  }

  /** 从候选里随机抽 n 条：**优先没用过的整条**，不够才拿用过的补齐（总比拼不出来强） */
  function sampleReviews(list, n, rnd, usedReviewIds) {
    const used = usedReviewIds || {};
    const all = (list || []).slice();
    const fresh = all.filter(function (c) { return !used[c.discussionId]; });
    const stale = all.filter(function (c) { return used[c.discussionId]; });
    const picked = shuffle(fresh, rnd).slice(0, n);
    if (picked.length >= n) return picked;
    return picked.concat(shuffle(stale, rnd).slice(0, n - picked.length));
  }

  /**
   * 组稿：把素材池里多条评价的句子拼成一条「新」评价。
   *   · 按评价分组取句，保持组内原始顺序（比完全随机打散读起来连贯）
   *   · 跳过已用过 / 近似的句子（去重靠 sentenceKey）
   *   · 凑够 minChars 就收手，尽量不超过 maxChars
   * 返回 { text, sentences, sources }，调用方负责把这些句子/素材记账，实现"跨单不重复"。
   */
  function composeFromPool(pool, minChars, maxChars, rnd, usedSentences) {
    const used = usedSentences || {};
    const groups = [];
    const seen = {};                       // 全局去重：同一条素材池里不同评价也可能有相同句子
    (pool || []).forEach(function (c) {
      const sents = splitSentences(c.content)
        .filter(function (s) { return s.length >= 10 && s.length <= 70; })
        .filter(function (s) {
          const k = sentenceKey(s);
          if (!k || used[k] || seen[k]) return false;
          seen[k] = 1;
          return true;
        });
      if (sents.length) groups.push({ id: c.discussionId, sents: sents });
    });
    if (!groups.length) return null;

    shuffle(groups, rnd);
    let out = '';
    const picked = [];
    const sources = [];
    for (let gi = 0; gi < groups.length && out.length < minChars; gi++) {
      const g = groups[gi];
      if (sources.indexOf(g.id) === -1) sources.push(g.id);
      const takeN = Math.min(g.sents.length, (out.length < minChars / 2) ? 2 : 1);
      for (let i = 0; i < takeN; i++) {
        const s = g.sents[i];
        if (!s) continue;
        if (out.length >= minChars) break;
        if (out.length + s.length > maxChars && out.length >= minChars) break;
        out += s;
        picked.push(s);
      }
    }
    // 还不够长：把没用上的句子也补进来
    if (out.length < minChars) {
      const rest = [];
      groups.forEach(function (g) {
        g.sents.forEach(function (s) { if (picked.indexOf(s) === -1) rest.push(s); });
      });
      shuffle(rest, rnd);
      for (let i = 0; i < rest.length && out.length < minChars; i++) {
        out += rest[i];
        picked.push(rest[i]);
      }
    }
    out = out.trim();
    if (out.length < minChars) return null;
    return { text: out, sentences: picked, sources: sources };
  }

  /** 两段文本的句子重合度（0~1）：用来判断"跟最近发过的像不像" */
  function sentenceOverlap(a, b) {
    const setA = {};
    splitSentences(a).forEach(function (s) { const k = sentenceKey(s); if (k) setA[k] = 1; });
    const keysA = Object.keys(setA);
    if (!keysA.length) return 0;
    let hit = 0;
    const seenB = {};
    splitSentences(b).forEach(function (s) {
      const k = sentenceKey(s);
      if (k && setA[k] && !seenB[k]) { seenB[k] = 1; hit++; }
    });
    return hit / keysA.length;
  }

  /**
   * 主入口
   * @param {Array} candidates [{content, score, discussionId, images}]
   * @param {number} minChars 目标字数
   * @param {object} opts {mode:'merge'|'single'|'auto', poolSize, maxChars, minScore, random,
   *                       usedSentences: {}, usedReviewIds: {}}
   * @returns {{text:string, source:'merged'|'single'|'template', review:object|null,
   *            sentences?:string[], sources?:string[]}}
   */
  function pickReviewText(candidates, minChars, opts) {
    const o = opts || {};
    const rnd = o.random || Math.random;
    const min = Math.max(10, Number(minChars) || 60);
    const minScore = o.minScore == null ? 4 : o.minScore;
    const mode = o.mode || 'merge';
    const poolSize = Math.max(3, Number(o.poolSize) || 10);
    const maxChars = Math.max(min, Number(o.maxChars) || 120);

    const all = (candidates || [])
      .map((c) => Object.assign({}, c, { content: cleanReviewText(c && c.content) }))
      .filter(Boolean);

    const good = all.filter((c) => isQualityText(c.content, c.score, minScore));

    // ① 组稿（默认）：随机抽 poolSize 条素材，拼出一条新的
    if (mode === 'merge' || mode === 'auto') {
      const pool = sampleReviews(good.length >= 3 ? good : all, poolSize, rnd, o.usedReviewIds);
      const merged = composeFromPool(pool, min, maxChars, rnd, o.usedSentences);
      if (merged) {
        return {
          text: merged.text, source: 'merged', review: null,
          sentences: merged.sentences, sources: merged.sources
        };
      }
      if (mode === 'merge') {
        // 实在拼不出来 → 退回单条
        const one = pickSingle(good.length ? good : all, min, rnd);
        if (one) return one;
      }
    }

    // ② 单条整段用（旧行为）；单条都不够长时也退而组稿（比模板好）
    if (mode === 'single' || mode === 'auto') {
      const one = pickSingle(good.length ? good : all, min, rnd);
      if (one) return one;
      const pool2 = sampleReviews(good.length >= 3 ? good : all, poolSize, rnd, o.usedReviewIds);
      const merged2 = composeFromPool(pool2, min, maxChars, rnd, o.usedSentences);
      if (merged2) {
        return {
          text: merged2.text, source: 'merged', review: null,
          sentences: merged2.sentences, sources: merged2.sources
        };
      }
    }

    // ③ 模板兜底
    const tpl = TEMPLATES[Math.floor(rnd() * TEMPLATES.length)];
    return { text: tpl, source: 'template', review: null };
  }

  /** 挑一条够长的整条评价 */
  function pickSingle(list, minChars, rnd) {
    const longOnes = (list || []).filter(function (c) { return (c.content || '').length >= minChars; });
    if (!longOnes.length) return null;
    const fresh = longOnes.filter(function (c) { return !c.used; });
    const from = fresh.length ? fresh : longOnes;
    const pick = from[Math.floor(rnd() * from.length)];
    return { text: pick.content, source: 'single', review: pick };
  }

  /** 仅要模板时用（配置里那句兜底尾巴会补在末尾，保证够字数） */
  function pickTemplate(minChars, tail) {
    const min = Math.max(10, Number(minChars) || 60);
    const base = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
    let out = base;
    const extra = String(tail || '').trim();
    let guard = 0;
    while (extra && out.length < min && guard < 4) { out += extra; guard++; }
    return out;
  }

  root.JDAR_TEXT = {
    cleanReviewText,
    decodeEntities,
    stripTags,
    trimToSentences,
    isQualityText,
    splitSentences,
    sentenceKey,
    sentenceOverlap,
    sampleReviews,
    composeFromPool,
    pickReviewText,
    pickSingle,
    pickTemplate,
    TEMPLATES,
    BOILERPLATE,
    WATER,
    ENTITY_MAP
  };
})(typeof window !== 'undefined' ? window : globalThis);
