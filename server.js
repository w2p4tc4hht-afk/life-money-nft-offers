const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "LIFE MONEY NFT Offers", version: "1.0.0" });
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
  if (!giftName || !price || !["TON", "GRAM", "⭐"].includes(currency)) {
    return res.status(400).json({ error: "Укажи подарок, цену и валюту TON, GRAM или ⭐." });
  }
  const id = require("crypto").randomBytes(6).toString("hex");
  const createdAt = new Date();
  const minutes = Math.min(Math.max(Number(expiresInMinutes) || 60, 1), 10080);
  res.status(201).json({
    id,
    giftName: String(giftName).slice(0, 80),
    giftNumber: String(giftNumber || "").slice(0, 30),
    price: String(price).slice(0, 20),
    currency,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + minutes * 60000).toISOString(),
    recipient: process.env.OFFER_RECIPIENT || "@koszakL",
    status: "demo"
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`LIFE MONEY NFT Offers listening on ${PORT}`));
