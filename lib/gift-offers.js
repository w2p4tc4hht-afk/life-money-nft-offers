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

async function inspectGift(link) {
  const slug = parseSlug(link);
  const { client } = await getClient();
  const { Api } = await import("teleproto");
  const result = await client.invoke(new Api.payments.GetUniqueStarGift({ slug }));
  const gift = result.gift;
  if (!gift) throw new Error("Telegram не вернул данные коллекционного подарка.");
  if (gift.burned) throw new Error("Этот подарок уже сожжён или использован.");
  // Telegram only includes owner_id when offer_min_stars is present.
  if (!gift.offerMinStars || !gift.ownerId) {
    throw new Error("Telegram не разрешает предложения для этого подарка: в ответе API отсутствуют owner_id/offer_min_stars. Проверь другой NFT.");
  }
  const peer = gift.ownerId;
  let inputPeer;
  if (peer.className === "PeerUser" || peer.userId !== undefined) {
    const user = (result.users || []).find(item => String(item.id) === String(peer.userId));
    if (!user || !user.accessHash) throw new Error("Telegram не предоставил данные доступа владельца подарка.");
    inputPeer = new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
  } else if (peer.className === "PeerChannel" || peer.channelId !== undefined) {
    const channel = (result.chats || []).find(item => String(item.id) === String(peer.channelId));
    if (!channel || !channel.accessHash) throw new Error("Telegram не предоставил данные доступа канала-владельца.");
    inputPeer = new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash });
  } else {
    throw new Error("Неподдерживаемый тип владельца NFT.");
  }
  return {
    slug: gift.slug,
    title: gift.title,
    number: gift.num,
    minStars: Number(gift.offerMinStars),
    ownerPeer: inputPeer,
    ownerName: gift.ownerName || null,
    requirePremium: Boolean(gift.requirePremium)
  };
}

async function sendGiftOffer({ link, priceStars, duration }) {
  const price = Number(priceStars);
  const allowedDurations = [21600, 43200, 86400, 129600, 172800, 259200];
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("Цена должна быть целым числом Stars.");
  if (!allowedDurations.includes(Number(duration))) throw new Error("Недопустимый срок предложения.");
  const gift = await inspectGift(link);
  if (price < gift.minStars) throw new Error("Цена ниже минимальной цены Telegram: " + gift.minStars + " Stars.");
  const { client } = await getClient();
  const { Api } = await import("teleproto");
  const randomId = BigInt("0x" + crypto.randomBytes(8).toString("hex"));
  const result = await client.invoke(new Api.payments.SendStarGiftOffer({
    peer: gift.ownerPeer,
    slug: gift.slug,
    price: new Api.StarsAmount({ amount: BigInt(price), nanos: 0 }),
    duration: Number(duration),
    randomId
  }));
  return { sent: true, title: gift.title, number: gift.number, priceStars: price, duration: Number(duration), resultType: result?.className || "Updates" };
}

module.exports = { inspectGift, sendGiftOffer };
