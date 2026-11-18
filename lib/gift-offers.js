const crypto = require("node:crypto");
const { loadTelegramSession } = require("./session-store");

let clientPromise = null;

async function getClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const session = await loadTelegramSession();
    if (!session) throw new Error("Сначала подключи Telegram через QR.");
    const apiId = Number(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    if (!apiId || !apiHash) throw new Error("Не настроены TG_API_ID/TG_API_HASH.");
    const [{ TelegramClient }, { StringSession }] = await Promise.all([
      import("teleproto"),
      import("teleproto/sessions")
    ]);
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 4 });
    await client.connect();
    const me = await client.getMe();
    if (!me) throw new Error("Не удалось подтвердить Telegram-сессию.");
    return { client, me };
  })().catch(error => { clientPromise = null; throw error; });
  return clientPromise;
}

function parseSlug(input) {
  let url;
  try { url = new URL(String(input || "")); } catch (_) { throw new Error("Нужна ссылка вида https://t.me/nft/Slug"); }
  if (!["t.me", "telegram.me"].includes(url.hostname.toLowerCase())) throw new Error("Разрешены только ссылки t.me.");
  const match = url.pathname.match(/^\/nft\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) throw new Error("Ссылка должна иметь формат https://t.me/nft/SLUG.");
  return match[1];
}

async function inspectGift(link, ownerUsername = "") {
  const slug = parseSlug(link);
  const { client } = await getClient();
  const { Api } = await import("teleproto");
  const result = await client.invoke(new Api.payments.GetUniqueStarGift({ slug }));
  const gift = result.gift;
  if (!gift) throw new Error("Telegram не вернул данные коллекционного подарка.");
  if (gift.burned) throw new Error("Этот подарок уже сожжён или использован.");

  let inputPeer = null;
  let resolvedOwner = null;
  const peer = gift.ownerId;
  if (peer) {
    if (peer.className === "PeerUser" || peer.userId !== undefined) {
      const user = (result.users || []).find(item => String(item.id) === String(peer.userId));
      if (user && user.accessHash) inputPeer = new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
    } else if (peer.className === "PeerChannel" || peer.channelId !== undefined) {
      const channel = (result.chats || []).find(item => String(item.id) === String(peer.channelId));
      if (channel && channel.accessHash) inputPeer = new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash });
    }
  }

  // Telegram's UI may expose the offer flow while GetUniqueStarGift omits owner_id.
  // In that case resolve the public username supplied by the user and verify it against ownerName.
  if (!inputPeer && ownerUsername) {
    const username = String(ownerUsername).trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error("Проверь username владельца Telegram.");
    const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
    const user = (resolved.users || []).find(item => resolved.peer?.userId != null && String(item.id) === String(resolved.peer.userId));
    if (!user || !user.accessHash) throw new Error("Не удалось получить доступ к Telegram-профилю владельца @" + username + ".");
    const expected = String(gift.ownerName || "").trim().toLowerCase();
    const actual = [user.firstName, user.lastName].filter(Boolean).join(" ").trim().toLowerCase();
    if (expected && actual && !actual.includes(expected) && !expected.includes(actual)) {
      throw new Error("Username @" + username + " не совпадает с именем владельца NFT (" + gift.ownerName + "). Не отправляю предложение не тому человеку.");
    }
    inputPeer = new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
    resolvedOwner = "@" + username;
  }

  if (!inputPeer) {
    const details = [
      "ownerId: " + (gift.ownerId == null ? "MISSING" : "present"),
      "offerMinStars: " + (gift.offerMinStars == null ? "MISSING" : String(gift.offerMinStars)),
      "ownerName: " + (gift.ownerName || "missing"),
      "ownerUsername: " + (ownerUsername || "not supplied")
    ].join("\\n");
    throw new Error("Не удалось определить адрес владельца NFT.\\n" + details);
  }

  return {
    slug: gift.slug,
    title: gift.title,
    number: gift.num,
    minStars: gift.offerMinStars == null ? null : Number(gift.offerMinStars),
    currency: gift.resaleTonOnly ? "TON" : "STARS",
    ownerPeer: inputPeer,
    ownerName: gift.ownerName || null,
    ownerUsername: resolvedOwner,
    requirePremium: Boolean(gift.requirePremium)
  };
}

async function sendGiftOffer({ link, ownerUsername = "", price, currency = "STARS", duration }) {
  const numericPrice = Number(price);
  const allowedDurations = [21600, 43200, 86400, 129600, 172800, 259200];
  if (!["STARS", "TON"].includes(currency)) throw new Error("Неизвестная валюта предложения.");
  if (currency === "STARS" && (!Number.isSafeInteger(numericPrice) || numericPrice <= 0)) throw new Error("Цена должна быть целым числом Stars.");
  if (currency === "TON" && (!Number.isFinite(numericPrice) || numericPrice <= 0 || !/^\\d+(\\.\\d{1,9})?$/.test(String(price)))) throw new Error("Укажи сумму TON максимум с 9 знаками после запятой.");
  if (!allowedDurations.includes(Number(duration))) throw new Error("Недопустимый срок предложения.");
  const gift = await inspectGift(link, ownerUsername);
  if (currency === "STARS" && numericPrice < gift.minStars) throw new Error("Цена ниже минимальной цены Telegram: " + gift.minStars + " Stars.");
  const { client } = await getClient();
  const { Api } = await import("teleproto");
  const randomId = BigInt("0x" + crypto.randomBytes(8).toString("hex"));
  const result = await client.invoke(new Api.payments.SendStarGiftOffer({
    peer: gift.ownerPeer,
    slug: gift.slug,
    price: currency === "TON"
      ? new Api.StarsTonAmount({ amount: BigInt(Math.round(numericPrice * 1000000000)) })
      : new Api.StarsAmount({ amount: BigInt(numericPrice), nanos: 0 }),
    duration: Number(duration),
    randomId
  }));
  return { sent: true, title: gift.title, number: gift.number, price: String(price), currency, duration: Number(duration), resultType: result?.className || "Updates" };
}

module.exports = { inspectGift, sendGiftOffer };
