import asyncio
import html
import logging
import os
import re
from typing import Any, Dict, Optional

import aiohttp
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandObject, CommandStart, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message


LOG = logging.getLogger("rbx_telegram_bot")

TELEGRAM_BOT_TOKEN = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
SITE_BASE_URL = (os.environ.get("SITE_BASE_URL") or "http://127.0.0.1:8000").strip().rstrip("/")
BOT_API_SECRET = (os.environ.get("BOT_API_SECRET") or os.environ.get("API_SECRET") or "").strip()
CHANNEL_LINK = (os.environ.get("CHANNEL_LINK") or "").strip()

PREMIUM = {
    "settings": "5870982283724328568",
    "profile": "5870994129244131212",
    "people": "5870772616305839506",
    "file": "5870528606328852614",
    "chart": "5870921681735781843",
    "home": "5873147866364514353",
    "lock_open": "6037496202990194718",
    "bullhorn": "6039422865189638057",
    "check": "5870633910337015697",
    "cross": "5870657884844462243",
    "pencil": "5870676941614354370",
    "trash": "5870875489362513438",
    "back": "5893057118545646106",
    "link": "5769289093221454192",
    "info": "6028435952299413210",
    "bot": "6030400221232501136",
    "eye": "6037397706505195857",
    "send": "5963103826075456248",
    "bell": "6039486778597970865",
    "gift": "6032644646587338669",
    "wallet": "5769126056262898415",
    "box": "5884479287171485878",
    "tag": "5886285355279193209",
    "money": "5904462880941545555",
    "money_send": "5890848474563352982",
    "bank": "5879814368572478751",
    "code": "5940433880585605708",
    "loading": "5345906554510012647",
}


def pe(name: str, fallback: str = "") -> str:
    emoji_id = PREMIUM.get(name)
    if not emoji_id:
        return html.escape(fallback)
    return f'<tg-emoji emoji-id="{emoji_id}">{html.escape(fallback or "•")}</tg-emoji>'


def h(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def btn(text: str, callback_data: str, icon: Optional[str] = None) -> InlineKeyboardButton:
    kwargs: Dict[str, Any] = {"text": text, "callback_data": callback_data}
    if icon and PREMIUM.get(icon):
        kwargs["icon_custom_emoji_id"] = PREMIUM[icon]
    return InlineKeyboardButton(**kwargs)


def url_btn(text: str, url: str, icon: Optional[str] = None) -> InlineKeyboardButton:
    kwargs: Dict[str, Any] = {"text": text, "url": url}
    if icon and PREMIUM.get(icon):
        kwargs["icon_custom_emoji_id"] = PREMIUM[icon]
    return InlineKeyboardButton(**kwargs)


def kb(rows: list[list[InlineKeyboardButton]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=rows)


def main_menu(is_admin: bool = False) -> InlineKeyboardMarkup:
    rows = [
        [btn("Профиль", "profile", "profile"), btn("Купить Robux", "buy", "money")],
        [btn("Наличие", "stock", "box"), btn("Мои заказы", "orders", "file")],
        [btn("Активировать ваучер", "voucher", "gift"), btn("Привязка", "link", "link")],
    ]
    if is_admin:
        rows.append([btn("Админка", "admin", "settings")])
    if CHANNEL_LINK:
        rows.append([url_btn("Канал", CHANNEL_LINK, "bullhorn")])
    return kb(rows)


def back_menu() -> InlineKeyboardMarkup:
    return kb([[btn("Назад", "home", "back")]])


class SiteAPIError(Exception):
    def __init__(self, detail: str, status: int = 0):
        super().__init__(detail)
        self.detail = detail
        self.status = status


class SiteAPI:
    def __init__(self, base_url: str, secret: str):
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self.session: Optional[aiohttp.ClientSession] = None

    async def _session(self) -> aiohttp.ClientSession:
        if self.session is None or self.session.closed:
            timeout = aiohttp.ClientTimeout(total=90)
            self.session = aiohttp.ClientSession(timeout=timeout)
        return self.session

    async def close(self) -> None:
        if self.session and not self.session.closed:
            await self.session.close()

    async def request(
        self,
        method: str,
        path: str,
        *,
        tg_id: Optional[int] = None,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if not self.secret:
            raise SiteAPIError("BOT_API_SECRET не задан")
        qp = dict(params or {})
        if tg_id:
            qp["telegram_id"] = int(tg_id)
        headers = {"X-API-SECRET": self.secret}
        url = f"{self.base_url}{path}"
        session = await self._session()
        async with session.request(method, url, params=qp, json=json_data, headers=headers) as resp:
            text = await resp.text()
            try:
                data = await resp.json(content_type=None)
            except Exception:
                data = {"detail": text[:400]}
            if resp.status >= 400:
                detail = data.get("detail") or data.get("message") or text[:400] or f"HTTP {resp.status}"
                raise SiteAPIError(str(detail), resp.status)
            if isinstance(data, dict) and data.get("ok") is False:
                raise SiteAPIError(str(data.get("detail") or data.get("message") or "Ошибка API"), resp.status)
            return data if isinstance(data, dict) else {"ok": True, "data": data}

    async def profile(self, tg_id: int) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/profile", tg_id=tg_id)

    async def link_info(self, tg_id: int) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/telegram/link", params={"telegram_id": tg_id})

    async def confirm_link(self, tg_id: int, username: str, code: str) -> Dict[str, Any]:
        return await self.request(
            "POST",
            "/api/bot/telegram/link/confirm",
            json_data={"telegram_id": tg_id, "telegram_username": username, "code": code},
        )

    async def stock(self) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/robux/stock")

    async def quote(self, amount: int) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/robux/quote", params={"amount": amount})

    async def orders(self, tg_id: int, limit: int = 8) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/robux/orders", tg_id=tg_id, params={"limit": limit})

    async def reserve_order(self, tg_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        return await self.request("POST", "/api/bot/robux/order_reserve", tg_id=tg_id, json_data=payload)

    async def pay_order(self, tg_id: int, order_id: int) -> Dict[str, Any]:
        return await self.request("POST", "/api/bot/robux/order_pay", tg_id=tg_id, json_data={"order_id": order_id})

    async def cancel_order(self, tg_id: int, order_id: int) -> Dict[str, Any]:
        return await self.request("POST", "/api/bot/robux/order_cancel", tg_id=tg_id, json_data={"order_id": order_id})

    async def order(self, tg_id: int, order_id: int) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/robux/order", tg_id=tg_id, params={"id": order_id})

    async def claim_voucher(self, tg_id: int, code: str) -> Dict[str, Any]:
        return await self.request("POST", "/api/bot/robux/voucher/claim", tg_id=tg_id, json_data={"code": code})

    async def admin_settings(self, tg_id: int) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/admin/robux/settings", tg_id=tg_id)

    async def admin_set_settings(self, tg_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        return await self.request("POST", "/api/bot/admin/robux/settings", tg_id=tg_id, json_data=payload)

    async def admin_recent(self, tg_id: int, limit: int = 10) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/admin/orders/recent", tg_id=tg_id, params={"limit": limit})

    async def admin_find_users(self, tg_id: int, q: str) -> Dict[str, Any]:
        return await self.request("GET", "/api/bot/admin/users/find", tg_id=tg_id, params={"q": q, "limit": 10})

    async def admin_adjust_balance(self, tg_id: int, user_id: int, delta: int, reason: str) -> Dict[str, Any]:
        return await self.request(
            "POST",
            "/api/bot/admin/balance_adjust",
            tg_id=tg_id,
            json_data={"user_id": user_id, "delta": delta, "reason": reason},
        )

    async def admin_create_voucher(self, tg_id: int, robux_amount: int, uses_total: int = 1) -> Dict[str, Any]:
        return await self.request(
            "POST",
            "/api/bot/admin/robux/voucher/create",
            tg_id=tg_id,
            json_data={"robux_amount": robux_amount, "uses_total": uses_total, "source": "telegram_bot"},
        )


class LinkStates(StatesGroup):
    waiting_code = State()


class VoucherStates(StatesGroup):
    waiting_code = State()


class BuyStates(StatesGroup):
    amount = State()
    target = State()


class AdminFindStates(StatesGroup):
    query = State()


class AdminAdjustStates(StatesGroup):
    user_id = State()
    delta = State()


class AdminSettingsStates(StatesGroup):
    value = State()


class AdminVoucherStates(StatesGroup):
    amount = State()
    uses = State()


router = Router()


async def try_profile(api: SiteAPI, tg_id: int) -> Optional[Dict[str, Any]]:
    try:
        data = await api.profile(tg_id)
        return data.get("user") or {}
    except SiteAPIError:
        return None


async def send_or_edit(event: Message | CallbackQuery, text: str, reply_markup: Optional[InlineKeyboardMarkup] = None) -> None:
    if isinstance(event, CallbackQuery):
        try:
            await event.message.edit_text(text, reply_markup=reply_markup)
        except Exception:
            await event.message.answer(text, reply_markup=reply_markup)
        await event.answer()
    else:
        await event.answer(text, reply_markup=reply_markup)


async def linked_or_prompt(event: Message | CallbackQuery, api: SiteAPI) -> Optional[Dict[str, Any]]:
    tg_id = event.from_user.id
    user = await try_profile(api, tg_id)
    if user:
        return user
    text = (
        f"{pe('link')} <b>Профиль не привязан</b>\n\n"
        "На сайте открой профиль и создай Telegram-код привязки, затем отправь его сюда командой:\n"
        "<code>/link 123456</code>"
    )
    if isinstance(event, CallbackQuery):
        await event.answer("Сначала привяжи профиль", show_alert=True)
        await event.message.answer(text, reply_markup=kb([[btn("Ввести код", "link", "link")]]))
    else:
        await event.answer(text, reply_markup=kb([[btn("Ввести код", "link", "link")]]))
    return None


def status_ru(status: str) -> str:
    return {
        "new": "новый",
        "reserved": "забронирован",
        "paid": "ожидает отправки",
        "processing": "отправляется",
        "done": "доставлен",
        "cancelled": "отменён",
        "refunded": "возврат",
        "expired": "истёк",
        "failed": "ошибка",
    }.get(status or "", status or "неизвестно")


def target_payload(target: str) -> Dict[str, str]:
    value = target.strip()
    if re.search(r"roblox\.com|game-pass|gamepass|^\d{5,}$", value, re.I):
        return {"gamepass_url": value}
    return {"username": value}


@router.message(CommandStart())
async def start(message: Message, api: SiteAPI, state: FSMContext) -> None:
    await state.clear()
    user = await try_profile(api, message.from_user.id)
    is_admin = bool(user and int(user.get("is_admin") or 0) == 1)
    if user:
        text = (
            f"{pe('bot')} <b>RBX ST Bot</b>\n\n"
            f"{pe('profile')} {h(user.get('username'))} · ID <code>{h(user.get('id'))}</code>\n"
            f"{pe('wallet')} Баланс: <b>{h(user.get('balance'))} ₽</b>"
        )
    else:
        text = (
            f"{pe('bot')} <b>RBX ST Bot</b>\n\n"
            "Покупка Robux, баланс, наличие и заказы синхронизированы с сайтом.\n"
            "Для начала привяжи профиль кодом с сайта."
        )
    await message.answer(text, reply_markup=main_menu(is_admin))


@router.message(Command("link"))
async def link_command(message: Message, command: CommandObject, api: SiteAPI, state: FSMContext) -> None:
    code = (command.args or "").strip()
    if not code:
        await state.set_state(LinkStates.waiting_code)
        await message.answer(f"{pe('link')} Введи 6-значный код привязки с сайта.", reply_markup=back_menu())
        return
    await confirm_link_code(message, api, state, code)


@router.callback_query(F.data == "home")
async def home(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    await state.clear()
    user = await try_profile(api, callback.from_user.id)
    is_admin = bool(user and int(user.get("is_admin") or 0) == 1)
    text = f"{pe('home')} <b>Главное меню</b>"
    if user:
        text += f"\n\n{pe('profile')} {h(user.get('username'))}\n{pe('wallet')} Баланс: <b>{h(user.get('balance'))} ₽</b>"
    else:
        text += "\n\nПрофиль пока не привязан."
    await send_or_edit(callback, text, main_menu(is_admin))


@router.callback_query(F.data == "link")
async def ask_link(callback: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(LinkStates.waiting_code)
    await send_or_edit(
        callback,
        f"{pe('link')} <b>Привязка профиля</b>\n\nОтправь код, который создан на сайте в профиле. Пример: <code>123456</code>",
        back_menu(),
    )


@router.message(LinkStates.waiting_code)
async def link_code_message(message: Message, api: SiteAPI, state: FSMContext) -> None:
    await confirm_link_code(message, api, state, message.text or "")


async def confirm_link_code(message: Message, api: SiteAPI, state: FSMContext, code: str) -> None:
    try:
        data = await api.confirm_link(message.from_user.id, message.from_user.username or "", code)
        user = data.get("user") or {}
        await state.clear()
        await message.answer(
            f"{pe('check')} <b>Профиль привязан</b>\n\n"
            f"{pe('profile')} {h(user.get('username'))} · ID <code>{h(user.get('id'))}</code>\n"
            f"{pe('wallet')} Баланс: <b>{h(user.get('balance'))} ₽</b>",
            reply_markup=main_menu(bool(int(user.get("is_admin") or 0))),
        )
    except SiteAPIError as e:
        await message.answer(f"{pe('cross')} Не удалось привязать профиль: {h(e.detail)}", reply_markup=back_menu())


@router.callback_query(F.data == "profile")
async def profile(callback: CallbackQuery, api: SiteAPI) -> None:
    user = await linked_or_prompt(callback, api)
    if not user:
        return
    text = (
        f"{pe('profile')} <b>Профиль</b>\n\n"
        f"Логин: <b>{h(user.get('username'))}</b>\n"
        f"ID сайта: <code>{h(user.get('id'))}</code>\n"
        f"Баланс: <b>{h(user.get('balance'))} ₽</b>\n"
        f"Premium: <b>{'активен' if user.get('premium') else 'нет'}</b>"
    )
    await send_or_edit(callback, text, back_menu())


@router.callback_query(F.data == "stock")
async def stock(callback: CallbackQuery, api: SiteAPI) -> None:
    try:
        data = await api.stock()
        text = (
            f"{pe('box')} <b>Наличие Robux</b>\n\n"
            f"Доступно: <b>{h(data.get('available'))}</b>\n"
            f"Статус: <b>{h(data.get('status'))}</b>\n"
            f"Курс: <b>{h(data.get('rub_per_robux'))} ₽ / Robux</b>\n"
            f"Резерв: <b>{h(data.get('reserved'))}</b>"
        )
    except SiteAPIError as e:
        text = f"{pe('cross')} Ошибка: {h(e.detail)}"
    await send_or_edit(callback, text, back_menu())


@router.callback_query(F.data == "orders")
async def orders(callback: CallbackQuery, api: SiteAPI) -> None:
    user = await linked_or_prompt(callback, api)
    if not user:
        return
    try:
        data = await api.orders(callback.from_user.id)
        items = data.get("items") or []
        if not items:
            text = f"{pe('file')} <b>Мои заказы</b>\n\nЗаказов пока нет."
        else:
            lines = [f"{pe('file')} <b>Мои заказы</b>"]
            for item in items:
                lines.append(
                    f"\n#<code>{h(item.get('id'))}</code> · <b>{h(item.get('robux_amount'))} Robux</b>\n"
                    f"{h(item.get('rub_price'))} ₽ · {h(status_ru(item.get('status')))}"
                )
            text = "\n".join(lines)
    except SiteAPIError as e:
        text = f"{pe('cross')} Ошибка: {h(e.detail)}"
    await send_or_edit(callback, text, back_menu())


@router.callback_query(F.data == "voucher")
async def voucher(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    if not await linked_or_prompt(callback, api):
        return
    await state.set_state(VoucherStates.waiting_code)
    await send_or_edit(callback, f"{pe('gift')} Введи код ваучера Robux.", back_menu())


@router.message(VoucherStates.waiting_code)
async def voucher_code(message: Message, api: SiteAPI, state: FSMContext) -> None:
    try:
        data = await api.claim_voucher(message.from_user.id, message.text or "")
        await state.clear()
        await message.answer(
            f"{pe('check')} <b>Ваучер активирован</b>\n\n"
            f"Robux: <b>{h(data.get('robux_amount'))}</b>\n"
            f"Зачислено: <b>{h(data.get('credited_balance'))} ₽</b>\n"
            f"Баланс: <b>{h(data.get('balance'))} ₽</b>",
            reply_markup=main_menu(False),
        )
    except SiteAPIError as e:
        await message.answer(f"{pe('cross')} {h(e.detail)}", reply_markup=back_menu())


@router.callback_query(F.data == "buy")
async def buy_start(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    if not await linked_or_prompt(callback, api):
        return
    await state.set_state(BuyStates.amount)
    await send_or_edit(callback, f"{pe('money')} <b>Покупка Robux</b>\n\nВведи количество Robux.", back_menu())


@router.message(BuyStates.amount)
async def buy_amount(message: Message, api: SiteAPI, state: FSMContext) -> None:
    raw = re.sub(r"\D+", "", message.text or "")
    amount = int(raw or 0)
    if amount <= 0:
        await message.answer("Введи число больше нуля.", reply_markup=back_menu())
        return
    try:
        quote = await api.quote(amount)
    except SiteAPIError as e:
        await message.answer(f"{pe('cross')} {h(e.detail)}", reply_markup=back_menu())
        return
    await state.update_data(amount=amount, quote=quote)
    await state.set_state(BuyStates.target)
    await message.answer(
        f"{pe('info')} <b>Расчёт</b>\n\n"
        f"К получению: <b>{h(quote.get('robux') or amount)} Robux</b>\n"
        f"Цена: <b>{h(quote.get('rub_price'))} ₽</b>\n"
        f"Цена gamepass: <b>{h(quote.get('gamepass_price'))} Robux</b>\n\n"
        "Отправь Roblox username или ссылку/ID gamepass.",
        reply_markup=back_menu(),
    )


@router.message(BuyStates.target)
async def buy_target(message: Message, state: FSMContext) -> None:
    target = (message.text or "").strip()
    if len(target) < 3:
        await message.answer("Пришли корректный username или gamepass.", reply_markup=back_menu())
        return
    data = await state.get_data()
    quote = data.get("quote") or {}
    await state.update_data(target=target)
    await message.answer(
        f"{pe('check')} <b>Подтверждение заказа</b>\n\n"
        f"Robux: <b>{h(data.get('amount'))}</b>\n"
        f"К оплате с баланса: <b>{h(quote.get('rub_price'))} ₽</b>\n"
        f"Получатель/gamepass: <code>{h(target)}</code>",
        reply_markup=kb([[btn("Забронировать", "buy_confirm", "check")], [btn("Назад", "home", "back")]]),
    )


@router.callback_query(F.data == "buy_confirm")
async def buy_confirm(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    data = await state.get_data()
    amount = int(data.get("amount") or 0)
    target = str(data.get("target") or "")
    if amount <= 0 or not target:
        await callback.answer("Нет данных заказа", show_alert=True)
        return
    payload = {"amount": amount, **target_payload(target)}
    await callback.answer("Создаю бронь...")
    try:
        res = await api.reserve_order(callback.from_user.id, payload)
        await state.clear()
        order_id = int(res.get("order_id") or 0)
        await callback.message.edit_text(
            f"{pe('check')} <b>Заказ забронирован</b>\n\n"
            f"ID: <code>{order_id}</code>\n"
            f"Статус: <b>{h(status_ru(res.get('status')))}</b>\n\n"
            "Нажми оплатить, чтобы запустить отправку Robux.",
            reply_markup=kb(
                [
                    [btn("Оплатить", f"pay:{order_id}", "money_send")],
                    [btn("Отменить", f"cancel:{order_id}", "cross")],
                ]
            ),
        )
    except SiteAPIError as e:
        await callback.message.answer(f"{pe('cross')} Не удалось создать заказ: {h(e.detail)}", reply_markup=back_menu())


@router.callback_query(F.data.startswith("pay:"))
async def pay_order(callback: CallbackQuery, api: SiteAPI) -> None:
    order_id = int(callback.data.split(":", 1)[1])
    await callback.answer("Запускаю оплату...")
    try:
        res = await api.pay_order(callback.from_user.id, order_id)
        await callback.message.edit_text(
            f"{pe('loading')} <b>Заказ отправлен в обработку</b>\n\n"
            f"ID: <code>{order_id}</code>\n"
            f"Статус: <b>{h(status_ru(res.get('status')))}</b>",
            reply_markup=kb([[btn("Проверить статус", f"order:{order_id}", "eye")], [btn("В меню", "home", "home")]]),
        )
    except SiteAPIError as e:
        await callback.message.answer(f"{pe('cross')} {h(e.detail)}", reply_markup=back_menu())


@router.callback_query(F.data.startswith("cancel:"))
async def cancel_order(callback: CallbackQuery, api: SiteAPI) -> None:
    order_id = int(callback.data.split(":", 1)[1])
    try:
        res = await api.cancel_order(callback.from_user.id, order_id)
        await callback.message.edit_text(
            f"{pe('cross')} <b>Заказ отменён</b>\n\n"
            f"ID: <code>{order_id}</code>\n"
            f"Возврат: <b>{h(res.get('refunded'))} ₽</b>",
            reply_markup=back_menu(),
        )
    except SiteAPIError as e:
        await callback.message.answer(f"{pe('cross')} {h(e.detail)}", reply_markup=back_menu())
    await callback.answer()


@router.callback_query(F.data.startswith("order:"))
async def order_status(callback: CallbackQuery, api: SiteAPI) -> None:
    order_id = int(callback.data.split(":", 1)[1])
    try:
        data = await api.order(callback.from_user.id, order_id)
        order = data.get("order") or {}
        await callback.message.edit_text(
            f"{pe('file')} <b>Заказ #{order_id}</b>\n\n"
            f"Robux: <b>{h(order.get('robux_amount'))}</b>\n"
            f"Цена: <b>{h(order.get('rub_price'))} ₽</b>\n"
            f"Статус: <b>{h(status_ru(order.get('status')))}</b>\n"
            f"Ошибка: <code>{h(order.get('error'))}</code>",
            reply_markup=back_menu(),
        )
    except SiteAPIError as e:
        await callback.message.answer(f"{pe('cross')} {h(e.detail)}", reply_markup=back_menu())
    await callback.answer()


async def ensure_admin(event: Message | CallbackQuery, api: SiteAPI) -> Optional[Dict[str, Any]]:
    user = await linked_or_prompt(event, api)
    if not user:
        return None
    if int(user.get("is_admin") or 0) != 1 and int(user.get("id") or 0) != 1:
        if isinstance(event, CallbackQuery):
            await event.answer("Нет доступа", show_alert=True)
        else:
            await event.answer("Нет доступа.")
        return None
    return user


@router.callback_query(F.data == "admin")
async def admin_menu(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    await state.clear()
    if not await ensure_admin(callback, api):
        return
    await send_or_edit(
        callback,
        f"{pe('settings')} <b>Админка</b>\n\nУправление балансом, настройками Robux, ваучерами и заказами.",
        kb(
            [
                [btn("Настройки Robux", "admin_settings", "settings"), btn("Последние заказы", "admin_recent", "file")],
                [btn("Найти пользователя", "admin_find", "people"), btn("Баланс", "admin_adjust", "wallet")],
                [btn("Создать ваучер", "admin_voucher", "gift")],
                [btn("Назад", "home", "back")],
            ]
        ),
    )


@router.callback_query(F.data == "admin_settings")
async def admin_settings(callback: CallbackQuery, api: SiteAPI) -> None:
    if not await ensure_admin(callback, api):
        return
    try:
        data = await api.admin_settings(callback.from_user.id)
        st = data.get("settings") or {}
        stock = (data.get("stock") or {}).get("available")
        text = (
            f"{pe('settings')} <b>Robux настройки</b>\n\n"
            f"Минимум: <b>{h(st.get('min_amount'))}</b>\n"
            f"Курс: <b>{h(st.get('rub_per_robux'))}</b>\n"
            f"Gamepass factor: <b>{h(st.get('gp_factor'))}</b>\n"
            f"Витрина: <b>{h(st.get('stock_show'))}</b>\n"
            f"Лимит продажи: <b>{h(st.get('stock_sell'))}</b>\n"
            f"Резерв секунд: <b>{h(st.get('reserve_seconds'))}</b>\n"
            f"Сейчас доступно: <b>{h(stock)}</b>"
        )
    except SiteAPIError as e:
        text = f"{pe('cross')} {h(e.detail)}"
    await send_or_edit(
        callback,
        text,
        kb(
            [
                [btn("Курс", "admin_set:rub_per_robux", "pencil"), btn("Минимум", "admin_set:min_amount", "pencil")],
                [btn("Витрина", "admin_set:stock_show", "pencil"), btn("Лимит", "admin_set:stock_sell", "pencil")],
                [btn("Назад", "admin", "back")],
            ]
        ),
    )


@router.callback_query(F.data.startswith("admin_set:"))
async def admin_set_field(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    if not await ensure_admin(callback, api):
        return
    field = callback.data.split(":", 1)[1]
    await state.update_data(field=field)
    await state.set_state(AdminSettingsStates.value)
    await send_or_edit(callback, f"{pe('pencil')} Введи новое значение для <code>{h(field)}</code>.", back_menu())


@router.message(AdminSettingsStates.value)
async def admin_set_value(message: Message, api: SiteAPI, state: FSMContext) -> None:
    data = await state.get_data()
    field = str(data.get("field") or "")
    raw = (message.text or "").replace(",", ".").strip()
    if field in {"rub_per_robux", "gp_factor"}:
        value: Any = float(raw)
    else:
        value = int(float(raw))
    try:
        await api.admin_set_settings(message.from_user.id, {field: value})
        await state.clear()
        await message.answer(f"{pe('check')} Настройка сохранена.", reply_markup=kb([[btn("Админка", "admin", "settings")]]))
    except (ValueError, SiteAPIError) as e:
        await message.answer(f"{pe('cross')} {h(getattr(e, 'detail', str(e)))}", reply_markup=back_menu())


@router.callback_query(F.data == "admin_recent")
async def admin_recent(callback: CallbackQuery, api: SiteAPI) -> None:
    if not await ensure_admin(callback, api):
        return
    try:
        data = await api.admin_recent(callback.from_user.id)
        items = data.get("items") or []
        lines = [f"{pe('file')} <b>Последние заказы</b>"]
        for item in items[:10]:
            lines.append(
                f"\n{h(item.get('kind'))} #<code>{h(item.get('id'))}</code> · user <code>{h(item.get('user_id'))}</code>\n"
                f"{h(item.get('title'))} · {h(item.get('amount'))} ₽ · {h(status_ru(item.get('status')))}"
            )
        text = "\n".join(lines) if items else f"{pe('file')} Заказов нет."
    except SiteAPIError as e:
        text = f"{pe('cross')} {h(e.detail)}"
    await send_or_edit(callback, text, kb([[btn("Назад", "admin", "back")]]))


@router.callback_query(F.data == "admin_find")
async def admin_find(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    if not await ensure_admin(callback, api):
        return
    await state.set_state(AdminFindStates.query)
    await send_or_edit(callback, f"{pe('people')} Введи username или email пользователя.", back_menu())


@router.message(AdminFindStates.query)
async def admin_find_query(message: Message, api: SiteAPI, state: FSMContext) -> None:
    try:
        data = await api.admin_find_users(message.from_user.id, message.text or "")
        items = data.get("items") or []
        if not items:
            text = "Ничего не найдено."
        else:
            lines = [f"{pe('people')} <b>Найдено</b>"]
            for user in items:
                lines.append(
                    f"\nID <code>{h(user.get('id'))}</code> · <b>{h(user.get('username'))}</b>\n"
                    f"{h(user.get('email'))} · баланс {h(user.get('balance'))} ₽"
                )
            text = "\n".join(lines)
        await state.clear()
        await message.answer(text, reply_markup=kb([[btn("Админка", "admin", "settings")]]))
    except SiteAPIError as e:
        await message.answer(f"{pe('cross')} {h(e.detail)}", reply_markup=back_menu())


@router.callback_query(F.data == "admin_adjust")
async def admin_adjust(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    if not await ensure_admin(callback, api):
        return
    await state.set_state(AdminAdjustStates.user_id)
    await send_or_edit(callback, f"{pe('wallet')} Введи ID пользователя на сайте.", back_menu())


@router.message(AdminAdjustStates.user_id)
async def admin_adjust_user(message: Message, state: FSMContext) -> None:
    user_id = int(re.sub(r"\D+", "", message.text or "") or 0)
    if user_id <= 0:
        await message.answer("Нужен числовой ID.", reply_markup=back_menu())
        return
    await state.update_data(user_id=user_id)
    await state.set_state(AdminAdjustStates.delta)
    await message.answer("Введи изменение баланса, например <code>100</code> или <code>-50</code>.", reply_markup=back_menu())


@router.message(AdminAdjustStates.delta)
async def admin_adjust_delta(message: Message, api: SiteAPI, state: FSMContext) -> None:
    data = await state.get_data()
    try:
        delta = int((message.text or "").strip())
        res = await api.admin_adjust_balance(
            message.from_user.id,
            int(data.get("user_id")),
            delta,
            f"telegram admin @{message.from_user.username or message.from_user.id}",
        )
        await state.clear()
        await message.answer(
            f"{pe('check')} Баланс обновлён.\nНовый баланс: <b>{h(res.get('new_balance'))} ₽</b>",
            reply_markup=kb([[btn("Админка", "admin", "settings")]]),
        )
    except (ValueError, SiteAPIError) as e:
        await message.answer(f"{pe('cross')} {h(getattr(e, 'detail', str(e)))}", reply_markup=back_menu())


@router.callback_query(F.data == "admin_voucher")
async def admin_voucher(callback: CallbackQuery, api: SiteAPI, state: FSMContext) -> None:
    if not await ensure_admin(callback, api):
        return
    await state.set_state(AdminVoucherStates.amount)
    await send_or_edit(callback, f"{pe('gift')} Введи количество Robux для ваучера.", back_menu())


@router.message(AdminVoucherStates.amount)
async def admin_voucher_amount(message: Message, state: FSMContext) -> None:
    amount = int(re.sub(r"\D+", "", message.text or "") or 0)
    if amount <= 0:
        await message.answer("Нужно число больше нуля.", reply_markup=back_menu())
        return
    await state.update_data(amount=amount)
    await state.set_state(AdminVoucherStates.uses)
    await message.answer("Сколько использований? Обычно <code>1</code>.", reply_markup=back_menu())


@router.message(AdminVoucherStates.uses)
async def admin_voucher_uses(message: Message, api: SiteAPI, state: FSMContext) -> None:
    data = await state.get_data()
    uses = int(re.sub(r"\D+", "", message.text or "") or 1)
    try:
        res = await api.admin_create_voucher(message.from_user.id, int(data.get("amount")), max(1, uses))
        voucher = res.get("voucher") or {}
        await state.clear()
        await message.answer(
            f"{pe('gift')} <b>Ваучер создан</b>\n\n"
            f"Код: <code>{h(voucher.get('code'))}</code>\n"
            f"Robux: <b>{h(voucher.get('robux_amount'))}</b>\n"
            f"Использований: <b>{h(voucher.get('uses_total'))}</b>",
            reply_markup=kb([[btn("Админка", "admin", "settings")]]),
        )
    except SiteAPIError as e:
        await message.answer(f"{pe('cross')} {h(e.detail)}", reply_markup=back_menu())


@router.message(StateFilter(None))
async def fallback(message: Message) -> None:
    await message.answer("Выбери действие в меню.", reply_markup=main_menu(False))


async def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
    if not BOT_API_SECRET:
        raise RuntimeError("BOT_API_SECRET is required")
    api = SiteAPI(SITE_BASE_URL, BOT_API_SECRET)
    bot = Bot(token=TELEGRAM_BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher()
    dp.include_router(router)
    try:
        LOG.info("Starting Telegram bot for %s", SITE_BASE_URL)
        await dp.start_polling(bot, api=api)
    finally:
        await api.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
