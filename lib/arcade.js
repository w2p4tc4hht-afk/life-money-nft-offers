const crypto = require("crypto");

// Demo arcade: virtual, non-purchasable, non-transferable points only.
// No Telegram Stars, deposits, withdrawals, or cash-equivalent balances.
const ENTRY_POINTS = 50;
const WINNER_POINTS = 80;
const matches = new Map();
const balances = new Map();
const names = new Map();

const MODES = {
  basketball: { title: "🏀 Баскетбол", emoji: "🏀" },
  slots: { title: "🎰 Слоты", emoji: "🎰" },
  dice: { title: "🎲 Кости", emoji: "🎲" }
};

function playerName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || (user.username ? "@" + user.username : "Игрок");
}

function ensurePlayer(user) {
  const id = String(user.id);
  if (!balances.has(id)) balances.set(id, 100);
  names.set(id, playerName(user));
  return balances.get(id);
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🏀 Баскетбол", callback_data: "arcade:create:basketball" }],
      [{ text: "🎰 Слоты", callback_data: "arcade:create:slots" }],
      [{ text: "🎲 Кости", callback_data: "arcade:create:dice" }],
      [{ text: "💰 Мой игровой баланс", callback_data: "arcade:balance" }]
    ]
  };
}

async function sendMenu(telegram, chatId, user) {
  const balance = ensurePlayer(user);
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "🎮 LIFE MONEY — АРКАДА\n\nВыбери игру и создай матч с другим участником.\n\nТестовый баланс: " + balance + " игровых очков.\nВход в матч: " + ENTRY_POINTS + " очков с каждого. Победителю начисляется 80 очков.\n\n⚠️ Это только демонстрационные очки: их нельзя купить, передать или вывести. Telegram Stars не используются.",
    reply_markup: mainMenu()
  });
}

async function handleCallback({ telegram, query }) {
  const data = String(query.data || "");
  const user = query.from;
  const chatId = query.message?.chat?.id;
  if (!data.startsWith("arcade:")) return false;
  ensurePlayer(user);

  if (data === "arcade:balance") {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Баланс: " + balances.get(String(user.id)) + " игровых очков" });
    return true;
  }

  const [, action, value] = data.split(":");
  if (action === "create") {
    const mode = MODES[value];
    if (!mode) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Неизвестная игра." });
      return true;
    }
    const playerId = String(user.id);
    if (balances.get(playerId) < ENTRY_POINTS) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Недостаточно тестовых очков." });
      return true;
    }
    balances.set(playerId, balances.get(playerId) - ENTRY_POINTS);
    const id = crypto.randomBytes(5).toString("hex");
    matches.set(id, {
      id, mode: value, chatId, creatorId: playerId, creatorName: playerName(user),
      status: "waiting", createdAt: Date.now()
    });
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Матч создан. Ждём соперника." });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: mode.title + " — открыт матч!\n\nИгрок: " + playerName(user) + "\nВход: " + ENTRY_POINTS + " игровых очков.\nПриз победителю: " + WINNER_POINTS + " игровых очков.\n\nНужен второй игрок. Очки виртуальные, без вывода.",
      reply_markup: { inline_keyboard: [[{ text: "⚔️ Присоединиться", callback_data: "arcade:join:" + id }]] }
    });
    return true;
  }

  if (action === "join") {
    const match = matches.get(value);
    const playerId = String(user.id);
    if (!match || match.status !== "waiting" || match.creatorId === playerId) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Матч уже закрыт или нельзя играть самому с собой." });
      return true;
    }
    if (balances.get(playerId) < ENTRY_POINTS) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Недостаточно тестовых очков." });
      return true;
    }
    match.status = "playing";
    match.opponentId = playerId;
    match.opponentName = playerName(user);
    balances.set(playerId, balances.get(playerId) - ENTRY_POINTS);
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Ты присоединился к матчу!" });
    await telegram("sendMessage", {
      chat_id: match.chatId,
      text: "⚔️ Матч начинается!\n" + match.creatorName + " против " + match.opponentName + "\n\nБроски выполняются Telegram. Победитель получит 80 виртуальных очков."
    });
    try {
      const first = await telegram("sendDice", { chat_id: match.chatId, emoji: MODES[match.mode].emoji });
      const second = await telegram("sendDice", { chat_id: match.chatId, emoji: MODES[match.mode].emoji });
      const a = Number(first.dice?.value || 0);
      const b = Number(second.dice?.value || 0);
      match.status = "finished";
      match.result = { first: a, second: b };
      if (a === b) {
        balances.set(match.creatorId, balances.get(match.creatorId) + ENTRY_POINTS);
        balances.set(match.opponentId, balances.get(match.opponentId) + ENTRY_POINTS);
        await telegram("sendMessage", { chat_id: match.chatId, text: "🤝 Ничья! Оба игрока получили обратно по " + ENTRY_POINTS + " виртуальных очков." });
      } else {
        const winnerId = a > b ? match.creatorId : match.opponentId;
        balances.set(winnerId, balances.get(winnerId) + WINNER_POINTS);
        const winnerName = a > b ? match.creatorName : match.opponentName;
        await telegram("sendMessage", {
          chat_id: match.chatId,
          text: "🏆 Победитель: " + winnerName + "!\nРезультат: " + a + " : " + b + "\nНачислено: " + WINNER_POINTS + " виртуальных очков.\n\nЭто демонстрационные очки, не Stars и не деньги."
        });
      }
    } catch (error) {
      match.status = "error";
      balances.set(match.creatorId, balances.get(match.creatorId) + ENTRY_POINTS);
      balances.set(match.opponentId, balances.get(match.opponentId) + ENTRY_POINTS);
      await telegram("sendMessage", { chat_id: match.chatId, text: "Не удалось завершить матч. Тестовые очки возвращены обоим игрокам." });
      console.error("Arcade match error:", error.message);
    }
    return true;
  }
  return true;
}

module.exports = { sendMenu, handleCallback };
