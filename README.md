# LIFE MONEY NFT Offers

Telegram Mini App MVP for user-created NFT gift offers.

## Features
- Mobile-first Russian interface
- Informational price in TON, GRAM, or Telegram Stars
- Offer acceptance/decline demo interaction
- Explicit recipient disclosure (@koszakL); no automatic transfer
- Health endpoint at /health

## Important
This MVP is a user-created offer demo, not an official Telegram order, escrow, marketplace listing, or payment processor. It does not transfer NFTs, TON, GRAM, or Stars. The displayed price is informational only.

## Run
```bash
npm install
npm start
```

## Render
Create a Node Web Service from this repository. Build command: `npm install`. Start command: `npm start`. Set `OFFER_RECIPIENT=@koszakL` and `BOT_USERNAME=koszak_bot_ai` as environment variables if desired. Do not commit bot tokens or secrets.


## Encrypted Telegram session storage (in progress)

Cloudflare Worker source: `cloudflare/worker.js`  
Node encryption/storage client: `lib/session-store.js`

Required secrets (do not commit or share):
- Cloudflare Worker: `API_SECRET` (random secret, 32+ characters)
- Render: `SESSION_STORE_URL` (Worker base URL, e.g. `https://life-money-session-store.<account>.workers.dev`)
- Render: `SESSION_STORE_API_SECRET` (same value as Worker `API_SECRET`)
- Render: `SESSION_ENCRYPTION_KEY` (base64-encoded random 32-byte key)

The Node storage client encrypts with AES-256-GCM before sending data to the Worker. D1 receives ciphertext only. The client is a storage primitive and is not yet called by the app's Telegram authorization flow; do not treat this as a completed Telegram MTProto integration.


## Telegram QR sign-in (MTProto)

Open `/connect.html` after deployment. Configure these Render environment variables:
- `TG_API_ID` and `TG_API_HASH` from the user's Telegram API application
- `MTPROTO_SETUP_TOKEN`: a long random secret used only to protect the setup page and its API routes
- `SESSION_STORE_URL`, `SESSION_STORE_API_SECRET`, and `SESSION_ENCRYPTION_KEY` for encrypted session persistence

The QR login uses Teleproto's `signInUserWithQrCode` flow. The QR code is short-lived; scan it only in the official Telegram app under Settings → Devices → Link Desktop Device. Never share the QR code or setup token. A 2FA password, if requested by Telegram, is submitted only to this app's protected HTTPS endpoint and is held in process memory for the login attempt; it is not written to logs or the database. The resulting MTProto session is encrypted with AES-256-GCM before being sent to Cloudflare D1.

This is the account-connection step only. Native collectible-gift offer sending still requires separate implementation and verification of Telegram's current API parameters and eligibility rules.
