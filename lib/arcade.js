const crypto = require("crypto");

// Online Telegram lobby. Points are demo-only and remain in process memory.
const ENTRY_POINTS = 50;
const WINNER_POINTS = 80;
const MATCH_TTL_MS = 10 * 60 * 1000;
const matches = new Map();
const balances = new Map();

const MODES = {
  basketball: { title: "🏀 Баскетбол", emoji: "🏀" },
  slots: { title: "🎰 Слоты", emoji: "🎰" },
  dice: { title: "🎲 Кости", emoji: "🎲" }
};

function playerName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") ||
    (user.username ? "@" + user.username : "Игрок");
}

function ensurePlayer(user) {
  const id = String(user.id);
  if (!balances.has(id)) balances.set(id, 100);
  return balances.get(id);
}

function botUsername() {
  return (process.env.BOT_USERNAME || "koszak_bot_ai").replace(/^@/, "");
}

function inviteUrl(id) {
  return "https://t.me/" + botUsername() + "?start=game_" + id;
}

async function safeSend(telegram, chatId, text) {
  try {
    await telegram("sendMessage", { chat_id: chatId, text });
  } catch (error) {
    console.warn("Arcade private notification skipped:", error.message);
  }
}

function refundWaitingMatch(match) {
  if (!match || match.status !== "waiting") return;
  match.status = "expired";
  balances.set(match.creatorId, (balances.get(match.creatorId) || 0) + ENTRY_POINTS);
}

function expireMatches() {
  const now = Date.now();
  for (const match of matches.values()) {
    if (match.status === "waiting" && now - match.createdAt > MATCH_TTL_MS) {
      refundWaitingMatch(match);
    }
  }
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
  expireMatches();
  const balance = ensurePlayer(user);
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "🎮 LIFE MONEY — ОНЛАЙН-АРКАДА\n\nВыбери игру, создай комнату и отправь ссылку другу. Соперник сможет подключиться из Telegram с другого телефона или чата.\n\nТестовый баланс: " + balance + " игровых очков.\nВход: " + ENTRY_POINTS + " очков с каждого. Приз: " + WINNER_POINTS + " очков.\n\n⚠️ Это демонстрационные очки: их нельзя купить, передать или вывести. Stars и реальные деньги не используются.",
    reply_markup: mainMenu()
  });
}

async function finishMatch({ telegram, match, opponent }) {
  match.status = "playing";
  match.opponentId = String(opponent.id);
  match.opponentName = playerName(opponent);
  balances.set(match.opponentId, (balances.get(match.opponentId) || 0) - ENTRY_POINTS);

  await telegram("sendMessage", {
    chat_id: match.chatId,
    text: "⚔️ ОНЛАЙН-МАТЧ НАЧИНАЕТСЯ!\n\n" + match.creatorName + " против " + match.opponentName +
      "\nИгра: " + MODES[match.mode].title + "\n\nБроски выполняются Telegram. Оба игрока подключены к одной комнате."
  });

  try {
    const first = await telegram("sendDice", { chat_id: match.chatId, emoji: MODES[match.mode].emoji });
    const second = await telegram("sendDice", { chat_id: match.chatId, emoji: MODES[match.mode].emoji });
    const a = Number(first.dice?.value || 0);
    const b = Number(second.dice?.value || 0);
    match.status = "finished";
    match.result = { first: a, second: b };

    let resultText;
    if (a === b) {
      balances.set(match.creatorId, (balances.get(match.creatorId) || 0) + ENTRY_POINTS);
      balances.set(match.opponentId, (balances.get(match.opponentId) || 0) + ENTRY_POINTS);
      resultText = "🤝 Ничья! Оба игрока получили обратно по " + ENTRY_POINTS + " виртуальных очков.";
    } else {
      const winnerId = a > b ? match.creatorId : match.opponentId;
      const winnerName = a > b ? match.creatorName : match.opponentName;
      balances.set(winnerId, (balances.get(winnerId) || 0) + WINNER_POINTS);
      resultText = "🏆 Победитель: " + winnerName + "!\nРезультат: " + a + " : " + b +
        "\nНачислено: " + WINNER_POINTS + " виртуальных очков.";
    }

    const finalText = resultText + "\n\nЭто демонстрационные очки, не Stars и не деньги.";
    await telegram("sendMessage", { chat_id: match.chatId, text: finalText });
    await safeSend(telegram, match.creatorId, "🎮 Результат твоего матча:\n" + finalText +
      "\nТвой баланс: " + balances.get(match.creatorId));
    await safeSend(telegram, match.opponentId, "🎮 Результат твоего матча:\n" + finalText +
      "\nТвой баланс: " + balances.get(match.opponentId));
  } catch (error) {
    match.status = "error";
    balances.set(match.creatorId, (balances.get(match.creatorId) || 0) + ENTRY_POINTS);
    balances.set(match.opponentId, (balances.get(match.opponentId) || 0) + ENTRY_POINTS);
    await telegram("sendMessage", {
      chat_id: match.chatId,
      text: "Не удалось завершить матч. Тестовые очки возвращены обоим игрокам."
    });
    await safeSend(telegram, match.opponentId, "Матч не завершился. Твои тестовые очки возвращены.");
    console.error("Arcade match error:", error.message);
  }
}

async function joinMatch({ telegram, matchId, user, callbackQueryId }) {
  expireMatches();
  const match = matches.get(matchId);
  const playerId = String(user.id);

  if (!match || match.status !== "waiting") {
    if (callbackQueryId) await telegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Комната уже закрыта или ссылка устарела." });
    else await telegram("sendMessage", { chat_id: playerId, text: "Эта игровая комната уже закрыта или ссылка устарела. Создай новую через /games." });
    return;
  }
  if (match.creatorId === playerId) {
    if (callbackQueryId) await telegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Нельзя подключиться к собственной комнате." });
    else await telegram("sendMessage", { chat_id: playerId, text: "Это твоя комната. Отправь ссылку другому игроку." });
    return;
  }
  ensurePlayer(user);
  if (balances.get(playerId) < ENTRY_POINTS) {
    if (callbackQueryId) await telegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Недостаточно тестовых очков." });
    else await telegram("sendMessage", { chat_id: playerId, text: "Недостаточно тестовых очков для входа. Нужно " + ENTRY_POINTS + "." });
    return;
  }

  // Synchronous status change prevents two callbacks from claiming the same room.
  match.status = "claiming";
  if (callbackQueryId) await telegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Подключение к онлайн-матчу..." });
  await finishMatch({ telegram, match, opponent: user });
}

async function joinFromStart({ telegram, chatId, user, matchId }) {
  await joinMatch({ telegram, matchId, user });
}

async function handleCallback({ telegram, query }) {
  const data = String(query.data || "");
  if (!data.startsWith("arcade:")) return false;

  const user = query.from;
  const chatId = query.message?.chat?.id;
  ensurePlayer(user);
  expireMatches();

  if (data === "arcade:menu") {
    await telegram("answerCallbackQuery", { callback_query_id: query.id });
    await sendMenu(telegram, chatId, user);
    return true;
  }
  if (data === "arcade:balance") {
    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Баланс: " + balances.get(String(user.id)) + " игровых очков"
    });
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
      id, mode: value, chatId, creatorId: playerId,
      creatorName: playerName(user), status: "waiting", createdAt: Date.now()
    });

    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Комната создана. Пригласи соперника!" });
    await telegram("sendMessage", {
      chat_id: chatId,
      text: mode.title + " — ОНЛАЙН-КОМНАТА ОТКРЫТА!\n\nСоздатель: " + playerName(user) +
        "\nВход: " + ENTRY_POINTS + " игровых очков.\nПриз победителю: " + WINNER_POINTS +
        " очков.\n\nОтправь другу ссылку ниже. Он подключится к этой комнате через бота, даже если находится в другом чате.\n\n" +
        inviteUrl(id) + "\n\nКомната действует 10 минут. Очки виртуальные, без вывода.",
      reply_markup: { inline_keyboard: [[{ text: "⚔️ Присоединиться к матчу", url: inviteUrl(id) }]] }
    });
    return true;
  }

  if (action === "join") {
    await joinMatch({ telegram, matchId: value, user, callbackQueryId: query.id });
    return true;
  }
  return true;
}

module.exports = { sendMenu, handleCallback, joinFromStart };