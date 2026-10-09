/**
 * 默认配置：background（importScripts）与 content script 共用同一份，
 * 改这里 = 改所有地方；用户在设置页改的值存在 chrome.storage.local.config 里，会覆盖这里的默认。
 */
var JDAR_DEFAULTS = {
  // ---- 文案来源 ----
  // offline = 只用「已评价过的真实评价」（免密钥，默认）
  // hybrid  = 现成优先，凑不出 60 字才用 AI
  // ai      = 只用大模型
  textSource: 'offline',
  textComposeMode: 'merge', // merge=随机抽素材拼成新评价（推荐）| single=直接用一条够长的 | auto=先拼，拼不出才用单条
  textPoolSize: 10,         // 组稿时随机抽几条好评当素材
  textMaxChars: 120,        // 组稿的正文长度上限（凑够 60 字后不超过这个）
  minScore: 4,             // 只拿 4~5 星的好评当素材

  // ---- 大模型 ----
  // 默认走 DeepSeek 官方（已在 manifest 的白名单里，不需要额外授权）；只有选了 AI 才会用到这几个值
  apiUrl: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: '',
  modelName: 'deepseek-chat',

  // ---- 硬性要求 ----
  minReviewChars: 60,      // 评价正文最少字数（京东「优质评价」门槛：60字+2图）
  minReviewRetry: 2,       // 字数不足时自动重试次数
  enableImage: true,       // 是否自动配图
  imgPerProduct: 2,        // 「固定张数」模式下每单传几张
  imgRandomCount: true,    // 【随机】张数在 imgCountMin~imgCountMax 之间随机
  imgCountMin: 2,          // 京东「优质评价」要求 ≥2 图
  imgCountMax: 3,
  imgSourceMode: 'random', // 【随机】random=从整个评价池随机取图 | same=优先取文案那条评价的图
  avoidReuseImage: true,   // 同一轮内不重复用同一张图（同一商品有 500 条图文评价，够抽）

  // ---- 图片上传节奏（模拟人手一张张选文件）----
  imgUploadMode: 'human',   // human = 一张一张注入，每张之间随机停 | instant = 一次性全部注入
  imgUploadBatch: 1,        // 每批注入几张
  imgUploadGapMinSec: 1.5,  // 批与批之间随机停 1.5~4 秒
  imgUploadGapMaxSec: 4,
  imgUploadWaitMinSec: 8,   // 注入完成后随机等 8~15 秒（等它真的传完）再点发表
  imgUploadWaitMaxSec: 15,
  // 一张图都没配到时怎么办：
  //   skip    = 跳过这一单（不计入上限），继续下一单（推荐）
  //   pause   = 暂停等你人工处理
  //   publish = 无图也照发（相当于旧的「关掉必须有图」）
  noImageAction: 'skip',

  // ---- 节奏（防风控：宁慢勿快，全部走随机区间，绝不用固定秒数）----
  // 单位统一用【秒】（界面上填的就是秒；代码内部自己换算成毫秒做随机）
  clickDelayMinSec: 4,      // 每次自动点击前随机等 4~9 秒
  clickDelayMaxSec: 9,
  stepDelayMinSec: 2,       // 同一单内，步骤之间随机停 2~4 秒
  stepDelayMaxSec: 4,
  orderDelayMinSec: 25,     // 两单之间随机休息 25~60 秒（第 1 单不套用）
  orderDelayMaxSec: 60,
  maxPerRun: 5,             // 单轮最多发表几条评价，到量自动停（0 = 不限）
  // 后台并发：同一时刻允许几个标签页同时跑。默认 1 = 其他页只显示面板、不操作、不提交。
  // 调大能快一点，但多个评价会几乎同时提交，风控特征明显 —— 除非你很确定，否则别改。
  maxConcurrent: 1,
  typeLikeHuman: true,      // 分块打字；页面字数计数不认账时自动改成逐块重打
  blockPopups: true,        // 把页面的 window.open 改成原地跳转（否则扩展发出的点击会被 Chrome 弹窗拦截，表现成"点了没反应"）
  panelTheme: 'auto',       // 面板配色：auto=跟页面底色走（浅色页面用浅色）｜light=始终浅色｜dark=始终深色
  uploadWaitTimeoutSec: 15, // 等图片上传的上限（秒）
  riskStop: true,           // 页面出现「正在维修 / 系统繁忙 / 安全验证」就立刻停手

  // ---- 安全开关 ----
  dryRun: true,            // 【默认开】试跑：填字/打星/配图，但不点「发表」
  supportNewCenter: true,  // 支持京东新评价中心 comment.m.jd.com

  // 兜底结尾：仅当模型连续重试仍写不够字数时补上
  fallbackTail: '整体用下来没什么槽点，做工和细节都在预期之上，性价比也可以，后续有需要还会再来回购。'
};
