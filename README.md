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
