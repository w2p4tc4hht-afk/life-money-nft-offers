const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const offers = new Map();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function publicOffer(offer) {
  return {
    id: offer.id,
    giftName: offer.giftName,
    giftNumber: offer.giftNumber,
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "LIFE MONEY NFT Offers", version: "1.1.0" });
});

app.get("/api/config", (_req, res) => {
  res.json({
    recipient: process.env.OFFER_RECIPIENT || "@koszakL",
    botUsername: process.env.BOT_USERNAME || "koszak_bot_ai",
    mode: "demo"
  });
});

app.post("/api/offers", (req, res) => {
  const { giftName, giftNumber, price, currency, expiresInMinutes } = req.body || {};
  const numericPrice = Number(price);
  if (!String(giftName || "").trim() || !Number.isFinite(numericPrice) || numericPrice <= 0 ||
      !["TON", "GRAM", "⭐"].includes(currency)) {
    return res.status(400).json({ error: "Укажи название подарка, положительную цену и валюту TON, GRAM или ⭐." });
  }

  const id = crypto.randomBytes(8).toString("hex");
  const createdAt = new Date();
  const minutes = Math.min(Math.max(Number(expiresInMinutes) || 60, 1), 10080);
  const offer = {
    id,
    giftName: String(giftName).trim().slice(0, 80),
    giftNumber: String(giftNumber || "").trim().slice(0, 30),
    price: String(price).slice(0, 20),
    currency,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + minutes * 60000).toISOString(),
    recipient: process.env.OFFER_RECIPIENT || "@koszakL",
    status: "active"
  };
  offers.set(id, offer);
  res.status(201).json(publicOffer(offer));
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

app.listen(PORT, () => console.log(`LIFE MONEY NFT Offers listening on ${PORT}`));
