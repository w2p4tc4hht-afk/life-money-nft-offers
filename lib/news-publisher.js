const DEFAULT_FEEDS = [
  "https://blog.ton.org/rss.xml",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://news.google.com/rss/search?q=Telegram+NFT+gifts+OR+Telegram+collectible+gifts&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Fragment+Telegram+NFT+TON&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Portals+TON+NFT+marketplace&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=TON+blockchain+crypto+news&hl=en-US&gl=US&ceid=US:en"
];

const POLL_MS = Math.max(5, Number(process.env.NEWS_POLL_MINUTES) || 15) * 60 * 1000;
const MAX_POSTS_PER_POLL = Math.min(10, Math.max(1, Number(process.env.NEWS_MAX_POSTS) || 4));
const seen = new Set();
let timer = null;
let running = false;
let bootstrapped = false;
let lastRunAt = null;
let lastError = null;
let lastPostedAt = null;
let giftSnapshot = null;

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanText(value = "") {
  return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tagValue(block, tag) {
  const match = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"));
  return match ? cleanText(match[1]) : "";
}

function parseFeed(xml, feedUrl) {
  const items = (xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []).concat(xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || []);
  const entries = items.map(block => {
    const title = tagValue(block, "title");
    const link = tagValue(block, "link") || ((block.match(/<link[^>]*href=["']([^"']+)/i) || [])[1] || "");
    const guid = tagValue(block, "guid") || tagValue(block, "id") || link || title;
    const description = tagValue(block, "description") || tagValue(block, "summary");
    const pubDate = tagValue(block, "pubDate") || tagValue(block, "published");
    const timestamp = pubDate ? Date.parse(pubDate) : Date.now();
    return { title, link, guid, description: description.slice(0, 500), timestamp, feedUrl };
  }).filter(item => item.title && item.link && /^https?:\/\//i.test(item.link));
  return entries;
}

function sourceName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch (_) { return "источник"; }
}

function buildPost(item) {
  const summary = item.description ? "\n\n" + item.description.slice(0, 360) : "";
  return "📰 НОВОСТИ NFT / TON\n\n" + item.title + summary +
    "\n\n🔗 Источник: " + sourceName(item.link) + "\n" + item.link +
    "\n\n#NFT #TON #TelegramGifts";
}

async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "LIFEMONEY-NewsBot/1.0", "Accept": "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("RSS " + response.status + " from " + sourceName(url));
  return parseFeed(await response.text(), url);
}

async function getAvailableGifts(telegram) {
  const result = await telegram("getAvailableGifts", {});
  return Array.isArray(result?.gifts) ? result.gifts : [];
}

function giftSignature(gifts) {
  return gifts.map(g => [g.id, g.star_count, g.total_count, g.remaining_count, g.upgrade_star_count].join(":")).sort().join("|");
}

function giftSummary(gift) {
  const name = cleanText(gift.sticker?.emoji || "🎁");
  const parts = [name + " Новый или обновлённый подарок"];
  if (Number.isFinite(gift.star_count)) parts.push("Цена отправки: " + gift.star_count + " ⭐");
  if (Number.isFinite(gift.total_count)) parts.push("Тираж: " + gift.total_count);
  if (Number.isFinite(gift.remaining_count)) parts.push("Осталось: " + gift.remaining_count);
  if (Number.isFinite(gift.upgrade_star_count)) parts.push("Улучшение: " + gift.upgrade_star_count + " ⭐");
  return parts.join("\n");
}

async function postGiftChanges(telegram, channel) {
  const gifts = await getAvailableGifts(telegram);
  const signature = giftSignature(gifts);
  if (giftSnapshot === null) {
    giftSnapshot = signature;
    return 0;
  }
  if (signature === giftSnapshot) return 0;

  const previous = new Set(giftSnapshot.split("|").filter(Boolean));
  const current = gifts.filter(g => !previous.has([g.id, g.star_count, g.total_count, g.remaining_count, g.upgrade_star_count].join(":")));
  giftSnapshot = signature;
  if (!current.length) return 0;

  for (const gift of current.slice(0, 3)) {
    await telegram("sendMessage", {
      chat_id: channel,
      text: "🎁 ОБНОВЛЕНИЕ TELEGRAM GIFTS\n\n" + giftSummary(gift) +
        "\n\nДанные получены через Telegram Bot API.\n#TelegramGifts #NFT",
      disable_web_page_preview: true
    });
    lastPostedAt = new Date().toISOString();
  }
  return Math.min(current.length, 3);
}

function getFeedUrls() {
  const custom = String(process.env.NEWS_FEEDS || "").split(",").map(x => x.trim()).filter(Boolean);
  return custom.length ? custom : DEFAULT_FEEDS;
}

async function runNewsCycle({ telegram, channel }) {
  if (running) return;
  running = true;
  lastRunAt = new Date().toISOString();
  lastError = null;
  try {
    const results = await Promise.allSettled(getFeedUrls().map(fetchFeed));
    const entries = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
    const fresh = entries
      .filter(item => item.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000)
      .sort((a, b) => b.timestamp - a.timestamp)
      .filter(item => {
        const id = item.guid || item.link;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

    if (!bootstrapped) {
      bootstrapped = true;
      // First run seeds the duplicate filter; it does not dump old headlines into the channel.
    } else {
      for (const item of fresh.slice(0, MAX_POSTS_PER_POLL)) {
        await telegram("sendMessage", {
          chat_id: channel,
          text: buildPost(item),
          disable_web_page_preview: false
        });
        lastPostedAt = new Date().toISOString();
      }
    }

    const failed = results.filter(r => r.status === "rejected").length;
    if (failed === results.length) lastError = "Не удалось получить данные ни из одной RSS-ленты.";
    if (seen.size > 2500) {
      const keep = Array.from(seen).slice(-1200);
      seen.clear();
      keep.forEach(id => seen.add(id));
    }

    try { await postGiftChanges(telegram, channel); }
    catch (error) { lastError = "Telegram Gifts API: " + error.message; }
  } catch (error) {
    lastError = error.message || "Неизвестная ошибка новостного цикла";
  } finally {
    running = false;
  }
}

function startNewsPublisher({ telegram, channel = process.env.NEWS_CHANNEL || "@koszakNEW" }) {
  if (String(process.env.NEWS_AUTOPUBLISH || "true").toLowerCase() === "false") {
    console.log("News autopublisher disabled by NEWS_AUTOPUBLISH=false");
    return;
  }
  if (timer) return;
  if (!process.env.BOT_TOKEN) {
    console.warn("News autopublisher is waiting for BOT_TOKEN");
    return;
  }
  console.log("News autopublisher scheduled for " + channel + " every " + Math.round(POLL_MS / 60000) + " minutes");
  runNewsCycle({ telegram, channel }).catch(error => console.error("News cycle failed:", error.message));
  timer = setInterval(() => {
    runNewsCycle({ telegram, channel }).catch(error => console.error("News cycle failed:", error.message));
  }, POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function getNewsPublisherStatus() {
  return {
    enabled: String(process.env.NEWS_AUTOPUBLISH || "true").toLowerCase() !== "false",
    channel: process.env.NEWS_CHANNEL || "@koszakNEW",
    intervalMinutes: Math.round(POLL_MS / 60000),
    bootstrapped,
    running,
    lastRunAt,
    lastPostedAt,
    lastError
  };
}

module.exports = { startNewsPublisher, getNewsPublisherStatus };
