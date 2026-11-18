const crypto = require("node:crypto");

function getKey() {
  const encoded = process.env.SESSION_ENCRYPTION_KEY;
  if (!encoded) throw new Error("SESSION_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function workerConfig() {
  const base = process.env.SESSION_STORE_URL;
  const token = process.env.SESSION_STORE_API_SECRET;
  if (!base || !token) throw new Error("Session store URL/API secret are not configured");
  return { base: base.replace(/\/$/, ""), token };
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(encoded) {
  const data = Buffer.from(encoded, "base64");
  if (data.length < 29) throw new Error("Stored session ciphertext is invalid");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function request(path, options = {}) {
  const { base, token } = workerConfig();
  const response = await fetch(base + path, {
    ...options,
    headers: {
      authorization: "Bearer " + token,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error("Session storage request failed (" + response.status + ")");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function saveTelegramSession(stringSession) {
  if (typeof stringSession !== "string" || !stringSession) throw new Error("Session is empty");
  const encryptedSession = encrypt(stringSession);
  return request("/session", {
    method: "PUT",
    body: JSON.stringify({ encryptedSession }),
  });
}

async function loadTelegramSession() {
  const result = await request("/session", { method: "GET" });
  return result.exists ? decrypt(result.encryptedSession) : null;
}

async function checkSessionStore() {
  const result = await request("/session", { method: "GET" });
  if (result.exists) {
    if (typeof result.encryptedSession !== "string") throw new Error("Stored session record is invalid");
    decrypt(result.encryptedSession);
  }
  return { connected: true, sessionSaved: Boolean(result.exists) };
}

module.exports = { saveTelegramSession, loadTelegramSession, checkSessionStore };
