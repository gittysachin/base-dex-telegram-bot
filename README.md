# Base Telegram Trading Bot

## Setup
1. Copy `.env.example` to `.env` and fill values.
2. `npm install`
3. Run Supabase migrations (run `npm run migrate:node`).
4. Start bot: `npm run dev`

## Scripts
- `dev`: Start the bot with nodemon
- `build`: Type-check and bundle (esbuild placeholder)
- `start`: Run compiled app from `dist`
- `import:excel`: Import `Crypto_Transactions.xlsx` into Supabase

## Notes
- Wallet private keys are encrypted with AES-GCM using `ENCRYPTION_KEY_BASE64` and stored in `wallets.encrypted_private_key`.
- Sessions are stored in Supabase table `bot_sessions`.
- Token scanning uses DexScreener. Trading uses 0x Swap API v2 (Permit2) on Base.

## Excel Import
- Place `Crypto_Transactions.xlsx` in project root (default path).
- Run: `npm run import:excel` or `npm run import:excel -- /absolute/path/to/file.xlsx`
- Data is stored in `imported_transactions` for analytics/reconciliation.
