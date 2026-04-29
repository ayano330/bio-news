const fs = require("fs");
const https = require("https");
const path = require("path");
const RSSParser = require("rss-parser");

const FEED_URL =
  "https://feeds.nature.com/subjects/biological-sciences/nature.rss";

/** GitHub Pages のベース（末尾スラッシュなし）。環境変数 BASE_URL で上書き可 */
const BASE_URL = (
  process.env.BASE_URL || "https://ayano330.github.io/bio-news"
).replace(/\/$/, "");

/** 取得・配信する本数（案1: デフォルト1本）。必要なら環境変数 TOP_N で変更可 */
const TOP_N = Math.max(1, Math.min(3, Number(process.env.TOP_N || 1)));

/**
 * HTML 書き出し先のルート。
 * ローカル実行: output/  (デフォルト)
 * GitHub Actions: . (リポジトリのルート) → bio-news/日付/ に直接書き出す
 */
const OUTPUT_ROOT = process.env.OUTPUT_ROOT
  ? path.resolve(process.env.OUTPUT_ROOT)
  : path.join(__dirname, "output");

/** Gemini のモデル ID（ListModels またはドキュメントで確認）。古い gemini-1.5-flash は v1beta で未提供になることがある */
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const LINE_MESSAGE_REL = path.join("bio-news", ".last_line_message.txt");

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------

function escapeHtml(text) {
  if (text == null || text === "") return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** RSS の HTML タグを除いた平文（要約失敗時の補助表示用） */
function stripTags(htmlish) {
  if (!htmlish) return "";
  return String(htmlish)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tryDecodeHtmlEntities(text) {
  if (!text) return "";
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractMetaDescription(html) {
  if (!html) return "";
  const s = String(html);
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) return tryDecodeHtmlEntities(m[1]).trim();
  }
  return "";
}

function fetchUrl(url, { timeoutMs = 12000, maxBytes = 512_000 } = {}) {
  if (!url) return Promise.resolve("");
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 400) {
          res.resume();
          return resolve("");
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > maxBytes) {
            req.destroy();
          }
        });
        res.on("end", () => resolve(data));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve("");
    });
    req.on("error", () => resolve(""));
    req.end();
  });
}

async function buildRssExcerpt(item) {
  const raw =
    item?.contentSnippet ||
    item?.content ||
    item?.description ||
    item?.summary ||
    "";
  const cleaned = stripTags(raw);
  if (cleaned) return cleaned.slice(0, 2000);

  // RSS に概要が無い場合は、元ページの meta description を拾う（取れれば表示）
  const html = await fetchUrl(item?.link || "");
  const meta = extractMetaDescription(html);
  if (meta) return meta.slice(0, 2000);

  // それでも無ければ「空」にはしない（テンプレが最終エラー表示にならないようにする）
  return "（RSSに概要がないため抜粋を取得できませんでした）";
}

/** JST の今日を YYYY-MM-DD */
function todayJstYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

// ----------------------------------------------------------------
// Gemini API（REST・追加パッケージ不要）
// ----------------------------------------------------------------

/** Gemini にプロンプトを送り、生テキストを返す。失敗時は "" を返す（例外を投げない） */
function callGemini(prompt, { attempt = 1, maxAttempts = 4 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Promise.resolve("");

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
  });

  const modelPath = `/v1beta/models/${GEMINI_MODEL}:generateContent`;

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `${modelPath}?key=${encodeURIComponent(apiKey)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", async () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(
                (json.candidates?.[0]?.content?.parts?.[0]?.text || "").trim()
              );
            } catch {
              resolve("");
            }
          } else {
            const status = res.statusCode || 0;
            const retryable = status === 429 || status === 503 || status === 500;
            console.warn("[Gemini] HTTPエラー:", status, data.slice(0, 400));

            if (retryable && attempt < maxAttempts) {
              const base = 1500;
              const jitter = Math.floor(Math.random() * 400);
              const wait = base * Math.pow(2, attempt - 1) + jitter;
              console.log(`[Gemini] リトライ (${attempt + 1}/${maxAttempts}) まで ${wait}ms 待機…`);
              await sleep(wait);
              resolve(
                await callGemini(prompt, { attempt: attempt + 1, maxAttempts })
              );
              return;
            }

            resolve("");
          }
        });
      }
    );
    req.on("error", (err) => {
      console.warn("[Gemini] 接続エラー:", err.message);
      resolve("");
    });
    req.write(body);
    req.end();
  });
}

/**
 * JSON 形式が失敗したときのプレーンテキスト要約（日本語のみ・本文のみ返す想定）
 */
async function generatePlainJapaneseSummary(title, description) {
  const descPart = description
    ? `\n概要（英語）：${description.slice(0, 900)}`
    : "";
  const prompt = `あなたは科学ニュースの編集者です。次の生物学関連の記事について、日本語で高校生にも分かるように5〜8文で要約してください。前置き・見出し・箇条書き記号は不要で、要約の本文だけを出力してください。

タイトル（英語）：${title}${descPart}`;

  console.log("[Gemini] プレーン要約にフォールバック…");
  const text = (await callGemini(prompt)).trim();
  return text;
}

/**
 * RSS のタイトルと概要文から日本語の要約データを生成する。
 * GEMINI_API_KEY が未設定の場合は空文字オブジェクトを返す。
 * @returns {{ titleJa: string, summary: string, highlight: string }}
 */
async function generateSummary(title, description) {
  if (!process.env.GEMINI_API_KEY) {
    console.log("[Gemini] GEMINI_API_KEY が未設定のためスキップします");
    return { titleJa: "", summary: "", highlight: "" };
  }

  const descPart = description
    ? `\n概要（英語）：${description.slice(0, 600)}`
    : "";

  const prompt = `以下の生物学論文について、日本語で答えてください。
タイトル（英語）：${title}${descPart}

次の3項目だけをJSON形式で返してください（コードブロック・余分な文字は不要）：
{
  "titleJa": "日本語タイトル（自然な日本語・30文字以内）",
  "summary": "研究の要約（5〜8文・高校生にも分かりやすく）",
  "highlight": "ポイント（3項目。各項目は短い1文で、改行で区切る）"
}`;

  console.log("[Gemini] 要約生成中:", title.slice(0, 60) + "…");
  const raw = await callGemini(prompt);

  let titleJa = "";
  let summary = "";
  let highlight = "";

  try {
    const jsonStr = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);
    titleJa = (parsed.titleJa || "").trim();
    summary = (parsed.summary || "").trim();
    highlight = (parsed.highlight || "").trim();
    if (summary) {
      console.log("[Gemini] 生成成功 ✓");
    }
  } catch {
    console.warn("[Gemini] JSONパース失敗。生テキスト:", raw.slice(0, 200));
  }

  if (!summary) {
    summary = await generatePlainJapaneseSummary(title, description);
    if (summary) console.log("[Gemini] プレーン要約で成功 ✓");
  }

  return { titleJa, summary, highlight };
}

// ----------------------------------------------------------------
// HTML テンプレート
// ----------------------------------------------------------------

/** トピック番号ごとのグラデーション色クラス */
const TOPIC_COLORS = [
  "from-emerald-600 to-teal-500",  // topic-1
  "from-sky-600 to-cyan-500",       // topic-2
  "from-violet-600 to-fuchsia-500", // topic-3
];

function topicPageHtml({
  title,
  sourceUrl,
  topicIndex,
  dateStr,
  titleJa,
  summary,
  highlight,
  rssExcerpt,
}) {
  const safeTitle = escapeHtml(title);
  const safeTitleJa = escapeHtml(titleJa || "");
  const safeSource = escapeHtml(sourceUrl || "");
  const safeSummary = escapeHtml(summary || "");
  const safeHighlightRaw = String(highlight || "").trim();
  const safeExcerpt = escapeHtml(rssExcerpt || "");
  const gradient = TOPIC_COLORS[(topicIndex - 1) % TOPIC_COLORS.length];

  let summaryBlock;
  if (safeSummary) {
    summaryBlock = `<div class="mt-4 text-lg leading-relaxed text-slate-800 whitespace-pre-wrap">${safeSummary}</div>`;
  } else if (safeExcerpt) {
    summaryBlock = `<p class="mt-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
  自動要約を取得できませんでした。RSS の英語抜粋をそのまま表示します。
</p>
<div class="mt-4 text-base leading-relaxed text-slate-700 whitespace-pre-wrap">${safeExcerpt}</div>`;
  } else {
    summaryBlock = `<p class="mt-4 text-slate-500">要約を表示できませんでした（API またはネットワークを確認してください）。</p>`;
  }

  let highlightSection = "";
  if (safeHighlightRaw) {
    const items = safeHighlightRaw
      .split(/\r?\n/)
      .map((s) => s.replace(/^[\-\u2022・\d\.\)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 6);
    const listHtml = items.length
      ? `<ul class="mt-3 space-y-2">
${items
  .map(
    (it) =>
      `  <li class="flex gap-2 text-base text-amber-950"><span class="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-500"></span><span>${escapeHtml(
        it
      )}</span></li>`
  )
  .join("\n")}
</ul>`
      : `<p class="mt-2 text-base text-amber-950 whitespace-pre-wrap">${escapeHtml(
          safeHighlightRaw
        )}</p>`;
    highlightSection = `<section class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-5">
  <h2 class="text-sm font-bold uppercase tracking-wide text-amber-900">ポイント</h2>
  ${listHtml}
</section>`;
  }

  const titleJaHtml = safeTitleJa
    ? `<p class="mt-2 text-xl font-semibold">${safeTitleJa}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitleJa || safeTitle}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-100 text-slate-800">
  <div class="max-w-3xl mx-auto px-4 py-10">

    <article class="rounded-3xl border border-slate-200 bg-white shadow-xl overflow-hidden">
      <div class="bg-gradient-to-r ${gradient} px-6 py-6 text-white">
        <p class="text-xs font-semibold tracking-wide opacity-90">
          ${dateStr} · topic ${topicIndex}
        </p>
        <h1 class="mt-2 text-xl font-bold leading-snug md:text-2xl">${safeTitle}</h1>
        ${titleJaHtml}
        <p class="mt-4 text-sm opacity-95">
          <a href="${safeSource}" target="_blank" rel="noopener"
             class="underline underline-offset-2 font-medium">元記事を開く（Nature 等）</a>
        </p>
      </div>

      <div class="p-6 md:p-8">
        <h2 class="text-sm font-bold uppercase tracking-wide text-slate-500">日本語要約</h2>
        ${summaryBlock}
        ${highlightSection}
      </div>
    </article>

  </div>
</body>
</html>
`;
}

// ----------------------------------------------------------------
// LINE 用テキスト組み立て
// ----------------------------------------------------------------

function buildLineMessage(top3, dateStr) {
  const item = top3[0];
  const detailUrl = `${BASE_URL}/bio-news/${dateStr}/topic-1.html`;
  const displayTitle = item?._titleJa || item?.title || "(無題)";

  const lines = ["🧬 今日のバイオニュース（1本）", "", `■ ${displayTitle}`];
  lines.push("", `要約はこちら：${detailUrl}`, `元記事：${item?.link || ""}`);
  return lines.join("\n").trimEnd();
}

// ----------------------------------------------------------------
// LINE Messaging API プッシュ送信
// ----------------------------------------------------------------

function sendLineMessage(text) {
  const token = process.env.LINE_TOKEN;
  const userId = process.env.LINE_USER_ID;

  if (!token || !userId) {
    console.log("[LINE] LINE_TOKEN / LINE_USER_ID が未設定のためスキップします");
    return Promise.resolve();
  }

  const body = JSON.stringify({
    to: userId,
    messages: [{ type: "text", text }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.line.me",
        path: "/v2/bot/message/push",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            console.log("[LINE] 送信成功 ✓");
            resolve();
          } else {
            reject(new Error(`LINE API エラー: ${res.statusCode} ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ----------------------------------------------------------------
// メイン処理
// ----------------------------------------------------------------

async function main() {
  // 1. RSS 取得
  const parser = new RSSParser({
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml, text/xml, */*;q=0.9",
    },
  });

  const feed = await parser.parseURL(FEED_URL);
  const top3 = feed.items.slice(0, TOP_N);

  console.log("--- 取得した3件 ---");
  top3.forEach((item, i) => {
    console.log(i + 1 + ".", item.title);
    console.log("   link:", item.link || "(なし)");
  });
  console.log("");

  // 2. 日付
  const dateStr = todayJstYmd();
  console.log("BASE_URL:", BASE_URL);
  console.log("OUTPUT_ROOT:", OUTPUT_ROOT);
  console.log("GEMINI_MODEL:", GEMINI_MODEL);
  console.log("TOP_N:", TOP_N);
  console.log("date (JST):", dateStr);
  console.log("");

  // 3. Gemini で各記事の要約を生成 → HTML を書き出し
  const outDir = path.join(OUTPUT_ROOT, "bio-news", dateStr);
  fs.mkdirSync(outDir, { recursive: true });

  // 案1: 1本だけを濃く作る（TOP_N を上げても topic-1 だけ生成）
  const target = top3[0];
  if (target) {
    const n = 1;

    // RSS の概要文（無ければ元ページから抜粋を補完）
    const description =
      target.contentSnippet ||
      target.content ||
      target.description ||
      target.summary ||
      "";
    const rssExcerpt = await buildRssExcerpt(target);

    // Gemini で要約生成（APIキーがなければスキップ）
    const { titleJa, summary, highlight } = await generateSummary(
      target.title || "",
      description
    );

    // LINE 用に日本語タイトルを item に付与
    target._titleJa = titleJa;
    target._summary = summary;

    // HTML 書き出し
    const filePath = path.join(outDir, `topic-${n}.html`);
    fs.writeFileSync(
      filePath,
      topicPageHtml({
        title: target.title || "(無題)",
        sourceUrl: target.link || "",
        topicIndex: n,
        dateStr,
        titleJa,
        summary,
        highlight,
        rssExcerpt,
      }),
      "utf8"
    );
    console.log("書き出し:", filePath);
  }
  console.log("");

  // 4. LINE 用テキスト（後続ステップで送信する場合はファイルに保存）
  const lineText = buildLineMessage(top3, dateStr);
  console.log("--- LINE 用テキスト ---");
  console.log(lineText);
  console.log("");

  const lineMsgPath = path.join(OUTPUT_ROOT, LINE_MESSAGE_REL);
  fs.mkdirSync(path.dirname(lineMsgPath), { recursive: true });
  fs.writeFileSync(lineMsgPath, lineText, "utf8");

  const skipLine =
    process.env.SKIP_LINE === "1" || process.env.SKIP_LINE === "true";
  if (skipLine) {
    console.log(
      "[LINE] SKIP_LINE のため送信しません。プッシュ後に `node fetch-rss.js --send-line` で送信できます。"
    );
  } else {
    await sendLineMessage(lineText);
  }
}

function runSendLineOnly() {
  const lineMsgPath = path.join(OUTPUT_ROOT, LINE_MESSAGE_REL);
  if (!fs.existsSync(lineMsgPath)) {
    return Promise.reject(
      new Error(`LINE 用テキストが見つかりません: ${lineMsgPath}`)
    );
  }
  const text = fs.readFileSync(lineMsgPath, "utf8");
  return sendLineMessage(text);
}

const argv = process.argv.slice(2);
if (argv.includes("--send-line")) {
  runSendLineOnly()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("エラー:", err.message);
      process.exit(1);
    });
} else {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("エラー:", err.message);
      process.exit(1);
    });
}
