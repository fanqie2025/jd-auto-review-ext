/* 设置页逻辑：读写 chrome.storage.local.config + 测试按钮 + 去京东页面的快捷入口 */
(function () {
  'use strict';

  const FIELDS = [
    'textSource', 'textComposeMode', 'textPoolSize', 'textMaxChars', 'minScore',
    'apiUrl', 'apiKey', 'modelName', 'panelTheme',
    'minReviewChars', 'minReviewRetry', 'fallbackTail',
    'imgPerProduct', 'imgCountMin', 'imgCountMax', 'imgSourceMode',
    'imgUploadMode', 'imgUploadBatch', 'imgUploadGapMinSec', 'imgUploadGapMaxSec',
    'imgUploadWaitMinSec', 'imgUploadWaitMaxSec', 'noImageAction',
    'clickDelayMinSec', 'clickDelayMaxSec', 'stepDelayMinSec', 'stepDelayMaxSec',
    'orderDelayMinSec', 'orderDelayMaxSec', 'maxPerRun', 'maxConcurrent', 'uploadWaitTimeoutSec'
  ];
  const CHECKS = ['supportNewCenter', 'enableImage',
    'imgRandomCount', 'avoidReuseImage', 'typeLikeHuman', 'riskStop', 'blockPopups'];

  const $ = (id) => document.getElementById(id);

  /* ---------------- 读写配置 ---------------- */

  function fill(cfg) {
    FIELDS.forEach((k) => { if ($(k)) $(k).value = cfg[k] == null ? '' : cfg[k]; });
    CHECKS.forEach((k) => { if ($(k)) $(k).checked = !!cfg[k]; });
    // 模式是下拉：模拟 / 真实
    if ($('dryRun')) $('dryRun').value = cfg.dryRun ? 'sim' : 'real';
    renderMcWarn();
  }

  function collect() {
    const out = {};
    FIELDS.forEach((k) => {
      const el = $(k);
      if (!el) return;
      const v = el.value.trim();
      out[k] = (el.type === 'number') ? (v === '' ? JDAR_DEFAULTS[k] : Number(v)) : v;
    });
    CHECKS.forEach((k) => { if ($(k)) out[k] = $(k).checked; });
    out.dryRun = $('dryRun') ? ($('dryRun').value === 'sim') : !!JDAR_DEFAULTS.dryRun;
    return out;
  }

  function load() {
    chrome.storage.local.get(['config', MODEL_LIST_KEY], (o) => {
      const cfg = Object.assign({}, JDAR_DEFAULTS, o.config || {});
      fill(cfg);
      // 上次探测到的模型列表也带回来，省得每次重新探测
      const saved = o[MODEL_LIST_KEY];
      if (saved && saved.ids && saved.ids.length) renderModelChoices(saved.ids, cfg.modelName);
    });
  }

  function msg(text, color) {
    const el = $('msg');
    el.textContent = text;
    el.style.color = color || '#28a745';
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000);
  }

  function showOut(id, text, ok) {
    const el = $(id);
    if (!el) return;
    el.style.display = 'block';
    el.style.color = ok ? '#1f8a3b' : '#d93a3f';
    el.style.borderColor = ok ? 'rgba(31,138,59,.35)' : 'rgba(217,58,63,.35)';
    el.textContent = text;
  }

  /* ---------------- 后台并发：默认关闭，开启必须确认 ---------------- */

  function renderMcWarn() {
    const el = $('mcWarn');
    const n = Number($('maxConcurrent') && $('maxConcurrent').value) || 1;
    if (el) el.style.display = (n > 1) ? 'inline-block' : 'none';
  }

  if ($('maxConcurrent')) {
    $('maxConcurrent').addEventListener('change', () => {
      const el = $('maxConcurrent');
      const n = Math.max(1, Math.min(5, Math.floor(Number(el.value) || 1)));
      if (n > 1) {
        const okGo = window.confirm(
          '要开启「后台并发 = ' + n + '」吗？\n\n' +
          '开启后会有最多 ' + n + ' 个标签页同时跑：\n' +
          '· 多条评价会几乎同时上传、同时提交\n' +
          '· 这是最明显的风控特征，可能触发限流/软封\n' +
          '· 只在确实需要、且你清楚后果时才开\n\n' +
          '确定开启吗？'
        );
        if (!okGo) {
          el.value = '1';
          renderMcWarn();
          msg('已保持关闭（并发 = 1）', '#1f8a3b');
          chrome.storage.local.set({ config: collect() });
          return;
        }
        msg('已开启并发 = ' + n + '（记得点「保存设置」）', '#d93a3f');
      } else {
        msg('并发已关闭（= 1）');
      }
      el.value = String(n);
      renderMcWarn();
    });
  }

  $('save').addEventListener('click', () => {
    const cfg = collect();
    chrome.storage.local.set({ config: cfg }, () => {
      if (cfg.textSource === 'ai' && !cfg.apiKey) {
        msg('已保存，但「只用 AI」却没填密钥，跑到生成文案时会停下', '#e4393c');
      } else {
        msg('已保存 ✓' + (cfg.dryRun ? '（当前默认：模拟）' : '（当前默认：真实提交）'));
      }
    });
  });

  $('reset').addEventListener('click', () => {
    chrome.storage.local.set({ config: Object.assign({}, JDAR_DEFAULTS) }, () => {
      fill(Object.assign({}, JDAR_DEFAULTS));
      msg('已恢复默认（免 AI + 试跑）');
    });
  });

  /* ---------------- 自建网关：申请该来源的 host 权限 ---------------- */

  function originOf(u) {
    let s = String(u || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try { return new URL(s).origin; } catch (e) { return ''; }
  }

  $('grantPerm').addEventListener('click', () => {
    const origin = originOf($('apiUrl').value);
    if (!origin) { msg('接口地址填得不对', '#e4393c'); return; }
    chrome.permissions.request({ origins: [origin + '/*'] }, (granted) => {
      msg(granted ? ('已授权 ' + origin) : '没授权，自定义接口会请求失败', granted ? '#28a745' : '#e4393c');
    });
  });

  /* ---------------- 探测模型（GET /v1/models） ---------------- */

  const MODEL_LIST_KEY = 'JDAR_MODEL_LIST';

  /** 把探测到的模型渲染成一排可点的小按钮，点一下直接设为模型名 */
  function renderModelChoices(ids, current) {
    const box = $('modelChoices');
    if (!box) return;
    box.innerHTML = '';
    if (!ids || !ids.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';

    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.textContent = '探测到 ' + ids.length + ' 个模型 —— 点一下直接选用（当前：' + (current || '空') + '）';
    box.appendChild(tip);

    ids.forEach((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = id;
      if (id === current) b.className = 'cur';
      b.addEventListener('click', () => {
        $('modelName').value = id;
        chrome.storage.local.set({ config: collect() });
        renderModelChoices(ids, id);
        msg('模型名已设为 ' + id + '（已自动保存）', '#28a745');
      });
      box.appendChild(b);
    });
  }

  $('probeModels').addEventListener('click', () => {
    const cfg = collect();
    chrome.storage.local.set({ config: cfg });

    const origin = originOf(cfg.apiUrl);
    if (!origin) { showOut('testOutModel', '❌ 接口地址填得不对：' + (cfg.apiUrl || '(空)'), false); return; }

    showOut('testOutModel', '准备中…（确认对 ' + origin + ' 的访问权限）', true);
    chrome.permissions.request({ origins: [origin + '/*'] }, (granted) => {
      if (!granted) {
        showOut('testOutModel', '❌ 没拿到 ' + origin + ' 的访问权限，请求会被浏览器拦掉。\n' +
          '请点「授权当前接口地址」，或重新点一次「探测模型」并在弹窗里点「允许」。', false);
        return;
      }
      showOut('testOutModel', '探测中…（GET 模型列表）\n已授权：' + origin, true);
      chrome.runtime.sendMessage({ type: 'listModels' }, (r) => {
        if (chrome.runtime.lastError) { showOut('testOutModel', '❌ 扩展通道错误：' + chrome.runtime.lastError.message, false); return; }
        if (!r) { showOut('testOutModel', '❌ 后台没有返回', false); return; }
        if (!r.ok) {
          showOut('testOutModel', [
            '❌ 探测失败',
            '耗时：' + r.ms + ' ms',
            '错误：' + r.error,
            '',
            '常见原因：',
            '  ① 该网关没实现 GET /v1/models（不少自建网关只做了 /chat/completions）→ 那就手填模型名，再用「测试大模型」验证',
            '  ② 密钥不对（401）或没授权该地址',
            '  ③ 地址写错（会自动按 /v1/models 拼，完整地址也会显示在下面的成功结果里）'
          ].join('\n'), false);
          return;
        }

        const ids = r.ids || [];
        let cur = ($('modelName').value || '').trim();

        // 只有一个模型、而且输入框还是空的 → 直接替你选上，省一步
        if (ids.length === 1 && !cur) {
          cur = ids[0];
          $('modelName').value = cur;
          chrome.storage.local.set({ config: collect() });
        }

        chrome.storage.local.set({ [MODEL_LIST_KEY]: { ids: ids, at: Date.now() } });
        renderModelChoices(ids, cur);

        const lines = [
          ids.length ? ('✅ 探测到 ' + ids.length + ' 个模型 —— 点下面那排按钮直接选') : '⚠️ 接口通了，但没返回任何模型',
          '耗时：' + r.ms + ' ms',
          '地址：' + r.url,
          ''
        ];
        if (!ids.length) {
          lines.push('接口存在但列表为空，请手动填模型名（然后用「测试大模型」验证）。');
        } else {
          const ci = ids.filter((x) => x.toLowerCase() === cur.toLowerCase())[0];
          if (!cur) lines.push('👉 模型名还是空的：点下面那排按钮选一个。');
          else if (ids.indexOf(cur) !== -1) lines.push('👉 当前填的「' + cur + '」在列表里 ✅');
          else if (ci) lines.push('⚠️ 当前填的「' + cur + '」不在列表里，大小写对不上 —— 应该是「' + ci + '」');
          else lines.push('⚠️ 当前填的「' + cur + '」不在列表里 —— 很可能是拼错了，点下面那排按钮选。');
        }
        showOut('testOutModel', lines.join('\n'), true);
      });
    });
  });

  /* ---------------- 测试大模型 ---------------- */

  function renderLlmResult(r) {
    if (r.ok) {
      showOut('testOutLlm', [
        '✅ 大模型可用',
        '耗时：' + r.ms + ' ms',
        '模型：' + r.info.model,
        '实际调用地址：' + r.info.url + (r.info.urlRewritten ? '（已自动补全）' : ''),
        '返回字数（去空白）：' + r.chars + ' 字　门槛 ≥' + r.info.minChars + ' 字：' +
          (r.passMinChars ? '通过 ✅' : '不足 ⚠️（实跑时会自动重试 2 次，再不足才补兜底结尾）'),
        '',
        '--- 模型返回的正文 ---',
        r.text || '(空)'
      ].join('\n'), true);
      return;
    }
    showOut('testOutLlm', [
      '❌ 大模型测试失败',
      '耗时：' + r.ms + ' ms',
      '模型：' + r.info.model + '　密钥：' + (r.info.hasKey ? '已填' : '【没填！】'),
      '实际调用地址：' + (r.info.url || r.info.apiUrl) + (r.info.urlRewritten ? '（已自动补全）' : ''),
      '错误：' + r.error,
      '',
      '常见原因：',
      '  ① 密钥里有中文/全角字符或空格 —— Headers 只允许 ISO-8859-1，会直接报 "String contains non ISO-8859-1 code point"',
      '  ② 密钥没填或填错（401/403）',
      '  ③ 自建网关没授权 —— 点上面的「授权当前接口地址」，或重开本页再点一次「测试大模型」',
      '  ④ 接口地址 404 或路径不对（只填到 /v1 也行，会自动补 /v1/chat/completions）',
      '  ⑤ 模型名该网关不认识（404 / model not found）',
      '  ⑥ 网关没开或网络不通（Failed to fetch / 超时）'
    ].join('\n'), false);
  }

  function runLlmTest() {
    chrome.runtime.sendMessage({ type: 'testLlm', productName: '真空保温杯 316不锈钢 500ml' }, (r) => {
      if (chrome.runtime.lastError) { showOut('testOutLlm', '❌ 扩展通道错误：' + chrome.runtime.lastError.message, false); return; }
      if (!r) { showOut('testOutLlm', '❌ 后台没有返回', false); return; }
      renderLlmResult(r);
    });
  }

  $('testLlm').addEventListener('click', () => {
    const cfg = collect();
    chrome.storage.local.set({ config: cfg });

    const origin = originOf(cfg.apiUrl);
    if (!origin) { showOut('testOutLlm', '❌ 接口地址填得不对：' + (cfg.apiUrl || '(空)'), false); return; }

    // 关键：permissions.request 必须在用户手势里同步发起（已授权时不会弹窗）
    showOut('testOutLlm', '准备中…（正在确认对 ' + origin + ' 的访问权限）', true);
    chrome.permissions.request({ origins: [origin + '/*'] }, (granted) => {
      if (!granted) {
        showOut('testOutLlm', '❌ 没拿到 ' + origin + ' 的访问权限，请求会被浏览器拦掉。\n' +
          '请点「授权当前接口地址」，或重新点一次「测试大模型」并在弹窗里点「允许」。', false);
        return;
      }
      showOut('testOutLlm', '测试中…（正在请求大模型，最长 60 秒）\n已授权：' + origin, true);
      runLlmTest();
    });
  });

  /* ---------------- 测试取现成评价 ---------------- */

  $('testPool').addEventListener('click', () => {
    const sku = $('testSku').value.trim();
    if (!/^\d{6,20}$/.test(sku)) {
      showOut('testOutPool', '❌ 先填一个正确的商品 SKU（纯数字，例如 10233255087903）', false);
      return;
    }
    showOut('testOutPool', '测试中…（正在拉取该商品的图文评价）', true);
    chrome.runtime.sendMessage({ type: 'testPool', productId: sku }, (r) => {
      if (chrome.runtime.lastError) { showOut('testOutPool', '❌ 扩展通道错误：' + chrome.runtime.lastError.message, false); return; }
      if (!r) { showOut('testOutPool', '❌ 后台没有返回', false); return; }
      if (!r.ok) {
        showOut('testOutPool', [
          '❌ 取评价失败',
          '耗时：' + r.ms + ' ms',
          '错误：' + r.error,
          '',
          '如果错误里出现 444 / 系统繁忙 / Forbidden，说明这个接口不接受后台发起的请求，',
          '需要改成「借一个 club.jd.com 标签页来取数」——把这个结果发我，我来加。'
        ].join('\n'), false);
        return;
      }
      const lines = [
        '✅ 取到评价池',
        '耗时：' + r.ms + ' ms',
        '评价条数：' + r.total + '　其中带图：' + r.withImages + '　≥' + r.minChars + ' 字：' + r.longEnough,
        '接口报错：' + ((r.errors && r.errors.length) ? r.errors.join(' | ') : '无'),
        '',
        '--- 前 3 条样例（只是给你看池子里有什么）---'
      ];
      (r.sample || []).forEach((s, i) => {
        lines.push((i + 1) + '. ' + s.字数 + ' 字 / ' + s.图 + ' 张图：' + s.开头 + '…');
      });
      if (r.preview) {
        const srcTxt = r.preview.source === 'merged'
          ? ('随机 ' + r.preview.materials + ' 条好评组稿（新拼的）')
          : (r.preview.source === 'single' ? '单条现成评价整条' : '内置模板兜底');
        lines.push('', '--- 实际会填进页面的文案（组稿预览）---',
          '来源：' + srcTxt + '　字数：' + r.preview.chars,
          r.preview.text);
      }
      if (r.longEnough === 0) {
        lines.push('', '⚠️ 没有一条够 ' + r.minChars + ' 字：会走「多条组稿」，再不够才用模板兜底。');
      }
      showOut('testOutPool', lines.join('\n'), true);
    });
  });

  /* ---------------- 去京东评价页：一律 chrome.tabs.create，别把设置页本身导航走 ---------------- */

  function openJd(url) {
    try {
      chrome.tabs.create({ url: url, active: true }, function () { void chrome.runtime.lastError; });
    } catch (e) {
      msg('打开失败：' + (e && e.message || e), '#e4393c');
    }
  }

  $('openJdNew').addEventListener('click', () => openJd('https://comment.m.jd.com/pc-static/center'));
  $('openJdOld').addEventListener('click', () => openJd('https://club.jd.com/myJdcomments/myJdcomment.action?sort=0'));
  $('openJdOrders').addEventListener('click', () => openJd('https://order.jd.com/center/list.action'));

  Array.prototype.forEach.call(document.querySelectorAll('a[data-jd]'), (a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openJd(a.getAttribute('href'));
    });
  });

  load();
})();
