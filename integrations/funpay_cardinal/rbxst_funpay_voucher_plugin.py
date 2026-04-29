# -*- coding: utf-8 -*-
NAME = "RBX ST Voucher Creator"
VERSION = "0.1.0"
DESCRIPTION = "Создаёт ваучеры на Robux через API сайта после оплаты на FunPay."
CREDITS = "OpenAI starter plugin"
UUID = "8f45f522-0f7f-4b08-b6ce-1f8f3d79f7c8"
SETTINGS_PAGE = False
BIND_TO_DELETE = None

import os
import requests

SITE_URL = os.environ.get("RBXST_SITE_URL", "https://example.com").rstrip("/")
API_SECRET = os.environ.get("RBXST_API_SECRET", "")
ADMIN_SITE_USER_ID = int(os.environ.get("RBXST_ADMIN_SITE_USER_ID", "1") or 1)
DEFAULT_ROBUX = int(os.environ.get("RBXST_DEFAULT_ROBUX", "100") or 100)


def create_robux_voucher(*, robux_amount: int, buyer_username: str = "", order_id: str = "", note: str = "") -> dict:
    payload = {
        "robux_amount": int(robux_amount or DEFAULT_ROBUX),
        "uses_total": 1,
        "source": "funpay_cardinal",
        "source_ref": str(order_id or ""),
        "note": note or (f"FunPay order {order_id} for {buyer_username}".strip()),
    }
    r = requests.post(
        f"{SITE_URL}/api/bot/admin/robux/voucher/create",
        params={"site_user_id": ADMIN_SITE_USER_ID},
        headers={"X-API-SECRET": API_SECRET},
        json=payload,
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


# Ниже — пример хука.
# Под ваш Cardinal нужно подставить реальное событие успешной оплаты/доставки.
new_order_handlers = []


def example_success_handler(order):
    """
    Пример. Подстройте под объект order вашего Cardinal.
    Когда поймёте точное событие, вызовите внутри:
        result = create_robux_voucher(robux_amount=..., buyer_username=..., order_id=...)
    и отправьте покупателю код ваучера.
    """
    return None
