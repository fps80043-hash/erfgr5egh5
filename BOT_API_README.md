# Bot API

Use `X-API-SECRET: <BOT_API_SECRET>` on all `/api/bot/*` requests.

Key endpoints:
- GET `/api/bot/health`
- GET `/api/bot/profile?site_user_id=1`
- GET `/api/bot/balance?site_user_id=1`
- GET `/api/bot/robux/stock`
- GET `/api/bot/robux/quote?amount=100`
- GET `/api/bot/robux/orders?site_user_id=1`
- POST `/api/bot/robux/inspect?telegram_id=123`
- POST `/api/bot/robux/order_create?telegram_id=123`
- POST `/api/bot/robux/order_reserve?telegram_id=123`
- POST `/api/bot/robux/order_pay?telegram_id=123`
- POST `/api/bot/robux/order_cancel?telegram_id=123`
- GET `/api/bot/robux/order?telegram_id=123&id=1`
- POST `/api/bot/robux/voucher/claim?site_user_id=1`
- GET `/api/bot/shop/catalog`
- GET `/api/bot/shop/orders?site_user_id=1`
- POST `/api/bot/telegram/link`
- GET `/api/bot/admin/robux/settings?site_user_id=1`
- POST `/api/bot/admin/robux/settings?site_user_id=1`
- POST `/api/bot/admin/robux/voucher/create?site_user_id=1`
- GET `/api/bot/admin/robux/vouchers?site_user_id=1`

Robux vouchers currently redeem into **site balance** equal to the configured Robux price, so the user can immediately buy Robux on the site or in the Telegram bot.

Telegram profile binding:
- Site user creates a 10-minute code with `POST /api/user/telegram/link_code` while logged in on the site.
- Bot confirms it with `POST /api/bot/telegram/link/confirm` and payload `{"telegram_id": 123, "telegram_username": "name", "code": "123456"}`.

Run bot:
```bash
pip install -r requirements-bot.txt
set TELEGRAM_BOT_TOKEN=...
set BOT_API_SECRET=...
set SITE_BASE_URL=https://your-site.example.com
python telegram_bot.py
```
