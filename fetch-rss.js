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
// HTML テンプレート
// ----------------------------------------------------------------

function topicPageHtml({ title, sourceUrl, topicIndex, dateStr }) {
  const safeTitle = escapeHtml(title);
  const safeSource = escapeHtml(sourceUrl || "");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
</head>
<body>
  <p><a href="${safeSource}">元記事（Nature 等）</a></p>
  <h1>${safeTitle}</h1>
  <p>トピック ${topicIndex} / ${dateStr}</p>
  <section>
    <h2>図解エリア</h2>
    <p>ここに図解をのせる予定です。</p>
  </section>
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
    lines.push(`${n}. ${item.title || "(無題)"}`);
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

  // 3. HTML 3枚を書き出し
  const outDir = path.join(OUTPUT_ROOT, "bio-news", dateStr);
  fs.mkdirSync(outDir, { recursive: true });

  top3.forEach((item, i) => {
    const n = i + 1;
    const filePath = path.join(outDir, `topic-${n}.html`);
    fs.writeFileSync(
      filePath,
      topicPageHtml({
        title: item.title || "(無題)",
        sourceUrl: item.link || "",
        topicIndex: n,
        dateStr,
      }),
      "utf8"
    );
    console.log("書き出し:", filePath);
  });
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
