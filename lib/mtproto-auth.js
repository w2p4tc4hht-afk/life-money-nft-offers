const { saveTelegramSession, loadTelegramSession } = require("./session-store");

let flow = null;
let restoredClient = null;
let restoredUser = null;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function loadLibrary() {
  const [{ TelegramClient }, sessions] = await Promise.all([
    import("teleproto"),
    import("teleproto/sessions")
  ]);
  return { TelegramClient, StringSession: sessions.StringSession };
}

async function getLoginStatus() {
  if (flow) return { state: flow.state, message: flow.message || "" };
  if (restoredUser) return { state: "connected", user: restoredUser };
  const saved = await loadTelegramSession();
  if (!saved) return { state: "not_connected" };
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!apiId || !apiHash) throw new Error("TG_API_ID/TG_API_HASH are not configured");
  const { TelegramClient, StringSession } = await loadLibrary();
  const client = new TelegramClient(new StringSession(saved), apiId, apiHash, { connectionRetries: 3 });
  await client.connect();
  const me = await client.getMe();
  restoredClient = client;
  restoredUser = { id: String(me.id), firstName: me.firstName || "", username: me.username || "" };
  return { state: "connected", user: restoredUser };
}

async function createLoginFlow(phone) {
  if (flow && ["waiting_code", "waiting_password", "starting"].includes(flow.state)) {
    throw new Error("Вход уже начат. Заверши текущий шаг или перезапусти сервис.");
  }
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!apiId || !apiHash) throw new Error("На сервере не настроены TG_API_ID и TG_API_HASH.");
  const { TelegramClient, StringSession } = await loadLibrary();
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  const codeInput = deferred();
  const passwordInput = deferred();
  flow = { state: "starting", phone, codeInput, passwordInput, client, message: "Подключаемся к Telegram…" };

  const startPromise = client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => {
      flow.state = "waiting_code";
      flow.message = "Код отправлен Telegram. Введи его на этой защищённой странице.";
      return codeInput.promise;
    },
    password: async () => {
      flow.state = "waiting_password";
      flow.message = "Telegram запросил пароль двухэтапной аутентификации.";
      return passwordInput.promise;
    },
    onError: () => {}
  }).then(async () => {
    const me = await client.getMe();
    await saveTelegramSession(client.session.save());
    restoredClient = client;
    restoredUser = { id: String(me.id), firstName: me.firstName || "", username: me.username || "" };
    flow = null;
  }).catch(error => {
    if (flow) {
      flow.state = "error";
      flow.message = "Telegram не принял данные входа. Проверь их и начни вход заново.";
      flow.error = error;
    }
  });
  flow.startPromise = startPromise;

  await new Promise(resolve => setTimeout(resolve, 500));
  if (!flow) return { state: "connected", user: restoredUser };
  return { state: flow.state, message: flow.message };
}

async function submitLoginValue(value) {
  if (!flow) throw new Error("Сначала запроси код входа.");
  if (flow.state === "waiting_code") {
    const current = flow;
    current.state = "checking_code";
    current.codeInput.resolve(value);
    await new Promise(resolve => setTimeout(resolve, 700));
    return { state: current.state === "error" ? "error" : current.state, message: current.message || "Проверяем код…" };
  }
  if (flow.state === "waiting_password") {
    const current = flow;
    current.state = "checking_password";
    current.passwordInput.resolve(value);
    await new Promise(resolve => setTimeout(resolve, 700));
    return { state: current.state === "error" ? "error" : current.state, message: current.message || "Проверяем пароль…" };
  }
  if (flow.state === "error") throw new Error(flow.message);
  throw new Error("Сейчас ввод не требуется. Обнови статус через пару секунд.");
}

module.exports = { createLoginFlow, getLoginStatus, submitLoginValue };
