/**
 * LIFE MONEY encrypted Telegram-session storage Worker.
 * D1 binding: DB
 * Secret: API_SECRET
 *
 * Stores ciphertext only. Encryption/decryption must happen in the Node app.
 * Never log request bodies, Authorization headers, or session material.
 */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(env.API_SECRET) && safeEqual(supplied, env.API_SECRET);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "life-money-session-store" });
    }

    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
    if (!env.DB) return json({ error: "Database binding DB is missing" }, 503);

    if (url.pathname === "/session" && request.method === "GET") {
      const row = await env.DB
        .prepare("SELECT encrypted_session, updated_at FROM telegram_sessions WHERE id = ?1")
        .bind("primary")
        .first();
      if (!row) return json({ exists: false });
      return json({ exists: true, encryptedSession: row.encrypted_session, updatedAt: row.updated_at });
    }

    if (url.pathname === "/session" && request.method === "PUT") {
      const length = Number(request.headers.get("content-length") || "0");
      if (length > 20000) return json({ error: "Payload too large" }, 413);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const value = body && body.encryptedSession;
      if (typeof value !== "string" || value.length < 32 || value.length > 16000) {
        return json({ error: "encryptedSession must be a valid ciphertext string" }, 400);
      }
      // Accept only base64-encoded AES-GCM payloads (nonce + ciphertext).
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return json({ error: "Ciphertext must be base64" }, 400);
      }

      await env.DB.prepare(
        "INSERT INTO telegram_sessions (id, encrypted_session, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) " +
        "ON CONFLICT(id) DO UPDATE SET encrypted_session = excluded.encrypted_session, updated_at = CURRENT_TIMESTAMP"
      ).bind("primary", value).run();

      return json({ saved: true });
    }

    return json({ error: "Not found" }, 404);
  },
};
