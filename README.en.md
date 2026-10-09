# JD Auto Review (image + 60 chars) — Chrome/Edge extension · Beta v0.1.0

**English** · [中文说明](README.md)

> ⭐ **If this project helps you, please [give it a Star](https://github.com/fanqie2025/jd-auto-review-ext).** It is the most practical support for a small tool like this.

A standalone **Manifest V3 extension** that ports the old Tampermonkey approach into a real extension: no userscript manager needed.

**No AI, no API key by default**: the review text is taken from **real reviews other buyers already published** for the same product, and the images are the **buyer-show photos attached to those same reviews**.

> 📖 **New here? Read the → [English Tutorial](TUTORIAL.en.md)** (install / run Simulate / switch to Real / which orders are skipped / FAQ), or the **[中文使用教程](使用教程.md)**.
> This README is the **reference manual**: every default value, the rationale, and troubleshooting.

---

## What it does

| Capability | Description |
|---|---|
| **Guaranteed ≥60 characters, no AI** | Scrapes published reviews for the same product → **samples N (default 10) good reviews → recombines their sentences into one new review** (merge mode, not a verbatim copy) → falls back to a single long review → then to a built-in template |
| **Avoids repetition** | Three layers: ① used **sentences** go into a cross-page memory and never reappear ② used **source reviews** are deprioritised ③ the new text is compared against the last 10 published texts, and **≥50% sentence overlap triggers a re-roll** (up to 3 attempts) |
| **One tab at a time** | A "lease" mechanism: exactly one tab is the driver; every other tab only shows the panel and **never acts**. If "去评价" opens a new tab, the old tab yields and stops — two publish pages can no longer upload and submit simultaneously |
| **Orders that cannot be reviewed are skipped** | **JD takeout / service orders / cards that do not respond / unknown pages / pages that say "暂无可评价 · 已评价过 · 评价已关闭"** → skipped: not published, **not counted toward the limit**, and the item is remembered so it is not clicked again this run. These skips do **not** trigger the "3 in a row" stop |
| **No image matched** | Default: **skip this order** (not published, **not counted toward the limit**). Can be changed to "pause" or "publish anyway". 3 such skips in a row stop the run |
| **Auto 5 stars** | Legacy page: clicks `.star5`; new publish page: the four dimensions already default to 「非常好」, so it is left alone |
| **Auto loop** | Publish → back to the list → next order → … until the list is empty |
| **Two code paths** | Legacy: `club.jd.com/myJdcomments/*`; New: `comment.m.jd.com/pc-static/{center,publish}` |
| **Simulate by default** | Fills text / sets stars / uploads images but **never clicks Publish** |
| **Anti-risk-control pacing (slow is safe)** | Every wait is a **random range** (never a fixed number) + a long rest between orders + a per-run limit + an immediate stop on 「正在维修 / 系统繁忙 / 安全验证」 |
| **Full log** | Live log in the panel, **continuing across page navigations**, with copy / download / clear |

---

## Install (Chrome / Edge, ~30 seconds)

1. Unzip `jd-auto-review-ext` to a permanent folder.
2. Open `chrome://extensions` (Edge: `edge://extensions`) → enable **Developer mode**.
3. Click **Load unpacked** → select the `jd-auto-review-ext` folder.
4. The options page opens automatically; otherwise click the toolbar icon.
5. **Keep "文案来源 = 只用现成评价" and you need no API key at all.**

> The **AI endpoint is pre-filled with DeepSeek official** (`https://api.deepseek.com/v1/chat/completions`, model `deepseek-chat`, already in the host whitelist so no extra permission prompt).
> Only if you switch to a self-hosted gateway (e.g. `http://192.168.1.100:8000/v1`) do you need to click **授权当前接口地址** on the options page.

---

## Usage

The panel (light by default, bottom-left, draggable, position remembered):

| Control | Purpose |
|---|---|
| **模式: 模拟 / 真实** | Only two modes. Simulate = fill but never submit; Real = actually clicks Publish (asks for confirmation) |
| **上限 [ N ] 条评价** | Max **reviews** this run, `0` = unlimited. Counted per review, not per order |
| **保存** | Writes "mode + limit" back to the options page as the new default |
| **开始 / 暂停** | Start / stop |
| **⭐** (title bar) | Opens this project on GitHub |
| **设置** (title bar) | Opens the options page |
| Log area | Collapse / Copy / Download / Clear |

**Panel theme** (options → 节奏与防风控 → 面板配色): follow the page background (default) / always light / always dark.

### Panel vs. options page

They are **the same config** (`chrome.storage.local.config`). The panel can change only "mode" and "limit"; everything else is options-page only, but the panel updates live via `chrome.storage.onChanged`.

- **Legacy config migration**: old pacing fields were in milliseconds; they are converted to seconds automatically.
- **Config clamping**: a `0` limit is rejected as invalid (it would mean "never wait"); `min > max` is swapped; negatives become 0. Covered by unit tests.

---

## Skip rules (not counted toward the limit)

| Case | Detection |
|---|---|
| JD takeout / service orders | The card click does nothing, or lands on an unrecognised page |
| Card click does nothing | URL unchanged after 2.5 s → yield for 8 s → if no tab takes over, skip that card |
| Page says it cannot be reviewed | When no input box is found, the page text is scanned for `暂无可评价 / 没有可评价 / 无待评价 / 暂不支持评价 / 不支持评价 / 不可评价 / 无法评价 / 不能评价 / 已关闭评价 / 评价已关闭 / 该订单已评价 / 订单已评价 / 已评价过 / 评价活动已结束 / 评价已结束` |
| Unknown page | A card was clicked within the last 3 minutes and the page is not one we support → skip that card |
| No image matched | No reusable buyer-show photos for the product |

- **"Cannot be reviewed" skips never count toward the streak** — each card is clicked at most once per run, so it converges.
- **"No image" skips stop the run after 3 in a row** (`MAX_SKIP_STREAK`) — that usually means the image pool is empty or the upload widget changed.

> Conservative by design: the "cannot be reviewed" text scan only runs **when no review input box is found**, so a normal publish page is never misjudged. If there is no input box *and* the page says nothing, the run **stops and asks you** instead of guessing.

---

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| **Default mode** | **Simulate** | `模拟` (fill only) / `真实` (submits) |
| **Default limit** | **5** | Per **review**; 0 = unlimited |
| Support new review center | on | `comment.m.jd.com` branches |
| **Text source** | **existing reviews (no key)** | `offline` / `hybrid` (fall back to AI) / `ai` |
| **Composition mode** | **merge (recombine sampled material)** | `merge` (recommended) / `single` / `auto` |
| **Material count / max length** | **10 / 120 chars** | sample N good reviews, stop at ≥60 and stay under the cap |
| **Minimum star rating** | 4 | only 4–5 star reviews are used as material |
| AI endpoint / key / model | **DeepSeek official** / empty / `deepseek-chat` | only needed if you pick AI |
| Minimum review length | 60 | JD's "quality review" threshold |
| Retries when too short | 2 | AI mode only |
| Images per product | random 2–3 | JD requires ≥2 |
| Image source | random from the whole pool | or "prefer the images of the text's own review" |
| Avoid reusing an image in one run | on | reduces image dedup hits |
| Auto attach images | on | |
| **Cannot review / no image** | **skip this order** | `skip` / `pause` / `publish anyway` (only affects "no image") |
| Delay before each click | 4–9 s random | |
| Pause between steps | 2–4 s random | |
| Rest between orders | **25–60 s random** | first order is exempt |
| Per-run limit | **5** (0 = unlimited) | checked **before** publishing, so an order is never half-reviewed |
| **Background concurrency** | **1 (off)** | raising it to 2–5 requires a confirmation; it is flagged as risky |
| Chunked typing | on | re-types in 6–14 char chunks when the page counter disagrees |
| Stop on risk control | on | stops immediately on maintenance / busy / verification text |
| Image upload mode | one at a time | simulating a human picking files |
| Batch / gap | **1 image / 1.5–4 s** | |
| Wait for upload | **8–15 s random** | |

> **All pacing is in seconds** (decimals allowed, e.g. 2.5). The conversion lives in `src/pacing.js` (`sec2ms()`) and is unit-tested.

---

## Safety / risk control

**Core principle: slow beats fast.** JD's rate limiting is behaviour-triggered — the same click every 5 seconds exactly is far more suspicious than a random 4–9 seconds.

Built-in protections:

1. **All waits are random ranges** — no fixed numbers anywhere;
2. **A hard 25–60 s rest between orders** (the most sensitive spot);
3. **An extra 2 s before clicking Publish**;
4. **A per-run limit** (default 5) that stops and tells you to come back in a few hours;
5. **Immediate stop on risk-control text** — and it tells you **not to retry** (retrying only extends the block);
6. **Text verification** — it reads the page's own "已写 N 字 / N / 500" counter and re-types char by char if they disagree, so you never submit an empty text;
7. **Simulate by default**.

At the default pacing one order is ~30–45 s, so **5 reviews take ~5–9 minutes**.

- Always run **Simulate** first; run the real thing in idle hours and finish in one go.
- The extension **collects and uploads nothing**; an API key stays in `chrome.storage.local`.
- A published review **cannot be undone** — which is why Simulate is the default.

---

## Testing (do this right after installing)

The options page has a "测试" section with three buttons that use **the exact same code path as a real run** (all in the background):

| Button | What it verifies |
|---|---|
| **探测模型** | `GET /v1/models` on your gateway, rendered as clickable buttons; also validates the model name you typed |
| **测试大模型** | A real request: reachability, key, model name, and whether the reply is ≥60 chars |
| **测试取现成评价** | The lifeline of the no-AI mode: can the product's image reviews be fetched (count / with-image count / ≥60-char count / first 3 samples) **plus a preview of the text that would actually be filled in** |

Both tests save your current settings first, so they test exactly what you typed.

Two things the AI test handles for you automatically:
1. **Requesting host permission** for the endpoint's origin (self-hosted gateways are not in the built-in whitelist and would otherwise fail with `Failed to fetch`);
2. **Completing the endpoint path** — filling in just `/v1` (or even a bare host) works; the result shows the "actual URL (auto-completed)".

**The key must be plain ASCII**: HTTP headers only allow ISO-8859-1, so a key containing Chinese/full-width characters makes `fetch` throw `String contains non ISO-8859-1 code point`. It is now caught early and names the exact character: `密钥里有非 ASCII 字符：第 7 个是「中」(U+4E2D)`.

---

## Popup blocking

**Why**: clicks issued by an extension are not user gestures, so any `window.open` in the page (including async ones after a click) gets blocked by Chrome's popup blocker — the symptom is "I clicked and nothing happened".

**How it is handled**: on page load `window.open` is replaced with an in-place navigation that returns a **fake window object**, so the page still receives a handle and `w.location = url` works. Legitimate `target="_blank"` anchors are neutralised the same way. The log records each interception. This can be turned off on the options page.

**If a popup is still blocked** (you disabled the switch, or the page opens windows differently): click the "popup blocked" icon in the address bar → **Always allow**, or add `https://comment.m.jd.com` and `https://club.jd.com` to the allow list at `chrome://settings/content/popups`.

---

## One tab at a time (the lease)

- Each tab acquires a **lease** before working (`JDAR_LEASE` in `chrome.storage.local`, a set of `{tabId: heartbeat}` slots);
- The holder is the **driver tab** and renews every 10 s; **other tabs only display, never act, never submit**;
- How many drivers are allowed is the options-page **后台并发** setting, **default 1**, range 1–5;
- A driver that has not renewed for 30 s (closed / crashed) can be **taken over**;
- If a card click does not navigate: the tab **yields the lease** first; **8 s later, if no tab took over**, it decides "this order cannot be opened" and **skips it, then continues** (this replaced the old behaviour of stopping the whole run);
- List clicks are **tried only once** (trying several candidates was exactly what opened multiple tabs);
- Before clicking Publish it **re-confirms** it is still the driver.

> Yielding only affects *who keeps running*; it does **not** weaken submit protection — the `canDrive()` check before publishing is what prevents double submission.

---

## Log

- The lower half of the panel is a live log: page load, review-pool size, text source and length, image count, whether the page accepted the text, click actions, post-publish feedback snippet, risk-control hits, exceptions.
- **Cross-page**: the flow navigates between `club.jd.com` and `comment.m.jd.com`, so the log is stored in `chrome.storage.local` (last 800 entries) and replayed on each new page with a `===== 本页 … =====` separator.
- Copy / Download (`jdar-log-<time>.txt`) / Clear.
- Format: `[hh:mm:ss] LEVEL message {data}`.

**When something goes wrong, download the log and send it — it pinpoints exactly where it stalled.**

---

## Credits

| Project | License | How we used it |
|---|---|---|
| [charmingYouYou/JDAIAutoComment](https://github.com/charmingYouYou/JDAIAutoComment) v8.6 | MIT | **Code ported**: legacy review flow, `.f-textarea textarea` / `.p-name` / `.star5` / `img[src*="imageUpload"]`, the buyer-show image API, the start/pause loop |
| [hezhengtao/jd-smart-assistant](https://github.com/hezhengtao/jd-smart-assistant) v4.1 | MIT | **API and approach**: scrape good reviews + buyer-show photos at zero API cost; the review-pool endpoint and parameters |
| [liu-ws/Haoping](https://github.com/liu-ws/Haoping) v0.1.0 | MIT | **Selectors**: the new review center (`pc-static/{center,publish}`, `.scoreBox-conter-score-star-box-item`, `.rate-publish-submit-button`) |
| [jQuery](https://jquery.com/) 1.11.1 | MIT | **Bundled verbatim** (the upstream script used a CDN `@require`; an extension cannot remote-load scripts under the MV3 CSP) |
| [Goodnameisfordoggy/JD-AutomatedTools](https://github.com/Goodnameisfordoggy/JD-AutomatedTools) 3.2.4 | Apache-2.0 + special notice | **Design reference only, no code taken** (Python): "smallest reviewable unit", "skip when the page does not exist" |
| [loinky/jd-review-assistant](https://github.com/loinky/jd-review-assistant) v0.7.0 | unspecified | README/structure read only, **no code taken** |
| [Fzuim/jd-review-bot-skill](https://github.com/Fzuim/jd-review-bot-skill) | — | Conclusions only, **no code taken**: the form only accepts real keyboard events; fill the text *before* clicking the stars |

👉 **File-and-line mapping, the full MIT license texts, and what is originally ours:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).**

> **Disclaimer**: for **personal learning and personal use only**. Do not use commercially and do not repost (also required by the upstream JD-AutomatedTools special notice). Automating a JD account may trigger risk control — at your own risk; reviews cannot be unpublished.

---

## Repository layout

```
manifest.json          MV3 manifest (storage/tabs + JD and popular LLM hosts)
使用教程.md             Chinese step-by-step tutorial
TUTORIAL.en.md         English step-by-step tutorial
README.md              Chinese reference manual
README.en.md           this file — English reference manual
THIRD-PARTY-NOTICES.md credits: provenance, license texts, line mapping
LICENSE                MIT (this project) + no-commercial-use notice
icons/                 16/48/128 icons
src/defaults.js        all default settings
src/pacing.js          pacing & risk control (pure functions, unit-tested)
src/textsource.js      text engine: cleaning / filtering / sentence recombination
src/netutil.js         URL completion / key sanitising / header byte checks
src/log.js             log formatting and truncation
src/background.js      review pool, buyer-show images, image → base64, LLM calls
src/content.js         all page interaction: panel, typing, images, stars, publishing
src/options.html/js    options page
```

Unit tests (pure functions, runnable with plain `node`):

| File | Coverage | Result |
|---|---|---|
| `pacing.test.cjs` | random ranges, chunked typing, counter parsing, risk-control detection, lease slots, per-run limit, skip fingerprints, unreviewable detection | **97 passed** |
| `textsource.test.cjs` | matching, sentence recombination, templates, cleaning, filtering, dedup | **45 passed** |
| `netutil.test.cjs` | URL completion (10 forms), models URL derivation (7 forms), key sanitising, non-ASCII location, GBK fallback | **36 passed** |
| `log.test.cjs` | line format, truncation, tail, error text, entry rendering | **17 passed** |

**195 assertions, all green.**

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No panel | Unsupported page, or the extension is disabled (`chrome://extensions`) |
| "后台无响应" | You reloaded the extension → refresh the JD page |
| "API key missing" | Only AI mode needs a key; keep the default text source |
| "页面计数与我们填入的字数对不上" | It re-types char by char automatically; if it still disagrees, check the box by hand |
| Stopped at the per-run limit | Anti-risk-control; wait hours or overnight |
| "出现风控/维护提示，已立刻停手" | **Do not press Start again**; it is a soft-block signature. Wait hours to a day |
| Cannot reach page buttons | The panel is bottom-left and draggable; the old top-right position covered the 「去评价」 column |
| "去评价" does not navigate | It retries candidates, verifies the URL, yields for 8 s, then skips that card and continues |
| Garbled text like `������÷` | The legacy JD endpoints return **GBK**; it is now detected and decoded as GBK (logged) |
| `&ldquo;` appears in the text | HTML entities are decoded automatically (semicolon optional) |
| Unknown page → stopped | The "last clicked card" fingerprint expired (3 min) or was unavailable; go back to the list and press Start again |
| "no input box found" but there is one | The page may not have finished loading; refresh. If it persists, JD changed the markup — send me the log |
