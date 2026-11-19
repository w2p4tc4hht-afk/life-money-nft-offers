const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { checkSessionStore } = require("./lib/session-store");
const { sendMenu: sendArcadeMenu, handleCallback: handleArcadeCallback } = require("./lib/arcade");

const app = express();
const PORT = process.env.PORT || 3000;
const offers = new Map();
const { startNewsPublisher, getNewsPublisherStatus } = require("./lib/news-publisher");

app.use(express.json({ limit: "100kb" }));

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = (process.env.BOT_USERNAME || "koszak_bot_ai").replace(/^@/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(24).toString("hex");

async function telegram(method, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not configured");
  const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

async function sendOfferToChat(chatId, offer) {
  const nl = String.fromCharCode(10);
  const message = "🎁 LIFE MONEY NFT OFFER" + nl + nl +
    "Пользователь предлагает вам " + offer.price + " " + offer.currency +
    " за " + offer.giftName + " " + offer.giftNumber + "." + nl + nl +
    "Предложение действует до " + new Date(offer.expiresAt).toLocaleString("ru-RU") +
    nl + nl + "Это пользовательское предложение LIFE MONEY, не официальный заказ Telegram. Цена информационная; NFT и средства автоматически не передаются.";
  return telegram("sendMessage", {
    chat_id: chatId,
    text: message,
    reply_markup: {
      inline_keyboard: [[
        { text: "✕ Отклонить", callback_data: "decline:" + offer.id },
        { text: "✓ Принять", callback_data: "accept:" + offer.id }
      ], [
        { text: "Открыть NFT", url: offer.giftUrl }
      ]]
    }
  });
}

app.post("/telegram/webhook/" + WEBHOOK_SECRET, async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body || {};
    if (update.message && typeof update.message.text === "string") {
      const pieces = update.message.text.trim().split(" ");
      if (pieces[0] === "/games" || pieces[0] === "/game") {
        await sendArcadeMenu(telegram, update.message.chat.id, update.message.from);
      }
      if (pieces[0] === "/start") {
        const chatId = update.message.chat.id;
        const startParam = pieces[1] || "";
        if (startParam.startsWith("game_")) {
          const matchId = startParam.slice(5);
          await require("./lib/arcade").joinFromStart({ telegram, chatId, user: update.message.from, matchId });
        } else if (startParam === "arcade" || startParam.startsWith("arcade_")) {
          await sendArcadeMenu(telegram, chatId, update.message.from);
        } else {
          const id = startParam.split("_")[0];
          if (id) {
            const offer = expireIfNeeded(offers.get(id));
            if (offer && offer.status === "active") await sendOfferToChat(chatId, offer);
            else await telegram("sendMessage", { chat_id: chatId, text: "Предложение не найдено или срок его действия истёк." });
          } else {
          const appUrl = String(process.env.RENDER_EXTERNAL_URL || "https://life-money-nft-offers.onrender.com").replace(/\\/$/, "");
          await telegram("sendMessage", {
            chat_id: chatId,
            text: "🌸 Добро пожаловать в LIFE MONEY!\\n\\nОткрой приложение: NFT-предложения, мини-игры и профиль — в одном красивом интерфейсе.\\n\\nИгровые очки демонстрационные, без реальных денег.",
            reply_markup: { inline_keyboard: [
              [{ text: "✦ ОТКРЫТЬ LIFE MONEY", web_app: { url: appUrl } }],
              [{ text: "🎮 Игры в чате", callback_data: "arcade:menu" }]
            ] }
          });
          }
        }
      }
    }
    if (update.callback_query) {
      const q = update.callback_query;
      if (await handleArcadeCallback({ telegram, query: q })) return;
      const parts = String(q.data || "").split(":");
      const decision = parts[0], id = parts[1];
      const offer = expireIfNeeded(offers.get(id));
      if (!offer || offer.status !== "active" || !["accept", "decline"].includes(decision)) {
        await telegram("answerCallbackQuery", { callback_query_id: q.id, text: "Предложение уже недоступно." });
      } else {
        offer.status = decision === "accept" ? "accepted" : "declined";
        offer.respondedAt = new Date().toISOString();
        await telegram("answerCallbackQuery", { callback_query_id: q.id, text: decision === "accept" ? "Предложение принято" : "Предложение отклонено" });
        const nl = String.fromCharCode(10);
        const recipient = String(offer.recipient || "@koszakL").replace(/^@/, "");
        const suffix = decision === "accept"
          ? nl + nl + "Вы приняли предложение. Это не автоматическая передача NFT. Чтобы отправить подарок, откройте профиль получателя и самостоятельно выберите отправку подарка в Telegram. Перед подтверждением проверьте аккаунт и подарок."
          : nl + nl + "Вы отклонили предложение.";
        const buttons = decision === "accept"
          ? [[{ text: "🎁 Открыть профиль получателя", url: "https://t.me/" + recipient }], [{ text: "Открыть NFT", url: offer.giftUrl }]]
          : [[{ text: "Открыть NFT", url: offer.giftUrl }]];
        await telegram("editMessageText", {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          text: q.message.text + suffix,
          reply_markup: { inline_keyboard: buttons }
        });
      }
    }
  } catch (error) {
    console.error("Telegram webhook error:", error.message);
  }
});

async function configureTelegramWebhook() {
  if (!BOT_TOKEN || !process.env.RENDER_EXTERNAL_URL) return;
  try {
    const base = process.env.RENDER_EXTERNAL_URL.endsWith("/") ? process.env.RENDER_EXTERNAL_URL.slice(0, -1) : process.env.RENDER_EXTERNAL_URL;
    const url = base + "/telegram/webhook/" + WEBHOOK_SECRET;
    await telegram("setWebhook", { url, secret_token: WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
    await telegram("setMyCommands", { commands: [
      { command: "start", description: "Открыть LIFE MONEY" },
      { command: "app", description: "Открыть приложение" },
      { command: "games", description: "Игры 🏀 🎰 🎲" }
    ] });
    try {
      await telegram("setChatMenuButton", {
        menu_button: { type: "web_app", text: "LIFE MONEY", web_app: { url: base } }
      });
      console.log("Telegram Mini App menu button configured");
    } catch (menuError) {
      console.warn("Mini App menu button not configured:", menuError.message);
    }
    console.log("Telegram webhook configured");
  } catch (error) {
    console.error("Telegram webhook setup failed:", error.message);
  }
}
app.use(express.static(path.join(__dirname, "public")));

function publicOffer(offer) {
  return {
    id: offer.id,
    giftName: offer.giftName,
    giftNumber: offer.giftNumber,
    giftUrl: offer.giftUrl,
    giftSlug: offer.giftSlug,
    price: offer.price,
    currency: offer.currency,
    createdAt: offer.createdAt,
    expiresAt: offer.expiresAt,
    recipient: offer.recipient,
    status: offer.status
  };
}

function expireIfNeeded(offer) {
  if (offer && offer.status === "active" && Date.now() >= Date.parse(offer.expiresAt)) {
    offer.status = "expired";
  }
  return offer;
}



const { createQrLogin, getQrStatus, submitTwoFactorPassword, cancelQrLogin } = require("./lib/mtproto-qr");

function requireSetupToken(req, res, next) {
  const expected = process.env.MTPROTO_SETUP_TOKEN || "";
  const supplied = req.get("x-setup-token") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Неверный ключ настройки. Проверь MTPROTO_SETUP_TOKEN в Render." });
  }
  next();
}

app.post("/api/mtproto/qr/start", requireSetupToken, async (_req, res) => {
  try { res.json(await createQrLogin()); }
  catch (error) { res.status(400).json({ error: error.message || "Не удалось создать QR-вход." }); }
});
app.get("/api/mtproto/qr/status", requireSetupToken, async (_req, res) => {
  try { res.json(await getQrStatus()); }
  catch (error) { res.status(503).json({ error: "Не удалось проверить статус сессии." }); }
});
app.post("/api/mtproto/qr/password", requireSetupToken, async (req, res) => {
  try { res.json(await submitTwoFactorPassword(String(req.body?.password || ""))); }
  catch (error) { res.status(400).json({ error: error.message || "Не удалось передать пароль Telegram." }); }
});
app.post("/api/mtproto/qr/cancel", requireSetupToken, async (_req, res) => {
  try { res.json(await cancelQrLogin()); }
  catch (error) { res.status(400).json({ error: "Не удалось отменить вход." }); }
});


const { inspectGift, sendGiftOffer } = require("./lib/gift-offers");

app.post("/api/mtproto/gift/inspect", requireSetupToken, async (req, res) => {
  try {
    const gift = await inspectGift(String(req.body?.link || ""), String(req.body?.ownerUsername || ""));
    res.json({ ok: true, gift: { slug: gift.slug, title: gift.title, number: gift.number, minStars: gift.minStars, currency: gift.currency, requirePremium: gift.requirePremium } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Не удалось проверить NFT." });
  }
});

app.post("/api/mtproto/gift/send-offer", requireSetupToken, async (req, res) => {
  try {
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Требуется явное подтверждение отправки." });
    const result = await sendGiftOffer({
      link: String(req.body?.link || ""),
      ownerUsername: String(req.body?.ownerUsername || ""),
      price: req.body?.price,
      currency: req.body?.currency,
      duration: req.body?.duration
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Telegram не принял предложение." });
  }
});
 
// Personal-account flow: seller receives a private message with a link to a transparent confirmation page.
const { sendPersonalMessage } = require("./lib/gift-offers");
const personalOffers = new Map();

app.post("/api/mtproto/personal-offer/create", requireSetupToken, async (req, res) => {
  try {
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Подтверди отправку личного сообщения." });
    const link = String(req.body?.link || "");
    const ownerUsername = String(req.body?.ownerUsername || "");
    const price = String(req.body?.price || "");
    const currency = String(req.body?.currency || "STARS");
    const displayValue = String(req.body?.displayValue || "");
    const duration = Number(req.body?.duration);
    if (!price || !["STARS", "TON"].includes(currency) || !Number.isFinite(Number(price)) || Number(price) <= 0) {
      return res.status(400).json({ error: "Проверь фактическую сумму предложения." });
    }
    if (!ownerUsername.trim()) return res.status(400).json({ error: "Укажи username владельца NFT." });
    if (displayValue && (!Number.isFinite(Number(displayValue)) || Number(displayValue) <= 0)) {
      return res.status(400).json({ error: "Проверь оценочную стоимость." });
    }
    const allowedDurations = [21600, 43200, 86400, 129600, 172800, 259200];
    if (!allowedDurations.includes(duration)) return res.status(400).json({ error: "Выбери допустимый срок предложения." });
    if (currency === "STARS" && (!Number.isSafeInteger(Number(price)) || Number(price) <= 0)) {
      return res.status(400).json({ error: "Сумма Stars должна быть целым положительным числом." });
    }
    if (currency === "TON" && (!/^\\d+(\\.\\d{1,9})?$/.test(price) || Number(price) <= 0)) {
      return res.status(400).json({ error: "Укажи положительную сумму TON максимум с 9 знаками после запятой." });
    }
    const inspected = await inspectGift(link, ownerUsername);
    if (currency === "STARS" && inspected.minStars != null && Number(price) < inspected.minStars) {
      return res.status(400).json({ error: "Сумма ниже минимальной цены Telegram: " + inspected.minStars + " Stars." });
    }
    const id = crypto.randomBytes(16).toString("hex");
    const base = String(process.env.RENDER_EXTERNAL_URL || "https://life-money-nft-offers.onrender.com").replace(/\/$/, "");
    const offer = {
      id, link, ownerUsername, giftTitle: inspected.title, giftNumber: inspected.number,
      price, currency, displayValue, duration, status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + duration * 1000).toISOString()
    };
    personalOffers.set(id, offer);
    const pageUrl = base + "/offer.html?id=" + id;
    const estimated = displayValue ? "Оценочная стоимость NFT: " + displayValue + " ⭐.\n" : "";
    const message = "🎁 LIFE MONEY — предложение по NFT\n\n" +
      "Подарок: " + inspected.title + " #" + inspected.number + "\n" +
      estimated +
      "Посмотри условия и подтверди решение по защищённой странице LIFE MONEY:\n" + pageUrl + "\n\n" +
      "Перед подтверждением на странице будут показаны точные условия фактического предложения Telegram.";
    const delivery = await sendPersonalMessage({ link, ownerUsername, message });
    res.status(201).json({ ok: true, id, pageUrl, owner: delivery.owner, messageId: delivery.messageId });
  } catch (error) {
    res.status(400).json({ error: error.message || "Не удалось отправить личное сообщение." });
  }
});

app.get("/api/mtproto/personal-offer/:id", (req, res) => {
  const offer = personalOffers.get(req.params.id);
  if (!offer) return res.status(404).json({ error: "Предложение не найдено." });
  if (offer.status === "pending" && Date.now() >= Date.parse(offer.expiresAt)) offer.status = "expired";
  res.json({
    giftTitle: offer.giftTitle, giftNumber: offer.giftNumber, giftUrl: offer.link,
    price: offer.price, currency: offer.currency, displayValue: offer.displayValue || null,
    status: offer.status, expiresAt: offer.expiresAt
  });
});

app.post("/api/mtproto/personal-offer/:id/decision", async (req, res) => {
  const offer = personalOffers.get(req.params.id);
  if (!offer) return res.status(404).json({ error: "Предложение не найдено." });
  if (offer.status === "pending" && Date.now() >= Date.parse(offer.expiresAt)) offer.status = "expired";
  if (offer.status !== "pending") return res.status(409).json({ error: "Предложение уже закрыто или срок истёк." });
  const decision = req.body?.decision;
  if (decision === "decline") {
    offer.status = "declined";
    return res.json({ ok: true, status: offer.status });
  }
  if (decision !== "accept") return res.status(400).json({ error: "Неизвестное действие." });
  try {
    const result = await sendGiftOffer({
      link: offer.link, ownerUsername: offer.ownerUsername,
      price: offer.price, currency: offer.currency, duration: offer.duration
    });
    offer.status = "sent";
    offer.respondedAt = new Date().toISOString();
    res.json({ ok: true, status: offer.status, result });
  } catch (error) {
    res.status(400).json({ error: error.message || "Telegram не принял предложение." });
  }
});


app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "LIFE MONEY NFT Offers", version: "1.2.0", news: getNewsPublisherStatus() });
});

app.get("/news/status", (_req, res) => {
  res.json(getNewsPublisherStatus());
});

app.get("/health/session-store", async (_req, res) => {
  try {
    const status = await checkSessionStore();
    res.json({ ok: true, service: "cloudflare-d1", ...status });
  } catch (error) {
    res.status(503).json({ ok: false, service: "cloudflare-d1", error: error.message });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({
    recipient: process.env.OFFER_RECIPIENT || "@koszakL",
    botUsername: BOT_USERNAME,
    botEnabled: Boolean(BOT_TOKEN),
    mode: "demo"
  });
});

app.post("/api/offers", (req, res) => {
  const { giftName, giftNumber, giftUrl, price, currency, expiresInMinutes } = req.body || {};
  const numericPrice = Number(price);
  let parsedGiftUrl;
  try {
    parsedGiftUrl = new URL(String(giftUrl || ""));
  } catch (_) {
    return res.status(400).json({ error: "Вставь действительную ссылку Telegram на NFT: https://t.me/nft/Название-номер" });
  }
  if (!["t.me", "telegram.me"].includes(parsedGiftUrl.hostname.toLowerCase()) ||
      !/^\/nft\/[A-Za-z0-9_]+-[0-9]+\/?$/.test(parsedGiftUrl.pathname) ||
      parsedGiftUrl.search || parsedGiftUrl.hash) {
    return res.status(400).json({ error: "Подходит только ссылка на коллекционный подарок вида https://t.me/nft/Название-номер" });
  }
  const giftSlug = parsedGiftUrl.pathname.split("/")[2];
  const splitAt = giftSlug.lastIndexOf("-");
  const parsedName = giftSlug.slice(0, splitAt);
  const parsedNumber = giftSlug.slice(splitAt + 1);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0 ||
      !["TON", "GRAM", "⭐"].includes(currency)) {
    return res.status(400).json({ error: "Укажи положительную информационную цену и валюту TON, GRAM или ⭐." });
  }

  const id = crypto.randomBytes(8).toString("hex");
  const createdAt = new Date();
  const minutes = Math.min(Math.max(Number(expiresInMinutes) || 60, 1), 10080);
  const offer = {
    id,
    giftName: String(giftName || parsedName).trim().slice(0, 80),
    giftNumber: String(giftNumber || ("#" + parsedNumber)).trim().slice(0, 30),
    giftUrl: parsedGiftUrl.origin + parsedGiftUrl.pathname, 
    giftSlug,
    price: String(price).slice(0, 20),
    currency,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + minutes * 60000).toISOString(),
    recipient: process.env.OFFER_RECIPIENT || "@koszakL",
    status: "active"
  };
  offers.set(id, offer);
  res.status(201).json({ ...publicOffer(offer), botLink: "https://t.me/" + BOT_USERNAME + "?start=" + id });
});

app.get("/api/offers/:id", (req, res) => {
  const offer = expireIfNeeded(offers.get(req.params.id));
  if (!offer) return res.status(404).json({ error: "Предложение не найдено. Возможно, ссылка неверная или сервер был перезапущен." });
  res.json(publicOffer(offer));
});

app.post("/api/offers/:id/decision", (req, res) => {
  const offer = expireIfNeeded(offers.get(req.params.id));
  if (!offer) return res.status(404).json({ error: "Предложение не найдено." });
  if (offer.status === "expired") return res.status(410).json({ error: "Срок действия предложения истёк." });
  if (offer.status !== "active") return res.status(409).json({ error: "По этому предложению уже выбран ответ." });

  const decision = req.body && req.body.decision;
  if (!["accepted", "declined"].includes(decision)) {
    return res.status(400).json({ error: "Неизвестный ответ." });
  }
  offer.status = decision;
  offer.respondedAt = new Date().toISOString();
  res.json(publicOffer(offer));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`LIFE MONEY NFT Offers listening on ${PORT}`);
  configureTelegramWebhook();
  startNewsPublisher({ telegram, channel: process.env.NEWS_CHANNEL || "@koszakNEW" });
});
