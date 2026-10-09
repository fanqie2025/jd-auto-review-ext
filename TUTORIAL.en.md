# Tutorial · JD Auto Review (image + 60 characters) — Beta v0.1.1

> **English** · [中文使用教程](使用教程.md)
> ｜ 📥 **Download**: [GitHub Releases page](https://github.com/fanqie2025/jd-auto-review-ext/releases/latest)
>
> ⭐ If this helps you, please **[give the project a Star](https://github.com/fanqie2025/jd-auto-review-ext)** — it is the most practical way to support a small tool like this.

This is a **Chrome / Edge extension**. No Tampermonkey, no Python, no API key required.

What it does: **it takes real reviews that other buyers already published for the same product, recombines their sentences into one new review of ≥60 characters, and attaches the buyer-show photos from those same reviews** — then auto-selects 5 stars, auto-submits, and moves on to the next order. **Orders that cannot be reviewed (JD takeout, service orders, already-reviewed, …) and orders with no usable image are skipped automatically, and skipped orders do NOT count toward your limit.**

**The default mode is "Simulate": it fills everything in but never clicks Publish.** Always run Simulate first.

---

## 1. Install (about 30 seconds)

**Step 0 · download first**
👉 Open the **[Releases page](https://github.com/fanqie2025/jd-auto-review-ext/releases/latest)** and click
`jd-auto-review-ext.zip` under **Assets**. (The release also has `jd-auto-review-ext.jar` —
**byte-identical**, just a different suffix; Chrome uses the `.zip` one.)

Direct links without opening the page (**these always point at the newest release**):
[zip](https://github.com/fanqie2025/jd-auto-review-ext/releases/latest/download/jd-auto-review-ext.zip) ·
[jar](https://github.com/fanqie2025/jd-auto-review-ext/releases/latest/download/jd-auto-review-ext.jar)

1. Unzip the whole `jd-auto-review-ext` folder to a **permanent location** (e.g. `D:\jd-auto-review-ext`).
   Do **not** leave it in Downloads — the browser loads the extension from this folder live; if the folder disappears the extension breaks.
2. Open your browser and go to:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the folder from step 1 (**the folder itself**, not a file inside it).
6. The **options page** opens automatically. If it does not, click the extension icon in the toolbar.

> If Chrome reports "Errors" on the card, send me the red error text.

---

## 2. First run: use "Simulate" for one order

**Simulate = fill in text, set stars, upload images — but never click Publish.** Use it to check the text and photos.

1. Open a JD review page (the options page has buttons that jump there):
   - New review center: `https://comment.m.jd.com/pc-static/center`
   - Legacy pending list: `https://club.jd.com/myJdcomments/myJdcomment.action?sort=0`
2. A panel appears in the **bottom-left** corner (drag its title bar to move it; the position is remembered).
3. Check the version next to the title: it should read **`v0.1.1 · 测试版`**. If not, the page still runs the old script → click **Reload** on `chrome://extensions`, then press F5 on the JD page.
4. Set mode to **模拟 (Simulate)**, set the limit to **`1`**, click **开始 (Start)**.
5. Watch it: it clicks into the first order → fills the text → sets 5 stars → uploads images → then **stops before submitting** with `🧪 模拟模式…没有点发布`.
6. **Look at the page by hand**: is the text ≥60 characters, does it read naturally, any `&ldquo;` garbage, are 2–3 images attached?

> Nothing is submitted in this run. Just refresh the page to reset.

---

## 3. Looks good → switch to "Real"

1. Set the mode to **真实 (Real)** → a confirmation dialog appears; confirm it.
2. Set the limit: **`5`** = submit at most 5 reviews this run; **`0`** = unlimited (**not recommended**, see section 6).
3. Click **开始 (Start)**. It will: open an order → fill text → stars → upload images → click Publish → back to the list → rest a while → next order, until the limit or the list is exhausted.
4. To stop halfway: click **暂停 (Pause)** — it stops after the current step.

**Keep a run at 5 reviews or fewer**, then wait a few hours (or overnight) before the next run. That is the safest usage.

---

## 4. What every control does

| Control | Meaning |
|---|---|
| **模式: 模拟 / 真实** | Simulate = fill only, never submit. Real = actually clicks Publish (asks for confirmation when you switch) |
| **上限 [ N ] 条评价** | Max **reviews published** this run. Counted in *reviews*, not orders (one order can contain several items, and one publish can produce several reviews). `0` = unlimited |
| **保存 (Save)** | Writes the current "mode + limit" back to the options page as the new default |
| **开始 / 暂停** | Start / stop with the current mode |
| Title bar, left | Version number (should be `v0.1.1`) |
| Title bar, **⭐** | Opens this project on GitHub — please give it a Star |
| Title bar, **设置** | Opens the extension options page |
| Log area | Collapse / Copy / Download / Clear. **When something goes wrong, click Download** and send me the txt |

> The panel and the options page are **not two separate configs** — they read and write the same `chrome.storage.local.config`.
> The panel can only change "mode" and "limit"; click Save to write them back. Saving on the options page updates the panel immediately (no page refresh needed).

---

## 5. Which orders get skipped (important)

**Skipped = not published, not counted toward the limit, and the run moves on to the next order.** A skipped item is also remembered, so it will not be clicked again during the same run.

| Case | How it is detected |
|---|---|
| **JD takeout / service orders** | Clicking the card does nothing, or lands on a page we do not recognize → treated as "cannot be opened", skipped |
| **Card click does nothing** | URL unchanged after 2.5s → the run yields for 8s; if no other tab takes over, that card is skipped |
| **Page explicitly says it cannot be reviewed** | When no input box is found, the page text is scanned for `暂无可评价 / 暂不支持评价 / 不可评价 / 无法评价 / 已关闭评价 / 已评价过 / 评价活动已结束` etc. |
| **Landed on an unknown page** | A card was clicked within the last 3 minutes and the page is not one we support → that card is skipped |
| **No image could be matched** | The product has no reusable buyer-show photos |

Two different streak rules:

- **"Cannot be reviewed" skips do NOT count as a streak** — that is a property of the order, not a failure. Each card is clicked at most once per run, so it converges naturally.
- **"No image" skips stop the run after 3 in a row** — that usually means the image pool is empty or JD changed the upload widget.

> These behaviours are configurable on the options page under **图片 → 没法评价 / 没配到图时**:
> `跳过这一单` (default, recommended) / `暂停等我人工处理` / `无图也照发`.
> Note: "无图也照发" only affects the *no image* case — **"cannot be reviewed" orders are still skipped**, because there is no input box to publish into.

---

## 6. Pacing and anti-risk-control (defaults, slow is safe)

| Item | Default | Meaning |
|---|---|---|
| Delay before each click | **4–9 s (random)** | Random wait before every action |
| Pause between steps | 2–4 s (random) | text → stars → images → publish |
| Rest between orders | **25–60 s (random)** | from "order done" to "next order". **Not applied to the first order** |
| Upload wait | 8–15 s (random) | after injecting images |
| Per-run limit | 5 reviews (0 = unlimited) | stops automatically |
| Background concurrency | **off (1)** | only one tab operates at a time. Raising it to 2–5 asks for confirmation |

**Every wait is a random value inside a `min–max` range — never a fixed number**, because a fixed rhythm is itself a bot signature.

At the default pacing one order takes about **30–45 seconds**; with the between-order rest, **5 reviews take about 5–9 minutes**.

Other hard rules:

- **Simulate is the default** because a published review **cannot be undone**;
- If the page shows `正在维修 / 系统繁忙 / 安全验证 / 操作过于频繁`, the run **stops immediately** — do **not** press Start again; wait hours to a day;
- The extension **collects and uploads nothing**. Even if you configure an AI key, it stays in your local browser storage (`chrome.storage.local`).

---

## 7. FAQ

| Symptom | What to do |
|---|---|
| No panel on the page | The page is not supported (only `club.jd.com` / `comment.m.jd.com`), or the extension is disabled |
| "后台无响应（扩展可能被重新加载）" | You clicked Reload on the extensions page → **press F5 on the JD page** |
| "扩展刚被重新加载过，本页面里的旧脚本已失效" | Same as above: F5 |
| Version is not `v0.1.1` | Reload the extension on `chrome://extensions`, then F5 on the JD page |
| It says an API key is missing | **Keep "文案来源 = 现成评价" and no key is needed**; only the AI mode needs one. Then the endpoint is **already filled in as DeepSeek official** (`https://api.deepseek.com/v1/chat/completions`, model `deepseek-chat`) — just paste the key |
| Clicking "去评价" does nothing | It retries and writes a log; if it happens for several orders in a row, send me the log |
| Takeout / service orders keep being skipped | By design (skips do not count toward the limit). If the list is only such orders, it finishes all cards and then reports "no pending cards" |
| Stopped at "已达上限" | The per-run limit kicked in; wait hours or overnight, then press Start |
| Stopped at "出现风控/维护提示" | **Do not press Start again**; wait hours to a day |
| Need to diagnose | Click **Download** in the panel to save the log (text length, image count, whether the page accepted the text, click and response snippets) and send me the txt |

---

## 8. Update / Uninstall

- **Update**: overwrite the old folder with the new version → click **Reload** on `chrome://extensions` → F5 on the JD page.
  Your settings and logs are not lost (they live in browser storage, not in the folder).
- **Uninstall**: `chrome://extensions` → the card → **Remove**.

---

## Credits

**This extension was not written from scratch.** It stands on the shoulders of several MIT-licensed open-source projects:

| Project | License | What we used |
|---|---|---|
| [charmingYouYou/JDAIAutoComment](https://github.com/charmingYouYou/JDAIAutoComment) | MIT | **The base**: the legacy review flow (pending list → review page → publish → back to list), page selectors, the buyer-show image API, the start/pause loop design |
| [hezhengtao/jd-smart-assistant](https://github.com/hezhengtao/jd-smart-assistant) | MIT | **The approach and the API**: scrape good reviews + buyer-show photos with zero API cost; the review-pool endpoint and its parameters |
| [liu-ws/Haoping](https://github.com/liu-ws/Haoping) | MIT | **The new review center selectors** (JD's 2026 redesign, `comment.m.jd.com`) |
| [jQuery](https://jquery.com/) 1.11.1 | MIT | Page manipulation (bundled; the copyright header is kept) |
| [Goodnameisfordoggy/JD-AutomatedTools](https://github.com/Goodnameisfordoggy/JD-AutomatedTools) | Apache-2.0 + special notice | **Design reference only, no code taken** (it is a Python tool) — the "skip orders that cannot be reviewed" idea comes from it |
| loinky/jd-review-assistant, Fzuim/jd-review-bot-skill | — | Documentation read / pitfalls adopted only, **no code taken** |

Which file and which line each item maps to, the full MIT license texts, and what is originally ours:
see **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**.

> **Disclaimer**: this project is for **personal learning and personal use only**. Do not use it commercially, and do not repost it to blogs/self-media (this is also required by the upstream JD-AutomatedTools special notice).
> Automating a JD account carries a risk of triggering risk control — use at your own risk. A published review cannot be undone.
