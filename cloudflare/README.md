# Cloudflare Worker — LIFE MONEY session store

## Current setup
- Worker name: `life-money-session-store`
- D1 database: `life-money-sessions`
- D1 binding variable: `DB`
- D1 table: `telegram_sessions`
- Required Worker secret: `API_SECRET`

## Deploy
The Worker source is `cloudflare/worker.js`. In Cloudflare, open the Worker → **Edit code**, replace the starter code with this file's contents, then **Deploy**.

In Worker Settings → Variables and Secrets, add a **Secret** named `API_SECRET` with a randomly generated value of at least 32 characters. Do not put it in GitHub or send it in chat.

## API
- `GET /health` — public liveness check.
- `GET /session` — authenticated; returns the stored ciphertext.
- `PUT /session` — authenticated; accepts JSON `{"encryptedSession":"<base64 ciphertext>"}`.

Authentication: `Authorization: Bearer <API_SECRET>`.

The Worker stores ciphertext only. The Node application must encrypt the GramJS StringSession using AES-256-GCM before sending it and decrypt only after retrieving it. The AES key must be a separate Render secret and must never be stored in D1, Worker code, or GitHub.

## Security notes
- Do not log request headers or bodies.
- Do not send Telegram login codes, 2FA passwords, or plaintext StringSession to this Worker.
- This storage adapter is not yet wired into the Node app; it becomes active only after the Node app is updated with client-side encryption and authenticated calls.
