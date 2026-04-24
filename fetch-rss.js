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

/**
 * HTML 書き出し先のルート。
 * ローカル実行: output/  (デフォルト)
 * GitHub Actions: . (リポジトリのルート) → bio-news/日付/ に直接書き出す
 */
const OUTPUT_ROOT = process.env.OUTPUT_ROOT
  ? path.resolve(process.env.OUTPUT_ROOT)
  : path.join(__dirname, "output");

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

/** JST の今日を YYYY-MM-DD */
function todayJstYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

// ----------------------------------------------------------------
// Gemini API（REST・追加パッケージ不要）
// ----------------------------------------------------------------

/** Gemini にプロンプトを送り、生テキストを返す。失敗時は "" を返す（例外を投げない） */
function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Promise.resolve("");

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
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
            console.warn("[Gemini] HTTPエラー:", res.statusCode, data.slice(0, 400));
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
  "summary": "研究の要約（2〜3文・高校生にも分かりやすく）",
  "highlight": "この研究のすごいところ・新しさ（1〜2文）"
}`;

  console.log("[Gemini] 要約生成中:", title.slice(0, 60) + "…");
  const raw = await callGemini(prompt);

  try {
    const jsonStr = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);
    console.log("[Gemini] 生成成功 ✓");
    return {
      titleJa: parsed.titleJa || "",
      summary: parsed.summary || "",
      highlight: parsed.highlight || "",
    };
  } catch {
    console.warn("[Gemini] JSONパース失敗。生テキスト:", raw.slice(0, 200));
    return { titleJa: "", summary: raw.slice(0, 300), highlight: "" };
  }
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
}) {
  const safeTitle = escapeHtml(title);
  const safeTitleJa = escapeHtml(titleJa || "");
  const safeSource = escapeHtml(sourceUrl || "");
  const safeSummary = escapeHtml(summary || "");
  const safeHighlight = escapeHtml(highlight || "");
  const gradient = TOPIC_COLORS[(topicIndex - 1) % TOPIC_COLORS.length];

  const summaryHtml = safeSummary
    ? `<p class="mt-2 text-sm text-slate-600">${safeSummary}</p>`
    : `<p class="mt-2 text-sm text-slate-400">（要約は生成されませんでした）</p>`;

  const highlightHtml = safeHighlight
    ? `<p class="mt-2 text-sm text-amber-950">${safeHighlight}</p>`
    : `<p class="mt-2 text-sm text-amber-400">（自動生成されませんでした）</p>`;

  const titleJaHtml = safeTitleJa
    ? `<p class="mt-1 text-base font-semibold opacity-90">${safeTitleJa}</p>`
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
  <div class="max-w-4xl mx-auto px-4 py-10">

    <!-- ヘッダー -->
    <article class="rounded-3xl border border-slate-200 bg-white shadow-xl overflow-hidden">
      <div class="bg-gradient-to-r ${gradient} px-6 py-5 text-white">
        <p class="text-xs font-semibold tracking-wide opacity-90">
          DETAIL PAGE / TOPIC ${topicIndex} / ${dateStr}
        </p>
        <h1 class="mt-1 text-2xl font-bold">${safeTitle}</h1>
        ${titleJaHtml}
        <p class="mt-3 text-sm opacity-90">
          <a href="${safeSource}" target="_blank" rel="noopener"
             class="underline underline-offset-2">元記事（Nature 等）→</a>
        </p>
      </div>

      <!-- 本文エリア -->
      <div class="p-6 grid gap-6 lg:grid-cols-[1.1fr_0.9fr] items-start">

        <!-- 左：図解エリア -->
        <div class="rounded-3xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 min-h-[320px]">
          <h2 class="text-lg font-bold text-slate-700">図解エリア</h2>
          <p class="mt-2 text-sm text-slate-500">ここに論文の全体像を示す図解を追加します。</p>
          <div class="mt-6 space-y-3">
            <div class="rounded-2xl bg-white p-4 text-sm text-slate-700 shadow-sm">① 出発点・背景</div>
            <div class="rounded-2xl bg-white p-4 text-sm text-slate-700 shadow-sm">② 何を調べたか</div>
            <div class="rounded-2xl bg-white p-4 text-sm text-slate-700 shadow-sm">③ 何がわかったか</div>
            <div class="rounded-2xl bg-white p-4 text-sm text-slate-700 shadow-sm">④ 何が新しいか</div>
          </div>
        </div>

        <!-- 右：テキストエリア -->
        <div class="space-y-4">
          <div class="rounded-2xl bg-slate-50 p-5 min-h-[90px] border border-slate-200">
            <h3 class="font-bold text-slate-800">要約</h3>
            ${summaryHtml}
          </div>
          <div class="rounded-2xl bg-amber-50 p-5 border border-amber-200 min-h-[90px]">
            <h3 class="font-bold text-amber-900">ここがすごい</h3>
            ${highlightHtml}
          </div>
          <div class="rounded-2xl bg-sky-50 p-5 border border-sky-200 min-h-[90px]">
            <h3 class="font-bold text-sky-900">授業への接続</h3>
            <p class="mt-2 text-sm text-sky-950">（授業でどう使えるかを記入します）</p>
          </div>
        </div>
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
  const lines = ["🧬 今日のバイオニュース", ""];
  top3.forEach((item, i) => {
    const n = i + 1;
    const detailUrl = `${BASE_URL}/bio-news/${dateStr}/topic-${n}.html`;
    // 日本語タイトルがあればそちらを優先
    const displayTitle = item._titleJa || item.title || "(無題)";
    lines.push(`${n}. ${displayTitle}`);
    lines.push(`詳細：${detailUrl}`);
    lines.push("");
  });
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
  const top3 = feed.items.slice(0, 3);

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
  console.log("date (JST):", dateStr);
  console.log("");

  // 3. Gemini で各記事の要約を生成 → HTML を書き出し
  const outDir = path.join(OUTPUT_ROOT, "bio-news", dateStr);
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 0; i < top3.length; i++) {
    const item = top3[i];
    const n = i + 1;

    // RSS の概要文（description / contentSnippet）を取得
    const description = item.contentSnippet || item.content || item.description || "";

    // Gemini で要約生成（APIキーがなければスキップ）
    // 2件目以降はレート制限を避けるため3秒待つ
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));
    const { titleJa, summary, highlight } = await generateSummary(
      item.title || "",
      description
    );

    // LINE 用に日本語タイトルを item に付与
    item._titleJa = titleJa;

    // HTML 書き出し
    const filePath = path.join(outDir, `topic-${n}.html`);
    fs.writeFileSync(
      filePath,
      topicPageHtml({
        title: item.title || "(無題)",
        sourceUrl: item.link || "",
        topicIndex: n,
        dateStr,
        titleJa,
        summary,
        highlight,
      }),
      "utf8"
    );
    console.log("書き出し:", filePath);
  }
  console.log("");

  // 4. LINE 用テキスト表示 & 送信
  const lineText = buildLineMessage(top3, dateStr);
  console.log("--- LINE 用テキスト ---");
  console.log(lineText);
  console.log("");

  await sendLineMessage(lineText);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("エラー:", err.message);
    process.exit(1);
  });
