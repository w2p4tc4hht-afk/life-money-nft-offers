const { saveTelegramSession, loadTelegramSession } = require("./session-store");
const QRCode = require("qrcode");

let flow = null;
let clientInstance = null;
let connectedUser = null;

function userSummary(user) {
  return { id: String(user.id), firstName: user.firstName || "", username: user.username || "" };
}

async function createQrLogin() {
  if (flow && flow.state !== "error" && flow.state !== "connected") {
    throw new Error("QR-вход уже запущен. Подожди или перезапусти сервис.");
  }
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!apiId || !apiHash) throw new Error("На Render не заданы TG_API_ID и TG_API_HASH.");
  const { TelegramClient } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  const controller = new AbortController();
  flow = { state: "waiting_qr", qrDataUrl: null, expiresAt: null, message: "Создаём QR-код…", controller, client, passwordResolver: null };
  clientInstance = client;

  flow.promise = client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      abortSignal: controller.signal,
      qrCode: async (code) => {
        const link = "tg://login?token=" + code.token.toString("base64url");
        flow.qrDataUrl = await QRCode.toDataURL(link, { width: 280, margin: 2 });
        flow.expiresAt = Number(code.expires) * 1000;
        flow.state = "waiting_qr";
        flow.message = "Открой Telegram на телефоне → Настройки → Устройства → Подключить устройство и отсканируй QR-код.";
      },
      password: async (hint) => {
        flow.state = "waiting_password";
        flow.message = hint ? "Telegram запросил пароль 2FA. Подсказка: " + hint : "Telegram запросил пароль 2FA.";
        return new Promise((resolve, reject) => { flow.passwordResolver = { resolve, reject }; });
      },
      onError: async (error) => {
        if (flow) flow.message = "Telegram: " + String(error.message || error).slice(0, 180);
        return false;
      }
    }
  ).then(async (user) => {
    await saveTelegramSession(client.session.save());
    connectedUser = userSummary(user);
    flow.state = "connected";
    flow.qrDataUrl = null;
    flow.message = "Telegram успешно подключён. Сессия сохранена в зашифрованном виде.";
  }).catch((error) => {
    if (flow) {
      flow.state = "error";
      flow.qrDataUrl = null;
      flow.message = "Вход не завершён: " + String(error.message || error).slice(0, 180);
    }
  });
  return getQrStatus();
}

async function getQrStatus() {
  if (!flow) {
    const saved = await loadTelegramSession();
    if (!saved) return { state: "not_connected", message: "Аккаунт ещё не подключён." };
    return { state: "session_saved", message: "Зашифрованная сессия найдена. Для проверки авторизации потребуется восстановить MTProto-соединение." };
  }
  return { state: flow.state, qrDataUrl: flow.qrDataUrl, expiresAt: flow.expiresAt, message: flow.message };
}

async function submitTwoFactorPassword(password) {
  if (!flow || flow.state !== "waiting_password" || !flow.passwordResolver) {
    throw new Error("Telegram сейчас не ожидает пароль 2FA.");
  }
  if (typeof password !== "string" || !password || password.length > 256) {
    throw new Error("Проверь пароль 2FA.");
  }
  const resolver = flow.passwordResolver;
  flow.passwordResolver = null;
  flow.state = "checking_password";
  resolver.resolve(password);
  return { state: "checking_password", message: "Проверяем пароль в Telegram…" };
}

async function cancelQrLogin() {
  if (flow && flow.controller) {
    flow.controller.abort();
    try { await flow.client.disconnect(); } catch (_) {}
    flow.state = "cancelled";
    flow.qrDataUrl = null;
    flow.message = "Попытка входа отменена.";
  }
  return getQrStatus();
}

module.exports = { createQrLogin, getQrStatus, submitTwoFactorPassword, cancelQrLogin };
