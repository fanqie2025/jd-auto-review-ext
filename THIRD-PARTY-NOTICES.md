# 来源与致谢 · THIRD-PARTY NOTICES

本扩展不是凭空写的：**老链路的流程与选择器是从一个 MIT 油猴脚本移植过来的，新评价中心的选择器参考了另一个 MIT 扩展，
"免 AI、复用现成好评+买家秀图"这条路线则是从一个 MIT 油猴脚本学来的。** 下面逐项写清出处、许可、以及**具体用在了哪里**。

| # | 项目 | 版本 | 许可 | 我们怎么用的 | 具体位置 |
|---|---|---|---|---|---|
| 1 | [charmingYouYou/JDAIAutoComment](https://github.com/charmingYouYou/JDAIAutoComment) | v8.6 | **MIT** | **移植其代码**：老评价链路全流程、页面选择器、晒单图接口、开始/暂停闭环交互 | `src/content.js` 60–64、1149–1150、1551、1694、1782–1786、1826；`src/background.js` 184、240 |
| 2 | [hezhengtao/jd-smart-assistant](https://github.com/hezhengtao/jd-smart-assistant) | v4.1 | **MIT** | **取其接口与路线**：「爬好评+晒单图、零 API 费用」的思路；评价池接口及其参数组合 | `src/background.js` 259（`club.jd.com/comment/productPageComments.action`） |
| 3 | [liu-ws/Haoping（好评）](https://github.com/liu-ws/Haoping) | v0.1.0 | **MIT** | **参考其选择器**：京东新评价中心（`comment.m.jd.com`）的 URL 判定与页面选择器 | `src/content.js` 60–61、1903–1913、1932、1960–1961 |
| 4 | [jQuery](https://jquery.com/) | 1.11.1 | **MIT** | **原样内嵌**（上游脚本用 `@require` 从 CDN 引入，这里打包进扩展以免受 CSP/网络影响） | `src/jquery.min.js`（文件头版权声明完整保留） |
| 5 | [Goodnameisfordoggy/JD-AutomatedTools](https://github.com/Goodnameisfordoggy/JD-AutomatedTools) | 3.2.4 | Apache-2.0 + 特别声明 | **只作设计参考，未取用任何代码**（它是 Python 实现）。参考的判断：把订单拆成"最小可评价单元"、商品/评价页不存在就跳过、评价有礼的创作值规则 | — |
| 6 | [loinky/jd-review-assistant](https://github.com/loinky/jd-review-assistant) | v0.7.0 | 未声明许可 | **只读了 README 与目录结构，未取用任何代码**（其许可未声明，按"保留所有权利"对待） | — |
| 7 | [Fzuim/jd-review-bot-skill](https://github.com/Fzuim/jd-review-bot-skill) | — | — | **只采纳了它记录的结论，未取用代码**：京东表单只认真实键盘事件（`textarea.value=` 会让字数计数为 0 而提交失败）、必须先填文字再点星级 | 结论体现在 `src/content.js` 的分块打字与"填完读页面计数复核"逻辑里 |

> 说明：**京东的页面选择器与接口本身来自京东自己的页面**（通过浏览器实测与抓包确认，见 `_update_tmp/jd-新评价中心-抓包-20261009.json`）。
> 上表列的是"我们参考/取用了谁的代码"，不是"这些接口是谁发明的"。

---

## 1. charmingYouYou/JDAIAutoComment（MIT）— 基底

本扩展是它的 **Manifest V3 等价替代**（原项目是油猴脚本）。逐条对应：

| 从它移植过来的东西 | 本项目位置 |
|---|---|
| 老评价链路三条 URL：我的评价列表 / `orderVoucher` 评价页 / `saveCommentSuccess` 成功页 | `src/content.js` 62–64、1150 |
| 商品名与 SKU：`.p-name a` → `item.jd.com/<sku>.html` | `src/content.js` 1551 |
| 正文输入框 `.f-textarea textarea`、商品名 `.p-name`、五星 `.star5` | `src/content.js` 1782–1786、1826 |
| 上传完成的判据：数 `img[src*="imageUpload"]` 够不够张数 | `src/content.js` 1694 |
| 晒单图接口 `discussion/getProductPageImageCommentList.action`（取 `imgComments.imgList[].imageUrl`） | `src/background.js` 184、240 |
| 「一个按钮控制开始/暂停、从当前步骤继续」的闭环交互 | 整个面板与 `dispatch()` |

```
MIT License
Copyright (c) charmingYouYou
（原脚本头部声明：@license MIT · @homepageURL https://github.com/charmingYouYou/JDAIAutoComment）

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. hezhengtao/jd-smart-assistant（MIT）— 评价池接口与路线

它的自述就是"纯浏览器端油猴脚本，零外部依赖，零 API 费用：爬取好评文字 → 智能改写 → 抓买家秀晒单图 → 自动五星 → 全闭环"。
本扩展「免 AI、复用现成好评」这条路线即由此而来；评价池接口与参数组合也取自它：

```
它：https://club.jd.com/comment/productPageComments.action?productId=<sku>
      &score=<最低分>&sortType=5&page=0&pageSize=<条数>&isShadowSku=0
我们：src/background.js:251（同样这几个参数，另加 fold=1）
```

```
MIT License
Copyright (c) hezhengtao
（原脚本头部声明：@license MIT · @namespace https://github.com/hezhengtao/jd-smart-assistant）
```

## 3. liu-ws/Haoping（好评）（MIT）— 新评价中心的选择器

京东 2026 年改版后新增的 `comment.m.jd.com` 评价中心，是**先在这个项目里看到的**（当时它是唯一明确适配新中心的公开项目）。
本扩展新链路用到的判定与选择器：

| 选择器 / 判定 | 本项目位置 |
|---|---|
| `comment.m.jd.com/pc-static/publish`、`/pc-static/center` | `src/content.js` 60–61、1149、1985 |
| `.scoreBox-conter-score-star-box-item`（四个评分维度） | `src/content.js` 1903–1913 |
| `.rate-publish-submit-button` | `src/content.js` 1960–1961 |

```
MIT License
Copyright (c) 2026 好评 contributors
```

（`textarea.rate-comment-content-textarea`、`input.uploadAddInput` 两个选择器是我们在真实页面上实测确认的。）

## 4. jQuery 1.11.1（MIT）

`src/jquery.min.js` 为原样内嵌，文件头版权声明完整保留：

```
/*! jQuery v1.11.1 | (c) 2005, 2014 jQuery Foundation, Inc. | jquery.org/license */
```

上游脚本用 `@require https://cdnjs.cloudflare.com/ajax/libs/jquery/1.11.1/jquery.min.js` 引入；
扩展受 CSP 限制不能远程加载脚本，因此打包进本地 —— **版本与上游完全一致**，页面操作行为不变。

## 5. Goodnameisfordoggy/JD-AutomatedTools（Apache-2.0 + 特别声明）— 仅设计参考

你原本一直用的工具。它是 **Python** 实现，本扩展**没有取用它的任何代码**，只在以下几点上参考了它的判断：

- 把一个待评价订单拆成**最小可评价单元**（按商品细分，一个单元 = 一条评价）；
- **商品详情页/评价页不存在时跳过当前单元**（与本扩展"没法评价就跳过、不计入上限"是同一个思路）；
- 评价有礼 / 创作值的规则（解释"为什么一个订单里只有主品能拿到评价有礼"）。

它的 README 自带**「宇宙安全声明」**，其中与本项目相关的两条：

> 1. 本仓库发布的脚本，仅用于测试和学习研究，**禁止用于商业用途**……
> 2. 本项目内所有资源文件，**禁止任何公众号、自媒体进行任何形式的转载、发布**。
>
> `Copyright 2024 Goodnameisfordoggy | huo dong jun | HDJ`（Apache-2.0，冲突时以特别声明为准）

请遵守。本扩展同样**仅供个人学习与自用**，不要商用、不要转载。

## 6. loinky/jd-review-assistant（未声明许可）

只读了它的 README 与目录结构（它把京东选择器写死在 `club.jd.com`，走老链路）。**未取用任何代码** ——
它没有声明开源许可，按"保留所有权利"对待。

## 7. Fzuim/jd-review-bot-skill（结论引用）

只采纳了它踩坑记录里的两条结论，**未取用代码**：

- 京东的评价表单**只认真实键盘事件** —— 直接 `textarea.value = '...'` 会让页面的字数计数显示 0，提交失败；
- **必须先填文字、再点星级** —— 点星级会清空 textarea。

这两条直接决定了本扩展 `fillReview()` / `typeInChunks()` 的做法：以真实输入事件分块"打字"，并且**填完要读页面自己的计数复核**，对不上就重打。

---

## 我们自己的部分

以下为原创，未从上述项目取用：

| 文件 | 内容 |
|---|---|
| `src/pacing.js` | 随机区间节奏、分块打字、页面计数校验、风控文案识别、运行权槽位、条数上限、跳过指纹与"没法评价"识别（纯函数，97 项单测） |
| `src/textsource.js` | 文案引擎：清洗（HTML 实体还原 / URL / emoji）、抽句重组、句子级去重、重叠度比对（纯函数，45 项单测） |
| `src/netutil.js` | 接口地址补全、`/v1/models` 推导、密钥非 ASCII 定位、响应 GBK 兜底解码（纯函数，36 项单测） |
| `src/log.js` | 日志行格式、截断、条目还原（纯函数，17 项单测） |
| `src/background.js` | 跨域取评价池 / 晒单图、图片转 base64（canvas 重编码成真 JPEG）、大模型调用与测试 |
| `src/content.js` | 面板 UI、运行权（单/多标签页并发）、跳过与上限、两条链路的编排 |
| `src/options.html` `src/options.js` | 设置页 |

## 免责

- 本项目**仅供个人学习与自用**，请勿商用、请勿转载到公众号/自媒体。
- 自动化操作京东账号**有触发风控的风险**（默认已按"宁慢勿快"设置：随机区间节奏、两单休息 25–60 秒、单轮上限、遇风控立刻停手），但**风险自担**。
- 评价一经发布**不可撤销**，所以默认是「模拟」模式（只填不提交）。
- 本项目不采集、不上传任何账号信息；接口密钥只存在你本机浏览器的 `chrome.storage.local` 里。
