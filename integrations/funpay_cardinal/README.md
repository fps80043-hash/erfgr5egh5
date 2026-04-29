# FunPay Cardinal starter plugin

Это стартовый плагин под FunPay Cardinal, который создаёт robux-ваучер через API сайта.

Что уже сделано:
- HTTP-вызов в `POST /api/bot/admin/robux/voucher/create`
- генерация ваучера на стороне сайта
- можно передать `robux_amount`, `buyer_username`, `order_id`

Что нужно сделать у себя в Cardinal:
- положить файл плагина в `plugins/`
- настроить переменные `SITE_URL`, `API_SECRET`, `ADMIN_SITE_USER_ID`
- подвязать вызов `create_robux_voucher(...)` к событию успешной оплаты нужного лота

Почему это стартовый вариант, а не 100% готовый plug-and-play:
- у разных сборок/форков FunPay Cardinal названия событий и структуры данных могут отличаться
- сам HTTP-слой и формат сайта уже готовы, но точку вызова под ваш конкретный Cardinal лучше подцепить после проверки его версии
