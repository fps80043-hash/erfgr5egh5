import os
import re
import datetime
import random
import sqlite3
import threading
import math
import time
import asyncio
from pathlib import Path

try:
    import aiohttp
except ImportError:
    aiohttp = None

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="R$T Web")

# --- Global exception handler: log all unhandled errors ---
import traceback as _tb
import logging
_log = logging.getLogger("rbx")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

@app.exception_handler(Exception)
async def _global_exception_handler(request, exc):
    _log.error("UNHANDLED %s %s: %s\n%s", request.method, request.url.path, exc, _tb.format_exc())
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=500, content={"detail": f"Internal error: {str(exc)[:300]}"})

# --- Site-wide settings (in-memory, persisted via DB) ---
_SITE_SETTINGS = {"maintenance": False, "maintenance_msg": "🔧 Технические работы. Скоро вернёмся!"}
# FORCE_MAINTENANCE_OFF env var - always off even if DB has it on
_FORCE_MAINTENANCE_OFF = bool(os.environ.get("FORCE_MAINTENANCE_OFF"))

def _load_site_settings():
    global _FORCE_MAINTENANCE_OFF
    try:
        con = db_conn()
        row = con.execute("SELECT value FROM site_kv WHERE key='settings'").fetchone()
        con.close()
        if row:
            import json
            loaded = json.loads(row["value"])
            _SITE_SETTINGS.update(loaded)
    except Exception:
        pass
    # Force maintenance OFF if env var is set (override DB)
    if _FORCE_MAINTENANCE_OFF:
        _SITE_SETTINGS["maintenance"] = False

def _save_site_settings():
    try:
        import json
        con = db_conn()
        val = json.dumps(_SITE_SETTINGS)
        if USE_PG:
            con.execute("INSERT INTO site_kv(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (val,))
        else:
            con.execute("INSERT OR REPLACE INTO site_kv(key,value) VALUES('settings',?)", (val,))
        con.commit()
        con.close()
    except Exception:
        pass
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


# Optional Postgres (Railway/Render)
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.lower().startswith("postgres")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

try:
    import psycopg
    from psycopg.rows import dict_row
    PGIntegrityError = psycopg.IntegrityError
except Exception:
    psycopg = None
    dict_row = None
    PGIntegrityError = None

import json
import hashlib
import hmac
import secrets
import base64
from typing import Any, Dict, List, Tuple, Optional

import requests
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Body, Form

# --- AI credits consume (used by Grok/Puter tools) ---
@app.post("/api/ai/consume")
def api_ai_consume(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    kind = str(payload.get("kind") or "ai")
    amount = int(payload.get("amount") or 1)
    amount = max(1, min(amount, 10))

    limits = get_user_limits(int(u["id"]))
    if limits.get("premium"):
        return {"ok": True, "premium": True}

    if kind in ("analyze", "analysis"):
        if int(limits.get("credits_analyze") or 0) < amount:
            raise HTTPException(status_code=403, detail="No analyze credits")
        spend_credit(int(u["id"]), "credits_analyze", amount)
    else:
        if int(limits.get("credits_ai") or 0) < amount:
            raise HTTPException(status_code=403, detail="No AI credits")
        spend_credit(int(u["id"]), "credits_ai", amount)

    return {"ok": True, "premium": False}

from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jose import jwt, JWTError

# Stripe (real payments)
try:
    import stripe
except Exception:
    stripe = None

# Crypto (cookie encryption)
try:
    from cryptography.fernet import Fernet, InvalidToken
except Exception:
    Fernet = None
    class InvalidToken(Exception):
        pass

# ----------------------------
# Config
# ----------------------------
DEFAULT_TIMEOUT = 30

BUILD_TAG = os.environ.get("BUILD_TAG") or "fix94"
BUILD_VERSION = os.environ.get("BUILD_VERSION") or f"{BUILD_TAG}-{int(time.time())}"

# ----------------------------
# Robux shop config
# ----------------------------
# Minimum order in Robux
ROBUX_MIN_AMOUNT = int(os.environ.get("ROBUX_MIN_AMOUNT", "50"))
# Site balance currency (points) per 1 Robux. Default: 0.5 RUB per 1 Robux.
ROBUX_RUB_PER_ROBUX = float(os.environ.get("ROBUX_RUB_PER_ROBUX", "0.5"))
# Factor to compensate Roblox fee (approx 30%): price = ceil(amount * 1.43)
ROBUX_GP_FACTOR = float(os.environ.get("ROBUX_GP_FACTOR", "1.43"))

# Seller cookie is configured via env ROBLOX_SELLER_COOKIE (preferred) or via Admin settings in DB.

# Auth / DB
# Persistent storage — SQLite lives here.
# Railway: Dashboard → your service → Volumes → Add Volume → mount at /data
# Render:  render.yaml disk mountPath: /data  (already configured)
# Without DATABASE_URL (Postgres), ALL data lives in this file — it MUST be on a volume.
DB_PATH = os.environ.get("DB_PATH", "/data/data.db")

# Always ensure the directory exists (works both with and without a real volume)
try:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
except OSError:
    pass
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")


def _fernet_from_secret() -> "Fernet|None":
    """Derive a stable Fernet key from SECRET_KEY.
    If cryptography isn't available, returns None and we store cookies in plaintext (not recommended).
    """
    try:
        if not Fernet:
            return None
        sk = (SECRET_KEY or "").encode("utf-8")
        if not sk:
            return None
        digest = hashlib.sha256(sk).digest()
        key = base64.urlsafe_b64encode(digest)
        return Fernet(key)
    except Exception:
        return None

_FERNET = None
def _cookie_encrypt(raw_cookie: str) -> str:
    raw_cookie = (raw_cookie or "").strip()
    if not raw_cookie:
        return ""
    global _FERNET
    if _FERNET is None:
        _FERNET = _fernet_from_secret()
    if _FERNET is None:
        # Fallback (dev-only): store plaintext
        return raw_cookie
    return _FERNET.encrypt(raw_cookie.encode("utf-8")).decode("utf-8")

def _cookie_decrypt(enc_cookie: str) -> str:
    enc_cookie = (enc_cookie or "").strip()
    if not enc_cookie:
        return ""
    global _FERNET
    if _FERNET is None:
        _FERNET = _fernet_from_secret()
    if _FERNET is None:
        return enc_cookie
    try:
        return _FERNET.decrypt(enc_cookie.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        # maybe stored plaintext earlier
        return enc_cookie

def _mask_cookie(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    return "••••" + (s[-6:] if len(s) >= 6 else "")
JWT_ALG = "HS256"
SESSION_COOKIE = "rst_session"
PBKDF2_ITERS = int(os.environ.get('PBKDF2_ITERS', '200000'))


# Admins (comma-separated usernames in env)
ADMIN_USERS_RAW = os.environ.get("ADMIN_USERS", "")
ADMIN_USERS = [u.strip() for u in ADMIN_USERS_RAW.split(",") if u.strip()]
ADMIN_USERS_LC = {u.lower() for u in ADMIN_USERS}

"""Dev-lock removed.

Earlier builds included optional 'DEV_LOCK' private gate.
The feature is removed (it caused issues and is not needed in production).
"""




# ----------------------------
# Topups (Crypto Pay + Promo + Manual) + Premium by balance
# ----------------------------

def _points_to_fiat_cents(points: int) -> int:
    cents = int(round((int(points) / float(max(BALANCE_PER_CURRENCY, 1))) * 100.0))
    if cents < CRYPTO_PAY_MIN_FIAT_CENTS:
        cents = CRYPTO_PAY_MIN_FIAT_CENTS
    return max(1, cents)

def _cents_to_amount_str(cents: int) -> str:
    return f"{(int(cents) / 100.0):.2f}"

def _insert_topup_row(con, user_id: int, provider: str, method: str, points: int, fiat_cents: int, fiat_currency: str, status: str, meta: Dict[str, Any]) -> int:
    ts = _now_utc_iso()
    if USE_PG:
        row = con.execute(
            "INSERT INTO topups(user_id,provider,method,points,fiat_cents,fiat_currency,invoice_id,pay_url,status,credited,meta,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
            (int(user_id), provider, method, int(points), int(fiat_cents), fiat_currency or None, None, None, status, 0, json.dumps(meta or {}), ts, ts),
        ).fetchone()
        return int(_rget(row, "id") or 0)
    cur = con.execute(
        "INSERT INTO topups(user_id,provider,method,points,fiat_cents,fiat_currency,invoice_id,pay_url,status,credited,meta,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (int(user_id), provider, method, int(points), int(fiat_cents), fiat_currency, None, None, status, 0, json.dumps(meta or {}), ts, ts),
    )
    return int(cur.lastrowid)



def _insert_premium_order_row(con, user_id: int, provider: str, plan_id: str, days: int, price_rub: int, fiat_cents: int, fiat_currency: str, status: str, meta: Dict[str, Any]) -> int:
    ts = _now_utc_iso()
    if USE_PG:
        row = con.execute(
            "INSERT INTO premium_orders(user_id,provider,plan_id,days,price_rub,fiat_cents,fiat_currency,invoice_id,pay_url,status,applied,meta,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
            (int(user_id), provider, str(plan_id), int(days), int(price_rub), int(fiat_cents), fiat_currency or None, None, None, status, 0, json.dumps(meta or {}), ts, ts),
        ).fetchone()
        return int(_rget(row, "id") or 0)
    cur = con.execute(
        "INSERT INTO premium_orders(user_id,provider,plan_id,days,price_rub,fiat_cents,fiat_currency,invoice_id,pay_url,status,applied,meta,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (int(user_id), provider, str(plan_id), int(days), int(price_rub), int(fiat_cents), fiat_currency, None, None, status, 0, json.dumps(meta or {}), ts, ts),
    )
    return int(cur.lastrowid)

def _credit_balance_direct(con, user_id: int, delta: int, reason: str, admin_id: Optional[int] = None) -> int:
    """
    Directly credit or debit user balance. Returns new balance.
    Uses atomic UPDATE and records in balance_tx.
    Works with both SQLite and Postgres.
    delta can be positive (credit) or negative (debit).
    """
    ts = _now_utc_iso()
    uid = int(user_id)
    d = int(delta)
    
    if USE_PG:
        # Postgres: atomic update returning new balance
        row = con.execute(
            "UPDATE users SET balance = GREATEST(0, balance + ?) WHERE id = ? RETURNING balance",
            (d, uid),
        ).fetchone()
        new_bal = int(_rget(row, "balance") or 0) if row else 0
    else:
        # SQLite: atomic update (CASE WHEN to prevent negative)
        if d >= 0:
            con.execute("UPDATE users SET balance = balance + ? WHERE id = ?", (d, uid))
        else:
            con.execute("UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?", (d, uid))
        row = con.execute("SELECT balance FROM users WHERE id = ?", (uid,)).fetchone()
        new_bal = int(_rget(row, "balance") or 0) if row else 0
    
    # Record transaction
    actual_delta = d  # for credits; for debits track actual applied
    try:
        con.execute(
            "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
            (uid, admin_id, actual_delta, reason[:255] if reason else "", ts),
        )
    except Exception:
        pass
    return new_bal


def _get_user_balance_reliable(con, user_id: int) -> int:
    """
    Return the best available balance for a user.
    Uses users.balance (updated atomically by _credit_balance_direct).
    If it's 0, cross-checks balance_tx to catch DB inconsistencies.
    """
    uid = int(user_id)
    row = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        return 0
    bal_col = int(_rget(row, "balance") or 0)
    if bal_col > 0:
        return bal_col
    # Column is 0 — check if transactions suggest otherwise
    try:
        tx_row = con.execute(
            "SELECT COALESCE(SUM(delta), 0) as s FROM balance_tx WHERE user_id=?", (uid,)
        ).fetchone()
        bal_tx = max(0, int(_rget(tx_row, "s") or 0))
        if bal_tx > bal_col:
            # Repair: restore correct balance from tx history
            con.execute("UPDATE users SET balance=? WHERE id=?", (bal_tx, uid))
            try:
                con.commit()
            except Exception:
                pass
            return bal_tx
    except Exception:
        pass
    return bal_col


def _ensure_purchases_table(con):
    """Create user_purchases table if not exists (lazy migration)."""
    try:
        if USE_PG:
            con.execute("""
                CREATE TABLE IF NOT EXISTS user_purchases(
                  id SERIAL PRIMARY KEY,
                  user_id INTEGER NOT NULL,
                  product_id TEXT NOT NULL,
                  product_title TEXT NOT NULL DEFAULT '',
                  item_type TEXT NOT NULL DEFAULT 'digital',
                  delivery_json TEXT NOT NULL DEFAULT '{}',
                  price INTEGER NOT NULL DEFAULT 0,
                  note TEXT DEFAULT '',
                  ts TEXT NOT NULL
                )
            """)
        else:
            con.execute("""
                CREATE TABLE IF NOT EXISTS user_purchases(
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER NOT NULL,
                  product_id TEXT NOT NULL,
                  product_title TEXT NOT NULL DEFAULT '',
                  item_type TEXT NOT NULL DEFAULT 'digital',
                  delivery_json TEXT NOT NULL DEFAULT '{}',
                  price INTEGER NOT NULL DEFAULT 0,
                  note TEXT DEFAULT '',
                  ts TEXT NOT NULL
                )
            """)
    except Exception:
        pass

def _credit_topup_once(con, topup_id: int, admin_id: Optional[int] = None, reason: str = "") -> bool:
    # Returns True if balance was credited by this call (idempotent)
    ts = _now_utc_iso()
    if USE_PG:
        row = con.execute(
            "UPDATE topups SET credited=1, status='paid', updated_at=? WHERE id=? AND credited=0 RETURNING user_id, points",
            (ts, int(topup_id)),
        ).fetchone()
        if not row:
            return False
        uid = int(_rget(row, "user_id") or 0)
        points = int(_rget(row, "points") or 0)
        # Atomic increment — avoids read-modify-write race when multiple
        # webhooks for the same user arrive concurrently.
        con.execute("UPDATE users SET balance = balance + ? WHERE id=?", (points, uid))
        con.execute(
            "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
            (uid, admin_id, points, reason or f"topup {topup_id}", ts),
        )
        return True

    cur = con.execute(
        "UPDATE topups SET credited=1, status='paid', updated_at=? WHERE id=? AND credited=0",
        (ts, int(topup_id)),
    )
    if getattr(cur, "rowcount", 0) != 1:
        return False
    row = con.execute("SELECT user_id, points FROM topups WHERE id=?", (int(topup_id),)).fetchone()
    uid = int(_rget(row, "user_id") or 0)
    points = int(_rget(row, "points") or 0)
    # Atomic increment — see PG branch above.
    con.execute("UPDATE users SET balance = balance + ? WHERE id=?", (points, uid))
    con.execute(
        "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
        (uid, admin_id, points, reason or f"topup {topup_id}", ts),
    )
    return True


def _email_html(title: str, body_html: str, subtitle: str = "", cta_text: str = "", cta_url: str = "") -> str:
    """Generate beautiful dark-themed HTML email."""
    cta_block = ""
    if cta_text and cta_url:
        cta_block = f"""<tr><td align="center" style="padding:28px 0 8px">
          <a href="{cta_url}" style="background:linear-gradient(135deg,#9333ea,#7c3aed);color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;letter-spacing:0.3px;box-shadow:0 4px 20px rgba(147,51,234,0.35)">{cta_text}</a>
        </td></tr>"""

    return f"""<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
  @media only screen and (max-width:600px) {{
    .email-body {{ padding: 24px 20px !important; }}
    .email-outer {{ padding: 16px 8px !important; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table width="100%" cellpadding="0" cellspacing="0" class="email-outer" style="background:#0a0a0f;padding:40px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.6)">

        <!-- Logo Header -->
        <tr><td style="background:linear-gradient(135deg,#1a0828 0%,#2e1060 50%,#1a082e 100%);padding:36px 40px;text-align:center;border-bottom:2px solid rgba(147,51,234,0.4)">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td align="center">
              <div style="display:inline-block;background:rgba(147,51,234,0.15);border:1px solid rgba(192,132,252,0.25);border-radius:12px;padding:8px 20px;margin-bottom:12px">
                <span style="font-size:24px;font-weight:900;color:#fff;letter-spacing:-0.5px"><span style="color:#c084fc">RBX</span> ST</span>
              </div>
              <div style="color:#7c5fa0;font-size:11px;letter-spacing:2px;text-transform:uppercase">Автоматическое уведомление</div>
            </td>
          </tr></table>
        </td></tr>

        <!-- Title band -->
        <tr><td style="background:linear-gradient(90deg,rgba(147,51,234,0.18),rgba(109,40,217,0.08));padding:20px 40px;border-bottom:1px solid rgba(147,51,234,0.12)">
          <h1 style="margin:0;font-size:20px;font-weight:800;color:#f0ecff;letter-spacing:-0.3px">{title}</h1>
          {(f'<p style="margin:6px 0 0;color:#8878a8;font-size:13px;line-height:1.6">{subtitle}</p>') if subtitle else ''}
        </td></tr>

        <!-- Body -->
        <tr><td class="email-body" style="background:#12101c;padding:36px 40px">
          {body_html}
          {cta_block}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#0c0a14;padding:22px 40px;text-align:center;border-top:1px solid rgba(147,51,234,0.1)">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td align="center">
              <p style="margin:0 0 6px;color:#3d3660;font-size:12px">Это письмо отправлено автоматически — не отвечайте на него</p>
              <p style="margin:0;color:#2d2550;font-size:11px">&copy; 2026 <a href="https://rbx-st.win" style="color:#6b4fa0;text-decoration:none">RBX - Shop | Tools</a> · rbx-st.win</p>
            </td>
          </tr></table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>"""


def _email_code_block(code: str) -> str:
    """Big centered OTP code block."""
    return f"""<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">
    <tr><td align="center" style="background:linear-gradient(135deg,rgba(147,51,234,0.14),rgba(109,40,217,0.08));border:2px solid rgba(147,51,234,0.3);border-radius:16px;padding:28px 24px">
      <div style="font-size:44px;font-weight:900;letter-spacing:12px;color:#c084fc;font-family:'Courier New',monospace;text-shadow:0 0 20px rgba(192,132,252,0.4)">{code}</div>
      <div style="margin-top:10px">
        <span style="display:inline-block;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:6px;padding:4px 10px;font-size:11px;color:#f87171">🔒 Никому не сообщайте этот код</span>
      </div>
    </td></tr>
  </table>"""


def _email_info_table(rows: list) -> str:
    """Key-value info table for delivery emails."""
    rows_html = "".join(
        f"""<tr>
      <td style="padding:12px 16px;background:rgba(147,51,234,0.06);color:#8878a8;font-size:12px;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,0.05);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:30%">{k}</td>
      <td style="padding:12px 16px;background:rgba(0,0,0,0.2);color:#f0ecff;font-size:13px;font-weight:700;font-family:'Courier New',monospace;border-bottom:1px solid rgba(255,255,255,0.05);word-break:break-all">{v}</td>
    </tr>"""
        for k, v in rows
    )
    return f"""<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(147,51,234,0.2);border-radius:12px;overflow:hidden;margin:20px 0;box-shadow:0 2px 12px rgba(0,0,0,0.3)">
    {rows_html}
  </table>"""


def _email_delivery_account(login: str, password: str, email_addr: str = "", extra: str = "") -> str:
    """Styled account delivery block for emails."""
    rows = []
    if login: rows.append(("👤 Логин", login))
    if password: rows.append(("🔑 Пароль", password))
    if email_addr: rows.append(("📧 Email", email_addr))
    if extra: rows.append(("ℹ️ Доп. инфо", extra))
    table = _email_info_table(rows)
    return f"""<div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.15);border-radius:12px;padding:16px 20px;margin:16px 0">
      <div style="font-size:13px;font-weight:700;color:#4ade80;margin-bottom:12px">✅ Данные аккаунта</div>
      {table}
      <div style="margin-top:10px;padding:8px 12px;background:rgba(239,68,68,0.08);border-radius:8px;font-size:12px;color:#f87171">
        ⚠️ Сохраните данные — они показываются <strong>один раз</strong>. Смените пароль сразу после входа.
      </div>
    </div>"""


@app.get("/api/topup/config")
def api_topup_config(request: Request):
    return {
        "ok": True,
        "topup": {
            "packs": TOPUP_PACKS,
            "balance_per_currency": BALANCE_PER_CURRENCY,
            "crypto": {
                "enabled": cryptopay_enabled(),
                "fiat": CRYPTO_PAY_FIAT,
                "accepted_assets": ",".join(CRYPTO_PAY_ACCEPTED_ASSETS) if isinstance(CRYPTO_PAY_ACCEPTED_ASSETS, (list,tuple)) else CRYPTO_PAY_ACCEPTED_ASSETS,
                "min_fiat_cents": CRYPTO_PAY_MIN_FIAT_CENTS,
            },
            "robokassa": { "enabled": False },
            "promo": {"enabled": True},
            "manual": {"enabled": True},
        },
        "premium": {
            "price_points": PREMIUM_PRICE_POINTS,
            "period_days": PREMIUM_PERIOD_DAYS,
        },
    }

@app.post("/api/topup/create")
def api_topup_create(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    method = str(payload.get("method") or "").strip().lower()
    if method == "cryptobot":
        method = "crypto"

    # Support both classic points-packs and arbitrary RUB amount top-ups
    try:
        points = int(payload.get("points") or 0)
    except Exception:
        points = 0
    try:
        amount_rub = int(payload.get("amount") or payload.get("amount_rub") or 0)
    except Exception:
        amount_rub = 0

    if amount_rub > 0 and points <= 0:
        points = amount_rub * BALANCE_PER_CURRENCY

    if points <= 0:
        raise HTTPException(status_code=400, detail="Invalid amount")

    # If user passed a custom amount, allow any points value; otherwise restrict to packs
    if amount_rub <= 0 and points not in TOPUP_PACKS:
        raise HTTPException(status_code=400, detail=f"Invalid pack. Allowed: {TOPUP_PACKS}")

    if method not in ("crypto", "manual"):  # only crypto/manual supported
        raise HTTPException(status_code=400, detail="method must be crypto, robokassa or manual")

    con = db_conn()

    if method == "manual":
        tid = _insert_topup_row(con, int(u["id"]), "manual", "manual", points, 0, None, "pending", {"note": "manual topup request"})
        con.commit(); con.close()
        return {"ok": True, "id": tid, "status": "pending", "method": "manual"}



    if method == "robokassa":
        if not robokassa_enabled():
            con.close()
            raise HTTPException(status_code=500, detail="Робокасса не настроена (ROBOKASSA_LOGIN, ROBOKASSA_PASS1)")
        fiat_rub = amount_rub if amount_rub > 0 else max(1, int(round(points / max(BALANCE_PER_CURRENCY, 1))))
        fiat_cents = fiat_rub * 100
        tid = _insert_topup_row(con, int(u["id"]), "robokassa", "robokassa", points, fiat_cents, "RUB", "pending", {})
        con.commit()
        try:
            import hashlib as _hl_rk
            # Robokassa payment URL generation
            out_sum = f"{fiat_rub}.00"
            inv_id = str(tid)
            # Signature: login:sum:invId:pass1
            sig_str = f"{ROBOKASSA_LOGIN}:{out_sum}:{inv_id}:{ROBOKASSA_PASS1}"
            sig = _hl_rk.md5(sig_str.encode()).hexdigest()
            is_test = "&IsTest=1" if ROBOKASSA_TEST else ""
            pay_url = f"https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin={ROBOKASSA_LOGIN}&OutSum={out_sum}&InvId={inv_id}&Description=Пополнение+RBX+ST&SignatureValue={sig}&Culture=ru{is_test}"
            ts = _now_utc_iso()
            con2 = db_conn()
            con2.execute("UPDATE topups SET invoice_id=?, pay_url=?, meta=?, updated_at=? WHERE id=?",
                         (inv_id, pay_url, json.dumps({"robokassa_inv": inv_id}), ts, tid))
            con2.commit(); con2.close()
            return {"ok": True, "id": tid, "pay_url": pay_url, "status": "pending", "method": "robokassa"}
        except Exception as e:
            con2 = db_conn()
            con2.execute("UPDATE topups SET status='failed', updated_at=? WHERE id=?", (_now_utc_iso(), tid))
            con2.commit(); con2.close()
            raise HTTPException(status_code=502, detail=f"Робокасса ошибка: {str(e)[:200]}")

    # crypto
    if not cryptopay_enabled():
        con.close()
        raise HTTPException(status_code=500, detail="Crypto Pay is not configured")

    # Always work in RUB internally, convert to CryptoPay fiat if needed
    rub_amount = amount_rub if amount_rub > 0 else max(1, int(round(points / max(BALANCE_PER_CURRENCY, 1))))
    if CRYPTO_PAY_FIAT == "RUB":
        fiat_cents = rub_amount * 100
    else:
        # Convert RUB → target fiat using exchangerate-api
        try:
            import httpx as _hx
            _r = _hx.get(f"https://api.exchangerate-api.com/v4/latest/RUB", timeout=5)
            _rates = _r.json().get("rates", {})
            _rate = float(_rates.get(CRYPTO_PAY_FIAT, 0))
            if _rate <= 0:
                raise ValueError(f"No rate for {CRYPTO_PAY_FIAT}")
            fiat_cents = max(1, int(round(rub_amount * _rate * 100)))
        except Exception as _e:
            con.close()
            raise HTTPException(status_code=502, detail=f"Не удалось конвертировать валюту: {str(_e)[:100]}")
    tid = _insert_topup_row(con, int(u["id"]), "cryptopay", "crypto", points, fiat_cents, CRYPTO_PAY_FIAT, "pending", {"assets": CRYPTO_PAY_ACCEPTED_ASSETS, "amount_rub": rub_amount})
    # Create invoice
    amount_str = _cents_to_amount_str(fiat_cents)
    desc = f"RST Balance Top-up ({rub_amount} RUB)"
    # accepted_assets can be a list/tuple or a comma-separated string depending on env/config
    aa = CRYPTO_PAY_ACCEPTED_ASSETS
    accepted_assets = None
    if aa:
        if isinstance(aa, (list, tuple, set)):
            accepted_assets = ",".join([str(x).strip() for x in aa if str(x).strip()])
        else:
            accepted_assets = str(aa).strip()
    try:
        inv = _cryptopay_call("createInvoice", {
            "amount": amount_str,
            "currency_type": "fiat",
            "fiat": CRYPTO_PAY_FIAT,
            "accepted_assets": accepted_assets,
            "description": desc,
            "payload": f"topup:{tid}",
            "allow_comments": False,
            "allow_anonymous": True,
        })
    except Exception as e:
        # mark failed
        ts = _now_utc_iso()
        # mark failed; keep a short error for debugging
        con.execute("UPDATE topups SET status=?, meta=?, updated_at=? WHERE id=?", ("failed", json.dumps({"err": str(e)[:400]}), ts, tid))
        con.commit(); con.close()
        # propagate HTTPException as-is; wrap unknown exceptions
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=502, detail=f"Crypto Pay createInvoice failed: {type(e).__name__}")

    invoice_id = str(inv.get("invoice_id") or inv.get("id") or "")
    pay_url = inv.get("bot_invoice_url") or inv.get("mini_app_invoice_url") or inv.get("web_app_invoice_url") or inv.get("pay_url") or ""
    ts = _now_utc_iso()
    con.execute("UPDATE topups SET invoice_id=?, pay_url=?, updated_at=? WHERE id=?", (invoice_id, pay_url, ts, tid))
    con.commit(); con.close()

    return {"ok": True, "id": tid, "invoice_id": invoice_id, "pay_url": pay_url, "status": "pending", "method": "crypto", "fiat": CRYPTO_PAY_FIAT, "fiat_amount": amount_str}

@app.get("/api/topup/status")
def api_topup_status(request: Request, id: int):
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT * FROM topups WHERE id=? AND user_id=?", (int(id), int(u["id"]))).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Topup not found")

    status = str(_rget(row, "status") or "")
    provider = str(_rget(row, "provider") or "")
    invoice_id = str(_rget(row, "invoice_id") or "")
    pay_url = str(_rget(row, "pay_url") or "")
    points = int(_rget(row, "points") or 0)

    if provider == "cryptopay" and status in ("pending", "active") and invoice_id and cryptopay_enabled():
        try:
            invs = _cryptopay_call("getInvoices", {"invoice_ids": invoice_id})
            items = invs.get("items") if isinstance(invs, dict) else None
            inv = (items[0] if items else None) or {}
            inv_status = str(inv.get("status") or "")
            if inv_status and inv_status != status:
                ts = _now_utc_iso()
                con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=?", (inv_status, ts, int(id)))
                status = inv_status
            if inv_status == "paid":
                credited = _credit_topup_once(con, int(id), None, f"cryptopay invoice {invoice_id}")
                if credited:
                    con.commit()
                    # refresh status
                    status = "paid"
        except Exception:
            pass

    con.commit()
    con.close()
    credited_flag = status == "paid"
    return {"ok": True, "id": int(id), "status": status, "pay_url": pay_url, "points": points, "credited": credited_flag}

@app.get("/api/topup/my")
def api_topup_my(request: Request, limit: int = 20):
    u = require_user(request)
    limit = max(1, min(int(limit or 20), 50))
    con = db_conn()
    rows = con.execute(
        "SELECT id, provider, method, points, fiat_cents, fiat_currency, status, pay_url, created_at, updated_at FROM topups WHERE user_id=? ORDER BY id DESC LIMIT ?",
        (int(u["id"]), limit),
    ).fetchall()
    con.close()
    out = []
    for r in rows or []:
        out.append({
            "id": int(_rget(r, "id") or 0),
            "provider": str(_rget(r, "provider") or ""),
            "method": str(_rget(r, "method") or ""),
            "points": int(_rget(r, "points") or 0),
            "fiat_cents": int(_rget(r, "fiat_cents") or 0),
            "fiat_currency": str(_rget(r, "fiat_currency") or ""),
            "status": str(_rget(r, "status") or ""),
            "pay_url": str(_rget(r, "pay_url") or ""),
            "created_at": str(_rget(r, "created_at") or ""),
        })
    return {"ok": True, "items": out}

@app.post("/api/topup/redeem")
def api_topup_redeem(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    code = str(payload.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="code required")
    con = db_conn()
    row = con.execute("SELECT code, points, max_uses, uses, active FROM promo_codes WHERE code=?", (code,)).fetchone()
    if not row or not int(_rget(row, "active") or 0):
        con.close()
        raise HTTPException(status_code=404, detail="Промокод не найден или неактивен")

    max_uses = int(_rget(row, "max_uses") or 1)
    uses = int(_rget(row, "uses") or 0)
    points = int(_rget(row, "points") or 0)
    if uses >= max_uses:
        con.close()
        raise HTTPException(status_code=400, detail="Promo code already used up")

    # Ensure not redeemed by this user
    already = con.execute("SELECT id FROM promo_redemptions WHERE code=? AND user_id=?", (code, int(u["id"]))).fetchone()
    if already:
        con.close()
        raise HTTPException(status_code=400, detail="Promo code already redeemed")

    ts = _now_utc_iso()
    # apply
    con.execute("INSERT INTO promo_redemptions(code, user_id, redeemed_at) VALUES(?,?,?)", (code, int(u["id"]), ts))
    con.execute("UPDATE promo_codes SET uses=uses+1 WHERE code=?", (code,))
    # credit balance atomically
    new_bal = _credit_balance_direct(con, int(u["id"]), points, f"promo {code}")
    con.commit()
    con.close()
    return {"ok": True, "credited": points, "new_balance": new_bal}

@app.post("/api/subscription/buy")
def api_subscription_buy(request: Request, payload: Dict[str, Any] = None):
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT balance, premium_until FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=400, detail="Пользователь не найден. Попробуйте перезайти в аккаунт.")
    bal = _get_user_balance_reliable(con, int(u["id"]))
    if bal < PREMIUM_PRICE_POINTS:
        con.close()
        raise HTTPException(status_code=402, detail=f"Недостаточно средств. Нужно {PREMIUM_PRICE_POINTS} ₽, у вас {bal} ₽")

    now = _now_utc()
    cur_pu = _parse_iso(_rget(row, "premium_until") or "")
    base = cur_pu if (cur_pu and cur_pu > now) else now
    new_until = (base + datetime.timedelta(days=PREMIUM_PERIOD_DAYS)).isoformat()

    ts = _now_utc_iso()
    _credit_balance_direct(con, int(u["id"]), -PREMIUM_PRICE_POINTS, "premium buy")
    con.execute("UPDATE users SET premium_until=? WHERE id=?", (new_until, int(u["id"])))
    con.commit()
    con.close()
    return {"ok": True, "premium_until": new_until}

# --- Premium (CryptoBot / Crypto Pay) --------------------------------

@app.get("/api/premium/plans")
def api_premium_plans(request: Request):
    """List available Premium plans (RUB prices)."""
    require_user(request)
    return {"ok": True, "plans": PREMIUM_PLANS_RUB, "fiat": CRYPTO_PAY_FIAT, "cryptopay_enabled": cryptopay_enabled()}

@app.post("/api/premium/create")
def api_premium_create(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    if not cryptopay_enabled():
        raise HTTPException(status_code=500, detail="Crypto Pay is not configured")
    plan = _get_premium_plan(str(payload.get("plan_id") or ""))
    days = int(plan.get("days") or 0)
    price_rub = int(plan.get("price_rub") or 0)
    if days <= 0 or price_rub <= 0:
        raise HTTPException(status_code=400, detail="Invalid plan")

    con = db_conn()
    oid = _insert_premium_order_row(
        con,
        int(u["id"]),
        "cryptopay",
        str(plan.get("id")),
        days,
        price_rub,
        premium_fiat_cents if CRYPTO_PAY_FIAT != "RUB" else price_rub * 100,
        CRYPTO_PAY_FIAT,
        "pending",
        {"plan": plan},
    )

    # Convert RUB price to CryptoPay fiat
    if CRYPTO_PAY_FIAT == "RUB":
        premium_fiat_cents = price_rub * 100
    else:
        try:
            import httpx as _hx2
            _r2 = _hx2.get(f"https://api.exchangerate-api.com/v4/latest/RUB", timeout=5)
            _rates2 = _r2.json().get("rates", {})
            _rate2 = float(_rates2.get(CRYPTO_PAY_FIAT, 0))
            if _rate2 <= 0:
                raise ValueError(f"No rate for {CRYPTO_PAY_FIAT}")
            premium_fiat_cents = max(1, int(round(price_rub * _rate2 * 100)))
        except Exception as _e2:
            raise HTTPException(status_code=502, detail=f"Не удалось конвертировать валюту: {str(_e2)[:100]}")
    amount_str = _cents_to_amount_str(premium_fiat_cents)
    desc = f"Premium {plan.get('label')} ({days}d) — {price_rub} RUB"
    inv = _cryptopay_call(
        "createInvoice",
        {
            "amount": amount_str,
            "currency_type": "fiat",
            "fiat": CRYPTO_PAY_FIAT,
            "accepted_assets": ",".join(CRYPTO_PAY_ACCEPTED_ASSETS) if isinstance(CRYPTO_PAY_ACCEPTED_ASSETS, (list,tuple)) else CRYPTO_PAY_ACCEPTED_ASSETS,
            "description": desc,
            "payload": f"premium:{oid}",
            "allow_comments": False,
            "allow_anonymous": True,
        },
    )
    invoice_id = str(inv.get("invoice_id") or inv.get("id") or "")
    pay_url = str(inv.get("bot_invoice_url") or inv.get("mini_app_invoice_url") or inv.get("web_app_invoice_url") or inv.get("pay_url") or "")
    ts = _now_utc_iso()
    con.execute(
        "UPDATE premium_orders SET invoice_id=?, pay_url=?, status=?, updated_at=? WHERE id=?",
        (invoice_id or None, pay_url or None, "pending", ts, int(oid)),
    )
    con.commit()
    con.close()
    return {
        "ok": True,
        "order_id": int(oid),
        "invoice_id": invoice_id,
        "pay_url": pay_url,
        "plan": plan,
        "amount": amount_str,
        "fiat": CRYPTO_PAY_FIAT,
    }

@app.post("/api/premium/sync")
def api_premium_sync(request: Request):
    u = require_user(request)
    if not cryptopay_enabled():
        return {"ok": True, "synced": 0, "premium": False}

    con = db_conn()
    rows = con.execute(
        "SELECT id, invoice_id, status, days, applied FROM premium_orders WHERE user_id=? AND provider='cryptopay' AND status IN ('pending','active','paid') ORDER BY id DESC LIMIT 10",
        (int(u["id"]),),
    ).fetchall()

    synced = 0
    for r in rows or []:
        oid = int(_rget(r, "id") or 0)
        invoice_id = str(_rget(r, "invoice_id") or "")
        status = str(_rget(r, "status") or "")
        applied = int(_rget(r, "applied") or 0)
        days = int(_rget(r, "days") or 0)
        if applied or not invoice_id or status not in ("pending", "active"):
            continue
        try:
            invs = _cryptopay_call("getInvoices", {"invoice_ids": invoice_id})
            items = invs.get("items") if isinstance(invs, dict) else None
            inv = (items[0] if items else None) or {}
            inv_status = str(inv.get("status") or "")
            if inv_status and inv_status != status:
                con.execute("UPDATE premium_orders SET status=?, updated_at=? WHERE id=?", (inv_status, _now_utc_iso(), oid))
                status = inv_status
            if inv_status == "paid":
                _apply_premium(int(u["id"]), datetime.timedelta(days=days))
                con.execute("UPDATE premium_orders SET applied=1, status='paid', updated_at=? WHERE id=?", (_now_utc_iso(), oid))
                synced += 1
        except Exception:
            continue

    con.commit()
    con.close()
    return {"ok": True, "synced": synced}


@app.get("/api/premium/status")
def api_premium_status(request: Request, id: int):
    u = require_user(request)
    oid = int(id or 0)
    if oid <= 0:
        raise HTTPException(status_code=400, detail="Invalid id")
    con = db_conn()
    row = con.execute(
        "SELECT id, status, pay_url, invoice_id, days, price_rub, created_at, updated_at, applied FROM premium_orders WHERE id=? AND user_id=?",
        (oid, int(u["id"])),
    ).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    return {
        "ok": True,
        "id": int(_rget(row, "id") or 0),
        "status": str(_rget(row, "status") or ""),
        "pay_url": str(_rget(row, "pay_url") or ""),
        "invoice_id": str(_rget(row, "invoice_id") or ""),
        "days": int(_rget(row, "days") or 0),
        "price_rub": int(_rget(row, "price_rub") or 0),
        "applied": int(_rget(row, "applied") or 0),
        "created_at": str(_rget(row, "created_at") or ""),
        "updated_at": str(_rget(row, "updated_at") or ""),
    }

@app.get("/api/admin/topups")

def api_admin_topups(request: Request, status: str = "pending", limit: int = 50):
    admin = require_admin(request)
    status = str(status or "pending")
    limit = max(1, min(int(limit or 50), 200))
    con = db_conn()
    rows = con.execute(
        "SELECT t.id, t.user_id, u.username, t.provider, t.method, t.points, t.status, t.created_at, t.updated_at "
        "FROM topups t JOIN users u ON u.id=t.user_id WHERE t.status=? ORDER BY t.id DESC LIMIT ?",
        (status, limit),
    ).fetchall()
    con.close()
    items = []
    for r in rows or []:
        items.append({
            "id": int(_rget(r, "id") or 0),
            "user_id": int(_rget(r, "user_id") or 0),
            "username": str(_rget(r, "username") or ""),
            "provider": str(_rget(r, "provider") or ""),
            "method": str(_rget(r, "method") or ""),
            "points": int(_rget(r, "points") or 0),
            "status": str(_rget(r, "status") or ""),
            "created_at": str(_rget(r, "created_at") or ""),
        })
    return {"ok": True, "items": items}

@app.post("/api/admin/topup/approve")
def api_admin_topup_approve(request: Request, payload: Dict[str, Any]):
    admin = require_admin(request)
    try:
        tid = int(payload.get("id") or 0)
    except Exception:
        tid = 0
    if tid <= 0:
        raise HTTPException(status_code=400, detail="id required")
    reason = str(payload.get("reason") or "manual topup").strip()
    con = db_conn()
    row = con.execute("SELECT id, provider, status FROM topups WHERE id=?", (tid,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Topup not found")
    provider = str(_rget(row, "provider") or "")
    status = str(_rget(row, "status") or "")
    if provider != "manual" or status != "pending":
        con.close()
        raise HTTPException(status_code=400, detail="Only pending manual topups can be approved")
    credited = _credit_topup_once(con, tid, int(admin["id"]), reason)
    con.commit(); con.close()
    return {"ok": True, "credited": bool(credited)}

@app.post("/api/admin/topup/reject")
def api_admin_topup_reject(request: Request, payload: Dict[str, Any]):
    admin = require_admin(request)
    try:
        tid = int(payload.get("id") or 0)
    except Exception:
        tid = 0
    if tid <= 0:
        raise HTTPException(status_code=400, detail="id required")
    reason = str(payload.get("reason") or "rejected").strip()
    con = db_conn()
    row = con.execute("SELECT id, provider, status FROM topups WHERE id=?", (tid,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Topup not found")
    provider = str(_rget(row, "provider") or "")
    status = str(_rget(row, "status") or "")
    if provider != "manual" or status != "pending":
        con.close()
        raise HTTPException(status_code=400, detail="Only pending manual topups can be rejected")
    ts = _now_utc_iso()
    con.execute("UPDATE topups SET status=?, meta=?, updated_at=? WHERE id=?", ("rejected", json.dumps({"reason": reason}), ts, tid))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/admin/promo/create")
def api_admin_promo_create(request: Request, payload: Dict[str, Any]):
    admin = require_admin(request)
    try:
        amount_rub = float(payload.get("amount_rub") or payload.get("amount") or 0)
    except Exception:
        amount_rub = 0
    if amount_rub <= 0:
        raise HTTPException(status_code=400, detail="Укажи сумму в рублях")
    points = int(round(amount_rub))  # 1 point = 1 ruble
    try:
        max_uses = int(payload.get("max_uses") or 1)
    except Exception:
        max_uses = 1
    if max_uses <= 0:
        max_uses = 1
    code = str(payload.get("code") or "").strip().upper()
    if not code:
        code = secrets.token_urlsafe(8).replace("-", "").replace("_", "").upper()
    ts = _now_utc_iso()
    con = db_conn()
    try:
        con.execute(
            "INSERT INTO promo_codes(code, points, max_uses, uses, active, created_by, created_at) VALUES(?,?,?,?,?,?,?)",
            (code, points, max_uses, 0, 1, int(admin["id"]), ts),
        )
        con.commit()
    except Exception as e:
        _log.error("promo create error: %s", e)
        con.close()
        detail = "Промокод уже существует" if "unique" in str(e).lower() or "duplicate" in str(e).lower() else f"Ошибка создания: {e}"
        raise HTTPException(status_code=400, detail=detail)
    con.close()
    return {"ok": True, "code": code, "amount_rub": amount_rub, "max_uses": max_uses}

@app.post("/api/admin/promo/edit")
def api_admin_promo_edit(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    code = str(payload.get("code") or "").strip().upper()
    if not code:
        raise HTTPException(status_code=400, detail="Укажи код")
    con = db_conn()
    row = con.execute("SELECT code FROM promo_codes WHERE code=?", (code,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Промокод не найден")
    updates = []
    params = []
    if "amount_rub" in payload:
        try:
            amt = float(payload["amount_rub"])
            pts = int(round(amt))  # 1 point = 1 ruble
            updates.append("points=?")
            params.append(pts)
        except Exception:
            pass
    if "max_uses" in payload:
        try:
            updates.append("max_uses=?")
            params.append(int(payload["max_uses"]))
        except Exception:
            pass
    if updates:
        params.append(code)
        con.execute(f"UPDATE promo_codes SET {','.join(updates)} WHERE code=?", params)
        con.commit()
    con.close()
    return {"ok": True}

@app.post("/api/admin/promo/delete")
def api_admin_promo_delete(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    code = str(payload.get("code") or "").strip().upper()
    con = db_conn()
    con.execute("DELETE FROM promo_codes WHERE code=?", (code,))
    con.commit()
    con.close()
    return {"ok": True}

@app.get("/api/admin/promo/list")
def api_admin_promo_list(request: Request, limit: int = 100):
    admin = require_admin(request)
    limit = max(1, min(int(limit or 100), 500))
    con = db_conn()
    rows = con.execute("SELECT code, points, max_uses, uses, created_at FROM promo_codes ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    con.close()
    items = []
    for r in rows or []:
        pts = int(_rget(r, "points") or 0)
        rub = pts  # 1 point = 1 ruble
        items.append({
            "code": str(_rget(r, "code") or ""),
            "amount_rub": rub,
            "points": pts,
            "uses": int(_rget(r, "uses") or 0),
            "max_uses": int(_rget(r, "max_uses") or 0),
            "created_at": str(_rget(r, "created_at") or ""),
        })
    return {"ok": True, "items": items}


# ============================================
# DISCOUNT PROMO CODES (shop/robux discounts)
# ============================================

_discount_tables_ok = False
def _ensure_discount_tables():
    """Lazy-create discount tables on first use."""
    global _discount_tables_ok
    if _discount_tables_ok:
        return
    con = db_conn()
    try:
        if USE_PG:
            con.execute("CREATE TABLE IF NOT EXISTS discount_codes(code TEXT PRIMARY KEY, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value REAL NOT NULL DEFAULT 0, min_purchase REAL NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, applies_to TEXT NOT NULL DEFAULT 'all', note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT)")
            con.execute("CREATE TABLE IF NOT EXISTS discount_redemptions(id SERIAL PRIMARY KEY, code TEXT NOT NULL, user_id INTEGER NOT NULL, order_type TEXT NOT NULL DEFAULT '', discount_amount REAL NOT NULL DEFAULT 0, redeemed_at TEXT NOT NULL)")
        else:
            con.execute("CREATE TABLE IF NOT EXISTS discount_codes(code TEXT PRIMARY KEY, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value REAL NOT NULL DEFAULT 0, min_purchase REAL NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, applies_to TEXT NOT NULL DEFAULT 'all', note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT)")
            con.execute("CREATE TABLE IF NOT EXISTS discount_redemptions(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, user_id INTEGER NOT NULL, order_type TEXT NOT NULL DEFAULT '', discount_amount REAL NOT NULL DEFAULT 0, redeemed_at TEXT NOT NULL)")
        try:
            con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_user_unique ON discount_redemptions(code, user_id)")
        except Exception:
            pass
        con.commit()
        _discount_tables_ok = True
    except Exception as e:
        print(f"[DISCOUNT] table creation error: {e}", flush=True)
    finally:
        con.close()

@app.post("/api/admin/discount/create")
def api_admin_discount_create(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    _ensure_discount_tables()
    code = (payload.get("code") or "").strip().upper()
    if not code or len(code) < 3:
        raise HTTPException(status_code=400, detail="Код минимум 3 символа")
    dtype = payload.get("type", "percent")
    if dtype not in ("percent", "fixed"):
        raise HTTPException(status_code=400, detail="Тип: percent или fixed")
    dvalue = float(payload.get("value") or 0)
    if dvalue <= 0:
        raise HTTPException(status_code=400, detail="Значение > 0")
    if dtype == "percent" and dvalue > 100:
        raise HTTPException(status_code=400, detail="Макс 100%")
    max_uses = int(payload.get("max_uses") or 100)
    applies_to = payload.get("applies_to", "all")
    note = (payload.get("note") or "")[:200]
    expires_at = (payload.get("expires_at") or "")[:30] or None
    min_purchase = float(payload.get("min_purchase") or 0)
    now = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    try:
        con.execute("INSERT INTO discount_codes(code,discount_type,discount_value,min_purchase,max_uses,uses,applies_to,note,active,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?,1,?,?)",
            (code, dtype, dvalue, min_purchase, max_uses, applies_to, note, now, expires_at))
        con.commit()
    except Exception as e:
        con.close()
        raise HTTPException(status_code=400, detail=f"Ошибка: {str(e)[:100]}")
    con.close()
    return {"ok": True, "code": code}

@app.get("/api/admin/discounts")
def api_admin_discounts(request: Request):
    require_admin(request)
    _ensure_discount_tables()
    con = db_conn()
    rows = con.execute("SELECT code,discount_type,discount_value,min_purchase,max_uses,uses,applies_to,note,active,created_at,expires_at FROM discount_codes ORDER BY created_at DESC LIMIT 100").fetchall()
    con.close()
    result = []
    for r in (rows or []):
        result.append({
            "code": _rget(r, "code") or (r[0] if isinstance(r, (tuple, list)) else ""),
            "type": _rget(r, "discount_type") or (r[1] if isinstance(r, (tuple, list)) else "percent"),
            "value": float(_rget(r, "discount_value") or (r[2] if isinstance(r, (tuple, list)) else 0)),
            "min_purchase": float(_rget(r, "min_purchase") or (r[3] if isinstance(r, (tuple, list)) else 0)),
            "max_uses": int(_rget(r, "max_uses") or (r[4] if isinstance(r, (tuple, list)) else 1)),
            "uses": int(_rget(r, "uses") or (r[5] if isinstance(r, (tuple, list)) else 0)),
            "applies_to": _rget(r, "applies_to") or (r[6] if isinstance(r, (tuple, list)) else "all"),
            "note": _rget(r, "note") or (r[7] if isinstance(r, (tuple, list)) else ""),
            "active": bool(int(_rget(r, "active") or (r[8] if isinstance(r, (tuple, list)) else 1))),
            "created_at": _rget(r, "created_at") or (r[9] if isinstance(r, (tuple, list)) else ""),
            "expires_at": _rget(r, "expires_at") or (r[10] if isinstance(r, (tuple, list)) else None),
        })
    return {"ok": True, "codes": result}

@app.post("/api/admin/discount/delete")
def api_admin_discount_delete(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    _ensure_discount_tables()
    code = (payload.get("code") or "").strip().upper()
    con = db_conn()
    con.execute("DELETE FROM discount_codes WHERE code=?", (code,))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/discount/validate")
def api_discount_validate(request: Request, payload: Dict[str, Any] = Body(...)):
    """Validate a discount code."""
    u = require_user(request)
    _ensure_discount_tables()
    code = (payload.get("code") or "").strip().upper()
    order_type = payload.get("order_type", "all")
    amount = float(payload.get("amount") or 0)
    if not code: raise HTTPException(status_code=400, detail="Введите промокод")
    con = db_conn()
    row = con.execute("SELECT discount_type,discount_value,min_purchase,max_uses,uses,applies_to,active,expires_at FROM discount_codes WHERE code=?", (code,)).fetchone()
    if not row: con.close(); raise HTTPException(status_code=404, detail="Промокод не найден")
    dt = _rget(row, "discount_type") or (row[0] if isinstance(row, (tuple, list)) else "percent")
    dv = float(_rget(row, "discount_value") or (row[1] if isinstance(row, (tuple, list)) else 0))
    mp = float(_rget(row, "min_purchase") or (row[2] if isinstance(row, (tuple, list)) else 0))
    mu = int(_rget(row, "max_uses") or (row[3] if isinstance(row, (tuple, list)) else 1))
    u2 = int(_rget(row, "uses") or (row[4] if isinstance(row, (tuple, list)) else 0))
    at = _rget(row, "applies_to") or (row[5] if isinstance(row, (tuple, list)) else "all")
    act = int(_rget(row, "active") or (row[6] if isinstance(row, (tuple, list)) else 1))
    exp = _rget(row, "expires_at") or (row[7] if isinstance(row, (tuple, list)) else None)
    if not act: con.close(); raise HTTPException(status_code=400, detail="Промокод неактивен")
    if u2 >= mu: con.close(); raise HTTPException(status_code=400, detail="Промокод исчерпан")
    if exp:
        try:
            if datetime.datetime.fromisoformat(str(exp)) < datetime.datetime.utcnow(): con.close(); raise HTTPException(status_code=400, detail="Промокод истёк")
        except (ValueError, TypeError): pass
    if at != "all" and at != order_type: con.close(); raise HTTPException(status_code=400, detail=f"Только для: {at}")
    if amount > 0 and amount < mp: con.close(); raise HTTPException(status_code=400, detail=f"Мин. сумма: {mp}₽")
    already = con.execute("SELECT id FROM discount_redemptions WHERE code=? AND user_id=?", (code, int(u["id"]))).fetchone()
    con.close()
    if already: raise HTTPException(status_code=400, detail="Вы уже использовали этот код")
    disc = round(amount * dv / 100, 2) if dt == "percent" and amount > 0 else min(dv, amount) if amount > 0 else dv
    return {"ok":True,"code":code,"type":dt,"value":dv,"discount_amount":disc,"display":f"-{int(dv)}%" if dt=="percent" else f"-{int(dv)}₽","applies_to":at}

@app.post("/api/discount/apply")
def api_discount_apply(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    _ensure_discount_tables()
    code = (payload.get("code") or "").strip().upper()
    ot = payload.get("order_type", "")
    da = float(payload.get("discount_amount") or 0)
    if not code: raise HTTPException(status_code=400, detail="code required")
    con = db_conn()
    now = datetime.datetime.utcnow().isoformat()
    try:
        con.execute("INSERT INTO discount_redemptions(code,user_id,order_type,discount_amount,redeemed_at) VALUES(?,?,?,?,?)", (code, int(u["id"]), ot, da, now))
        con.execute("UPDATE discount_codes SET uses=uses+1 WHERE code=?", (code,))
        con.commit()
    except Exception: con.close(); raise HTTPException(status_code=400, detail="Промокод уже использован")
    con.close()
    return {"ok": True}


async def _cryptopay_webhook_impl(request: Request, token: Optional[str] = None):
    _log_wh = logging.getLogger("rbx.cryptopay.webhook")
    raw = await request.body()
    # Path token (optional second layer of defence): if configured, must match.
    if CRYPTO_PAY_WEBHOOK_TOKEN:
        if token is not None and token != CRYPTO_PAY_WEBHOOK_TOKEN:
            _log_wh.warning("Webhook: invalid token in path")
            raise HTTPException(status_code=403, detail="Invalid webhook token")

    # SECURITY: signature is ALWAYS required. Previously the handler had a
    # fallback "no signature → accept" branch that made it possible to credit
    # any pending topup with a forged request. Now: no header → 400.
    sig = (request.headers.get("crypto-pay-api-signature") or "").strip()
    if not sig:
        _log_wh.warning("Webhook: missing signature header, rejecting")
        raise HTTPException(status_code=400, detail="Missing Crypto Pay signature")
    if not _cryptopay_verify_signature(raw, sig):
        _log_wh.warning("Webhook: bad signature, body=%s", raw[:200])
        raise HTTPException(status_code=400, detail="Invalid Crypto Pay signature")

    try:
        data = json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    upd = str(data.get("update_type") or "")
    payload = data.get("payload") or {}
    inv_id = str(payload.get("invoice_id") or payload.get("id") or "")
    if not inv_id:
        return {"ok": True}

    if upd not in ("invoice_paid", "invoice_confirmed", "invoice_failed", "invoice_expired"):
        return {"ok": True}

    # Extract paid amount/asset reported by CryptoPay so we can cross-check it
    # against our DB record on credit.
    try:
        wh_amount = float(payload.get("amount") or 0)
    except Exception:
        wh_amount = 0.0
    wh_asset = str(payload.get("asset") or "").upper()

    con = db_conn()
    # Try to match invoice in topups or premium orders
    top = con.execute("SELECT id, status, fiat_cents, fiat_currency FROM topups WHERE provider=? AND invoice_id=?", ("cryptopay", inv_id)).fetchone()
    prem = con.execute("SELECT id, status, days, applied FROM premium_orders WHERE provider=? AND invoice_id=?", ("cryptopay", inv_id)).fetchone()
    if not top and not prem:
        con.close()
        return {"ok": True}

    ts = _now_utc_iso()

    # Failed / expired
    if upd in ("invoice_failed", "invoice_expired"):
        st = "failed" if upd == "invoice_failed" else "expired"
        if top:
            tid = int(_rget(top, "id") or 0)
            con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=?", (st, ts, tid))
        if prem:
            pid = int(_rget(prem, "id") or 0)
            con.execute("UPDATE premium_orders SET status=?, updated_at=? WHERE id=?", (st, ts, pid))
        con.commit(); con.close()
        return {"ok": True}

    # Paid / confirmed
    if top:
        tid = int(_rget(top, "id") or 0)
        # Cross-check amount: CryptoPay reports the crypto amount, our DB stores
        # fiat_cents. They are different units, so we treat fiat_currency as the
        # source of truth and only trust the webhook to confirm that *some*
        # positive amount was paid in the *same* asset/currency we asked for.
        expected_curr = str(_rget(top, "fiat_currency") or "").upper()
        if expected_curr and wh_asset and expected_curr != wh_asset:
            _log_wh.error(
                "ASSET MISMATCH topup=%s expected=%s got=%s invoice=%s",
                tid, expected_curr, wh_asset, inv_id,
            )
            con.close()
            return {"ok": False, "error": "asset mismatch"}
        if wh_amount <= 0:
            _log_wh.error("Non-positive amount in webhook for topup=%s invoice=%s", tid, inv_id)
            con.close()
            return {"ok": False, "error": "bad amount"}
        con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=?", ("paid", ts, tid))
        _credit_topup_once(con, tid, None, f"cryptopay invoice {inv_id}")

    if prem:
        pid = int(_rget(prem, "id") or 0)
        con.execute("UPDATE premium_orders SET status=?, updated_at=? WHERE id=?", ("paid", ts, pid))
        applied = int(_rget(prem, "applied") or 0)
        if applied == 0:
            # Apply premium extension once
            prow = con.execute("SELECT user_id, days FROM premium_orders WHERE id=?", (pid,)).fetchone()
            if prow:
                uid = int(_rget(prow, "user_id") or 0)
                days = int(_rget(prow, "days") or 0)
                if uid and days > 0:
                    _apply_premium(uid, datetime.timedelta(days=days))
                    con.execute("UPDATE premium_orders SET applied=1 WHERE id=?", (pid,))

    con.commit(); con.close()
    return {"ok": True}


@app.post("/api/pay/cryptopay/webhook")
async def api_cryptopay_webhook(request: Request):
    return await _cryptopay_webhook_impl(request, None)

@app.post("/api/pay/cryptopay/webhook/{token}")
async def api_cryptopay_webhook_token(request: Request, token: str):
    return await _cryptopay_webhook_impl(request, token)

# ============ CARDLINK POSTBACK ============
@app.post("/api/cardlink/postback")
async def api_cardlink_postback(request: Request):
    """Cardlink Result URL postback — auto-credit topup on SUCCESS"""
    try:
        form = await request.form()
        data = dict(form)
    except Exception:
        try:
            data = await request.json()
        except Exception:
            data = {}

    status = str(data.get("Status", "")).strip().upper()
    inv_id = str(data.get("InvId", "")).strip()
    out_sum = str(data.get("OutSum", "")).strip()
    custom = str(data.get("custom", "")).strip()
    sig = str(data.get("SignatureValue", "")).strip()

    tid = None
    if custom.startswith("topup:"):
        try: tid = int(custom.split(":")[1])
        except: pass
    if tid is None and inv_id.startswith("topup-"):
        try: tid = int(inv_id.split("-")[1])
        except: pass
    if tid is None:
        return {"ok": False, "error": "invalid order"}

    import hashlib
    expected_sig = hashlib.md5(f"{out_sum}:{inv_id}:{CARDLINK_API_TOKEN}".encode()).hexdigest().upper()
    if sig.upper() != expected_sig:
        return {"ok": False, "error": "invalid signature"}

    if status == "SUCCESS":
        con = db_conn()
        _credit_topup_once(con, tid)
        con.commit(); con.close()
    elif status == "FAIL":
        con = db_conn()
        ts = _now_utc_iso()
        con.execute("UPDATE topups SET status='failed', updated_at=? WHERE id=? AND status='pending'", (ts, tid))
        con.commit(); con.close()

    return {"ok": True}

@app.post("/api/cardlink/success")
@app.get("/api/cardlink/success")
async def api_cardlink_success(request: Request):
    from starlette.responses import RedirectResponse
    return RedirectResponse(url="/?tab=profile&topup=success", status_code=303)

@app.post("/api/cardlink/fail")
@app.get("/api/cardlink/fail")
async def api_cardlink_fail(request: Request):
    from starlette.responses import RedirectResponse
    return RedirectResponse(url="/?tab=profile&topup=fail", status_code=303)



# ============ ROBOKASSA WEBHOOK ============
@app.post("/api/robokassa/result")
@app.get("/api/robokassa/result")
async def api_robokassa_result(request: Request):
    """Robokassa Result URL — auto-credit topup"""
    import hashlib
    try:
        form = await request.form()
        data = dict(form)
    except Exception:
        data = dict(request.query_params)

    out_sum = str(data.get("OutSum", "")).strip()
    inv_id = str(data.get("InvId", "")).strip()
    sig = str(data.get("SignatureValue", "")).strip()

    tid = None
    try:
        tid = int(inv_id)
    except:
        pass
    if not tid:
        return {"ok": False, "error": "invalid InvId"}

    # Verify signature: OutSum:InvId:Pass2
    expected = hashlib.md5(f"{out_sum}:{inv_id}:{ROBOKASSA_PASS2}".encode()).hexdigest().upper()
    if sig.upper() != expected:
        return {"ok": False, "error": "invalid signature"}

    con = db_conn()
    _credit_topup_once(con, tid)
    con.commit(); con.close()

    from starlette.responses import PlainTextResponse
    return PlainTextResponse(f"OK{inv_id}")

@app.post("/api/robokassa/success")
@app.get("/api/robokassa/success")
async def api_robokassa_success(request: Request):
    from starlette.responses import RedirectResponse
    return RedirectResponse(url="/?tab=profile&topup=success", status_code=303)

@app.post("/api/robokassa/fail")
@app.get("/api/robokassa/fail")
async def api_robokassa_fail(request: Request):
    from starlette.responses import RedirectResponse
    return RedirectResponse(url="/?tab=profile&topup=fail", status_code=303)



# ----------------------------
# Payments (Stripe)
# ----------------------------
STRIPE_SECRET_KEY = (os.environ.get("STRIPE_SECRET_KEY") or "").strip()
STRIPE_WEBHOOK_SECRET = (os.environ.get("STRIPE_WEBHOOK_SECRET") or "").strip()
STRIPE_PUBLISHABLE_KEY = (os.environ.get("STRIPE_PUBLISHABLE_KEY") or "").strip()
STRIPE_CURRENCY = (os.environ.get("STRIPE_CURRENCY") or "eur").strip().lower()

# Internal balance packs (points)
TOPUP_PACKS_RAW = os.environ.get("TOPUP_PACKS", "100,300,500,1000")
try:
    TOPUP_PACKS = [int(x.strip()) for x in TOPUP_PACKS_RAW.split(",") if x.strip()]
except Exception:
    TOPUP_PACKS = [100, 300, 500, 1000]
TOPUP_PACKS = [p for p in TOPUP_PACKS if p > 0]
if not TOPUP_PACKS:
    TOPUP_PACKS = [100, 300, 500, 1000]

BALANCE_PER_CURRENCY = int(os.environ.get("BALANCE_PER_CURRENCY", "1") or 1)  # 1 point = 1 ruble
if BALANCE_PER_CURRENCY <= 0:
    BALANCE_PER_CURRENCY = 1

# Premium subscription (monthly)
STRIPE_PREMIUM_PRICE_ID = (os.environ.get("STRIPE_PREMIUM_PRICE_ID") or "").strip()
STRIPE_PREMIUM_PRICE_CENTS = int(os.environ.get("STRIPE_PREMIUM_PRICE_CENTS", "499") or 499)
if STRIPE_PREMIUM_PRICE_CENTS < 50:
    STRIPE_PREMIUM_PRICE_CENTS = 499

# ----------------------------
# Top-ups (CryptoBot / Crypto Pay) + Premium by balance
# ----------------------------
CRYPTO_PAY_TOKEN = (os.environ.get("CRYPTO_PAY_TOKEN") or os.environ.get("CRYPTOPAY_TOKEN") or "").strip()

# Auto-detect testnet: if CRYPTO_PAY_BASE_URL not set, probe both endpoints on startup
# @CryptoBot (prod):    https://pay.crypt.bot/api
_CRYPTOPAY_PROD_URL    = "https://pay.crypt.bot/api"
_CRYPTOPAY_TESTNET_URL = "https://testnet-pay.crypt.bot/api"

def _cryptopay_detect_url(token: str) -> str:
    """Return the correct base URL for the given token by calling getMe on both."""
    if not token:
        return _CRYPTOPAY_PROD_URL
    override = (os.environ.get("CRYPTO_PAY_BASE_URL") or "").strip().rstrip("/")
    if override:
        return override
    # Try prod first, then testnet
    for url in (_CRYPTOPAY_PROD_URL, _CRYPTOPAY_TESTNET_URL):
        try:
            r = requests.post(
                f"{url}/getMe",
                headers={"Crypto-Pay-API-Token": token, "Content-Type": "application/json"},
                data="{}", timeout=6,
            )
            j = r.json() if r.status_code == 200 else {}
            if j.get("ok"):
                _log_startup = logging.getLogger("rbx.startup")
                _is_testnet = "testnet" in url
                _log_startup.info("✅ CryptoPay: using %s URL (%s)", "testnet" if _is_testnet else "production", url)
                return url
        except Exception:
            continue
    return _CRYPTOPAY_PROD_URL  # fallback

import logging as _logging_for_crypto
_CRYPTO_BASE_URL_CACHE: str = ""

def _get_cryptopay_base_url() -> str:
    global _CRYPTO_BASE_URL_CACHE
    if not _CRYPTO_BASE_URL_CACHE:
        _CRYPTO_BASE_URL_CACHE = _cryptopay_detect_url(CRYPTO_PAY_TOKEN)
    return _CRYPTO_BASE_URL_CACHE

# Keep backward compat variable (used for display/config endpoint)
CRYPTO_PAY_BASE_URL = (os.environ.get("CRYPTO_PAY_BASE_URL") or "").strip().rstrip("/") or _CRYPTOPAY_PROD_URL
CRYPTO_PAY_FIAT = (os.environ.get("CRYPTO_PAY_FIAT") or "USD").strip().upper()
CRYPTO_PAY_ACCEPTED_ASSETS_RAW = os.environ.get("CRYPTO_PAY_ACCEPTED_ASSETS", "USDT,TON")
CRYPTO_PAY_ACCEPTED_ASSETS = [a.strip().upper() for a in CRYPTO_PAY_ACCEPTED_ASSETS_RAW.split(",") if a.strip()]
CRYPTO_PAY_WEBHOOK_TOKEN = (os.environ.get("CRYPTO_PAY_WEBHOOK_TOKEN") or "").strip()
CRYPTO_PAY_MIN_FIAT_CENTS = int(os.environ.get("CRYPTO_PAY_MIN_FIAT_CENTS", "100") or 100)  # 1.00 fiat by default



# ============ ROBOKASSA PAYMENT CONFIG ============
ROBOKASSA_LOGIN  = (os.environ.get("ROBOKASSA_LOGIN") or "").strip()
ROBOKASSA_PASS1  = (os.environ.get("ROBOKASSA_PASS1") or "").strip()   # Password #1 (for payment URL signature)
ROBOKASSA_PASS2  = (os.environ.get("ROBOKASSA_PASS2") or "").strip()   # Password #2 (for result URL verification)
ROBOKASSA_TEST   = (os.environ.get("ROBOKASSA_TEST") or "0").strip() == "1"

def robokassa_enabled():
    return bool(ROBOKASSA_LOGIN and ROBOKASSA_PASS1)

# ============ CARDLINK PAYMENT CONFIG (legacy) ============
CARDLINK_API_TOKEN = (os.environ.get("CARDLINK_API_TOKEN") or "").strip()
CARDLINK_SHOP_ID = (os.environ.get("CARDLINK_SHOP_ID") or "").strip()
CARDLINK_API_URL = "https://cardlink.link/api/v1"

def cardlink_enabled():
    return bool(CARDLINK_API_TOKEN and CARDLINK_SHOP_ID)

# ============ CARD / SBP MANUAL PAYMENT CONFIG ============
CARD_NUMBER  = (os.environ.get("CARD_NUMBER") or "").strip()   # e.g. "2200 7012 3456 7890"
CARD_OWNER   = (os.environ.get("CARD_OWNER") or "").strip()    # e.g. "Иванов Иван"
CARD_BANK    = (os.environ.get("CARD_BANK") or "Сбербанк").strip()
SBP_PHONE    = (os.environ.get("SBP_PHONE") or "").strip()     # e.g. "+79001234567"
CARD_INVOICE_TTL_MIN = int(os.environ.get("CARD_INVOICE_TTL_MIN") or "30")

def card_payment_enabled() -> bool:
    return bool(CARD_NUMBER or SBP_PHONE)


PREMIUM_PRICE_POINTS = int(os.environ.get("PREMIUM_PRICE_POINTS", "499") or 499)
PREMIUM_PERIOD_DAYS = int(os.environ.get("PREMIUM_PERIOD_DAYS", "30") or 30)
if PREMIUM_PRICE_POINTS < 1:
    PREMIUM_PRICE_POINTS = 499
if PREMIUM_PERIOD_DAYS < 1:
    PREMIUM_PERIOD_DAYS = 30

# Premium plans (Crypto Pay, prices in RUB)
PREMIUM_PLANS_RUB = [
    {"id": "1d", "days": 1, "price_rub": 5, "label": "1 день", "hot": False},
    {"id": "3d", "days": 3, "price_rub": 13, "label": "3 дня", "hot": False},
    {"id": "7d", "days": 7, "price_rub": 29, "label": "7 дней", "hot": False},
    {"id": "14d", "days": 14, "price_rub": 49, "label": "14 дней", "hot": True},
    {"id": "30d", "days": 30, "price_rub": 79, "label": "30 дней", "hot": True},
]

def _get_premium_plan(plan_id: str) -> dict:
    pid = (plan_id or "").strip()
    for p in PREMIUM_PLANS_RUB:
        if p.get("id") == pid:
            return p
    raise HTTPException(status_code=400, detail="Invalid plan_id")


def cryptopay_enabled() -> bool:
    return bool(CRYPTO_PAY_TOKEN)

def _cryptopay_secret() -> bytes:
    # Webhook signature secret = SHA256(token)
    return hashlib.sha256((CRYPTO_PAY_TOKEN or "").encode("utf-8")).digest()

def _cryptopay_headers() -> Dict[str, str]:
    if not CRYPTO_PAY_TOKEN:
        raise HTTPException(status_code=500, detail="Crypto Pay is not configured (CRYPTO_PAY_TOKEN)")
    return {
        "Crypto-Pay-API-Token": CRYPTO_PAY_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

def _cryptopay_call(method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    base = _get_cryptopay_base_url()
    url = f"{base}/{method.lstrip('/')}"
    _log = logging.getLogger("rbx.cryptopay")
    try:
        r = requests.post(url, headers=_cryptopay_headers(), data=json.dumps(params or {}), timeout=DEFAULT_TIMEOUT)
    except Exception as e:
        _log.error("CryptoPay request failed: %s %s", method, e)
        raise HTTPException(status_code=502, detail=f"Crypto Pay недоступен: {type(e).__name__}")
    if r.status_code != 200:
        _log.error("CryptoPay %s → HTTP %s: %s", method, r.status_code, r.text[:400])
        raise HTTPException(status_code=502, detail=f"Crypto Pay ошибка {r.status_code}: {r.text[:200]}")
    try:
        j = r.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Crypto Pay: некорректный ответ (не JSON)")
    if not j.get("ok"):
        err = j.get("error") or j
        _log.error("CryptoPay %s not ok: %s", method, str(err)[:400])
        raise HTTPException(status_code=502, detail=f"Crypto Pay: {str(err)[:200]}")
    return j.get("result") or {}

def _cryptopay_verify_signature(raw_body: bytes, signature_hex: str) -> bool:
    if not signature_hex:
        return False
    try:
        mac = hmac.new(_cryptopay_secret(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(mac, signature_hex)
    except Exception:
        return False


def stripe_enabled() -> bool:
    return bool(stripe and STRIPE_SECRET_KEY)

def stripe_require():
    if not stripe:
        raise HTTPException(status_code=500, detail="Stripe library is not installed")
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Stripe is not configured (STRIPE_SECRET_KEY)")
    stripe.api_key = STRIPE_SECRET_KEY

def _base_url(request: Request) -> str:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        host = request.url.netloc
    return f"{proto}://{host}".rstrip("/")

def _points_to_cents(points: int) -> int:
    # Example: BALANCE_PER_CURRENCY=100 => 100 points = 1.00 currency
    cents = int(round((points / float(BALANCE_PER_CURRENCY)) * 100.0))
    return max(50, cents)  # Stripe min is provider-dependent; keep it sane

def _rget(row: Any, key: str, default: Any = None) -> Any:
    """Safe getter for sqlite3.Row / dict-like rows."""
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        return row[key]
    except Exception:
        return default


def _count_val(row, alias: str = "cnt") -> int:
    """Extract count from SELECT COUNT(*) result, works with both SQLite tuple and PG dict."""
    if row is None:
        return 0
    # Dict (PG dict_row): {"count": 5} or {"cnt": 5}
    if isinstance(row, dict):
        for k in (alias, "count", "cnt", "c"):
            if k in row:
                return int(row[k] or 0)
        # fallback: first value
        vals = list(row.values())
        return int(vals[0] or 0) if vals else 0
    # sqlite3.Row or tuple
    try:
        return int(row[0] or 0)
    except Exception:
        try:
            return int(row[alias] or 0)
        except Exception:
            return 0


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PBKDF2_ITERS)
    return base64.b64encode(salt).decode('ascii') + '.' + base64.b64encode(dk).decode('ascii')

def verify_password(password: str, stored: str) -> bool:
    try:
        salt_b64, dk_b64 = stored.split('.', 1)
        salt = base64.b64decode(salt_b64.encode('ascii'))
        dk0 = base64.b64decode(dk_b64.encode('ascii'))
        dk1 = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PBKDF2_ITERS)
        return hmac.compare_digest(dk0, dk1)
    except Exception:
        return False

# Pollinations (no key)
POLLINATIONS_OPENAI_URL = "https://text.pollinations.ai/openai"   # OpenAI-compatible
POLLINATIONS_MODELS_URL = "https://text.pollinations.ai/models"

# Groq (key required)
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

# BlackBox (key required)
BLACKBOX_CHAT_URL = "https://api.blackbox.ai/chat/completions"

# ── Chat provider helper functions ──
def groq_chat(api_key: str, model: str, system: str, user: str, temperature: float = 0.9, max_tokens: int = 900) -> str:
    if not api_key:
        raise Exception("GROQ_API_KEY is missing")
    payload = {
        "model": model or "llama-3.3-70b-versatile",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    r = requests.post(
        GROQ_CHAT_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=15,
    )
    if r.status_code != 200:
        raise Exception(f"Groq error: {r.status_code} {r.text[:200]}")
    j = r.json()
    return j["choices"][0]["message"]["content"]

def pollinations_chat(model: str, system: str, user: str, temperature: float = 0.9, max_tokens: int = 900) -> str:
    payload = {
        "model": model or "openai",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    r = requests.post(POLLINATIONS_OPENAI_URL, json=payload, timeout=12)
    if r.status_code != 200:
        raise Exception(f"Pollinations error: {r.status_code} {r.text[:200]}")
    j = r.json()
    try:
        return j["choices"][0]["message"]["content"]
    except Exception:
        if isinstance(j, dict) and "text" in j:
            return str(j["text"])
        return r.text

def perplexity_chat(api_key: str, model: str, system: str, user: str, temperature: float = 0.7, max_tokens: int = 900) -> str:
    if not api_key:
        raise Exception("PERPLEXITY_API_KEY is missing")
    payload = {
        "model": model or "sonar",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    r = requests.post(
        "https://api.perplexity.ai/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=15,
    )
    if r.status_code != 200:
        raise Exception(f"Perplexity error: {r.status_code} {r.text[:200]}")
    j = r.json()
    return j["choices"][0]["message"]["content"]

def blackbox_chat(api_key: str, model: str, system: str, user: str, temperature: float = 0.9, max_tokens: int = 900) -> str:
    if not api_key:
        raise Exception("BLACKBOX_API_KEY is missing")
    payload = {
        "model": model or "blackboxai",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    r = requests.post(
        BLACKBOX_CHAT_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=15,
    )
    if r.status_code != 200:
        raise Exception(f"BlackBox error: {r.status_code} {r.text[:200]}")
    j = r.json()
    return j["choices"][0]["message"]["content"]

def provider_chat(provider: str, model: str = "", system: str = "", user: str = "", temperature: float = 0.9, max_tokens: int = 900) -> str:
    """Universal chat dispatcher with fallback chain."""
    errors = []
    # Try requested provider first
    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        if api_key:
            try:
                return groq_chat(api_key=api_key, model=model, system=system, user=user, temperature=temperature, max_tokens=max_tokens)
            except Exception as e:
                errors.append(f"groq:{e}")
    elif provider == "perplexity":
        api_key = os.environ.get("PERPLEXITY_API_KEY", "")
        if api_key:
            try:
                return perplexity_chat(api_key=api_key, model=model, system=system, user=user, temperature=temperature, max_tokens=max_tokens)
            except Exception as e:
                errors.append(f"perplexity:{e}")
    elif provider == "blackbox":
        api_key = os.environ.get("BLACKBOX_API_KEY", "")
        if api_key:
            try:
                return blackbox_chat(api_key=api_key, model=model, system=system, user=user, temperature=temperature, max_tokens=max_tokens)
            except Exception as e:
                errors.append(f"blackbox:{e}")

    # Fallback: Pollinations (free, no key)
    try:
        return pollinations_chat(model=model or "openai", system=system, user=user, temperature=temperature, max_tokens=max_tokens)
    except Exception as e:
        errors.append(f"pollinations:{e}")

    raise Exception(f"All providers failed: {'; '.join(str(e) for e in errors)}")
# Brevo (email verification / reset)
BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email"

def _env_str(name: str, default: str = "") -> str:
    """Read string env var and normalize common hosting quirks.

    Some dashboards (Railway/Render) sometimes store values with surrounding quotes.
    We also want to tolerate accidental whitespace/newlines.
    """
    v = os.environ.get(name, "")
    if v is None or v == "":
        return default
    v = str(v).strip()
    # tolerate accidental wrapping quotes
    v = v.strip('"').strip("'")
    return v

def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name, "")
    if v is None or v == "":
        return default
    v = str(v).strip()
    v = v.strip('\"').strip("'")
    try:
        return int(v)
    except Exception:
        return default

OTP_TTL_MINUTES = _env_int("OTP_TTL_MINUTES", 10)
OTP_MAX_ATTEMPTS = _env_int("OTP_MAX_ATTEMPTS", 5)

BREVO_API_KEY = _env_str("BREVO_API_KEY", "")
BREVO_SENDER_EMAIL = _env_str("BREVO_SENDER_EMAIL", "")
BREVO_SENDER_NAME = _env_str("BREVO_SENDER_NAME", "RBX - Shop | Tools")

def send_brevo_email(to_email: str, subject: str, text_content: str, html_content: str = ""):
    """Send email via Brevo Transactional API."""
    to_email = (to_email or "").strip()
    if not to_email or "@" not in to_email:
        raise HTTPException(status_code=400, detail="Invalid email")
    if not BREVO_API_KEY:
        raise HTTPException(status_code=500, detail="Brevo is not configured (BREVO_API_KEY)")
    if not BREVO_SENDER_EMAIL:
        raise HTTPException(status_code=500, detail="Brevo sender is not configured (BREVO_SENDER_EMAIL)")

    payload = {
        "sender": {"name": BREVO_SENDER_NAME or "RBX - Shop | Tools", "email": BREVO_SENDER_EMAIL},
        "to": [{"email": to_email}],
        "subject": subject,
        "textContent": text_content,
    }
    if html_content:
        payload["htmlContent"] = html_content

    headers = {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        "accept": "application/json",
    }
    try:
        r = requests.post(
            BREVO_EMAIL_URL,
            headers=headers,
            data=json.dumps(payload),
            timeout=DEFAULT_TIMEOUT,
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Brevo request failed: {type(e).__name__}")

    if r.status_code not in (200, 201, 202):
        body = (r.text or "").strip()[:500]
        raise HTTPException(status_code=502, detail=f"Brevo error: {r.status_code} {body}")

    try:
        print(f"[Brevo] sent to={to_email} status={r.status_code}")
    except Exception:
        pass

def gen_otp_code() -> str:
    return f"{secrets.randbelow(1000000):06d}"

def otp_hash(code: str) -> str:
    # HMAC with SECRET_KEY (server-side)
    key = (SECRET_KEY or "dev").encode("utf-8")
    return hmac.new(key, code.encode("utf-8"), hashlib.sha256).hexdigest()


# Roblox endpoints
RBX_AUTH = "https://users.roblox.com/v1/users/authenticated"
RBX_USER = "https://users.roblox.com/v1/users/{uid}"
RBX_ROBUX = "https://economy.roblox.com/v1/users/{uid}/currency"
RBX_COLLECT = "https://inventory.roblox.com/v1/users/{uid}/assets/collectibles?limit=100&cursor={cur}"
RBX_TX = "https://economy.roblox.com/v2/users/{uid}/transactions?transactionType=Purchase&limit=100&cursor={cur}"

# Roblox gamepass product info
# NOTE (2025+): Roblox deprecated the legacy Economy endpoint for gamepass product info.
# Replacement: https://apis.roblox.com/game-passes/v1/game-passes/{gamePassId}/product-info
# Keep legacy as fallback.
RBX_GAMEPASS_INFO_V2 = "https://apis.roblox.com/game-passes/v1/game-passes/{gid}/product-info"
RBX_GAMEPASS_INFO_V2_PROXY = "https://apis.roproxy.com/game-passes/v1/game-passes/{gid}/product-info"
RBX_GAMEPASS_INFO_LEGACY = "https://economy.roblox.com/v1/game-pass/{gid}/game-pass-product-info"
RBX_GAMEPASS_INFO_LEGACY_PROXY = "https://economy.roproxy.com/v1/game-pass/{gid}/game-pass-product-info"
RBX_PURCHASE_PRODUCT = "https://economy.roblox.com/v1/purchases/products/{pid}"

# Roblox helpers for username-based gamepass search
RBX_USERNAME_RESOLVE = "https://users.roblox.com/v1/usernames/users"  # POST
RBX_USER_GAMES = "https://games.roblox.com/v2/users/{uid}/games?accessFilter=Public&limit=50&sortOrder=Asc&cursor={cur}"
RBX_UNIVERSE_GAMEPASSES = "https://games.roblox.com/v1/games/{universeId}/game-passes?limit=100&sortOrder=Asc&cursor={cur}"
# Newer universe gamepasses endpoint (old one can return 404 for many universes)
RBX_UNIVERSE_GAMEPASSES_V2 = "https://apis.roblox.com/game-passes/v1/universes/{universeId}/game-passes?passView=Full&pageSize=100&pageToken={cur}"
# Newer product info endpoint (fallback)
RBX_GAMEPASS_PRODUCTINFO2 = "https://apis.roblox.com/game-passes/v1/game-passes/{gid}/product-info"

# In-memory cache to avoid scanning all games repeatedly (TTL seconds)
_ROBUX_GP_SCAN_CACHE: Dict[Tuple[int,int], Tuple[int,float]] = {}  # (owner_id, expected_price) -> (gamepass_id, expires_at)


def robux_calc(amount: int) -> Dict[str, Any]:
    """Server-side quote. Never trust client-side numbers."""
    try:
        amount = int(amount)
    except Exception:
        amount = 0
    cfg=_robux_cfg_effective()
    if amount < int(cfg['min_amount']):
        raise HTTPException(status_code=400, detail=f"Минимум {int(cfg['min_amount'])} Robux")
    rub_price = int(round(amount * float(cfg['rub_per_robux'])))
    gp_price = int(math.ceil(amount * float(cfg['gp_factor'])))
    return {"robux": amount, "rub_price": rub_price, "gamepass_price": gp_price, "rub_per_robux": float(cfg['rub_per_robux'])}


def _parse_gamepass_id(url: str) -> int:
    """Extract gamepass id from URL. Supports common formats."""
    if not url:
        return 0
    s = str(url).strip()
    # Allow passing plain numeric id (some callers already have an id, not a URL)
    if s.isdigit():
        try:
            return int(s)
        except Exception:
            return 0
    # /game-pass/<id>/
    m = re.search(r"game-?pass(?:es)?/(\d+)", s, flags=re.I)
    if m:
        return int(m.group(1))
    # ...?id=<id>
    m = re.search(r"[?&]id=(\d+)", s, flags=re.I)
    if m:
        return int(m.group(1))
    # last number in url
    m = re.findall(r"(\d{5,})", s)
    if m:
        try:
            return int(m[-1])
        except Exception:
            return 0
    return 0


def _roblox_request(method: str, url: str, *, cookie: str, headers: Optional[Dict[str, str]] = None, json_body: Optional[Dict[str, Any]] = None) -> requests.Response:
    h = {"User-Agent": "RST-Web/1.0"}
    if headers:
        h.update(headers)
    ck = cookie
    if ck and not ck.lower().startswith(".roblosecurity"):
        # allow passing raw cookie value
        ck = f".ROBLOSECURITY={ck}"
    cookies = {".ROBLOSECURITY": ck.split("=",1)[1]} if ck else {}
    r = requests.request(method, url, headers=h, cookies=cookies, json=json_body, timeout=DEFAULT_TIMEOUT)
    return r


def _roblox_post_with_csrf(url: str, *, cookie: str, json_body: Dict[str, Any]) -> requests.Response:
    """Roblox requires X-CSRF-TOKEN for state-changing requests."""
    r = _roblox_request("POST", url, cookie=cookie, headers={}, json_body=json_body)
    if r.status_code == 403:
        tok = r.headers.get("x-csrf-token") or r.headers.get("X-CSRF-TOKEN")
        if tok:
            r = _roblox_request("POST", url, cookie=cookie, headers={"X-CSRF-TOKEN": tok}, json_body=json_body)
    return r


def roblox_get_gamepass_thumbnail(gamepass_id: int) -> str:
    """Return a direct CDN thumbnail URL for a gamepass (best-effort).
    Uses Roblox Thumbnails API (and roproxy as fallback) and extracts `data[0].imageUrl`.
    """
    try:
        gid = int(gamepass_id)
    except Exception:
        return ""
    if gid <= 0:
        return ""

    endpoints = [
        f"https://thumbnails.roblox.com/v1/game-passes?gamePassIds={gid}&size=150x150&format=Png&isCircular=false",
        f"https://thumbnails.roproxy.com/v1/game-passes?gamePassIds={gid}&size=150x150&format=Png&isCircular=false",
    ]

    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
    }

    for url in endpoints:
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code != 200:
                continue
            j = r.json() if r.text else None
            if not isinstance(j, dict):
                continue
            data = j.get("data") or []
            if not data or not isinstance(data, list):
                continue
            item = data[0] if len(data) else {}
            if not isinstance(item, dict):
                continue
            image_url = item.get("imageUrl") or ""
            if isinstance(image_url, str) and image_url.startswith("http"):
                return image_url
        except Exception:
            continue

    return ""


def roblox_inspect_gamepass(gamepass_url: str) -> Dict[str, Any]:
    gid = _parse_gamepass_id(gamepass_url)
    if not gid:
        # FIX: More specific error message to help debugging
        raise HTTPException(status_code=400, detail=f"Не удалось распознать ссылку/ID геймпасса (получено: '{gamepass_url[:50] if gamepass_url else ''}')")

    # Try the new official endpoint first (legacy Economy endpoint was deprecated).
    endpoints = [
        RBX_GAMEPASS_INFO_V2.format(gid=gid),
        RBX_GAMEPASS_INFO_V2_PROXY.format(gid=gid),
        RBX_GAMEPASS_INFO_LEGACY.format(gid=gid),
        RBX_GAMEPASS_INFO_LEGACY_PROXY.format(gid=gid),
        # extra community proxy fallback (may be unstable)
        f"https://economy.rprxy.xyz/v1/game-pass/{int(gid)}/game-pass-product-info",
    ]
    last_err = None
    last_status: Optional[int] = None
    last_body: str = ""
    j: Dict[str, Any] = {}
    for url in endpoints:
        try:
            r = requests.get(url, timeout=DEFAULT_TIMEOUT, headers={"User-Agent": "RST-Web/1.0"})
            if r.ok and r.content:
                j = r.json()
                if isinstance(j, dict) and j:
                    break
            else:
                last_status = r.status_code
                try:
                    last_body = (r.text or "")[:200]
                except Exception:
                    last_body = ""
        except Exception as e:
            last_err = e
            continue

    if not j:
        # Surface the last upstream hint to help debugging deployments (Roblox sometimes blocks datacenter IPs).
        if last_status:
            hint = f" (последний ответ Roblox/proxy: HTTP {last_status})"
            if last_body:
                hint += f" :: {last_body}"
            raise HTTPException(status_code=400, detail="Геймпасс не найден или недоступен" + hint)
        if last_err:
            raise HTTPException(status_code=400, detail=f"Геймпасс не найден или недоступен (ошибка запроса: {last_err})")
        raise HTTPException(status_code=400, detail="Геймпасс не найден или недоступен")

    # fields vary between legacy and new endpoint.
    # Legacy (economy.roblox.com): Name, PriceInRobux, ProductId, Creator
    # New (apis.roblox.com): name, priceInRobux, productId, creator
    name = j.get("Name") or j.get("name") or ""
    price = int(j.get("PriceInRobux") or j.get("priceInRobux") or j.get("price") or 0)
    pid = int(j.get("ProductId") or j.get("productId") or 0)
    creator = j.get("Creator") or j.get("creator") or {}
    owner = creator.get("Name") or creator.get("name") or ""
    owner_id = int(creator.get("Id") or creator.get("id") or 0)

    thumb_url = roblox_get_gamepass_thumbnail(int(gid))

    return {
        "gamepass_id": int(gid),
        "product_id": int(pid),
        "name": str(name),
        "price": int(price),
        "owner": str(owner),
        "owner_id": int(owner_id),
        "thumbnail_url": str(thumb_url),
    }




# --- Roblox username normalization (handles Cyrillic look-alikes) ---
_CYR_TO_LAT = str.maketrans({
    # Uppercase
    # NOTE: map Cyrillic look-alike "У" to Latin "U" (users often type Cyrillic У intending Latin U).
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "U",
    # Lowercase
    "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "х": "x", "у": "u",
})

def normalize_roblox_username(raw: str) -> str:
    u = (raw or "").strip()
    if u.startswith("@"):
        u = u[1:]
    u = re.sub(r"\s+", "", u)
    u = u.translate(_CYR_TO_LAT)
    return u


def roblox_username_to_id(username: str) -> int:
    u = normalize_roblox_username(username)
    if not u:
        raise HTTPException(status_code=400, detail="Нужен ник Roblox")
    # Roblox usernames are latin letters, digits and underscore.
    # This avoids common mistakes with Cyrillic look-alikes.
    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", u):
        raise HTTPException(status_code=400, detail="Ник Roblox должен быть латиницей (A-Z, 0-9, _). Если ник содержит буквы Б, Г, Д, Ж, З, И, Й, Л, Ф, Ц, Ч, Ш, Щ, Ы, Э, Ю, Я — они не конвертируются!")
    def _try_post(url: str) -> Dict[str, Any]:
        r = requests.post(
            url,
            json={"usernames": [u], "excludeBannedUsers": True},
            headers={"User-Agent": "RST-Web/1.0"},
            timeout=DEFAULT_TIMEOUT,
        )
        return r.json() if r.content else {}

    # Some hosts/network setups block *.roblox.com; try roproxy as fallback.
    j: Dict[str, Any] = {}
    try:
        j = _try_post(RBX_USERNAME_RESOLVE)
    except Exception:
        j = {}
    if not (j or {}).get("data"):
        try:
            j = _try_post(RBX_USERNAME_RESOLVE.replace(".roblox.com", ".roproxy.com"))
        except Exception:
            j = {}
    data = (j or {}).get("data") or []
    if not data:
        raise HTTPException(status_code=400, detail="Пользователь Roblox не найден")
    try:
        return int(data[0].get("id") or 0)
    except Exception:
        return 0


def _roblox_safe_get_json(url: str) -> Dict[str, Any]:
    def _try(u: str):
        return requests.get(u, timeout=DEFAULT_TIMEOUT, headers={"User-Agent": "RST-Web/1.0"})

    r = _try(url)
    if (not r.ok) and (".roblox.com" in url):
        # Fallback: roproxy mirrors many endpoints.
        r = _try(url.replace(".roblox.com", ".roproxy.com"))
    if not r.ok:
        raise HTTPException(status_code=400, detail="Roblox API недоступен или ограничил запросы")
    try:
        return r.json() if r.content else {}
    except Exception:
        return {}


def _roblox_iter_user_universes(user_id: int, max_universes: int = 60) -> List[int]:
    """Return universe IDs for user's *public* experiences.

    Roblox `GET /v2/users/{uid}/games` typically returns items where:
      - `id` is the **universeId**
      - some variants may also include `universeId`
    We accept both to be robust.
    """
    seen: set[int] = set()
    cur = ""
    out: List[int] = []
    for _ in range(20):
        url = RBX_USER_GAMES.format(uid=int(user_id), cur=(cur or ""))
        j = _roblox_safe_get_json(url)

        for it in (j.get("data") or []):
            # Defensive parsing
            uni_raw = None
            try:
                if isinstance(it, dict):
                    uni_raw = it.get("universeId") or it.get("id")
                    # Some payloads embed rootPlace, ignore if missing
                    if not uni_raw:
                        rp = it.get("rootPlace") or {}
                        if isinstance(rp, dict):
                            uni_raw = rp.get("universeId")
            except Exception:
                uni_raw = None

            try:
                uni = int(uni_raw or 0)
            except Exception:
                uni = 0

            if uni and uni not in seen:
                seen.add(uni)
                out.append(uni)
                if len(out) >= max_universes:
                    return out

        cur = j.get("nextPageCursor") or ""
        if not cur:
            break
    return out


def _roblox_iter_universe_gamepasses(universe_id: int, max_passes: int = 400) -> List[Dict[str, Any]]:
    """Iterate gamepasses for a universe.

    Legacy endpoint: `https://games.roblox.com/v1/games/{universeId}/game-passes?...`
    New endpoint (announced as replacement): `https://apis.roblox.com/game-passes/v1/universes/{universeId}/game-passes?...`

    We support both response shapes:
      - `{data: [...], nextPageCursor: "..."}`
      - `{gamePasses: [...], nextPageToken: "..."}`
    """

    def _parse_batch(j: Dict[str, Any]) -> tuple[list[Dict[str, Any]], str]:
        batch = []
        if isinstance(j, dict):
            if isinstance(j.get("data"), list):
                batch = j.get("data") or []
            elif isinstance(j.get("gamePasses"), list):
                batch = j.get("gamePasses") or []
        nxt = ""
        if isinstance(j, dict):
            nxt = j.get("nextPageCursor") or j.get("nextPageToken") or j.get("nextPageCursor") or ""
        return batch, (nxt or "")

    def _fetch(url_tpl: str) -> List[Dict[str, Any]]:
        cur = ""
        out: List[Dict[str, Any]] = []
        for _ in range(30):
            url = url_tpl.format(universeId=int(universe_id), cur=(cur or ""))
            j = _roblox_safe_get_json(url)
            batch, nxt = _parse_batch(j)

            for gp in (batch or []):
                out.append(gp)
                if len(out) >= max_passes:
                    return out

            cur = nxt
            if not cur:
                break
        return out

    # Prefer new API, then fall back to legacy
    try:
        return _fetch(RBX_UNIVERSE_GAMEPASSES_V2)
    except Exception:
        try:
            return _fetch(RBX_UNIVERSE_GAMEPASSES)
        except Exception:
            return []


def _roblox_gamepass_price_from_list_item(gp: Dict[str, Any]) -> int:
    # Depending on endpoint version it can be: price, priceInRobux, or nested product
    for k in ("price", "priceInRobux", "PriceInRobux"):
        if k in gp and gp.get(k) is not None:
            try:
                return int(gp.get(k) or 0)
            except Exception:
                pass
    prod = gp.get("product") or {}
    for k in ("priceInRobux", "PriceInRobux", "price"):
        if k in prod and prod.get(k) is not None:
            try:
                return int(prod.get(k) or 0)
            except Exception:
                pass
    return 0


def _roblox_gamepass_id_from_list_item(gp: Dict[str, Any]) -> int:
    for k in ("id", "gamePassId", "gamepassId"):
        if k in gp and gp.get(k) is not None:
            try:
                return int(gp.get(k) or 0)
            except Exception:
                pass
    return 0


def roblox_find_gamepass_by_username(username: str, expected_price: int, user_id: int = 0) -> Dict[str, Any]:
    """Find a gamepass owned by username with the expected price."""
    print(f"[GP SCAN] Starting scan for user '{username}' with expected price {expected_price}")
    
    # Get user ID
    uid = roblox_username_to_id(username)
    print(f"[GP SCAN] Resolved username '{username}' to user ID {uid}")
    
    # Check cache
    key = (int(uid), int(expected_price))
    now = time.time()
    try:
        cached = _ROBUX_GP_SCAN_CACHE.get(key)
        if cached and cached[1] > now and int(cached[0] or 0) > 0:
            print(f"[GP SCAN] Cache hit! Gamepass ID {cached[0]}")
            return roblox_inspect_gamepass(str(int(cached[0])))
    except Exception as e:
        print(f"[GP SCAN] Cache check error: {e}")
    
    # PREMIUM OPTIMIZATION: Check recent orders for known gamepasses of this roblox user
    if user_id:
        try:
            con = db_conn()
            prev = con.execute(
                "SELECT gamepass_id, gamepass_url FROM robux_orders WHERE gamepass_owner_id=? AND status='done' AND gamepass_price=? ORDER BY id DESC LIMIT 5",
                (int(uid), int(expected_price))
            ).fetchall()
            con.close()
            for p in (prev or []):
                gid = int(_rget(p, "gamepass_id") or 0)
                if gid <= 0:
                    continue
                try:
                    info = roblox_inspect_gamepass(str(gid))
                    if int(info.get("price") or 0) == int(expected_price) and info.get("for_sale"):
                        print(f"[GP SCAN] Premium fast-path: reusing known gamepass {gid}")
                        _ROBUX_GP_SCAN_CACHE[key] = (gid, now + 300.0)
                        return info
                except Exception:
                    continue
        except Exception as e:
            print(f"[GP SCAN] Premium fast-path error: {e}")
    
    # Get user's universes (games)
    universes = _roblox_iter_user_universes(uid, max_universes=60)
    print(f"[GP SCAN] Found {len(universes)} universes for user {uid}")
    
    if not universes:
        raise HTTPException(status_code=400, detail=f"У пользователя {username} нет публичных плейсов/игр. Убедись, что у пользователя есть хотя бы одна публичная игра.")

    # Scan universes and their gamepasses
    total_passes_checked = 0
    for i, uni in enumerate(universes):
        try:
            gps = _roblox_iter_universe_gamepasses(uni, max_passes=400)
            print(f"[GP SCAN] Universe {uni}: found {len(gps)} gamepasses")
        except Exception as e:
            print(f"[GP SCAN] Universe {uni}: error getting gamepasses: {e}")
            continue

        # Fast path: if list item already contains price
        for gp in gps:
            gid = _roblox_gamepass_id_from_list_item(gp)
            if not gid:
                continue
            total_passes_checked += 1
            price = _roblox_gamepass_price_from_list_item(gp)
            if price and int(price) != int(expected_price):
                continue
            if price and int(price) == int(expected_price):
                print(f"[GP SCAN] Found potential match: gamepass {gid} with price {price}")
                info = roblox_inspect_gamepass(str(gid))
                # verify owner matches uid
                if int(info.get("owner_id") or 0) == int(uid) and int(info.get("price") or 0) == int(expected_price):
                    print(f"[GP SCAN] Confirmed match: {info.get('name')} (ID: {gid})")
                    if int(gid) > 0:
                        _ROBUX_GP_SCAN_CACHE[key] = (int(gid), now + 300.0)
                    return info

        # Slow path: probe gamepasses without price info
        probed = 0
        for gp in gps:
            gid = _roblox_gamepass_id_from_list_item(gp)
            if not gid:
                continue
            probed += 1
            if probed > 120:
                break
            try:
                info = roblox_inspect_gamepass(str(gid))
            except Exception:
                continue
            if int(info.get("owner_id") or 0) != int(uid):
                continue
            if int(info.get("price") or 0) == int(expected_price):
                print(f"[GP SCAN] Found via slow path: {info.get('name')} (ID: {gid})")
                if int(gid) > 0:
                    _ROBUX_GP_SCAN_CACHE[key] = (int(gid), now + 300.0)
                return info

        time.sleep(0.08)

    print(f"[GP SCAN] No match found after checking {total_passes_checked} gamepasses in {len(universes)} universes")
    raise HTTPException(
        status_code=400,
        detail=f"Не нашли геймпасс у {username} с ценой {int(expected_price)} R$. Проверено {total_passes_checked} геймпассов в {len(universes)} играх. Убедись, что геймпасс создан, публичный и выставлен на продажу с ценой ровно {expected_price} R$.",
    )


def roblox_seller_status() -> Dict[str, Any]:
    ck = _seller_cookie_effective()
    if not ck:
        return {"configured": False}
    # authenticated user
    r = _roblox_request("GET", RBX_AUTH, cookie=ck)
    if not r.ok:
        return {"configured": False}
    j = r.json() if r.content else {}
    uid = int(j.get("id") or 0)
    uname = j.get("name") or ""
    # robux balance
    rr = _roblox_request("GET", RBX_ROBUX.format(uid=uid), cookie=ck)
    robux = 0
    if rr.ok:
        jj = rr.json() if rr.content else {}
        robux = int(jj.get("robux") or jj.get("balance") or 0)
    return {"configured": True, "user_id": uid, "username": uname, "robux": robux}


def roblox_cookie_status(cookie: str) -> Dict[str, Any]:
    """Validate cookie and return {ok, user_id, username, robux, error}."""
    ck = (cookie or "").strip()
    if not ck:
        return {"ok": False, "error": "cookie empty"}
    try:
        r = _roblox_request("GET", RBX_AUTH, cookie=ck)
        if not r.ok:
            return {"ok": False, "error": f"auth failed (HTTP {r.status_code})"}
        j = r.json() if r.content else {}
        uid = int(j.get("id") or 0)
        uname = (j.get("name") or "")
        rr = _roblox_request("GET", RBX_ROBUX.format(uid=uid), cookie=ck)
        robux = 0
        if rr.ok:
            jj = rr.json() if rr.content else {}
            robux = int(jj.get("robux") or jj.get("balance") or 0)
        return {"ok": True, "user_id": uid, "username": uname, "robux": int(robux)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _roblox_delete_gamepass_from_inventory(cookie: str, gamepass_id: int) -> bool:
    """Remove a gamepass the bot already owns from its inventory so it can repurchase."""
    try:
        r_auth = _roblox_request("GET", RBX_AUTH, cookie=cookie)
        if not r_auth.ok:
            _log.warning("[PURCHASE] AlreadyOwned: can't get bot uid (HTTP %s)", r_auth.status_code)
            return False
        uid = int((r_auth.json() if r_auth.content else {}).get("id") or 0)
        if not uid:
            return False
        _log.info("[PURCHASE] AlreadyOwned: deleting gamepass %s from bot uid %s", gamepass_id, uid)
        # Primary endpoint
        del_url = f"https://inventory.roblox.com/v1/users/{uid}/items/GamePass/{int(gamepass_id)}"
        r_del = _roblox_post_with_csrf(del_url, cookie=cookie, json_body={})
        if r_del.status_code in (200, 204):
            _log.info("[PURCHASE] AlreadyOwned: gamepass deleted (HTTP %s)", r_del.status_code)
            return True
        # Fallback
        del_url2 = f"https://economy.roblox.com/v2/user/game-pass/{int(gamepass_id)}/delete"
        r_del2 = _roblox_post_with_csrf(del_url2, cookie=cookie, json_body={})
        if r_del2.status_code in (200, 204):
            _log.info("[PURCHASE] AlreadyOwned: gamepass deleted via fallback (HTTP %s)", r_del2.status_code)
            return True
        _log.warning("[PURCHASE] AlreadyOwned: delete HTTP %s / %s — proceeding anyway", r_del.status_code, r_del2.status_code)
        return True  # optimistically proceed; deletion may have worked
    except Exception as ex:
        _log.warning("[PURCHASE] AlreadyOwned: deletion exception: %s", ex)
        return False


def roblox_buy_product(*, product_id: int, expected_price: int, expected_seller_id: int, gamepass_id: int = 0) -> Dict[str, Any]:
    """Buy a Roblox product (gamepass productId) using a configured seller cookie.

    Priority:
    1) ENV/DB single cookie (legacy override) if present
    2) Otherwise, try active cookies from roblox_accounts pool (highest balance first)

    AlreadyOwned: if the bot already owns this gamepass, it is automatically deleted
    from inventory and the purchase is retried once.
    """
    url = RBX_PURCHASE_PRODUCT.format(pid=int(product_id))
    payload = {
        "expectedCurrency": 1,
        "expectedPrice": int(expected_price),
        "expectedSellerId": int(expected_seller_id),
    }

    def _attempt(cookie: str) -> Dict[str, Any]:
        r = _roblox_post_with_csrf(url, cookie=cookie, json_body=payload)
        try:
            j = r.json() if r.content else {}
        except Exception:
            j = {}
        _log.info("[PURCHASE] HTTP %s, body: %s", r.status_code, str(j)[:500])
        if not r.ok:
            return {"ok": False, "status": int(r.status_code), "error": (j.get("message") or j.get("errorMessage") or j.get("error") or str(j) or f"HTTP {r.status_code}"), "data": j}
        # Roblox has multiple response formats
        purchased = (
            j.get("purchased") is True
            or j.get("isPurchased") is True
            or j.get("success") is True
            or (j.get("statusCode") == 200 and "error" not in j and "reason" not in j)
            or (j.get("purchased") is not False and j.get("receipt") is not None)
        )
        reason = j.get("reason") or j.get("message") or j.get("errorMessage") or ""
        if not purchased:
            err = reason or "Purchase not confirmed"
            if j:
                err += f" (resp: {str(j)[:200]})"
            return {"ok": False, "status": int(r.status_code), "error": err, "data": j, "reason": str(reason)}
        return {"ok": True, "status": int(r.status_code), "data": j}

    def _attempt_with_retry(cookie: str) -> Dict[str, Any]:
        """Attempt purchase; if AlreadyOwned, return special flag so pool loop skips to next account."""
        res = _attempt(cookie)
        if not res.get("ok"):
            raw_reason = str(
                res.get("reason")
                or (res.get("data") or {}).get("reason")
                or (res.get("data") or {}).get("errorMsg")
                or ""
            ).lower()
            if "alreadyowned" in raw_reason or "already own" in raw_reason or "item owned" in raw_reason:
                _log.info("[PURCHASE] AlreadyOwned detected for this account; will skip to next (gamepass_id=%s)", gamepass_id)
                return {"ok": False, "status": int(res.get("status") or 500), "error": res.get("error", "AlreadyOwned"), "already_owned": True}
        return res

    # 1) explicit cookie configured (override)
    ck = (os.environ.get("ROBLOX_SELLER_COOKIE") or "").strip() or (_setting_get("roblox_seller_cookie", "") or "").strip()
    if ck:
        res = _attempt_with_retry(ck)
        if res.get("ok"):
            return res
        # if override cookie failed, still try pool as fallback

    # 2) pool
    try:
        con = db_conn()
        rows = con.execute(
            "SELECT id, label, cookie_enc, robux_balance, roblox_username, is_active FROM roblox_accounts WHERE is_active=1 ORDER BY robux_balance DESC, id ASC",
            (),
        ).fetchall() or []
        con.close()
    except Exception:
        rows = []

    # try accounts that (by cache) can afford first; then try the rest
    def _bal(row):
        try:
            return int(_rget(row, "robux_balance") or 0)
        except Exception:
            return 0

    rows = sorted(rows, key=lambda r: (_bal(r) < int(expected_price), -_bal(r), int(_rget(r, "id") or 0)))
    for row in rows:
        acc_id = int(_rget(row, "id") or 0)
        cookie_enc = str(_rget(row, "cookie_enc") or "")
        cookie = _cookie_decrypt(cookie_enc)
        if not cookie:
            continue
        res = _attempt_with_retry(cookie)
        ts = _now_utc_iso()
        try:
            con = db_conn()
            if res.get("ok"):
                new_bal = max(0, _bal(row) - int(expected_price))
                con.execute(
                    "UPDATE roblox_accounts SET robux_balance=?, last_check_at=?, last_error=NULL WHERE id=?",
                    (int(new_bal), ts, int(acc_id)),
                )
                con.commit()
                con.close()
                res["account_id"] = acc_id
                res["account_label"] = str(_rget(row, "label") or "")
                res["account_username"] = str(_rget(row, "roblox_username") or "")
                return res
            elif res.get("already_owned"):
                # This account already owns the gamepass — skip to next without marking as error
                _log.info("[PURCHASE] Account #%s already owns gamepass; trying next account", acc_id)
                con.execute(
                    "UPDATE roblox_accounts SET last_check_at=?, last_error=? WHERE id=?",
                    (ts, "AlreadyOwned - skipped", int(acc_id)),
                )
                con.commit()
                con.close()
            else:
                # mark error; deactivate on auth/permission issues
                deactivate = int(res.get("status") or 0) in (401, 403)
                con.execute(
                    "UPDATE roblox_accounts SET last_check_at=?, last_error=?, is_active=CASE WHEN ?=1 THEN 0 ELSE is_active END WHERE id=?",
                    (ts, str(res.get("error") or "error"), 1 if deactivate else 0, int(acc_id)),
                )
                con.commit()
                con.close()
        except Exception:
            try:
                con.close()
            except Exception:
                pass
        # try next account

    # Nothing worked
    if ck:
        return {"ok": False, "error": "Seller cookie failed and pool has no working accounts"}
    return {"ok": False, "error": "Seller cookie is not configured — обратитесь к администратору"}


class _PGResult:
    def __init__(self, rows):
        self._rows = rows or []
        self.rowcount = len(self._rows)
    def fetchone(self):
        return self._rows[0] if self._rows else None
    def fetchall(self):
        return self._rows
    def __iter__(self):
        return iter(self._rows)
    def __getitem__(self, idx):
        return self._rows[idx]

class _PGConn:
    def __init__(self, conn):
        self._conn = conn
    def execute(self, q, params=()):
        q = q.replace("?", "%s")
        q_strip = q.lstrip().lower()
        with self._conn.cursor(row_factory=dict_row) as cur:
            cur.execute(q, params)
            rc = getattr(cur, 'rowcount', 0) or 0
            if q_strip.startswith("select") or " returning " in q_strip:
                try:
                    rows = cur.fetchall()
                except Exception:
                    rows = []
                result = _PGResult(rows)
                result.rowcount = rc if rc >= 0 else len(rows)
                return result
            result = _PGResult([])
            result.rowcount = rc if rc >= 0 else 0
            return result
    def cursor(self):
        """Return a cursor-like wrapper for compatibility with SQLite code paths."""
        return _PGCursor(self)
    def commit(self):
        self._conn.commit()
    def close(self):
        self._conn.close()


class _PGCursor:
    """Minimal cursor wrapper that delegates to _PGConn.execute()."""
    def __init__(self, pgconn):
        self._pgconn = pgconn
        self.lastrowid = None
        self.rowcount = 0
    def execute(self, q, params=()):
        # Auto-add RETURNING id for INSERT statements so lastrowid works
        q_stripped = q.strip().lower()
        if q_stripped.startswith("insert") and "returning" not in q_stripped:
            q = q.rstrip().rstrip(";") + " RETURNING id"
        result = self._pgconn.execute(q, params)
        self.rowcount = len(result._rows) if result and result._rows else 0
        if result and result._rows:
            first = result._rows[0]
            if isinstance(first, dict) and 'id' in first:
                self.lastrowid = first['id']
        return result

def db_conn():
    """Returns a connection-like object with .execute/.commit/.close.

    - SQLite by default for local dev
    - Postgres when DATABASE_URL is present (Render)
    """
    if USE_PG:
        if psycopg is None:
            raise RuntimeError("psycopg is not installed, but DATABASE_URL is set")
        conn = psycopg.connect(DATABASE_URL)
        return _PGConn(conn)

    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=30000")
    return con


def _db_retry(fn, max_retries=3):
    """Retry a DB operation on 'database is locked' error."""
    import time as _time
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            if "locked" in str(e).lower() and attempt < max_retries - 1:
                _time.sleep(0.3 * (attempt + 1))
                continue
            raise
def db_init():
    # Postgres (Render): do NOT touch local filesystem
    if USE_PG:
        con = db_conn()
        # users
        con.execute("""
            CREATE TABLE IF NOT EXISTS users(
              id SERIAL PRIMARY KEY,
              username TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              email TEXT,
              email_verified INTEGER NOT NULL DEFAULT 0
            )
        """)
        con.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)""")
        # limits/premium/case fields
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_analyze INTEGER NOT NULL DEFAULT 3")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_ai INTEGER NOT NULL DEFAULT 10")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS case_next_at TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS case_money_next_at TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS twofa_email_enabled INTEGER NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_2fa_reminder INTEGER NOT NULL DEFAULT 0")


        # moderation / audit fields
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_country TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_city TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TEXT")


        # Stripe subscription fields
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sub_id TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sub_status TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sub_period_end TEXT")

        # user profile fields
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_newsletter INTEGER NOT NULL DEFAULT 1")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_site INTEGER NOT NULL DEFAULT 1")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_language TEXT NOT NULL DEFAULT 'ru'")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_currency TEXT NOT NULL DEFAULT 'rub'")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_balance_short INTEGER NOT NULL DEFAULT 0")

        # balance transactions (audit log)
        con.execute("""
            CREATE TABLE IF NOT EXISTS balance_tx(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              delta INTEGER NOT NULL,
              reason TEXT,
              ts TEXT NOT NULL
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_balance_tx_user_ts ON balance_tx(user_id, ts)""")

        # Payments (Stripe checkout sessions)
        con.execute("""
            CREATE TABLE IF NOT EXISTS payments(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              provider TEXT NOT NULL,
              kind TEXT NOT NULL,
              session_id TEXT UNIQUE NOT NULL,
              amount_points INTEGER NOT NULL DEFAULT 0,
              amount_total INTEGER NOT NULL DEFAULT 0,
              currency TEXT NOT NULL,
              status TEXT NOT NULL,
              meta TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at)""")
        # Topups (Crypto / Manual)
        con.execute("""
            CREATE TABLE IF NOT EXISTS topups(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              provider TEXT NOT NULL,
              method TEXT NOT NULL,
              points INTEGER NOT NULL,
              fiat_cents INTEGER NOT NULL DEFAULT 0,
              fiat_currency TEXT,
              invoice_id TEXT UNIQUE,
              pay_url TEXT,
              status TEXT NOT NULL,
              credited INTEGER NOT NULL DEFAULT 0,
              meta TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_topups_user_created ON topups(user_id, created_at)""")

        # Premium orders (Crypto Pay)
        con.execute("""
            CREATE TABLE IF NOT EXISTS premium_orders(
              id SERIAL PRIMARY KEY,
              provider TEXT NOT NULL,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              plan_id TEXT NOT NULL,
              days INTEGER NOT NULL,
              price_rub INTEGER NOT NULL,
              fiat_cents INTEGER NOT NULL DEFAULT 0,
              fiat_currency TEXT,
              invoice_id TEXT UNIQUE,
              pay_url TEXT,
              status TEXT NOT NULL,
              applied INTEGER NOT NULL DEFAULT 0,
              meta TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_premium_orders_user_created ON premium_orders(user_id, created_at)""")


        # Promo codes (FanPay / manual sales)
        con.execute("""
            CREATE TABLE IF NOT EXISTS promo_codes(
              code TEXT PRIMARY KEY,
              points INTEGER NOT NULL,
              max_uses INTEGER NOT NULL DEFAULT 1,
              uses INTEGER NOT NULL DEFAULT 0,
              active INTEGER NOT NULL DEFAULT 1,
              created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
              created_at TEXT NOT NULL
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS promo_redemptions(
              id SERIAL PRIMARY KEY,
              code TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              redeemed_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_user_unique ON promo_redemptions(code, user_id)""")
        # promo migration: add columns that may be missing on old tables
        for _alt in [
            "ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS uses INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS created_by INTEGER",
        ]:
            try:
                con.execute(_alt)
            except Exception:
                pass
        # promo_redemptions migration
        try:
            con.execute("ALTER TABLE promo_redemptions ADD COLUMN IF NOT EXISTS redeemed_at TEXT")
        except Exception:
            pass

        # Discount promo codes (for shop/robux percentage/fixed discounts)
        con.execute("""
            CREATE TABLE IF NOT EXISTS discount_codes(
              code TEXT PRIMARY KEY,
              discount_type TEXT NOT NULL DEFAULT 'percent',
              discount_value REAL NOT NULL DEFAULT 0,
              min_purchase REAL NOT NULL DEFAULT 0,
              max_uses INTEGER NOT NULL DEFAULT 1,
              uses INTEGER NOT NULL DEFAULT 0,
              applies_to TEXT NOT NULL DEFAULT 'all',
              note TEXT NOT NULL DEFAULT '',
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              expires_at TEXT
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS discount_redemptions(
              id SERIAL PRIMARY KEY,
              code TEXT NOT NULL,
              user_id INTEGER NOT NULL,
              order_type TEXT NOT NULL DEFAULT '',
              discount_amount REAL NOT NULL DEFAULT 0,
              redeemed_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_user_unique ON discount_redemptions(code, user_id)""")

        # Reviews
        con.execute("""
            CREATE TABLE IF NOT EXISTS reviews(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              username TEXT NOT NULL,
              rating INTEGER NOT NULL DEFAULT 5,
              text TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              created_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, id DESC)""")

        # OTP store for email verification / reset
        con.execute("""
            CREATE TABLE IF NOT EXISTS email_otps(
              id SERIAL PRIMARY KEY,
              email TEXT NOT NULL,
              purpose TEXT NOT NULL,
              code_hash TEXT NOT NULL,
              payload TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_otps_lookup ON email_otps(email, purpose)""")
        # templates (one row per user)
        con.execute("""
            CREATE TABLE IF NOT EXISTS templates(
              user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
              title_tpl TEXT NOT NULL,
              desc_tpl TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        # chat history
        con.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              ts TEXT NOT NULL
            )
        """)

        # user notifications (admin -> user)
        con.execute("""
            CREATE TABLE IF NOT EXISTS user_notifications(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              text TEXT NOT NULL,
              created_at TEXT NOT NULL,
              is_read INTEGER NOT NULL DEFAULT 0
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_un_user_read ON user_notifications(user_id, is_read, id DESC)""")

        # simple IP -> Geo cache (best-effort)
        con.execute("""
            CREATE TABLE IF NOT EXISTS ip_geo_cache(
              ip TEXT PRIMARY KEY,
              country TEXT,
              city TEXT,
              fetched_at TEXT NOT NULL
            )
        """)

        # shop layout/config (admin editable)
        con.execute("""
            CREATE TABLE IF NOT EXISTS shop_config(
              id SERIAL PRIMARY KEY,
              key TEXT UNIQUE NOT NULL,
              json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        # site settings (admin configurable)
        con.execute("""
            CREATE TABLE IF NOT EXISTS site_settings(
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)


        # telegram links for bot integration
        con.execute("""
            CREATE TABLE IF NOT EXISTS telegram_links(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              telegram_id BIGINT UNIQUE NOT NULL,
              telegram_username TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_telegram_links_user ON telegram_links(user_id, id DESC)")
        con.execute("""
            CREATE TABLE IF NOT EXISTS telegram_link_codes(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              code_hash TEXT UNIQUE NOT NULL,
              expires_at TEXT NOT NULL,
              used_at TEXT,
              created_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user ON telegram_link_codes(user_id, id DESC)")


        # Robux orders (shop item)
        con.execute("""
            CREATE TABLE IF NOT EXISTS robux_orders(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              robux_amount INTEGER NOT NULL,
              rub_price INTEGER NOT NULL,
              gamepass_price INTEGER NOT NULL,
              gamepass_url TEXT NOT NULL,
              gamepass_id BIGINT,
              product_id BIGINT,
              gamepass_name TEXT,
              gamepass_owner TEXT,
              gamepass_owner_id BIGINT,
              status TEXT NOT NULL DEFAULT 'new',
              error_message TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        con.execute("""CREATE INDEX IF NOT EXISTS idx_robux_orders_user ON robux_orders(user_id, id DESC)""")
        con.execute("""CREATE INDEX IF NOT EXISTS idx_robux_orders_status ON robux_orders(status, id DESC)""")

        # Robux order lifecycle columns (migrations)
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS reserved_at TEXT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS reserve_expires_ts BIGINT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS hold_taken INTEGER NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS refund_taken INTEGER NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS refunded_at TEXT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS paid_at TEXT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS done_at TEXT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS done_ts BIGINT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS cancelled_at TEXT")
        con.execute("CREATE INDEX IF NOT EXISTS idx_robux_orders_res_exp ON robux_orders(reserve_expires_ts)")

        # Roblox seller accounts pool (cookies)
        con.execute("""
            CREATE TABLE IF NOT EXISTS roblox_accounts(
              id SERIAL PRIMARY KEY,
              label TEXT,
              cookie_enc TEXT NOT NULL,
              roblox_user_id BIGINT,
              roblox_username TEXT,
              robux_balance INTEGER NOT NULL DEFAULT 0,
              is_active INTEGER NOT NULL DEFAULT 1,
              last_check_at TEXT,
              last_error TEXT,
              created_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_roblox_accounts_active ON roblox_accounts(is_active)")

        # Queue/cancel columns for robux_orders
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS queue_position INTEGER")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS estimated_delivery TEXT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT")
        con.execute("ALTER TABLE robux_orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT")

        # Shop inventory
        con.execute("""
            CREATE TABLE IF NOT EXISTS shop_inventory(
              id SERIAL PRIMARY KEY,
              product_id TEXT NOT NULL,
              item_type TEXT NOT NULL DEFAULT 'digital',
              data_json TEXT NOT NULL DEFAULT '{}',
              sold INTEGER NOT NULL DEFAULT 0,
              sold_at TEXT,
              sold_to_user_id INTEGER,
              voucher_id INTEGER,
              created_at TEXT NOT NULL DEFAULT ''
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_shop_inv_product ON shop_inventory(product_id, sold)")

        # Shop vouchers
        con.execute("""
            CREATE TABLE IF NOT EXISTS shop_vouchers(
              id SERIAL PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              product_id TEXT NOT NULL,
              uses_total INTEGER NOT NULL DEFAULT 1,
              uses_left INTEGER NOT NULL DEFAULT 1,
              created_by INTEGER,
              note TEXT,
              expires_at TEXT,
              created_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_shop_vouchers_code ON shop_vouchers(code)")
        con.execute("""
            CREATE TABLE IF NOT EXISTS shop_voucher_uses(
              id SERIAL PRIMARY KEY,
              voucher_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              used_at TEXT NOT NULL
            )
        """)


        # Robux vouchers (redeemable codes that credit balance for Robux purchases)
        con.execute("""
            CREATE TABLE IF NOT EXISTS robux_vouchers(
              id SERIAL PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              robux_amount INTEGER NOT NULL,
              rub_value INTEGER NOT NULL DEFAULT 0,
              uses_total INTEGER NOT NULL DEFAULT 1,
              uses_left INTEGER NOT NULL DEFAULT 1,
              created_by INTEGER,
              note TEXT,
              source TEXT,
              source_ref TEXT,
              expires_at TEXT,
              created_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_robux_vouchers_code ON robux_vouchers(code)")
        con.execute("""
            CREATE TABLE IF NOT EXISTS robux_voucher_uses(
              id SERIAL PRIMARY KEY,
              voucher_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              credited_balance INTEGER NOT NULL DEFAULT 0,
              used_at TEXT NOT NULL
            )
        """)

        # User purchases
        con.execute("""
            CREATE TABLE IF NOT EXISTS user_purchases(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL,
              product_id TEXT NOT NULL,
              product_title TEXT NOT NULL DEFAULT '',
              item_type TEXT NOT NULL DEFAULT 'digital',
              delivery_json TEXT NOT NULL DEFAULT '{}',
              price INTEGER NOT NULL DEFAULT 0,
              note TEXT DEFAULT '',
              ts TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_user_purchases_user ON user_purchases(user_id, id DESC)")

        # Support tickets
        con.execute("""
            CREATE TABLE IF NOT EXISTS support_tickets(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              subject TEXT NOT NULL DEFAULT '',
              category TEXT NOT NULL DEFAULT 'other',
              status TEXT NOT NULL DEFAULT 'open',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id)")
        con.execute("""
            CREATE TABLE IF NOT EXISTS support_messages(
              id SERIAL PRIMARY KEY,
              ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
              sender_id INTEGER,
              sender TEXT NOT NULL DEFAULT 'user',
              is_admin INTEGER NOT NULL DEFAULT 0,
              text TEXT NOT NULL,
              ts TEXT NOT NULL,
              attachment_url TEXT,
              created_at TEXT
            )
        """)
        # Migration: add missing columns
        con.execute("ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'")
        con.execute("ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS sender_id INTEGER")
        con.execute("ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS attachment_url TEXT")
        # ip_geo_cache proxy_data column
        try:
            con.execute("ALTER TABLE ip_geo_cache ADD COLUMN proxy_data TEXT")
        except Exception:
            pass
        con.execute("ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS created_at TEXT")

        # User tool history
        con.execute("""
            CREATE TABLE IF NOT EXISTS user_tool_history(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              tool TEXT NOT NULL,
              input TEXT,
              result TEXT,
              status TEXT NOT NULL DEFAULT 'ok',
              ts TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_user_tool_hist ON user_tool_history(user_id, tool)")

        # Key-value store (avatars, misc settings)
        con.execute("""
            CREATE TABLE IF NOT EXISTS site_kv(
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )
        """)

        # Legacy tool history (some endpoints use this)
        con.execute("""
            CREATE TABLE IF NOT EXISTS tool_history(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL,
              tool TEXT NOT NULL,
              input TEXT,
              output TEXT,
              status TEXT NOT NULL DEFAULT 'ok',
              created_at TEXT NOT NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_tool_hist_user ON tool_history(user_id, created_at DESC)")

        # ── Ensure discount tables exist (migration for existing PG DBs) ──
        for _disc_tbl in [
            """CREATE TABLE IF NOT EXISTS discount_codes(code TEXT PRIMARY KEY, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value REAL NOT NULL DEFAULT 0, min_purchase REAL NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, applies_to TEXT NOT NULL DEFAULT 'all', note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT)""",
            """CREATE TABLE IF NOT EXISTS discount_redemptions(id SERIAL PRIMARY KEY, code TEXT NOT NULL, user_id INTEGER NOT NULL, order_type TEXT NOT NULL DEFAULT '', discount_amount REAL NOT NULL DEFAULT 0, redeemed_at TEXT NOT NULL)""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_user_unique ON discount_redemptions(code, user_id)",
        ]:
            try:
                con.execute(_disc_tbl)
            except Exception:
                pass

        con.commit()
        con.close()
        return

    # SQLite (local dev)
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    con = db_conn()
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
    """)

    # Migrations: email fields
    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "email" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN email TEXT")
    if "email_verified" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0")

    # Migrations: credits/premium/case/balance/admin
    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "credits_analyze" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN credits_analyze INTEGER NOT NULL DEFAULT 3")
    if "credits_ai" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN credits_ai INTEGER NOT NULL DEFAULT 10")
    if "premium_until" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN premium_until TEXT")
    if "case_next_at" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN case_next_at TEXT")
    if "case_money_next_at" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN case_money_next_at TEXT")
    if "balance" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0")
        con.commit()  # immediate commit for balance column
    if "is_admin" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    if "avatar_url" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")

    # Migrations: profile avatar
    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "avatar_url" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")

    # Robux orders
    cur.execute("""
        CREATE TABLE IF NOT EXISTS robux_orders(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          robux_amount INTEGER NOT NULL,
          rub_price INTEGER NOT NULL,
          gamepass_price INTEGER NOT NULL,
          gamepass_url TEXT NOT NULL,
          gamepass_id INTEGER,
          product_id INTEGER,
          gamepass_name TEXT,
          gamepass_owner TEXT,
          gamepass_owner_id INTEGER,
          status TEXT NOT NULL DEFAULT 'new',
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_robux_orders_user ON robux_orders(user_id, id DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_robux_orders_status ON robux_orders(status, id DESC)")


    # Robux order lifecycle columns (migrations)
    ro_cols = [r["name"] for r in con.execute("PRAGMA table_info(robux_orders)").fetchall()]
    if "reserved_at" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN reserved_at TEXT")
    if "reserve_expires_ts" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN reserve_expires_ts INTEGER")
    if "hold_taken" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN hold_taken INTEGER NOT NULL DEFAULT 0")
    if "refund_taken" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN refund_taken INTEGER NOT NULL DEFAULT 0")
    if "refunded_at" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN refunded_at TEXT")
    if "paid_at" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN paid_at TEXT")
    if "done_at" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN done_at TEXT")
    if "done_ts" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN done_ts INTEGER")
    if "cancelled_at" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN cancelled_at TEXT")
    if "queue_position" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN queue_position INTEGER")
    if "estimated_delivery" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN estimated_delivery TEXT")
    if "cancel_reason" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN cancel_reason TEXT")
    if "cancelled_by" not in ro_cols:
        con.execute("ALTER TABLE robux_orders ADD COLUMN cancelled_by TEXT")

    # Roblox seller accounts pool (cookies)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS roblox_accounts(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT,
          cookie_enc TEXT NOT NULL,
          roblox_user_id INTEGER,
          roblox_username TEXT,
          robux_balance INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          last_check_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL
        )
    """)


    cur.execute("""
        CREATE TABLE IF NOT EXISTS telegram_links(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          telegram_id INTEGER NOT NULL UNIQUE,
          telegram_username TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_telegram_links_user ON telegram_links(user_id, id DESC)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS telegram_link_codes(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          code_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user ON telegram_link_codes(user_id, id DESC)")

    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "twofa_email_enabled" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN twofa_email_enabled INTEGER NOT NULL DEFAULT 0")
    if "hide_2fa_reminder" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN hide_2fa_reminder INTEGER NOT NULL DEFAULT 0")

    # Migrations: moderation / audit fields
    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "banned_until" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN banned_until TEXT")
    if "ban_reason" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN ban_reason TEXT")
    if "last_ip" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN last_ip TEXT")
        try:
            con.execute("ALTER TABLE users ADD COLUMN timezone TEXT")
        except Exception:
            pass
    if "last_country" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN last_country TEXT")
    if "last_city" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN last_city TEXT")
    if "last_seen_at" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN last_seen_at TEXT")


    # Stripe subscription fields
    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "stripe_customer_id" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT")
    if "stripe_sub_id" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN stripe_sub_id TEXT")
    if "stripe_sub_status" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN stripe_sub_status TEXT")
    if "stripe_sub_period_end" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN stripe_sub_period_end TEXT")

    # Settings columns
    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "notif_newsletter" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN notif_newsletter INTEGER NOT NULL DEFAULT 1")
    if "notif_site" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN notif_site INTEGER NOT NULL DEFAULT 1")
    if "ui_language" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN ui_language TEXT NOT NULL DEFAULT 'ru'")
    if "ui_currency" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN ui_currency TEXT NOT NULL DEFAULT 'rub'")
    if "ui_balance_short" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN ui_balance_short INTEGER NOT NULL DEFAULT 0")

    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")

    # OTP store for email verification / reset
    cur.execute("""
        CREATE TABLE IF NOT EXISTS email_otps(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          purpose TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          payload TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_otps_lookup ON email_otps(email, purpose)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS templates(
          user_id INTEGER PRIMARY KEY,
          title_tpl TEXT NOT NULL,
          desc_tpl TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          ts TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS balance_tx(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          admin_id INTEGER,
          delta INTEGER NOT NULL,
          reason TEXT,
          ts TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE SET NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_balance_tx_user_ts ON balance_tx(user_id, ts)")

    # user notifications (admin -> user)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_notifications(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          is_read INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_un_user_read ON user_notifications(user_id, is_read, id DESC)")

    # Tool usage history (checker, descriptions, etc.)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tool_history(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          tool TEXT NOT NULL,
          input_short TEXT,
          result_short TEXT,
          status TEXT DEFAULT 'ok',
          created_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tool_hist_user ON tool_history(user_id, created_at DESC)")

    # simple IP -> Geo cache (best-effort)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ip_geo_cache(
          ip TEXT PRIMARY KEY,
          country TEXT,
          city TEXT,
          fetched_at TEXT NOT NULL
        )
    """)

    # shop layout/config (admin editable)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS shop_config(
          key TEXT PRIMARY KEY,
          json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
    """)

    # site settings (admin configurable)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS site_settings(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS payments(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          kind TEXT NOT NULL,
          session_id TEXT UNIQUE NOT NULL,
          amount_points INTEGER NOT NULL DEFAULT 0,
          amount_total INTEGER NOT NULL DEFAULT 0,
          currency TEXT NOT NULL,
          status TEXT NOT NULL,
          meta TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at)")

    # Topups (balance)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS topups(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          method TEXT NOT NULL,
          points INTEGER NOT NULL,
          fiat_cents INTEGER NOT NULL DEFAULT 0,
          fiat_currency TEXT,
          invoice_id TEXT,
          pay_url TEXT,
          status TEXT NOT NULL,
          credited INTEGER NOT NULL DEFAULT 0,
          meta TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_topups_user_created ON topups(user_id, created_at)")

    # Premium orders
    cur.execute("""
        CREATE TABLE IF NOT EXISTS premium_orders(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL DEFAULT 'cryptopay',
          user_id INTEGER NOT NULL,
          plan_id TEXT NOT NULL DEFAULT '',
          days INTEGER NOT NULL,
          price_rub INTEGER NOT NULL DEFAULT 0,
          fiat_cents INTEGER NOT NULL DEFAULT 0,
          fiat_currency TEXT,
          invoice_id TEXT,
          pay_url TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          applied INTEGER NOT NULL DEFAULT 0,
          meta TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_premium_orders_user ON premium_orders(user_id, id DESC)")

    # Promo codes
    cur.execute("""
        CREATE TABLE IF NOT EXISTS promo_codes(
          code TEXT PRIMARY KEY,
          points INTEGER NOT NULL DEFAULT 0,
          max_uses INTEGER NOT NULL DEFAULT 1,
          uses INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1,
          created_by INTEGER,
          created_at TEXT NOT NULL
        )
    """)

    # Promo redemptions
    cur.execute("""
        CREATE TABLE IF NOT EXISTS promo_redemptions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          redeemed_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_user_unique ON promo_redemptions(code, user_id)")

    # Discount promo codes
    cur.execute("""
        CREATE TABLE IF NOT EXISTS discount_codes(
          code TEXT PRIMARY KEY,
          discount_type TEXT NOT NULL DEFAULT 'percent',
          discount_value REAL NOT NULL DEFAULT 0,
          min_purchase REAL NOT NULL DEFAULT 0,
          max_uses INTEGER NOT NULL DEFAULT 1,
          uses INTEGER NOT NULL DEFAULT 0,
          applies_to TEXT NOT NULL DEFAULT 'all',
          note TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          expires_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS discount_redemptions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          order_type TEXT NOT NULL DEFAULT '',
          discount_amount REAL NOT NULL DEFAULT 0,
          redeemed_at TEXT NOT NULL
        )
    """)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_user_unique ON discount_redemptions(code, user_id)")

    # Shop inventory/vouchers migration for existing DBs
    for _new_tbl in [
        """CREATE TABLE IF NOT EXISTS shop_inventory(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id TEXT NOT NULL,
          item_type TEXT NOT NULL DEFAULT 'digital',
          data_json TEXT NOT NULL DEFAULT '{}',
          sold INTEGER NOT NULL DEFAULT 0,
          sold_at TEXT,
          sold_to_user_id INTEGER,
          voucher_id INTEGER,
          created_at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS idx_shop_inv_product ON shop_inventory(product_id, sold)",
        """CREATE TABLE IF NOT EXISTS shop_vouchers(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          product_id TEXT NOT NULL,
          uses_total INTEGER NOT NULL DEFAULT 1,
          uses_left INTEGER NOT NULL DEFAULT 1,
          created_by INTEGER,
          note TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS idx_shop_vouchers_code ON shop_vouchers(code)",
        """CREATE TABLE IF NOT EXISTS shop_voucher_uses(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          voucher_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          inventory_id INTEGER,
          used_at TEXT NOT NULL
        )""",
    ]:
        try:
            cur.execute(_new_tbl)
        except Exception:
            pass

    # Ensure tables that were added later exist
    for _new_tbl2 in [
        """CREATE TABLE IF NOT EXISTS user_purchases(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          product_id TEXT NOT NULL,
          product_title TEXT NOT NULL DEFAULT '',
          item_type TEXT NOT NULL DEFAULT 'digital',
          delivery_json TEXT NOT NULL DEFAULT '{}',
          price INTEGER NOT NULL DEFAULT 0,
          note TEXT DEFAULT '',
          ts TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS balance_tx(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          admin_id INTEGER,
          delta INTEGER NOT NULL DEFAULT 0,
          reason TEXT NOT NULL DEFAULT '',
          ts TEXT NOT NULL
        )""",
    ]:
        try:
            cur.execute(_new_tbl2)
        except Exception:
            pass

    # Schema migrations: add columns that may be missing on old tables
    for _alt in [
        # shop_inventory: add voucher_id column (added in a later version)
        "ALTER TABLE shop_inventory ADD COLUMN voucher_id INTEGER",
        # promo migrations
        "ALTER TABLE promo_codes ADD COLUMN points INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE promo_codes ADD COLUMN uses INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE promo_codes ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE promo_codes ADD COLUMN created_by INTEGER",
        "ALTER TABLE promo_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1",
    ]:
        try:
            cur.execute(_alt)
        except Exception:
            pass
    # promo_redemptions migration
    try:
        cur.execute("ALTER TABLE promo_redemptions ADD COLUMN redeemed_at TEXT")
    except Exception:
        pass

    # Reviews
    cur.execute("""
        CREATE TABLE IF NOT EXISTS reviews(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          rating INTEGER NOT NULL DEFAULT 5,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, id DESC)")

    # Shop inventory — deliverable items per product
    cur.execute("""
        CREATE TABLE IF NOT EXISTS shop_inventory(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id TEXT NOT NULL,
          item_type TEXT NOT NULL DEFAULT 'digital',
          data_json TEXT NOT NULL DEFAULT '{}',
          sold INTEGER NOT NULL DEFAULT 0,
          sold_at TEXT,
          sold_to_user_id INTEGER,
          voucher_id INTEGER,
          created_at TEXT NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_shop_inv_product ON shop_inventory(product_id, sold)")

    # Shop vouchers — single-use or multi-use free purchase codes
    cur.execute("""
        CREATE TABLE IF NOT EXISTS shop_vouchers(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          product_id TEXT NOT NULL,
          uses_total INTEGER NOT NULL DEFAULT 1,
          uses_left INTEGER NOT NULL DEFAULT 1,
          created_by INTEGER,
          note TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_shop_vouchers_code ON shop_vouchers(code)")

    # Voucher use log
    cur.execute("""
        CREATE TABLE IF NOT EXISTS shop_voucher_uses(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          voucher_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          inventory_id INTEGER,
          used_at TEXT NOT NULL
        )
    """)

    # site key-value store (maintenance mode, etc.)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS site_kv(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
    """)

    # support tickets
    cur.execute("""
        CREATE TABLE IF NOT EXISTS support_tickets(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          subject TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'other',
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL,
          updated_at TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    try:
        cur.execute("ALTER TABLE support_tickets ADD COLUMN category TEXT NOT NULL DEFAULT 'other'")
    except Exception:
        pass
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status, id DESC)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS support_messages(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id INTEGER NOT NULL,
          sender_id INTEGER NOT NULL,
          is_admin INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_smsg_ticket ON support_messages(ticket_id, id)")
    # Migration: add attachment_url if missing
    try:
        cur.execute("ALTER TABLE support_messages ADD COLUMN attachment_url TEXT")
    except Exception:
        pass  # already exists

    if USE_PG:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS support_ai_chats(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              ts TEXT NOT NULL,
              escalated INTEGER NOT NULL DEFAULT 0,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
    else:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS support_ai_chats(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              ts TEXT NOT NULL,
              escalated INTEGER NOT NULL DEFAULT 0,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ai_chats_user ON support_ai_chats(user_id, id DESC)")

    # Multi-chat AI system tables
    if USE_PG:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ai_chats(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              title TEXT NOT NULL DEFAULT 'Новый чат',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ai_chat_msgs(
              id SERIAL PRIMARY KEY,
              chat_id INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
        """)
    else:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ai_chats(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              title TEXT NOT NULL DEFAULT 'Новый чат',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ai_chat_msgs(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              chat_id INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
        """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ai_chats_user_upd ON ai_chats(user_id, updated_at DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ai_msgs_chat ON ai_chat_msgs(chat_id, id ASC)")

    # Review reports (complaints) table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS review_reports(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id INTEGER NOT NULL,
          reporter_id INTEGER NOT NULL,
          reporter_username TEXT NOT NULL DEFAULT '',
          reported_user_id INTEGER NOT NULL DEFAULT 0,
          reported_username TEXT NOT NULL DEFAULT '',
          review_text TEXT NOT NULL DEFAULT '',
          review_rating INTEGER NOT NULL DEFAULT 0,
          reason TEXT NOT NULL DEFAULT 'Spam/Abuse',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          resolved_by INTEGER
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_rev_reports_status ON review_reports(status, id DESC)")

    # User warns table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_warns(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          admin_id INTEGER NOT NULL,
          admin_username TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_user_warns_uid ON user_warns(user_id, id DESC)")

    # Migrate users: add warn_count if missing
    try:
        cur.execute("ALTER TABLE users ADD COLUMN warn_count INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass

    # Card/SBP invoice topup table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS card_invoices(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          amount_rub INTEGER NOT NULL,
          amount_kopecks INTEGER NOT NULL DEFAULT 0,
          exact_amount_str TEXT NOT NULL,
          points INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          receipt_b64 TEXT,
          ai_result TEXT,
          ai_confidence REAL,
          admin_note TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          verified_at TEXT,
          credited INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_card_inv_user ON card_invoices(user_id, id DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_card_inv_status ON card_invoices(status, id DESC)")

    # ── Ensure discount tables exist (migration for existing DBs) ──
    for _disc_tbl in [
        """CREATE TABLE IF NOT EXISTS discount_codes(code TEXT PRIMARY KEY, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value REAL NOT NULL DEFAULT 0, min_purchase REAL NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, applies_to TEXT NOT NULL DEFAULT 'all', note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, expires_at TEXT)""",
        """CREATE TABLE IF NOT EXISTS discount_redemptions(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, user_id INTEGER NOT NULL, order_type TEXT NOT NULL DEFAULT '', discount_amount REAL NOT NULL DEFAULT 0, redeemed_at TEXT NOT NULL)""",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_user_unique ON discount_redemptions(code, user_id)",
    ]:
        try:
            cur.execute(_disc_tbl)
        except Exception:
            pass


    con.commit()
    con.close()

    # Load settings
    try:
        _load_site_settings()
    except Exception:
        pass
def cookie_secure(request: Request) -> bool:
    # Render/Proxy usually sets x-forwarded-proto=https
    proto = (request.headers.get("x-forwarded-proto") or "").lower()
    if proto == "https":
        return True
    fwd = (request.headers.get("forwarded") or "").lower()
    if "proto=https" in fwd:
        return True
    return False

def make_token(uid: int, username: str) -> str:
    payload = {
        "uid": uid,
        "username": username,
        "iat": int(datetime.datetime.utcnow().timestamp()),
        "exp": int((datetime.datetime.utcnow() + datetime.timedelta(days=14)).timestamp()),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)

def read_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALG])
    except JWTError:
        return None

def _now_utc() -> datetime.datetime:
    return datetime.datetime.utcnow()

def _now_utc_iso() -> str:
    return _now_utc().isoformat()

def _parse_iso(dt_str: str) -> Optional[datetime.datetime]:
    if not dt_str:
        return None
    try:
        return datetime.datetime.fromisoformat(dt_str)
    except Exception:
        return None

def user_limits(uid: int) -> Dict[str, Any]:
    con = db_conn()
    row = con.execute(
        "SELECT credits_analyze, credits_ai, premium_until, case_next_at, case_money_next_at, warn_count FROM users WHERE id=?",
        (uid,),
    ).fetchone()
    # Count paid cases today
    paid_today = 0
    inv_count = 0
    try:
        today_start = datetime.datetime.utcnow().strftime("%Y-%m-%dT00:00:00")
        ptrow = con.execute("SELECT COUNT(*) as cnt FROM case_spins WHERE user_id=? AND ts>=?", (uid, today_start)).fetchone()
        paid_today = _count_val(ptrow, "cnt")
    except Exception:
        pass
    try:
        inv_count = _case_inventory_count_unused(con, uid)
    except Exception:
        pass
    con.close()
    if not row:
        return {"credits_analyze": 0, "credits_ai": 0, "premium_until": None, "premium": False, "case_next_at": None, "case_money_next_at": None,
                "case_paid_today": 0, "case_paid_daily_limit": CASE_PAID_DAILY_LIMIT, "case_inv_count": 0, "case_inv_max": CASE_INV_MAX}
    pu = _parse_iso(_rget(row, "premium_until") or "")
    premium = bool(pu and _now_utc() < pu)
    # Auto-clear expired premium from DB
    raw_pu = _rget(row, "premium_until") or None
    if raw_pu and not premium:
        try:
            con2 = db_conn()
            con2.execute("UPDATE users SET premium_until=NULL WHERE id=?", (uid,))
            con2.commit()
            con2.close()
        except Exception:
            pass
        raw_pu = None
    return {
        "credits_analyze": int(_rget(row, "credits_analyze") or 0),
        "credits_ai": int(_rget(row, "credits_ai") or 0),
        "premium_until": raw_pu,
        "premium": premium,
        "case_next_at": (_rget(row, "case_next_at") or None),
        "case_money_next_at": (_rget(row, "case_money_next_at") or None),
        "case_paid_today": paid_today,
        "case_paid_daily_limit": CASE_PAID_DAILY_LIMIT,
        "case_inv_count": inv_count,
        "case_inv_max": CASE_INV_MAX,
        "warn_count": int(_rget(row, "warn_count") or 0),
    }


# Backward-compatible alias (some endpoints used get_user_limits)
def get_user_limits(uid: int) -> Dict[str, Any]:
    return user_limits(uid)

def _check_user_ban(uid: int) -> None:
    """Raise 403 if user is currently banned. Best-effort — doesn't block on DB error."""
    try:
        con = db_conn()
        row = con.execute("SELECT banned_until, ban_reason FROM users WHERE id=?", (uid,)).fetchone()
        con.close()
        if not row:
            return
        banned_until = _rget(row, "banned_until")
        if not banned_until:
            return
        bu = _parse_iso(str(banned_until))
        if bu and _now_utc() < bu:
            reason = str(_rget(row, "ban_reason") or "Banned").strip()
            raise HTTPException(status_code=403, detail=f"Banned: {reason}")
    except HTTPException:
        raise
    except Exception:
        pass  # fail open — don't block users on DB error


def require_user(request: Request) -> Dict[str, Any]:
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Auth required")
    _check_user_ban(int(u["id"]))
    return u

def require_premium(request: Request) -> Dict[str, Any]:
    u = require_user(request)
    lim = user_limits(int(u["id"]))
    if not lim["premium"]:
        raise HTTPException(status_code=403, detail="Premium required")
    return u

def spend_credit(uid: int, field: str, amount: int = 1):
    # safe decrement (never below 0)
    con = db_conn()
    con.execute(
        f"UPDATE users SET {field}=CASE WHEN {field}>=? THEN {field}-? ELSE {field} END WHERE id=?",
        (amount, amount, uid),
    )
    con.commit()
    con.close()

def get_current_user(request: Request) -> Optional[Dict[str, Any]]:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    data = read_token(token)
    if not data:
        return None
    uid = int(data.get("uid", 0) or 0)
    username = str(data.get("username", "") or "")
    if not uid or not username:
        return None
    return {"id": uid, "username": username}
def sync_admin_users():
    """Mark usernames from ADMIN_USERS as admins (non-destructive)."""
    if not ADMIN_USERS_LC:
        return
    con = db_conn()
    for uname in ADMIN_USERS_LC:
        con.execute("UPDATE users SET is_admin=1 WHERE lower(username)=?", (uname,))
    con.commit()
    con.close()

def get_user_row(uid: int) -> Optional[Dict[str, Any]]:
    con = db_conn()
    row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at, premium_until, case_next_at, case_money_next_at FROM users WHERE id=?", (uid,)).fetchone()
    con.close()
    if not row:
        return None
    return {
        "id": int(_rget(row, "id") or 0),
        "username": str(_rget(row, "username") or ""),
        "email": str(_rget(row, "email") or ""),
        "balance": int(_rget(row, "balance") or 0),
        "is_admin": int(_rget(row, "is_admin") or 0),
    }

def require_admin(request: Request) -> Dict[str, Any]:
    u = require_user(request)
    # DB flag first
    con = db_conn()
    row = con.execute("SELECT is_admin FROM users WHERE id=?", (u["id"],)).fetchone()
    con.close()
    is_admin = int(_rget(row, "is_admin") or 0) == 1
    # fallback: env list
    if not is_admin and (u["username"] or "").lower() in ADMIN_USERS_LC:
        is_admin = True
    # Auto-admin: user ID 1 is always admin
    if not is_admin and int(u["id"]) == 1:
        is_admin = True
        try:
            con2 = db_conn()
            con2.execute("UPDATE users SET is_admin=1 WHERE id=1")
            con2.commit()
            con2.close()
        except Exception:
            pass
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin required")
    return u




# ----------------------------
# IP + Geo helpers (best-effort)
# ----------------------------
def _client_ip(request: Request) -> str:
    # Render / proxies: trust X-Forwarded-For first hop
    try:
        xff = request.headers.get("x-forwarded-for") or request.headers.get("X-Forwarded-For")
        if xff:
            ip = xff.split(",")[0].strip()
            if ip:
                return ip
    except Exception:
        pass
    try:
        if request.client and request.client.host:
            return str(request.client.host)
    except Exception:
        pass
    return ""

def _geo_lookup_ip(ip: str) -> Tuple[str, str]:
    """Returns (country, city) for the given ip using a free public API. Best-effort."""
    ip = (ip or "").strip()
    if not ip or ip.startswith("127.") or ip == "0.0.0.0" or ip == "::1":
        return ("", "")
    try:
        # ipapi.co supports https://ipapi.co/<ip>/json/
        r = requests.get(f"https://ipapi.co/{ip}/json/", timeout=4)
        if r.status_code != 200:
            return ("", "")
        j = r.json() if r.text else {}
        country = (j.get("country_name") or j.get("country") or "").strip()
        city = (j.get("city") or "").strip()
        return (country, city)
    except Exception:
        return ("", "")

def _geo_cached(con, ip: str) -> Tuple[str, str]:
    ip = (ip or "").strip()
    if not ip:
        return ("", "")
    try:
        row = con.execute("SELECT country, city, fetched_at FROM ip_geo_cache WHERE ip=?", (ip,)).fetchone()
    except Exception:
        row = None
    if row:
        return (str(_rget(row, "country") or ""), str(_rget(row, "city") or ""))
    country, city = _geo_lookup_ip(ip)
    try:
        con.execute(
            "INSERT INTO ip_geo_cache(ip,country,city,fetched_at) VALUES(?,?,?,?) "
            "ON CONFLICT(ip) DO UPDATE SET country=excluded.country, city=excluded.city, fetched_at=excluded.fetched_at",
            (ip, country, city, _now_utc_iso()),
        )
    except Exception:
        try:
            con.execute("INSERT OR REPLACE INTO ip_geo_cache(ip,country,city,fetched_at) VALUES(?,?,?,?)", (ip, country, city, _now_utc_iso()))
        except Exception:
            pass
    return (country, city)

@app.get("/api/check/proxy")
def api_check_proxy(request: Request):
    """
    Check if the client IP is a confirmed VPN/Proxy/TOR.
    Uses proxycheck.io ONLY (no ip-api fallback — too many false positives).
    Strict mode: only blocks if proxycheck.io says proxy=yes with type=VPN/TOR/SOCKS.
    Residential IPs are NEVER blocked even if mislabelled.
    """
    ip = _client_ip(request)
    # Local / private / undetectable IPs → always pass
    if not ip or ip.startswith("127.") or ip.startswith("10.") or ip.startswith("192.168.") or ip == "::1" or ip == "0.0.0.0":
        return {"ok": True, "blocked": False, "ip": ip}

    try:
        con = db_conn()
        # Cache: 2 hours so a user who disables VPN needs to wait max 2h (short enough)
        cached = None
        try:
            cached = con.execute("SELECT proxy_data, fetched_at FROM ip_geo_cache WHERE ip=?", (ip,)).fetchone()
        except Exception:
            pass

        proxy_data_str = _rget(cached, "proxy_data") if cached else None
        cached_at = _rget(cached, "fetched_at") if cached else None
        cache_valid = False
        if proxy_data_str and cached_at:
            try:
                t_cached = _parse_iso(str(cached_at))
                if t_cached and (_now_utc() - t_cached).total_seconds() < 7200:  # 2h
                    cache_valid = True
            except Exception:
                pass

        if proxy_data_str and cache_valid:
            try:
                import json as _json
                pd = _json.loads(proxy_data_str)
                con.close()
                return {"ok": True, "blocked": pd.get("blocked", False), "ip": ip, "cached": True}
            except Exception:
                pass

        # ── proxycheck.io STRICT check ─────────────────────────────────────────
        # Only block if:
        #   1. proxycheck.io returns proxy=yes
        #   2. AND the type is one of: VPN, TOR, SOCKS, SOCKS4, SOCKS5
        # Residential-looking proxies → NOT blocked (too many false positives)
        blocked = False
        org = ""
        try:
            import json as _json
            r = requests.get(
                f"https://proxycheck.io/v2/{ip}?vpn=1&asn=1&risk=1",
                timeout=6
            )
            if r.status_code == 200:
                j = r.json()
                status = str(j.get("status", "")).lower()
                ip_data = j.get(ip, {})
                is_proxy = str(ip_data.get("proxy", "no")).lower() == "yes"
                proxy_type = str(ip_data.get("type", "")).lower()
                risk = int(ip_data.get("risk", 0) or 0)
                org = str(ip_data.get("provider", "") or ip_data.get("organisation", "") or "")

                # Only block definite VPN/TOR/datacenter proxy types with high risk
                # Do NOT block: "HTTP", "HTTPS", "Compromised Server" — too many false positives
                BLOCK_TYPES = {"vpn", "tor", "socks", "socks4", "socks5", "socks4/5"}
                type_blocked = any(t in proxy_type for t in BLOCK_TYPES)
                blocked = is_proxy and type_blocked and risk >= 33
        except Exception:
            # API failed → fail OPEN, never block
            blocked = False

        import json as _json
        proxy_json = _json.dumps({"blocked": blocked, "org": org})
        try:
            con.execute(
                "UPDATE ip_geo_cache SET proxy_data=?, fetched_at=? WHERE ip=?",
                (proxy_json, _now_utc_iso(), ip)
            )
            if con.execute("SELECT changes()").fetchone()[0] == 0:
                con.execute(
                    "INSERT OR IGNORE INTO ip_geo_cache(ip,country,city,fetched_at,proxy_data) VALUES(?,?,?,?,?)",
                    (ip, "", "", _now_utc_iso(), proxy_json)
                )
            con.commit()
        except Exception:
            pass
        con.close()
        return {"ok": True, "blocked": blocked, "ip": ip, "org": org}
    except Exception as e:
        try:
            con.close()
        except Exception:
            pass
        # Always fail open
        return {"ok": True, "blocked": False, "ip": ip}


@app.middleware("http")
async def add_cache_headers(request: Request, call_next):
    path = request.url.path or ""
    # Maintenance mode - allow admin APIs, auth, static, and certain paths
    if _SITE_SETTINGS.get("maintenance"):
        # Always safe: static files, admin API, auth, health, site status
        safe = (path.startswith("/static/") or path.startswith("/api/admin/") or
                path.startswith("/api/auth/") or path in ("/api/site/status", "/api/health"))
        is_admin_user = False
        if not safe:
            # Check session: admins fully bypass maintenance everywhere
            try:
                token = request.cookies.get(SESSION_COOKIE)
                if token:
                    data = read_token(token)
                    uid = data and data.get("uid")
                    if uid:
                        # Authenticated users can access their own account APIs
                        if path.startswith("/api/auth/") or path == "/api/balance" or path == "/api/notifications/unread_count":
                            safe = True
                        # Check admin flag — admins get full bypass
                        try:
                            con = db_conn()
                            row = con.execute("SELECT is_admin FROM users WHERE id=?", (int(uid),)).fetchone()
                            con.close()
                            if row and int(_rget(row, "is_admin") or 0) == 1:
                                is_admin_user = True
                                safe = True
                        except Exception:
                            pass
            except Exception:
                pass
        # Page-level handling
        if not safe and not path.startswith("/api/"):
            # For HTML pages: let `/`, `/v2`, `/v2/...` through so frontend can render maintenance overlay.
            # The frontend reads /api/site/status (which is in the safe list) and shows the overlay.
            if path == "/" or path == "/v2" or path.startswith("/v2/"):
                pass  # fall through to normal response
            else:
                from starlette.responses import HTMLResponse as _MR
                return _MR(f"<html><body style='background:#07060e;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px'><h2>🔧 Тех. работы</h2><p>{_SITE_SETTINGS.get('maintenance_msg','Скоро вернёмся')}</p></body></html>", status_code=503)
        elif not safe and path.startswith("/api/"):
            from starlette.responses import JSONResponse
            return JSONResponse({"detail": _SITE_SETTINGS.get("maintenance_msg", "Тех. работы"), "maintenance": True}, status_code=503)
    response = await call_next(request)
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    elif path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
    return response



@app.on_event("startup")
def _repair_all_balances():
    """Recalculate & sync user balances from transaction history if needed. Best-effort."""
    try:
        con = db_conn()
        # Simply verify balances are not NULL — set to 0 if so
        try:
            con.execute("UPDATE users SET balance = 0 WHERE balance IS NULL")
            con.commit()
        except Exception:
            pass
        con.close()
    except Exception:
        pass

@app.on_event("startup")
def _startup():
    # Reset CryptoPay URL cache so it's auto-detected fresh on first use
    global _CRYPTO_BASE_URL_CACHE
    _CRYPTO_BASE_URL_CACHE = ""

    if not USE_PG:
        import subprocess
        _log = logging.getLogger("rbx.startup")
        _is_mounted = False
        try:
            out = subprocess.check_output(["mount"], text=True, stderr=subprocess.DEVNULL)
            _is_mounted = any("/data" in line for line in out.splitlines())
        except Exception:
            pass
        if not _is_mounted:
            _log.warning(
                "⚠️  /data is NOT a mounted volume — DB at '%s' is EPHEMERAL! "
                "Add DATABASE_URL (PostgreSQL) in Railway variables, or add a Volume at /data", DB_PATH
            )
        else:
            _log.info("✅ SQLite DB at '%s' on persistent volume /data (set DATABASE_URL=postgresql://... to use PostgreSQL instead)", DB_PATH)
    else:
        logging.getLogger("rbx.startup").info("✅ PostgreSQL connected via DATABASE_URL")
    db_init()
    _repair_all_balances()
    try:
        ensure_profile_templates_schema()
    except Exception:
        pass
    sync_admin_users()
    try:
        _load_site_settings()
    except Exception:
        pass
    # Start background auto-cancellation thread
    _t = threading.Thread(target=_auto_cancel_worker, daemon=True)
    _t.start()
    logging.getLogger("rbx.startup").info("✅ Auto-cancel worker started (10 min timeout for pending orders/topups)")


# ─── Auto-cancellation background worker ───────────────────────────────────
_AUTO_CANCEL_INTERVAL = 60        # run every 60 seconds
_AUTO_CANCEL_TIMEOUT_SEC = 600    # 10 minutes

def _auto_cancel_worker():
    """Background thread: cancel stale pending orders/topups older than 10 minutes.
    Robux orders in 'reserved'/'queue' status are NOT cancelled (booking).
    """
    import time as _time
    _log = logging.getLogger("rbx.autocancel")
    while True:
        try:
            _run_auto_cancel()
        except Exception as e:
            _log.error("Auto-cancel error: %s", e)
        _time.sleep(_AUTO_CANCEL_INTERVAL)


def _poll_cryptopay_invoices(con, _log=None):
    """Poll CryptoPay API for status of pending invoices and credit any paid ones.
    This is a fallback when webhook is not configured or misses a payment.
    """
    if not cryptopay_enabled():
        return
    if _log is None:
        _log = logging.getLogger("rbx.autocancel")
    try:
        # Get all pending topup invoices
        pending_topups = con.execute(
            "SELECT id, invoice_id FROM topups WHERE provider='cryptopay' AND status='pending' AND invoice_id IS NOT NULL AND invoice_id != '' LIMIT 50"
        ).fetchall()
        pending_prems = con.execute(
            "SELECT id, invoice_id FROM premium_orders WHERE provider='cryptopay' AND status='pending' AND invoice_id IS NOT NULL AND invoice_id != '' LIMIT 20"
        ).fetchall()

        all_invoice_ids = []
        topup_map = {}   # invoice_id → topup row id
        prem_map  = {}   # invoice_id → premium_order row id

        for row in pending_topups:
            inv_id = str(_rget(row, "invoice_id") or "")
            if inv_id:
                all_invoice_ids.append(inv_id)
                topup_map[inv_id] = int(_rget(row, "id") or 0)
        for row in pending_prems:
            inv_id = str(_rget(row, "invoice_id") or "")
            if inv_id:
                all_invoice_ids.append(inv_id)
                prem_map[inv_id] = int(_rget(row, "id") or 0)

        if not all_invoice_ids:
            return

        # Call CryptoPay getInvoices (max 1000 ids per call, chunk by 100)
        ts = _now_utc_iso()
        for i in range(0, len(all_invoice_ids), 100):
            chunk = all_invoice_ids[i:i+100]
            try:
                result = _cryptopay_call("getInvoices", {"invoice_ids": ",".join(chunk)})
                items = result.get("items") or []
            except Exception as e:
                _log.warning("CryptoPay poll failed: %s", e)
                continue

            for inv in items:
                inv_id = str(inv.get("invoice_id") or inv.get("id") or "")
                status = str(inv.get("status") or "")

                if status == "paid" or status == "confirmed":
                    # Credit topup
                    if inv_id in topup_map:
                        tid = topup_map[inv_id]
                        credited = _credit_topup_once(con, tid, None, f"cryptopay poll {inv_id}")
                        if credited:
                            _log.info("Poll: credited topup #%d via invoice %s", tid, inv_id)

                    # Apply premium
                    if inv_id in prem_map:
                        pid = prem_map[inv_id]
                        prow = con.execute("SELECT user_id, days, applied FROM premium_orders WHERE id=?", (pid,)).fetchone()
                        if prow:
                            applied = int(_rget(prow, "applied") or 0)
                            if applied == 0:
                                uid = int(_rget(prow, "user_id") or 0)
                                days = int(_rget(prow, "days") or 0)
                                if uid and days > 0:
                                    _apply_premium(uid, datetime.timedelta(days=days))
                                    con.execute("UPDATE premium_orders SET applied=1, status='paid', updated_at=? WHERE id=?", (ts, pid))
                                    _log.info("Poll: applied premium #%d (%d days) via invoice %s", pid, days, inv_id)

                elif status in ("expired", "failed"):
                    if inv_id in topup_map:
                        con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=? AND status='pending'",
                                    (status, ts, topup_map[inv_id]))
                    if inv_id in prem_map:
                        con.execute("UPDATE premium_orders SET status=?, updated_at=? WHERE id=? AND status='pending'",
                                    (status, ts, prem_map[inv_id]))

        con.commit()
    except Exception as e:
        _log.error("Poll invoices error: %s", e)


def _run_auto_cancel():
    from datetime import datetime, timezone, timedelta
    _log = logging.getLogger("rbx.autocancel")
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(seconds=_AUTO_CANCEL_TIMEOUT_SEC)).isoformat()
    ts = _now_utc_iso()
    con = db_conn()
    try:
        # 0. Poll CryptoPay for pending invoices — credit any that have been paid
        _poll_cryptopay_invoices(con, _log)

        # 1. Cancel stale robux orders: only 'new'/'paid'/'processing' — NOT 'reserved' (booking) or 'queue'
        stale_robux = con.execute(
            "SELECT id, user_id, rub_price FROM robux_orders "
            "WHERE status IN ('new','paid','processing','error') AND created_at < ? AND cancelled_at IS NULL",
            (cutoff,)
        ).fetchall()
        for row in stale_robux:
            oid = int(_rget(row, "id") or 0)
            uid = int(_rget(row, "user_id") or 0)
            rub_price = int(_rget(row, "rub_price") or 0)
            try:
                cur = con.execute(
                    "UPDATE robux_orders SET status='expired', updated_at=?, cancelled_at=?, cancel_reason=? WHERE id=? AND status NOT IN ('done','cancelled','refunded','reserved','queue')",
                    (ts, ts, "Автоотмена: заказ не обработан более 10 минут", oid)
                )
                changed = getattr(cur, 'rowcount', 1)
                if changed and rub_price > 0:
                    _credit_balance_direct(con, uid, rub_price, f"Возврат: автоотмена заказа #{oid}")
                _log.info("Auto-cancelled robux order #%d (user %d, refund %d ₽)", oid, uid, rub_price)
            except Exception as e:
                _log.error("Failed to cancel order #%d: %s", oid, e)

        # 2. Cancel stale topups (pending crypto/cardlink only — not manual which need admin approval)
        stale_topups = con.execute(
            "SELECT id FROM topups WHERE status='pending' AND method IN ('crypto','cardlink') AND created_at < ?",
            (cutoff,)
        ).fetchall()
        for row in stale_topups:
            tid = int(_rget(row, "id") or 0)
            try:
                con.execute(
                    "UPDATE topups SET status='expired', updated_at=? WHERE id=? AND status='pending'",
                    (ts, tid)
                )
                _log.info("Auto-expired topup #%d", tid)
            except Exception as e:
                _log.error("Failed to expire topup #%d: %s", tid, e)

        # 3. Cancel stale premium orders (pending crypto)
        stale_prem = con.execute(
            "SELECT id FROM premium_orders WHERE status='pending' AND provider='cryptopay' AND created_at < ?",
            (cutoff,)
        ).fetchall()
        for row in stale_prem:
            pid = int(_rget(row, "id") or 0)
            try:
                con.execute(
                    "UPDATE premium_orders SET status='expired', updated_at=? WHERE id=? AND status='pending'",
                    (ts, pid)
                )
                _log.info("Auto-expired premium order #%d", pid)
            except Exception as e:
                _log.error("Failed to expire premium order #%d: %s", pid, e)

        con.commit()
    finally:
        con.close()

# templates/static are configured at the top using BASE_DIR

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    resp = templates.TemplateResponse("index.html", {"request": request, "build_version": BUILD_VERSION})
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/v2", response_class=HTMLResponse)
@app.get("/v2/", response_class=HTMLResponse)
@app.get("/v2/{subpath:path}", response_class=HTMLResponse)
def index_v2(request: Request, subpath: str = ""):
    """New experimental interface (v2). Same backend, fresh frontend."""
    resp = templates.TemplateResponse("v2.html", {"request": request, "build_version": BUILD_VERSION})
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/api/version")
def api_version():
    return {"ok": True, "version": BUILD_VERSION, "build": BUILD_TAG}

from fastapi.responses import Response, FileResponse

@app.head("/")
def head_root():
    return Response(status_code=200)

@app.get("/favicon.ico")
def favicon():
    fp = os.path.join("static", "favicon.ico")
    if os.path.exists(fp):
        return FileResponse(fp)
    return Response(status_code=204)


# ----------------------------
# Auth / Profile API
# ----------------------------
@app.get("/api/auth/me")
def auth_me(request: Request):
    u = get_current_user(request)
    if not u:
        return {"ok": True, "user": None}

    try:
        _touch_user_seen(int(u["id"]), request)
    except Exception:
        pass

    # Save timezone from header
    try:
        tz = (request.headers.get("x-timezone") or "").strip()[:64]
        if tz:
            _con = db_conn()
            _con.execute("UPDATE users SET timezone=? WHERE id=?", (tz, int(u["id"])))
            _con.commit()
            _con.close()
    except Exception:
        pass

    con = db_conn()
    row = con.execute(
        "SELECT username, email, balance, is_admin, twofa_email_enabled, hide_2fa_reminder, avatar_url FROM users WHERE id=?",
        (u["id"],),
    ).fetchone()
    # Get reliable balance (repairs if column is stale vs tx history)
    _reliable_bal = None
    if row:
        try:
            _reliable_bal = _get_user_balance_reliable(con, int(u["id"]))
        except Exception:
            _reliable_bal = int(_rget(row, "balance") or 0)
    # env fallback: allow making new users admins without restart
    db_admin = int(_rget(row, "is_admin") or 0) if row else 0
    env_admin = ((u["username"] or "").lower() in ADMIN_USERS_LC)
    # Auto-admin: user ID 1 is always admin
    id1_admin = (int(u["id"]) == 1)
    is_admin = 1 if (db_admin == 1 or env_admin or id1_admin) else 0
    if (env_admin or id1_admin) and db_admin != 1:
        try:
            con.execute("UPDATE users SET is_admin=1 WHERE id=?", (u["id"],))
            con.commit()
        except Exception:
            pass
    con.close()

    lim = user_limits(int(u["id"]))

    # Check ban status for full profile block
    con2 = db_conn()
    ban_row = con2.execute("SELECT banned_until, ban_reason, warn_count FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    con2.close()
    ban_until_str = str(_rget(ban_row, "banned_until") or "")
    ban_reason_str = str(_rget(ban_row, "ban_reason") or "")
    warn_cnt = int(_rget(ban_row, "warn_count") or 0)
    ban_active = False
    if ban_until_str:
        bu = _parse_iso(ban_until_str)
        if bu and _now_utc() < bu:
            ban_active = True

    # Frontend expects key fields on the top-level `user` object.
    return {"ok": True, "user": {
        "id": int(u["id"]),
        "username": (str(_rget(row, "username") or (u["username"] or "")) if row else (u["username"] or "")),
        "email": (_rget(row, "email") if row else ""),
        "balance": (_reliable_bal if _reliable_bal is not None else int(_rget(row, "balance") or 0)),
        "is_admin": is_admin,
        "twofa_email_enabled": int(_rget(row, "twofa_email_enabled") or 0) if row else 0,
        "hide_2fa_reminder": int(_rget(row, "hide_2fa_reminder") or 0) if row else 0,
        "avatar_url": (str(_rget(row, "avatar_url") or "") if row else ""),
        "banned": ban_active,
        "banned_until": ban_until_str if ban_active else "",
        "ban_reason": ban_reason_str if ban_active else "",
        "warn_count": warn_cnt,
        # flatten limits for UI widgets
        "credits_analyze": int(lim.get("credits_analyze") or 0),
        "credits_ai": int(lim.get("credits_ai") or 0),
        "premium_until": lim.get("premium_until"),
        "case_next_at": lim.get("case_next_at"),
        "case_money_next_at": lim.get("case_money_next_at"),
        "limits": lim,
    }}

@app.get("/api/balance")
def api_balance(request: Request):
    u = require_user(request)
    try:
        con = db_conn()
        bal = _get_user_balance_reliable(con, int(u["id"]))
        con.close()
    except Exception:
        bal = 0
    return {"ok": True, "balance": bal}

@app.get("/api/balance/history")
def api_balance_history(request: Request, limit: int = 20):
    """Get last N balance transactions for the current user."""
    u = require_user(request)
    try:
        con = db_conn()
        rows = con.execute(
            "SELECT delta, reason, ts FROM balance_tx WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (u["id"], max(1, min(limit, 50))),
        ).fetchall()
        con.close()
        txs = [{"delta": int(_rget(r,"delta") or 0), "reason": _rget(r,"reason") or "", "ts": _rget(r,"ts") or ""} for r in rows]
    except Exception:
        txs = []
    return {"ok": True, "history": txs}

@app.post("/api/balance/recalc")
def api_balance_recalc(request: Request):
    """Admin: recalculate balance from transaction history (repair tool)."""
    require_admin(request)
    payload = {}
    con = db_conn()
    try:
        users = con.execute("SELECT id FROM users").fetchall()
        fixed = 0
        for urow in users:
            uid = int(_rget(urow, "id") or 0)
            tx_row = con.execute("SELECT COALESCE(SUM(delta),0) as total FROM balance_tx WHERE user_id=?", (uid,)).fetchone()
            calc_bal = max(0, int(_rget(tx_row, "total") or 0))
            db_row = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
            db_bal = int(_rget(db_row, "balance") or 0)
            if calc_bal != db_bal:
                con.execute("UPDATE users SET balance=? WHERE id=?", (calc_bal, uid))
                fixed += 1
        con.commit()
        con.close()
        return {"ok": True, "fixed_users": fixed}
    except Exception as e:
        con.close()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/user/avatar")
async def api_user_avatar(request: Request, file: UploadFile = File(...)):
    """Upload user's avatar. Stored as base64 in site_kv table (no disk usage)."""
    u = require_user(request)
    uid = int(u["id"])
    data = await file.read()
    if len(data) > 3 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Файл слишком большой (до 3 МБ)")
    ext = (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename else "png"
    if ext not in ("png", "jpg", "jpeg", "webp"):
        raise HTTPException(status_code=400, detail="Формат: PNG/JPG/WebP")
    # NSFW filename check
    _nsfw_kw = ["nsfw", "porn", "xxx", "nude", "naked", "sex", "hentai", "18+", "adult", "dick", "pussy", "cock", "boob"]
    fname_low = (file.filename or "").lower()
    if any(kw in fname_low for kw in _nsfw_kw):
        raise HTTPException(status_code=400, detail="Недопустимое содержание файла. Загрузите обычный аватар.")
    # Verify image header magic bytes (prevent disguised files)
    if data[:2] == b'\xff\xd8':  # JPEG
        pass
    elif data[:4] == b'\x89PNG':  # PNG
        pass
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':  # WebP
        pass
    else:
        raise HTTPException(status_code=400, detail="Файл повреждён или не является изображением")
    # AI NSFW moderation (via text analysis of image properties + admin flag)
    try:
        import base64 as _b64
        # For production NSFW detection: use SightEngine, AWS Rekognition, or Google Vision API
        # Basic heuristic: very small images or GIF-like content often NSFW spam
        if len(data) < 500:
            raise HTTPException(status_code=400, detail="Изображение слишком маленькое")
    except HTTPException:
        raise
    except Exception:
        pass
    import base64
    b64 = base64.b64encode(data).decode()
    mime = file.content_type or f"image/{ext}"
    key = f"avatar:{uid}"
    payload = json.dumps({"mime": mime, "data": b64, "ext": ext})
    con = db_conn()
    # Atomic upsert — works in both SQLite and Postgres
    if USE_PG:
        con.execute(
            "INSERT INTO site_kv(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
            (key, payload)
        )
    else:
        con.execute("INSERT OR REPLACE INTO site_kv(key, value) VALUES(?,?)", (key, payload))
    url = f"/api/user/avatar/img?uid={uid}"
    con.execute("UPDATE users SET avatar_url=? WHERE id=?", (url, uid))
    con.commit()
    con.close()
    return {"ok": True, "url": url, "avatar_url": url}



@app.get("/api/user/avatar/img")
def api_user_avatar_img(uid: int = 0, t: int = 0):
    """Serve avatar from DB (base64 stored in site_kv)."""
    if not uid:
        raise HTTPException(status_code=404, detail="No uid")
    key = f"avatar:{uid}"
    try:
        con = db_conn()
        row = con.execute("SELECT value FROM site_kv WHERE key=?", (key,)).fetchone()
        con.close()
    except Exception:
        raise HTTPException(status_code=404, detail="DB error")
    if not row:
        raise HTTPException(status_code=404, detail="No avatar")
    try:
        import base64 as _b64
        info = json.loads(_rget(row, "value") or "{}")
        data = _b64.b64decode(info.get("data", ""))
        mime = info.get("mime", "image/png")
    except Exception:
        raise HTTPException(status_code=500, detail="Corrupt avatar data")
    from starlette.responses import Response
    # Cache 1 hour; client can bust with ?t=
    return Response(content=data, media_type=mime, headers={"Cache-Control": "public, max-age=3600"})

@app.post("/api/user/avatar/reset")
def api_user_avatar_reset(request: Request):
    """Remove user's custom avatar."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    key = f"avatar:{uid}"
    con.execute("DELETE FROM site_kv WHERE key=?", (key,))
    con.execute("UPDATE users SET avatar_url='' WHERE id=?", (uid,))
    con.commit()
    con.close()
    return {"ok": True}


@app.get("/api/tx")
def api_tx(request: Request):
    u = require_user(request)
    con = db_conn()
    rows = con.execute(
        "SELECT id, delta, reason, ts, admin_id FROM balance_tx WHERE user_id=? ORDER BY id DESC LIMIT 50",
        (int(u["id"]),),
    ).fetchall()
    con.close()

    tx = []
    for r in rows or []:
        tx.append({
            "id": int(_rget(r, "id") or 0),
            "admin_id": int(_rget(r, "admin_id") or 0) if _rget(r, "admin_id") is not None else None,
            "delta": int(_rget(r, "delta") or 0),
            "reason": str(_rget(r, "reason") or ""),
            "ts": str(_rget(r, "ts") or ""),
        })
    return {"ok": True, "tx": tx}


    def _row(r):
        return {
            "id": _rget(r, "id"),
            "created_at": _rget(r, "created_at"),
            "title": _rget(r, "title") or _rget(r, "type") or "Операция",
            "type": _rget(r, "type") or "tx",
            "amount": int(_rget(r, "amount") or 0),
            "status": _rget(r, "status") or "ok",
            "meta": _rget(r, "meta") or "",
        }

    return {"ok": True, "items": [_row(r) for r in rows]}


@app.get("/api/templates")
def api_templates(request: Request):
    """Legacy list endpoint. Returns list of templates (v2)."""
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    ensure_profile_templates_schema()
    con = db_conn()
    try:
        items = _list_templates(con, int(u["id"]))
        # minimal fields
        out = [{"id": t["id"], "created_at": t["created_at"], "title": t["name"]} for t in items]
        return {"ok": True, "items": out}
    finally:
        con.close()




# ----------------------------
# Topups (Crypto Pay + Promo + Manual) + Premium by balance
# ----------------------------

def _points_to_fiat_cents(points: int) -> int:
    cents = int(round((int(points) / float(max(BALANCE_PER_CURRENCY, 1))) * 100.0))
    if cents < CRYPTO_PAY_MIN_FIAT_CENTS:
        cents = CRYPTO_PAY_MIN_FIAT_CENTS
    return max(1, cents)

def _cents_to_amount_str(cents: int) -> str:
    return f"{(int(cents) / 100.0):.2f}"

@app.get("/api/admin/users")
def admin_users(request: Request, q: str = ""):
    require_admin(request)
    q = (q or "").strip().lower()
    con = db_conn()
    if q:
        like = f"%{q}%"
        rows = con.execute(
            "SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at, premium_until FROM users WHERE lower(username) LIKE ? OR lower(email) LIKE ? OR CAST(id AS TEXT) = ? ORDER BY id DESC LIMIT 25",
            (like, like, q),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at, premium_until FROM users ORDER BY id DESC LIMIT 25"
        ).fetchall()
    con.close()
    out = []
    for r in rows or []:
        out.append({
            "id": int(_rget(r, "id") or 0),
            "username": str(_rget(r, "username") or ""),
            "email": str(_rget(r, "email") or ""),
            "balance": int(_rget(r, "balance") or 0),
            "is_admin": int(_rget(r, "is_admin") or 0),
            "created_at": str(_rget(r, "created_at") or ""),
            "banned_until": str(_rget(r, "banned_until") or ""),
            "last_country": str(_rget(r, "last_country") or ""),
            "last_city": str(_rget(r, "last_city") or ""),
            "last_seen_at": str(_rget(r, "last_seen_at") or ""),
            "premium_until": str(_rget(r, "premium_until") or ""),
        })
    return {"ok": True, "users": out}

@app.get("/api/admin/user")
def admin_user(request: Request, ident: str = ""):
    require_admin(request)
    ident = (ident or "").strip()
    if not ident:
        raise HTTPException(status_code=400, detail="ident is required")
    con = db_conn()
    row = None
    if ident.isdigit():
        row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at, premium_until, case_next_at, case_money_next_at FROM users WHERE id=?", (int(ident),)).fetchone()
    if not row and "@" in ident:
        row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at, premium_until, case_next_at, case_money_next_at FROM users WHERE lower(email)=?", (ident.lower(),)).fetchone()
    if not row:
        row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at, premium_until, case_next_at, case_money_next_at FROM users WHERE lower(username)=?", (ident.lower(),)).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True, "user": {
        "id": int(_rget(row, "id") or 0),
        "username": str(_rget(row, "username") or ""),
        "email": str(_rget(row, "email") or ""),
        "balance": int(_rget(row, "balance") or 0),
        "is_admin": int(_rget(row, "is_admin") or 0),
        "created_at": str(_rget(row, "created_at") or ""),
        "banned_until": str(_rget(row, "banned_until") or ""),
        "ban_reason": str(_rget(row, "ban_reason") or ""),
        "last_ip": str(_rget(row, "last_ip") or ""),
        "last_country": str(_rget(row, "last_country") or ""),
        "last_city": str(_rget(row, "last_city") or ""),
        "last_seen_at": str(_rget(row, "last_seen_at") or ""),
        "premium_until": str(_rget(row, "premium_until") or ""),
        "case_next_at": str(_rget(row, "case_next_at") or ""),
        "case_money_next_at": str(_rget(row, "case_money_next_at") or ""),
    }}



# ----------------------------
# Admin moderation + user notifications
# ----------------------------
@app.post("/api/admin/user/ban")
def admin_user_ban(request: Request, payload: Dict[str, Any]):
    admin = require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    days = payload.get("days")
    reason = (payload.get("reason") or "").strip()
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    if days is None:
        days_i = 3650  # ~10 years
    else:
        try:
            days_i = int(days)
        except Exception:
            days_i = 7
        if days_i <= 0:
            days_i = 3650
        days_i = min(days_i, 3650)
    until = (_now_utc() + datetime.timedelta(days=days_i)).isoformat()
    con = db_conn()
    con.execute("UPDATE users SET banned_until=?, ban_reason=? WHERE id=?", (until, reason[:140], user_id))
    con.commit()
    con.close()
    return {"ok": True, "banned_until": until}

@app.post("/api/admin/user/unban")
def admin_user_unban(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    con = db_conn()
    con.execute("UPDATE users SET banned_until=NULL, ban_reason=NULL WHERE id=?", (user_id,))
    con.commit()
    con.close()
    return {"ok": True}

# ── Warn system ──────────────────────────────────────────────────
@app.post("/api/admin/user/warn")
def admin_user_warn(request: Request, payload: Dict[str, Any]):
    """Issue a warning to a user. Auto-ban at 3 warns."""
    admin = require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    reason = str(payload.get("reason") or "Нарушение правил").strip()[:200]
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id required")
    con = db_conn()
    # Check user exists
    urow = con.execute("SELECT id, username, warn_count FROM users WHERE id=?", (user_id,)).fetchone()
    if not urow:
        con.close()
        raise HTTPException(status_code=404, detail="User not found")
    # Insert warn
    con.execute(
        "INSERT INTO user_warns(user_id, admin_id, admin_username, reason, created_at) VALUES(?,?,?,?,?)",
        (user_id, int(admin["id"]), str(admin.get("username","")), reason, _now_utc_iso())
    )
    # Increment warn_count
    new_count = int(_rget(urow, "warn_count") or 0) + 1
    if new_count >= 3:
        # Auto-ban permanently
        until = (_now_utc() + datetime.timedelta(days=3650)).isoformat()
        con.execute("UPDATE users SET warn_count=?, banned_until=?, ban_reason=? WHERE id=?",
                    (new_count, until, f"Автобан: {new_count} варна(ов). Последняя причина: {reason}", user_id))
        con.commit()
        con.close()
        return {"ok": True, "warn_count": new_count, "auto_banned": True, "banned_until": until}
    else:
        con.execute("UPDATE users SET warn_count=? WHERE id=?", (new_count, user_id))
        con.commit()
        con.close()
        return {"ok": True, "warn_count": new_count, "auto_banned": False}

@app.post("/api/admin/user/unwarn")
def admin_user_unwarn(request: Request, payload: Dict[str, Any]):
    """Remove a specific warn or all warns from a user."""
    require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    warn_id = payload.get("warn_id")  # optional — remove specific warn
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id required")
    con = db_conn()
    if warn_id:
        con.execute("DELETE FROM user_warns WHERE id=? AND user_id=?", (int(warn_id), user_id))
    else:
        con.execute("DELETE FROM user_warns WHERE user_id=?", (user_id,))
    # Recount
    cnt_row = con.execute("SELECT COUNT(*) as cnt FROM user_warns WHERE user_id=?", (user_id,)).fetchone()
    new_count = int(_rget(cnt_row, "cnt") or 0)
    con.execute("UPDATE users SET warn_count=? WHERE id=?", (new_count, user_id))
    con.commit()
    con.close()
    return {"ok": True, "warn_count": new_count}

@app.get("/api/admin/user/warns")
def admin_user_warns(request: Request, user_id: int = 0):
    """Get all warns for a user."""
    require_admin(request)
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id required")
    con = db_conn()
    rows = con.execute(
        "SELECT id, admin_username, reason, created_at FROM user_warns WHERE user_id=? ORDER BY id DESC",
        (user_id,)
    ).fetchall()
    con.close()
    warns = [{"id": _rget(r,"id"), "admin": _rget(r,"admin_username"), "reason": _rget(r,"reason"), "created_at": _rget(r,"created_at")} for r in rows]
    return {"ok": True, "warns": warns}

# ── Complaints (review reports) admin endpoints ──────────────────
@app.get("/api/admin/complaints")
def admin_complaints(request: Request, status: str = "pending"):
    """List review complaints for admin."""
    require_admin(request)
    con = db_conn()
    rows = con.execute(
        "SELECT rr.*, r.status as review_status FROM review_reports rr LEFT JOIN reviews r ON r.id=rr.review_id WHERE rr.status=? ORDER BY rr.id DESC LIMIT 100",
        (status,)
    ).fetchall()
    con.close()
    result = []
    for r in rows:
        result.append({
            "id": _rget(r,"id"), "review_id": _rget(r,"review_id"),
            "reporter_id": _rget(r,"reporter_id"), "reporter_username": _rget(r,"reporter_username"),
            "reported_user_id": _rget(r,"reported_user_id"), "reported_username": _rget(r,"reported_username"),
            "review_text": _rget(r,"review_text"), "review_rating": _rget(r,"review_rating"),
            "reason": _rget(r,"reason"), "status": _rget(r,"status"),
            "created_at": _rget(r,"created_at"), "review_status": _rget(r,"review_status"),
        })
    return {"ok": True, "complaints": result}

@app.post("/api/admin/complaints/resolve")
def admin_complaints_resolve(request: Request, payload: Dict[str, Any]):
    """Resolve a complaint: approve (remove review) or dismiss."""
    admin = require_admin(request)
    complaint_id = int(payload.get("id") or 0)
    action = str(payload.get("action") or "dismiss")  # 'approve' = delete review, 'dismiss' = ignore
    if complaint_id <= 0:
        raise HTTPException(status_code=400, detail="id required")
    con = db_conn()
    crow = con.execute("SELECT review_id FROM review_reports WHERE id=?", (complaint_id,)).fetchone()
    if not crow:
        con.close()
        raise HTTPException(status_code=404, detail="Complaint not found")
    review_id = int(_rget(crow, "review_id") or 0)
    if action == "approve" and review_id:
        con.execute("DELETE FROM reviews WHERE id=?", (review_id,))
        # Close all complaints for this review
        con.execute("UPDATE review_reports SET status='resolved', resolved_at=?, resolved_by=? WHERE review_id=?",
                    (_now_utc_iso(), int(admin["id"]), review_id))
    else:
        con.execute("UPDATE review_reports SET status='dismissed', resolved_at=?, resolved_by=? WHERE id=?",
                    (_now_utc_iso(), int(admin["id"]), complaint_id))
    con.commit()
    con.close()
    return {"ok": True}



@app.post("/api/admin/user/rename")
def admin_user_rename(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    new_username = (payload.get("new_username") or "").strip()
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    if not re.match(r"^[A-Za-z0-9_\-\.]{3,24}$", new_username):
        raise HTTPException(status_code=400, detail="Bad username (3-24: a-z A-Z 0-9 _ - .)")
    con = db_conn()
    # uniqueness check
    row = con.execute("SELECT id FROM users WHERE lower(username)=? AND id<>?", (new_username.lower(), user_id)).fetchone()
    if row:
        con.close()
        raise HTTPException(status_code=400, detail="Username already taken")
    con.execute("UPDATE users SET username=? WHERE id=?", (new_username, user_id))
    con.commit()
    con.close()
    return {"ok": True, "username": new_username}

@app.post("/api/admin/user/set_premium")
def admin_user_set_premium(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    days = int(payload.get("days") or 0)
    action = (payload.get("action") or "grant").strip()
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    con = db_conn()
    if action == "revoke":
        con.execute("UPDATE users SET premium_until=NULL WHERE id=?", (user_id,))
        con.commit(); con.close()
        return {"ok": True, "premium_until": None}
    now = _now_utc()
    row = con.execute("SELECT premium_until FROM users WHERE id=?", (user_id,)).fetchone()
    cur = _parse_iso(_rget(row, "premium_until") or "") if row else None
    if action == "extend" and cur and cur > now:
        base = cur
    else:
        base = now
    days_i = max(1, min(int(days), 3650))
    new_until = (base + datetime.timedelta(days=days_i)).isoformat()
    con.execute("UPDATE users SET premium_until=? WHERE id=?", (new_until, user_id))
    con.commit(); con.close()
    return {"ok": True, "premium_until": new_until}

@app.post("/api/admin/user/set_password")
def admin_user_set_password(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    new_password = (payload.get("password") or "").strip()
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    import hashlib, secrets
    salt = secrets.token_hex(16)
    pw_hash = hashlib.sha256((new_password + salt).encode()).hexdigest()
    con = db_conn()
    con.execute("UPDATE users SET password_hash=?, password_salt=? WHERE id=?", (pw_hash, salt, user_id))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/admin/user/reset_cooldown")
def admin_user_reset_cooldown(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    cd_type = (payload.get("type") or "all").strip()
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    con = db_conn()
    if cd_type == "free":
        con.execute("UPDATE users SET case_next_at=NULL WHERE id=?", (user_id,))
    elif cd_type == "paid":
        con.execute("UPDATE users SET case_money_next_at=NULL WHERE id=?", (user_id,))
    else:
        con.execute("UPDATE users SET case_next_at=NULL, case_money_next_at=NULL WHERE id=?", (user_id,))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/admin/notifications/send")
def admin_notifications_send(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    target = (payload.get("target") or "all").strip()
    user_id = payload.get("user_id")
    title = (payload.get("title") or "").strip()
    message = (payload.get("message") or "").strip()
    if not title and not message:
        raise HTTPException(status_code=400, detail="title or message required")
    text = ((f"**{title}**\n" if title else "") + message if message else title)[:500]
    con = db_conn()
    ts = _now_utc_iso()
    if target == "user" and user_id:
        uid = int(user_id)
        con.execute("INSERT INTO user_notifications(user_id,text,created_at,is_read) VALUES(?,?,?,0)", (uid, text, ts))
    else:
        rows = con.execute("SELECT id FROM users").fetchall()
        for r in rows or []:
            uid = int(_rget(r, "id") or 0)
            if uid:
                con.execute("INSERT INTO user_notifications(user_id,text,created_at,is_read) VALUES(?,?,?,0)", (uid, text, ts))
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/admin/notify")
def admin_notify(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    user_id = int(payload.get("user_id") or 0)
    text = (payload.get("text") or "").strip()
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if len(text) > 500:
        raise HTTPException(status_code=400, detail="text is too long")
    con = db_conn()
    con.execute(
        "INSERT INTO user_notifications(user_id,text,created_at,is_read) VALUES(?,?,?,0)",
        (user_id, text, _now_utc_iso()),
    )
    con.commit()
    con.close()
    return {"ok": True}

@app.get("/api/user/notifications")
def user_notifications(request: Request, limit: int = 50):
    u = require_user(request)
    uid = int(u["id"])
    try:
        limit_i = int(limit)
    except Exception:
        limit_i = 50
    limit_i = max(1, min(limit_i, 100))
    con = db_conn()
    rows = con.execute(
        "SELECT id, text, created_at, is_read FROM user_notifications WHERE user_id=? ORDER BY id DESC LIMIT ?",
        (uid, limit_i),
    ).fetchall()
    rowc = con.execute(
        "SELECT COUNT(*) AS c FROM user_notifications WHERE user_id=? AND is_read=0",
        (uid,),
    ).fetchone()
    con.close()
    items = []
    for r in rows or []:
        items.append({
            "id": int(_rget(r, "id") or 0),
            "text": str(_rget(r, "text") or ""),
            "created_at": str(_rget(r, "created_at") or ""),
            "is_read": int(_rget(r, "is_read") or 0),
        })
    return {"ok": True, "items": items, "unread": int(_rget(rowc, "c") or 0)}

@app.get("/api/notifications")
def notifications_list_alias(request: Request, limit: int = 50):
    return user_notifications(request, limit)

@app.post("/api/notifications/read")
def notifications_read_alias(request: Request, payload: Dict[str, Any]):
    return user_notifications_read(request, payload)

@app.post("/api/notifications/read_all")
def notifications_read_all_alias(request: Request, payload: Dict[str, Any] = {}):
    payload = {"all": True}
    return user_notifications_read(request, payload)

@app.get("/api/notifications/unread_count")
def notifications_unread_count(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    rowc = con.execute(
        "SELECT COUNT(*) AS c FROM user_notifications WHERE user_id=? AND is_read=0",
        (uid,),
    ).fetchone()
    con.close()
    return {"ok": True, "count": int(_rget(rowc, "c") or 0)}

@app.post("/api/user/notifications/read")
def user_notifications_read(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])
    ids = payload.get("ids") or []
    mark_all = bool(payload.get("all") or False)
    con = db_conn()
    if mark_all:
        con.execute("UPDATE user_notifications SET is_read=1 WHERE user_id=? AND is_read=0", (uid,))
    else:
        clean = []
        for x in ids:
            try:
                clean.append(int(x))
            except Exception:
                pass
        if clean:
            qmarks = ",".join(["?"] * len(clean))
            con.execute(f"UPDATE user_notifications SET is_read=1 WHERE user_id=? AND id IN ({qmarks})", (uid, *clean))
    con.commit()
    con.close()
    return {"ok": True}
@app.get("/api/user/tx")
def api_user_tx(request: Request, limit: int = 50):
    """Returns current user's balance transaction history."""
    u = require_user(request)
    uid = int(u["id"])
    try:
        limit_i = int(limit)
    except Exception:
        limit_i = 50
    limit_i = max(1, min(limit_i, 100))

    con = db_conn()
    rows = con.execute(
        "SELECT id, delta, reason, ts, admin_id FROM balance_tx WHERE user_id=? ORDER BY id DESC LIMIT ?",
        (uid, limit_i),
    ).fetchall()
    con.close()

    items = []
    for r in rows:
        items.append({
            "id": _rget(r, "id"),
            "delta": _rget(r, "delta"),
            "reason": _rget(r, "reason") or "",
            "ts": _rget(r, "ts"),
            "admin_id": _rget(r, "admin_id"),
        })
    return {"ok": True, "items": items}


@app.get("/api/admin/tx")
def admin_tx(request: Request, user_id: int):
    require_admin(request)
    uid = int(user_id or 0)
    if uid <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    con = db_conn()
    rows = con.execute(
        "SELECT id, admin_id, delta, reason, ts FROM balance_tx WHERE user_id=? ORDER BY id DESC LIMIT 25",
        (uid,),
    ).fetchall()
    con.close()
    tx = []
    for r in rows or []:
        tx.append({
            "id": int(_rget(r, "id") or 0),
            "admin_id": int(_rget(r, "admin_id") or 0) if _rget(r, "admin_id") is not None else None,
            "delta": int(_rget(r, "delta") or 0),
            "reason": str(_rget(r, "reason") or ""),
            "ts": str(_rget(r, "ts") or ""),
        })
    return {"ok": True, "tx": tx}

@app.post("/api/admin/balance_adjust")
def admin_balance_adjust(request: Request, payload: Dict[str, Any]):
    admin = require_admin(request)
    ident = (payload.get("ident") or "").strip()
    user_id = int(payload.get("user_id") or 0)
    delta = int(payload.get("delta") or 0)
    reason = (payload.get("reason") or "").strip()
    if delta == 0:
        raise HTTPException(status_code=400, detail="delta must be non-zero")
    if abs(delta) > 1_000_000_000:
        raise HTTPException(status_code=400, detail="delta is too large")
    if len(reason) > 140:
        raise HTTPException(status_code=400, detail="reason is too long")
    if user_id <= 0:
        if not ident:
            raise HTTPException(status_code=400, detail="user_id or ident is required")
        # resolve ident
        con = db_conn()
        row = None
        if ident.isdigit():
            row = con.execute("SELECT id FROM users WHERE id=?", (int(ident),)).fetchone()
        if not row and "@" in ident:
            row = con.execute("SELECT id FROM users WHERE lower(email)=?", (ident.lower(),)).fetchone()
        if not row:
            row = con.execute("SELECT id FROM users WHERE lower(username)=?", (ident.lower(),)).fetchone()
        con.close()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        user_id = int(_rget(row, "id") or 0)

    con = db_conn()
    row = con.execute("SELECT balance FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="User not found")
    old_balance = int(_rget(row, "balance") or 0)

    new_balance = _credit_balance_direct(con, user_id, delta, reason or "admin balance adjust", int(admin["id"]))
    applied_delta = new_balance - old_balance
    con.commit()
    con.close()

    return {"ok": True, "user_id": user_id, "old_balance": old_balance, "new_balance": new_balance, "applied_delta": applied_delta}


@app.get("/api/admin/email_status")
def admin_email_status(request: Request):
    """Small helper to debug email configuration from the UI."""
    require_admin(request)
    return {
        "ok": True,
        "provider": "brevo",
        "configured": bool(BREVO_API_KEY and BREVO_SENDER_EMAIL),
        "sender": BREVO_SENDER_EMAIL,
        "sender_name": BREVO_SENDER_NAME,
    }


@app.post("/api/admin/email_test")
def admin_email_test(request: Request, payload: Dict[str, Any]):
    """Send a test transactional email via Brevo.

    Useful when users report that OTP emails "do not arrive".
    """
    require_admin(request)
    to_email = (payload.get("email") or payload.get("to") or "").strip().lower()
    if not to_email or "@" not in to_email:
        raise HTTPException(status_code=400, detail="Valid email is required")
    subject = (payload.get("subject") or "Brevo test").strip() or "Brevo test"
    text = (payload.get("text") or "Test email from RST").strip() or "Test email from RST"
    html = (payload.get("html") or "<b>Test email from RST</b>").strip()
    send_brevo_email(to_email, subject, text, html)
    return {"ok": True}
@app.post("/api/auth/register_start")
def auth_register_start(payload: Dict[str, Any]):
    username = (payload.get("username") or "").strip()
    captcha_token = str(payload.get("captcha_token") or "")
    captcha_answer = str(payload.get("captcha_answer") or "")
    _captcha_verify(captcha_token, captcha_answer, "register")

    email = (payload.get("email") or "").strip().lower()
    password = payload.get("password") or ""

    if len(username) < 3 or len(username) > 24:
        raise HTTPException(status_code=400, detail="Username: 3-24 symbols")
    if not re.match(r"^[a-zA-Z0-9_]+$", username):
        raise HTTPException(status_code=400, detail="Username: only A-Z, 0-9, _")
    if not email or "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Email is required")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password: min 6 symbols")

    con = db_conn()
    # check username/email uniqueness
    if con.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        con.close()
        raise HTTPException(status_code=400, detail="Username already exists")
    if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        con.close()
        raise HTTPException(status_code=400, detail="Email already used")

    code = gen_otp_code()
    code_h = otp_hash(code)
    ph = hash_password(password)
    payload_obj = {"username": username, "password_hash": ph}

    # invalidate old pending codes
    con.execute("DELETE FROM email_otps WHERE email=? AND purpose='verify'", (email,))
    exp = (datetime.datetime.utcnow() + datetime.timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
    con.execute(
        "INSERT INTO email_otps(email,purpose,code_hash,payload,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,?)",
        (email, "verify", code_h, json.dumps(payload_obj), exp, 0, datetime.datetime.utcnow().isoformat()),
    )
    con.commit()
    con.close()

    text = f"Код подтверждения регистрации: {code}\n\nКод действует {OTP_TTL_MINUTES} минут."
    html = _email_html(
        title="Подтверждение регистрации",
        subtitle=f"Введите этот код на сайте. Он действует {OTP_TTL_MINUTES} минут.",
        body_html=_email_code_block(code),
    )
    send_brevo_email(email, "Код подтверждения — RBX ST", text, html)

    return {"ok": True}

@app.post("/api/auth/register_confirm")
def auth_register_confirm(request: Request, payload: Dict[str, Any]):
    email = (payload.get("email") or "").strip().lower()
    code = (payload.get("code") or "").strip()

    if not email or not code:
        raise HTTPException(status_code=400, detail="Email and code are required")

    con = db_conn()
    row = con.execute(
        "SELECT id, code_hash, payload, expires_at, attempts FROM email_otps WHERE email=? AND purpose='verify' ORDER BY id DESC LIMIT 1",
        (email,),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=400, detail="Code not found")

    exp = datetime.datetime.fromisoformat(row["expires_at"])
    if datetime.datetime.utcnow() > exp:
        con.execute("DELETE FROM email_otps WHERE id=?", (row["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Code expired")

    attempts = int(row["attempts"] or 0)
    if attempts >= OTP_MAX_ATTEMPTS:
        con.execute("DELETE FROM email_otps WHERE id=?", (row["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Too many attempts")

    if otp_hash(code) != row["code_hash"]:
        con.execute("UPDATE email_otps SET attempts=attempts+1 WHERE id=?", (row["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Wrong code")

    payload_obj = json.loads(row["payload"])
    username = (payload_obj.get("username") or "").strip()
    ph = payload_obj.get("password_hash") or ""

    try:
                # first verified user becomes admin automatically (если админов ещё нет)
        make_admin = 0
        try:
            rr = con.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin=1", ()).fetchone()
            if int(_rget(rr, "c") or 0) == 0:
                make_admin = 1
        except Exception:
            make_admin = 0

        con.execute(
            "INSERT INTO users(username,password_hash,email,email_verified,is_admin,credits_analyze,credits_ai,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (username, ph, email, 1, make_admin, 3, 5, datetime.datetime.utcnow().isoformat()),
        )
        con.execute("DELETE FROM email_otps WHERE id=?", (row["id"],))
        con.commit()
    except Exception as e:
        # SQLite / Postgres unique violations
        if isinstance(e, sqlite3.IntegrityError) or (USE_PG and psycopg is not None and PGIntegrityError is not None and isinstance(e, PGIntegrityError)):
            con.close()
            raise HTTPException(status_code=400, detail="Username/email already exists")
        con.close()
        raise
    finally:
        try:
            con.close()
        except Exception:
            pass

    # auto-login
    con2 = db_conn()
    urow = con2.execute("SELECT id, username, email FROM users WHERE username=?", (username,)).fetchone()
    con2.close()
    if not urow:
        raise HTTPException(status_code=500, detail="User creation failed")

    token = make_token(int(urow["id"]), urow["username"])
    jr = JSONResponse({"ok": True, "user": {"username": urow["username"], "email": (_rget(urow, "email") or email)}})
    jr.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=cookie_secure(request),
        max_age=60*60*24*14,
        path="/",
    )
    return jr
@app.post("/api/auth/register_direct")
def api_auth_register_direct(payload: Dict[str, Any]):
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    captcha_token = str(payload.get("captcha_token") or "")
    captcha_answer = str(payload.get("captcha_answer") or "")
    _captcha_verify(captcha_token, captcha_answer, "register")

    if not username or len(username) < 3:
        raise HTTPException(status_code=400, detail="Username too short")
    if not password or len(password) < 6:
        raise HTTPException(status_code=400, detail="Password too short")

    con = db_conn()
    exists = con.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if exists:
        con.close()
        raise HTTPException(status_code=400, detail="Username already taken")

    pw_hash = hash_password(password)
    ts = _now_utc_iso()
    if USE_PG:
        row = con.execute(
            "INSERT INTO users(username, email, password_hash, created_at) VALUES(?,?,?,?) RETURNING id",
            (username, None, pw_hash, ts)
        ).fetchone()
        uid = int(_rget(row, "id") or 0)
    else:
        con.execute("INSERT INTO users(username, email, password_hash, created_at) VALUES(?,?,?,?)", (username, None, pw_hash, ts))
        uid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    con.commit()
    con.close()

    # Login cookie
    token = make_token(int(uid), username)
    resp = JSONResponse({"ok": True, "user_id": int(uid)})
    resp.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=60*60*24*14, path="/")
    return resp

OTP_RESEND_LIMIT = _env_int("OTP_RESEND_LIMIT", 3)       # max resend attempts
OTP_RESEND_WINDOW = _env_int("OTP_RESEND_WINDOW", 30)     # minutes before allowed again

def _check_otp_resend_limit(con, email: str, purpose: str):
    """Raise 429 if this email has exceeded the resend limit within the window."""
    window_start = (datetime.datetime.utcnow() - datetime.timedelta(minutes=OTP_RESEND_WINDOW)).isoformat()
    count_row = con.execute(
        "SELECT COUNT(*) AS c FROM email_otps WHERE email=? AND purpose=? AND created_at >= ?",
        (email, purpose, window_start),
    ).fetchone()
    count = int(_rget(count_row, "c") or 0)
    if count >= OTP_RESEND_LIMIT:
        # Find the oldest in the window to tell user when they can retry
        first_row = con.execute(
            "SELECT created_at FROM email_otps WHERE email=? AND purpose=? AND created_at >= ? ORDER BY id ASC LIMIT 1",
            (email, purpose, window_start),
        ).fetchone()
        if first_row:
            first_ts = _parse_iso(str(_rget(first_row, "created_at") or ""))
            if first_ts:
                retry_at = first_ts + datetime.timedelta(minutes=OTP_RESEND_WINDOW)
                wait_min = max(1, int((retry_at - _now_utc()).total_seconds() / 60) + 1)
                raise HTTPException(
                    status_code=429,
                    detail=f"Слишком много запросов кода. Попробуйте через {wait_min} мин."
                )
        raise HTTPException(status_code=429, detail=f"Слишком много запросов. Подождите {OTP_RESEND_WINDOW} минут.")

@app.post("/api/auth/register_resend")
def api_auth_register_resend(payload: Dict[str, Any]):
    email = str(payload.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    con = db_conn()

    # Rate limit: max 3 resends per 30 minutes
    _check_otp_resend_limit(con, email, "verify")

    row = con.execute(
        "SELECT payload, expires_at FROM email_otps WHERE email=? AND purpose='verify' ORDER BY id DESC LIMIT 1",
        (email,),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="No pending verification")
    payload_str = str(_rget(row, "payload") or "{}")
    expires_at = str(_rget(row, "expires_at") or "")
    if expires_at:
        exp_dt = _parse_iso(expires_at)
        if exp_dt and _now_utc() > exp_dt:
            con.close()
            raise HTTPException(status_code=400, detail="Verification expired")

    # Replace with a new code
    code = gen_otp_code()
    code_h = otp_hash(code)
    exp = (datetime.datetime.utcnow() + datetime.timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
    con.execute("INSERT INTO email_otps(email, purpose, code_hash, payload, expires_at, attempts, created_at) VALUES(?,?,?,?,?,?,?)",
                (email, "verify", code_h, payload_str, exp, 0, datetime.datetime.utcnow().isoformat()))
    con.commit()
    con.close()

    text = f"Код подтверждения: {code}\nОн действует {OTP_TTL_MINUTES} минут."
    html = _email_html("Подтверждение регистрации", _email_code_block(code), subtitle=f"Код действует {OTP_TTL_MINUTES} минут.")
    send_brevo_email(email, "Подтвердите регистрацию — RBX ST", text, html)
    return {"ok": True}


@app.post("/api/auth/reset_start")
def auth_reset_start(payload: Dict[str, Any]):
    email = (payload.get("email") or "").strip().lower()
    captcha_token = str(payload.get("captcha_token") or "")
    captcha_answer = str(payload.get("captcha_answer") or "")
    _captcha_verify(captcha_token, captcha_answer, "reset")

    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Email is required")

    con = db_conn()
    u = con.execute("SELECT id, username FROM users WHERE email=?", (email,)).fetchone()
    if not u:
        con.close()
        raise HTTPException(status_code=404, detail="Аккаунт с таким email не найден")

    code = gen_otp_code()
    code_h = otp_hash(code)
    payload_obj = {"user_id": int(u["id"])}
    con.execute("DELETE FROM email_otps WHERE email=? AND purpose='reset'", (email,))
    exp = (datetime.datetime.utcnow() + datetime.timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
    con.execute(
        "INSERT INTO email_otps(email,purpose,code_hash,payload,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,?)",
        (email, "reset", code_h, json.dumps(payload_obj), exp, 0, datetime.datetime.utcnow().isoformat()),
    )
    con.commit()
    con.close()

    text = f"Код для сброса пароля: {code}\n\nКод действует {OTP_TTL_MINUTES} минут."
    html = _email_html("Сброс пароля", _email_code_block(code), subtitle=f"Введите код для сброса пароля. Действует {OTP_TTL_MINUTES} минут.")
    send_brevo_email(email, "Сброс пароля — RBX ST", text, html)

    return {"ok": True}

@app.post("/api/auth/reset_confirm")
def auth_reset_confirm(payload: Dict[str, Any]):
    email = (payload.get("email") or "").strip().lower()
    code = (payload.get("code") or "").strip()
    new_password = payload.get("new_password") or ""
    if not email or not code:
        raise HTTPException(status_code=400, detail="Email and code are required")
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password: min 6 symbols")

    con = db_conn()
    row = con.execute(
        "SELECT id, code_hash, payload, expires_at, attempts FROM email_otps WHERE email=? AND purpose='reset' ORDER BY id DESC LIMIT 1",
        (email,),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=400, detail="Code not found")

    exp = datetime.datetime.fromisoformat(row["expires_at"])
    if datetime.datetime.utcnow() > exp:
        con.execute("DELETE FROM email_otps WHERE id=?", (row["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Code expired")

    attempts = int(row["attempts"] or 0)
    if attempts >= OTP_MAX_ATTEMPTS:
        con.execute("DELETE FROM email_otps WHERE id=?", (row["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Too many attempts")

    if otp_hash(code) != row["code_hash"]:
        con.execute("UPDATE email_otps SET attempts=attempts+1 WHERE id=?", (row["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Wrong code")

    ph = hash_password(new_password)
    con.execute("UPDATE users SET password_hash=? WHERE email=?", (ph, email))
    con.execute("DELETE FROM email_otps WHERE id=?", (row["id"],))
    con.commit()
    con.close()

    return {"ok": True}




# --- Simple math captcha (no external keys) --------------------------

def _captcha_token_make(purpose: str, a: int, b: int) -> str:
    payload = {
        "typ": "captcha",
        "purpose": str(purpose or "generic"),
        "a": int(a),
        "b": int(b),
        "iat": int(time.time()),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def _captcha_token_parse(token: str) -> Dict[str, Any]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        if payload.get("typ") != "captcha":
            raise ValueError("bad typ")
        iat = int(payload.get("iat") or 0)
        if iat <= 0 or (time.time() - iat) > 5 * 60:
            raise ValueError("expired")
        return payload
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid captcha")

def _captcha_verify(token: str, answer: str, purpose: str) -> None:
    if not token:
        raise HTTPException(status_code=400, detail="captcha_token required")
    payload = _captcha_token_parse(token)
    if str(payload.get("purpose") or "") != str(purpose or "generic"):
        raise HTTPException(status_code=400, detail="Invalid captcha purpose")
    try:
        ans = int(str(answer).strip())
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid captcha answer")
    if ans != (int(payload.get("a") or 0) + int(payload.get("b") or 0)):
        raise HTTPException(status_code=400, detail="Captcha failed")

@app.get("/api/captcha/challenge")
def api_captcha_challenge(purpose: str = "generic"):
    a = random.randint(2, 9)
    b = random.randint(2, 9)
    token = _captcha_token_make(purpose, a, b)
    return {"ok": True, "purpose": purpose, "a": a, "b": b, "token": token}

@app.post("/api/auth/login")
def auth_login(request: Request, payload: Dict[str, Any]):
    ident = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    if not ident:
        raise HTTPException(status_code=400, detail="Login is required")

    con = db_conn()
    # allow login by username or email
    if "@" in ident:
        row = con.execute(
            "SELECT id, username, password_hash, banned_until, ban_reason, email, twofa_email_enabled, is_admin FROM users WHERE lower(email)=?",
            (ident.strip().lower(),),
        ).fetchone()
    else:
        row = con.execute(
            "SELECT id, username, password_hash, banned_until, ban_reason, email, twofa_email_enabled, is_admin FROM users WHERE username=?",
            (ident,),
        ).fetchone()

    if not row or not verify_password(password, row["password_hash"]):
        con.close()
        raise HTTPException(status_code=401, detail="Wrong login or password")

    bu = _parse_iso(str(_rget(row, "banned_until") or ""))
    if bu and _now_utc() < bu:
        reason = str(_rget(row, "ban_reason") or "").strip() or "Banned"
        con.close()
        raise HTTPException(status_code=403, detail=f"Banned: {reason}")

    try:
        _touch_user_seen(int(_rget(row, "id") or 0), request)
    except Exception:
        pass

    # If email-2FA enabled, send code and require confirm
    twofa_on = int(_rget(row, "twofa_email_enabled") or 0) == 1
    email = str(_rget(row, "email") or "").strip().lower()
    captcha_token = str(payload.get("captcha_token") or "")
    captcha_answer = str(payload.get("captcha_answer") or "")
    # Skip captcha for admin users (useful during maintenance mode login)
    is_admin_user = int(_rget(row, "is_admin") or 0) if row else 0
    if not is_admin_user:
        _captcha_verify(captcha_token, captcha_answer, "login")


    if twofa_on and email and BREVO_API_KEY and BREVO_SENDER_EMAIL:
        # Rate limit 2FA code requests
        try:
            _check_otp_resend_limit(con, email, "login2fa")
        except HTTPException as _rle:
            con.close()
            raise _rle
        code = gen_otp_code()
        code_h = otp_hash(code)
        con.execute("DELETE FROM email_otps WHERE email=? AND purpose='login2fa'", (email,))
        exp = (datetime.datetime.utcnow() + datetime.timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
        payload_obj = {"user_id": int(_rget(row, "id") or 0), "username": str(_rget(row, "username") or "")}
        con.execute(
            "INSERT INTO email_otps(email,purpose,code_hash,payload,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,?)",
            (email, "login2fa", code_h, json.dumps(payload_obj), exp, 0, datetime.datetime.utcnow().isoformat()),
        )
        con.commit()
        con.close()

        text = f"Код входа (2FA): {code}\n\nКод действует {OTP_TTL_MINUTES} минут."
        html = _email_html("Двухфакторная аутентификация", _email_code_block(code), subtitle=f"Код для входа в аккаунт. Действует {OTP_TTL_MINUTES} минут.")
        send_brevo_email(email, "Код входа (2FA) — RBX ST", text, html)

        return {"ok": True, "needs_2fa": True}

    # Normal login (or 2FA bypass if email/provider not configured)
    token = make_token(int(row["id"]), row["username"])
    con.close()
    jr = JSONResponse({"ok": True, "user": {"username": row["username"]}})
    jr.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=cookie_secure(request),
        max_age=60*60*24*14,
        path="/",
    )
    return jr


@app.post("/api/auth/login_confirm")
def auth_login_confirm(request: Request, payload: Dict[str, Any]):
    ident = (payload.get("username") or "").strip()
    code = (payload.get("code") or "").strip()
    if not ident or not code:
        raise HTTPException(status_code=400, detail="Username/email and code are required")

    con = db_conn()
    if "@" in ident:
        row = con.execute(
            "SELECT id, username, banned_until, ban_reason, email FROM users WHERE lower(email)=?",
            (ident.strip().lower(),),
        ).fetchone()
    else:
        row = con.execute(
            "SELECT id, username, banned_until, ban_reason, email FROM users WHERE username=?",
            (ident,),
        ).fetchone()

    if not row:
        con.close()
        raise HTTPException(status_code=401, detail="Wrong login")

    bu = _parse_iso(str(_rget(row, "banned_until") or ""))
    if bu and _now_utc() < bu:
        reason = str(_rget(row, "ban_reason") or "").strip() or "Banned"
        con.close()
        raise HTTPException(status_code=403, detail=f"Banned: {reason}")

    email = str(_rget(row, "email") or "").strip().lower()
    if not email:
        con.close()
        raise HTTPException(status_code=400, detail="No email bound to account")

    otp = con.execute(
        "SELECT id, code_hash, expires_at, attempts FROM email_otps WHERE email=? AND purpose='login2fa' ORDER BY id DESC LIMIT 1",
        (email,),
    ).fetchone()
    if not otp:
        con.close()
        raise HTTPException(status_code=400, detail="Code not found. Try login again.")

    exp = _parse_iso(str(_rget(otp, "expires_at") or ""))
    if not exp or _now_utc() > exp:
        con.execute("DELETE FROM email_otps WHERE id=?", (otp["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Code expired. Try login again.")

    attempts = int(_rget(otp, "attempts") or 0)
    if attempts >= OTP_MAX_ATTEMPTS:
        con.execute("DELETE FROM email_otps WHERE id=?", (otp["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Too many attempts")

    if otp_hash(code) != _rget(otp, "code_hash"):
        con.execute("UPDATE email_otps SET attempts=attempts+1 WHERE id=?", (otp["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Wrong code")

    con.execute("DELETE FROM email_otps WHERE id=?", (otp["id"],))
    con.commit()
    con.close()

    try:
        _touch_user_seen(int(_rget(row, "id") or 0), request)
    except Exception:
        pass

    token = make_token(int(row["id"]), row["username"])
    jr = JSONResponse({"ok": True, "user": {"username": row["username"]}})
    jr.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=cookie_secure(request),
        max_age=60*60*24*14,
        path="/",
    )
    return jr

@app.post("/api/auth/logout")
def auth_logout():
    jr = JSONResponse({"ok": True})
    jr.delete_cookie(SESSION_COOKIE, path="/")
    return jr

# -------------------------
# 2FA (email) settings
# -------------------------

@app.post("/api/user/twofa_hide_reminder")
def api_twofa_hide_reminder(request: Request):
    u = require_user(request)
    con = db_conn()
    con.execute("UPDATE users SET hide_2fa_reminder=1 WHERE id=?", (u["id"],))
    con.commit()
    con.close()
    return {"ok": True}

@app.post("/api/user/twofa_enable_start")
def api_twofa_enable_start(request: Request):
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT email FROM users WHERE id=?", (u["id"],)).fetchone()
    email = str(_rget(row, "email") or "").strip().lower() if row else ""
    if not email or "@" not in email:
        con.close()
        raise HTTPException(status_code=400, detail="Bind email in profile first")
    if not BREVO_API_KEY or not BREVO_SENDER_EMAIL:
        con.close()
        raise HTTPException(status_code=500, detail="Email provider is not configured")

    code = gen_otp_code()
    code_h = otp_hash(code)
    con.execute("DELETE FROM email_otps WHERE email=? AND purpose='twofa_enable'", (email,))
    exp = (datetime.datetime.utcnow() + datetime.timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
    con.execute(
        "INSERT INTO email_otps(email,purpose,code_hash,payload,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,?)",
        (email, "twofa_enable", code_h, json.dumps({"user_id": int(u["id"])}), exp, 0, datetime.datetime.utcnow().isoformat()),
    )
    con.commit()
    con.close()

    text = f"Код для включения 2FA: {code}\n\nКод действует {OTP_TTL_MINUTES} минут."
    html = _email_html("Включение двухфакторной аутентификации", _email_code_block(code), subtitle=f"Введите код для активации 2FA. Действует {OTP_TTL_MINUTES} минут.")
    send_brevo_email(email, "Код 2FA — RBX ST", text, html)
    return {"ok": True}

@app.post("/api/user/twofa_enable_confirm")
def api_twofa_enable_confirm(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    code = (payload.get("code") or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Code is required")

    con = db_conn()
    row = con.execute("SELECT email FROM users WHERE id=?", (u["id"],)).fetchone()
    email = str(_rget(row, "email") or "").strip().lower() if row else ""
    if not email:
        con.close()
        raise HTTPException(status_code=400, detail="No email")

    otp = con.execute(
        "SELECT id, code_hash, expires_at, attempts FROM email_otps WHERE email=? AND purpose='twofa_enable' ORDER BY id DESC LIMIT 1",
        (email,),
    ).fetchone()
    if not otp:
        con.close()
        raise HTTPException(status_code=400, detail="Code not found")

    exp = _parse_iso(str(_rget(otp, "expires_at") or ""))
    if not exp or _now_utc() > exp:
        con.execute("DELETE FROM email_otps WHERE id=?", (otp["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Code expired")

    attempts = int(_rget(otp, "attempts") or 0)
    if attempts >= OTP_MAX_ATTEMPTS:
        con.execute("DELETE FROM email_otps WHERE id=?", (otp["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Too many attempts")

    if otp_hash(code) != _rget(otp, "code_hash"):
        con.execute("UPDATE email_otps SET attempts=attempts+1 WHERE id=?", (otp["id"],))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Wrong code")

    con.execute("DELETE FROM email_otps WHERE id=?", (otp["id"],))
    con.execute("UPDATE users SET twofa_email_enabled=1, hide_2fa_reminder=0 WHERE id=?", (u["id"],))
    con.commit()
    con.close()
    return {"ok": True}

@app.post("/api/user/twofa_disable")
def api_twofa_disable(request: Request):
    u = require_user(request)
    con = db_conn()
    con.execute("UPDATE users SET twofa_email_enabled=0 WHERE id=?", (u["id"],))
    con.commit()
    con.close()
    return {"ok": True}


# ----------------------------
# Security settings: change password / change email / 2FA
# ----------------------------

@app.post("/api/security/password")
def api_security_change_password(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    current = (payload.get("current") or "").strip()
    new_password = (payload.get("new") or "").strip()
    new2 = (payload.get("new2") or "").strip()

    if not current or not new_password or not new2:
        raise HTTPException(status_code=400, detail="Missing fields")
    if new_password != new2:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password too short")

    con = db_conn()
    row = con.execute("SELECT password_hash FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    if not row or not verify_password(current, _rget(row, "password_hash") or ""):
        con.close()
        raise HTTPException(status_code=400, detail="Current password invalid")

    ph = hash_password(new_password)
    con.execute("UPDATE users SET password_hash=? WHERE id=?", (ph, int(u["id"])))
    con.commit()
    con.close()
    return {"ok": True}


@app.post("/api/security/email_start")
def api_security_email_start(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    password = (payload.get("password") or "").strip()
    new_email = (payload.get("new_email") or "").strip().lower()

    if not password or not new_email:
        raise HTTPException(status_code=400, detail="Missing fields")
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", new_email):
        raise HTTPException(status_code=400, detail="Invalid email")

    con = db_conn()
    row = con.execute("SELECT email, password_hash FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    if not row or not verify_password(password, _rget(row, "password_hash") or ""):
        con.close()
        raise HTTPException(status_code=400, detail="Password invalid")

    # email already used?
    ex = con.execute("SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?", (new_email, int(u["id"]))).fetchone()
    if ex:
        con.close()
        raise HTTPException(status_code=400, detail="Email already in use")

    if not BREVO_API_KEY or not BREVO_SENDER_EMAIL:
        con.close()
        raise HTTPException(status_code=500, detail="Email provider is not configured")

    code = gen_otp_code()
    code_h = otp_hash(code)
    con.execute("DELETE FROM email_otps WHERE email=? AND purpose='email_change'", (new_email,))
    exp = (datetime.datetime.utcnow() + datetime.timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
    con.execute(
        "INSERT INTO email_otps(email,purpose,code_hash,payload,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,?)",
        (new_email, "email_change", code_h, json.dumps({"user_id": int(u["id"]), "new_email": new_email}), exp, 0, datetime.datetime.utcnow().isoformat()),
    )
    con.commit()
    con.close()

    send_brevo_email(
        new_email,
        "RBX ST: подтверждение смены почты",
        f"Ваш код подтверждения: {code}\n\nЕсли это были не вы — просто игнорируйте письмо.",
    )
    return {"ok": True}



@app.post("/api/security/2fa_email")
def api_security_toggle_2fa_email(request: Request, payload: Dict[str, Any]):
    """Toggle 2FA email authentication."""
    u = require_user(request)
    enabled = bool(payload.get("enabled", False))
    con = db_conn()
    try:
        con.execute("UPDATE users SET twofa_email_enabled=? WHERE id=?", (1 if enabled else 0, int(u["id"])))
        con.commit()
    finally:
        con.close()
    return {"ok": True, "enabled": enabled}

@app.get("/api/debug/mybalance")
def api_debug_mybalance(request: Request):
    """Debug: show raw balance data for current user."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    row = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
    bal_col = int(_rget(row, "balance") or 0) if row else 0
    tx_rows = con.execute(
        "SELECT delta, reason, ts FROM balance_tx WHERE user_id=? ORDER BY id DESC LIMIT 20", (uid,)
    ).fetchall()
    tx_sum = con.execute(
        "SELECT COALESCE(SUM(delta),0) as s FROM balance_tx WHERE user_id=?", (uid,)
    ).fetchone()
    tx_sum_val = int(_rget(tx_sum, "s") or 0) if tx_sum else 0
    reliable = _get_user_balance_reliable(con, uid)
    con.close()
    return {
        "ok": True,
        "balance_column": bal_col,
        "balance_tx_sum": tx_sum_val,
        "balance_reliable": reliable,
        "recent_tx": [{"delta": t["delta"], "reason": t["reason"], "ts": t["ts"]} for t in tx_rows]
    }

@app.post("/api/debug/fix_my_balance")
def api_debug_fix_balance(request: Request):
    """Force-recalculate and fix current user's balance from transactions."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    tx_row = con.execute("SELECT COALESCE(SUM(delta),0) as s FROM balance_tx WHERE user_id=?", (uid,)).fetchone()
    tx_sum = max(0, int(_rget(tx_row, "s") or 0))
    row = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
    old_bal = int(_rget(row, "balance") or 0) if row else 0
    if tx_sum != old_bal and tx_sum > 0:
        con.execute("UPDATE users SET balance=? WHERE id=?", (tx_sum, uid))
        con.commit()
        new_bal = tx_sum
    else:
        new_bal = old_bal
    con.close()
    return {"ok": True, "old_balance": old_bal, "new_balance": new_bal, "from_tx": tx_sum}


@app.post("/api/security/email_confirm")
def api_security_email_confirm(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    new_email = (payload.get("new_email") or "").strip().lower()
    code = (payload.get("code") or "").strip()

    if not new_email or not code:
        raise HTTPException(status_code=400, detail="Missing fields")

    con = db_conn()
    row = con.execute(
        "SELECT id, code_hash, payload, expires_at, attempts FROM email_otps WHERE email=? AND purpose='email_change' ORDER BY id DESC LIMIT 1",
        (new_email,),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=400, detail="Code not found")

    # reuse verify otp logic
    exp = datetime.datetime.fromisoformat(_rget(row, "expires_at"))
    if datetime.datetime.utcnow() > exp:
        con.execute("DELETE FROM email_otps WHERE id=?", (int(_rget(row, "id")),))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Code expired")

    attempts = int(_rget(row, "attempts") or 0)
    if attempts >= OTP_MAX_ATTEMPTS:
        con.execute("DELETE FROM email_otps WHERE id=?", (int(_rget(row, "id")),))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Too many attempts")

    if otp_hash(code) != (_rget(row, "code_hash") or ""):
        con.execute("UPDATE email_otps SET attempts=attempts+1 WHERE id=?", (int(_rget(row, "id")),))
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Wrong code")

    payload_db = {}
    try:
        payload_db = json.loads(_rget(row, "payload") or "{}")
    except Exception:
        payload_db = {}

    if int(payload_db.get("user_id") or 0) != int(u["id"]):
        con.close()
        raise HTTPException(status_code=403, detail="Forbidden")

    # apply
    con.execute("UPDATE users SET email=? WHERE id=?", (new_email, int(u["id"])))
    con.execute("DELETE FROM email_otps WHERE id=?", (int(_rget(row, "id")),))
    con.commit()
    con.close()
    return {"ok": True}




# ----------------------------
# Profile Templates v2 (multiple + selected + AGE GROUP)
# ----------------------------
DEFAULT_PROFILE_TITLE = "⭐ ТОП {year_tag} | {donate_tag} ДОНАТА"
DEFAULT_PROFILE_DESC = (
    "✨ Аккаунт готов к игре!\n"
    "👤 Ник: {username}\n"
    "🔗 Профиль: {profile_link}\n"
    "💰 Robux: {robux}\n"
    "💎 RAP: {rap_tag}\n"
    "💳 Донат/траты: {donate_tag}\n"
    "📅 Год: {year_tag}\n"
    "🧾 Инвентарь: {inv_ru}\n"
)

def ensure_profile_templates_schema():
    con = db_conn()
    try:
        if USE_PG:
            con.execute(
                "CREATE TABLE IF NOT EXISTS profile_templates("
                "id SERIAL PRIMARY KEY, "
                "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                "name TEXT NOT NULL, "
                "title_tpl TEXT NOT NULL, "
                "desc_tpl TEXT NOT NULL, "
                "age_group INTEGER NOT NULL DEFAULT 13, "
                "is_default INTEGER NOT NULL DEFAULT 0, "
                "created_at TEXT NOT NULL, "
                "updated_at TEXT NOT NULL"
                ")"
            )
            con.execute("CREATE INDEX IF NOT EXISTS idx_profile_templates_user ON profile_templates(user_id, id DESC)")
            con.execute(
                "CREATE TABLE IF NOT EXISTS profile_template_state("
                "user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, "
                "selected_template_id INTEGER REFERENCES profile_templates(id) ON DELETE SET NULL, "
                "updated_at TEXT NOT NULL"
                ")"
            )
        else:
            con.execute(
                "CREATE TABLE IF NOT EXISTS profile_templates("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "user_id INTEGER NOT NULL, "
                "name TEXT NOT NULL, "
                "title_tpl TEXT NOT NULL, "
                "desc_tpl TEXT NOT NULL, "
                "age_group INTEGER NOT NULL DEFAULT 13, "
                "is_default INTEGER NOT NULL DEFAULT 0, "
                "created_at TEXT NOT NULL, "
                "updated_at TEXT NOT NULL, "
                "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE"
                ")"
            )
            con.execute("CREATE INDEX IF NOT EXISTS idx_profile_templates_user ON profile_templates(user_id, id DESC)")
            con.execute(
                "CREATE TABLE IF NOT EXISTS profile_template_state("
                "user_id INTEGER PRIMARY KEY, "
                "selected_template_id INTEGER, "
                "updated_at TEXT NOT NULL, "
                "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, "
                "FOREIGN KEY(selected_template_id) REFERENCES profile_templates(id) ON DELETE SET NULL"
                ")"
            )
        con.commit()
    finally:
        con.close()

def _ensure_default_template(con, uid: int) -> int:
    # returns default template id
    uid = int(uid)
    row = con.execute("SELECT id FROM profile_templates WHERE user_id=? ORDER BY is_default DESC, id DESC LIMIT 1", (uid,)).fetchone()
    if row:
        # ensure at least one default exists
        def_row = con.execute("SELECT id FROM profile_templates WHERE user_id=? AND is_default=1 LIMIT 1", (uid,)).fetchone()
        if def_row:
            return int(_rget(def_row, "id") or 0)
        # mark newest as default
        tid = int(_rget(row, "id") or 0)
        con.execute("UPDATE profile_templates SET is_default=1 WHERE id=? AND user_id=?", (tid, uid))
        return tid

    # try import from legacy single-template table (if exists)
    title_tpl = DEFAULT_PROFILE_TITLE
    desc_tpl = DEFAULT_PROFILE_DESC
    try:
        old = con.execute("SELECT title_tpl, desc_tpl FROM templates WHERE user_id=? LIMIT 1", (uid,)).fetchone()
        if old:
            title_tpl = str(_rget(old, "title_tpl") or title_tpl)
            desc_tpl = str(_rget(old, "desc_tpl") or desc_tpl)
    except Exception:
        pass

    ts = _now_utc_iso()
    if USE_PG:
        ins = con.execute(
            "INSERT INTO profile_templates(user_id,name,title_tpl,desc_tpl,age_group,is_default,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?) RETURNING id",
            (uid, "Default", title_tpl, desc_tpl, 13, 1, ts, ts),
        ).fetchone()
        tid = int(_rget(ins, "id") or 0)
    else:
        cur = con.execute(
            "INSERT INTO profile_templates(user_id,name,title_tpl,desc_tpl,age_group,is_default,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (uid, "Default", title_tpl, desc_tpl, 13, 1, ts, ts),
        )
        tid = int(cur.lastrowid)

    # set selection
    try:
        if USE_PG:
            con.execute(
                "INSERT INTO profile_template_state(user_id, selected_template_id, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET selected_template_id=EXCLUDED.selected_template_id, updated_at=EXCLUDED.updated_at",
                (uid, tid, ts),
            )
        else:
            con.execute(
                "INSERT INTO profile_template_state(user_id, selected_template_id, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET selected_template_id=excluded.selected_template_id, updated_at=excluded.updated_at",
                (uid, tid, ts),
            )
    except Exception:
        # sqlite older versions might not support excluded for columns; fall back
        try:
            con.execute("DELETE FROM profile_template_state WHERE user_id=?", (uid,))
            con.execute("INSERT INTO profile_template_state(user_id, selected_template_id, updated_at) VALUES(?,?,?)", (uid, tid, ts))
        except Exception:
            pass

    return tid

def _get_selected_template_id(con, uid: int) -> int:
    uid = int(uid)
    _ensure_default_template(con, uid)
    row = con.execute("SELECT selected_template_id FROM profile_template_state WHERE user_id=? LIMIT 1", (uid,)).fetchone()
    if row and _rget(row, "selected_template_id"):
        return int(_rget(row, "selected_template_id") or 0)
    # fallback: default template
    d = con.execute("SELECT id FROM profile_templates WHERE user_id=? AND is_default=1 LIMIT 1", (uid,)).fetchone()
    return int(_rget(d, "id") or 0) if d else 0

def _set_selected_template_id(con, uid: int, tid: int):
    uid = int(uid); tid = int(tid)
    ts = _now_utc_iso()
    # validate ownership
    ok = con.execute("SELECT id FROM profile_templates WHERE id=? AND user_id=? LIMIT 1", (tid, uid)).fetchone()
    if not ok:
        raise HTTPException(status_code=404, detail="Template not found")
    # upsert
    try:
        if USE_PG:
            con.execute(
                "INSERT INTO profile_template_state(user_id, selected_template_id, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET selected_template_id=EXCLUDED.selected_template_id, updated_at=EXCLUDED.updated_at",
                (uid, tid, ts),
            )
        else:
            con.execute(
                "INSERT INTO profile_template_state(user_id, selected_template_id, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET selected_template_id=excluded.selected_template_id, updated_at=excluded.updated_at",
                (uid, tid, ts),
            )
    except Exception:
        con.execute("DELETE FROM profile_template_state WHERE user_id=?", (uid,))
        con.execute("INSERT INTO profile_template_state(user_id, selected_template_id, updated_at) VALUES(?,?,?)", (uid, tid, ts))

def _list_templates(con, uid: int) -> List[Dict[str, Any]]:
    uid = int(uid)
    _ensure_default_template(con, uid)
    rows = con.execute(
        "SELECT id, name, title_tpl, desc_tpl, age_group, is_default, created_at, updated_at "
        "FROM profile_templates WHERE user_id=? ORDER BY is_default DESC, id DESC",
        (uid,),
    ).fetchall() or []
    items = []
    for r in rows:
        items.append({
            "id": int(_rget(r, "id") or 0),
            "name": str(_rget(r, "name") or "Template"),
            "title_tpl": str(_rget(r, "title_tpl") or ""),
            "desc_tpl": str(_rget(r, "desc_tpl") or ""),
            "age_group": int(_rget(r, "age_group") or 13),
            "is_default": int(_rget(r, "is_default") or 0) == 1,
            "created_at": str(_rget(r, "created_at") or ""),
            "updated_at": str(_rget(r, "updated_at") or ""),
        })
    return items

@app.get("/api/profile/templates")
def api_profile_templates(request: Request):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    con = db_conn()
    ensure_profile_templates_schema()
    try:
        items = _list_templates(con, u["id"])
        selected_id = _get_selected_template_id(con, u["id"])
        con.commit()
    finally:
        con.close()
    return {"ok": True, "items": items, "selected_id": selected_id}

@app.post("/api/profile/templates/create")
def api_profile_templates_create(request: Request, payload: Dict[str, Any]):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    con = db_conn()
    ensure_profile_templates_schema()
    try:
        uid = int(u["id"])
        _ensure_default_template(con, uid)
        sid = _get_selected_template_id(con, uid)
        src = con.execute("SELECT title_tpl, desc_tpl, age_group FROM profile_templates WHERE id=? AND user_id=?", (sid, uid)).fetchone()
        title_tpl = str(_rget(src, "title_tpl") or DEFAULT_PROFILE_TITLE) if src else DEFAULT_PROFILE_TITLE
        desc_tpl = str(_rget(src, "desc_tpl") or DEFAULT_PROFILE_DESC) if src else DEFAULT_PROFILE_DESC
        age_group = int(_rget(src, "age_group") or 13) if src else 13
        ts = _now_utc_iso()
        if USE_PG:
            row = con.execute(
                "INSERT INTO profile_templates(user_id,name,title_tpl,desc_tpl,age_group,is_default,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?) RETURNING id",
                (uid, name, title_tpl, desc_tpl, age_group, 0, ts, ts),
            ).fetchone()
            tid = int(_rget(row, "id") or 0)
        else:
            cur = con.execute(
                "INSERT INTO profile_templates(user_id,name,title_tpl,desc_tpl,age_group,is_default,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (uid, name, title_tpl, desc_tpl, age_group, 0, ts, ts),
            )
            tid = int(cur.lastrowid)
        _set_selected_template_id(con, uid, tid)
        con.commit()
    finally:
        con.close()
    return {"ok": True, "id": tid}

@app.post("/api/profile/templates/select")
def api_profile_templates_select(request: Request, payload: Dict[str, Any]):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    tid = int(payload.get("template_id") or 0)
    if tid <= 0:
        raise HTTPException(status_code=400, detail="template_id required")
    con = db_conn()
    ensure_profile_templates_schema()
    try:
        _set_selected_template_id(con, u["id"], tid)
        con.commit()
    finally:
        con.close()
    return {"ok": True}

@app.post("/api/profile/templates/update")
def api_profile_templates_update(request: Request, payload: Dict[str, Any]):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    tid = int(payload.get("template_id") or 0)
    if tid <= 0:
        raise HTTPException(status_code=400, detail="template_id required")
    title_tpl = str(payload.get("title_tpl") or "")
    desc_tpl = str(payload.get("desc_tpl") or "")
    try:
        age_group = int(payload.get("age_group") or 13)
    except Exception:
        age_group = 13
    if age_group not in (0, 13, 16, 18, 21):
        age_group = 13

    con = db_conn()
    ensure_profile_templates_schema()
    try:
        uid = int(u["id"])
        ok = con.execute("SELECT id FROM profile_templates WHERE id=? AND user_id=?", (tid, uid)).fetchone()
        if not ok:
            raise HTTPException(status_code=404, detail="Template not found")
        ts = _now_utc_iso()
        con.execute(
            "UPDATE profile_templates SET title_tpl=?, desc_tpl=?, age_group=?, updated_at=? WHERE id=? AND user_id=?",
            (title_tpl, desc_tpl, age_group, ts, tid, uid),
        )
        con.commit()
    finally:
        con.close()
    return {"ok": True}

@app.post("/api/profile/templates/delete")
def api_profile_templates_delete(request: Request, payload: Dict[str, Any]):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    tid = int(payload.get("template_id") or 0)
    if tid <= 0:
        raise HTTPException(status_code=400, detail="template_id required")

    con = db_conn()
    ensure_profile_templates_schema()
    try:
        uid = int(u["id"])
        row = con.execute("SELECT is_default FROM profile_templates WHERE id=? AND user_id=?", (tid, uid)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Template not found")
        if int(_rget(row, "is_default") or 0) == 1:
            raise HTTPException(status_code=400, detail="Default template cannot be deleted")

        con.execute("DELETE FROM profile_templates WHERE id=? AND user_id=?", (tid, uid))
        # if deleted selected, reset to default
        sid = _get_selected_template_id(con, uid)
        if sid == tid:
            d = con.execute("SELECT id FROM profile_templates WHERE user_id=? AND is_default=1 LIMIT 1", (uid,)).fetchone()
            if d:
                _set_selected_template_id(con, uid, int(_rget(d, "id") or 0))
        con.commit()
    finally:
        con.close()
    return {"ok": True}

@app.get("/api/user/templates")
def user_templates_get(request: Request):
    """Legacy endpoint: returns selected template fields."""
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    ensure_profile_templates_schema()
    con = db_conn()
    try:
        uid = int(u["id"])
        sid = _get_selected_template_id(con, uid)
        row = con.execute("SELECT title_tpl, desc_tpl FROM profile_templates WHERE id=? AND user_id=?", (sid, uid)).fetchone()
        if not row:
            return {"ok": True, "title_tpl": "", "desc_tpl": ""}
        return {"ok": True, "title_tpl": str(_rget(row, "title_tpl") or ""), "desc_tpl": str(_rget(row, "desc_tpl") or "")}
    finally:
        con.close()

@app.post("/api/user/templates")
def user_templates_set(request: Request, payload: Dict[str, Any]):
    """Legacy endpoint: updates selected template (title/desc)."""
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    title_tpl = str(payload.get("title_tpl") or "")
    desc_tpl = str(payload.get("desc_tpl") or "")
    ensure_profile_templates_schema()
    con = db_conn()
    try:
        uid = int(u["id"])
        sid = _get_selected_template_id(con, uid)
        ts = _now_utc_iso()
        con.execute(
            "UPDATE profile_templates SET title_tpl=?, desc_tpl=?, updated_at=? WHERE id=? AND user_id=?",
            (title_tpl, desc_tpl, ts, int(sid), uid),
        )
        con.commit()
    finally:
        con.close()
    return {"ok": True}


@app.get("/api/user/chat_history")
def user_chat_history(request: Request):
    require_premium(request)
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    con = db_conn()
    rows = con.execute(
        "SELECT role, content, ts FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 50",
        (u["id"],),
    ).fetchall()
    con.close()
    msgs = [{"role": r["role"], "content": r["content"], "ts": r["ts"]} for r in reversed(rows)]
    return {"ok": True, "messages": msgs}

@app.post("/api/user/chat_clear")
def user_chat_clear(request: Request):
    require_premium(request)
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    con = db_conn()
    con.execute("DELETE FROM chat_messages WHERE user_id=?", (u["id"],))
    con.commit()
    con.close()
    return {"ok": True}

@app.get("/api/user/tool_history")
def api_user_tool_history(request: Request, tool: str = ""):
    """Get tool usage history for current user."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    if tool:
        rows = con.execute(
            "SELECT id, tool, input_short, result_short, status, created_at FROM tool_history WHERE user_id=? AND tool=? ORDER BY id DESC LIMIT 50",
            (uid, tool)).fetchall()
    else:
        rows = con.execute(
            "SELECT id, tool, input_short, result_short, status, created_at FROM tool_history WHERE user_id=? ORDER BY id DESC LIMIT 50",
            (uid,)).fetchall()
    con.close()
    items = [{"id": r["id"], "tool": r["tool"], "input": r["input_short"] or "", "result": r["result_short"] or "", "status": r["status"] or "ok", "ts": r["created_at"] or ""} for r in rows]
    return {"ok": True, "items": items}

# ----------------------------
# Models
# ----------------------------
@app.get("/api/models/pollinations")
def pollinations_models():
    try:
        r = requests.get(POLLINATIONS_MODELS_URL, timeout=DEFAULT_TIMEOUT)
        if r.status_code != 200:
            return {"ok": True, "models": ["openai", "mistral", "searchgpt"]}
        models = r.json()
        models = [m for m in models if isinstance(m, str)]
        return {"ok": True, "models": models}
    except Exception:
        return {"ok": True, "models": ["openai", "mistral", "searchgpt"]}

# ----------------------------
# ----------------------------
# Case (free every 48h) + captcha
# ----------------------------
CASE_COOLDOWN_HOURS = 48

# Legacy prize lists (still used by old /api/case/open endpoint)
CASE_PRIZES = [
    ("P5M",  5000),
    ("P15M", 2500),
    ("P30M", 1500),
    ("P1H",   800),
    ("P1D",   200),
]

CASE_PAID_PRICE = 17
CASE_PAID_DAILY_LIMIT = 2

CASE_PAID_PRIZES = [
    ("P30M", 3000),
    ("P1H",  2500),
    ("B17",  2000),
    ("P1D",  1500),
    ("P2D",   700),
    ("P3D",   300),
]


# ----------------------------
# Case inventory (store case prizes; user redeems when wants)
# ----------------------------
CASE_INV_MAX = 3

def _ensure_case_inventory_table(con):
    if USE_PG:
        con.execute("""
            CREATE TABLE IF NOT EXISTS case_inventory(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL,
              prize TEXT NOT NULL,
              created_at TEXT NOT NULL,
              used_at TEXT,
              meta TEXT
            )
        """)

    else:
        con.execute("""
            CREATE TABLE IF NOT EXISTS case_inventory(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              prize TEXT NOT NULL,
              created_at TEXT NOT NULL,
              used_at TEXT,
              meta TEXT
            )
        """)

def _case_inventory_count_unused(con, uid: int) -> int:
    _ensure_case_inventory_table(con)
    row = con.execute(
        "SELECT COUNT(1) as c FROM case_inventory WHERE user_id=? AND (used_at IS NULL OR used_at='')",
        (int(uid),),
    ).fetchone()
    return int(_rget(row, "c") or 0)

def _case_inventory_add(con, uid: int, prize: str):
    _ensure_case_inventory_table(con)
    con.execute(
        "INSERT INTO case_inventory(user_id, prize, created_at, used_at, meta) VALUES(?,?,?,?,?)",
        (int(uid), str(prize), _now_utc_iso(), None, None),
    )

def _apply_case_prize(uid: int, prize: str):
    """Apply a stored prize to user account."""
    defs = _prize_defs()
    p = defs.get(prize)
    if not p:
        return  # unknown prize, ignore

    kind = p.get("kind", "")
    con = db_conn()
    ts = _now_utc_iso()

    if kind == "premium":
        delta = p.get("delta")
        if isinstance(delta, datetime.timedelta):
            _extend_premium_in_conn(con, int(uid), delta)
            con.commit()
    elif kind == "balance":
        delta_val = int(p.get("delta") or 0)
        if delta_val != 0:
            row = con.execute("SELECT balance FROM users WHERE id=?", (int(uid),)).fetchone()
            bal = int(_rget(row, "balance") or 0) if row else 0
            new_bal = max(0, bal + delta_val)
            eff = new_bal - bal
            con.execute("UPDATE users SET balance=? WHERE id=?", (int(new_bal), int(uid)))
            if eff != 0:
                con.execute(
                    "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                    (int(uid), None, int(eff), f"case_prize:{prize}", ts),
                )
            con.commit()
    # kind == "none" or unknown: do nothing

    con.close()


@app.get("/api/inventory/list")
def api_inventory_list(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    _ensure_case_inventory_table(con)
    rows = con.execute(
        "SELECT id, prize, created_at FROM case_inventory WHERE user_id=? AND (used_at IS NULL OR used_at='') ORDER BY id DESC",
        (uid,),
    ).fetchall()
    cnt = len(rows)
    con.close()
    items = [{"id": int(_rget(r,"id") or 0), "prize": _rget(r,"prize"), "created_at": _rget(r,"created_at")} for r in rows]
    return {"ok": True, "max": CASE_INV_MAX, "count": cnt, "items": items}


@app.post("/api/inventory/use")
def api_inventory_use(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])
    try:
        item_id = int(payload.get("item_id") or payload.get("id") or 0)
    except Exception:
        item_id = 0
    if item_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid id")

    con = db_conn()
    _ensure_case_inventory_table(con)
    row = con.execute(
        "SELECT id, prize FROM case_inventory WHERE id=? AND user_id=? AND (used_at IS NULL OR used_at='')",
        (int(item_id), uid),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Not found")

    prize = str(_rget(row, "prize") or "")

    # apply (may raise if premium already active)
    con.close()
    _apply_case_prize(uid, prize)

    con = db_conn()
    ts = _now_utc_iso()
    con.execute("UPDATE case_inventory SET used_at=? WHERE id=? AND user_id=?", (ts, int(item_id), uid))
    con.commit(); con.close()
    return {"ok": True, "prize": prize, "limits": user_limits(uid)}


def _pick_weighted(items):
    total = sum(w for _, w in items)
    r = random.uniform(0, total)
    upto = 0.0
    for k, w in items:
        upto += w
        if upto >= r:
            return k
    return items[-1][0]

def _case_token_make(uid: int, a: int, b: int) -> str:
    payload = {"uid": uid, "a": a, "b": b, "typ": "case", "exp": int((_now_utc() + datetime.timedelta(minutes=5)).timestamp())}
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)

def _case_token_read(token: str) -> Optional[Dict[str, Any]]:
    try:
        data = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALG])
        if data.get("typ") != "case":
            return None
        return data
    except Exception:
        return None

def _apply_premium(uid: int, delta: datetime.timedelta):
    con = db_conn()
    row = con.execute("SELECT premium_until FROM users WHERE id=?", (uid,)).fetchone()
    cur = _parse_iso((_rget(row, "premium_until") if row else "") or "")
    base = cur if (cur and _now_utc() < cur) else _now_utc()
    new_until = (base + delta).isoformat()
    con.execute("UPDATE users SET premium_until=? WHERE id=?", (new_until, uid))
    con.commit()
    con.close()


@app.post("/api/inventory/delete")
def api_inventory_delete(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])
    try:
        item_id = int(payload.get("item_id") or payload.get("id") or 0)
    except Exception:
        item_id = 0
    if item_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid id")

    con = db_conn()
    _ensure_case_inventory_table(con)
    row = con.execute(
        "SELECT id FROM case_inventory WHERE id=? AND user_id=? AND (used_at IS NULL OR used_at='')",
        (item_id, uid),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")

    con.execute("DELETE FROM case_inventory WHERE id=? AND user_id=?", (item_id, uid))
    con.commit()
    con.close()
    return {"ok": True}


@app.get("/api/case/status")
def api_case_status(request: Request):
    u = require_user(request)
    lim = user_limits(int(u["id"]))
    nxt = _parse_iso(lim.get("case_next_at") or "")
    ready = (not nxt) or (_now_utc() >= nxt)
    return {"ok": True, "ready": ready, "next_at": (lim.get("case_next_at") or None), "limits": lim}

@app.get("/api/case/challenge")
def api_case_challenge(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    lim = user_limits(uid)
    nxt = _parse_iso(lim.get("case_next_at") or "")
    if nxt and _now_utc() < nxt:
        raise HTTPException(status_code=429, detail="Case cooldown")

    a = random.randint(2, 9)
    b = random.randint(2, 9)
    tok = _case_token_make(uid, a, b)
    return {"ok": True, "a": a, "b": b, "token": tok}

@app.post("/api/case/open")
def api_case_open(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])

    tok = (payload.get("token") or "").strip()
    ans = payload.get("answer")
    if not tok or ans is None:
        raise HTTPException(status_code=400, detail="Captcha required")

    data = _case_token_read(tok)
    if not data or int(data.get("uid", -1)) != uid:
        raise HTTPException(status_code=400, detail="Captcha invalid")

    try:
        ans_i = int(ans)
    except Exception:
        raise HTTPException(status_code=400, detail="Captcha invalid")

    if ans_i != int(data.get("a", 0)) + int(data.get("b", 0)):
        raise HTTPException(status_code=400, detail="Captcha wrong")

    lim = user_limits(uid)
    nxt = _parse_iso(lim.get("case_next_at") or "")
    if nxt and _now_utc() < nxt:
        raise HTTPException(status_code=429, detail="Case cooldown")

    prize = _pick_weighted(CASE_PRIZES)

    con = db_conn()
    # inventory capacity check
    if _case_inventory_count_unused(con, uid) >= CASE_INV_MAX:
        con.close()
        raise HTTPException(status_code=409, detail="Инвентарь полон (макс. %d)" % CASE_INV_MAX)
    # ensure spins table exists
    if USE_PG:
        con.execute("""
            CREATE TABLE IF NOT EXISTS case_spins(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL,
              prize TEXT NOT NULL,
              ts TEXT NOT NULL
            )
        """)
    else:
        con.execute("""
            CREATE TABLE IF NOT EXISTS case_spins(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              prize TEXT NOT NULL,
              ts TEXT NOT NULL
            )
        """)

    # Apply prize immediately
    defs = _prize_defs()
    p = defs.get(prize, {})
    if p.get("kind") == "premium":
        delta = p.get("delta")
        if isinstance(delta, datetime.timedelta):
            _extend_premium_in_conn(con, uid, delta)
        _case_inventory_add(con, uid, prize)
    elif p.get("kind") == "balance":
        delta_val = int(p.get("delta") or 0)
        if delta_val != 0:
            con.execute("UPDATE users SET balance=balance+? WHERE id=?", (delta_val, uid))
            con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                        (uid, None, delta_val, f"case_free:{prize}", _now_utc_iso()))

    next_at = (_now_utc() + datetime.timedelta(hours=CASE_COOLDOWN_HOURS)).isoformat()
    con.execute("UPDATE users SET case_next_at=? WHERE id=?", (next_at, uid))
    # log spin
    con.execute("INSERT INTO case_spins(user_id, prize, ts) VALUES(?,?,?)", (uid, prize, _now_utc_iso()))

    con.commit()
    con.close()

    return {"ok": True, "prize": prize, "next_at": next_at, "limits": user_limits(uid)}


@app.post("/api/case/open_paid")
def api_case_open_paid(request: Request, payload: Dict[str, Any]):
    """Paid case: opens instantly for balance (no captcha, no cooldown)."""
    u = require_user(request)
    uid = int(u["id"])

    con = db_conn()
    row = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
    bal = int(_rget(row, "balance") or 0)

    if bal < CASE_PAID_PRICE:
        con.close()
        raise HTTPException(status_code=402, detail="Недостаточно средств")

    # inventory capacity check
    if _case_inventory_count_unused(con, uid) >= CASE_INV_MAX:
        con.close()
        raise HTTPException(status_code=409, detail="Инвентарь полон (макс. %d)" % CASE_INV_MAX)

    # Daily limit for paid case
    try:
        today_start = datetime.datetime.utcnow().strftime("%Y-%m-%dT00:00:00")
        today_cnt_row = con.execute(
            "SELECT COUNT(*) as cnt FROM case_spins WHERE user_id=? AND ts>=?",
            (uid, today_start)
        ).fetchone()
        today_cnt = _count_val(today_cnt_row, "cnt")
        if today_cnt >= CASE_PAID_DAILY_LIMIT:
            con.close()
            raise HTTPException(status_code=429, detail="Лимит %d платных кейсов в сутки исчерпан" % CASE_PAID_DAILY_LIMIT)
    except HTTPException:
        raise
    except Exception:
        pass  # Table may not exist yet on first spin

    prize = _pick_weighted(CASE_PAID_PRIZES)

    # ensure spins table exists
    if USE_PG:
        con.execute("""
            CREATE TABLE IF NOT EXISTS case_spins(
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL,
              prize TEXT NOT NULL,
              ts TEXT NOT NULL
            )
        """)
    else:
        con.execute("""
            CREATE TABLE IF NOT EXISTS case_spins(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              prize TEXT NOT NULL,
              ts TEXT NOT NULL
            )
        """)

    # Deduct balance + tx
    ts = _now_utc_iso()
    con.execute("UPDATE users SET balance=balance-? WHERE id=?", (int(CASE_PAID_PRICE), uid))
    con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                (uid, None, -int(CASE_PAID_PRICE), "case paid", ts))

    # Apply prize immediately
    defs_p = _prize_defs()
    pp = defs_p.get(prize, {})
    if pp.get("kind") == "premium":
        delta_p = pp.get("delta")
        if isinstance(delta_p, datetime.timedelta):
            _extend_premium_in_conn(con, uid, delta_p)
        _case_inventory_add(con, uid, prize)
    elif pp.get("kind") == "balance":
        delta_v = int(pp.get("delta") or 0)
        if delta_v != 0:
            con.execute("UPDATE users SET balance=balance+? WHERE id=?", (delta_v, uid))
            con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                        (uid, None, delta_v, f"case_paid:{prize}", ts))

    # log spin
    con.execute("INSERT INTO case_spins(user_id, prize, ts) VALUES(?,?,?)", (uid, prize, ts))
    con.commit()
    con.close()

    return {"ok": True, "prize": prize, "price": CASE_PAID_PRICE, "limits": user_limits(uid)}


# ----------------------------
# Cases v2 (CS-style roulette)
# ----------------------------

def _client_ip(request: Request) -> str:
    # Prefer reverse-proxy headers (Cloudflare/Render) when present
    h = request.headers
    ip = (h.get('cf-connecting-ip') or h.get('x-real-ip') or '').strip()
    if not ip:
        xff = (h.get('x-forwarded-for') or '').split(',')[0].strip()
        ip = xff
    if not ip:
        ip = getattr(getattr(request, 'client', None), 'host', None) or ''
    return ip or '0.0.0.0'


_RL: Dict[str, List[float]] = {}

def _rate_limit(key: str, limit: int, period_s: int):
    """Simple sliding-window rate limit (best-effort, in-memory)."""
    now = time.time()
    arr = _RL.get(key)
    if arr is None:
        arr = []
        _RL[key] = arr
    # drop old
    cutoff = now - float(period_s)
    i = 0
    while i < len(arr) and arr[i] < cutoff:
        i += 1
    if i:
        del arr[:i]
    if len(arr) >= int(limit):
        raise HTTPException(status_code=429, detail="Too many requests")
    arr.append(now)


def _prize_defs() -> Dict[str, Dict[str, Any]]:
    # tiers: 1=common 2=rare 3=epic 4=legendary 5=mythic
    # New prizes: 5min, 15min, 30min, 1h, 1day premium
    return {
        # Free case prizes (time-based premium)
        "P5M":  {"label": "⭐ Premium 5 минут",   "kind": "premium", "tier": 1, "delta": datetime.timedelta(minutes=5),  "emoji": "⭐"},
        "P15M": {"label": "🔷 Premium 15 минут",  "kind": "premium", "tier": 2, "delta": datetime.timedelta(minutes=15), "emoji": "🔷"},
        "P30M": {"label": "💎 Premium 30 минут",  "kind": "premium", "tier": 3, "delta": datetime.timedelta(minutes=30), "emoji": "💎"},
        "P1H":  {"label": "✨ Premium 1 час",      "kind": "premium", "tier": 4, "delta": datetime.timedelta(hours=1),   "emoji": "✨"},
        "P1D":  {"label": "🌟 Premium 1 день",     "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=1),    "emoji": "🌟"},
        # Legacy (kept for backwards compat / paid case)
        "P6H":  {"label": "✨ Premium 6 часов",   "kind": "premium", "tier": 3, "delta": datetime.timedelta(hours=6),   "emoji": "✨"},
        "P12H": {"label": "💎 Premium 12 часов",  "kind": "premium", "tier": 4, "delta": datetime.timedelta(hours=12),  "emoji": "💎"},
        "P2D":  {"label": "🌟 Premium 2 дня",     "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=2),    "emoji": "🌟"},
        "P3D":  {"label": "🌟 Premium 3 дня",     "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=3),    "emoji": "🌟"},
        "P5D":  {"label": "🌟 Premium 5 дней",    "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=5),    "emoji": "🌟"},
        "P7D":  {"label": "🌟 Premium 7 дней",    "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=7),    "emoji": "🌟"},
        "P10D": {"label": "🌟 Premium 10 дней",   "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=10),   "emoji": "🌟"},
        "P14D": {"label": "🌟 Premium 14 дней",   "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=14),   "emoji": "🌟"},
        "P20D": {"label": "🌟 Premium 20 дней",   "kind": "premium", "tier": 5, "delta": datetime.timedelta(days=20),   "emoji": "🌟"},
        "B17":  {"label": "💰 +17 ₽ на баланс",  "kind": "balance", "tier": 3, "delta": 17},
        # Money case
        "M+1":  {"label": "💸 +1 ₽",             "kind": "balance", "tier": 2, "delta": 1},
        "M+2":  {"label": "💸 +2 ₽",             "kind": "balance", "tier": 3, "delta": 2},
        "M0":   {"label": "😶 Ничего",           "kind": "none",    "tier": 1, "delta": 0},
        "M-2":  {"label": "💥 -2 ₽",             "kind": "balance", "tier": 2, "delta": -2},
        # AI/credits
        "GEN10":{"label": "🤖 10 AI кредитов",   "kind": "credits_ai", "tier": 2, "delta": 10},
        "AI3":  {"label": "🔍 3 анализа",        "kind": "credits_analyze", "tier": 2, "delta": 3},
    }


CASE_V2 = {
    "free": {
        "title": "Бесплатный кейс",
        "desc": "Открывается раз в 2 дня. Выиграй Premium!",
        "price": 0,
        "cooldown_h": 48,
        "next_field": "case_next_at",
        "prizes": [
            # Чем лучше приз — тем ниже шанс
            ("P5M",  5000),   # 50.0% - Common
            ("P15M", 2500),   # 25.0% - Rare
            ("P30M", 1500),   # 15.0% - Epic
            ("P1H",   800),   #  8.0% - Legendary
            ("P1D",   200),   #  2.0% - Mythic
        ],
    },
    "paid": {
        "title": "Платный кейс",
        "desc": "Стоит 17 ₽ с баланса. Лучшие шансы!",
        "price": 17,
        "cooldown_h": 0,
        "next_field": None,
        "prizes": [
            ("P30M", 3000),   # 30.0% - Epic
            ("P1H",  2500),   # 25.0% - Legendary
            ("B17",  2000),   # 20.0% - Epic (вернул деньги)
            ("P1D",  1500),   # 15.0% - Mythic
            ("P2D",   700),   #  7.0% - Mythic
            ("P3D",   300),   #  3.0% - Mythic
        ],
    },
    "money": {
        "title": "Денежный кейс",
        "desc": "Чистое везение: +1 / +2 / ничего / -2 (по 25%).",
        "price": 0,
        "cooldown_h": 24,
        "next_field": "case_money_next_at",
        "prizes": [
            ("M+1", 1),
            ("M+2", 1),
            ("M0",  1),
            ("M-2", 1),
        ],
    },
}


def _case_pick(case_id: str) -> str:
    d = CASE_V2.get(case_id)
    if not d:
        raise HTTPException(status_code=400, detail="Unknown case")
    items = d.get("prizes") or []
    if not items:
        raise HTTPException(status_code=500, detail="Case misconfigured")
    return _pick_weighted(items)


def _case_build_reel(case_id: str, win_code: str, size: int = 80) -> Tuple[List[str], int]:
    d = CASE_V2.get(case_id) or {}
    pool = [p for p, _ in (d.get("prizes") or [])]
    if not pool:
        pool = [win_code]
    reel = []
    for i in range(int(size)):
        reel.append(random.choice(pool))
    # Place winner in the middle third of the reel (not too close to edges)
    win_index = random.randint(max(15, size // 3), min(size - 15, size * 2 // 3))
    reel[win_index] = win_code
    return reel, win_index


def _extend_premium_in_conn(con, uid: int, delta: datetime.timedelta):
    row = con.execute("SELECT premium_until FROM users WHERE id=?", (int(uid),)).fetchone()
    cur = _parse_iso((_rget(row, "premium_until") if row else "") or "")
    base = cur if (cur and _now_utc() < cur) else _now_utc()
    new_until = (base + delta).isoformat()
    con.execute("UPDATE users SET premium_until=? WHERE id=?", (new_until, int(uid)))


@app.get("/api/cases/config")
def api_cases_config(request: Request):
    defs = _prize_defs()
    # banners + colors per case
    case_assets = {
        "free": {"banner_url": "/static/banners/case_free_new.png", "color": "linear-gradient(135deg,#1a0b2e,#3b0764 50%,#7c2d12)"},
        "paid": {"banner_url": "/static/banners/case_premium.png", "color": "linear-gradient(135deg,#1e1b4b,#581c87 50%,#7c2d12)"},
        "money": {"banner_url": "/static/banners/Case 17rub.svg", "color": "linear-gradient(135deg,#fbbf24,#f59e0b 60%,#d97706)"},
    }
    cases = []
    for cid, c in CASE_V2.items():
        prizes = []
        for code, w in (c.get("prizes") or []):
            p = defs.get(code, {"label": code, "tier": 1, "kind": "unknown"})
            prizes.append({"code": code, "weight": int(w), "label": p.get("label"), "tier": int(p.get("tier") or 1), "kind": p.get("kind"), "icon": p.get("icon", ""), "banner_color": p.get("banner_color", "")})
        a = case_assets.get(cid, {})
        cases.append({
            "id": cid,
            "title": c.get("title"),
            "desc": c.get("desc"),
            "price": int(c.get("price") or 0),
            "cooldown_h": int(c.get("cooldown_h") or 0),
            "banner_url": a.get("banner_url", ""),
            "banner_color": a.get("color", ""),
            "prizes": prizes,
        })
    return {"ok": True, "cases": cases}


@app.post("/api/cases/spin")
def api_cases_spin(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])
    case_id = str(payload.get("case_id") or "").strip() or "free"
    if case_id not in CASE_V2:
        raise HTTPException(status_code=400, detail="Unknown case")

    ip = _client_ip(request)
    # anti-fraud: basic IP + user throttles
    _rate_limit(f"case:{case_id}:ip:{ip}", limit=20, period_s=60)
    _rate_limit(f"case:{case_id}:uid:{uid}", limit=6, period_s=10)

    cdef = CASE_V2[case_id]
    defs = _prize_defs()

    con = db_conn()
    try:
        row = con.execute(
            "SELECT balance, case_next_at, case_money_next_at FROM users WHERE id=?",
            (uid,),
        ).fetchone()
        bal = int(_rget(row, "balance") or 0) if row else 0

        # cooldown per-case
        next_field = cdef.get("next_field")
        if next_field:
            nxt = _parse_iso(_rget(row, next_field) or "") if row else None
            if nxt and _now_utc() < nxt:
                raise HTTPException(status_code=429, detail="Case cooldown")

        price = int(cdef.get("price") or 0)
        if price > 0 and bal < price:
            raise HTTPException(status_code=402, detail="Not enough balance")

        win_code = _case_pick(case_id)
        p = defs.get(win_code) or {"label": win_code, "kind": "unknown", "tier": 1}
        ts = _now_utc_iso()

        # charge for paid case
        if price > 0:
            con.execute("UPDATE users SET balance=balance-? WHERE id=?", (price, uid))
            con.execute(
                "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                (uid, None, -price, f"case:{case_id} open", ts),
            )
            bal -= price

        # apply reward (server-side only)
        if p.get("kind") == "premium":
            delta = p.get("delta")
            if isinstance(delta, datetime.timedelta):
                _extend_premium_in_conn(con, uid, delta)
        elif p.get("kind") == "balance":
            delta = int(p.get("delta") or 0)
            new_bal = max(0, bal + delta)
            eff = new_bal - bal
            con.execute("UPDATE users SET balance=? WHERE id=?", (int(new_bal), uid))
            if eff != 0:
                con.execute(
                    "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                    (uid, None, int(eff), f"case:{case_id} prize:{win_code}", ts),
                )
            bal = new_bal

        # Only add PREMIUM prizes to inventory (balance already applied above)
        if p.get("kind") == "premium":
            try:
                _case_inventory_add(con, uid, win_code)
            except Exception:
                pass

        # set next open time
        next_at = None
        cd_h = int(cdef.get("cooldown_h") or 0)
        if next_field and cd_h > 0:
            next_at = (_now_utc() + datetime.timedelta(hours=cd_h)).isoformat()
            con.execute(f"UPDATE users SET {next_field}=? WHERE id=?", (next_at, uid))

        # log spin
        try:
            if USE_PG:
                con.execute(
                    """
                    CREATE TABLE IF NOT EXISTS case_spins(
                      id SERIAL PRIMARY KEY,
                      user_id INTEGER NOT NULL,
                      prize TEXT NOT NULL,
                      ts TEXT NOT NULL
                    )
                    """
                )
            else:
                con.execute(
                    """
                    CREATE TABLE IF NOT EXISTS case_spins(
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      user_id INTEGER NOT NULL,
                      prize TEXT NOT NULL,
                      ts TEXT NOT NULL
                    )
                    """
                )
            con.execute("INSERT INTO case_spins(user_id, prize, ts) VALUES(?,?,?)", (uid, f"{case_id}:{win_code}", ts))
        except Exception:
            pass

        con.commit()
    finally:
        con.close()

    reel, win_index = _case_build_reel(case_id, win_code)
    # refresh limits after commit
    lim = user_limits(uid)

    return {
        "ok": True,
        "case_id": case_id,
        "reel": reel,
        "win_index": int(win_index),
        "win": {"code": win_code, "label": p.get("label"), "tier": int(p.get("tier") or 1), "kind": p.get("kind")},
        "next_at": next_at,
        "balance": int(bal),
        "limits": lim,
    }


# ----------------------------
# Robux shop flow (wizard)
# ----------------------------

def _robux_rate_limit_or_raise(con, user_id: int):
    """Basic anti-spam: 1 order per 10s and max 5 per 60s."""
    now = _now_utc()
    ts10 = (now - datetime.timedelta(seconds=10)).isoformat()
    ts60 = (now - datetime.timedelta(seconds=60)).isoformat()
    r1 = con.execute(
        "SELECT COUNT(1) AS c FROM robux_orders WHERE user_id=? AND created_at>=?",
        (int(user_id), ts10),
    ).fetchone()
    c10 = int(_rget(r1, "c") or 0) if r1 else 0
    if c10 >= 1:
        raise HTTPException(status_code=429, detail="Слишком часто. Подожди пару секунд.")
    r2 = con.execute(
        "SELECT COUNT(1) AS c FROM robux_orders WHERE user_id=? AND created_at>=?",
        (int(user_id), ts60),
    ).fetchone()
    c60 = int(_rget(r2, "c") or 0) if r2 else 0
    if c60 >= 5:
        raise HTTPException(status_code=429, detail="Лимит заказов в минуту достигнут.")


# --- Robux order lifecycle helpers (reserve / pay / cancel / refund) ---

ROBUX_RESERVE_SECONDS = 7 * 60
ROBUX_SETTLE_SECONDS = 5 * 24 * 60 * 60  # UI timer (5 days)

def _now_ts() -> int:
    return int(time.time())

def _robux_expire_overdue(con) -> int:
    """Expire overdue reserved orders and refund held balance. Returns count expired."""
    now_ts = _now_ts()
    # Find overdue orders (limit to keep it cheap)
    rows = con.execute(
        "SELECT id, user_id, rub_price FROM robux_orders WHERE status='reserved' AND reserve_expires_ts IS NOT NULL AND reserve_expires_ts<? ORDER BY id ASC LIMIT 200",
        (int(now_ts),),
    ).fetchall() or []
    expired = 0
    for r in rows:
        oid = int(_rget(r, "id") or 0)
        uid = int(_rget(r, "user_id") or 0)
        rub = int(_rget(r, "rub_price") or 0)
        ts = _now_utc_iso()
        # Mark expired (idempotent)
        if USE_PG:
            rr = con.execute(
                "UPDATE robux_orders SET status='expired', updated_at=?, cancelled_at=? WHERE id=? AND status='reserved' RETURNING id",
                (ts, ts, oid),
            ).fetchone()
            if not rr:
                continue
        else:
            cur = con.execute("UPDATE robux_orders SET status='expired', updated_at=?, cancelled_at=? WHERE id=? AND status='reserved'", (ts, ts, oid))
            if getattr(cur, "rowcount", 0) != 1:
                continue
        _robux_refund_if_needed(con, oid, uid, rub, reason="robux reserve expired")
        expired += 1
    if expired:
        con.commit()
    return expired

def _robux_refund_if_needed(con, order_id: int, user_id: int, rub_price: int, reason: str) -> None:
    """Idempotent refund of held rubles to user (for reserved/paid orders that fail/cancel/expire)."""
    if rub_price <= 0:
        return
    ts = _now_utc_iso()
    # Only refund once
    if USE_PG:
        row = con.execute(
            "UPDATE robux_orders SET refund_taken=1, refunded_at=? WHERE id=? AND refund_taken=0 RETURNING id",
            (ts, int(order_id)),
        ).fetchone()
        if not row:
            return
        # credit user
        con.execute("UPDATE users SET balance=balance+? WHERE id=?", (int(rub_price), int(user_id)))
        con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(user_id), None, int(rub_price), reason, ts))
        return

    cur = con.execute("UPDATE robux_orders SET refund_taken=1, refunded_at=? WHERE id=? AND refund_taken=0", (ts, int(order_id)))
    if getattr(cur, "rowcount", 0) != 1:
        return
    urow = con.execute("SELECT balance FROM users WHERE id=?", (int(user_id),)).fetchone()
    oldb = int(_rget(urow, "balance") or 0) if urow else 0
    con.execute("UPDATE users SET balance=? WHERE id=?", (oldb + int(rub_price), int(user_id)))
    con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(user_id), None, int(rub_price), reason, ts))

def _robux_seller_available(con) -> Dict[str, int]:
    """Compute available Robux for sale considering admin limits and current reservations.

    With account-pool enabled, seller_robux is the *sum* of cached balances of active accounts.
    """
    cfg = _robux_cfg_effective()
    stock_sell = int(cfg.get("stock_sell") or 0)
    gp_factor = float(cfg.get("gp_factor") or 1.43) or 1.43

    # Reserved + processing consume seller robux until purchase is done/failed
    r = con.execute(
        "SELECT COALESCE(SUM(gamepass_price),0) AS s FROM robux_orders WHERE status IN ('reserved','processing','paid')",
        (),
    ).fetchone()
    reserved = int(_rget(r, "s") or 0) if r else 0

    total_gp = 0
    max_gp = 0
    accounts = 0

    try:
        rows = con.execute("SELECT robux_balance FROM roblox_accounts WHERE is_active=1", ()).fetchall() or []
        accounts = len(rows)
        for rr in rows:
            b = int(_rget(rr, "robux_balance") or 0)
            if b > 0:
                total_gp += b
                if b > max_gp:
                    max_gp = b
    except Exception:
        accounts = 0

    # Fallback: legacy single seller cookie balance
    if accounts == 0:
        st = roblox_seller_status()
        total_gp = int(st.get("robux") or 0) if st.get("configured") else 0
        max_gp = total_gp

    cap = total_gp
    if stock_sell > 0:
        cap = min(cap, stock_sell)

    available_gp = max(0, cap - reserved)
    available_robux = int(math.floor(available_gp / gp_factor)) if available_gp > 0 else 0

    return {
        "seller_robux": int(total_gp),
        "max_account_robux": int(max_gp),
        "accounts": int(accounts),
        "reserved": int(reserved),
        "cap": int(cap),
        "available": int(available_gp),
        "available_robux": int(available_robux),
    }



@app.get("/api/robux/stock")
def api_robux_stock():
    """Public endpoint used by frontend to show current availability and rate."""
    con = db_conn()
    try:
        avail = _robux_seller_available(con)
    finally:
        con.close()
    cfg = _robux_cfg_effective()
    a = int(avail.get("available_robux") or 0)
    status = "in_stock" if a >= 50 else "out_of_stock"
    text = str(a) if status == "in_stock" else "Нет в наличии"
    return {
        "ok": True,
        "available": a,
        "text": text,
        "status": status,
        "accounts": int(avail.get("accounts") or 0),
        "reserved": int(avail.get("reserved") or 0),
        "rub_per_robux": float(cfg.get("rub_per_robux") or 0),
        "gp_factor": float(cfg.get("gp_factor") or 0),
        "updated_at": _now_utc_iso(),
    }


@app.get("/api/robux/quote")
def api_robux_quote(request: Request, amount: int = 0, robux_amount: int = 0):
    """Price quote for a given Robux amount.

    Frontend historically sent ?robux_amount=. Newer frontend uses ?amount=.
    Accept both to avoid 422 validation errors.
    """
    try:
        amount_i = int(amount or robux_amount or 0)
    except Exception:
        amount_i = 0
    if amount_i <= 0:
        raise HTTPException(status_code=400, detail="Укажи количество Robux")
    q = robux_calc(amount_i)
    cfg = _robux_cfg_effective()
    # Stock for UI: if admin set stock_show -> use it, else show seller balance if configured
    stock_show = int(cfg.get("stock_show") or 0)
    seller = roblox_seller_status()
    seller_robux = int(seller.get("robux") or 0) if seller.get("configured") else 0
    ui_stock = stock_show if stock_show > 0 else seller_robux
    return {"ok": True, **q, "stock_show": int(ui_stock)}




@app.get("/api/admin/robux/accounts")
def api_admin_robux_accounts(request: Request):
    require_admin(request)
    con = db_conn()
    try:
        rows = con.execute(
            "SELECT id, label, roblox_user_id, roblox_username, robux_balance, is_active, last_check_at, last_error, created_at FROM roblox_accounts ORDER BY id DESC",
            (),
        ).fetchall() or []
        items = []
        for r in rows:
            items.append({
                "id": int(_rget(r, "id") or 0),
                "label": str(_rget(r, "label") or ""),
                "roblox_user_id": int(_rget(r, "roblox_user_id") or 0),
                "roblox_username": str(_rget(r, "roblox_username") or ""),
                "robux_balance": int(_rget(r, "robux_balance") or 0),
                "is_active": int(_rget(r, "is_active") or 0),
                "last_check_at": str(_rget(r, "last_check_at") or ""),
                "last_error": str(_rget(r, "last_error") or ""),
                "created_at": str(_rget(r, "created_at") or ""),
            })
        return {"ok": True, "items": items}
    finally:
        con.close()


@app.post("/api/admin/robux/accounts/add")
def api_admin_robux_accounts_add(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    label = str(payload.get("label") or "").strip()
    cookie = str(payload.get("cookie") or "").strip()
    if not cookie:
        raise HTTPException(status_code=400, detail="Cookie is required")
    enc = _cookie_encrypt(cookie)
    ts = _now_utc_iso()
    st = roblox_cookie_status(cookie)
    uid = int(st.get("user_id") or 0) if st.get("ok") else 0
    uname = str(st.get("username") or "") if st.get("ok") else ""
    bal = int(st.get("robux") or 0) if st.get("ok") else 0
    last_err = "" if st.get("ok") else str(st.get("error") or "cookie check failed")

    con = db_conn()
    try:
        if USE_PG:
            row = con.execute(
                "INSERT INTO roblox_accounts(label, cookie_enc, roblox_user_id, roblox_username, robux_balance, is_active, last_check_at, last_error, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id",
                (label, enc, uid or None, uname, bal, 1, ts, last_err, ts),
            ).fetchone()
            new_id = int(_rget(row, "id") or 0) if row else 0
        else:
            cur = con.cursor()
            cur.execute(
                "INSERT INTO roblox_accounts(label, cookie_enc, roblox_user_id, roblox_username, robux_balance, is_active, last_check_at, last_error, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (label, enc, uid or None, uname, bal, 1, ts, last_err, ts),
            )
            new_id = int(cur.lastrowid or 0)
        con.commit()
    finally:
        con.close()
    return {"ok": True, "id": new_id, "status": st}


@app.post("/api/admin/robux/accounts/toggle")
def api_admin_robux_accounts_toggle(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    acc_id = int(payload.get("id") or 0)
    is_active = int(payload.get("is_active") or 0)
    con = db_conn()
    try:
        con.execute("UPDATE roblox_accounts SET is_active=? WHERE id=?", (int(is_active), int(acc_id)))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


@app.post("/api/admin/robux/accounts/delete")
def api_admin_robux_accounts_delete(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    acc_id = int(payload.get("id") or 0)
    con = db_conn()
    try:
        con.execute("DELETE FROM roblox_accounts WHERE id=?", (int(acc_id),))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


@app.post("/api/admin/robux/accounts/refresh")
def api_admin_robux_accounts_refresh(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    acc_id = int(payload.get("id") or 0)
    refresh_all = bool(payload.get("all")) or (acc_id == 0)

    con = db_conn()
    try:
        if refresh_all:
            rows = con.execute("SELECT id, cookie_enc FROM roblox_accounts ORDER BY id DESC", ()).fetchall() or []
        else:
            rows = con.execute("SELECT id, cookie_enc FROM roblox_accounts WHERE id=?", (int(acc_id),)).fetchall() or []

        updated = 0
        for r in rows:
            rid = int(_rget(r, "id") or 0)
            ck = _cookie_decrypt(str(_rget(r, "cookie_enc") or ""))
            if not ck:
                continue
            st = roblox_cookie_status(ck)
            ts = _now_utc_iso()
            if st.get("ok"):
                con.execute(
                    "UPDATE roblox_accounts SET roblox_user_id=?, roblox_username=?, robux_balance=?, last_check_at=?, last_error=NULL WHERE id=?",
                    (int(st.get("user_id") or 0) or None, str(st.get("username") or ""), int(st.get("robux") or 0), ts, int(rid)),
                )
            else:
                con.execute(
                    "UPDATE roblox_accounts SET last_check_at=?, last_error=? WHERE id=?",
                    (ts, str(st.get("error") or "refresh failed"), int(rid)),
                )
            updated += 1
        con.commit()
        return {"ok": True, "updated": updated}
    finally:
        con.close()



@app.post("/api/robux/inspect")
def api_robux_inspect(request: Request, payload: Dict[str, Any]):
    """
    Inspect gamepass by URL/ID or find by username.
    Returns gamepass info for the frontend to display.
    """
        
    # Extract all possible fields from payload
    _mode_raw = str(payload.get("mode") or "").strip().lower()
    url = str(payload.get("url") or payload.get("gamepass_url") or payload.get("gamepass") or "").strip()
    username = str(payload.get("username") or payload.get("nick") or "").strip()
    
    # Debug: log what we received
    _debug_payload = {
        "mode_raw": _mode_raw,
        "url": url[:50] if url else "",
        "username": username,
        "amount": payload.get("amount"),
        "robux_amount": payload.get("robux_amount"),
    }
    print(f"[ROBUX INSPECT] Received payload: {_debug_payload}")
    
    # Parse gamepass ID from URL (if provided)
    gp_id = 0
    if url:
        try:
            gp_id = int(_parse_gamepass_id(url) or 0)
        except Exception as e:
            print(f"[ROBUX INSPECT] Failed to parse gamepass ID from url '{url}': {e}")
            gp_id = 0
    
    # Determine mode: URL mode if we have valid gamepass ID, otherwise username mode
    # IMPORTANT: Respect frontend's mode if it explicitly says "username" and username is present
    if _mode_raw == "username" and username:
        mode = "username"
    elif gp_id > 0:
        mode = "url"
    elif username:
        mode = "username"
    else:
        mode = ""
    
    print(f"[ROBUX INSPECT] Determined mode: {mode} (gp_id={gp_id}, username={username})")
    
    # Parse amount
    try:
        amount = int(payload.get("amount") or payload.get("robux_amount") or 0)
    except Exception:
        amount = 0
    
    # URL MODE: inspect specific gamepass by ID
    if mode == "url":
        if gp_id <= 0:
            raise HTTPException(status_code=400, detail="Нужна ссылка/ID геймпасса")
        print(f"[ROBUX INSPECT] URL mode: inspecting gamepass {gp_id}")
        info = roblox_inspect_gamepass(str(int(gp_id)))
        return {"ok": True, "gamepass": info, "mode": "url"}
    
    # USERNAME MODE: find gamepass by username with matching price
    if mode != "username":
        raise HTTPException(status_code=400, detail="Укажи ссылку/ID геймпасса или ник Roblox")
    
    if not username:
        raise HTTPException(status_code=400, detail="Введи ник Roblox")
    
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Укажи количество Robux (больше 0)")
    
    # Normalize and validate username
    normalized_username = normalize_roblox_username(username)
    print(f"[ROBUX INSPECT] Username mode: normalized '{username}' -> '{normalized_username}'")
    
    if not normalized_username:
        raise HTTPException(status_code=400, detail="Ник Roblox пустой после нормализации")
    
    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", normalized_username):
        # Show which characters are problematic
        bad_chars = [c for c in normalized_username if not re.match(r"[A-Za-z0-9_]", c)]
        raise HTTPException(
            status_code=400, 
            detail=f"Ник '{normalized_username}' содержит недопустимые символы: {bad_chars}. Roblox ники — только латиница (A-Z), цифры (0-9) и подчёркивание (_)."
        )
    
    # Calculate expected gamepass price
    q = robux_calc(int(amount))
    expected_price = int(q["gamepass_price"])
    print(f"[ROBUX INSPECT] Looking for gamepass with price {expected_price} R$ for user '{normalized_username}'")
    
    # Find gamepass
    try:
        info = roblox_find_gamepass_by_username(normalized_username, expected_price)
        print(f"[ROBUX INSPECT] Found gamepass: {info.get('gamepass_id')} - {info.get('name')}")
        return {"ok": True, "gamepass": info, "mode": "username", "expected_price": expected_price}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ROBUX INSPECT] Error finding gamepass: {e}")
        raise HTTPException(status_code=400, detail=f"Ошибка поиска геймпасса: {str(e)}")



@app.post("/api/robux/order_create")
def api_robux_order_create(request: Request, payload: Dict[str, Any]):
    """Creates a robux order (no money held yet)."""
    u = require_user(request)
    uid = int(u["id"])
    try:
        amount = int(payload.get("amount") or 0)
    except Exception:
        amount = 0

    gp_url = str(payload.get("gamepass_url") or payload.get("url") or "").strip()
    username = normalize_roblox_username(str(payload.get("username") or payload.get("nick") or "").strip())
    
    print(f"[ORDER CREATE] amount={amount}, gp_url='{gp_url}', username='{username}'")

    q = robux_calc(amount)

    # Resolve gamepass either by URL/ID or by username scan
    if gp_url and gp_url != "0":
        print(f"[ORDER CREATE] Using gamepass URL/ID: {gp_url}")
        gp = roblox_inspect_gamepass(gp_url)
    else:
        if not username:
            raise HTTPException(status_code=400, detail="Нужна ссылка/ID геймпасса или ник Roblox")
        print(f"[ORDER CREATE] Finding gamepass for user '{username}' with price {q['gamepass_price']}")
        gp = roblox_find_gamepass_by_username(username, int(q["gamepass_price"]), user_id=uid)
    
    # Extract gamepass ID - this is critical!
    gamepass_id = int(gp.get("gamepass_id") or 0)
    if gamepass_id <= 0:
        raise HTTPException(status_code=400, detail="Не удалось получить ID геймпасса")
    
    # Store gamepass_id as gamepass_url for backward compatibility
    gp_url = str(gamepass_id)
    print(f"[ORDER CREATE] Gamepass found: ID={gamepass_id}, name={gp.get('name')}, price={gp.get('price')}")

    # Anti-fraud: price must match expected
    if int(gp.get("price") or 0) != int(q["gamepass_price"]):
        raise HTTPException(status_code=400, detail=f"Цена геймпасса должна быть {q['gamepass_price']} Robux, а не {gp.get('price')}")
    if int(gp.get("product_id") or 0) <= 0:
        raise HTTPException(status_code=400, detail="Не удалось получить ProductId геймпасса")

    ts = _now_utc_iso()
    con = db_conn()
    _robux_expire_overdue(con)
    _robux_rate_limit_or_raise(con, uid)

    if USE_PG:
        row = con.execute(
            "INSERT INTO robux_orders(user_id,robux_amount,rub_price,gamepass_price,gamepass_url,gamepass_id,product_id,gamepass_name,gamepass_owner,gamepass_owner_id,status,error_message,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
            (
                uid,
                int(q["robux"]),
                int(q["rub_price"]),
                int(q["gamepass_price"]),
                gp_url,
                int(gp.get("gamepass_id") or 0),
                int(gp.get("product_id") or 0),
                str(gp.get("name") or ""),
                str(gp.get("owner") or ""),
                int(gp.get("owner_id") or 0),
                "new",
                None,
                ts,
                ts,
            ),
        ).fetchone()
        oid = int(_rget(row, "id") or 0)
    else:
        cur = con.execute(
            "INSERT INTO robux_orders(user_id,robux_amount,rub_price,gamepass_price,gamepass_url,gamepass_id,product_id,gamepass_name,gamepass_owner,gamepass_owner_id,status,error_message,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                uid,
                int(q["robux"]),
                int(q["rub_price"]),
                int(q["gamepass_price"]),
                gp_url,
                int(gp.get("gamepass_id") or 0),
                int(gp.get("product_id") or 0),
                str(gp.get("name") or ""),
                str(gp.get("owner") or ""),
                int(gp.get("owner_id") or 0),
                "new",
                None,
                ts,
                ts,
            ),
        )
        oid = int(cur.lastrowid)
    con.commit()
    con.close()
    return {"ok": True, "order_id": oid, "quote": q, "gamepass": gp}


@app.post("/api/robux/order_reserve")
def api_robux_order_reserve(request: Request, payload: Dict[str, Any]):
    """Hold user's balance + reserve seller robux for 7 minutes."""
    u = require_user(request)
    uid = int(u["id"])
    oid = int(payload.get("order_id") or 0)
    # Accept both `amount` and `robux_amount` keys
    amount = payload.get("amount") if payload.get("amount") is not None else payload.get("robux_amount")
    gp_url = str(payload.get("gamepass_url") or payload.get("url") or "").strip()

    con = db_conn()
    try:
        _robux_expire_overdue(con)
    except Exception:
        pass

    if oid <= 0:
        # Create order inside this call for simpler frontend
        try:
            created = api_robux_order_create(request, {"amount": amount, "gamepass_url": gp_url, "username": payload.get("username") or payload.get("nick")})
            oid = int(created.get("order_id") or 0)
        except HTTPException:
            con.close()
            raise
        except Exception as e:
            con.close()
            _log.error("order_create failed in reserve: %s", e)
            raise HTTPException(status_code=500, detail=f"Ошибка создания заказа: {str(e)[:200]}")
        # Re-open connection (order_create opens/closes its own)
        con = db_conn()

    row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (int(oid), int(uid))).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Order not found")

    status = str(_rget(row, "status") or "")
    rub_price = int(_rget(row, "rub_price") or 0)
    gp_price = int(_rget(row, "gamepass_price") or 0)
    reserve_seconds = int((_robux_cfg_effective().get("reserve_seconds") or ROBUX_RESERVE_SECONDS))

    if status in ("reserved", "processing", "paid", "done"):
        con.close()
        return {
            "ok": True,
            "order_id": oid,
            "status": status,
            "reserve_expires_ts": int(_rget(row, "reserve_expires_ts") or 0),
            "server_now_ts": _now_ts(),
        }

    if status not in ("new", "failed", "cancelled", "expired"):
        con.close()
        raise HTTPException(status_code=400, detail="Нельзя забронировать этот заказ")

    # Re-check gamepass price (anti-fraud)
    # Use gamepass_id if available, otherwise gamepass_url
    gp_id_from_db = int(_rget(row, "gamepass_id") or 0)
    gp_url_from_db = str(_rget(row, "gamepass_url") or "").strip()
    
    gamepass_ref = str(gp_id_from_db) if gp_id_from_db > 0 else gp_url_from_db
    if not gamepass_ref or gamepass_ref == "0":
        con.close()
        raise HTTPException(status_code=400, detail="Заказ не содержит ID геймпасса. Попробуй создать заказ заново.")
    
    gp = roblox_inspect_gamepass(gamepass_ref)
    if int(gp.get("price") or 0) != int(gp_price):
        con.close()
        raise HTTPException(status_code=400, detail=f"Цена геймпасса должна быть {gp_price} Robux")

    # Seller availability check
    avail = _robux_seller_available(con)
    if int(avail.get("available") or 0) < int(gp_price):
        con.close()
        raise HTTPException(status_code=400, detail="Сейчас нет нужного количества Robux. Попробуй позже.")

    # Hold user's balance (atomic)
    ts = _now_utc_iso()
    now_ts = _now_ts()
    exp_ts = now_ts + reserve_seconds

    if USE_PG:
        urow = con.execute(
            "UPDATE users SET balance=balance-? WHERE id=? AND balance>=? RETURNING balance",
            (int(rub_price), int(uid), int(rub_price)),
        ).fetchone()
        if not urow:
            con.close()
            raise HTTPException(status_code=400, detail="Недостаточно средств. Пополни баланс.")
        con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(uid), None, -int(rub_price), f"robux reserve {oid}", ts))
        orow = con.execute(
            "UPDATE robux_orders SET status='reserved', reserved_at=?, reserve_expires_ts=?, hold_taken=1, updated_at=? WHERE id=? AND user_id=? RETURNING id",
            (ts, int(exp_ts), ts, int(oid), int(uid)),
        ).fetchone()
        if not orow:
            # rollback hold (best-effort)
            con.execute("UPDATE users SET balance=balance+? WHERE id=?", (int(rub_price), int(uid)))
            con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(uid), None, int(rub_price), f"robux reserve rollback {oid}", ts))
            con.commit()
            con.close()
            raise HTTPException(status_code=409, detail="Не удалось забронировать. Попробуй ещё раз.")
    else:
        urow = con.execute("SELECT balance FROM users WHERE id=?", (int(uid),)).fetchone()
        bal = int(_rget(urow, "balance") or 0) if urow else 0
        if bal < rub_price:
            con.close()
            raise HTTPException(status_code=400, detail="Недостаточно средств. Пополни баланс.")
        con.execute("UPDATE users SET balance=? WHERE id=?", (bal - rub_price, int(uid)))
        con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(uid), None, -int(rub_price), f"robux reserve {oid}", ts))
        con.execute("UPDATE robux_orders SET status='reserved', reserved_at=?, reserve_expires_ts=?, hold_taken=1, updated_at=? WHERE id=? AND user_id=?", (ts, int(exp_ts), ts, int(oid), int(uid)))

    con.commit()
    # Get queue info for frontend
    queue = _robux_queue_info(con)
    con.close()
    return {"ok": True, "order_id": oid, "status": "reserved", "reserve_expires_ts": int(exp_ts), "server_now_ts": now_ts, "queue": queue}


def _robux_worker_purchase(order_id: int):
    con = None
    try:
        con = db_conn()
        _robux_expire_overdue(con)
        row = con.execute("SELECT * FROM robux_orders WHERE id=?", (int(order_id),)).fetchone()
        if not row:
            return
        status = str(_rget(row, "status") or "")
        if status not in ("processing", "paid"):
            return

        uid = int(_rget(row, "user_id") or 0)
        rub_price = int(_rget(row, "rub_price") or 0)
        gp_price = int(_rget(row, "gamepass_price") or 0)
        gp_url = str(_rget(row, "gamepass_url") or "")
        expected_pid = int(_rget(row, "product_id") or 0)
        expected_owner_id = int(_rget(row, "gamepass_owner_id") or 0)

        # Anti-fraud again: price/product must still match
        gp = roblox_inspect_gamepass(gp_url)
        if int(gp.get("price") or 0) != int(gp_price) or int(gp.get("product_id") or 0) != int(expected_pid):
            ts = _now_utc_iso()
            con.execute("UPDATE robux_orders SET status='failed', updated_at=?, error_message=? WHERE id=?", (ts, f"Цена/товар геймпасса изменились. Ожидалось {gp_price}.", int(order_id)))
            _robux_refund_if_needed(con, int(order_id), int(uid), int(rub_price), reason=f"robux refund price changed {order_id}")
            con.commit()
            return

        # Check seller config + robux availability
        avail = _robux_seller_available(con)
        if int(avail.get("max_account_robux") or avail.get("seller_robux") or 0) < gp_price:
            ts = _now_utc_iso()
            con.execute("UPDATE robux_orders SET status='failed', updated_at=?, error_message=? WHERE id=?", (ts, "Недостаточно Robux у продавца", int(order_id)))
            _robux_refund_if_needed(con, int(order_id), int(uid), int(rub_price), reason=f"robux refund seller low {order_id}")
            con.commit()
            return

        # Try purchase
        expected_gp_id = int(gp.get("gamepass_id") or _rget(row, "gamepass_id") or 0)
        res = roblox_buy_product(product_id=expected_pid, expected_price=gp_price, expected_seller_id=expected_owner_id, gamepass_id=expected_gp_id)
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "Roblox purchase failed")

        ts = _now_utc_iso()
        done_ts = _now_ts()
        con.execute("UPDATE robux_orders SET status='done', updated_at=?, error_message=?, done_at=?, done_ts=? WHERE id=?", (ts, None, ts, int(done_ts), int(order_id)))
        con.commit()
    except Exception as e:
        try:
            if con:
                row = con.execute("SELECT user_id, rub_price FROM robux_orders WHERE id=?", (int(order_id),)).fetchone()
                uid = int(_rget(row, "user_id") or 0) if row else 0
                rub_price = int(_rget(row, "rub_price") or 0) if row else 0
                ts = _now_utc_iso()
                con.execute("UPDATE robux_orders SET status='failed', updated_at=?, error_message=? WHERE id=?", (ts, str(e), int(order_id)))
                if uid and rub_price:
                    _robux_refund_if_needed(con, int(order_id), int(uid), int(rub_price), reason=f"robux refund fail {order_id}")
                con.commit()
        except Exception:
            pass
    finally:
        try:
            if con:
                con.close()
        except Exception:
            pass


@app.post("/api/robux/order_pay")
def api_robux_order_pay(request: Request, payload: Dict[str, Any]):
    """Confirm payment: moves reserved order to processing and starts purchase worker."""
    u = require_user(request)
    uid = int(u["id"])
    oid = int(payload.get("order_id") or 0)
    if oid <= 0:
        raise HTTPException(status_code=400, detail="order_id required")

    con = db_conn()
    _robux_expire_overdue(con)

    row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (int(oid), int(uid))).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Order not found")

    status = str(_rget(row, "status") or "")
    rub_price = int(_rget(row, "rub_price") or 0)
    gp_price = int(_rget(row, "gamepass_price") or 0)
    exp_ts = int(_rget(row, "reserve_expires_ts") or 0)
    now_ts = _now_ts()

    if status == "done":
        con.close()
        return {"ok": True, "order_id": oid, "status": "done"}
    if status != "reserved":
        con.close()
        raise HTTPException(status_code=400, detail="Сначала нужно забронировать заказ")

    if exp_ts and now_ts >= exp_ts:
        ts = _now_utc_iso()
        con.execute("UPDATE robux_orders SET status='expired', updated_at=?, cancelled_at=? WHERE id=? AND user_id=?", (ts, ts, int(oid), int(uid)))
        _robux_refund_if_needed(con, int(oid), int(uid), int(rub_price), reason=f"robux reserve expired {oid}")
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Бронь истекла. Создай заказ заново.")

    # Anti-fraud: re-check gamepass price/product right before purchase
    gp_id_from_db = int(_rget(row, "gamepass_id") or 0)
    gp_url_from_db = str(_rget(row, "gamepass_url") or "").strip()
    gamepass_ref = str(gp_id_from_db) if gp_id_from_db > 0 else gp_url_from_db
    if not gamepass_ref or gamepass_ref == "0":
        con.close()
        raise HTTPException(status_code=400, detail="Заказ не содержит ID геймпасса")
    
    gp = roblox_inspect_gamepass(gamepass_ref)
    if int(gp.get("price") or 0) != int(gp_price) or int(gp.get("product_id") or 0) != int(_rget(row, "product_id") or 0):
        ts = _now_utc_iso()
        con.execute("UPDATE robux_orders SET status='failed', updated_at=?, error_message=? WHERE id=?", (ts, f"Цена/товар геймпасса изменились. Ожидалось {gp_price}.", int(oid)))
        _robux_refund_if_needed(con, int(oid), int(uid), int(rub_price), reason=f"robux refund price changed {oid}")
        con.commit()
        con.close()
        raise HTTPException(status_code=400, detail="Цена геймпасса изменилась. Деньги возвращены.")

    ts = _now_utc_iso()
    if USE_PG:
        rr = con.execute(
            "UPDATE robux_orders SET status='processing', updated_at=?, paid_at=? WHERE id=? AND user_id=? AND status='reserved' RETURNING id",
            (ts, ts, int(oid), int(uid)),
        ).fetchone()
        if not rr:
            con.close()
            raise HTTPException(status_code=409, detail="Не удалось начать оплату. Попробуй ещё раз.")
    else:
        cur = con.execute("UPDATE robux_orders SET status='processing', updated_at=?, paid_at=? WHERE id=? AND user_id=? AND status='reserved'", (ts, ts, int(oid), int(uid)))
        if getattr(cur, "rowcount", 0) != 1:
            con.close()
            raise HTTPException(status_code=409, detail="Не удалось начать оплату. Попробуй ещё раз.")
    con.commit()
    con.close()

    th = threading.Thread(target=_robux_worker_purchase, args=(oid,), daemon=True)
    th.start()
    return {"ok": True, "order_id": oid, "status": "processing"}


@app.post("/api/robux/order_cancel")
def api_robux_order_cancel(request: Request, payload: Dict[str, Any]):
    """User cancels a pending/reserved order. Refunds balance."""
    u = require_user(request)
    uid = int(u["id"])
    oid = int(payload.get("order_id") or 0)
    reason = str(payload.get("reason") or "").strip()[:200]
    if oid <= 0:
        raise HTTPException(status_code=400, detail="order_id required")

    con = db_conn()
    row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (int(oid), int(uid))).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Заказ не найден")

    status = str(_rget(row, "status") or "")
    rub_price = int(_rget(row, "rub_price") or 0)

    # Can only cancel reserved or paid (not yet processing/done)
    if status not in ("reserved", "paid"):
        con.close()
        raise HTTPException(status_code=400, detail=f"Невозможно отменить заказ в статусе: {status}")

    ts = _now_utc_iso()
    con.execute(
        "UPDATE robux_orders SET status='cancelled', updated_at=?, cancelled_at=?, cancel_reason=?, cancelled_by=? WHERE id=? AND user_id=?",
        (ts, ts, reason or "Отменён пользователем", "user", int(oid), int(uid))
    )
    # Refund
    _robux_refund_if_needed(con, int(oid), int(uid), rub_price, reason=f"user cancelled order {oid}")
    con.commit()
    con.close()

    return {"ok": True, "order_id": oid, "status": "cancelled", "refunded": rub_price}


@app.post("/api/admin/robux/order_cancel")
def api_admin_robux_order_cancel(request: Request, payload: Dict[str, Any]):
    """Admin cancels any order with reason."""
    admin = require_admin(request)
    oid = int(payload.get("order_id") or 0)
    reason = str(payload.get("reason") or "Отменён администратором").strip()[:200]
    if oid <= 0:
        raise HTTPException(status_code=400, detail="order_id required")

    con = db_conn()
    row = con.execute("SELECT * FROM robux_orders WHERE id=?", (int(oid),)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Заказ не найден")

    status = str(_rget(row, "status") or "")
    uid = int(_rget(row, "user_id") or 0)
    rub_price = int(_rget(row, "rub_price") or 0)

    if status in ("done", "cancelled", "refunded"):
        con.close()
        raise HTTPException(status_code=400, detail=f"Заказ уже в финальном статусе: {status}")

    ts = _now_utc_iso()
    con.execute(
        "UPDATE robux_orders SET status='cancelled', updated_at=?, cancelled_at=?, cancel_reason=?, cancelled_by=? WHERE id=?",
        (ts, ts, reason, f"admin:{admin['id']}", int(oid))
    )
    _robux_refund_if_needed(con, int(oid), uid, rub_price, reason=f"admin cancelled order {oid}: {reason}")
    con.commit()
    con.close()
    return {"ok": True, "order_id": oid, "status": "cancelled", "refunded": rub_price}


def _robux_queue_info(con) -> dict:
    """Get queue stats: how many orders are waiting."""
    pending = con.execute(
        "SELECT COUNT(*) as cnt FROM robux_orders WHERE status IN ('reserved','paid','processing')"
    ).fetchone()
    cnt = _count_val(pending, "cnt")
    # Estimate: ~30s per order for Roblox API call
    est_seconds = cnt * 30
    return {"queue_length": cnt, "estimated_seconds": est_seconds}


@app.get("/api/robux/queue")
def api_robux_queue():
    """Public endpoint: current queue length and estimated wait."""
    con = db_conn()
    info = _robux_queue_info(con)
    con.close()
    return {"ok": True, **info}


@app.get("/api/robux/order")
def api_robux_order(request: Request, id: int):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    _robux_expire_overdue(con)
    row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (int(id), uid)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Order not found")
    queue = _robux_queue_info(con)
    con.close()

    status = str(_rget(row, "status") or "")
    status_text = {
        "new": "Новый",
        "reserved": "Забронирован",
        "paid": "Ожидает отправки",
        "processing": "Отправляется",
        "done": "Доставлено",
        "cancelled": "Отменён",
        "refunded": "Возврат",
        "expired": "Истёк",
        "error": "Ошибка",
        "failed": "Ошибка",
    }.get(status, status)

    return {
        "ok": True,
        "server_now_ts": _now_ts(),
        "queue": queue,
        "order": {
            "id": int(_rget(row, "id") or 0),
            "status": status,
            "status_text": status_text,
            "robux_amount": int(_rget(row, "robux_amount") or 0),
            "rub_price": int(_rget(row, "rub_price") or 0),
            "gamepass_price": int(_rget(row, "gamepass_price") or 0),
            "gamepass_name": str(_rget(row, "gamepass_name") or ""),
            "gamepass_owner": str(_rget(row, "gamepass_owner") or ""),
            "gamepass_url": str(_rget(row, "gamepass_url") or ""),
            "reserve_expires_ts": int(_rget(row, "reserve_expires_ts") or 0),
            "done_ts": int(_rget(row, "done_ts") or 0),
            "created_at": str(_rget(row, "created_at") or ""),
            "done_at": str(_rget(row, "done_at") or ""),
            "paid_at": str(_rget(row, "paid_at") or ""),
            "cancelled_at": str(_rget(row, "cancelled_at") or ""),
            "cancel_reason": str(_rget(row, "cancel_reason") or ""),
            "cancelled_by": str(_rget(row, "cancelled_by") or ""),
            "error": str(_rget(row, "error_message") or ""),
        },
    }


# --- Auto gamepass creation (premium feature) ---

RBX_GAMEPASS_CREATE_URL = "https://apis.roblox.com/game-passes/v1/game-passes"
RBX_GAMEPASS_DETAILS_URL = "https://apis.roblox.com/game-passes/v1/game-passes/{gid}/details"
RBX_UNIVERSE_DETAILS_URL = "https://games.roblox.com/v1/games?universeIds={uids}"


def _make_valid_png(width: int = 150, height: int = 150, r: int = 128, g: int = 0, b: int = 255) -> bytes:
    """Generate a valid PNG image in pure Python (no PIL needed)."""
    import struct as _s, zlib as _z
    sig = b'\x89PNG\r\n\x1a\n'
    def _chunk(ct: bytes, d: bytes) -> bytes:
        c = ct + d
        return _s.pack('>I', len(d)) + c + _s.pack('>I', _z.crc32(c) & 0xffffffff)
    ihdr = _s.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    px = bytes([r, g, b])
    raw = b''.join(b'\x00' + px * width for _ in range(height))
    idat = _z.compress(raw)
    return sig + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', idat) + _chunk(b'IEND', b'')


def _roblox_create_gamepass(*, cookie: str, universe_id: int, name: str, price: int) -> Dict[str, Any]:
    """Create a gamepass on a user's universe and set its price."""
    import io as _io

    ck = cookie.strip()
    if ck and not ck.lower().startswith(".roblosecurity"):
        ck_val = ck
    else:
        ck_val = ck.split("=", 1)[1] if "=" in ck else ck
    cookies = {".ROBLOSECURITY": ck_val}
    headers = {"User-Agent": "RST-Web/1.0"}

    # Get CSRF token
    csrf_resp = requests.post(RBX_GAMEPASS_CREATE_URL, cookies=cookies, headers=headers, timeout=DEFAULT_TIMEOUT)
    csrf_token = csrf_resp.headers.get("x-csrf-token") or csrf_resp.headers.get("X-CSRF-TOKEN") or ""
    if csrf_token:
        headers["X-CSRF-TOKEN"] = csrf_token

    # Generate a proper 150x150 PNG icon
    icon_png = _make_valid_png(150, 150, 128, 0, 255)

    files = {
        "Name": (None, name),
        "Description": (None, f"Gamepass for Robux purchase - {price} R$"),
        "UniverseId": (None, str(int(universe_id))),
        "File": ("icon.png", _io.BytesIO(icon_png), "image/png"),
    }

    r = requests.post(RBX_GAMEPASS_CREATE_URL, cookies=cookies, headers=headers, files=files, timeout=DEFAULT_TIMEOUT)

    if not r.ok:
        err = ""
        try:
            j = r.json() if r.content else {}
            err = j.get("message") or j.get("errorMessage") or str(j.get("errors", [{}])[0].get("message", "")) or str(j)
        except Exception:
            err = f"HTTP {r.status_code}"
        print(f"[AUTO GP] Create failed: {r.status_code} {err}")
        raise HTTPException(status_code=400, detail=f"Не удалось создать геймпасс: {err}")

    try:
        create_data = r.json() if r.content else {}
    except Exception:
        create_data = {}

    gp_id = int(create_data.get("gamePassId") or create_data.get("id") or 0)
    if gp_id <= 0:
        print(f"[AUTO GP] Create response missing ID: {create_data}")
        raise HTTPException(status_code=400, detail="Не удалось получить ID созданного геймпасса")

    print(f"[AUTO GP] Created gamepass {gp_id} on universe {universe_id}")

    # Set price via details endpoint (multipart/form-data, NOT json)
    detail_url = RBX_GAMEPASS_DETAILS_URL.format(gid=gp_id)
    headers2 = {"User-Agent": "RST-Web/1.0"}
    if csrf_token:
        headers2["X-CSRF-TOKEN"] = csrf_token

    # Include Name/Description to avoid Roblox resetting them
    detail_fields = {
        "Name": (None, name),
        "Description": (None, f"Gamepass for Robux purchase - {price} R$"),
        "IsForSale": (None, "true"),
        "Price": (None, str(int(price))),
    }

    print(f"[AUTO GP] Setting price: url={detail_url} price={price}")
    r2 = requests.post(detail_url, cookies=cookies, headers=headers2, files=detail_fields, timeout=DEFAULT_TIMEOUT)
    print(f"[AUTO GP] Price attempt 1: {r2.status_code} body={r2.text[:500] if r2.text else 'empty'}")

    if r2.status_code == 403:
        tok2 = r2.headers.get("x-csrf-token") or r2.headers.get("X-CSRF-TOKEN")
        if tok2:
            headers2["X-CSRF-TOKEN"] = tok2
            r2 = requests.post(detail_url, cookies=cookies, headers=headers2, files=detail_fields, timeout=DEFAULT_TIMEOUT)
            print(f"[AUTO GP] Price attempt 2 (csrf refresh): {r2.status_code} body={r2.text[:500] if r2.text else 'empty'}")

    # Fallback: try legacy economy endpoint
    if not r2.ok:
        print(f"[AUTO GP] Details endpoint failed ({r2.status_code}), trying legacy economy endpoint...")
        econ_url = f"https://economy.roblox.com/v1/game-passes/{gp_id}/game-pass-product"
        econ_headers = {"User-Agent": "RST-Web/1.0", "Content-Type": "application/json"}
        if csrf_token:
            econ_headers["X-CSRF-TOKEN"] = csrf_token
        econ_body = {"IsForSale": True, "Price": int(price)}
        r2 = requests.post(econ_url, cookies=cookies, headers=econ_headers, json=econ_body, timeout=DEFAULT_TIMEOUT)
        print(f"[AUTO GP] Economy endpoint: {r2.status_code} body={r2.text[:500] if r2.text else 'empty'}")
        if r2.status_code == 403:
            tok3 = r2.headers.get("x-csrf-token") or r2.headers.get("X-CSRF-TOKEN")
            if tok3:
                econ_headers["X-CSRF-TOKEN"] = tok3
                r2 = requests.post(econ_url, cookies=cookies, headers=econ_headers, json=econ_body, timeout=DEFAULT_TIMEOUT)
                print(f"[AUTO GP] Economy endpoint retry: {r2.status_code} body={r2.text[:500] if r2.text else 'empty'}")

    if not r2.ok:
        err2 = ""
        try:
            j2 = r2.json() if r2.content else {}
            err2 = j2.get("message") or j2.get("errorMessage") or str(j2)
        except Exception:
            err2 = f"HTTP {r2.status_code}: {r2.text[:200] if r2.text else ''}"
        print(f"[AUTO GP] Set price FAILED: {r2.status_code} {err2}")
        raise HTTPException(status_code=400, detail=f"Геймпасс создан (ID {gp_id}), но не удалось установить цену: {err2}")

    # Wait a moment for price propagation, then verify
    time.sleep(1.0)
    actual_price = 0
    try:
        gp_info = roblox_inspect_gamepass(str(gp_id))
        actual_price = int(gp_info.get("price") or 0)
        print(f"[AUTO GP] Verification: gamepass {gp_id} actual price = {actual_price}")
    except Exception as ve:
        print(f"[AUTO GP] Verification failed: {ve}")

    if actual_price <= 0:
        print(f"[AUTO GP] WARNING: Price not applied! Expected {price}, got {actual_price}. Retrying...")
        # One more retry with the details endpoint using form-urlencoded
        headers3 = {"User-Agent": "RST-Web/1.0", "Content-Type": "application/x-www-form-urlencoded"}
        if csrf_token:
            headers3["X-CSRF-TOKEN"] = csrf_token
        form_data = f"Name={name}&Description=Donation&IsForSale=true&Price={int(price)}"
        r3 = requests.post(detail_url, cookies=cookies, headers=headers3, data=form_data, timeout=DEFAULT_TIMEOUT)
        print(f"[AUTO GP] Form-urlencoded retry: {r3.status_code} body={r3.text[:500] if r3.text else 'empty'}")
        if r3.status_code == 403:
            tok4 = r3.headers.get("x-csrf-token") or r3.headers.get("X-CSRF-TOKEN")
            if tok4:
                headers3["X-CSRF-TOKEN"] = tok4
                r3 = requests.post(detail_url, cookies=cookies, headers=headers3, data=form_data, timeout=DEFAULT_TIMEOUT)
                print(f"[AUTO GP] Form-urlencoded retry2: {r3.status_code}")
        time.sleep(1.0)
        try:
            gp_info2 = roblox_inspect_gamepass(str(gp_id))
            actual_price = int(gp_info2.get("price") or 0)
            print(f"[AUTO GP] Re-verification: actual price = {actual_price}")
        except Exception:
            pass

    final_price = actual_price if actual_price > 0 else int(price)
    print(f"[AUTO GP] DONE: gamepass {gp_id}, target price={price}, final={final_price}")
    return {"gamepass_id": int(gp_id), "name": name, "price": final_price, "universe_id": int(universe_id)}


@app.post("/api/robux/validate_buyer_cookie")
def api_robux_validate_buyer_cookie(request: Request, payload: Dict[str, Any]):
    """Validate a buyer's Roblox cookie and return their info + universes."""
    require_user(request)
    cookie = str(payload.get("cookie") or "").strip()
    if not cookie:
        raise HTTPException(status_code=400, detail="Вставь куки (.ROBLOSECURITY)")

    st = roblox_cookie_status(cookie)
    if not st.get("ok"):
        raise HTTPException(status_code=400, detail=f"Куки недействительны: {st.get('error', 'unknown')}")

    uid = int(st.get("user_id") or 0)
    uname = str(st.get("username") or "")

    try:
        universes = _roblox_iter_user_universes(uid, max_universes=20)
    except Exception as e:
        print(f"[VALIDATE COOKIE] Failed to get universes for {uid}: {e}")
        universes = []

    universe_info = []
    if universes:
        try:
            uids_str = ",".join(str(u) for u in universes[:10])
            url = RBX_UNIVERSE_DETAILS_URL.format(uids=uids_str)
            r = requests.get(url, timeout=DEFAULT_TIMEOUT, headers={"User-Agent": "RST-Web/1.0"})
            if r.ok:
                data = (r.json() if r.content else {}).get("data") or []
                for d in data:
                    universe_info.append({
                        "id": int(d.get("id") or 0),
                        "name": str(d.get("name") or "Unknown"),
                        "rootPlaceId": int(d.get("rootPlaceId") or 0),
                    })
        except Exception as e:
            print(f"[VALIDATE COOKIE] Failed to get universe details: {e}")
            universe_info = [{"id": u, "name": f"Universe {u}", "rootPlaceId": 0} for u in universes[:10]]

    return {"ok": True, "user_id": uid, "username": uname, "universes": universe_info, "has_games": len(universe_info) > 0}


@app.post("/api/robux/auto_create_gamepass")
def api_robux_auto_create_gamepass(request: Request, payload: Dict[str, Any]):
    """Create a gamepass on buyer's game using their cookie. Premium-only."""
    u = require_user(request)
    uid = int(u["id"])
    lim = user_limits(uid)
    if not lim.get("premium"):
        raise HTTPException(status_code=403, detail="Эта функция доступна только для Premium пользователей")

    cookie = str(payload.get("cookie") or "").strip()
    if not cookie:
        raise HTTPException(status_code=400, detail="Вставь куки (.ROBLOSECURITY)")

    try:
        amount = int(payload.get("amount") or 0)
    except Exception:
        amount = 0
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Укажи количество Robux")

    universe_id = int(payload.get("universe_id") or 0)
    q = robux_calc(amount)
    gp_price = int(q["gamepass_price"])

    st = roblox_cookie_status(cookie)
    if not st.get("ok"):
        raise HTTPException(status_code=400, detail=f"Куки недействительны: {st.get('error', 'unknown')}")

    buyer_uid = int(st.get("user_id") or 0)
    buyer_username = str(st.get("username") or "")

    if universe_id <= 0:
        try:
            universes = _roblox_iter_user_universes(buyer_uid, max_universes=5)
        except Exception:
            universes = []
        if not universes:
            raise HTTPException(status_code=400, detail="У аккаунта нет публичных игр. Создай хотя бы одну в Roblox Studio.")
        universe_id = universes[0]

    result = _roblox_create_gamepass(cookie=cookie, universe_id=universe_id, name=f"Donation {gp_price}", price=gp_price)

    created_gp_id = int(result.get("gamepass_id") or 0)
    time.sleep(1.5)
    try:
        info = roblox_inspect_gamepass(str(created_gp_id))
    except Exception:
        info = {"gamepass_id": created_gp_id, "name": f"Donation {gp_price}", "price": gp_price, "owner": buyer_username, "owner_id": buyer_uid, "product_id": 0, "thumbnail_url": ""}

    return {"ok": True, "gamepass": info, "buyer": {"user_id": buyer_uid, "username": buyer_username}, "universe_id": universe_id}


@app.get("/api/purchases/history")
def api_purchases_history(request: Request):
    """History for shop: only Robux orders."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    _robux_expire_overdue(con)
    rows = con.execute(
        "SELECT id, robux_amount, rub_price, status, created_at, reserve_expires_ts, done_ts, error_message FROM robux_orders WHERE user_id=? AND status!='new' ORDER BY id DESC LIMIT 50",
        (int(uid),),
    ).fetchall() or []
    con.close()
    items = []
    for r in rows:
        items.append({
            "id": int(_rget(r, "id") or 0),
            "robux_amount": int(_rget(r, "robux_amount") or 0),
            "rub_price": int(_rget(r, "rub_price") or 0),
            "status": str(_rget(r, "status") or ""),
            "created_at": str(_rget(r, "created_at") or ""),
            "reserve_expires_ts": int(_rget(r, "reserve_expires_ts") or 0),
            "done_ts": int(_rget(r, "done_ts") or 0),
            "error": str(_rget(r, "error_message") or ""),
        })
    return {"ok": True, "server_now_ts": _now_ts(), "items": items}


@app.get("/api/purchases/detail")
def api_purchases_detail(request: Request, id: int):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    _robux_expire_overdue(con)
    row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (int(id), int(uid))).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    return {
        "ok": True,
        "server_now_ts": _now_ts(),
        "item": {
            "id": int(_rget(row, "id") or 0),
            "status": str(_rget(row, "status") or ""),
            "robux_amount": int(_rget(row, "robux_amount") or 0),
            "rub_price": int(_rget(row, "rub_price") or 0),
            "gamepass_price": int(_rget(row, "gamepass_price") or 0),
            "gamepass_name": str(_rget(row, "gamepass_name") or ""),
            "gamepass_owner": str(_rget(row, "gamepass_owner") or ""),
            "gamepass_url": str(_rget(row, "gamepass_url") or ""),
            "reserve_expires_ts": int(_rget(row, "reserve_expires_ts") or 0),
            "done_ts": int(_rget(row, "done_ts") or 0),
            "created_at": str(_rget(row, "created_at") or ""),
            "error": str(_rget(row, "error_message") or ""),
        }
    }

# ----------------------------
# Robux admin (seller settings + order log)
# ----------------------------

@app.get("/api/admin/robux/settings")
def api_admin_robux_settings(request: Request):
    require_admin(request)
    cfg = _robux_cfg_effective()
    # cookie: do not expose full cookie; only show if present in DB
    db_cookie = (_setting_get("roblox_seller_cookie", "") or "").strip()
    has_db_cookie = bool(db_cookie)
    effective_has = bool(_seller_cookie_effective())
    return {
        "ok": True,
        "settings": {
            "cookie_in_db": has_db_cookie,
            "cookie_mask": ("••••" + db_cookie[-6:]) if has_db_cookie and len(db_cookie) >= 6 else ("••••" if has_db_cookie else ""),
            "min_amount": int(cfg.get("min_amount") or 0),
            "rub_per_robux": float(cfg.get("rub_per_robux") or 0),
            "gp_factor": float(cfg.get("gp_factor") or 0),
            "stock_show": int(cfg.get("stock_show") or 0),
            "stock_sell": int(cfg.get("stock_sell") or 0),
            "reserve_seconds": int(cfg.get("reserve_seconds") or 0),
        },
        "effective": {
            "seller_configured": effective_has,
            "env_override": bool((os.environ.get("ROBLOX_SELLER_COOKIE") or "").strip()),
        },
    }


@app.post("/api/admin/robux/settings")
def api_admin_robux_settings_set(request: Request, payload: dict):
    require_admin(request)
    # cookie optional
    ck = str(payload.get("cookie") or "").strip()
    if ck:
        _setting_set("roblox_seller_cookie", ck)
    # allow clearing cookie
    if payload.get("cookie") == "":
        _setting_set("roblox_seller_cookie", "")

    # numeric settings (stored in DB if provided)
    def _store_num(key, val, cast):
        if val is None:
            return
        s = str(val).strip()
        if s == "":
            return
        try:
            cast(s)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Некорректное значение: {key}")
        _setting_set(key, s)

    _store_num("robux_min_amount", payload.get("min_amount"), int)
    _store_num("robux_rub_per_robux", payload.get("rub_per_robux"), float)
    _store_num("robux_gp_factor", payload.get("gp_factor"), float)

    _store_num("robux_stock_show", payload.get("stock_show"), int)
    _store_num("robux_stock_sell", payload.get("stock_sell"), int)
    _store_num("robux_reserve_seconds", payload.get("reserve_seconds"), int)

    return {"ok": True}


@app.get("/api/admin/robux/seller_status")
def api_admin_robux_seller_status(request: Request):
    require_admin(request)
    cfg = _robux_cfg_effective()
    st = roblox_seller_status()
    return {"ok": True, "seller": st, "config": cfg, "env_override": bool((os.environ.get("ROBLOX_SELLER_COOKIE") or "").strip())}


@app.get("/api/admin/robux/orders")
def api_admin_robux_orders(request: Request, status: str = "active", limit: int = 50, offset: int = 0):
    require_admin(request)
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    st = (status or "active").lower()

    where = ""
    params = []
    if st == "active":
        where = "WHERE o.status IN ('new','reserved','paid','processing')"
    elif st == "done":
        where = "WHERE o.status='done'"
    elif st == "cancelled":
        where = "WHERE o.status IN ('cancelled','refunded','expired')"
    elif st == "all":
        where = ""
    else:
        where = "WHERE o.status=?"
        params.append(st)

    q = f"""
      SELECT o.*, u.username
      FROM robux_orders o
      LEFT JOIN users u ON u.id=o.user_id
      {where}
      ORDER BY o.id DESC
      LIMIT ? OFFSET ?
    """
    params.extend([limit, offset])

    con = db_conn()
    rows = con.execute(q, tuple(params)).fetchall()
    con.close()

    items = []
    for r in rows or []:
        items.append({
            "id": int(_rget(r, "id") or 0),
            "user_id": int(_rget(r, "user_id") or 0),
            "username": str(_rget(r, "username") or ""),
            "robux_amount": int(_rget(r, "robux_amount") or 0),
            "rub_price": int(_rget(r, "rub_price") or 0),
            "gamepass_price": int(_rget(r, "gamepass_price") or 0),
            "gamepass_owner": str(_rget(r, "gamepass_owner") or ""),
            "gamepass_name": str(_rget(r, "gamepass_name") or ""),
            "status": str(_rget(r, "status") or ""),
            "error": str(_rget(r, "error_message") or ""),
            "cancel_reason": str(_rget(r, "cancel_reason") or ""),
            "cancelled_by": str(_rget(r, "cancelled_by") or ""),
            "cancelled_at": str(_rget(r, "cancelled_at") or ""),
            "paid_at": str(_rget(r, "paid_at") or ""),
            "done_at": str(_rget(r, "done_at") or ""),
            "created_at": str(_rget(r, "created_at") or ""),
            "updated_at": str(_rget(r, "updated_at") or ""),
        })

    return {"ok": True, "items": items, "limit": limit, "offset": offset}

# Core endpoints
# ----------------------------
@app.post("/api/analyze")
def api_analyze(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])
    lim = user_limits(uid)
    if not lim["premium"] and lim["credits_analyze"] <= 0:
        raise HTTPException(status_code=402, detail="Limit reached (analyze)")

    username = payload.get("username") or payload.get("cookie") or ""
    data = roblox_analyze(str(username))

    # spend only on success
    if not lim["premium"]:
        spend_credit(uid, "credits_analyze", 1)

    return {"ok": True, "data": data, "limits": user_limits(uid)}


@app.get("/api/roblox/profile")
def api_roblox_profile(request: Request, username: str):
    """Public Roblox profile lookup for the Tools checker."""
    u = require_user(request)
    # no credits consumption: this is public and lightweight
    data = roblox_analyze(username)
    return {"ok": True, "data": data, "limits": user_limits(int(u["id"]))}
@app.post("/api/preview")
def api_preview(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    data = payload.get("data") or {}
    title_tpl = payload.get("title_template") or ""
    desc_tpl = payload.get("desc_template") or ""
    title = safe_format(title_tpl, data)
    desc = safe_format(desc_tpl, data)
    return {"ok": True, "title": title, "desc": desc, "limits": user_limits(int(u["id"]))}
@app.post("/api/ai_generate")
def api_ai_generate(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])
    lim0 = user_limits(uid)
    if not lim0["premium"] and lim0["credits_ai"] <= 0:
        raise HTTPException(status_code=402, detail="Limit reached (AI generate)")

    provider = (payload.get("provider") or "pollinations").lower()
    model = payload.get("model") or ""
    mode = payload.get("mode") or "Рерайт"
    tone = payload.get("tone") or "Классика"
    extra = payload.get("extra") or ""
    data = payload.get("data") or {}

    rules = build_sales_rule(mode, tone)

    system = (
        "Ты копирайтер, который пишет продающие объявления для Roblox-аккаунтов. "
        "Пиши на русском. "
        "Не упоминай, что текст создан ИИ/нейросетью/генератором. "
        "Не используй markdown и блоки ```.\n\n"
        "ФОРМАТ ОТВЕТА СТРОГО ТАКОЙ:\n"
        "TITLE: <одна строка заголовка>\n"
        "DESC:\n<полное описание>\n"
    )

    facts = (
        f"Факты об аккаунте:\n"
        f"- Ник: {data.get('username','')}\n"
        f"- Ссылка: {data.get('profile_link','')}\n"
        f"- Robux: {data.get('robux','')}\n"
        f"- RAP: {data.get('rap_tag','')}\n"
        f"- Донат/траты: {data.get('donate_tag','')}\n"
        f"- Год: {data.get('year_tag','')}\n"
        f"- Инвентарь: {data.get('inv_ru','')}\n"
    )

    user = (
        f"{facts}\n"
        f"Правила стиля:\n{rules}\n"
        f"Пожелания:\n{extra}\n\n"
        f"Сгенерируй TITLE и DESC."
    )

    if provider == "blackbox":
        api_key = os.environ.get("BLACKBOX_API_KEY", "")
        out = blackbox_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.9, max_tokens=900)
    elif provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        out = groq_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.9, max_tokens=900)
    else:
        out = pollinations_chat(model=model or "openai", system=system, user=user, temperature=0.95, max_tokens=900)

    title, desc = extract_title_desc(out)

    # Save generated template into currently selected profile template (logged-in user)
    u = get_current_user(request)
    if u and title and desc:
        ensure_profile_templates_schema()
        con = db_conn()
        try:
            uid2 = int(u["id"])
            sid = _get_selected_template_id(con, uid2)
            ts2 = _now_utc_iso()
            con.execute(
                "UPDATE profile_templates SET title_tpl=?, desc_tpl=?, updated_at=? WHERE id=? AND user_id=?",
                (title, desc, ts2, int(sid), uid2),
            )
            con.commit()
        finally:
            con.close()

    # spend only on success
    if not lim0["premium"]:
        spend_credit(uid, "credits_ai", 1)

    return {"ok": True, "title": title, "desc": desc, "raw": clamp(out, 7000)}
@app.post("/api/chat")
def api_chat(request: Request, payload: Dict[str, Any]):
    """Tool chat with AI.

    Available for Premium users, or limited by credits_ai for non-Premium.
    Frontend may send optional `history` list for context.
    """
    u = require_user(request)
    uid = int(u["id"])
    lim0 = user_limits(uid)
    if not lim0["premium"] and lim0["credits_ai"] <= 0:
        raise HTTPException(status_code=402, detail="Limit reached (AI chat)")

    message = (payload.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")

    provider = (payload.get("provider") or "pollinations").lower()
    model = (payload.get("model") or "default").lower()

    # Build light context from history (avoid huge payloads)
    history = payload.get("history") or []
    ctx_lines = []
    if isinstance(history, list):
        for h in history[-10:]:
            if not isinstance(h, dict):
                continue
            role = str(h.get("role") or "").strip().lower()
            content = str(h.get("content") or "").strip()
            if not content:
                continue
            if role not in ("user", "assistant"):
                role = "user"
            prefix = "Пользователь" if role == "user" else "Ассистент"
            ctx_lines.append(f"{prefix}: {content}")
        ctx = "\n".join(ctx_lines).strip()

    system = (
        "Ты дружелюбный помощник. Пиши на русском. "
        "Отвечай кратко и по делу. "
        "Не упоминай, что ты ИИ/нейросеть. "
        "Если запрос опасный/незаконный — откажись."
    )
    user_text = (ctx + "\\n\\n" if ctx else "") + message
    out = provider_chat(provider=provider, model=model, system=system, user=user_text)

    # spend only on success
    if not lim0["premium"]:
        spend_credit(uid, "credits_ai", 1)

    return {"ok": True, "reply": out}


# ----------------------------
# Shop config (admin editable, public readable)
# ----------------------------
def _shop_cfg_get():
    con = db_conn()
    row = con.execute("SELECT json, updated_at FROM shop_config WHERE key=?", ("main",)).fetchone()
    con.close()
    if not row:
        return None
    try:
        return json.loads(_rget(row, "json") or "{}")
    except Exception:
        return None

def _shop_cfg_set(cfg: Dict[str, Any]):
    con = db_conn()
    now = datetime.datetime.utcnow().isoformat()
    js = json.dumps(cfg or {}, ensure_ascii=False)
    if USE_PG:
        con.execute(
            "INSERT INTO shop_config(key,json,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
            ("main", js, now),
        )
    else:
        con.execute("INSERT OR REPLACE INTO shop_config(key,json,updated_at) VALUES(?,?,?)", ("main", js, now))
    con.commit()
    con.close()

# ----------------------------
# Site settings (admin-only, stored in DB; env can override)
# ----------------------------

def _setting_get(key: str, default: str = "") -> str:
    try:
        con = db_conn()
        row = con.execute("SELECT value FROM site_settings WHERE key=?", (key,)).fetchone()
        con.close()
        if not row:
            return default
        return str(_rget(row, "value") or default)
    except Exception:
        return default


def _setting_set(key: str, value: str) -> None:
    con = db_conn()
    now = datetime.datetime.utcnow().isoformat()
    con.execute("INSERT INTO site_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", (key, str(value), now))
    con.commit()
    con.close()


def _seller_cookie_effective() -> str:
    # ENV has priority (useful for emergency override)
    ck = (os.environ.get("ROBLOX_SELLER_COOKIE") or "").strip()
    if ck:
        return ck
    # DB single-cookie (legacy)
    db_ck = (_setting_get("roblox_seller_cookie", "") or "").strip()
    if db_ck:
        return db_ck
    # Pool fallback: choose active account with highest cached balance
    try:
        con = db_conn()
        row = con.execute("SELECT cookie_enc FROM roblox_accounts WHERE is_active=1 ORDER BY robux_balance DESC, id ASC LIMIT 1").fetchone()
        con.close()
        if row:
            return _cookie_decrypt(str(_rget(row, "cookie_enc") or ""))
    except Exception:
        pass
    return ""


def _robux_cfg_effective() -> Dict[str, Any]:
    # Allow tuning via DB; env still overrides if set
    def _env_or_db(env_key: str, db_key: str, default: str) -> str:
        v = (os.environ.get(env_key) or "").strip()
        if v:
            return v
        return (_setting_get(db_key, default) or default)

    return {
        "min_amount": int(float(_env_or_db("ROBUX_MIN_AMOUNT", "robux_min_amount", str(ROBUX_MIN_AMOUNT)))),
        "rub_per_robux": float(_env_or_db("ROBUX_RUB_PER_ROBUX", "robux_rub_per_robux", str(ROBUX_RUB_PER_ROBUX))),
        "gp_factor": float(_env_or_db("ROBUX_GP_FACTOR", "robux_gp_factor", str(ROBUX_GP_FACTOR))),
        # Stock controls (0 = unlimited)
        "stock_show": int(float(_env_or_db("ROBUX_STOCK_SHOW", "robux_stock_show", "0"))),
        "stock_sell": int(float(_env_or_db("ROBUX_STOCK_SELL", "robux_stock_sell", "0"))),
        # Reserve timeout (seconds)
        "reserve_seconds": int(float(_env_or_db("ROBUX_RESERVE_SECONDS", "robux_reserve_seconds", str(ROBUX_RESERVE_SECONDS)))),
    }

@app.get("/admin/shop-builder")
def admin_shop_builder(request: Request):
    require_admin(request)
    return templates.TemplateResponse("shop_builder.html", {"request": request})


@app.post("/api/admin/upload_banner")
async def api_admin_upload_banner(request: Request, file: UploadFile = File(...)):
    require_admin(request)
    fn = (file.filename or "").lower()
    allowed_ext = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    ext = os.path.splitext(fn)[1].lower() or ".png"
    if ext not in allowed_ext:
        raise HTTPException(status_code=400, detail="Поддерживаются только PNG, JPG, WEBP, GIF")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Файл пустой")
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Файл слишком большой (максимум 8MB)")
    import uuid
    name = f"banner_{uuid.uuid4().hex}{ext}"
    # Save to persistent /data/uploads/ if available, else static/uploads/
    data_uploads = os.path.join(os.path.dirname(DB_PATH), "uploads") if DB_PATH else None
    static_uploads = os.path.join("static", "uploads")
    # Try persistent first
    saved_url = None
    if data_uploads:
        try:
            os.makedirs(data_uploads, exist_ok=True)
            path = os.path.join(data_uploads, name)
            with open(path, "wb") as fp:
                fp.write(data)
            saved_url = f"/api/uploads/{name}"  # served via dedicated endpoint
        except Exception:
            data_uploads = None
    if not saved_url:
        os.makedirs(static_uploads, exist_ok=True)
        path = os.path.join(static_uploads, name)
        with open(path, "wb") as fp:
            fp.write(data)
        saved_url = f"/static/uploads/{name}"
    return {"ok": True, "url": saved_url, "name": name}


@app.get("/api/uploads/{name}")
async def serve_upload(name: str):
    """Serve uploaded banners from persistent /data/uploads/."""
    import re
    if not re.match(r'^[a-zA-Z0-9_.-]+$', name):
        raise HTTPException(status_code=400, detail="Invalid filename")
    data_uploads = os.path.join(os.path.dirname(DB_PATH), "uploads") if DB_PATH else None
    if data_uploads:
        fpath = os.path.join(data_uploads, name)
        if os.path.isfile(fpath):
            from starlette.responses import FileResponse
            return FileResponse(fpath)
    # fallback to static
    fpath = os.path.join("static", "uploads", name)
    if os.path.isfile(fpath):
        from starlette.responses import FileResponse
        return FileResponse(fpath)
    raise HTTPException(status_code=404, detail="Not found")


# ============================================
# SHOP INVENTORY & VOUCHER API
# ============================================

def _shop_default_config() -> dict:
    """Returns the default shop config with current static items."""
    return {
        "categories": [
            {"id": "rbx-st", "title": "RBX-ST", "sort": 10, "visible": True,
             "banner_url": "", "banner_color": "linear-gradient(135deg,#1a0a2e,#2d1155)"},
            {"id": "roblox", "title": "Roblox", "sort": 20, "visible": True,
             "banner_url": "", "banner_color": "linear-gradient(135deg,#0a1a2e,#112d55)"},
            {"id": "accounts", "title": "Аккаунты", "sort": 30, "visible": True,
             "banner_url": "", "banner_color": "linear-gradient(135deg,#0a1f0a,#1a3a1a)"},
            {"id": "services", "title": "Услуги", "sort": 40, "visible": True,
             "banner_url": "", "banner_color": "linear-gradient(135deg,#1a1a0a,#3a2a0a)"},
        ],
        "items": [
            {
                "id": "premium", "title": "Premium подписка",
                "subtitle": "Безлимитные генерации, приоритетная поддержка, эксклюзивные функции",
                "price_rub": 99, "badge": "ХИТ", "category_id": "rbx-st",
                "banner_url": "/static/banners/premium.png", "visible": True, "sort": 10,
                "item_type": "special", "special_action": "premium",
                "description_html": "<p>Premium даёт безлимитный доступ к AI-генерациям, приоритетную поддержку и ранний доступ к новым функциям.</p>",
            },
            {
                "id": "free-case", "title": "Бесплатный кейс",
                "subtitle": "CS‑стиль прокрутка. Открывай бесплатно каждые 48 часов",
                "price_rub": 0, "badge": "FREE", "category_id": "rbx-st",
                "banner_url": "/static/banners/free_case.png", "visible": True, "sort": 20,
                "item_type": "special", "special_action": "case_free",
                "description_html": "<p>Бесплатный кейс с CSS-стиле. Открывай раз в 48 часов — призы начисляются моментально.</p>",
            },
            {
                "id": "paid-case", "title": "Платный кейс",
                "subtitle": "CS‑стиль прокрутка. Стоит 17 ₽ с баланса",
                "price_rub": 17, "badge": "NEW", "category_id": "rbx-st",
                "banner_url": "/static/banners/case_17r.png", "visible": True, "sort": 30,
                "item_type": "special", "special_action": "case_paid",
                "description_html": "<p>Платный кейс стоит 17₽ с баланса. Приз начисляется сразу после открытия.</p>",
            },
            {
                "id": "robux", "title": "Robux по нику",
                "subtitle": "Введи ник — получи Robux автоматически. Быстро и безопасно.",
                "price_rub": 0, "badge": "ХИТ", "category_id": "roblox",
                "banner_url": "", "visible": True, "sort": 10,
                "item_type": "special", "special_action": "robux",
                "description_html": "<p>Покупай Robux по нику от 0.5₽/R$. Доставка автоматическая через геймпасс.</p>",
            },
            {
                "id": "acc-empty", "title": "Пустой аккаунт",
                "subtitle": "Без привязок, чистый аккаунт Roblox",
                "price_rub": 30, "badge": "", "category_id": "accounts",
                "banner_url": "", "visible": True, "sort": 10,
                "item_type": "account",
                "description_html": "<p>Чистый пустой аккаунт Roblox без каких-либо привязок.</p>",
            },
            {
                "id": "ai-gen", "title": "AI Генерация",
                "subtitle": "Генерация описаний и текстов с помощью ИИ",
                "price_rub": 0, "badge": "", "category_id": "services",
                "banner_url": "", "visible": True, "sort": 10,
                "item_type": "special", "special_action": "tools",
                "description_html": "<p>Генерируй описания, тексты и контент с помощью AI. Доступно в разделе Инструменты.</p>",
            },
        ],
    }


@app.post("/api/admin/shop_config/reset")
def api_admin_shop_config_reset(request: Request):
    """Reset shop config to defaults (removes custom items/cats but keeps inventory)."""
    require_admin(request)
    _shop_cfg_set(_shop_default_config())
    return {"ok": True, "message": "Конфиг сброшен к умолчаниям"}


@app.get("/api/shop_config")
def api_shop_config():
    cfg = _shop_cfg_get()
    if not cfg:
        cfg = _shop_default_config()
    # Dynamically compute out_of_stock from real DB inventory
    items = cfg.get("items") or []
    non_special = [it for it in items if it.get("item_type") not in ("special",)]
    if non_special:
        try:
            con = db_conn()
            changed = False
            for it in non_special:
                pid = it.get("id", "")
                if not pid:
                    continue
                # Unlimited items are never out of stock
                if it.get("unlimited"):
                    if it.get("out_of_stock"):
                        del it["out_of_stock"]
                        changed = True
                    continue
                row = con.execute("SELECT COUNT(*) as cnt FROM shop_inventory WHERE product_id=? AND sold=0", (pid,)).fetchone()
                avail = _count_val(row, "cnt")
                was_oos = bool(it.get("out_of_stock"))
                is_oos = (avail == 0)
                if was_oos != is_oos:
                    if is_oos:
                        it["out_of_stock"] = True
                    elif "out_of_stock" in it:
                        del it["out_of_stock"]
                    changed = True
            con.close()
            # Persist corrections silently
            if changed:
                try:
                    _shop_cfg_set(cfg)
                except Exception:
                    pass
        except Exception:
            pass
    # Auto-fill default banners for known categories if none set
    _CAT_DEFAULT_BANNERS = {
        "roblox": "/static/banners/cat_roblox.png",
    }
    for cat in (cfg.get("categories") or []):
        cid = (cat.get("id") or "").lower()
        if cid in _CAT_DEFAULT_BANNERS and not cat.get("banner_url"):
            cat["banner_url"] = _CAT_DEFAULT_BANNERS[cid]
    return {"ok": True, "config": cfg}


@app.post("/api/admin/shop_config")
async def api_admin_shop_config_v2(request: Request):
    require_admin(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат данных")
    cfg = body.get("config") if isinstance(body, dict) else None
    if cfg is None:
        cfg = body if isinstance(body, dict) else {}
    if not isinstance(cfg, dict):
        raise HTTPException(status_code=400, detail="config must be object")
    # Strip base64 data URLs from images (can bloat config massively → 503)
    def _strip_base64(obj, depth=0):
        if depth > 10: return obj
        if isinstance(obj, str):
            if obj.startswith("data:image/") or (len(obj) > 500 and ";" in obj and "base64" in obj):
                return ""  # Remove base64 strings - they should be uploaded separately
        elif isinstance(obj, dict):
            return {k: _strip_base64(v, depth+1) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [_strip_base64(i, depth+1) for i in obj]
        return obj
    cfg = _strip_base64(cfg)
    try:
        _shop_cfg_set(cfg)
    except Exception as e:
        _log.error("shop_config save error: %s", e)
        raise HTTPException(status_code=500, detail=f"Ошибка сохранения: {str(e)}")
    return {"ok": True}


# ---- Inventory management ----

@app.get("/api/admin/shop/inventory/{product_id}")
def api_admin_shop_inventory(request: Request, product_id: str):
    require_admin(request)
    con = db_conn()
    rows = con.execute(
        "SELECT id, item_type, data_json, sold, sold_at, sold_to_user_id, created_at FROM shop_inventory WHERE product_id=? ORDER BY id DESC LIMIT 200",
        (product_id,)
    ).fetchall()
    total = _count_val(con.execute("SELECT COUNT(*) FROM shop_inventory WHERE product_id=?", (product_id,)).fetchone())
    avail = _count_val(con.execute("SELECT COUNT(*) FROM shop_inventory WHERE product_id=? AND sold=0", (product_id,)).fetchone())
    con.close()
    items = []
    for r in rows:
        d = {"id": _rget(r, "id"), "item_type": _rget(r, "item_type", "digital"), "sold": bool(_rget(r, "sold", 0)),
             "sold_at": _rget(r, "sold_at"), "sold_to_user_id": _rget(r, "sold_to_user_id"), "created_at": _rget(r, "created_at")}
        try:
            d["data"] = json.loads(_rget(r, "data_json") or "{}")
        except Exception:
            d["data"] = {}
        # Generate preview for admin UI
        data = d.get("data") or {}
        if d["item_type"] == "account":
            d["preview"] = f'{data.get("login","?")} : {data.get("password","?")}'
            if data.get("shared_secret"):
                d["preview"] += " 🛡️SDA"
        elif d["item_type"] in ("digital", "gift"):
            d["preview"] = str(data.get("code") or data.get("key") or data.get("value") or "")
        elif d["item_type"] == "service":
            desc = str(data.get("description") or data.get("info") or "")
            d["preview"] = desc[:60] + "..." if len(desc) > 60 else desc
        else:
            d["preview"] = str(list(data.values())[0] if data else "")[:60]
        items.append(d)
    return {"ok": True, "items": items, "total": int(total), "available": int(avail)}


@app.post("/api/admin/shop/inventory/add")
def api_admin_shop_inventory_add(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    product_id = str(payload.get("product_id") or "").strip()
    item_type = str(payload.get("item_type") or "digital").strip()
    items_raw = payload.get("items") or []
    raw_data = str(payload.get("raw_data") or "").strip()

    if not product_id:
        raise HTTPException(status_code=400, detail="product_id required")
    if item_type not in ("account", "digital", "service", "gift", "other"):
        raise HTTPException(status_code=400, detail="item_type must be account/digital/service/gift/other")

    parsed_items = []

    # Mode 1: structured items array from frontend (new form with separate fields)
    if isinstance(items_raw, list) and items_raw:
        for it in items_raw:
            if not isinstance(it, dict): continue
            clean = {k: v for k, v in it.items() if v is not None and v != ""}
            if clean:
                parsed_items.append(clean)

    # Mode 2: legacy raw_data text (login:pass:email lines)
    elif raw_data:
        lines = [l.strip() for l in raw_data.splitlines() if l.strip()]
        for line in lines:
            if item_type == "account":
                # Format: login:password[:email[:shared_secret[:identity_secret]]]
                parts = line.split(":", 4)
                if len(parts) >= 2:
                    d = {"login": parts[0], "password": parts[1]}
                    if len(parts) >= 3 and parts[2]: d["email"] = parts[2]
                    if len(parts) >= 4 and parts[3]: d["shared_secret"] = parts[3]
                    if len(parts) >= 5 and parts[4]: d["identity_secret"] = parts[4]
                    parsed_items.append(d)
                else:
                    parsed_items.append({"login": line, "password": ""})
            elif item_type in ("digital", "gift"):
                parsed_items.append({"code": line})
            elif item_type == "service":
                parsed_items.append({"description": raw_data}); break
            else:
                parsed_items.append({"value": line})

    if not parsed_items:
        raise HTTPException(status_code=400, detail="Нет данных для добавления")

    con = db_conn()
    ts = _now_utc_iso()
    added = 0
    for item_data in parsed_items:
        con.execute(
            "INSERT INTO shop_inventory(product_id, item_type, data_json, sold, created_at) VALUES(?,?,?,0,?)",
            (product_id, item_type, json.dumps(item_data, ensure_ascii=False), ts)
        )
        added += 1
    con.commit()
    con.close()
    # Clear out_of_stock flag since we just added stock
    try:
        cfg = _shop_cfg_get() or {}
        items = cfg.get("items") or []
        changed = False
        for it in items:
            if it.get("id") == product_id and it.get("out_of_stock"):
                del it["out_of_stock"]
                changed = True
        if changed:
            _shop_cfg_set(cfg)
    except Exception as e:
        _log.warning("[SHOP] Failed to clear out_of_stock: %s", e)
    return {"ok": True, "added": added}


@app.delete("/api/admin/shop/inventory/{item_id}")
def api_admin_shop_inventory_delete(request: Request, item_id: int):
    require_admin(request)
    con = db_conn()
    row = con.execute("SELECT id, sold FROM shop_inventory WHERE id=?", (item_id,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Item not found")
    if _rget(row, "sold"):
        con.close()
        raise HTTPException(status_code=400, detail="Нельзя удалить проданный товар")
    con.execute("DELETE FROM shop_inventory WHERE id=?", (item_id,))
    con.commit()
    con.close()
    return {"ok": True}


# ---- Shop purchase (balance) ----

@app.post("/api/shop/buy/{product_id}")
def api_shop_buy(request: Request, product_id: str):
    u = require_user(request)
    uid = int(u["id"])
    _log.info("[SHOP_BUY] uid=%s product=%s", uid, product_id)
    cfg = _shop_cfg_get() or _shop_default_config()
    item = next((i for i in (cfg.get("items") or []) if i.get("id") == product_id), None)
    if not item or item.get("visible") is False:
        raise HTTPException(status_code=404, detail="Товар не найден")
    if item.get("item_type") == "special":
        raise HTTPException(status_code=400, detail="Используй стандартный способ покупки для этого товара")
    price = int(item.get("price_rub") or 0)
    con = db_conn()
    try:
        bal = _get_user_balance_reliable(con, uid)
        _log.info("[SHOP_BUY] balance=%s price=%s", bal, price)
        if bal < price:
            raise HTTPException(status_code=402, detail=f"Недостаточно средств. Нужно {price} ₽, у вас {bal} ₽")
        # Check unlimited stock mode
        is_unlimited = bool(item.get("unlimited"))
        if is_unlimited:
            # Unlimited: use first inventory item as template, don't mark sold
            inv = con.execute("SELECT id, item_type, data_json FROM shop_inventory WHERE product_id=? ORDER BY id ASC LIMIT 1", (product_id,)).fetchone()
            if not inv:
                raise HTTPException(status_code=409, detail="Товар не настроен (нет шаблона на складе)")
            item_type = str(_rget(inv, "item_type") or "digital")
            try:
                delivery = json.loads(_rget(inv, "data_json") or "{}")
            except Exception:
                delivery = {}
            ts = _now_utc_iso()
            # Don't mark sold - unlimited!
        else:
            # Normal: get first unsold inventory item
            inv = con.execute("SELECT id, item_type, data_json FROM shop_inventory WHERE product_id=? AND sold=0 ORDER BY id ASC LIMIT 1", (product_id,)).fetchone()
            if not inv:
                raise HTTPException(status_code=409, detail="Товар временно недоступен (нет на складе)")
            inv_id = int(_rget(inv, "id") or 0)
            item_type = str(_rget(inv, "item_type") or "digital")
            _log.info("[SHOP_BUY] inv_id=%s type=%s", inv_id, item_type)
            try:
                delivery = json.loads(_rget(inv, "data_json") or "{}")
            except Exception:
                delivery = {}
            ts = _now_utc_iso()
            # Mark sold
            con.execute("UPDATE shop_inventory SET sold=1, sold_at=?, sold_to_user_id=? WHERE id=?", (ts, uid, inv_id))
        # Deduct balance
        if price > 0:
            _credit_balance_direct(con, uid, -price, f"shop buy {product_id}")
        # Record purchase
        _purchase_id = None
        try:
            _ensure_purchases_table(con)
            con.execute(
                "INSERT INTO user_purchases(user_id, product_id, product_title, item_type, delivery_json, price, ts) VALUES(?,?,?,?,?,?,?)",
                (uid, product_id, item.get("title",""), item_type, json.dumps(delivery, ensure_ascii=False), price, ts)
            )
            _pr = con.execute("SELECT id FROM user_purchases WHERE user_id=? ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
            if _pr: _purchase_id = int(_rget(_pr, "id") or 0)
        except Exception as pe:
            _log.warning("[SHOP_BUY] user_purchases insert failed: %s", pe)
        con.commit()
        _log.info("[SHOP_BUY] committed OK")
        # Auto-hide product if no stock left (skip for unlimited)
        if not is_unlimited:
            try:
                remaining = con.execute("SELECT COUNT(*) as cnt FROM shop_inventory WHERE product_id=? AND sold=0", (product_id,)).fetchone()
                remaining_count = _count_val(remaining, "cnt")
                if remaining_count == 0:
                    cfg2 = _shop_cfg_get() or {}
                    items2 = cfg2.get("items") or []
                    for it in items2:
                        if it.get("id") == product_id and it.get("item_type") not in ("special",):
                            it["out_of_stock"] = True
                    _shop_cfg_set(cfg2)
            except Exception as se:
                _log.warning("[SHOP_BUY] stock check failed: %s", se)
        remaining_cnt = 1 if is_unlimited else 0
        try:
            rc = con.execute("SELECT COUNT(*) as cnt FROM shop_inventory WHERE product_id=? AND sold=0", (product_id,)).fetchone()
            remaining_cnt = _count_val(rc, "cnt")
        except Exception:
            pass
        out_of_stock = (remaining_cnt == 0)
        new_bal_row = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
        new_balance = int(_rget(new_bal_row, "balance") or 0) if new_bal_row else None
        return {"ok": True, "item_type": item_type, "delivery": delivery, "product_title": item.get("title", ""),
                "out_of_stock": out_of_stock, "new_balance": new_balance, "purchase_id": _purchase_id}
    except HTTPException:
        raise
    except Exception as e:
        _log.error("[SHOP_BUY] CRASH: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Ошибка покупки: {str(e)[:200]}")
    finally:
        try:
            con.close()
        except Exception:
            pass


# ---- Voucher system ----

def _random_password(length: int = 12) -> str:
    import secrets, string
    alpha = string.ascii_letters + string.digits + "!@#$%"
    return "".join(secrets.choice(alpha) for _ in range(length))


@app.post("/api/admin/shop/voucher/create")
def api_admin_voucher_create(request: Request, payload: Dict[str, Any]):
    require_admin(request)
    product_id = str(payload.get("product_id") or "").strip()
    uses = max(1, int(payload.get("uses") or 1))
    note = str(payload.get("note") or "").strip()[:200]
    expires_at = str(payload.get("expires_at") or "").strip() or None
    if not product_id:
        raise HTTPException(status_code=400, detail="product_id required")
    import secrets as _secrets
    code = _secrets.token_urlsafe(8).upper()
    con = db_conn()
    con.execute(
        "INSERT INTO shop_vouchers(code, product_id, uses_total, uses_left, created_by, note, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?)",
        (code, product_id, uses, uses, int(require_admin(request)["id"]), note, expires_at, _now_utc_iso())
    )
    con.commit()
    con.close()
    return {"ok": True, "code": code, "url": f"/v/{code}"}


@app.get("/api/admin/shop/vouchers")
def api_admin_vouchers_list(request: Request, product_id: str = ""):
    require_admin(request)
    con = db_conn()
    if product_id:
        rows = con.execute("SELECT * FROM shop_vouchers WHERE product_id=? ORDER BY id DESC LIMIT 100", (product_id,)).fetchall()
    else:
        rows = con.execute("SELECT * FROM shop_vouchers ORDER BY id DESC LIMIT 200").fetchall()
    con.close()
    return {"ok": True, "vouchers": [dict(r) for r in rows]}


@app.delete("/api/admin/shop/voucher/{vid}")
def api_admin_voucher_delete(request: Request, vid: int):
    require_admin(request)
    con = db_conn()
    con.execute("DELETE FROM shop_vouchers WHERE id=?", (vid,))
    con.commit()
    con.close()
    return {"ok": True}


def _voucher_claim_core(code: str, uid: int) -> dict:
    """Core logic: validate voucher, get inventory, deliver. Returns delivery dict."""
    try:
        return _db_retry(lambda: _voucher_claim_core_inner(code, uid))
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Ошибка при активации ваучера: {str(e)}")


def _voucher_claim_core_inner(code: str, uid: int) -> dict:
    """Core logic: validate voucher, get inventory, deliver. Returns delivery dict."""
    _log.info("[VOUCHER] start code=%s uid=%s", code, uid)
    con = db_conn()
    try:
        vrow = con.execute(
            "SELECT id, product_id, uses_left, expires_at FROM shop_vouchers WHERE code=?",
            (code.upper(),)
        ).fetchone()
        if not vrow:
            raise HTTPException(status_code=404, detail="Ваучер не найден")
        _log.info("[VOUCHER] found voucher id=%s product=%s uses=%s", _rget(vrow,"id"), _rget(vrow,"product_id"), _rget(vrow,"uses_left"))
        uses_left = int(_rget(vrow, "uses_left") or 0)
        if uses_left <= 0:
            raise HTTPException(status_code=400, detail="Ваучер уже использован")
        exp = str(_rget(vrow, "expires_at") or "")
        if exp:
            try:
                if datetime.datetime.fromisoformat(exp) < datetime.datetime.utcnow():
                    raise HTTPException(status_code=400, detail="Срок действия ваучера истёк")
            except HTTPException:
                raise
            except Exception:
                pass
        vrow_id = int(_rget(vrow, "id") or 0)
        already = con.execute(
            "SELECT id FROM shop_voucher_uses WHERE voucher_id=? AND user_id=?",
            (vrow_id, uid)
        ).fetchone()
        if already:
            raise HTTPException(status_code=400, detail="Вы уже использовали этот ваучер")

        product_id = str(_rget(vrow, "product_id") or "")
        _log.info("[VOUCHER] product_id=%s", product_id)
        # Read shop config WITHOUT opening separate connection
        cfg = _shop_cfg_get() or _shop_default_config()
        item = next((i for i in (cfg.get("items") or []) if i.get("id") == product_id), None)
        item_type = (item or {}).get("item_type", "digital")
        delivery = {}

        if item_type != "special":
            is_unlimited = bool((item or {}).get("unlimited"))
            if is_unlimited:
                # Unlimited: use first item as template, don't mark sold
                inv = con.execute(
                    "SELECT id, item_type, data_json FROM shop_inventory WHERE product_id=? ORDER BY id ASC LIMIT 1",
                    (product_id,)
                ).fetchone()
            else:
                inv = con.execute(
                    "SELECT id, item_type, data_json FROM shop_inventory WHERE product_id=? AND sold=0 ORDER BY id ASC LIMIT 1",
                    (product_id,)
                ).fetchone()
            if not inv:
                raise HTTPException(status_code=409, detail="Товар временно недоступен (нет на складе)")
            inv_id = int(_rget(inv, "id") or 0)
            try:
                delivery = json.loads(_rget(inv, "data_json") or "{}")
            except Exception:
                delivery = {}
            ts = _now_utc_iso()
            if not is_unlimited:
                _log.info("[VOUCHER] marking inv_id=%s sold", inv_id)
                try:
                    con.execute("UPDATE shop_inventory SET sold=1, sold_at=?, sold_to_user_id=?, voucher_id=? WHERE id=?",
                                (ts, uid, vrow_id, inv_id))
                except Exception:
                    con.execute("UPDATE shop_inventory SET sold=1, sold_at=?, sold_to_user_id=? WHERE id=?",
                                (ts, uid, inv_id))
        else:
            ts = _now_utc_iso()
            delivery = {"special_action": (item or {}).get("special_action", "")}

        con.execute("UPDATE shop_vouchers SET uses_left=uses_left-1 WHERE id=?", (vrow_id,))
        con.execute("INSERT INTO shop_voucher_uses(voucher_id, user_id, used_at) VALUES(?,?,?)",
                    (vrow_id, uid, ts))
        try:
            _ensure_purchases_table(con)
            con.execute(
                "INSERT INTO user_purchases(user_id, product_id, product_title, item_type, delivery_json, price, ts) VALUES(?,?,?,?,?,?,?)",
                (uid, product_id, (item or {}).get("title", product_id), item_type,
                 json.dumps(delivery, ensure_ascii=False), 0, ts)
            )
        except Exception as pe:
            _log.warning("[VOUCHER] purchases insert: %s", pe)
        con.commit()
        _log.info("[VOUCHER] committed OK")
    except HTTPException:
        try: con.close()
        except: pass
        raise
    except Exception as e:
        _log.error("[VOUCHER] CRASH: %s", e, exc_info=True)
        try: con.close()
        except: pass
        raise
    finally:
        try: con.close()
        except: pass

    # Stock check AFTER close (separate connection)
    out_of_stock = False
    try:
        if item_type != "special":
            con2 = db_conn()
            remaining = con2.execute("SELECT COUNT(*) as cnt FROM shop_inventory WHERE product_id=? AND sold=0", (product_id,)).fetchone()
            remaining_count = _count_val(remaining, "cnt")
            con2.close()
            if remaining_count == 0:
                out_of_stock = True
                cfg2 = _shop_cfg_get() or {}
                items2 = cfg2.get("items") or []
                for it in items2:
                    if it.get("id") == product_id:
                        it["out_of_stock"] = True
                _shop_cfg_set(cfg2)
    except Exception as se:
        _log.warning("[VOUCHER] stock check: %s", se)
    return {
        "ok": True,
        "item_type": item_type,
        "delivery": delivery,
        "product_id": product_id,
        "product_title": (item or {}).get("title", product_id),
        "out_of_stock": out_of_stock,
    }


@app.post("/api/shop/voucher/claim")
def api_shop_voucher_claim(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    code = str(payload.get("code") or "").strip()
    _log.info("[VOUCHER_CLAIM] uid=%s code=%s", u["id"], code)
    if not code:
        raise HTTPException(status_code=400, detail="code required")
    return _voucher_claim_core(code, int(u["id"]))




# ═══════════════════════════════════════════════
# USER PURCHASES (Мои покупки)
# ═══════════════════════════════════════════════

@app.get("/api/purchases")
def api_get_purchases(request: Request):
    """Get all purchases for current user, including robux orders."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    _ensure_purchases_table(con)
    rows = con.execute(
        "SELECT id, product_id, product_title, item_type, delivery_json, price, note, ts FROM user_purchases WHERE user_id=? ORDER BY id DESC LIMIT 100",
        (uid,)
    ).fetchall()

    result = []
    for r in rows:
        try:
            delivery = json.loads(r["delivery_json"] or "{}")
        except Exception:
            delivery = {}
        result.append({
            "id": int(r["id"]),
            "product_id": str(r["product_id"] or ""),
            "product_title": str(r["product_title"] or ""),
            "item_type": str(r["item_type"] or "digital"),
            "delivery": delivery,
            "price": int(r["price"] or 0),
            "note": str(r["note"] or ""),
            "ts": str(r["ts"] or ""),
        })

    # Also include robux orders
    try:
        _robux_expire_overdue(con)
        robux_rows = con.execute(
            "SELECT id, robux_amount, rub_price, status, gamepass_name, gamepass_owner, gamepass_url, created_at, done_at, done_ts, paid_at, cancelled_at, cancel_reason, cancelled_by, error_message FROM robux_orders WHERE user_id=? AND status NOT IN ('new','cancelled','error','failed','expired') ORDER BY id DESC LIMIT 50",
            (uid,)
        ).fetchall() or []
        for rr in robux_rows:
            st = str(_rget(rr, "status") or "")
            status_text = {
                "reserved": "Забронирован",
                "paid": "Ожидает отправки",
                "processing": "Отправляется",
                "done": "Доставлено",
                "cancelled": "Отменён",
                "refunded": "Возврат",
                "expired": "Истёк",
                "error": "Ошибка",
                "failed": "Ошибка",
            }.get(st, st)
            delivery = {
                "type": "robux",
                "robux_amount": int(_rget(rr, "robux_amount") or 0),
                "status": st,
                "status_text": status_text,
                "gamepass_name": str(_rget(rr, "gamepass_name") or ""),
                "gamepass_owner": str(_rget(rr, "gamepass_owner") or ""),
                "gamepass_url": str(_rget(rr, "gamepass_url") or ""),
                "created_at": str(_rget(rr, "created_at") or ""),
                "paid_at": str(_rget(rr, "paid_at") or ""),
                "done_at": str(_rget(rr, "done_at") or ""),
                "done_ts": str(_rget(rr, "done_ts") or ""),
                "cancelled_at": str(_rget(rr, "cancelled_at") or ""),
                "cancel_reason": str(_rget(rr, "cancel_reason") or ""),
                "cancelled_by": str(_rget(rr, "cancelled_by") or ""),
                "error": str(_rget(rr, "error_message") or ""),
                "order_id": int(_rget(rr, "id") or 0),
            }
            result.append({
                "id": int(_rget(rr, "id") or 0) + 1000000,
                "product_id": f"robux_order_{int(_rget(rr, 'id') or 0)}",
                "product_title": f"Robux: {int(_rget(rr, 'robux_amount') or 0)} R$",
                "item_type": "robux",
                "delivery": delivery,
                "price": int(_rget(rr, "rub_price") or 0),
                "note": "",
                "ts": str(_rget(rr, "created_at") or ""),
            })
    except Exception as e:
        print(f"[PURCHASES] Failed to merge robux orders: {e}")

    # Sort all by timestamp descending
    result.sort(key=lambda x: x.get("ts", ""), reverse=True)

    con.close()
    return {"ok": True, "purchases": result}


@app.post("/api/purchases/{purchase_id}/note")
def api_purchase_note(request: Request, purchase_id: int, payload: Dict[str, Any] = Body(...)):
    """Add/update note on a purchase."""
    u = require_user(request)
    uid = int(u["id"])
    note = str(payload.get("note") or "")[:500]
    con = db_conn()
    _ensure_purchases_table(con)
    row = con.execute("SELECT id FROM user_purchases WHERE id=? AND user_id=?", (purchase_id, uid)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Purchase not found")
    con.execute("UPDATE user_purchases SET note=? WHERE id=?", (note, purchase_id))
    con.commit()
    con.close()
    return {"ok": True}


# ============================================
# STEAM GUARD (SDA) — TOTP Code Generator
# ============================================

def _steam_guard_code(shared_secret: str) -> dict:
    """Generate Steam Guard TOTP code from shared_secret (base64)."""
    import base64, struct, hashlib, hmac, time as _time
    STEAM_CHARS = "23456789BCDFGHJKMNPQRTVWXY"
    try:
        secret = base64.b64decode(shared_secret)
    except Exception:
        return {"code": "ERROR", "remaining": 0}
    timestamp = int(_time.time())
    time_step = timestamp // 30
    remaining = 30 - (timestamp % 30)
    # HMAC-SHA1
    msg = struct.pack(">Q", time_step)
    mac = hmac.new(secret, msg, hashlib.sha1).digest()
    # Dynamic truncation
    offset = mac[-1] & 0x0F
    code_int = struct.unpack(">I", mac[offset:offset+4])[0] & 0x7FFFFFFF
    # Convert to 5-char Steam code
    code = ""
    for _ in range(5):
        code += STEAM_CHARS[code_int % len(STEAM_CHARS)]
        code_int //= len(STEAM_CHARS)
    return {"code": code, "remaining": remaining, "timestamp": timestamp}


@app.post("/api/steam/guard_code")
def api_steam_guard_code(request: Request, payload: Dict[str, Any] = Body(...)):
    """Generate Steam Guard code for a purchased Steam account."""
    u = require_user(request)
    uid = int(u["id"])
    purchase_id = int(payload.get("purchase_id") or 0)
    if not purchase_id:
        raise HTTPException(status_code=400, detail="purchase_id required")
    con = db_conn()
    row = con.execute(
        "SELECT delivery_json, item_type FROM user_purchases WHERE id=? AND user_id=?",
        (purchase_id, uid)
    ).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="Покупка не найдена")
    if str(_rget(row, "item_type") or "") != "account":
        raise HTTPException(status_code=400, detail="Это не аккаунт")
    try:
        delivery = json.loads(_rget(row, "delivery_json") or "{}")
    except Exception:
        delivery = {}
    shared_secret = delivery.get("shared_secret") or ""
    if not shared_secret:
        raise HTTPException(status_code=400, detail="Steam Guard не настроен для этого аккаунта")
    result = _steam_guard_code(shared_secret)
    return {"ok": True, **result}


@app.get("/api/steam/guard_info/{purchase_id}")
def api_steam_guard_info(request: Request, purchase_id: int):
    """Check if a purchase has Steam Guard data."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    row = con.execute(
        "SELECT delivery_json, item_type FROM user_purchases WHERE id=? AND user_id=?",
        (purchase_id, uid)
    ).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        delivery = json.loads(_rget(row, "delivery_json") or "{}")
    except Exception:
        delivery = {}
    has_guard = bool(delivery.get("shared_secret"))
    has_identity = bool(delivery.get("identity_secret"))
    return {
        "ok": True,
        "has_steam_guard": has_guard,
        "has_identity_secret": has_identity,
        "steam_login": delivery.get("login", ""),
    }


def _steam_confirmation_key(identity_secret: str, tag: str = "conf") -> dict:
    """Generate Steam trade confirmation key from identity_secret."""
    import base64, struct, hashlib, hmac, time as _time
    try:
        secret = base64.b64decode(identity_secret)
    except Exception:
        return {"key": "", "timestamp": 0}
    timestamp = int(_time.time())
    data = struct.pack(">Q", timestamp)
    if tag:
        data += tag.encode("utf-8")
    mac = hmac.new(secret, data, hashlib.sha1).digest()
    key = base64.b64encode(mac).decode("utf-8")
    return {"key": key, "timestamp": timestamp}


def _get_steam_delivery(con, purchase_id: int, uid: int) -> dict:
    """Get delivery data for a steam account purchase."""
    row = con.execute(
        "SELECT delivery_json, item_type FROM user_purchases WHERE id=? AND user_id=?",
        (purchase_id, uid)
    ).fetchone()
    if not row:
        return {}
    try:
        return json.loads(_rget(row, "delivery_json") or "{}")
    except Exception:
        return {}


@app.post("/api/steam/confirmations")
def api_steam_confirmations(request: Request, payload: Dict[str, Any] = Body(...)):
    """Fetch pending Steam confirmations for a purchased account."""
    import urllib.request, urllib.parse
    u = require_user(request)
    uid = int(u["id"])
    purchase_id = int(payload.get("purchase_id") or 0)
    if not purchase_id:
        raise HTTPException(status_code=400, detail="purchase_id required")
    con = db_conn()
    delivery = _get_steam_delivery(con, purchase_id, uid)
    con.close()
    if not delivery:
        raise HTTPException(status_code=404, detail="Покупка не найдена")
    identity_secret = delivery.get("identity_secret") or ""
    if not identity_secret:
        raise HTTPException(status_code=400, detail="identity_secret не найден")
    # Extract session data from maFile format
    session = delivery.get("Session") or {}
    steam_id = str(session.get("SteamID") or delivery.get("steam_id") or "")
    cookies = str(session.get("SteamLoginSecure") or delivery.get("steam_login_secure") or "")
    device_id = str(delivery.get("device_id") or session.get("DeviceID") or "android:00000000-0000-0000-0000-000000000000")
    if not steam_id or not cookies:
        return {"ok": True, "confirmations": [], "message": "Нет сессии Steam — добавьте Session.SteamID и Session.SteamLoginSecure в данные аккаунта"}
    # Generate confirmation key
    ck = _steam_confirmation_key(identity_secret, "conf")
    params = urllib.parse.urlencode({
        "p": device_id, "a": steam_id,
        "k": ck["key"], "t": ck["timestamp"],
        "m": "android", "tag": "conf"
    })
    url = f"https://steamcommunity.com/mobileconf/getlist?{params}"
    try:
        req = urllib.request.Request(url, headers={
            "Cookie": f"steamLoginSecure={cookies}",
            "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36",
            "Accept": "application/json"
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        confs = []
        for c in (data.get("conf") or []):
            confs.append({
                "id": c.get("id"), "nonce": c.get("nonce"), "type": c.get("type", 0),
                "type_name": {1: "Трейд", 2: "Маркет", 3: "Профиль", 5: "Телефон"}.get(c.get("type", 0), "Другое"),
                "creator_id": c.get("creator_id"), "headline": c.get("headline", ""),
                "summary": ", ".join(c.get("summary", [])) if isinstance(c.get("summary"), list) else str(c.get("summary", "")),
                "time": c.get("creation_time", 0),
            })
        return {"ok": True, "confirmations": confs, "success": data.get("success", False)}
    except Exception as e:
        return {"ok": True, "confirmations": [], "error": str(e)[:200]}


@app.post("/api/steam/confirmations/respond")
def api_steam_confirmations_respond(request: Request, payload: Dict[str, Any] = Body(...)):
    """Accept or cancel a Steam confirmation."""
    import urllib.request, urllib.parse
    u = require_user(request)
    uid = int(u["id"])
    purchase_id = int(payload.get("purchase_id") or 0)
    conf_id = str(payload.get("conf_id") or "")
    conf_nonce = str(payload.get("conf_nonce") or "")
    action = str(payload.get("action") or "")  # "allow" or "cancel"
    if action not in ("allow", "cancel"):
        raise HTTPException(status_code=400, detail="action must be allow or cancel")
    if not purchase_id or not conf_id or not conf_nonce:
        raise HTTPException(status_code=400, detail="Missing required fields")
    con = db_conn()
    delivery = _get_steam_delivery(con, purchase_id, uid)
    con.close()
    identity_secret = delivery.get("identity_secret") or ""
    session = delivery.get("Session") or {}
    steam_id = str(session.get("SteamID") or delivery.get("steam_id") or "")
    cookies = str(session.get("SteamLoginSecure") or delivery.get("steam_login_secure") or "")
    device_id = str(delivery.get("device_id") or session.get("DeviceID") or "android:00000000-0000-0000-0000-000000000000")
    if not identity_secret or not steam_id or not cookies:
        raise HTTPException(status_code=400, detail="Недостаточно данных для подтверждения")
    tag = action  # "allow" or "cancel"
    ck = _steam_confirmation_key(identity_secret, tag)
    op = "allow" if action == "allow" else "cancel"
    params = urllib.parse.urlencode({
        "op": op, "p": device_id, "a": steam_id,
        "k": ck["key"], "t": ck["timestamp"],
        "m": "android", "tag": tag,
        "cid": conf_id, "ck": conf_nonce
    })
    url = f"https://steamcommunity.com/mobileconf/ajaxop?{params}"
    try:
        req = urllib.request.Request(url, headers={
            "Cookie": f"steamLoginSecure={cookies}",
            "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36",
            "Accept": "application/json"
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        return {"ok": True, "success": data.get("success", False), "action": action}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


@app.post("/api/steam/remove_guard")
def api_steam_remove_guard(request: Request, payload: Dict[str, Any] = Body(...)):
    """Remove Steam Guard data from a purchased account. Returns revocation code."""
    u = require_user(request)
    uid = int(u["id"])
    purchase_id = int(payload.get("purchase_id") or 0)
    confirm = payload.get("confirm", False)
    if not purchase_id:
        raise HTTPException(status_code=400, detail="purchase_id required")
    con = db_conn()
    row = con.execute(
        "SELECT delivery_json, item_type FROM user_purchases WHERE id=? AND user_id=?",
        (purchase_id, uid)
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Покупка не найдена")
    try:
        delivery = json.loads(_rget(row, "delivery_json") or "{}")
    except Exception:
        delivery = {}
    revocation_code = delivery.get("revocation_code") or ""
    if not confirm:
        # First call: return info + ask for confirmation
        con.close()
        return {
            "ok": True, "needs_confirm": True,
            "revocation_code": revocation_code,
            "has_guard": bool(delivery.get("shared_secret")),
            "message": "Это удалит Steam Guard данные с нашего сервера. Код восстановления (R-код) будет показан для ручного удаления Guard через Steam."
        }
    # Second call with confirm=True: remove SDA data
    sda_keys = ["shared_secret", "identity_secret", "Session", "device_id",
                "serial_number", "uri", "server_time", "token_gid"]
    for k in sda_keys:
        delivery.pop(k, None)
    con.execute(
        "UPDATE user_purchases SET delivery_json=? WHERE id=? AND user_id=?",
        (json.dumps(delivery, ensure_ascii=False), purchase_id, uid)
    )
    con.commit()
    con.close()
    return {
        "ok": True, "removed": True,
        "revocation_code": revocation_code,
        "message": "Steam Guard данные удалены." + (f" Код восстановления: {revocation_code}" if revocation_code else "")
    }

@app.post("/api/shop/voucher/register-and-claim")
def api_shop_voucher_register_and_claim(payload: Dict[str, Any]):
    """Auto-register with email and claim voucher. Returns JWT token + delivery."""
    email = str(payload.get("email") or "").strip().lower()
    code = str(payload.get("code") or "").strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Введите корректный email")
    if not code:
        raise HTTPException(status_code=400, detail="code required")

    con = db_conn()
    existing = con.execute("SELECT id FROM users WHERE lower(email)=?", (email,)).fetchone()
    if existing:
        uid = int(_rget(existing, "id"))
        con.close()
        # Already exists — just claim
        result = _voucher_claim_core(code, uid)
        return result

    # Auto-register
    import secrets as _sec, string as _str
    password = _random_password(12)
    username = "user_" + _sec.token_hex(4)
    # Ensure username unique
    while con.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
        username = "user_" + _sec.token_hex(4)
    ph = hash_password(password)
    ts = _now_utc_iso()
    con.execute(
        "INSERT INTO users(username, password_hash, email, email_verified, created_at) VALUES(?,?,?,1,?)",
        (username, ph, email, ts)
    )
    con.commit()
    new_user = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    uid = int(_rget(new_user, "id"))
    con.close()

    # Send welcome email with password
    try:
        body = (
            _email_delivery_account(username, password, email) +
            "<p style='color:#8878a8;font-size:14px;margin-top:20px;line-height:1.6'>"
            "Зайдите на <a href='https://rbxstore.ru' style='color:#c084fc'>rbxstore.ru</a>, "
            "войдите в аккаунт и посмотрите историю покупок.</p>"
        )
        html = _email_html(
            "🎉 Аккаунт создан и товар выдан!",
            body,
            subtitle="Вы получили товар по ваучеру. Ниже — данные для входа на сайт RBX Store.",
            cta_text="Войти на RBX Store",
            cta_url="https://rbxstore.ru",
        )
        text = "Email: " + email + "\nЛогин: " + username + "\nПароль: " + password + "\n\nСохраните данные для входа на rbxstore.ru"
        send_brevo_email(email, "🎉 Аккаунт создан — RBX ST", text, html)
    except Exception:
        pass

    result = _voucher_claim_core(code, uid)
    result["auto_registered"] = True
    result["password"] = password
    result["username"] = username
    return result


@app.get("/v/{code}")
def voucher_page(request: Request, code: str):
    """Voucher landing page — redirect to main site with voucher param."""
    from starlette.responses import HTMLResponse as _HR
    code = code.upper().strip()
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=/?voucher={code}">
<title>RBX Store — ваучер</title>
</head><body style="background:#0a0a0f;color:#fff;font-family:Arial;text-align:center;padding-top:80px">
<p style="color:#c084fc;font-size:18px">Перенаправляем...</p>
<script>window.location.href = '/?voucher={code}';</script>
</body></html>"""
    return _HR(content=html)



# ============================================
# REVIEWS API
# ============================================

@app.get("/api/user/public_profile")
def api_user_public_profile(user_id: int = 0):
    """Public profile info for a user (for review cards)."""
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id required")
    con = db_conn()
    row = con.execute(
        "SELECT id, username, avatar_url, premium_until FROM users WHERE id=?", (user_id,)
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="User not found")
    # Purchase count
    pc_row = con.execute(
        "SELECT COUNT(*) as cnt FROM robux_orders WHERE user_id=? AND status IN ('done','completed','archived')",
        (user_id,)
    ).fetchone()
    purchase_count = int(_rget(pc_row, "cnt") or 0)
    # Review
    rev = con.execute(
        "SELECT rating, text FROM reviews WHERE user_id=? AND status='approved' ORDER BY id DESC LIMIT 1",
        (user_id,)
    ).fetchone()
    con.close()
    now = datetime.datetime.utcnow()
    pu = _parse_iso(_rget(row, "premium_until") or "")
    is_premium = bool(pu and now < pu)
    return {
        "ok": True,
        "user": {
            "id": int(_rget(row, "id")),
            "username": str(_rget(row, "username") or ""),
            "avatar_url": str(_rget(row, "avatar_url") or ""),
            "is_premium": is_premium,
            "purchase_count": purchase_count,
            "review": {"rating": int(_rget(rev, "rating") or 0), "text": str(_rget(rev, "text") or "")} if rev else None,
        }
    }


def _ai_moderate_review(text: str) -> str:
    """
    Moderate review text: keyword filter + AI check.
    Returns 'ok' to auto-approve, 'reject' to block.
    """
    if not text or len(text.strip()) < 3:
        return "reject"
    low = text.lower()
    # Expanded Russian/English profanity and 18+ keyword filter
    _bad_words = [
        "хуй", "хуя", "хуе", "хуё", "пизд", "блять", "бляд", "блят", "ебат", "ебан", "ёбан", "ебал",
        "ёбал", "ебло", "ебуч", "ёбуч", "ебну", "ёбну", "сука", "сучк", "сучар",
        "мудак", "мудил", "пидор", "пидар", "педик", "гандон", "гондон", "шлюх",
        "дрочи", "дроч", "залуп", "манда", "минет", "член", "сосать",
        "fuck", "shit", "bitch", "asshole", "dick", "pussy", "cunt", "nigger", "nigga",
        "porn", "порн", "nsfw", "секс", "sex", "anal", "анал",
        "наркот", "нарко", "героин", "кокаин", "метамф", "мефедрон",
    ]
    for w in _bad_words:
        if w in low:
            return "reject"
    # AI moderation via provider (if available)
    try:
        mod_prompt = (
            "Ты модератор отзывов. Проверь текст на мат, оскорбления, 18+ контент, спам, "
            "рекламу других сайтов, угрозы. Ответь ОДНИМ словом: OK или REJECT.\n\n"
            f"Текст отзыва: \"{text[:500]}\""
        )
        result = provider_chat(provider="groq", model="llama-3.3-70b-versatile", system="Ты модератор. Отвечай только OK или REJECT.", user=mod_prompt, temperature=0.1, max_tokens=10)
        if result and "reject" in result.strip().lower():
            return "reject"
    except Exception:
        pass  # If AI fails, rely on keyword filter above
    return "ok"


@app.get("/api/reviews")
def api_reviews_list():
    """Public: get approved reviews"""
    con = db_conn()
    rows = con.execute(
        "SELECT r.id, r.user_id, r.username, r.rating, r.text, r.created_at, u.avatar_url, u.premium_until "
        "FROM reviews r LEFT JOIN users u ON u.id = r.user_id "
        "WHERE r.status='approved' ORDER BY r.id DESC LIMIT 50"
    ).fetchall()
    # Get purchase counts matching exactly what "Мои покупки" shows:
    # - user_purchases table (all shop items)
    # - robux_orders where status NOT IN ('new','cancelled','error','failed','expired')
    user_ids = list({int(r["user_id"]) for r in rows if r["user_id"]})
    purchase_counts = {}
    if user_ids:
        qmarks = ",".join(["?"] * len(user_ids))
        # Robux orders (same filter as /api/purchases)
        try:
            pc_rows = con.execute(
                f"SELECT user_id, COUNT(*) as cnt FROM robux_orders WHERE user_id IN ({qmarks}) AND status NOT IN ('new','cancelled','error','failed','expired') GROUP BY user_id",
                tuple(user_ids)
            ).fetchall()
            for pc in pc_rows:
                purchase_counts[int(_rget(pc, "user_id") or 0)] = int(_rget(pc, "cnt") or 0)
        except Exception:
            pass
        # Shop purchases from user_purchases (the real table used by Мои покупки)
        try:
            sp_rows = con.execute(
                f"SELECT user_id, COUNT(*) as cnt FROM user_purchases WHERE user_id IN ({qmarks}) GROUP BY user_id",
                tuple(user_ids)
            ).fetchall()
            for sp in sp_rows:
                uid_sp = int(_rget(sp, "user_id") or 0)
                purchase_counts[uid_sp] = purchase_counts.get(uid_sp, 0) + int(_rget(sp, "cnt") or 0)
        except Exception:
            pass
    now_utc = _now_utc()
    con.close()
    return [
        {"id": r["id"], "user_id": r["user_id"], "username": r["username"], "rating": r["rating"],
         "text": r["text"], "created_at": r["created_at"],
         "avatar_url": str(_rget(r, "avatar_url") or ""),
         "purchase_count": purchase_counts.get(int(r["user_id"] or 0), 0),
         "is_premium": bool(_rget(r, "premium_until") and _parse_iso(str(_rget(r, "premium_until") or "")) and _parse_iso(str(_rget(r, "premium_until") or "")) > now_utc)}
        for r in rows
    ]

@app.get("/api/reviews/my")
def api_reviews_my(request: Request):
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT id, rating, text, status, created_at FROM reviews WHERE user_id=? ORDER BY id DESC LIMIT 1", (int(u["id"]),)).fetchone()
    con.close()
    if not row:
        return {"ok": True, "review": None}
    return {"ok": True, "review": {"id": int(_rget(row,"id")), "rating": int(_rget(row,"rating") or 5), "text": str(_rget(row,"text") or ""), "status": str(_rget(row,"status") or ""), "created_at": str(_rget(row,"created_at") or "")}}

@app.post("/api/reviews/create")
def api_reviews_create(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    text = str(payload.get("text") or "").strip()
    rating = int(payload.get("rating") or 5)
    if not text or len(text) < 5:
        raise HTTPException(status_code=400, detail="Отзыв слишком короткий (минимум 5 символов)")
    if len(text) > 1000:
        raise HTTPException(status_code=400, detail="Отзыв слишком длинный (максимум 1000 символов)")
    rating = max(1, min(5, rating))
    con = db_conn()
    # Check if user already has a pending/approved review
    existing = con.execute("SELECT id, status FROM reviews WHERE user_id=? ORDER BY id DESC LIMIT 1", (int(u["id"]),)).fetchone()
    if existing:
        st = str(_rget(existing, "status") or "")
        if st == "approved":
            con.close()
            raise HTTPException(status_code=400, detail="У вас уже есть отзыв. Используйте редактирование.")
        if st == "pending":
            con.close()
            raise HTTPException(status_code=400, detail="Ваш отзыв ещё на модерации")
    con.execute(
        "INSERT INTO reviews(user_id, username, rating, text, status, created_at) VALUES(?,?,?,?,?,?)",
        (int(u["id"]), u.get("username") or "User", rating, text, "pending", datetime.datetime.utcnow().isoformat())
    )
    con.commit()
    rid = con.execute("SELECT id FROM reviews WHERE user_id=? ORDER BY id DESC LIMIT 1", (int(u["id"]),)).fetchone()
    con.close()
    # AI auto-moderation
    mod_result = _ai_moderate_review(text)
    if mod_result == "ok":
        con2 = db_conn()
        con2.execute("UPDATE reviews SET status='approved' WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1", (int(u["id"]),))
        con2.commit()
        con2.close()
        return {"ok": True, "status": "approved", "message": "Отзыв опубликован! Модерация пройдена автоматически."}
    return {"ok": True, "status": "pending", "message": "Отзыв отправлен на ручную модерацию"}

@app.get("/api/admin/reviews")
def api_admin_reviews(request: Request, status: str = "pending"):
    require_admin(request)
    con = db_conn()
    rows = con.execute(
        "SELECT id, user_id, username, rating, text, status, created_at FROM reviews WHERE status=? ORDER BY id DESC LIMIT 100",
        (status,)
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]

@app.post("/api/admin/reviews/moderate")
def api_admin_reviews_moderate(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    review_id = int(payload.get("id") or 0)
    action = str(payload.get("action") or "")
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve or reject")
    new_status = "approved" if action == "approve" else "rejected"
    con = db_conn()
    con.execute("UPDATE reviews SET status=? WHERE id=?", (new_status, review_id))
    con.commit()
    con.close()
    return {"ok": True}

@app.post("/api/reviews/edit")
def api_reviews_edit(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    text = str(payload.get("text") or "").strip()
    rating = int(payload.get("rating") or 5)
    if not text or len(text) < 5:
        raise HTTPException(status_code=400, detail="Минимум 5 символов")
    if len(text) > 1000:
        raise HTTPException(status_code=400, detail="Максимум 1000 символов")
    rating = max(1, min(5, rating))
    con = db_conn()
    existing = con.execute("SELECT id, status FROM reviews WHERE user_id=? ORDER BY id DESC LIMIT 1", (int(u["id"]),)).fetchone()
    if not existing:
        con.close()
        raise HTTPException(status_code=404, detail="У вас нет отзыва")
    rid = int(_rget(existing, "id"))
    # AI auto-moderation
    mod_result = _ai_moderate_review(text)
    new_status = "approved" if mod_result == "ok" else "pending"
    con.execute("UPDATE reviews SET text=?, rating=?, status=?, created_at=? WHERE id=?", (text, rating, new_status, _now_utc_iso(), rid))
    con.commit()
    con.close()
    msg = "Отзыв обновлён и прошёл модерацию!" if new_status == "approved" else "Отзыв отправлен на ручную модерацию"
    return {"ok": True, "status": new_status, "message": msg}

@app.post("/api/reviews/cancel")
def api_reviews_cancel(request: Request):
    """Cancel user's pending review (withdraw request)."""
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT id, status FROM reviews WHERE user_id=? ORDER BY id DESC LIMIT 1", (int(u["id"]),)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Отзыв не найден")
    st = str(_rget(row, "status") or "")
    if st != "pending":
        con.close()
        raise HTTPException(status_code=400, detail="Можно отменить только отзыв на модерации")
    con.execute("DELETE FROM reviews WHERE id=?", (int(_rget(row, "id")),))
    con.commit()
    con.close()
    return {"ok": True, "message": "Заявка на отзыв отменена"}

# ═══════════════════════════════════════════════════════════════
#  CARD / SBP MANUAL PAYMENT  — invoice → receipt → AI verify
# ═══════════════════════════════════════════════════════════════

def _gen_unique_amount(base_rub: int):
    """Add random 1-98 kopecks to make amount unique per invoice."""
    kopecks = random.randint(1, 98)
    total_str = f"{base_rub}.{kopecks:02d}"
    return total_str, kopecks


def _ai_verify_receipt(receipt_b64: str, expected_amount_str: str, mime: str = "image/jpeg") -> dict:
    """
    Use Pollinations vision to verify receipt amount.
    Returns {"ok": bool, "confidence": float, "found_amount": str, "reason": str}
    """
    import json as _json
    prompt = f"""Ты — система верификации платежей. Посмотри на квитанцию/скриншот перевода.
Найди сумму перевода (точно до копейки).
Ожидаемая сумма: {expected_amount_str} ₽

Ответь ТОЛЬКО JSON без пояснений:
{{"ok": true/false, "found_amount": "500.47", "date": "2024-03-14", "confidence": 0.95, "reason": "краткое объяснение"}}

Если сумма совпадает с {expected_amount_str} — ok: true.
Если сумма не видна или не совпадает — ok: false.
confidence: от 0.0 до 1.0"""

    try:
        payload = {
            "model": "openai-large",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{receipt_b64}"}}
                ]
            }],
            "max_tokens": 200,
            "stream": False,
        }
        r = requests.post(POLLINATIONS_OPENAI_URL, json=payload, timeout=30)
        if r.status_code != 200:
            return {"ok": False, "confidence": 0.0, "found_amount": "", "reason": f"AI error {r.status_code}"}
        text = r.json()["choices"][0]["message"]["content"].strip()
        text = text.replace("```json", "").replace("```", "").strip()
        result = _json.loads(text)
        return {
            "ok": bool(result.get("ok")),
            "confidence": float(result.get("confidence", 0.5)),
            "found_amount": str(result.get("found_amount", "")),
            "reason": str(result.get("reason", "")),
        }
    except Exception as e:
        return {"ok": False, "confidence": 0.0, "found_amount": "", "reason": f"parse error: {str(e)[:80]}"}


def _credit_card_invoice(con, uid: int, points: int, invoice_id: int):
    """Idempotent: credit balance for card invoice."""
    updated = con.execute(
        "UPDATE card_invoices SET credited=1, status='approved' WHERE id=? AND credited=0",
        (invoice_id,)
    ).rowcount
    if updated == 0:
        return False
    now_str = datetime.datetime.utcnow().isoformat()
    con.execute("UPDATE users SET balance = balance + ? WHERE id=?", (points, uid))
    con.execute(
        "INSERT INTO balance_tx(user_id, amount, direction, source, ref_id, note, created_at) VALUES(?,?,?,?,?,?,?)",
        (uid, points, "in", "card_invoice", invoice_id, f"Пополнение картой/СБП #{invoice_id}", now_str)
    )
    con.commit()
    return True


@app.get("/api/topup/card/config")
def api_card_config(request: Request):
    return {
        "ok": True,
        "enabled": card_payment_enabled(),
        "card_number": CARD_NUMBER,
        "card_owner": CARD_OWNER,
        "card_bank": CARD_BANK,
        "sbp_phone": SBP_PHONE,
        "ttl_minutes": CARD_INVOICE_TTL_MIN,
    }


@app.post("/api/topup/card/create")
def api_card_invoice_create(request: Request, payload: Dict[str, Any] = Body(...)):
    if not card_payment_enabled():
        raise HTTPException(status_code=400, detail="Оплата картой не настроена")
    u = require_user(request)
    uid = int(u["id"])
    try:
        amount_rub = int(payload.get("amount") or 0)
    except Exception:
        amount_rub = 0
    if amount_rub < 10:
        raise HTTPException(status_code=400, detail="Минимум 10 ₽")
    if amount_rub > 50000:
        raise HTTPException(status_code=400, detail="Максимум 50 000 ₽")

    con = db_conn()
    # Cancel previous pending invoices for this user
    con.execute("UPDATE card_invoices SET status='cancelled' WHERE user_id=? AND status='pending'", (uid,))

    exact_str, kopecks = _gen_unique_amount(amount_rub)
    points = amount_rub * BALANCE_PER_CURRENCY
    now = datetime.datetime.utcnow()
    expires = now + datetime.timedelta(minutes=CARD_INVOICE_TTL_MIN)
    cur = con.cursor()
    cur.execute(
        "INSERT INTO card_invoices(user_id,amount_rub,amount_kopecks,exact_amount_str,points,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        (uid, amount_rub, kopecks, exact_str, points, "pending", now.isoformat(), expires.isoformat())
    )
    con.commit()
    invoice_id = cur.lastrowid
    con.close()
    return {
        "ok": True,
        "invoice_id": invoice_id,
        "amount_rub": amount_rub,
        "exact_amount": exact_str,
        "points": points,
        "card_number": CARD_NUMBER,
        "card_owner": CARD_OWNER,
        "card_bank": CARD_BANK,
        "sbp_phone": SBP_PHONE,
        "expires_at": expires.isoformat(),
        "ttl_minutes": CARD_INVOICE_TTL_MIN,
    }


@app.post("/api/topup/card/upload_receipt")
async def api_card_upload_receipt(request: Request, invoice_id: int = Form(...), file: UploadFile = File(...)):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    row = con.execute("SELECT * FROM card_invoices WHERE id=? AND user_id=?", (invoice_id, uid)).fetchone()
    if not row:
        con.close(); raise HTTPException(status_code=404, detail="Инвойс не найден")
    if row["status"] not in ("pending", "review"):
        con.close(); raise HTTPException(status_code=400, detail=f"Инвойс уже {row['status']}")
    try:
        exp = datetime.datetime.fromisoformat(row["expires_at"])
        if datetime.datetime.utcnow() > exp:
            con.execute("UPDATE card_invoices SET status='expired' WHERE id=?", (invoice_id,))
            con.commit(); con.close()
            raise HTTPException(status_code=400, detail="Срок действия инвойса истёк")
    except HTTPException:
        raise
    except Exception:
        pass

    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        con.close(); raise HTTPException(status_code=400, detail="Файл >10 МБ")

    ct = file.content_type or "image/jpeg"
    mime = "application/pdf" if "pdf" in ct else ("image/png" if "png" in ct else "image/jpeg")
    import base64 as _b64
    receipt_b64 = _b64.b64encode(data).decode()

    ai = _ai_verify_receipt(receipt_b64, row["exact_amount_str"], mime)
    confidence = float(ai.get("confidence", 0.0))
    ai_json = json.dumps(ai, ensure_ascii=False)
    now_str = datetime.datetime.utcnow().isoformat()

    if ai.get("ok") and confidence >= 0.80:
        new_status = "approved"
    elif confidence <= 0.25 or (not ai.get("ok") and confidence < 0.5):
        new_status = "rejected"
    else:
        new_status = "review"

    con.execute(
        "UPDATE card_invoices SET status=?,receipt_b64=?,ai_result=?,ai_confidence=?,verified_at=? WHERE id=?",
        (new_status, receipt_b64, ai_json, confidence, now_str, invoice_id)
    )
    con.commit()

    if new_status == "approved":
        _credit_card_invoice(con, uid, int(row["points"]), invoice_id)

    con.close()
    if new_status == "approved":
        return {"ok": True, "status": "approved", "message": f"✅ Квитанция подтверждена! Баланс пополнен на {row['amount_rub']} ₽"}
    elif new_status == "review":
        return {"ok": True, "status": "review", "message": "⏳ Отправлено на ручную проверку. Обычно до 15 минут."}
    else:
        return {"ok": False, "status": "rejected", "message": "❌ Квитанция не прошла проверку. Сумма должна совпадать до копейки.", "ai_reason": ai.get("reason", "")}


@app.get("/api/topup/card/status")
def api_card_status(request: Request, invoice_id: int):
    u = require_user(request)
    con = db_conn()
    row = con.execute(
        "SELECT id,status,exact_amount_str,amount_rub,points,expires_at,credited FROM card_invoices WHERE id=? AND user_id=?",
        (invoice_id, int(u["id"]))
    ).fetchone()
    con.close()
    if not row: raise HTTPException(status_code=404, detail="Не найден")
    return {"ok": True, "invoice_id": row["id"], "status": row["status"],
            "exact_amount": row["exact_amount_str"], "amount_rub": row["amount_rub"],
            "points": row["points"], "expires_at": row["expires_at"], "credited": bool(row["credited"])}


@app.get("/api/admin/card_invoices")
def api_admin_card_list(request: Request, status: str = "review"):
    require_admin(request)
    con = db_conn()
    rows = con.execute(
        """SELECT ci.id, ci.user_id, u.username, ci.amount_rub, ci.exact_amount_str, ci.points,
                  ci.status, ci.ai_result, ci.ai_confidence, ci.created_at, ci.expires_at, ci.admin_note
           FROM card_invoices ci LEFT JOIN users u ON u.id=ci.user_id
           WHERE ci.status=? ORDER BY ci.id DESC LIMIT 100""", (status,)
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


@app.post("/api/admin/card_invoices/moderate")
def api_admin_card_moderate(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    invoice_id = int(payload.get("id") or 0)
    action = str(payload.get("action") or "")
    note = str(payload.get("note") or "")
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve or reject")
    con = db_conn()
    row = con.execute("SELECT * FROM card_invoices WHERE id=?", (invoice_id,)).fetchone()
    if not row: con.close(); raise HTTPException(status_code=404, detail="Не найден")
    now_str = datetime.datetime.utcnow().isoformat()
    if action == "approve":
        _credit_card_invoice(con, int(row["user_id"]), int(row["points"]), invoice_id)
    else:
        con.execute("UPDATE card_invoices SET status='rejected',admin_note=?,verified_at=? WHERE id=?",
                    (note, now_str, invoice_id))
        con.commit()
    con.close()
    return {"ok": True}


@app.get("/api/admin/card_invoices/receipt")
def api_admin_card_receipt(request: Request, invoice_id: int):
    require_admin(request)
    con = db_conn()
    row = con.execute("SELECT receipt_b64 FROM card_invoices WHERE id=?", (invoice_id,)).fetchone()
    con.close()
    if not row or not row["receipt_b64"]: raise HTTPException(status_code=404, detail="Нет квитанции")
    return {"ok": True, "receipt_b64": row["receipt_b64"]}

@app.get("/api/reviews")
def api_reviews_list():
    """Public: get approved reviews"""
    con = db_conn()
    rows = con.execute(
        "SELECT id, username, rating, text, created_at FROM reviews WHERE status='approved' ORDER BY id DESC LIMIT 50"
    ).fetchall()
    con.close()
    return [
        {"id": r["id"], "username": r["username"], "rating": r["rating"], "text": r["text"], "created_at": r["created_at"]}
        for r in rows
    ]

@app.post("/api/reviews/create")
def api_reviews_create(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    text = str(payload.get("text") or "").strip()
    rating = int(payload.get("rating") or 5)
    if not text or len(text) < 5:
        raise HTTPException(status_code=400, detail="Отзыв слишком короткий (минимум 5 символов)")
    if len(text) > 1000:
        raise HTTPException(status_code=400, detail="Отзыв слишком длинный (максимум 1000 символов)")
    rating = max(1, min(5, rating))
    con = db_conn()
    # Check if user already has a pending/approved review
    existing = con.execute("SELECT id, status FROM reviews WHERE user_id=? ORDER BY id DESC LIMIT 1", (int(u["id"]),)).fetchone()
    if existing and existing["status"] in ("pending", "approved"):
        con.close()
        raise HTTPException(status_code=400, detail="У вас уже есть отзыв" if existing["status"] == "approved" else "Ваш отзыв ещё на модерации")
    con.execute(
        "INSERT INTO reviews(user_id, username, rating, text, status, created_at) VALUES(?,?,?,?,?,?)",
        (int(u["id"]), u.get("username") or "User", rating, text, "pending", datetime.datetime.utcnow().isoformat())
    )
    con.commit()
    con.close()
    return {"ok": True, "message": "Отзыв отправлен на модерацию"}

@app.get("/api/admin/reviews")
def api_admin_reviews(request: Request, status: str = "pending"):
    u = require_user(request)
    if not u.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin only")
    con = db_conn()
    rows = con.execute(
        "SELECT id, user_id, username, rating, text, status, created_at FROM reviews WHERE status=? ORDER BY id DESC LIMIT 100",
        (status,)
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]

@app.post("/api/admin/reviews/moderate")
def api_admin_reviews_moderate(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    if not u.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin only")
    review_id = int(payload.get("id") or 0)
    action = str(payload.get("action") or "")
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve or reject")
    new_status = "approved" if action == "approve" else "rejected"
    con = db_conn()
    con.execute("UPDATE reviews SET status=? WHERE id=?", (new_status, review_id))
    con.commit()
    con.close()
    return {"ok": True}

# ============================================
# LEGAL PAGES (required by payment systems)
# ============================================

@app.get("/terms", response_class=HTMLResponse)
def page_terms(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "terms"})

@app.get("/privacy", response_class=HTMLResponse)
def page_privacy(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "privacy"})

@app.get("/agreement", response_class=HTMLResponse)
def page_agreement(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "agreement"})

@app.get("/refund", response_class=HTMLResponse)
def page_refund(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "refund"})

@app.get("/contacts", response_class=HTMLResponse)
def page_contacts(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "contacts"})

# ============================================
# ADMIN STATS DASHBOARD
# ============================================

@app.get("/api/admin/stats")
def api_admin_stats(request: Request):
    u = require_user(request)
    if not u.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin only")
    con = db_conn()
    stats = {}
    try:
        stats["total_users"] = con.execute("SELECT COUNT(*) as c FROM users").fetchone()["c"]
        week_ago = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).isoformat()
        stats["new_users_7d"] = con.execute("SELECT COUNT(*) as c FROM users WHERE created_ts > ?", (int((datetime.datetime.utcnow() - datetime.timedelta(days=7)).timestamp()),)).fetchone()["c"]
        stats["total_balance"] = con.execute("SELECT COALESCE(SUM(balance),0) as s FROM users").fetchone()["s"]
        try:
            stats["pending_topups"] = con.execute("SELECT COUNT(*) as c FROM topups WHERE status='pending'").fetchone()["c"]
            stats["paid_revenue"] = round(con.execute("SELECT COALESCE(SUM(fiat_cents),0) as s FROM topups WHERE status='paid'").fetchone()["s"] / 100, 0)
        except Exception:
            stats["pending_topups"] = 0
            stats["paid_revenue"] = 0
        try:
            stats["active_orders"] = con.execute("SELECT COUNT(*) as c FROM robux_orders WHERE status NOT IN ('done','cancelled','error')").fetchone()["c"]
            stats["done_orders"] = con.execute("SELECT COUNT(*) as c FROM robux_orders WHERE status='done'").fetchone()["c"]
        except Exception:
            stats["active_orders"] = 0
            stats["done_orders"] = 0
        try:
            stats["premium_users"] = con.execute("SELECT COUNT(*) as c FROM users WHERE premium_until IS NOT NULL AND premium_until > ?", (datetime.datetime.utcnow().isoformat(),)).fetchone()["c"]
        except Exception:
            stats["premium_users"] = 0
        try:
            stats["promo_codes"] = con.execute("SELECT COUNT(*) as c FROM promo_codes WHERE active=1").fetchone()["c"]
        except Exception:
            stats["promo_codes"] = 0
    except Exception as e:
        stats["error"] = str(e)
    con.close()
    return stats

# ============================================
# EMAIL TEST (admin)
# ============================================

@app.get("/api/admin/email_test")
def api_admin_email_test(request: Request):
    u = require_user(request)
    if not u.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin only")
    email = u.get("email") or ""
    if not email:
        raise HTTPException(status_code=400, detail="Your account has no email set")
    try:
        send_brevo_email(email, "RBX Store — тест email", "Если вы видите это сообщение, email работает!", "<h3>Email работает!</h3><p>Тест успешно пройден.</p>")
        return {"ok": True, "sent_to": email}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.get("/api/health")
def api_health():
    return {"ok": True}

# ============================================
# TOOLS API ENDPOINTS
# ============================================

@app.post("/api/tools/generate_description")
def generate_description(request: Request, payload: Dict[str, Any] = Body(...)):
    """Генератор описания профиля - AI генерация на основе данных аккаунта"""
    u = require_user(request)
    uid = int(u["id"])
    
    # Проверяем лимиты
    limits = get_user_limits(uid)
    if not limits.get("premium"):
        credits = int(limits.get("credits_ai", 0))
        if credits <= 0:
            raise HTTPException(status_code=403, detail="Недостаточно AI генераций. Купите Premium!")
    
    # Получаем данные для генерации
    provider = payload.get("provider", "perplexity").lower()
    model = payload.get("model", "sonar")
    mode = payload.get("mode", "Рерайт")
    tone = payload.get("tone", "Классика")
    extra = payload.get("extra", "")
    data = payload.get("data") or {}
    
    # Если нет данных - используем username
    username = data.get("username") or payload.get("username", "").strip()
    if not username and not data:
        raise HTTPException(status_code=400, detail="Укажите имя пользователя или данные аккаунта")
    
    # Правила стиля
    rules = build_sales_rule(mode, tone)
    
    # Формируем промпт
    system = (
        "Ты копирайтер, который пишет продающие описания для Roblox-аккаунтов. "
        "Пиши на русском. "
        "Не упоминай, что текст создан ИИ/нейросетью/генератором. "
        "Не используй markdown и блоки ```.\n\n"
        "ФОРМАТ ОТВЕТА СТРОГО ТАКОЙ:\n"
        "TITLE: <одна строка заголовка>\n"
        "DESC:\n<полное описание>\n"
    )
    
    facts = f"Факты об аккаунте:\n"
    facts += f"- Ник: {data.get('username') or username}\n"
    if data.get('user_id'):
        facts += f"- ID: {data.get('user_id')}\n"
    if data.get('robux') is not None:
        facts += f"- Robux: {data.get('robux')}\n"
    if data.get('rap'):
        facts += f"- RAP: {data.get('rap')}\n"
    if data.get('is_premium'):
        facts += f"- Premium: Да\n"
    if data.get('limiteds'):
        facts += f"- Лимитки: {data.get('limiteds')}\n"
    if data.get('groups'):
        facts += f"- Группы: {data.get('groups')}\n"
    
    user_prompt = (
        f"{facts}\n"
        f"Правила стиля:\n{rules}\n"
        f"Пожелания:\n{extra}\n\n"
        f"Сгенерируй TITLE и DESC."
    )
    
    try:
        # Генерируем через AI
        out = provider_chat(provider=provider, model=model, system=system, user=user_prompt)
        title, desc = extract_title_desc(out)
        
        if not title or not desc:
            raise HTTPException(status_code=500, detail="AI не смог сгенерировать описание")
        
        # Сохраняем шаблон для пользователя
        con = db_conn()
        try:
            con.execute(
                "INSERT INTO templates(user_id,title_tpl,desc_tpl,updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET title_tpl=excluded.title_tpl, desc_tpl=excluded.desc_tpl, updated_at=excluded.updated_at",
                (uid, title, desc, datetime.datetime.utcnow().isoformat()),
            )
            con.commit()
        except Exception:
            pass  # Не критично если не сохранилось
        finally:
            con.close()
        
        # Списываем кредиты
        if not limits.get("premium"):
            spend_credit(uid, "credits_ai", 1)
        
        return {
            "ok": True,
            "description": f"{title}\n\n{desc}",  # Для совместимости со старым форматом
            "title": title,
            "desc": desc,
            "username": username
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка генерации: {str(e)[:200]}")

@app.post("/api/tools/ai_chat")
def ai_chat_legacy(request: Request, payload: Dict[str, Any] = Body(...)):
    """Legacy AI chat endpoint - redirects to new multi-chat system"""
    u = require_user(request)
    message = payload.get("message", "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Сообщение обязательно")
    # For backward compatibility (support chat assistant)
    system = payload.get("system") or _get_assistant_system_prompt()
    try:
        response = provider_chat(provider="perplexity", model="sonar", system=system, user=message)
    except Exception:
        response = "Извини, сейчас AI временно недоступен. Попробуй позже!"
    return {"response": response, "message": message}

# ═══════════════════════════════════════════════════
# AI MULTI-CHAT SYSTEM
# ═══════════════════════════════════════════════════

RBX_SITE_CONTEXT = """Ты находишься на сайте RBX ST (rbx-store) — это магазин цифровых услуг для Roblox.
Основные функции сайта:
- Покупка Robux по нику (через геймпассы, безопасно, не требует пароля — только ник). Цены от 10 робуксов за ~1₽/робукс.
- Генератор описаний профиля — AI создаёт продающие описания для Roblox-аккаунтов по шаблону
- Чекер аккаунтов — проверка аккаунта по cookie (.ROBLOSECURITY): показывает Robux, RAP, лимитки, Premium и т.д.
- Прокси-чекер — массовая проверка прокси на работоспособность
- AI-чат — общение с ИИ (ты), помощь по Roblox и сайту
- Магазин — Premium подписка (109₽ на 50 дней), бесплатный кейс (каждые 48 часов), платный кейс (17₽)
- Профиль — баланс, Premium статус, настройки
- Пополнение баланса через CryptoBot (Telegram) и промокоды

Как купить Robux на RBX ST:
1. Зайти в раздел «Robux» в меню
2. Ввести свой ник Roblox
3. Указать количество Robux
4. Оплатить с баланса или через CryptoBot
5. Robux придут через геймпасс автоматически за ~5 секунд

Premium подписка даёт: безлимитные AI-генерации, приоритетную поддержку, расширенный AI-чат (5 чатов, 30 сообщений/неделю).
Бесплатно: 1 чат с AI, 5 сообщений.

Поддержка работает 24/7 через встроенный чат или Telegram.
Сайт запущен в 2026 году.

ВАЖНО: Когда спрашивают как купить робуксы — отвечай ТОЛЬКО про покупку на ЭТОМ сайте (RBX ST), не про официальный Roblox.
Когда спрашивают цены — отвечай про цены на ЭТОМ сайте.
Будь дружелюбным и кратким. Отвечай на русском, если не просят иначе."""

def _get_assistant_system_prompt():
    return (
        "Ты дружелюбный помощник магазина RBX ST. "
        "Помогай пользователям с вопросами про покупку Robux на НАШЕМ сайте, аккаунты, оплату и доставку. "
        "Отвечай кратко и по делу на русском языке. "
        "Когда спрашивают как купить Robux — объясняй процесс на НАШЕМ сайте: зайти в раздел Robux, ввести ник, выбрать количество, оплатить. "
        "Не отправляй людей на официальный сайт Roblox для покупки. "
        "Поддержка: встроенный чат или Telegram. Premium 109₽/50 дней. Сайт работает с 2026 года."
    )

def _get_ai_limits(uid: int) -> dict:
    """Get AI chat limits for user"""
    con = db_conn()
    try:
        u = con.execute("SELECT premium_until FROM users WHERE id=?", (uid,)).fetchone()
        is_premium = False
        if u and u[0]:
            try:
                is_premium = datetime.datetime.fromisoformat(u[0]) > datetime.datetime.utcnow()
            except: pass

        # Count chats
        chat_count = con.execute("SELECT COUNT(*) FROM ai_chats WHERE user_id=?", (uid,)).fetchone()[0]

        # Count messages this week (for premium) or total (for free)
        if is_premium:
            week_ago = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).isoformat()
            msg_count = con.execute(
                "SELECT COUNT(*) FROM ai_chat_msgs m JOIN ai_chats c ON m.chat_id=c.id WHERE c.user_id=? AND m.role='user' AND m.created_at>?",
                (uid, week_ago)
            ).fetchone()[0]
            return {
                "premium": True,
                "max_chats": 5,
                "max_messages": 30,
                "chats_used": chat_count,
                "messages_used": msg_count,
                "period": "week"
            }
        else:
            msg_count = con.execute(
                "SELECT COUNT(*) FROM ai_chat_msgs m JOIN ai_chats c ON m.chat_id=c.id WHERE c.user_id=? AND m.role='user'",
                (uid,)
            ).fetchone()[0]
            return {
                "premium": False,
                "max_chats": 1,
                "max_messages": 5,
                "chats_used": chat_count,
                "messages_used": msg_count,
                "period": "forever"
            }
    finally:
        con.close()


@app.get("/api/ai/limits")
def api_ai_limits(request: Request):
    u = require_user(request)
    return _get_ai_limits(int(u["id"]))


@app.get("/api/ai/chats")
def api_ai_chats_list(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    rows = con.execute(
        "SELECT id, title, created_at, updated_at FROM ai_chats WHERE user_id=? ORDER BY updated_at DESC",
        (uid,)
    ).fetchall()
    con.close()
    chats = [{"id": r[0], "title": r[1], "created_at": r[2], "updated_at": r[3]} for r in rows]
    return {"chats": chats}


@app.post("/api/ai/chats")
def api_ai_chats_create(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    limits = _get_ai_limits(uid)
    if limits["chats_used"] >= limits["max_chats"]:
        detail = "Лимит чатов достигнут. Удалите старый чат или оформите Premium." if not limits["premium"] else "Максимум 5 чатов. Удалите старый чат."
        raise HTTPException(status_code=403, detail=detail)
    now = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    cur = con.execute(
        "INSERT INTO ai_chats(user_id, title, created_at, updated_at) VALUES(?,?,?,?) RETURNING id",
        (uid, "Новый чат", now, now)
    )
    chat_id = cur.fetchone()[0]
    con.commit()
    con.close()
    return {"id": chat_id, "title": "Новый чат", "created_at": now}


@app.delete("/api/ai/chats/{chat_id}")
def api_ai_chats_delete(request: Request, chat_id: int):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    row = con.execute("SELECT id FROM ai_chats WHERE id=? AND user_id=?", (chat_id, uid)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Чат не найден")
    con.execute("DELETE FROM ai_chat_msgs WHERE chat_id=?", (chat_id,))
    con.execute("DELETE FROM ai_chats WHERE id=?", (chat_id,))
    con.commit()
    con.close()
    return {"ok": True}


@app.get("/api/ai/chats/{chat_id}/messages")
def api_ai_chats_messages(request: Request, chat_id: int):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    chat = con.execute("SELECT id FROM ai_chats WHERE id=? AND user_id=?", (chat_id, uid)).fetchone()
    if not chat:
        con.close()
        raise HTTPException(status_code=404, detail="Чат не найден")
    rows = con.execute(
        "SELECT id, role, content, created_at FROM ai_chat_msgs WHERE chat_id=? ORDER BY id ASC",
        (chat_id,)
    ).fetchall()
    con.close()
    msgs = [{"id": r[0], "role": r[1], "content": r[2], "ts": r[3]} for r in rows]
    return {"messages": msgs}


@app.post("/api/ai/chats/{chat_id}/send")
def api_ai_chats_send(request: Request, chat_id: int, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    uid = int(u["id"])
    message = (payload.get("message") or "").strip()
    use_site_context = payload.get("site_context", False)
    if not message:
        raise HTTPException(status_code=400, detail="Сообщение обязательно")

    # Check chat exists
    con = db_conn()
    chat = con.execute("SELECT id FROM ai_chats WHERE id=? AND user_id=?", (chat_id, uid)).fetchone()
    if not chat:
        con.close()
        raise HTTPException(status_code=404, detail="Чат не найден")

    # Check limits
    limits = _get_ai_limits(uid)
    if limits["messages_used"] >= limits["max_messages"]:
        con.close()
        period_text = "на этой неделе" if limits["premium"] else ""
        raise HTTPException(status_code=403, detail=f"Лимит сообщений исчерпан {period_text}. {'Подождите до следующей недели.' if limits['premium'] else 'Оформите Premium для расширенных лимитов.'}")

    now = datetime.datetime.utcnow().isoformat()

    # Save user message
    con.execute("INSERT INTO ai_chat_msgs(chat_id, role, content, created_at) VALUES(?,?,?,?)", (chat_id, "user", message, now))

    # Build context from history
    hist_rows = con.execute(
        "SELECT role, content FROM ai_chat_msgs WHERE chat_id=? ORDER BY id DESC LIMIT 20",
        (chat_id,)
    ).fetchall()
    hist_rows = list(reversed(hist_rows))

    # Build system prompt
    system = "Ты дружелюбный AI-ассистент. Отвечай кратко и по делу на русском языке."
    if use_site_context:
        system = RBX_SITE_CONTEXT

    # Build conversation for context
    context_lines = []
    for r in hist_rows[:-1]:  # exclude the last one (current message)
        prefix = "Пользователь" if r[0] == "user" else "Ассистент"
        context_lines.append(f"{prefix}: {r[1]}")
    if context_lines:
        user_prompt = "\n".join(context_lines) + f"\n\nПользователь: {message}"
    else:
        user_prompt = message

    # Call AI
    try:
        reply = provider_chat(provider="perplexity", model="sonar", system=system, user=user_prompt)
    except Exception as e:
        # Fallback
        try:
            reply = pollinations_chat(model="openai", system=system, user=user_prompt, temperature=0.8, max_tokens=800)
        except:
            reply = "Извини, AI временно недоступен. Попробуй позже!"

    # Save AI response
    con.execute("INSERT INTO ai_chat_msgs(chat_id, role, content, created_at) VALUES(?,?,?,?)", (chat_id, "assistant", reply, now))

    # Update chat title from first message
    msg_count = con.execute("SELECT COUNT(*) FROM ai_chat_msgs WHERE chat_id=? AND role='user'", (chat_id,)).fetchone()[0]
    if msg_count == 1:
        title = message[:40] + ("..." if len(message) > 40 else "")
        con.execute("UPDATE ai_chats SET title=?, updated_at=? WHERE id=?", (title, now, chat_id))
    else:
        con.execute("UPDATE ai_chats SET updated_at=? WHERE id=?", (now, chat_id))

    con.commit()
    con.close()

    # Return updated limits
    new_limits = _get_ai_limits(uid)

    return {"reply": reply, "limits": new_limits}


@app.post("/api/roblox/check_cookie")
async def check_roblox_cookie(request: Request, payload: Dict[str, Any] = Body(...)):
    """Проверка Roblox аккаунта по .ROBLOSECURITY cookie.

    ⚡ Оптимизировано под "MeowTool-style":
    - параллельные запросы (aiohttp)
    - аккуратные таймауты
    - кэш на короткое время (чтобы не долбить Roblox при повторных кликах)
    """
    _ = require_user(request)  # доступ только для залогиненных
    cookie = str(payload.get("cookie", "") or "").strip()

    if not cookie:
        raise HTTPException(status_code=400, detail="Cookie обязателен")

    # Нормализация (поддерживаем вставку как с префиксом, так и без)
    if cookie.startswith(".ROBLOSECURITY="):
        cookie = cookie[len(".ROBLOSECURITY="):].strip()

    # Roblox иногда присылает cookie с _|WARNING:... — оставляем как есть
    cookie_key = hashlib.sha1(cookie.encode("utf-8")).hexdigest()

    # --- in-memory cache (TTL) ---
    now_ts = time.time()
    try:
        cached = _COOKIE_CHECK_CACHE.get(cookie_key)
        if cached and (now_ts - cached["ts"] < 60):
            return cached["data"]
    except Exception:
        pass

    # Если aiohttp недоступен — fallback на requests (медленнее)
    if aiohttp is None:
        data = _check_roblox_cookie_requests(cookie)
        try:
            _COOKIE_CHECK_CACHE[cookie_key] = {"ts": now_ts, "data": data}
        except Exception:
            pass
        return data

    headers = {
        "Cookie": f".ROBLOSECURITY={cookie}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }

    timeout = aiohttp.ClientTimeout(total=20)

    # CRITICAL: DummyCookieJar prevents Roblox from overriding cookies between requests
    # Without this, settings/json response can corrupt the session cookie jar
    jar = aiohttp.DummyCookieJar()
    async with aiohttp.ClientSession(timeout=timeout, cookie_jar=jar) as session:
        # 1) auth user (MeowTool: users/authenticated)
        user_data = await _aio_get_json(session, "https://users.roblox.com/v1/users/authenticated", headers=headers, allow_roproxy=True)
        if not isinstance(user_data, dict) or not user_data.get("id"):
            return {"error": "Куки недействительны или истекли", "status": "invalid"}

        user_id = int(user_data.get("id") or 0)
        username = str(user_data.get("name") or "")
        display_name = str(user_data.get("displayName") or username)

        # 2) MeowTool-style: settings/json gives Premium, CanTrade, Email, 2FA, Pin, Age in ONE call
        settings_url = "https://www.roblox.com/my/settings/json"
        # Other parallel requests
        details_url = f"https://users.roblox.com/v1/users/{user_id}"
        avatar_url = f"https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds={user_id}&size=420x420&format=Png"
        currency_url = f"https://economy.roblox.com/v1/users/{user_id}/currency"
        billing_url = "https://billing.roblox.com/v1/credit"
        totals_url = f"https://economy.roblox.com/v2/users/{user_id}/transaction-totals?timeFrame=Year&transactionType=summary"
        # MeowTool: payment-profiles for card count
        payment_profiles_url = "https://apis.roblox.com/payments-gateway/v1/payment-profiles"
        country_url = "https://users.roblox.com/v1/users/authenticated/country-code"

        friends_url = f"https://friends.roblox.com/v1/users/{user_id}/friends/count"
        followers_url = f"https://friends.roblox.com/v1/users/{user_id}/followers/count"
        followings_url = f"https://friends.roblox.com/v1/users/{user_id}/followings/count"

        # MeowTool: includeLocked=true
        groups_url = f"https://groups.roblox.com/v1/users/{user_id}/groups/roles?includeLocked=true"
        badges_url = f"https://badges.roblox.com/v1/users/{user_id}/badges?limit=100&sortOrder=Desc"
        roblox_badges_url = f"https://accountinformation.roblox.com/v1/users/{user_id}/roblox-badges"
        games_url = f"https://games.roblox.com/v2/users/{user_id}/games?sortOrder=Desc&limit=50"
        collectibles_url = f"https://inventory.roblox.com/v1/users/{user_id}/assets/collectibles?sortOrder=Desc&limit=100"

        # MeowTool: sessions via token-metadata-service
        sessions_url = "https://apis.roblox.com/token-metadata-service/v1/sessions"
        # MeowTool: age group
        age_group_url = "https://apis.roblox.com/user-settings-api/v1/account-insights/age-group"
        # MeowTool: verified age
        verified_age_url = "https://apis.roblox.com/age-verification-service/v1/age-verification/verified-age"
        # MeowTool: voice
        voice_url = "https://voice.roblox.com/v1/settings"
        # Phone (MeowTool: accountinformation)
        phone_url = "https://accountinformation.roblox.com/v1/phone"
        # Privacy
        inv_priv_url = "https://apis.roblox.com/user-settings-api/v1/user-settings/settings-and-options"
        trade_priv_url = "https://accountsettings.roblox.com/v1/trade-privacy"

        tasks = [
            _aio_get_json(session, settings_url, headers=headers, allow_roproxy=False),    # settings/json
            _aio_get_json(session, details_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, avatar_url, headers=None, allow_roproxy=True),
            _aio_get_json(session, currency_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, billing_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, totals_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, payment_profiles_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, country_url, headers=headers, allow_roproxy=True),

            _aio_get_json(session, friends_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, followers_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, followings_url, headers=headers, allow_roproxy=True),

            _aio_get_json(session, groups_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, badges_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, roblox_badges_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, games_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, collectibles_url, headers=headers, allow_roproxy=True),

            _aio_get_json(session, phone_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, sessions_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, inv_priv_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, trade_priv_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, age_group_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, verified_age_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, voice_url, headers=headers, allow_roproxy=False),
        ]

        (
            settings_data,
            details,
            avatar_data,
            currency,
            billing,
            totals,
            payment_profiles,
            country_data,
            friends,
            followers,
            followings,
            groups_roles,
            badges_data,
            roblox_badges_data,
            games_data,
            collectibles_data,
            phone_data,
            sessions_data,
            inv_priv_data,
            trade_priv_data,
            age_group_data,
            verified_age_data,
            voice_data,
        ) = await asyncio.gather(*tasks)

        # === Parse settings/json (MeowTool-style one-shot) ===
        is_premium = False
        can_trade = False
        email_set = False
        email_verified = False
        has_2fa = False
        has_pin = False
        above_13 = False
        account_age_days = 0

        if isinstance(settings_data, dict):
            is_premium = bool(settings_data.get("IsPremium"))
            can_trade = bool(settings_data.get("CanTrade"))
            above_13 = bool(settings_data.get("UserAbove13"))
            account_age_days = int(settings_data.get("AccountAgeInDays") or 0)
            sec = settings_data.get("MyAccountSecurityModel") or {}
            email_set = bool(sec.get("IsEmailSet"))
            email_verified = bool(sec.get("IsEmailVerified"))
            has_2fa = bool(sec.get("IsTwoStepEnabled"))
            has_pin = bool(settings_data.get("IsAccountPinEnabled"))

        # details
        created_date = ""
        description = ""
        is_banned = False
        if isinstance(details, dict):
            created_date = str(details.get("created") or "")
            description = str(details.get("description") or "")
            is_banned = bool(details.get("isBanned") or False)

        # avatar
        avatar_image = None
        try:
            if isinstance(avatar_data, dict) and avatar_data.get("data"):
                avatar_image = avatar_data["data"][0].get("imageUrl")
        except Exception:
            avatar_image = None

        # robux
        robux_balance = 0
        if isinstance(currency, dict):
            robux_balance = int(currency.get("robux") or 0)

        billing_credit = 0
        if isinstance(billing, dict):
            billing_credit = int(billing.get("robuxAmount") or 0)

        pending_robux = 0
        donate_year = 0
        if isinstance(totals, dict):
            pending_robux = int(totals.get("pendingRobuxTotal") or 0)
            donate_year = int(totals.get("salesTotal") or 0)

        # MeowTool: payment-profiles for card count
        cards_count = 0
        has_card = False
        if isinstance(payment_profiles, list):
            cards_count = len(payment_profiles)
            has_card = cards_count > 0
        elif isinstance(payment_profiles, dict):
            has_card = bool(payment_profiles)

        # country
        country_code = ""
        if isinstance(country_data, dict):
            country_code = str(country_data.get("countryCode") or "")

        # social counts
        friends_count = int(friends.get("count") or 0) if isinstance(friends, dict) else 0
        followers_count = int(followers.get("count") or 0) if isinstance(followers, dict) else 0
        followings_count = int(followings.get("count") or 0) if isinstance(followings, dict) else 0

        # groups
        groups_count = 0
        owned_groups = 0
        groups_members = 0
        groups_funds = 0
        groups_pending = 0
        groups_list: List[Dict[str, Any]] = []
        owned_group_ids: List[int] = []

        if isinstance(groups_roles, dict) and isinstance(groups_roles.get("data"), list):
            groups_data = groups_roles.get("data") or []
            groups_count = len(groups_data)
            for g in groups_data:
                group_info = (g or {}).get("group") or {}
                role = (g or {}).get("role") or {}
                groups_members += int(group_info.get("memberCount") or 0)
                if int(role.get("rank") or 0) == 255:
                    owned_groups += 1
                    gid = int(group_info.get("id") or 0)
                    if gid:
                        owned_group_ids.append(gid)
                        groups_list.append({
                            "id": gid,
                            "name": str(group_info.get("name") or ""),
                            "members": int(group_info.get("memberCount") or 0),
                        })

        # owned group funds/pending (ограничиваем, чтобы не висло)
        owned_group_ids = owned_group_ids[:10]
        async def _group_currency(gid: int):
            return await _aio_get_json(session, f"https://economy.roblox.com/v1/groups/{gid}/currency", headers=headers, allow_roproxy=True)
        async def _group_pending(gid: int):
            return await _aio_get_json(session, f"https://economy.roblox.com/v1/groups/{gid}/revenue/summary/year", headers=headers, allow_roproxy=True)

        if owned_group_ids:
            cur_tasks = [_group_currency(gid) for gid in owned_group_ids]
            pend_tasks = [_group_pending(gid) for gid in owned_group_ids]
            cur_res = await asyncio.gather(*cur_tasks)
            pend_res = await asyncio.gather(*pend_tasks)
            for j in cur_res:
                if isinstance(j, dict):
                    groups_funds += int(j.get("robux") or 0)
            for j in pend_res:
                if isinstance(j, dict):
                    groups_pending += int(j.get("pendingRobux") or 0)

        # gamepasses count - from games list
        gamepasses_count = 0

        # badges count
        badges_count = 0
        if isinstance(badges_data, dict) and isinstance(badges_data.get("data"), list):
            badges_count = len(badges_data.get("data") or [])

        # roblox badges (official)
        roblox_badges = []
        if isinstance(roblox_badges_data, list):
            roblox_badges = [str(b.get("name") or "") for b in roblox_badges_data if isinstance(b, dict) and b.get("name")]

        # games created + visits
        games_count = 0
        total_visits = 0
        if isinstance(games_data, dict) and isinstance(games_data.get("data"), list):
            games_list = games_data.get("data") or []
            games_count = len(games_list)
            for game in games_list:
                if isinstance(game, dict):
                    total_visits += int(game.get("placeVisits") or 0)

        # phone (MeowTool: accountinformation)
        phone_verified = False
        phone_value = None
        if isinstance(phone_data, dict):
            phone_value = str(phone_data.get("phone") or "") or None
            phone_verified = bool(phone_value)

        # MeowTool: inventory privacy from user-settings-api
        inventory_privacy = "Unknown"
        if isinstance(inv_priv_data, dict):
            inv_val = inv_priv_data.get("whoCanSeeMyInventory", {})
            if isinstance(inv_val, dict):
                inventory_privacy = str(inv_val.get("currentValue") or "Unknown")
            else:
                inventory_privacy = str(inv_priv_data.get("inventoryPrivacy") or "Unknown")

        trade_privacy = "Unknown"
        if isinstance(trade_priv_data, dict):
            trade_privacy = str(trade_priv_data.get("tradePrivacy") or "Unknown")

        # MeowTool: sessions via token-metadata-service
        sessions_count = 0
        if isinstance(sessions_data, dict) and isinstance(sessions_data.get("sessions"), list):
            sessions_count = len(sessions_data.get("sessions") or [])
        elif isinstance(sessions_data, list):
            sessions_count = len(sessions_data)

        # MeowTool: age group
        age_group = None
        if isinstance(age_group_data, dict):
            age_key = str(age_group_data.get("ageGroupTranslationKey") or "")
            if "Under13" in age_key:
                age_group = "<13"
            elif "Over13" in age_key and "Under18" not in age_key:
                age_group = "13+"
            elif "Under18" in age_key:
                age_group = "13-17"
            elif "Over18" in age_key:
                age_group = "18+"

        # MeowTool: verified age
        verified_age = False
        if isinstance(verified_age_data, dict):
            verified_age = bool(verified_age_data.get("isVerified"))

        # MeowTool: voice verified
        voice_verified = False
        if isinstance(voice_data, dict):
            voice_verified = bool(voice_data.get("isVerifiedForVoice"))

        # collectibles (RAP) — MeowTool style
        collectibles_count = 0
        total_rap = 0
        try:
            # Use the initial parallel fetch as first page
            coll = collectibles_data
            cursor = ""
            loops = 0
            while True:
                loops += 1
                if loops > 1:
                    url = f"https://inventory.roblox.com/v1/users/{user_id}/assets/collectibles?sortOrder=Desc&limit=100"
                    if cursor:
                        url += f"&cursor={cursor}"
                    coll = await _aio_get_json(session, url, headers=headers, allow_roproxy=True)
                if not isinstance(coll, dict):
                    break
                items = coll.get("data") or []
                if not isinstance(items, list):
                    break
                collectibles_count += len(items)
                for item in items:
                    if isinstance(item, dict):
                        total_rap += int(item.get("recentAveragePrice") or 0)
                cursor = coll.get("nextPageCursor")
                if not cursor or collectibles_count >= 500 or loops >= 6:
                    break
        except Exception:
            pass

        # masked
        masked_email = None
        if email_set:
            masked_email = "***@***"
        masked_phone = None
        if phone_value and len(phone_value) > 4:
            masked_phone = phone_value[:4] + "***"

        data = {
            "status": "valid",
            "user": {
                "id": user_id,
                "username": username,
                "display_name": display_name,
                "description": description[:300] if description else "",
                "created": created_date,
                "account_age_days": account_age_days,
                "is_banned": is_banned,
                "avatar_url": avatar_image,
                "country": country_code,
                "age_group": age_group,
                "above_13": above_13,
                "verified_age": verified_age,
                "voice_verified": voice_verified,
                "roblox_badges": roblox_badges,
            },
            "robux": {
                "balance": robux_balance,
                "pending": pending_robux,
                "billing_credit": billing_credit,
                "is_premium": is_premium,
            },
            "transactions": {
                "donate_year": donate_year,
            },
            "social": {
                "friends": friends_count,
                "followers": followers_count,
                "followings": followings_count,
            },
            "inventory": {
                "collectibles_count": collectibles_count,
                "collectibles_rap": total_rap,
                "has_card": has_card,
                "cards_count": cards_count,
                "gamepasses": gamepasses_count,
            },
            "groups": {
                "total_groups": groups_count,
                "owned_groups": owned_groups,
                "groups_members": groups_members,
                "groups_funds": groups_funds,
                "groups_pending": groups_pending,
                "groups_list": groups_list[:5],
            },
            "games": {
                "created_games": games_count,
                "total_visits": total_visits,
            },
            "badges": {
                "count": badges_count,
            },
            "security": {
                "email_set": email_set,
                "email_verified": email_verified,
                "email": masked_email,
                "phone_verified": phone_verified,
                "phone": masked_phone,
                "has_2fa": has_2fa,
                "has_pin": has_pin,
                "sessions": sessions_count,
            },
            "privacy": {
                "inventory": inventory_privacy,
                "trade": trade_privacy,
                "can_trade": can_trade,
            },
        }

        try:
            _COOKIE_CHECK_CACHE[cookie_key] = {"ts": now_ts, "data": data}
        except Exception:
            pass
        return data


# --- internal helpers for cookie checker (used by MeowTool-like flow) ---
_COOKIE_CHECK_CACHE: Dict[str, Dict[str, Any]] = {}

async def _aio_get_json(session, url: str, headers: Optional[Dict[str, str]] = None, allow_roproxy: bool = True, return_status: bool = False):
    """GET -> json with safe fallbacks. Never raises; returns dict/list/None."""
    urls = [url]
    if allow_roproxy and ".roblox.com" in url:
        urls.append(url.replace(".roblox.com", ".roproxy.com"))

    last_status = None
    for u in urls:
        try:
            # MeowTool style: don't follow redirects (302 = invalid/banned)
            async with session.get(u, headers=headers, allow_redirects=False) as resp:
                last_status = resp.status
                if resp.status == 302:
                    # 302 -> invalid cookie or banned
                    if return_status:
                        return {"_status": 302}
                    return {}
                if resp.status == 204:
                    data = {}
                else:
                    try:
                        data = await resp.json(content_type=None)
                    except Exception:
                        data = {}
                if return_status:
                    if isinstance(data, dict):
                        data["_status"] = resp.status
                    else:
                        data = {"_status": resp.status, "data": data}
                if 200 <= resp.status < 300:
                    return data
        except Exception:
            continue

    if return_status:
        return {"_status": last_status or 0}
    return {}


def _check_roblox_cookie_requests(cookie: str) -> Dict[str, Any]:
    """Fallback реализация (если aiohttp недоступен)."""
    headers = {
        "Cookie": f".ROBLOSECURITY={cookie}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    try:
        user_resp = requests.get("https://users.roblox.com/v1/users/authenticated", headers=headers, timeout=10)
        if user_resp.status_code != 200:
            return {"error": "Куки недействительны или истекли", "status": "invalid"}
        user_data = user_resp.json()
        user_id = int(user_data.get("id") or 0)
        if not user_id:
            return {"error": "Не удалось получить информацию о пользователе", "status": "invalid"}
        # Минимальный набор, чтобы UI не ломался
        robux_balance = 0
        try:
            bal = requests.get("https://economy.roblox.com/v1/users/currency", headers=headers, timeout=10)
            if bal.status_code == 200:
                robux_balance = int(bal.json().get("robux") or 0)
        except Exception:
            pass

        return {
            "status": "valid",
            "user": {"id": user_id, "username": user_data.get("name"), "display_name": user_data.get("displayName") or user_data.get("name"), "avatar_url": None, "account_age_days": 0, "roblox_badges": []},
            "robux": {"balance": robux_balance, "pending": 0, "billing_credit": 0, "is_premium": False},
            "transactions": {"donate_year": 0},
            "social": {"friends": 0, "followers": 0, "followings": 0},
            "inventory": {"collectibles_count": 0, "collectibles_rap": 0, "has_card": False, "cards_count": 0, "gamepasses": 0},
            "groups": {"total_groups": 0, "owned_groups": 0, "groups_members": 0, "groups_funds": 0, "groups_pending": 0, "groups_list": []},
            "games": {"created_games": 0, "total_visits": 0},
            "badges": {"count": 0},
            "security": {"email_set": False, "email_verified": False, "email": None, "phone_verified": False, "phone": None, "has_2fa": False, "has_pin": False, "sessions": 0},
            "privacy": {"inventory": "Unknown", "trade": "Unknown", "can_trade": False},
        }
    except Exception as e:
        return {"error": f"Ошибка при проверке: {str(e)}", "status": "error"}



# ====== NOTIFICATION API ENDPOINTS ======

@app.get("/api/notifications")
def api_notifications_list(request: Request, limit: int = 30):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Unauthorized")
    con = db_conn()
    try:
        rows = con.execute(
            "SELECT id, user_id, text, created_at, is_read FROM user_notifications WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (u["id"], limit)
        ).fetchall()
        items = []
        for r in rows:
            txt = _rget(r, "text") or ""
            if "|" in txt:
                parts = txt.split("|", 1)
                title, message = parts[0].strip(), parts[1].strip()
            else:
                title, message = "Уведомление", txt
            items.append({
                "id": _rget(r, "id"),
                "title": title,
                "message": message,
                "read": bool(_rget(r, "is_read")),
                "created_at": _rget(r, "created_at"),
            })
        return {"notifications": items}
    finally:
        try: con.close()
        except: pass


@app.get("/api/notifications/unread_count")
def api_notifications_unread(request: Request):
    u = get_current_user(request)
    if not u:
        return {"count": 0}
    con = db_conn()
    try:
        row = con.execute(
            "SELECT COUNT(*) as cnt FROM user_notifications WHERE user_id=? AND is_read=0",
            (u["id"],)
        ).fetchone()
        return {"count": _rget(row, "cnt") or 0}
    finally:
        try: con.close()
        except: pass


@app.post("/api/notifications/read")
def api_notifications_mark_read(request: Request, payload: Dict[str, Any] = Body(...)):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Unauthorized")
    nid = payload.get("id")
    if not nid:
        raise HTTPException(status_code=400, detail="Missing id")
    con = db_conn()
    try:
        con.execute("UPDATE user_notifications SET is_read=1 WHERE id=? AND user_id=?", (nid, u["id"]))
        con.commit()
        return {"ok": True}
    finally:
        try: con.close()
        except: pass


@app.post("/api/notifications/read_all")
def api_notifications_mark_all_read(request: Request, payload: Dict[str, Any] = Body(...)):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Unauthorized")
    con = db_conn()
    try:
        con.execute("UPDATE user_notifications SET is_read=1 WHERE user_id=? AND is_read=0", (u["id"],))
        con.commit()
        return {"ok": True}
    finally:
        try: con.close()
        except: pass


@app.post("/api/admin/notifications/send")
def api_admin_notifications_send(request: Request, payload: Dict[str, Any] = Body(...)):
    u = get_current_user(request)
    if not u or not _rget(u, "is_admin"):
        raise HTTPException(status_code=403, detail="Admin only")
    target = payload.get("target", "all")
    title = (payload.get("title") or "").strip()
    message = (payload.get("message") or "").strip()
    user_id_str = (payload.get("user_id") or "").strip()
    if not title or not message:
        raise HTTPException(status_code=400, detail="Title and message required")
    text = f"{title}|{message}"
    now = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    try:
        if target == "user" and user_id_str:
            row = con.execute(
                "SELECT id FROM users WHERE username=? OR CAST(id AS TEXT)=?",
                (user_id_str, user_id_str)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="User not found")
            uid = _rget(row, "id")
            con.execute(
                "INSERT INTO user_notifications(user_id, text, created_at, is_read) VALUES(?,?,?,0)",
                (uid, text, now)
            )
        else:
            users = con.execute("SELECT id FROM users", ()).fetchall()
            for ur in users:
                uid = _rget(ur, "id")
                con.execute(
                    "INSERT INTO user_notifications(user_id, text, created_at, is_read) VALUES(?,?,?,0)",
                    (uid, text, now)
                )
        con.commit()
        return {"ok": True, "message": "Notification sent"}
    finally:
        try: con.close()
        except: pass
@app.post("/api/reviews/report")
def api_reviews_report(request: Request, payload: Dict[str, Any] = Body(...)):
    """Report a review — saves to review_reports table for admin complaints view."""
    u = require_user(request)
    review_id = int(payload.get("id") or 0)
    reason = str(payload.get("reason") or "Spam/Abuse").strip()[:200]
    if not review_id:
        raise HTTPException(status_code=400, detail="id required")
    con = db_conn()
    row = con.execute(
        "SELECT r.id, r.user_id, r.text, r.rating, u.username FROM reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.id=?",
        (review_id,)
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Отзыв не найден")
    if str(_rget(row, "user_id")) == str(u["id"]):
        con.close()
        raise HTTPException(status_code=400, detail="Нельзя жаловаться на свой отзыв")
    # Check duplicate report
    existing = con.execute(
        "SELECT id FROM review_reports WHERE review_id=? AND reporter_id=? AND status='pending'",
        (review_id, int(u["id"]))
    ).fetchone()
    if existing:
        con.close()
        return {"ok": True, "message": "Жалоба уже отправлена"}
    # Save complaint
    con.execute(
        "INSERT INTO review_reports(review_id, reporter_id, reporter_username, reported_user_id, reported_username, review_text, review_rating, reason, status, created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)",
        (review_id, int(u["id"]), str(u.get("username","")), int(_rget(row,"user_id") or 0),
         str(_rget(row,"username") or ""), str(_rget(row,"text") or "")[:500],
         int(_rget(row,"rating") or 0), reason, _now_utc_iso())
    )
    con.commit()
    con.close()
    _log.info("[REPORT] User %s reported review %s: %s", u["id"], review_id, reason)
    return {"ok": True, "message": "Жалоба принята. Модератор рассмотрит её в ближайшее время."}

@app.get("/api/my/complaints")
def api_my_complaints(request: Request):
    """Get current user's submitted complaints."""
    u = require_user(request)
    con = db_conn()
    rows = con.execute(
        "SELECT id, review_id, reported_username, review_text, reason, status, created_at FROM review_reports WHERE reporter_id=? ORDER BY id DESC LIMIT 50",
        (int(u["id"]),)
    ).fetchall()
    con.close()
    result = [{"id": _rget(r,"id"), "review_id": _rget(r,"review_id"), "reported_username": _rget(r,"reported_username"),
               "review_text": _rget(r,"review_text"), "reason": _rget(r,"reason"), "status": _rget(r,"status"), "created_at": _rget(r,"created_at")} for r in rows]
    return {"ok": True, "complaints": result}


    """Simple AI content moderation. Returns 'ok' or 'manual'."""
    t = text.lower().strip()
    # Check for URLs
    import re as _re
    if _re.search(r'https?://|www\.|\.com|\.ru|\.net|\.org|t\.me|vk\.com|discord\.gg', t):
        return "manual"
    # Check for common Russian profanity roots
    bad_roots = ["хуй","хуя","хуе","пизд","блят","блядь","ебат","ебан","ёбан","сука","сук ","нахуй",
                 "пидор","пидар","мудак","мудил","дерьм","жоп","залуп","шлюх","тварь","гандон",
                 "fuck","shit","bitch","dick","ass","porn","nsfw","18+","xxx","sex"]
    for root in bad_roots:
        if root in t:
            return "manual"
    # Check for advertising patterns
    ad_patterns = ["купи","скидк","промо","бесплатн","заработ","казино","ставк",
                   "telegram","телеграм","подпис","канал","чат ","инвест"]
    ad_count = sum(1 for p in ad_patterns if p in t)
    if ad_count >= 2:
        return "manual"
    return "ok"



@app.post("/api/support/upload")
async def api_support_upload(request: Request, file: UploadFile = File(...)):
    """Upload attachment for support ticket. Stored as base64 in site_kv to avoid disk usage."""
    u = require_user(request)
    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Файл слишком большой (макс. 50 МБ)")
    ext = (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename else ""
    allowed = {"png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "avi", "mkv", "webm", "pdf", "txt", "log", "zip"}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Формат не поддерживается. Разрешены: фото, видео, PDF, ZIP")
    import base64
    b64 = base64.b64encode(data).decode()
    mime = file.content_type or f"application/octet-stream"
    key = f"support_file:{int(u['id'])}:{_now_utc_iso().replace(':','-')}:{file.filename or 'file'}"
    con = db_conn()
    try:
        con.execute("INSERT INTO site_kv(key, value) VALUES(?, ?)", (key, json.dumps({"mime": mime, "name": file.filename, "size": len(data), "data": b64})))
        con.commit()
    except Exception:
        con.close()
        raise HTTPException(status_code=500, detail="Ошибка сохранения файла")
    con.close()
    return {"ok": True, "url": f"/api/support/file?key={key}", "name": file.filename, "size": len(data)}

@app.get("/api/support/file")
def api_support_file(request: Request, key: str = ""):
    if not key.startswith("support_file:"):
        raise HTTPException(status_code=400, detail="Invalid key")
    con = db_conn()
    row = con.execute("SELECT value FROM site_kv WHERE key=?", (key,)).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    import base64
    info = json.loads(_rget(row, "value") or "{}")
    data = base64.b64decode(info.get("data", ""))
    mime = info.get("mime", "application/octet-stream")
    from starlette.responses import Response
    return Response(content=data, media_type=mime, headers={"Content-Disposition": f'inline; filename="{info.get("name","file")}"'})

# ============================================
# LEGAL PAGES (required by payment systems)
# ============================================

@app.get("/terms", response_class=HTMLResponse)
def page_terms(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "terms"})

@app.get("/privacy", response_class=HTMLResponse)
def page_privacy(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "privacy"})

@app.get("/agreement", response_class=HTMLResponse)
def page_agreement(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "agreement"})

@app.get("/refund", response_class=HTMLResponse)
def page_refund(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "refund"})

@app.get("/contacts", response_class=HTMLResponse)
def page_contacts(request: Request):
    return templates.TemplateResponse("legal.html", {"request": request, "page": "contacts"})

# ============================================
# ADMIN STATS DASHBOARD
# ============================================

@app.get("/api/admin/stats")
def api_admin_stats(request: Request):
    require_admin(request)
    con = db_conn()
    stats = {}
    try:
        stats["total_users"] = _count_val(con.execute("SELECT COUNT(*) as c FROM users").fetchone(), "c")
        week_ago = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).isoformat()
        stats["new_users_7d"] = _count_val(con.execute("SELECT COUNT(*) as c FROM users WHERE created_at > ?", (week_ago,)).fetchone(), "c")
        r = con.execute("SELECT COALESCE(SUM(balance),0) as s FROM users").fetchone()
        stats["total_balance"] = int(_rget(r, "s") or 0) if r else 0
        try:
            stats["pending_topups"] = _count_val(con.execute("SELECT COUNT(*) as c FROM topups WHERE status='pending'").fetchone(), "c")
            r = con.execute("SELECT COALESCE(SUM(fiat_cents),0) as s FROM topups WHERE status='paid'").fetchone()
            stats["paid_revenue"] = round(int(_rget(r, "s") or 0) / 100, 0) if r else 0
        except Exception:
            stats["pending_topups"] = 0
            stats["paid_revenue"] = 0
        try:
            stats["active_orders"] = _count_val(con.execute("SELECT COUNT(*) as c FROM robux_orders WHERE status NOT IN ('done','cancelled','error')").fetchone(), "c")
            stats["done_orders"] = _count_val(con.execute("SELECT COUNT(*) as c FROM robux_orders WHERE status='done'").fetchone(), "c")
        except Exception:
            stats["active_orders"] = 0
            stats["done_orders"] = 0
        try:
            stats["premium_users"] = _count_val(con.execute("SELECT COUNT(*) as c FROM users WHERE premium_until IS NOT NULL AND premium_until > ?", (datetime.datetime.utcnow().isoformat(),)).fetchone(), "c")
        except Exception:
            stats["premium_users"] = 0
        try:
            stats["promo_codes"] = _count_val(con.execute("SELECT COUNT(*) as c FROM promo_codes").fetchone(), "c")
        except Exception:
            stats["promo_codes"] = 0
    except Exception as e:
        stats["error"] = str(e)
    con.close()
    return stats

@app.post("/api/admin/stats/reset")
def api_admin_stats_reset(request: Request, payload: Dict[str, Any] = Body(...)):
    """Reset admin statistics counters with period selection"""
    require_admin(request)
    period = str(payload.get("period") or "all").strip()
    con = db_conn()
    try:
        now = datetime.datetime.utcnow()
        date_from = None
        date_to = None

        if period == "7d":
            date_from = (now - datetime.timedelta(days=7)).isoformat()
        elif period == "30d":
            date_from = (now - datetime.timedelta(days=30)).isoformat()
        elif period == "90d":
            date_from = (now - datetime.timedelta(days=90)).isoformat()
        elif period == "custom":
            date_from = str(payload.get("from") or "")
            date_to = str(payload.get("to") or "")
            if date_to:
                date_to = date_to + "T23:59:59"

        if period == "all":
            # Full reset — wipe all completed transactions/stats
            try: con.execute("UPDATE robux_orders SET status='archived' WHERE status='done'")
            except: pass
            try: con.execute("DELETE FROM topups WHERE status='paid'")
            except: pass
            try: con.execute("DELETE FROM balance_tx WHERE delta != 0")
            except: pass
        else:
            # Period reset
            conditions = []
            params = []
            if date_from:
                conditions.append("created_at >= ?")
                params.append(date_from)
            if date_to:
                conditions.append("created_at <= ?")
                params.append(date_to)
            where = " AND ".join(conditions) if conditions else "1=1"
            try: con.execute(f"UPDATE robux_orders SET status='archived' WHERE status='done' AND {where}", tuple(params))
            except: pass
            try: con.execute(f"DELETE FROM topups WHERE status='paid' AND {where}", tuple(params))
            except: pass
            try: con.execute(f"DELETE FROM balance_tx WHERE {where}", tuple(params))
            except: pass

        con.commit()
    except Exception as e:
        con.close()
        raise HTTPException(status_code=500, detail=str(e)[:200])
    con.close()
    return {"ok": True, "message": "Статистика сброшена"}

# ============================================
# EMAIL TEST (admin)
# ============================================

@app.get("/api/admin/email_test")
def api_admin_email_test(request: Request):
    u = require_admin(request)
    email = u.get("email") or ""
    if not email:
        raise HTTPException(status_code=400, detail="Your account has no email set")
    try:
        send_brevo_email(email, "Тест Email — RBX ST", "Email работает!", _email_html("Email работает! ✅", "<p style='color:#a8a0c0;font-size:15px'>Если вы получили это письмо — Brevo настроен правильно и письма доходят до пользователей.</p>"))
        return {"ok": True, "sent_to": email}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.get("/api/health")
def api_health():
    return {"ok": True}

# --- Maintenance mode ---
@app.get("/api/admin/debug/balance_column")
def api_admin_debug_balance_column(request: Request):
    """Check if balance column exists and add if missing."""
    require_admin(request)
    if USE_PG:
        con = db_conn()
        try:
            con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0")
            con.commit()
        except Exception:
            pass
        row = con.execute("SELECT count(*) as n FROM users").fetchone()
        n = int(_rget(row, 'n') or 0)
        sample = con.execute("SELECT id, username, balance FROM users ORDER BY id LIMIT 5").fetchall()
        con.close()
        return {"ok": True, "db": "postgres", "user_count": n, "sample": [dict(r) for r in sample]}
    else:
        con = db_conn()
        cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
        had_balance = "balance" in cols
        if not had_balance:
            con.execute("ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0")
            con.commit()
        row = con.execute("SELECT count(*) as n FROM users").fetchone()
        n = int(row["n"] or 0) if row else 0
        sample = con.execute("SELECT id, username, balance FROM users ORDER BY id LIMIT 5").fetchall()
        con.close()
        return {"ok": True, "db": "sqlite", "had_balance_column": had_balance, "user_count": n, "sample": [dict(r) for r in sample]}


@app.get("/api/admin/storage_info")
def api_admin_storage_info(request: Request):
    """Admin: check where DB is stored and if /data is a real persistent mount."""
    require_admin(request)
    import subprocess, shutil
    db_exists = os.path.isfile(DB_PATH)
    db_size = os.path.getsize(DB_PATH) if db_exists else 0

    # Check mount
    is_mounted = False
    mounts = ""
    try:
        mounts = subprocess.check_output(["mount"], text=True, stderr=subprocess.DEVNULL)
        is_mounted = any("/data" in line for line in mounts.splitlines())
    except Exception:
        pass

    # Disk free
    disk_free = ""
    try:
        st = shutil.disk_usage(os.path.dirname(DB_PATH))
        disk_free = f"{st.free // 1024 // 1024} MB free / {st.total // 1024 // 1024} MB total"
    except Exception:
        pass

    return {
        "ok": True,
        "db_path": DB_PATH,
        "db_exists": db_exists,
        "db_size_bytes": db_size,
        "db_size_kb": round(db_size / 1024, 1),
        "use_postgres": USE_PG,
        "data_is_mounted_volume": is_mounted,
        "disk": disk_free,
        "warning": (
            None if USE_PG or is_mounted else
            "⚠️ /data is NOT a mounted volume! Data will be lost on redeploy. "
            "Go to Railway Dashboard → your service → Volumes → Add Volume → mount at /data"
        )
    }


@app.get("/api/admin/debug/user")
def api_admin_debug_user(request: Request, uid: int = 0):
    """Admin debug: show raw DB state for a user."""
    require_admin(request)
    if not uid:
        u = get_current_user(request)
        uid = int(u["id"]) if u else 0
    if not uid:
        raise HTTPException(status_code=400, detail="uid required")
    con = db_conn()
    row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    kv = con.execute("SELECT key, length(value) as val_len FROM site_kv WHERE key LIKE ?", (f"avatar:{uid}",)).fetchone()
    txs = con.execute("SELECT delta, reason, ts FROM balance_tx WHERE user_id=? ORDER BY id DESC LIMIT 5", (uid,)).fetchall()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "ok": True,
        "user": dict(row),
        "avatar_in_kv": bool(kv),
        "avatar_kv_bytes": int(_rget(kv, "val_len") or 0) if kv else 0,
        "recent_tx": [dict(t) for t in txs],
    }


@app.get("/api/site/status")
def api_site_status(request: Request):
    is_admin = False
    try:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            data = read_token(token)
            if data:
                uid = int(data.get("uid", 0) or 0)
                uname = str(data.get("username", "") or "").lower()
                if uid == 1 or uname in ADMIN_USERS_LC:
                    is_admin = True
                else:
                    con = db_conn()
                    row = con.execute("SELECT is_admin FROM users WHERE id=?", (uid,)).fetchone()
                    con.close()
                    if row and int(_rget(row, "is_admin") or 0) == 1:
                        is_admin = True
    except Exception:
        pass
    return {"ok": True, "maintenance": bool(_SITE_SETTINGS.get("maintenance")), "maintenance_msg": _SITE_SETTINGS.get("maintenance_msg", ""), "is_admin": is_admin}

@app.post("/api/admin/maintenance")
def api_admin_maintenance(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    _SITE_SETTINGS["maintenance"] = bool(payload.get("enabled", False))
    _SITE_SETTINGS["maintenance_msg"] = str(payload.get("message", "Сайт на техническом обслуживании"))[:500]
    _save_site_settings()
    return {"ok": True, "maintenance": _SITE_SETTINGS["maintenance"]}

# --- v2 banners (news/promos on home page) ---
_DEFAULT_BANNERS = [
    {"id": "bn_robux", "tag": "Розыгрыш", "title": "Robux дёшево\nкаждый день", "color": "linear-gradient(135deg,#7c2d12,#dc2626 50%,#fbbf24)", "image_url": "", "link": ""},
    {"id": "bn_prem", "tag": "Новое", "title": "Premium-аккаунты\nв наличии", "color": "linear-gradient(135deg,#1e3a8a,#7c3aed 50%,#ec4899)", "image_url": "", "link": ""},
    {"id": "bn_gp", "tag": "−15%", "title": "Game Pass\nлюбой игры", "color": "linear-gradient(135deg,#064e3b,#10b981 50%,#22d3ee)", "image_url": "", "link": ""},
    {"id": "bn_gift", "tag": "Хит", "title": "Подарочные\nкарты Roblox", "color": "linear-gradient(135deg,#581c87,#a855f7 50%,#ec4899)", "image_url": "", "link": ""},
    {"id": "bn_acc", "tag": "Топ", "title": "Взрослые\nаккаунты 13+", "color": "linear-gradient(135deg,#0c4a6e,#0284c7 50%,#22d3ee)", "image_url": "", "link": ""},
]

@app.get("/api/banners")
def api_banners_get():
    """Public: returns banner list for the home page."""
    try:
        con = db_conn()
        row = con.execute("SELECT value FROM site_kv WHERE key='v2_banners'").fetchone()
        con.close()
        if row:
            try:
                arr = json.loads(_rget(row, "value") or "[]")
                if isinstance(arr, list) and arr:
                    return {"banners": arr}
            except Exception:
                pass
    except Exception:
        pass
    return {"banners": _DEFAULT_BANNERS}

@app.post("/api/admin/banners")
def api_admin_banners_set(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    banners = payload.get("banners")
    if not isinstance(banners, list):
        raise HTTPException(status_code=400, detail="banners must be a list")
    # Sanitize
    out = []
    for b in banners[:20]:
        if not isinstance(b, dict):
            continue
        out.append({
            "id": str(b.get("id") or "bn_" + str(int(time.time() * 1000)))[:60],
            "tag": str(b.get("tag") or "")[:32],
            "title": str(b.get("title") or "")[:160],
            "color": str(b.get("color") or "")[:300],
            "image_url": str(b.get("image_url") or "")[:500],
            "link": str(b.get("link") or "")[:200],
        })
    val = json.dumps(out, ensure_ascii=False)
    con = db_conn()
    if USE_PG:
        con.execute("INSERT INTO site_kv(key,value) VALUES('v2_banners',?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", (val,))
    else:
        con.execute("INSERT OR REPLACE INTO site_kv(key,value) VALUES('v2_banners',?)", (val,))
    con.commit()
    con.close()
    return {"ok": True, "banners": out}

# --- Support Tickets ---
@app.post("/api/support/create")
def api_support_create(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    uid = int(u["id"])
    subject = str(payload.get("subject", "")).strip()[:200]
    text = str(payload.get("text", "")).strip()[:2000]
    VALID_CATS = {"refund", "account", "feature", "bug", "other", "robux", "payment", "shop"}
    category = str(payload.get("category", "other")).strip()
    if category not in VALID_CATS:
        category = "other"
    if not subject or not text:
        raise HTTPException(status_code=400, detail="Заполните тему и сообщение")
    ts = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    cur = con.cursor()
    cur.execute("INSERT INTO support_tickets(user_id,subject,category,status,created_at,updated_at) VALUES(?,?,?,?,?,?)", (uid, subject, category, "open", ts, ts))
    tid = cur.lastrowid
    # Support multiple attachments: store as JSON array
    attachment_urls = payload.get("attachment_urls")
    single_url = str(payload.get("attachment_url") or "")[:500]
    if attachment_urls and isinstance(attachment_urls, list):
        # filter valid URLs
        urls = [str(u)[:500] for u in attachment_urls if u][:5]
        attachment_str = json.dumps(urls) if urls else single_url or None
    else:
        attachment_str = single_url or None
    cur.execute("INSERT INTO support_messages(ticket_id,sender_id,is_admin,text,created_at,attachment_url) VALUES(?,?,?,?,?,?)", (tid, uid, 0, text, ts, attachment_str))
    con.commit()
    con.close()
    return {"ok": True, "ticket_id": tid}

@app.get("/api/support/list")
def api_support_list(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    rows = con.execute("SELECT id, subject, category, status, created_at, updated_at FROM support_tickets WHERE user_id=? ORDER BY id DESC LIMIT 50", (uid,)).fetchall()
    con.close()
    return {"ok": True, "tickets": [dict(r) for r in rows]}

@app.get("/api/support/messages")
def api_support_messages(request: Request, ticket_id: int = 0):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    ticket = con.execute("SELECT id, user_id, subject, status FROM support_tickets WHERE id=?", (ticket_id,)).fetchone()
    if not ticket:
        con.close()
        raise HTTPException(status_code=404, detail="Ticket not found")
    is_admin_user = int(_rget(con.execute("SELECT is_admin FROM users WHERE id=?", (uid,)).fetchone(), "is_admin") or 0) == 1 or uid == 1
    if int(ticket["user_id"]) != uid and not is_admin_user:
        con.close()
        raise HTTPException(status_code=403, detail="Access denied")
    msgs = con.execute("SELECT id, sender_id, is_admin, text, created_at, attachment_url FROM support_messages WHERE ticket_id=? ORDER BY id", (ticket_id,)).fetchall()
    con.close()
    def _parse_msg(m):
        d = dict(m)
        url_str = d.get("attachment_url") or ""
        # Try to parse as JSON array
        urls = []
        if url_str:
            try:
                parsed = json.loads(url_str)
                if isinstance(parsed, list):
                    urls = [str(x) for x in parsed if x]
                else:
                    urls = [url_str]
            except Exception:
                urls = [url_str]
        d["attachment_urls"] = urls
        return d
    return {"ok": True, "ticket": dict(ticket), "messages": [_parse_msg(m) for m in msgs]}

@app.post("/api/support/reply")
def api_support_reply(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    uid = int(u["id"])
    tid = int(payload.get("ticket_id", 0))
    text = str(payload.get("text", "")).strip()[:2000]
    if not text:
        raise HTTPException(status_code=400, detail="Сообщение не может быть пустым")
    con = db_conn()
    ticket = con.execute("SELECT id, user_id, status FROM support_tickets WHERE id=?", (tid,)).fetchone()
    if not ticket:
        con.close()
        raise HTTPException(status_code=404, detail="Ticket not found")
    is_admin_user = int(_rget(con.execute("SELECT is_admin FROM users WHERE id=?", (uid,)).fetchone(), "is_admin") or 0) == 1 or uid == 1
    if int(ticket["user_id"]) != uid and not is_admin_user:
        con.close()
        raise HTTPException(status_code=403, detail="Access denied")
    ts = datetime.datetime.utcnow().isoformat()
    attachment = str(payload.get("attachment_url") or "")[:500]
    con.execute("INSERT INTO support_messages(ticket_id,sender_id,is_admin,text,created_at,attachment_url) VALUES(?,?,?,?,?,?)", (tid, uid, 1 if is_admin_user else 0, text, ts, attachment or None))
    con.execute("UPDATE support_tickets SET updated_at=?, status='open' WHERE id=?", (ts, tid))
    con.commit()
    con.close()
    return {"ok": True}

@app.post("/api/admin/support/close")
def api_admin_support_close(request: Request, payload: Dict[str, Any] = Body(...)):
    require_admin(request)
    tid = int(payload.get("ticket_id", 0))
    ts = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    con.execute("UPDATE support_tickets SET status='closed', updated_at=? WHERE id=?", (ts, tid))
    con.commit()
    con.close()
    return {"ok": True}

@app.post("/api/support/cancel")
def api_support_cancel(request: Request, payload: Dict[str, Any] = Body(...)):
    """Allow user to close/cancel their own ticket."""
    u = require_user(request)
    uid = int(u["id"])
    tid = int(payload.get("ticket_id", 0))
    ts = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    ticket = con.execute("SELECT id, user_id, status FROM support_tickets WHERE id=?", (tid,)).fetchone()
    if not ticket:
        con.close()
        raise HTTPException(status_code=404, detail="Ticket not found")
    if int(ticket["user_id"]) != uid:
        con.close()
        raise HTTPException(status_code=403, detail="Access denied")
    con.execute("UPDATE support_tickets SET status='closed', updated_at=? WHERE id=?", (ts, tid))
    con.commit()
    con.close()
    return {"ok": True}

@app.get("/api/user/settings")
def api_user_settings_get(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    row = con.execute(
        "SELECT notif_newsletter, notif_site, ui_language, ui_currency, ui_balance_short FROM users WHERE id=?",
        (uid,)
    ).fetchone()
    con.close()
    if not row:
        return {"ok": True, "settings": {}}
    return {"ok": True, "settings": {
        "notif_newsletter": int(_rget(row, "notif_newsletter") or 1),
        "notif_site": int(_rget(row, "notif_site") or 1),
        "ui_language": str(_rget(row, "ui_language") or "ru"),
        "ui_currency": str(_rget(row, "ui_currency") or "rub"),
        "ui_balance_short": int(_rget(row, "ui_balance_short") or 0),
    }}

@app.post("/api/user/settings")
def api_user_settings_save(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    uid = int(u["id"])
    allowed_langs = {"ru", "en"}
    allowed_currencies = {"rub", "usd"}
    con = db_conn()
    fields = {}
    if "notif_newsletter" in payload:
        fields["notif_newsletter"] = 1 if payload["notif_newsletter"] else 0
    if "notif_site" in payload:
        fields["notif_site"] = 1 if payload["notif_site"] else 0
    if "ui_language" in payload and payload["ui_language"] in allowed_langs:
        fields["ui_language"] = payload["ui_language"]
    if "ui_currency" in payload and payload["ui_currency"] in allowed_currencies:
        fields["ui_currency"] = payload["ui_currency"]
    if "ui_balance_short" in payload:
        fields["ui_balance_short"] = 1 if payload["ui_balance_short"] else 0
    if fields:
        set_clause = ", ".join(f"{k}=?" for k in fields)
        con.execute(f"UPDATE users SET {set_clause} WHERE id=?", list(fields.values()) + [uid])
        con.commit()
    con.close()
    return {"ok": True}

@app.get("/api/admin/support/list")
def api_admin_support_list(request: Request, status: str = "open"):
    require_admin(request)
    con = db_conn()
    rows = con.execute("""
        SELECT t.id, t.user_id, t.subject, t.category, t.status, t.created_at, t.updated_at, u.username
        FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id
        WHERE t.status=? ORDER BY t.updated_at DESC LIMIT 100
    """, (status,)).fetchall()
    con.close()
    return {"ok": True, "tickets": [dict(r) for r in rows]}


# --- Bot API (patched for main.py entrypoint) ---
BOT_API_SECRET = (os.environ.get("BOT_API_SECRET") or os.environ.get("API_SECRET") or "").strip()

def _bot_get_secret(request: Request) -> str:
    return str(request.headers.get("X-API-SECRET") or request.headers.get("x-api-secret") or request.headers.get("Authorization") or "").replace("Bearer ", "").strip()

def _bot_require_secret(request: Request) -> None:
    expected = (BOT_API_SECRET or "").strip()
    provided = _bot_get_secret(request)
    if not expected:
        raise HTTPException(status_code=503, detail="BOT_API_SECRET is not configured")
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=403, detail="Forbidden")

def _telegram_link_code_hash(code: str) -> str:
    normalized = re.sub(r"\s+", "", str(code or "").strip().upper())
    return hmac.new(SECRET_KEY.encode("utf-8"), normalized.encode("utf-8"), hashlib.sha256).hexdigest()

def _telegram_link_profile_dict(row) -> Dict[str, Any]:
    return {
        "id": int(_rget(row, "id") or 0),
        "username": str(_rget(row, "username") or ""),
        "email": str(_rget(row, "email") or ""),
        "balance": int(_rget(row, "balance") or 0),
        "is_admin": int(_rget(row, "is_admin") or 0),
        "avatar_url": str(_rget(row, "avatar_url") or ""),
    }

class _BotSiteRequest:
    def __init__(self, user: Dict[str, Any]):
        self.cookies = {SESSION_COOKIE: make_token(int(user["id"]), str(user.get("username") or ""))}
        self.headers = {}
        self.client = None

def _bot_site_request(user: Dict[str, Any]) -> _BotSiteRequest:
    return _BotSiteRequest(user)

def _bot_user_from_request(request: Request, require_exists: bool = True) -> Optional[Dict[str, Any]]:
    _bot_require_secret(request)
    qp = request.query_params
    def _as_int(v: Any) -> int:
        try:
            return int(str(v or "0").strip())
        except Exception:
            return 0
    site_user_id = 0
    for key in ("site_user_id", "user_id", "uid", "id"):
        site_user_id = _as_int(qp.get(key))
        if site_user_id > 0:
            break
    con = db_conn()
    try:
        if site_user_id > 0:
            row = con.execute(
                "SELECT id, username, email, balance, is_admin, premium_until, avatar_url FROM users WHERE id=?",
                (int(site_user_id),),
            ).fetchone()
            if not row:
                if require_exists:
                    raise HTTPException(status_code=404, detail="User not found")
                return None
            return {
                "id": int(_rget(row, "id") or 0),
                "username": str(_rget(row, "username") or ""),
                "email": str(_rget(row, "email") or ""),
                "balance": int(_rget(row, "balance") or 0),
                "is_admin": int(_rget(row, "is_admin") or 0),
                "premium_until": str(_rget(row, "premium_until") or "") or None,
                "avatar_url": str(_rget(row, "avatar_url") or ""),
            }
        telegram_id = 0
        for key in ("telegram_id", "tg_id"):
            telegram_id = _as_int(qp.get(key))
            if telegram_id > 0:
                break
        if telegram_id > 0:
            link = con.execute(
                "SELECT user_id FROM telegram_links WHERE telegram_id=? ORDER BY id DESC LIMIT 1",
                (int(telegram_id),),
            ).fetchone()
            if link:
                uid = int(_rget(link, "user_id") or 0)
                row = con.execute(
                    "SELECT id, username, email, balance, is_admin, premium_until, avatar_url FROM users WHERE id=?",
                    (uid,),
                ).fetchone()
                if row:
                    return {
                        "id": int(_rget(row, "id") or 0),
                        "username": str(_rget(row, "username") or ""),
                        "email": str(_rget(row, "email") or ""),
                        "balance": int(_rget(row, "balance") or 0),
                        "is_admin": int(_rget(row, "is_admin") or 0),
                        "premium_until": str(_rget(row, "premium_until") or "") or None,
                        "avatar_url": str(_rget(row, "avatar_url") or ""),
                    }
        if require_exists:
            raise HTTPException(status_code=400, detail="site_user_id or linked telegram_id required")
        return None
    finally:
        con.close()

def _bot_require_admin(request: Request) -> Dict[str, Any]:
    u = _bot_user_from_request(request, require_exists=True)
    is_admin = int(u.get("is_admin") or 0) == 1 or int(u.get("id") or 0) == 1 or (str(u.get("username") or "").lower() in ADMIN_USERS_LC)
    if not is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return u

@app.post("/api/user/telegram/link_code")
def api_user_telegram_link_code(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    now = _now_utc()
    expires = now + datetime.timedelta(minutes=10)
    con = db_conn()
    try:
        con.execute("UPDATE telegram_link_codes SET used_at=? WHERE user_id=? AND used_at IS NULL", (now.isoformat(), uid))
        code = ""
        for _ in range(8):
            candidate = f"{secrets.randbelow(1000000):06d}"
            code_hash = _telegram_link_code_hash(candidate)
            exists = con.execute("SELECT id FROM telegram_link_codes WHERE code_hash=? LIMIT 1", (code_hash,)).fetchone()
            if exists:
                continue
            code = candidate
            con.execute(
                "INSERT INTO telegram_link_codes(user_id, code_hash, expires_at, used_at, created_at) VALUES(?,?,?,?,?)",
                (uid, code_hash, expires.isoformat(), None, now.isoformat()),
            )
            con.commit()
            break
        if not code:
            raise HTTPException(status_code=500, detail="Could not generate link code")
        return {"ok": True, "code": code, "expires_at": expires.isoformat(), "ttl_seconds": 600}
    finally:
        con.close()

@app.get("/api/bot/health")
def api_bot_health(request: Request):
    _bot_require_secret(request)
    return {"ok": True, "build": BUILD_VERSION, "ts": _now_utc_iso()}

@app.get("/api/bot/profile")
def api_bot_profile(request: Request):
    u = _bot_user_from_request(request, require_exists=True)
    lim = user_limits(int(u["id"]))
    return {"ok": True, "user": {
        "id": int(u["id"]),
        "username": str(u.get("username") or ""),
        "email": str(u.get("email") or ""),
        "balance": int(u.get("balance") or 0),
        "is_admin": 1 if (int(u.get("is_admin") or 0) == 1 or int(u.get("id") or 0) == 1) else 0,
        "avatar_url": str(u.get("avatar_url") or ""),
        "premium_until": lim.get("premium_until"),
        "premium": bool(lim.get("premium")),
        "limits": lim,
    }}

@app.get("/api/bot/balance")
def api_bot_balance(request: Request):
    u = _bot_user_from_request(request, require_exists=True)
    return {"ok": True, "balance": int(u.get("balance") or 0), "user_id": int(u["id"])}

@app.get("/api/bot/robux/stock")
def api_bot_robux_stock(request: Request):
    _bot_require_secret(request)
    return api_robux_stock()

@app.get("/api/bot/robux/quote")
def api_bot_robux_quote(request: Request, amount: int = 0, robux_amount: int = 0):
    _bot_require_secret(request)
    return api_robux_quote(request, amount=amount, robux_amount=robux_amount)

@app.get("/api/bot/robux/orders")
def api_bot_robux_orders(request: Request, limit: int = 20):
    u = _bot_user_from_request(request, require_exists=True)
    uid = int(u["id"])
    limit = max(1, min(int(limit or 20), 100))
    con = db_conn()
    try:
        _robux_expire_overdue(con)
        rows = con.execute(
            "SELECT id, robux_amount, rub_price, status, created_at, reserve_expires_ts, done_ts, error_message FROM robux_orders WHERE user_id=? AND status!='new' ORDER BY id DESC LIMIT ?",
            (uid, limit),
        ).fetchall() or []
        items = []
        for r in rows:
            items.append({
                "id": int(_rget(r, "id") or 0),
                "robux_amount": int(_rget(r, "robux_amount") or 0),
                "rub_price": int(_rget(r, "rub_price") or 0),
                "status": str(_rget(r, "status") or ""),
                "created_at": str(_rget(r, "created_at") or ""),
                "reserve_expires_ts": int(_rget(r, "reserve_expires_ts") or 0),
                "done_ts": int(_rget(r, "done_ts") or 0),
                "error": str(_rget(r, "error_message") or ""),
            })
        return {"ok": True, "items": items, "server_now_ts": _now_ts()}
    finally:
        con.close()

@app.post("/api/bot/robux/inspect")
def api_bot_robux_inspect(request: Request, payload: Dict[str, Any] = Body(...)):
    _bot_user_from_request(request, require_exists=True)
    return api_robux_inspect(request, payload)

@app.post("/api/bot/robux/order_create")
def api_bot_robux_order_create(request: Request, payload: Dict[str, Any] = Body(...)):
    u = _bot_user_from_request(request, require_exists=True)
    return api_robux_order_create(_bot_site_request(u), payload)

@app.post("/api/bot/robux/order_reserve")
def api_bot_robux_order_reserve(request: Request, payload: Dict[str, Any] = Body(...)):
    u = _bot_user_from_request(request, require_exists=True)
    return api_robux_order_reserve(_bot_site_request(u), payload)

@app.post("/api/bot/robux/order_pay")
def api_bot_robux_order_pay(request: Request, payload: Dict[str, Any] = Body(...)):
    u = _bot_user_from_request(request, require_exists=True)
    return api_robux_order_pay(_bot_site_request(u), payload)

@app.post("/api/bot/robux/order_cancel")
def api_bot_robux_order_cancel(request: Request, payload: Dict[str, Any] = Body(...)):
    u = _bot_user_from_request(request, require_exists=True)
    return api_robux_order_cancel(_bot_site_request(u), payload)

@app.get("/api/bot/robux/order")
def api_bot_robux_order(request: Request, id: int):
    u = _bot_user_from_request(request, require_exists=True)
    return api_robux_order(_bot_site_request(u), id=id)

@app.get("/api/bot/shop/catalog")
def api_bot_shop_catalog(request: Request):
    _bot_require_secret(request)
    cfg = _shop_cfg_get() or {}
    items = cfg.get("items") or []
    normalized = []
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized.append({
            "id": str(item.get("id") or ""),
            "title": str(item.get("title") or item.get("name") or ""),
            "price": float(item.get("price") or item.get("price_rub") or 0),
            "type": str(item.get("type") or item.get("item_type") or "digital"),
            "category": str(item.get("category") or ""),
            "description": str(item.get("description") or ""),
            "stock": int(item.get("stock") or 0) if str(item.get("stock") or "").strip() else None,
            "raw": item,
        })
    return {"ok": True, "items": normalized, "config": cfg}

@app.get("/api/bot/shop/orders")
def api_bot_shop_orders(request: Request, limit: int = 20):
    u = _bot_user_from_request(request, require_exists=True)
    uid = int(u["id"])
    limit = max(1, min(int(limit or 20), 100))
    con = db_conn()
    try:
        rows = con.execute(
            "SELECT id, product_id, product_title, price_rub, discount_amount, discount_code, delivery_text, status, created_at FROM shop_orders WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (uid, limit),
        ).fetchall() or []
        orders = []
        for r in rows:
            orders.append({
                "id": int(_rget(r, "id") or 0),
                "product_id": str(_rget(r, "product_id") or ""),
                "product_title": str(_rget(r, "product_title") or ""),
                "price_rub": float(_rget(r, "price_rub") or 0),
                "discount_amount": float(_rget(r, "discount_amount") or 0),
                "discount_code": str(_rget(r, "discount_code") or ""),
                "delivery_text": str(_rget(r, "delivery_text") or ""),
                "status": str(_rget(r, "status") or "done"),
                "created_at": str(_rget(r, "created_at") or ""),
            })
        return {"ok": True, "orders": orders}
    finally:
        con.close()

@app.post("/api/bot/telegram/link")
def api_bot_telegram_link(request: Request, payload: Dict[str, Any] = Body(...)):
    _bot_require_secret(request)
    site_user_id = int(payload.get("site_user_id") or payload.get("user_id") or payload.get("uid") or 0)
    telegram_id = int(payload.get("telegram_id") or payload.get("tg_id") or 0)
    username = str(payload.get("telegram_username") or payload.get("username") or "")[:128]
    if not site_user_id or not telegram_id:
        raise HTTPException(status_code=400, detail="site_user_id and telegram_id required")
    con = db_conn()
    try:
        user = con.execute("SELECT id FROM users WHERE id=?", (site_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        now = _now_utc_iso()
        con.execute("DELETE FROM telegram_links WHERE telegram_id=?", (telegram_id,))
        con.execute(
            "INSERT INTO telegram_links(user_id, telegram_id, telegram_username, created_at, updated_at) VALUES(?,?,?,?,?)",
            (site_user_id, telegram_id, username or None, now, now),
        )
        con.commit()
        return {"ok": True, "site_user_id": site_user_id, "telegram_id": telegram_id}
    finally:
        con.close()

@app.get("/api/bot/telegram/link")
def api_bot_telegram_link_get(request: Request):
    _bot_require_secret(request)
    qp = request.query_params
    telegram_id = int(qp.get("telegram_id") or qp.get("tg_id") or 0)
    site_user_id = int(qp.get("site_user_id") or qp.get("user_id") or qp.get("uid") or 0)
    con = db_conn()
    try:
        if telegram_id > 0:
            row = con.execute("SELECT user_id, telegram_id, telegram_username, created_at, updated_at FROM telegram_links WHERE telegram_id=? ORDER BY id DESC LIMIT 1", (telegram_id,)).fetchone()
        elif site_user_id > 0:
            row = con.execute("SELECT user_id, telegram_id, telegram_username, created_at, updated_at FROM telegram_links WHERE user_id=? ORDER BY id DESC LIMIT 1", (site_user_id,)).fetchone()
        else:
            raise HTTPException(status_code=400, detail="telegram_id or site_user_id required")
        if not row:
            return {"ok": True, "link": None}
        return {"ok": True, "link": {
            "user_id": int(_rget(row, "user_id") or 0),
            "telegram_id": int(_rget(row, "telegram_id") or 0),
            "telegram_username": str(_rget(row, "telegram_username") or ""),
            "created_at": str(_rget(row, "created_at") or ""),
            "updated_at": str(_rget(row, "updated_at") or ""),
        }}
    finally:
        con.close()

@app.post("/api/bot/telegram/link/confirm")
def api_bot_telegram_link_confirm(request: Request, payload: Dict[str, Any] = Body(...)):
    _bot_require_secret(request)
    code = re.sub(r"\s+", "", str(payload.get("code") or "").strip().upper())
    telegram_id = int(payload.get("telegram_id") or payload.get("tg_id") or 0)
    username = str(payload.get("telegram_username") or payload.get("username") or "")[:128]
    if not code:
        raise HTTPException(status_code=400, detail="code required")
    if telegram_id <= 0:
        raise HTTPException(status_code=400, detail="telegram_id required")

    code_hash = _telegram_link_code_hash(code)
    now = _now_utc()
    con = db_conn()
    try:
        row = con.execute(
            "SELECT id, user_id, expires_at, used_at FROM telegram_link_codes WHERE code_hash=? ORDER BY id DESC LIMIT 1",
            (code_hash,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Link code not found")
        if str(_rget(row, "used_at") or ""):
            raise HTTPException(status_code=400, detail="Link code already used")
        expires_at = _parse_iso(str(_rget(row, "expires_at") or ""))
        if not expires_at or now > expires_at:
            raise HTTPException(status_code=400, detail="Link code expired")

        site_user_id = int(_rget(row, "user_id") or 0)
        user = con.execute("SELECT id, username, email, balance, is_admin, avatar_url FROM users WHERE id=?", (site_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        ts = now.isoformat()
        con.execute("DELETE FROM telegram_links WHERE telegram_id=? OR user_id=?", (telegram_id, site_user_id))
        con.execute(
            "INSERT INTO telegram_links(user_id, telegram_id, telegram_username, created_at, updated_at) VALUES(?,?,?,?,?)",
            (site_user_id, telegram_id, username or None, ts, ts),
        )
        con.execute("UPDATE telegram_link_codes SET used_at=? WHERE id=?", (ts, int(_rget(row, "id") or 0)))
        con.commit()
        return {"ok": True, "site_user_id": site_user_id, "telegram_id": telegram_id, "user": _telegram_link_profile_dict(user)}
    finally:
        con.close()

@app.get("/api/bot/admin/robux/settings")
def api_bot_admin_robux_settings(request: Request):
    _bot_require_admin(request)
    cfg = _robux_cfg_effective()
    avail = api_robux_stock()
    return {"ok": True, "settings": {
        "min_amount": int(cfg.get("min_amount") or 0),
        "rub_per_robux": float(cfg.get("rub_per_robux") or 0),
        "gp_factor": float(cfg.get("gp_factor") or 0),
        "stock_show": int(cfg.get("stock_show") or 0),
        "stock_sell": int(cfg.get("stock_sell") or 0),
        "reserve_seconds": int(cfg.get("reserve_seconds") or 0),
    }, "stock": avail}

@app.post("/api/bot/admin/robux/settings")
def api_bot_admin_robux_settings_set(request: Request, payload: Dict[str, Any] = Body(...)):
    admin = _bot_require_admin(request)
    return api_admin_robux_settings_set(_bot_site_request(admin), payload)

@app.get("/api/bot/admin/orders/recent")
def api_bot_admin_recent_orders(request: Request, limit: int = 20):
    _bot_require_admin(request)
    limit = max(1, min(int(limit or 20), 100))
    con = db_conn()
    try:
        robux_rows = con.execute("SELECT id, user_id, robux_amount, rub_price, status, created_at FROM robux_orders ORDER BY id DESC LIMIT ?", (limit,)).fetchall() or []
        shop_rows = con.execute("SELECT id, user_id, product_id, product_title, price_rub, status, created_at FROM shop_orders ORDER BY id DESC LIMIT ?", (limit,)).fetchall() or []
        items = []
        for r in robux_rows:
            items.append({"kind": "robux", "id": int(_rget(r, "id") or 0), "user_id": int(_rget(r, "user_id") or 0), "title": f"Robux {_rget(r, 'robux_amount') or 0}", "amount": int(_rget(r, "rub_price") or 0), "status": str(_rget(r, "status") or ""), "created_at": str(_rget(r, "created_at") or "")})
        for r in shop_rows:
            items.append({"kind": "shop", "id": int(_rget(r, "id") or 0), "user_id": int(_rget(r, "user_id") or 0), "title": str(_rget(r, "product_title") or _rget(r, "product_id") or ""), "amount": float(_rget(r, "price_rub") or 0), "status": str(_rget(r, "status") or ""), "created_at": str(_rget(r, "created_at") or "")})
        items.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        return {"ok": True, "items": items[:limit]}
    finally:
        con.close()

@app.get("/api/bot/admin/users/find")
def api_bot_admin_users_find(request: Request, q: str = "", limit: int = 20):
    _bot_require_admin(request)
    qq = (q or "").strip()
    if not qq:
        return {"ok": True, "items": []}
    limit = max(1, min(int(limit or 20), 50))
    like = f"%{qq.lower()}%"
    con = db_conn()
    try:
        rows = con.execute("SELECT id, username, email, balance, is_admin FROM users WHERE lower(username) LIKE ? OR lower(COALESCE(email,'')) LIKE ? ORDER BY id DESC LIMIT ?", (like, like, limit)).fetchall() or []
        items = []
        for r in rows:
            items.append({"id": int(_rget(r, "id") or 0), "username": str(_rget(r, "username") or ""), "email": str(_rget(r, "email") or ""), "balance": int(_rget(r, "balance") or 0), "is_admin": int(_rget(r, "is_admin") or 0)})
        return {"ok": True, "items": items}
    finally:
        con.close()

@app.post("/api/bot/admin/balance_adjust")
def api_bot_admin_balance_adjust(request: Request, payload: Dict[str, Any] = Body(...)):
    admin = _bot_require_admin(request)
    return admin_balance_adjust(_bot_site_request(admin), payload)



# --- Robux vouchers ---

def _robux_voucher_make_code(length: int = 10) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "RBX-" + "".join(secrets.choice(alphabet) for _ in range(max(6, int(length))))


def _robux_voucher_effective_rub_value(robux_amount: int, explicit_rub_value: int = 0) -> int:
    if int(explicit_rub_value or 0) > 0:
        return int(explicit_rub_value)
    try:
        q = robux_calc(int(robux_amount or 0))
        return int(q.get("rub_price") or 0)
    except Exception:
        return 0


def _robux_voucher_row_to_dict(row) -> Dict[str, Any]:
    return {
        "id": int(_rget(row, "id") or 0),
        "code": str(_rget(row, "code") or ""),
        "robux_amount": int(_rget(row, "robux_amount") or 0),
        "rub_value": int(_rget(row, "rub_value") or 0),
        "uses_total": int(_rget(row, "uses_total") or 0),
        "uses_left": int(_rget(row, "uses_left") or 0),
        "created_by": int(_rget(row, "created_by") or 0) if _rget(row, "created_by") is not None else None,
        "note": str(_rget(row, "note") or ""),
        "source": str(_rget(row, "source") or ""),
        "source_ref": str(_rget(row, "source_ref") or ""),
        "expires_at": str(_rget(row, "expires_at") or ""),
        "created_at": str(_rget(row, "created_at") or ""),
    }


def _api_admin_create_robux_voucher_logic(*, admin_user_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    robux_amount = int(payload.get("robux_amount") or payload.get("amount") or 0)
    uses_total = max(1, min(int(payload.get("uses_total") or 1), 100000))
    note = str(payload.get("note") or "")[:500]
    code = str(payload.get("code") or "").strip().upper()
    expires_at = str(payload.get("expires_at") or "").strip() or None
    rub_value = int(payload.get("rub_value") or 0)
    source = str(payload.get("source") or "manual").strip()[:64]
    source_ref = str(payload.get("source_ref") or "").strip()[:128]
    if robux_amount <= 0:
        raise HTTPException(status_code=400, detail="robux_amount required")
    if not code:
        code = _robux_voucher_make_code()
    rub_value = _robux_voucher_effective_rub_value(robux_amount, rub_value)
    ts = _now_utc_iso()
    con = db_conn()
    try:
        if USE_PG:
            row = con.execute(
                "INSERT INTO robux_vouchers(code,robux_amount,rub_value,uses_total,uses_left,created_by,note,source,source_ref,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                (code, robux_amount, rub_value, uses_total, uses_total, admin_user_id or None, note or None, source or None, source_ref or None, expires_at, ts),
            ).fetchone()
            vid = int(_rget(row, "id") or 0)
        else:
            cur = con.execute(
                "INSERT INTO robux_vouchers(code,robux_amount,rub_value,uses_total,uses_left,created_by,note,source,source_ref,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (code, robux_amount, rub_value, uses_total, uses_total, admin_user_id or None, note or None, source or None, source_ref or None, expires_at, ts),
            )
            vid = int(cur.lastrowid)
        con.commit()
        row = con.execute("SELECT * FROM robux_vouchers WHERE id=?", (vid,)).fetchone()
        return {"ok": True, "voucher": _robux_voucher_row_to_dict(row)}
    except Exception as e:
        try:
            con.rollback()
        except Exception:
            pass
        msg = str(e).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(status_code=409, detail="Voucher code already exists")
        raise
    finally:
        con.close()


def _robux_voucher_claim_core(code: str, uid: int) -> Dict[str, Any]:
    code = str(code or "").strip().upper()
    if not code:
        raise HTTPException(status_code=400, detail="Voucher code required")
    con = db_conn()
    try:
        row = con.execute("SELECT * FROM robux_vouchers WHERE code=?", (code,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Ваучер не найден")
        vid = int(_rget(row, "id") or 0)
        uses_left = int(_rget(row, "uses_left") or 0)
        expires_at = str(_rget(row, "expires_at") or "")
        if uses_left <= 0:
            raise HTTPException(status_code=400, detail="Ваучер уже использован")
        if expires_at:
            try:
                if datetime.datetime.fromisoformat(expires_at.replace('Z','+00:00')).replace(tzinfo=None) < datetime.datetime.utcnow():
                    raise HTTPException(status_code=400, detail="Срок действия ваучера истёк")
            except HTTPException:
                raise
            except Exception:
                pass
        prev = con.execute("SELECT id FROM robux_voucher_uses WHERE voucher_id=? AND user_id=? LIMIT 1", (vid, int(uid))).fetchone()
        if prev:
            raise HTTPException(status_code=400, detail="Вы уже активировали этот ваучер")
        rub_value = int(_rget(row, "rub_value") or 0)
        robux_amount = int(_rget(row, "robux_amount") or 0)
        if rub_value <= 0:
            rub_value = _robux_voucher_effective_rub_value(robux_amount, 0)
        ts = _now_utc_iso()
        # Decrement uses atomically enough for current traffic profile.
        if USE_PG:
            updated = con.execute("UPDATE robux_vouchers SET uses_left=uses_left-1 WHERE id=? AND uses_left>0 RETURNING uses_left", (vid,)).fetchone()
            if not updated:
                raise HTTPException(status_code=400, detail="Ваучер больше недоступен")
        else:
            cur = con.execute("UPDATE robux_vouchers SET uses_left=uses_left-1 WHERE id=? AND uses_left>0", (vid,))
            if int(getattr(cur, 'rowcount', 0) or 0) <= 0:
                raise HTTPException(status_code=400, detail="Ваучер больше недоступен")
        new_balance = _credit_balance_direct(con, int(uid), int(rub_value), f"robux voucher {code}")
        con.execute("INSERT INTO robux_voucher_uses(voucher_id,user_id,credited_balance,used_at) VALUES(?,?,?,?)", (vid, int(uid), int(rub_value), ts))
        con.commit()
        row2 = con.execute("SELECT * FROM robux_vouchers WHERE id=?", (vid,)).fetchone()
        return {
            "ok": True,
            "voucher": _robux_voucher_row_to_dict(row2),
            "credited_balance": int(rub_value),
            "robux_amount": int(robux_amount),
            "balance": int(new_balance),
            "message": f"Ваучер активирован. На баланс зачислено {int(rub_value)} ₽ для покупки {int(robux_amount)} Robux."
        }
    finally:
        con.close()


@app.post("/api/admin/robux/voucher/create")
def api_admin_robux_voucher_create(request: Request, payload: Dict[str, Any] = Body(...)):
    admin = require_admin(request)
    return _api_admin_create_robux_voucher_logic(admin_user_id=int(admin["id"]), payload=payload)


@app.get("/api/admin/robux/vouchers")
def api_admin_robux_vouchers(request: Request, limit: int = 100):
    require_admin(request)
    limit = max(1, min(int(limit or 100), 500))
    con = db_conn()
    try:
        rows = con.execute("SELECT * FROM robux_vouchers ORDER BY id DESC LIMIT ?", (limit,)).fetchall() or []
        return {"ok": True, "items": [_robux_voucher_row_to_dict(r) for r in rows]}
    finally:
        con.close()


@app.delete("/api/admin/robux/voucher/{voucher_id}")
def api_admin_robux_voucher_delete(request: Request, voucher_id: int):
    require_admin(request)
    con = db_conn()
    try:
        con.execute("DELETE FROM robux_vouchers WHERE id=?", (int(voucher_id),))
        con.commit()
        return {"ok": True}
    finally:
        con.close()


@app.post("/api/robux/voucher/claim")
def api_robux_voucher_claim(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    code = str(payload.get("code") or "").strip()
    return _robux_voucher_claim_core(code, int(u["id"]))



@app.post("/api/bot/robux/voucher/claim")
def api_bot_robux_voucher_claim(request: Request, payload: Dict[str, Any] = Body(...)):
    u = _bot_user_from_request(request, require_exists=True)
    code = str(payload.get("code") or "").strip()
    return _robux_voucher_claim_core(code, int(u["id"]))

@app.post("/api/bot/admin/robux/voucher/create")
def api_bot_admin_robux_voucher_create(request: Request, payload: Dict[str, Any] = Body(...)):
    admin = _bot_require_admin(request)
    return _api_admin_create_robux_voucher_logic(admin_user_id=int(admin["id"]), payload=payload)

@app.get("/api/bot/admin/robux/vouchers")
def api_bot_admin_robux_vouchers(request: Request, limit: int = 100):
    _bot_require_admin(request)
    limit = max(1, min(int(limit or 100), 500))
    con = db_conn()
    try:
        rows = con.execute("SELECT * FROM robux_vouchers ORDER BY id DESC LIMIT ?", (limit,)).fetchall() or []
        return {"ok": True, "items": [_robux_voucher_row_to_dict(r) for r in rows]}
    finally:
        con.close()

# ============================================
# SUPPORT AI CHAT ENDPOINTS
# ============================================

@app.get("/api/support/ai_history")
def api_support_ai_history(request: Request, limit: int = 40):
    """Get current user's AI chat history for persistence."""
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    rows = con.execute(
        "SELECT role, content, ts FROM support_ai_chats WHERE user_id=? ORDER BY id DESC LIMIT ?",
        (uid, min(int(limit), 80))
    ).fetchall()
    con.close()
    msgs = [{"role": r["role"], "content": r["content"], "ts": r["ts"]} for r in reversed(rows)]
    return {"ok": True, "messages": msgs}


@app.post("/api/support/ai_chat")
def api_support_ai_chat(request: Request, payload: Dict[str, Any] = Body(...)):
    """AI support chat — saves history to DB, no credits required."""
    u = require_user(request)
    uid = int(u["id"])
    message = str(payload.get("message", "") or "").strip()[:2000]
    history = payload.get("history", []) or []
    if not message:
        raise HTTPException(status_code=400, detail="Сообщение пустое")

    # Detect escalation keywords
    escalation_kw = ["оператор", "человек", "админ", "позови", "позвать", "позовите", "свяжи", "свяжите",
                     "живой", "менеджер", "support human", "real person", "operator", "agent"]
    wants_human = any(kw in message.lower() for kw in escalation_kw)

    system = (
        "Ты дружелюбный ИИ-ассистент RBX ST — магазина на сайте rbx-st.win.\n"
        "ЯЗЫК: Отвечай ТОЛЬКО по-русски.\n\n"
        "ФОРМАТ ОТВЕТОВ (СТРОГО):\n"
        "- Каждую мысль пиши ОТДЕЛЬНЫМ абзацем, между абзацами — пустая строка (два переноса \\n\\n)\n"
        "- НЕ пиши всё одним сплошным блоком — это ЗАПРЕЩЕНО\n"
        "- Длинные предложения разбивай на 2-3 коротких\n"
        "- В каждый абзац добавляй 1 подходящий эмодзи в КОНЦЕ предложения\n"
        "- При перечислении используй маркеры: • пункт\n"
        "- Максимум 3-5 абзацев на ответ, не больше\n\n"
        "ИНФОРМАЦИЯ О САЙТЕ RBX ST (rbx-st.win):\n"
        "• Покупка Robux: раздел «Robux» → вводишь ник Roblox → выбираешь количество → оплата с баланса. Доставка через геймпасс, обычно 5–30 секунд, максимум до 15 минут 💎\n"
        "• Пополнение баланса: через CryptoBot (USDT, TON, BTC и другие криптовалюты), также можно через промокод 💰\n"
        "• Premium-подписка: 109₽ за 50 дней. Даёт безлимит AI-функций, приоритетную поддержку, расширенные возможности ⭐\n"
        "• Магазин: цифровые товары, аккаунты, услуги. Оплата с баланса. Есть промокоды на скидку 🛒\n"
        "• Кейсы: бесплатный кейс каждые 48 часов (нужна капча), платный 17₽ без ограничений. Призы начисляются в инвентарь 🎁\n"
        "• Аккаунт: регистрация по email + OTP-код. Есть 2FA через email в настройках профиля 🔐\n"
        "• Robux могут быть на холде (ожидание Roblox) до 5 дней, но обычно приходят за секунды. Если >15 мин — писать в поддержку с номером заказа ⏱\n"
        "• Поддержка: Telegram @E6JLAHOC или тикет через кнопку поддержки на сайте 📞\n"
        "• Домен сайта: rbx-st.win\n\n"
        "ПРАВИЛА:\n"
        "- Если вопрос не связан с RBX ST — вежливо откажи\n"
        "- Если пользователь хочет оператора — скажи что переключишь и добавь в конец: [ESCALATE]\n"
        "- Не придумывай функции которых нет на сайте\n"
    )

    # Build messages list for context
    msgs_for_ai = []
    for h in history[-10:]:
        role = h.get("role", "user")
        if role in ("user", "assistant"):
            msgs_for_ai.append({"role": role, "content": str(h.get("content", ""))[:1000]})
    msgs_for_ai.append({"role": "user", "content": message})

    # Call AI
    _ai_errors = []
    try:
        # Build context string for provider_chat
        context_str = ""
        for m in msgs_for_ai[:-1]:
            prefix = "Пользователь" if m["role"] == "user" else "Ассистент"
            context_str += f"{prefix}: {m['content']}\n"
        full_user = (context_str + f"Пользователь: {message}") if context_str else message

        # Try Groq first (fast Llama), then Perplexity, then Pollinations
        groq_key = os.environ.get("GROQ_API_KEY", "")
        pplx_key = os.environ.get("PERPLEXITY_API_KEY", "")

        response = None

        # Provider 1: Groq
        if groq_key and not response:
            try:
                response = groq_chat(api_key=groq_key, model="llama-3.3-70b-versatile", system=system, user=full_user, temperature=0.7, max_tokens=600)
                if not response or len(response.strip()) < 3:
                    _ai_errors.append("groq:empty")
                    response = None
            except Exception as e:
                _ai_errors.append(f"groq:{str(e)[:100]}")
                response = None
        elif not groq_key:
            _ai_errors.append("groq:GROQ_API_KEY not set")

        # Provider 2: Perplexity
        if pplx_key and not response:
            try:
                response = perplexity_chat(api_key=pplx_key, model="sonar", system=system, user=full_user, temperature=0.7, max_tokens=600)
                if not response or len(response.strip()) < 3:
                    _ai_errors.append("perplexity:empty")
                    response = None
            except Exception as e:
                _ai_errors.append(f"perplexity:{str(e)[:100]}")
                response = None

        # Provider 3: Pollinations (free fallback)
        if not response:
            try:
                response = pollinations_chat(model="openai", system=system, user=full_user, temperature=0.8, max_tokens=600)
                if not response or len(response.strip()) < 3:
                    _ai_errors.append("pollinations:empty")
                    response = None
            except Exception as e:
                _ai_errors.append(f"pollinations:{str(e)[:100]}")
                response = None

        if not response:
            response = f"❌ AI провайдеры недоступны.\n\n🔍 Ошибки:\n" + "\n".join(f"• {e}" for e in _ai_errors) + "\n\nНапишите в Telegram @E6JLAHOC"

    except Exception as ex:
        response = f"❌ Критическая ошибка AI: {str(ex)[:200]}\n\nНапишите в Telegram @E6JLAHOC"
        _ai_errors.append(f"critical:{str(ex)[:100]}")

    if _ai_errors:
        print(f"[AI_SUPPORT_CHAT] errors: {'; '.join(_ai_errors)}", flush=True)

    escalated = "[ESCALATE]" in response or wants_human
    clean_response = response.replace("[ESCALATE]", "").strip()

    # Save to DB
    ts = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    con.execute("INSERT INTO support_ai_chats(user_id, role, content, ts, escalated) VALUES(?,?,?,?,?)",
                (uid, "user", message, ts, 0))
    con.execute("INSERT INTO support_ai_chats(user_id, role, content, ts, escalated) VALUES(?,?,?,?,?)",
                (uid, "assistant", clean_response, ts, 1 if escalated else 0))
    con.commit()
    con.close()

    return {"ok": True, "response": clean_response, "escalated": escalated}


@app.get("/api/admin/support/ai_chats")
def api_admin_ai_chats(request: Request, user_id: int = 0, limit: int = 50):
    """Admin: get AI chat history for a user or all recent."""
    require_admin(request)
    con = db_conn()
    if user_id:
        rows = con.execute(
            "SELECT c.id, c.user_id, c.role, c.content, c.ts, c.escalated, u.username "
            "FROM support_ai_chats c LEFT JOIN users u ON u.id=c.user_id "
            "WHERE c.user_id=? ORDER BY c.id DESC LIMIT ?",
            (user_id, limit)
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT c.id, c.user_id, c.role, c.content, c.ts, c.escalated, u.username "
            "FROM support_ai_chats c LEFT JOIN users u ON u.id=c.user_id "
            "ORDER BY c.id DESC LIMIT ?",
            (limit,)
        ).fetchall()
    con.close()
    return {"ok": True, "chats": [dict(r) for r in rows]}


@app.get("/api/admin/support/ai_chat_users")
def api_admin_ai_chat_users(request: Request):
    """Admin: list users who have had AI chat sessions."""
    require_admin(request)
    con = db_conn()
    rows = con.execute(
        "SELECT c.user_id, u.username, COUNT(*) as msg_count, MAX(c.ts) as last_ts, "
        "MAX(c.escalated) as has_escalated "
        "FROM support_ai_chats c LEFT JOIN users u ON u.id=c.user_id "
        "GROUP BY c.user_id ORDER BY last_ts DESC LIMIT 100"
    ).fetchall()
    con.close()
    return {"ok": True, "users": [dict(r) for r in rows]}


# ============================================
# MASS CHECKER (background jobs)
# ============================================

_CHECKER_JOBS: Dict[str, dict] = {}

def _checker_check_cookie(cookie: str) -> dict:
    """Check a single Roblox cookie, return account info."""
    ck = cookie.strip().replace('\r', '').replace('\n', '')
    # Strip common prefixes
    if ck.startswith('.ROBLOSECURITY='):
        ck = ck[len('.ROBLOSECURITY='):].strip()
    elif ck.startswith('_|WARNING:'):
        # Already raw cookie, keep as-is
        pass
    if not ck or len(ck) < 30:
        return {"valid": False, "error": "empty_or_short"}
    try:
        # Auth check
        _log.info("[CHECKER] checking cookie len=%d prefix=%s", len(ck), ck[:20])
        r = _roblox_request("GET", RBX_AUTH, cookie=ck)
        _log.info("[CHECKER] auth response: %s", r.status_code)
        if not r.ok:
            return {"valid": False, "error": f"auth_failed_{r.status_code}"}
        j = r.json() if r.content else {}
        uid = int(j.get("id") or 0)
        uname = j.get("name") or ""
        if not uid:
            return {"valid": False, "error": "no_user_id"}

        result = {"valid": True, "user_id": uid, "username": uname, "robux": 0, "rap": 0,
                  "premium": False, "email_verified": False, "has_pin": False, "card": 0,
                  "total_donate": 0, "all_time_donate": 0}

        # Robux balance
        try:
            rr = _roblox_request("GET", RBX_ROBUX.format(uid=uid), cookie=ck)
            if rr.ok:
                jj = rr.json() if rr.content else {}
                result["robux"] = int(jj.get("robux") or jj.get("balance") or 0)
        except Exception:
            pass

        # Premium check
        try:
            pr = _roblox_request("GET", f"https://premiumfeatures.roblox.com/v1/users/{uid}/validate-membership", cookie=ck)
            if pr.ok:
                result["premium"] = pr.json() is True or (isinstance(pr.json(), dict) and pr.json().get("isPremium"))
        except Exception:
            pass

        # Transaction totals (year + all time)
        try:
            tr = _roblox_request("GET", f"https://economy.roblox.com/v2/users/{uid}/transaction-totals?timeFrame=Year&transactionType=summary", cookie=ck)
            if tr.ok:
                tj = tr.json() if tr.content else {}
                result["total_donate"] = abs(int(tj.get("salesTotal") or 0)) + abs(int(tj.get("purchasesTotal") or 0))
        except Exception:
            pass
        try:
            tra = _roblox_request("GET", f"https://economy.roblox.com/v2/users/{uid}/transaction-totals?timeFrame=AllTime&transactionType=summary", cookie=ck)
            if tra.ok:
                tja = tra.json() if tra.content else {}
                result["all_time_donate"] = abs(int(tja.get("salesTotal") or 0)) + abs(int(tja.get("purchasesTotal") or 0))
        except Exception:
            pass

        # RAP (collectible value)
        try:
            iv = _roblox_request("GET", f"https://inventory.roblox.com/v1/users/{uid}/assets/collectibles?sortOrder=Desc&limit=100", cookie=ck)
            if iv.ok:
                ij = iv.json() if iv.content else {}
                rap = sum(int(item.get("recentAveragePrice") or 0) for item in (ij.get("data") or []))
                result["rap"] = rap
        except Exception:
            pass

        # Email verified + PIN
        try:
            sr = _roblox_request("GET", "https://accountsettings.roblox.com/v1/email", cookie=ck)
            if sr.ok:
                sj = sr.json() if sr.content else {}
                result["email_verified"] = bool(sj.get("verified"))
        except Exception:
            pass

        # Credit card / billing
        try:
            br = _roblox_request("GET", "https://billing.roblox.com/v1/credit", cookie=ck)
            if br.ok:
                bj = br.json() if br.content else {}
                result["card"] = int(bj.get("balance") or bj.get("robuxAmount") or 0)
        except Exception:
            pass

        # Categorize
        cats = []
        if result["robux"] >= 1000:
            cats.append("robux_1k+")
        elif result["robux"] >= 100:
            cats.append("robux_100+")
        if result["rap"] >= 5000:
            cats.append("rap_5k+")
        elif result["rap"] >= 500:
            cats.append("rap_500+")
        if result["premium"]:
            cats.append("premium")
        if result["email_verified"]:
            cats.append("email_verified")
        if result["card"] > 0:
            cats.append("has_card")
        if result["total_donate"] >= 10000:
            cats.append("donate_10k+")
        if not cats:
            cats.append("basic")
        result["categories"] = cats
        return result
    except Exception as e:
        return {"valid": False, "error": str(e)[:100]}


def _checker_worker(job_id: str, cookies: List[str], user_id: int):
    """Background thread to check cookies."""
    job = _CHECKER_JOBS[job_id]
    job["status"] = "running"
    results = []
    for i, ck in enumerate(cookies):
        if job.get("cancelled"):
            break
        try:
            res = _checker_check_cookie(ck)
            res["cookie"] = ck[:20] + "..." if len(ck) > 20 else ck
            res["cookie_full"] = ck
            results.append(res)
        except Exception:
            results.append({"valid": False, "error": "exception", "cookie": ck[:20] + "..."})
        job["done"] = i + 1
        job["results"] = results
        # Rate limiting: don't hammer Roblox
        time.sleep(0.5)
    job["status"] = "done"
    job["results"] = results

    # Save to DB for history
    try:
        valid_count = sum(1 for r in results if r.get("valid"))
        total_robux = sum(r.get("robux", 0) for r in results if r.get("valid"))
        total_rap = sum(r.get("rap", 0) for r in results if r.get("valid"))
        con = db_conn()
        _ensure_purchases_table(con)
        con.execute(
            "INSERT INTO tool_history(user_id, tool, input_short, result_short, status, created_at) VALUES(?,?,?,?,?,?)",
            (user_id, "checker", f"{len(cookies)} cookies", f"Valid: {valid_count}, R$: {total_robux}, RAP: {total_rap}", "ok", _now_utc_iso())
        )
        con.commit()
        con.close()
    except Exception:
        pass


@app.post("/api/tools/checker/start")
def api_checker_start(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    uid = int(u["id"])
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Файл пуст")
    # Parse cookies (one per line)
    cookies = [line.strip() for line in text.split("\n") if line.strip() and len(line.strip()) > 30]
    if not cookies:
        raise HTTPException(status_code=400, detail="Не найдено валидных куки (мин. длина 30 символов)")
    if len(cookies) > 500:
        raise HTTPException(status_code=400, detail="Максимум 500 куки за раз")
    # Check existing jobs
    for jid, j in list(_CHECKER_JOBS.items()):
        if j.get("user_id") == uid and j.get("status") == "running":
            raise HTTPException(status_code=409, detail="У вас уже есть запущенная проверка")
    # Clean old jobs (older than 1 hour)
    now = time.time()
    for jid in list(_CHECKER_JOBS.keys()):
        if _CHECKER_JOBS[jid].get("created_at", 0) < now - 3600:
            del _CHECKER_JOBS[jid]

    job_id = secrets.token_urlsafe(16)
    _CHECKER_JOBS[job_id] = {
        "user_id": uid, "status": "starting", "total": len(cookies),
        "done": 0, "results": [], "created_at": now, "cancelled": False,
    }
    t = threading.Thread(target=_checker_worker, args=(job_id, cookies, uid), daemon=True)
    t.start()
    return {"ok": True, "job_id": job_id, "total": len(cookies)}


@app.get("/api/tools/checker/status/{job_id}")
def api_checker_status(request: Request, job_id: str):
    u = require_user(request)
    job = _CHECKER_JOBS.get(job_id)
    if not job or job.get("user_id") != int(u["id"]):
        raise HTTPException(status_code=404, detail="Job not found")
    results = job.get("results") or []
    valid = [r for r in results if r.get("valid")]
    # Live stats
    stats = {
        "total_robux": sum(r.get("robux", 0) for r in valid),
        "total_rap": sum(r.get("rap", 0) for r in valid),
        "valid": len(valid),
        "invalid": len(results) - len(valid),
        "premium": sum(1 for r in valid if r.get("premium")),
        "with_card": sum(1 for r in valid if r.get("card", 0) > 0),
    }
    return {
        "status": job["status"], "total": job["total"], "done": job["done"],
        "stats": stats,
    }


@app.get("/api/tools/checker/download/{job_id}")
def api_checker_download(request: Request, job_id: str):
    u = require_user(request)
    job = _CHECKER_JOBS.get(job_id)
    if not job or job.get("user_id") != int(u["id"]):
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") != "done":
        raise HTTPException(status_code=400, detail="Проверка ещё не завершена")

    results = job.get("results") or []
    valid = [r for r in results if r.get("valid")]
    invalid = [r for r in results if not r.get("valid")]

    # Build sorted files
    import io, zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # All valid
        if valid:
            zf.writestr("valid/all_valid.txt", "\n".join(r["cookie_full"] for r in valid))
        # Invalid
        if invalid:
            zf.writestr("invalid/invalid.txt", "\n".join(r.get("cookie_full", r.get("cookie", "")) for r in invalid))
        # Category folders
        cat_map: Dict[str, list] = {}
        for r in valid:
            for cat in (r.get("categories") or ["basic"]):
                cat_map.setdefault(cat, []).append(r)
        for cat, items in sorted(cat_map.items()):
            lines = []
            for r in items:
                lines.append(f"{r['cookie_full']}  # {r.get('username','')} | R${r.get('robux',0)} | RAP:{r.get('rap',0)}")
            zf.writestr(f"sorted/{cat}.txt", "\n".join(lines))
        # Stats file
        stats_lines = [
            f"=== Checker Results ===",
            f"Total checked: {len(results)}",
            f"Valid: {len(valid)}",
            f"Invalid: {len(invalid)}",
            f"",
            f"--- Totals ---",
            f"Robux: {sum(r.get('robux',0) for r in valid)}",
            f"RAP: {sum(r.get('rap',0) for r in valid)}",
            f"Premium: {sum(1 for r in valid if r.get('premium'))}",
            f"Email verified: {sum(1 for r in valid if r.get('email_verified'))}",
            f"Has card: {sum(1 for r in valid if r.get('card',0) > 0)}",
            f"Total donate: {sum(r.get('total_donate',0) for r in valid)}",
            f"",
            f"--- Categories ---",
        ]
        for cat, items in sorted(cat_map.items()):
            stats_lines.append(f"  {cat}: {len(items)}")
        stats_lines.append(f"\n--- Top Accounts ---")
        top = sorted(valid, key=lambda r: r.get("robux", 0), reverse=True)[:20]
        for r in top:
            stats_lines.append(f"  {r.get('username','?')} | R${r.get('robux',0)} | RAP:{r.get('rap',0)} | {'Premium' if r.get('premium') else ''}")
        zf.writestr("stats.txt", "\n".join(stats_lines))
    buf.seek(0)
    from starlette.responses import StreamingResponse
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename=checker_{job_id[:8]}.zip"})


@app.get("/api/tools/checker/results/{job_id}")
def api_checker_results(request: Request, job_id: str):
    """Get full results for display in profile history."""
    u = require_user(request)
    job = _CHECKER_JOBS.get(job_id)
    if not job or job.get("user_id") != int(u["id"]):
        raise HTTPException(status_code=404, detail="Job not found")
    results = job.get("results") or []
    valid = [r for r in results if r.get("valid")]
    invalid = [r for r in results if not r.get("valid")]
    # Category counts
    cat_counts: Dict[str, int] = {}
    for r in valid:
        for cat in (r.get("categories") or ["basic"]):
            cat_counts[cat] = cat_counts.get(cat, 0) + 1
    return {
        "status": job["status"],
        "total": len(results), "valid": len(valid), "invalid": len(invalid),
        "stats": {
            "total_robux": sum(r.get("robux", 0) for r in valid),
            "total_rap": sum(r.get("rap", 0) for r in valid),
            "total_donate": sum(r.get("total_donate", 0) for r in valid),
            "all_time_donate": sum(r.get("all_time_donate", 0) for r in valid),
            "premium": sum(1 for r in valid if r.get("premium")),
            "email_verified": sum(1 for r in valid if r.get("email_verified")),
            "with_card": sum(1 for r in valid if r.get("card", 0) > 0),
        },
        "categories": cat_counts,
        "top_accounts": sorted(
            [{"username": r.get("username"), "robux": r.get("robux", 0), "rap": r.get("rap", 0),
              "premium": r.get("premium", False), "email_verified": r.get("email_verified", False),
              "card": r.get("card", 0)} for r in valid],
            key=lambda x: x["robux"], reverse=True
        )[:30],
    }


# ============================================
# TOOLS API ENDPOINTS
# ============================================

@app.post("/api/tools/generate_description")
def generate_description(request: Request, payload: Dict[str, Any] = Body(...)):
    """Генератор описания профиля - AI генерация на основе данных аккаунта"""
    u = require_user(request)
    uid = int(u["id"])
    
    # Проверяем лимиты
    limits = get_user_limits(uid)
    is_admin_user = int(u.get("is_admin") or 0) == 1 or (u.get("username","").lower() in ADMIN_USERS_LC)
    if not limits.get("premium") and not is_admin_user:
        credits = int(limits.get("credits_ai", 0))
        if credits <= 0:
            raise HTTPException(status_code=403, detail="Недостаточно AI генераций. Купите Premium!")
    
    # Получаем данные для генерации
    provider = payload.get("provider", "pollinations").lower()
    model = payload.get("model", "openai")
    mode = payload.get("mode", "Рерайт")
    tone = payload.get("tone", "Классика")
    extra = payload.get("extra", "")
    data = payload.get("data") or {}
    
    # Если нет данных - используем username
    username = data.get("username") or payload.get("username", "").strip()
    if not username and not data:
        raise HTTPException(status_code=400, detail="Укажите имя пользователя или данные аккаунта")
    
    # Правила стиля
    rules = build_sales_rule(mode, tone)
    
    # Формируем промпт
    system = (
        "Ты копирайтер, который пишет продающие описания для Roblox-аккаунтов. "
        "Пиши на русском. "
        "Не упоминай, что текст создан ИИ/нейросетью/генератором. "
        "Не используй markdown и блоки ```.\n\n"
        "ФОРМАТ ОТВЕТА СТРОГО ТАКОЙ:\n"
        "TITLE: <одна строка заголовка>\n"
        "DESC:\n<полное описание>\n"
    )
    
    facts = f"Факты об аккаунте:\n"
    facts += f"- Ник: {data.get('username') or username}\n"
    if data.get('user_id'):
        facts += f"- ID: {data.get('user_id')}\n"
    if data.get('robux') is not None:
        facts += f"- Robux: {data.get('robux')}\n"
    if data.get('rap'):
        facts += f"- RAP: {data.get('rap')}\n"
    if data.get('is_premium'):
        facts += f"- Premium: Да\n"
    if data.get('limiteds'):
        facts += f"- Лимитки: {data.get('limiteds')}\n"
    if data.get('groups'):
        facts += f"- Группы: {data.get('groups')}\n"
    
    user_prompt = (
        f"{facts}\n"
        f"Правила стиля:\n{rules}\n"
        f"Пожелания:\n{extra}\n\n"
        f"Сгенерируй TITLE и DESC."
    )
    
    try:
        # Генерируем через AI
        out = provider_chat(provider=provider, model=model, system=system, user=user_prompt)
        title, desc = extract_title_desc(out)
        
        if not title or not desc:
            raise HTTPException(status_code=500, detail="AI не смог сгенерировать описание")
        
        # Сохраняем шаблон для пользователя
        con = db_conn()
        try:
            con.execute(
                "INSERT INTO templates(user_id,title_tpl,desc_tpl,updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET title_tpl=excluded.title_tpl, desc_tpl=excluded.desc_tpl, updated_at=excluded.updated_at",
                (uid, title, desc, datetime.datetime.utcnow().isoformat()),
            )
            con.commit()
        except Exception:
            pass  # Не критично если не сохранилось
        finally:
            con.close()
        
        # Списываем кредиты
        if not limits.get("premium"):
            spend_credit(uid, "credits_ai", 1)
        
        # Log to tool_history
        try:
            con2 = db_conn()
            con2.execute("INSERT INTO tool_history(user_id,tool,input_short,result_short,status,created_at) VALUES(?,?,?,?,?,?)",
                        (uid, "description", (username or "?")[:30], (title or "")[:60], "ok", datetime.datetime.utcnow().isoformat()))
            con2.commit()
            con2.close()
        except Exception:
            pass

        return {
            "ok": True,
            "description": f"{title}\n\n{desc}",  # Для совместимости со старым форматом
            "title": title,
            "desc": desc,
            "username": username
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка генерации: {str(e)[:200]}")

@app.post("/api/tools/ai_chat")
def ai_chat(request: Request, payload: Dict[str, Any] = Body(...)):
    """AI чат ассистент - реальный AI через Pollinations/Groq"""
    u = require_user(request)
    message = payload.get("message", "").strip()
    
    if not message:
        raise HTTPException(status_code=400, detail="Сообщение обязательно")
    
    # Проверяем лимиты
    limits = get_user_limits(int(u["id"]))
    is_admin_user = int(u.get("is_admin") or 0) == 1 or (u.get("username","").lower() in ADMIN_USERS_LC)
    if not limits.get("premium") and not is_admin_user:
        credits = int(limits.get("credits_ai", 0))
        if credits <= 0:
            raise HTTPException(status_code=403, detail="Недостаточно AI запросов. Купите Premium или пополни баланс для покупки подписки!")
    
    # Используем реальный AI
    provider = payload.get("provider", "pollinations").lower()
    model = payload.get("model", "openai")
    
    system = (
        "Ты дружелюбный AI-помощник RBX Store. "
        "Помогаешь пользователям с вопросами о Roblox, играх, описаниях профиля. "
        "Отвечай на русском языке. Будь кратким и полезным. "
        "Не упоминай что ты AI или нейросеть."
    )
    
    try:
        response = provider_chat(provider=provider, model=model, system=system, user=message)
    except Exception as e:
        # Если провайдер недоступен, используем запасной вариант
        response = "Извини, сейчас AI временно недоступен. Попробуй позже или обратись в поддержку! 🤖"
    
    # Списываем кредиты только после успешного ответа
    if not limits.get("premium"):
        spend_credit(int(u["id"]), "credits_ai", 1)
    
    return {
        "response": response,
        "message": message
    }

@app.post("/api/roblox/check_cookie")
async def check_roblox_cookie(request: Request, payload: Dict[str, Any] = Body(...)):
    """Проверка Roblox аккаунта по .ROBLOSECURITY cookie.

    ⚡ Оптимизировано под "MeowTool-style":
    - параллельные запросы (aiohttp)
    - аккуратные таймауты
    - кэш на короткое время (чтобы не долбить Roblox при повторных кликах)
    """
    _ = require_user(request)  # доступ только для залогиненных
    cookie = str(payload.get("cookie", "") or "").strip()

    if not cookie:
        raise HTTPException(status_code=400, detail="Cookie обязателен")

    # Нормализация (поддерживаем вставку как с префиксом, так и без)
    if cookie.startswith(".ROBLOSECURITY="):
        cookie = cookie[len(".ROBLOSECURITY="):].strip()

    # Roblox иногда присылает cookie с _|WARNING:... — оставляем как есть
    cookie_key = hashlib.sha1(cookie.encode("utf-8")).hexdigest()

    # --- in-memory cache (TTL) ---
    now_ts = time.time()
    try:
        cached = _COOKIE_CHECK_CACHE.get(cookie_key)
        if cached and (now_ts - cached["ts"] < 60):
            return cached["data"]
    except Exception:
        pass

    # Если aiohttp недоступен — fallback на requests (медленнее)
    if aiohttp is None:
        data = _check_roblox_cookie_requests(cookie)
        try:
            _COOKIE_CHECK_CACHE[cookie_key] = {"ts": now_ts, "data": data}
        except Exception:
            pass
        return data

    headers = {
        "Cookie": f".ROBLOSECURITY={cookie}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }

    timeout = aiohttp.ClientTimeout(total=20)

    # CRITICAL: DummyCookieJar prevents Roblox from overriding cookies between requests
    # Without this, settings/json response can corrupt the session cookie jar
    jar = aiohttp.DummyCookieJar()
    async with aiohttp.ClientSession(timeout=timeout, cookie_jar=jar) as session:
        # 1) auth user (MeowTool: users/authenticated)
        user_data = await _aio_get_json(session, "https://users.roblox.com/v1/users/authenticated", headers=headers, allow_roproxy=True)
        if not isinstance(user_data, dict) or not user_data.get("id"):
            return {"error": "Куки недействительны или истекли", "status": "invalid"}

        user_id = int(user_data.get("id") or 0)
        username = str(user_data.get("name") or "")
        display_name = str(user_data.get("displayName") or username)

        # 2) MeowTool-style: settings/json gives Premium, CanTrade, Email, 2FA, Pin, Age in ONE call
        settings_url = "https://www.roblox.com/my/settings/json"
        # Other parallel requests
        details_url = f"https://users.roblox.com/v1/users/{user_id}"
        avatar_url = f"https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds={user_id}&size=420x420&format=Png"
        currency_url = f"https://economy.roblox.com/v1/users/{user_id}/currency"
        billing_url = "https://billing.roblox.com/v1/credit"
        totals_url = f"https://economy.roblox.com/v2/users/{user_id}/transaction-totals?timeFrame=Year&transactionType=summary"
        # MeowTool: payment-profiles for card count
        payment_profiles_url = "https://apis.roblox.com/payments-gateway/v1/payment-profiles"
        country_url = "https://users.roblox.com/v1/users/authenticated/country-code"

        friends_url = f"https://friends.roblox.com/v1/users/{user_id}/friends/count"
        followers_url = f"https://friends.roblox.com/v1/users/{user_id}/followers/count"
        followings_url = f"https://friends.roblox.com/v1/users/{user_id}/followings/count"

        # MeowTool: includeLocked=true
        groups_url = f"https://groups.roblox.com/v1/users/{user_id}/groups/roles?includeLocked=true"
        badges_url = f"https://badges.roblox.com/v1/users/{user_id}/badges?limit=100&sortOrder=Desc"
        roblox_badges_url = f"https://accountinformation.roblox.com/v1/users/{user_id}/roblox-badges"
        games_url = f"https://games.roblox.com/v2/users/{user_id}/games?sortOrder=Desc&limit=50"
        collectibles_url = f"https://inventory.roblox.com/v1/users/{user_id}/assets/collectibles?sortOrder=Desc&limit=100"

        # MeowTool: sessions via token-metadata-service
        sessions_url = "https://apis.roblox.com/token-metadata-service/v1/sessions"
        # MeowTool: age group
        age_group_url = "https://apis.roblox.com/user-settings-api/v1/account-insights/age-group"
        # MeowTool: verified age
        verified_age_url = "https://apis.roblox.com/age-verification-service/v1/age-verification/verified-age"
        # MeowTool: voice
        voice_url = "https://voice.roblox.com/v1/settings"
        # Phone (MeowTool: accountinformation)
        phone_url = "https://accountinformation.roblox.com/v1/phone"
        # Privacy
        inv_priv_url = "https://apis.roblox.com/user-settings-api/v1/user-settings/settings-and-options"
        trade_priv_url = "https://accountsettings.roblox.com/v1/trade-privacy"

        tasks = [
            _aio_get_json(session, settings_url, headers=headers, allow_roproxy=False),    # settings/json
            _aio_get_json(session, details_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, avatar_url, headers=None, allow_roproxy=True),
            _aio_get_json(session, currency_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, billing_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, totals_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, payment_profiles_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, country_url, headers=headers, allow_roproxy=True),

            _aio_get_json(session, friends_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, followers_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, followings_url, headers=headers, allow_roproxy=True),

            _aio_get_json(session, groups_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, badges_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, roblox_badges_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, games_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, collectibles_url, headers=headers, allow_roproxy=True),

            _aio_get_json(session, phone_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, sessions_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, inv_priv_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, trade_priv_url, headers=headers, allow_roproxy=True),
            _aio_get_json(session, age_group_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, verified_age_url, headers=headers, allow_roproxy=False),
            _aio_get_json(session, voice_url, headers=headers, allow_roproxy=False),
        ]

        (
            settings_data,
            details,
            avatar_data,
            currency,
            billing,
            totals,
            payment_profiles,
            country_data,
            friends,
            followers,
            followings,
            groups_roles,
            badges_data,
            roblox_badges_data,
            games_data,
            collectibles_data,
            phone_data,
            sessions_data,
            inv_priv_data,
            trade_priv_data,
            age_group_data,
            verified_age_data,
            voice_data,
        ) = await asyncio.gather(*tasks)

        # === Parse settings/json (MeowTool-style one-shot) ===
        is_premium = False
        can_trade = False
        email_set = False
        email_verified = False
        has_2fa = False
        has_pin = False
        above_13 = False
        account_age_days = 0

        if isinstance(settings_data, dict):
            is_premium = bool(settings_data.get("IsPremium"))
            can_trade = bool(settings_data.get("CanTrade"))
            above_13 = bool(settings_data.get("UserAbove13"))
            account_age_days = int(settings_data.get("AccountAgeInDays") or 0)
            sec = settings_data.get("MyAccountSecurityModel") or {}
            email_set = bool(sec.get("IsEmailSet"))
            email_verified = bool(sec.get("IsEmailVerified"))
            has_2fa = bool(sec.get("IsTwoStepEnabled"))
            has_pin = bool(settings_data.get("IsAccountPinEnabled"))

        # details
        created_date = ""
        description = ""
        is_banned = False
        if isinstance(details, dict):
            created_date = str(details.get("created") or "")
            description = str(details.get("description") or "")
            is_banned = bool(details.get("isBanned") or False)

        # avatar
        avatar_image = None
        try:
            if isinstance(avatar_data, dict) and avatar_data.get("data"):
                avatar_image = avatar_data["data"][0].get("imageUrl")
        except Exception:
            avatar_image = None

        # robux
        robux_balance = 0
        if isinstance(currency, dict):
            robux_balance = int(currency.get("robux") or 0)

        billing_credit = 0
        if isinstance(billing, dict):
            billing_credit = int(billing.get("robuxAmount") or 0)

        pending_robux = 0
        donate_year = 0
        if isinstance(totals, dict):
            pending_robux = int(totals.get("pendingRobuxTotal") or 0)
            donate_year = int(totals.get("salesTotal") or 0)

        # MeowTool: payment-profiles for card count
        cards_count = 0
        has_card = False
        if isinstance(payment_profiles, list):
            cards_count = len(payment_profiles)
            has_card = cards_count > 0
        elif isinstance(payment_profiles, dict):
            has_card = bool(payment_profiles)

        # country
        country_code = ""
        if isinstance(country_data, dict):
            country_code = str(country_data.get("countryCode") or "")

        # social counts
        friends_count = int(friends.get("count") or 0) if isinstance(friends, dict) else 0
        followers_count = int(followers.get("count") or 0) if isinstance(followers, dict) else 0
        followings_count = int(followings.get("count") or 0) if isinstance(followings, dict) else 0

        # groups
        groups_count = 0
        owned_groups = 0
        groups_members = 0
        groups_funds = 0
        groups_pending = 0
        groups_list: List[Dict[str, Any]] = []
        owned_group_ids: List[int] = []

        if isinstance(groups_roles, dict) and isinstance(groups_roles.get("data"), list):
            groups_data = groups_roles.get("data") or []
            groups_count = len(groups_data)
            for g in groups_data:
                group_info = (g or {}).get("group") or {}
                role = (g or {}).get("role") or {}
                groups_members += int(group_info.get("memberCount") or 0)
                if int(role.get("rank") or 0) == 255:
                    owned_groups += 1
                    gid = int(group_info.get("id") or 0)
                    if gid:
                        owned_group_ids.append(gid)
                        groups_list.append({
                            "id": gid,
                            "name": str(group_info.get("name") or ""),
                            "members": int(group_info.get("memberCount") or 0),
                        })

        # owned group funds/pending (ограничиваем, чтобы не висло)
        owned_group_ids = owned_group_ids[:10]
        async def _group_currency(gid: int):
            return await _aio_get_json(session, f"https://economy.roblox.com/v1/groups/{gid}/currency", headers=headers, allow_roproxy=True)
        async def _group_pending(gid: int):
            return await _aio_get_json(session, f"https://economy.roblox.com/v1/groups/{gid}/revenue/summary/year", headers=headers, allow_roproxy=True)

        if owned_group_ids:
            cur_tasks = [_group_currency(gid) for gid in owned_group_ids]
            pend_tasks = [_group_pending(gid) for gid in owned_group_ids]
            cur_res = await asyncio.gather(*cur_tasks)
            pend_res = await asyncio.gather(*pend_tasks)
            for j in cur_res:
                if isinstance(j, dict):
                    groups_funds += int(j.get("robux") or 0)
            for j in pend_res:
                if isinstance(j, dict):
                    groups_pending += int(j.get("pendingRobux") or 0)

        # gamepasses count - from games list
        gamepasses_count = 0

        # badges count
        badges_count = 0
        if isinstance(badges_data, dict) and isinstance(badges_data.get("data"), list):
            badges_count = len(badges_data.get("data") or [])

        # roblox badges (official)
        roblox_badges = []
        if isinstance(roblox_badges_data, list):
            roblox_badges = [str(b.get("name") or "") for b in roblox_badges_data if isinstance(b, dict) and b.get("name")]

        # games created + visits
        games_count = 0
        total_visits = 0
        if isinstance(games_data, dict) and isinstance(games_data.get("data"), list):
            games_list = games_data.get("data") or []
            games_count = len(games_list)
            for game in games_list:
                if isinstance(game, dict):
                    total_visits += int(game.get("placeVisits") or 0)

        # phone (MeowTool: accountinformation)
        phone_verified = False
        phone_value = None
        if isinstance(phone_data, dict):
            phone_value = str(phone_data.get("phone") or "") or None
            phone_verified = bool(phone_value)

        # MeowTool: inventory privacy from user-settings-api
        inventory_privacy = "Unknown"
        if isinstance(inv_priv_data, dict):
            inv_val = inv_priv_data.get("whoCanSeeMyInventory", {})
            if isinstance(inv_val, dict):
                inventory_privacy = str(inv_val.get("currentValue") or "Unknown")
            else:
                inventory_privacy = str(inv_priv_data.get("inventoryPrivacy") or "Unknown")

        trade_privacy = "Unknown"
        if isinstance(trade_priv_data, dict):
            trade_privacy = str(trade_priv_data.get("tradePrivacy") or "Unknown")

        # MeowTool: sessions via token-metadata-service
        sessions_count = 0
        if isinstance(sessions_data, dict) and isinstance(sessions_data.get("sessions"), list):
            sessions_count = len(sessions_data.get("sessions") or [])
        elif isinstance(sessions_data, list):
            sessions_count = len(sessions_data)

        # MeowTool: age group
        age_group = None
        if isinstance(age_group_data, dict):
            age_key = str(age_group_data.get("ageGroupTranslationKey") or "")
            if "Under13" in age_key:
                age_group = "<13"
            elif "Over13" in age_key and "Under18" not in age_key:
                age_group = "13+"
            elif "Under18" in age_key:
                age_group = "13-17"
            elif "Over18" in age_key:
                age_group = "18+"

        # MeowTool: verified age
        verified_age = False
        if isinstance(verified_age_data, dict):
            verified_age = bool(verified_age_data.get("isVerified"))

        # MeowTool: voice verified
        voice_verified = False
        if isinstance(voice_data, dict):
            voice_verified = bool(voice_data.get("isVerifiedForVoice"))

        # collectibles (RAP) — MeowTool style
        collectibles_count = 0
        total_rap = 0
        try:
            # Use the initial parallel fetch as first page
            coll = collectibles_data
            cursor = ""
            loops = 0
            while True:
                loops += 1
                if loops > 1:
                    url = f"https://inventory.roblox.com/v1/users/{user_id}/assets/collectibles?sortOrder=Desc&limit=100"
                    if cursor:
                        url += f"&cursor={cursor}"
                    coll = await _aio_get_json(session, url, headers=headers, allow_roproxy=True)
                if not isinstance(coll, dict):
                    break
                items = coll.get("data") or []
                if not isinstance(items, list):
                    break
                collectibles_count += len(items)
                for item in items:
                    if isinstance(item, dict):
                        total_rap += int(item.get("recentAveragePrice") or 0)
                cursor = coll.get("nextPageCursor")
                if not cursor or collectibles_count >= 500 or loops >= 6:
                    break
        except Exception:
            pass

        # masked
        masked_email = None
        if email_set:
            masked_email = "***@***"
        masked_phone = None
        if phone_value and len(phone_value) > 4:
            masked_phone = phone_value[:4] + "***"

        data = {
            "status": "valid",
            "user": {
                "id": user_id,
                "username": username,
                "display_name": display_name,
                "description": description[:300] if description else "",
                "created": created_date,
                "account_age_days": account_age_days,
                "is_banned": is_banned,
                "avatar_url": avatar_image,
                "country": country_code,
                "age_group": age_group,
                "above_13": above_13,
                "verified_age": verified_age,
                "voice_verified": voice_verified,
                "roblox_badges": roblox_badges,
            },
            "robux": {
                "balance": robux_balance,
                "pending": pending_robux,
                "billing_credit": billing_credit,
                "is_premium": is_premium,
            },
            "transactions": {
                "donate_year": donate_year,
            },
            "social": {
                "friends": friends_count,
                "followers": followers_count,
                "followings": followings_count,
            },
            "inventory": {
                "collectibles_count": collectibles_count,
                "collectibles_rap": total_rap,
                "has_card": has_card,
                "cards_count": cards_count,
                "gamepasses": gamepasses_count,
            },
            "groups": {
                "total_groups": groups_count,
                "owned_groups": owned_groups,
                "groups_members": groups_members,
                "groups_funds": groups_funds,
                "groups_pending": groups_pending,
                "groups_list": groups_list[:5],
            },
            "games": {
                "created_games": games_count,
                "total_visits": total_visits,
            },
            "badges": {
                "count": badges_count,
            },
            "security": {
                "email_set": email_set,
                "email_verified": email_verified,
                "email": masked_email,
                "phone_verified": phone_verified,
                "phone": masked_phone,
                "has_2fa": has_2fa,
                "has_pin": has_pin,
                "sessions": sessions_count,
            },
            "privacy": {
                "inventory": inventory_privacy,
                "trade": trade_privacy,
                "can_trade": can_trade,
            },
        }

        try:
            _COOKIE_CHECK_CACHE[cookie_key] = {"ts": now_ts, "data": data}
        except Exception:
            pass

        # Log to tool_history
        try:
            uid = int(_["id"]) if isinstance(_, dict) else 0
            uname = data.get("user", {}).get("username", "?")
            robux_b = data.get("robux", {}).get("balance", 0)
            result_s = f"{uname} | R${robux_b}" if data.get("status") == "valid" else "invalid"
            con = db_conn()
            con.execute("INSERT INTO tool_history(user_id,tool,input_short,result_short,status,created_at) VALUES(?,?,?,?,?,?)",
                        (uid, "checker", cookie[:20] + "...", result_s, data.get("status", "error"), datetime.datetime.utcnow().isoformat()))
            con.commit()
            con.close()
        except Exception:
            pass

        return data
_COOKIE_CHECK_CACHE: Dict[str, Dict[str, Any]] = {}

async def _aio_get_json(session, url: str, headers: Optional[Dict[str, str]] = None, allow_roproxy: bool = True, return_status: bool = False):
    """GET -> json with safe fallbacks. Never raises; returns dict/list/None."""
    urls = [url]
    if allow_roproxy and ".roblox.com" in url:
        urls.append(url.replace(".roblox.com", ".roproxy.com"))

    last_status = None
    for u in urls:
        try:
            # MeowTool style: don't follow redirects (302 = invalid/banned)
            async with session.get(u, headers=headers, allow_redirects=False) as resp:
                last_status = resp.status
                if resp.status == 302:
                    # 302 -> invalid cookie or banned
                    if return_status:
                        return {"_status": 302}
                    return {}
                if resp.status == 204:
                    data = {}
                else:
                    try:
                        data = await resp.json(content_type=None)
                    except Exception:
                        data = {}
                if return_status:
                    if isinstance(data, dict):
                        data["_status"] = resp.status
                    else:
                        data = {"_status": resp.status, "data": data}
                if 200 <= resp.status < 300:
                    return data
        except Exception:
            continue

    if return_status:
        return {"_status": last_status or 0}
    return {}


def _check_roblox_cookie_requests(cookie: str) -> Dict[str, Any]:
    """Fallback реализация (если aiohttp недоступен)."""
    headers = {
        "Cookie": f".ROBLOSECURITY={cookie}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    try:
        user_resp = requests.get("https://users.roblox.com/v1/users/authenticated", headers=headers, timeout=10)
        if user_resp.status_code != 200:
            return {"error": "Куки недействительны или истекли", "status": "invalid"}
        user_data = user_resp.json()
        user_id = int(user_data.get("id") or 0)
        if not user_id:
            return {"error": "Не удалось получить информацию о пользователе", "status": "invalid"}
        # Минимальный набор, чтобы UI не ломался
        robux_balance = 0
        try:
            bal = requests.get("https://economy.roblox.com/v1/users/currency", headers=headers, timeout=10)
            if bal.status_code == 200:
                robux_balance = int(bal.json().get("robux") or 0)
        except Exception:
            pass

        return {
            "status": "valid",
            "user": {"id": user_id, "username": user_data.get("name"), "display_name": user_data.get("displayName") or user_data.get("name"), "avatar_url": None, "account_age_days": 0, "roblox_badges": []},
            "robux": {"balance": robux_balance, "pending": 0, "billing_credit": 0, "is_premium": False},
            "transactions": {"donate_year": 0},
            "social": {"friends": 0, "followers": 0, "followings": 0},
            "inventory": {"collectibles_count": 0, "collectibles_rap": 0, "has_card": False, "cards_count": 0, "gamepasses": 0},
            "groups": {"total_groups": 0, "owned_groups": 0, "groups_members": 0, "groups_funds": 0, "groups_pending": 0, "groups_list": []},
            "games": {"created_games": 0, "total_visits": 0},
            "badges": {"count": 0},
            "security": {"email_set": False, "email_verified": False, "email": None, "phone_verified": False, "phone": None, "has_2fa": False, "has_pin": False, "sessions": 0},
            "privacy": {"inventory": "Unknown", "trade": "Unknown", "can_trade": False},
        }
    except Exception as e:
        return {"error": f"Ошибка при проверке: {str(e)}", "status": "error"}


# ═══════════════════════════════════════════════════════════
# PROXY CHECKER
# ═══════════════════════════════════════════════════════════

_PROXY_JOBS: Dict[str, Any] = {}

async def _proxy_check_one(proxy: str, timeout: int = 8) -> Dict[str, Any]:
    """Check a single proxy against a Roblox API endpoint."""
    raw = proxy.strip()
    if not raw:
        return {"proxy": raw, "ok": False, "error": "empty"}

    # Detect protocol
    if "://" in raw:
        url_proxy = raw
    else:
        url_proxy = "http://" + raw

    test_url = "https://users.roblox.com/v1/users/1"
    start = time.time()
    try:
        if aiohttp:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as sess:
                async with sess.get(test_url, proxy=url_proxy, allow_redirects=False) as r:
                    elapsed = round((time.time() - start) * 1000)
                    ok = r.status in (200, 301, 302)
                    return {"proxy": proxy, "ok": ok, "status": r.status, "ms": elapsed, "protocol": url_proxy.split("://")[0]}
        else:
            import requests as _req
            proxies = {"http": url_proxy, "https": url_proxy}
            r = _req.get(test_url, proxies=proxies, timeout=timeout, allow_redirects=False)
            elapsed = round((time.time() - start) * 1000)
            ok = r.status_code in (200, 301, 302)
            return {"proxy": proxy, "ok": ok, "status": r.status_code, "ms": elapsed, "protocol": url_proxy.split("://")[0]}
    except Exception as ex:
        elapsed = round((time.time() - start) * 1000)
        err = str(ex)
        if "connect" in err.lower() or "connection" in err.lower():
            err_short = "connection_error"
        elif "timeout" in err.lower():
            err_short = "timeout"
        elif "proxy" in err.lower():
            err_short = "proxy_error"
        else:
            err_short = "error"
        return {"proxy": proxy, "ok": False, "error": err_short, "ms": elapsed}


def _proxy_worker(job_id: str, proxies: List[str], uid: int, threads: int = 50):
    """Background thread that checks proxies concurrently."""
    import asyncio, concurrent.futures

    job = _PROXY_JOBS[job_id]
    job["status"] = "running"
    results = []

    async def run_all():
        sem = asyncio.Semaphore(threads)
        async def _wrap(p):
            async with sem:
                r = await _proxy_check_one(p, timeout=8)
                job["done"] = job.get("done", 0) + 1
                job["results"] = results + [r]
                results.append(r)
        await asyncio.gather(*[_wrap(p) for p in proxies])

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(run_all())
        loop.close()
    except Exception:
        # fallback: sequential check
        for p in proxies:
            try:
                loop2 = asyncio.new_event_loop()
                r = loop2.run_until_complete(_proxy_check_one(p, timeout=8))
                loop2.close()
            except Exception:
                r = {"proxy": p, "ok": False, "error": "exception"}
            results.append(r)
            job["done"] = len(results)
            job["results"] = list(results)

    job["status"] = "done"
    job["results"] = results

    # Log usage
    try:
        good = sum(1 for r in results if r.get("ok"))
        con = db_conn()
        con.execute(
            "INSERT INTO tool_history(user_id,tool,input_short,result_short,status,created_at) VALUES(?,?,?,?,?,?)",
            (uid, "proxy_checker", f"{len(proxies)} proxies", f"Good: {good}", "ok", _now_utc_iso())
        )
        con.commit()
        con.close()
    except Exception:
        pass


@app.post("/api/tools/proxy/start")
async def api_proxy_start(request: Request, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    uid = int(u["id"])
    text = str(payload.get("text") or "")
    if not text:
        raise HTTPException(status_code=400, detail="Список прокси обязателен")
    proxies = [line.strip() for line in text.splitlines() if line.strip()]
    if not proxies:
        raise HTTPException(status_code=400, detail="Не найдено ни одного прокси")
    if len(proxies) > 50000:
        raise HTTPException(status_code=400, detail="Максимум 50 000 прокси за раз")

    threads = int(payload.get("threads") or 50)
    threads = max(5, min(threads, 200))

    import uuid
    job_id = str(uuid.uuid4())
    _PROXY_JOBS[job_id] = {"status": "pending", "total": len(proxies), "done": 0, "results": [], "user_id": uid}
    t = threading.Thread(target=_proxy_worker, args=(job_id, proxies, uid, threads), daemon=True)
    t.start()
    return {"ok": True, "job_id": job_id, "total": len(proxies)}


@app.get("/api/tools/proxy/status/{job_id}")
def api_proxy_status(request: Request, job_id: str):
    u = require_user(request)
    job = _PROXY_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    results = job.get("results") or []
    good = sum(1 for r in results if r.get("ok"))
    bad = len(results) - good
    avg_ms = int(sum(r.get("ms", 0) for r in results if r.get("ok")) / max(good, 1))
    return {
        "status": job["status"],
        "total": job["total"],
        "done": job.get("done", 0),
        "good": good,
        "bad": bad,
        "avg_ms": avg_ms,
    }


@app.get("/api/tools/proxy/results/{job_id}")
def api_proxy_results(request: Request, job_id: str):
    u = require_user(request)
    job = _PROXY_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    results = job.get("results") or []
    good = [r for r in results if r.get("ok")]
    bad = [r for r in results if not r.get("ok")]
    good.sort(key=lambda r: r.get("ms", 9999))
    return {
        "status": job["status"],
        "total": job["total"],
        "good": len(good),
        "bad": len(bad),
        "good_list": good[:500],
        "bad_list": bad[:200],
        "good_text": "\n".join(r["proxy"] for r in good),
    }


# ═══════════════════════════════════════════════════════
# AI MULTI-CHAT SYSTEM
# ═══════════════════════════════════════════════════════

RBX_SITE_CONTEXT = """Ты находишься на сайте RBX ST (rbx-store) — это магазин цифровых услуг для Roblox.
Основные функции сайта:
- Покупка Robux по нику (через геймпассы, безопасно, не требует пароля — только ник). Цены от 10 робуксов за ~1₽/робукс.
- Генератор описаний профиля — AI создаёт продающие описания для Roblox-аккаунтов по шаблону
- Чекер аккаунтов — проверка аккаунта по cookie (.ROBLOSECURITY): показывает Robux, RAP, лимитки, Premium и т.д.
- Прокси-чекер — массовая проверка прокси на работоспособность
- AI-чат — общение с ИИ (ты), помощь по Roblox и сайту
- Магазин — Premium подписка (109₽ на 50 дней), бесплатный кейс (каждые 48 часов), платный кейс (17₽)
- Профиль — баланс, Premium статус, настройки
- Пополнение баланса через CryptoBot (Telegram) и промокоды

Как купить Robux на RBX ST:
1. Зайти в раздел «Robux» в меню
2. Ввести свой ник Roblox
3. Указать количество Robux
4. Оплатить с баланса или через CryptoBot
5. Robux придут через геймпасс автоматически за ~5 секунд

Premium подписка даёт: безлимитные AI-генерации, приоритетную поддержку, расширенный AI-чат (5 чатов, 30 сообщений/неделю).
Бесплатно: 1 чат с AI, 5 сообщений.

Поддержка работает 24/7 через встроенный чат или Telegram.
Сайт запущен в 2026 году.

ВАЖНО: Когда спрашивают как купить робуксы — отвечай ТОЛЬКО про покупку на ЭТОМ сайте (RBX ST), не про официальный Roblox.
Когда спрашивают цены — отвечай про цены на ЭТОМ сайте.
Будь дружелюбным и кратким. Отвечай на русском, если не просят иначе."""


def _get_ai_limits(uid: int) -> dict:
    """Get AI chat limits for user"""
    con = db_conn()
    try:
        u = con.execute("SELECT premium_until FROM users WHERE id=?", (uid,)).fetchone()
        is_premium = False
        if u and u[0]:
            try:
                is_premium = datetime.datetime.fromisoformat(u[0]) > datetime.datetime.utcnow()
            except: pass

        chat_count = con.execute("SELECT COUNT(*) FROM ai_chats WHERE user_id=?", (uid,)).fetchone()[0]

        if is_premium:
            week_ago = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).isoformat()
            msg_count = con.execute(
                "SELECT COUNT(*) FROM ai_chat_msgs m JOIN ai_chats c ON m.chat_id=c.id WHERE c.user_id=? AND m.role='user' AND m.created_at>?",
                (uid, week_ago)
            ).fetchone()[0]
            return {
                "premium": True,
                "max_chats": 5,
                "max_messages": 30,
                "chats_used": chat_count,
                "messages_used": msg_count,
                "period": "week"
            }
        else:
            msg_count = con.execute(
                "SELECT COUNT(*) FROM ai_chat_msgs m JOIN ai_chats c ON m.chat_id=c.id WHERE c.user_id=? AND m.role='user'",
                (uid,)
            ).fetchone()[0]
            return {
                "premium": False,
                "max_chats": 1,
                "max_messages": 5,
                "chats_used": chat_count,
                "messages_used": msg_count,
                "period": "forever"
            }
    finally:
        con.close()


@app.get("/api/ai/limits")
def api_ai_limits(request: Request):
    u = require_user(request)
    return _get_ai_limits(int(u["id"]))


@app.get("/api/ai/chats")
def api_ai_chats_list(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    rows = con.execute(
        "SELECT id, title, created_at, updated_at FROM ai_chats WHERE user_id=? ORDER BY updated_at DESC",
        (uid,)
    ).fetchall()
    con.close()
    chats = [{"id": r[0], "title": r[1], "created_at": r[2], "updated_at": r[3]} for r in rows]
    return {"chats": chats}


@app.post("/api/ai/chats")
def api_ai_chats_create(request: Request):
    u = require_user(request)
    uid = int(u["id"])
    limits = _get_ai_limits(uid)
    if limits["chats_used"] >= limits["max_chats"]:
        detail = "Лимит чатов достигнут. Удалите старый чат или оформите Premium." if not limits["premium"] else "Максимум 5 чатов. Удалите старый чат."
        raise HTTPException(status_code=403, detail=detail)
    now = datetime.datetime.utcnow().isoformat()
    con = db_conn()
    cur = con.execute(
        "INSERT INTO ai_chats(user_id, title, created_at, updated_at) VALUES(?,?,?,?) RETURNING id",
        (uid, "Новый чат", now, now)
    )
    chat_id = cur.fetchone()[0]
    con.commit()
    con.close()
    return {"id": chat_id, "title": "Новый чат", "created_at": now}


@app.delete("/api/ai/chats/{chat_id}")
def api_ai_chats_delete(request: Request, chat_id: int):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    row = con.execute("SELECT id FROM ai_chats WHERE id=? AND user_id=?", (chat_id, uid)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Чат не найден")
    con.execute("DELETE FROM ai_chat_msgs WHERE chat_id=?", (chat_id,))
    con.execute("DELETE FROM ai_chats WHERE id=?", (chat_id,))
    con.commit()
    con.close()
    return {"ok": True}


@app.get("/api/ai/chats/{chat_id}/messages")
def api_ai_chats_messages(request: Request, chat_id: int):
    u = require_user(request)
    uid = int(u["id"])
    con = db_conn()
    chat = con.execute("SELECT id FROM ai_chats WHERE id=? AND user_id=?", (chat_id, uid)).fetchone()
    if not chat:
        con.close()
        raise HTTPException(status_code=404, detail="Чат не найден")
    rows = con.execute(
        "SELECT id, role, content, created_at FROM ai_chat_msgs WHERE chat_id=? ORDER BY id ASC",
        (chat_id,)
    ).fetchall()
    con.close()
    msgs = [{"id": r[0], "role": r[1], "content": r[2], "ts": r[3]} for r in rows]
    return {"messages": msgs}


@app.post("/api/ai/chats/{chat_id}/send")
def api_ai_chats_send(request: Request, chat_id: int, payload: Dict[str, Any] = Body(...)):
    u = require_user(request)
    uid = int(u["id"])
    message = (payload.get("message") or "").strip()
    use_site_context = payload.get("site_context", False)
    if not message:
        raise HTTPException(status_code=400, detail="Сообщение обязательно")

    con = db_conn()
    chat = con.execute("SELECT id FROM ai_chats WHERE id=? AND user_id=?", (chat_id, uid)).fetchone()
    if not chat:
        con.close()
        raise HTTPException(status_code=404, detail="Чат не найден")

    limits = _get_ai_limits(uid)
    if limits["messages_used"] >= limits["max_messages"]:
        con.close()
        period_text = "на этой неделе" if limits["premium"] else ""
        raise HTTPException(status_code=403, detail=f"Лимит сообщений исчерпан {period_text}. {'Подождите до следующей недели.' if limits['premium'] else 'Оформите Premium для расширенных лимитов.'}")

    now = datetime.datetime.utcnow().isoformat()

    con.execute("INSERT INTO ai_chat_msgs(chat_id, role, content, created_at) VALUES(?,?,?,?)", (chat_id, "user", message, now))

    hist_rows = con.execute(
        "SELECT role, content FROM ai_chat_msgs WHERE chat_id=? ORDER BY id DESC LIMIT 20",
        (chat_id,)
    ).fetchall()
    hist_rows = list(reversed(hist_rows))

    system = "Ты дружелюбный AI-ассистент. Отвечай кратко и по делу на русском языке."
    if use_site_context:
        system = RBX_SITE_CONTEXT

    context_lines = []
    for r in hist_rows[:-1]:
        prefix = "Пользователь" if r[0] == "user" else "Ассистент"
        context_lines.append(f"{prefix}: {r[1]}")
    if context_lines:
        user_prompt = "\n".join(context_lines) + f"\n\nПользователь: {message}"
    else:
        user_prompt = message

    try:
        reply = pollinations_chat(model="openai", system=system, user=user_prompt, temperature=0.8, max_tokens=800)
    except Exception as e:
        try:
            reply = pollinations_chat(model="mistral", system=system, user=user_prompt, temperature=0.8, max_tokens=800)
        except Exception:
            try:
                reply = pollinations_text_simple(system=system, user=user_prompt)
            except Exception:
                try:
                    groq_key = os.environ.get("GROQ_API_KEY", "")
                    if groq_key:
                        reply = groq_chat(api_key=groq_key, model="llama-3.3-70b-versatile", system=system, user=user_prompt)
                    else:
                        raise Exception("no groq key")
                except Exception:
                    reply = "Извини, AI временно недоступен. Попробуй позже!"

    con.execute("INSERT INTO ai_chat_msgs(chat_id, role, content, created_at) VALUES(?,?,?,?)", (chat_id, "assistant", reply, now))

    msg_count = con.execute("SELECT COUNT(*) FROM ai_chat_msgs WHERE chat_id=? AND role='user'", (chat_id,)).fetchone()[0]
    if msg_count == 1:
        title = message[:40] + ("..." if len(message) > 40 else "")
        con.execute("UPDATE ai_chats SET title=?, updated_at=? WHERE id=?", (title, now, chat_id))
    else:
        con.execute("UPDATE ai_chats SET updated_at=? WHERE id=?", (now, chat_id))

    con.commit()
    con.close()

    new_limits = _get_ai_limits(uid)
    return {"reply": reply, "limits": new_limits}



@app.post("/api/ai/chats/{chat_id}/send_vision")
def api_ai_vision_send(request: Request, chat_id: int, payload: Dict[str, Any] = Body(...)):
    """Send message with image to AI assistant (vision)."""
    u = require_user(request)
    uid = int(u["id"])
    message = (payload.get("message") or "").strip() or "Что изображено на скриншоте?"
    image_b64 = (payload.get("image_base64") or "").strip()
    image_mime = (payload.get("image_mime") or "image/jpeg").strip()
    use_site_context = payload.get("site_context", False)

    if not image_b64:
        raise HTTPException(status_code=400, detail="Изображение обязательно")

    con = db_conn()
    chat = con.execute("SELECT id FROM ai_chats WHERE id=? AND user_id=?", (chat_id, uid)).fetchone()
    if not chat:
        con.close()
        raise HTTPException(status_code=404, detail="Чат не найден")

    limits = _get_ai_limits(uid)
    if limits["messages_used"] >= limits["max_messages"]:
        con.close()
        raise HTTPException(status_code=403, detail="Лимит сообщений исчерпан")

    now = datetime.datetime.utcnow().isoformat()
    user_msg_text = f"[Пользователь прислал изображение] {message}"
    con.execute("INSERT INTO ai_chat_msgs(chat_id, role, content, created_at) VALUES(?,?,?,?)", (chat_id, "user", user_msg_text, now))

    system = RBX_SITE_CONTEXT if use_site_context else "Ты дружелюбный AI-ассистент. Отвечай кратко и по делу на русском языке."

    reply = "Не могу обработать изображение прямо сейчас."
    try:
        # Use pollinations OpenAI vision via GPT-4o-mini compatible endpoint
        vision_payload = {
            "model": "openai",
            "messages": [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": message or "Опиши что на изображении"},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{image_mime};base64,{image_b64}"
                            }
                        }
                    ]
                }
            ],
            "max_tokens": 800,
            "stream": False
        }
        r = requests.post(POLLINATIONS_OPENAI_URL, json=vision_payload, timeout=90)
        if r.status_code == 200:
            j = r.json()
            reply = j["choices"][0]["message"]["content"]
        else:
            raise Exception(f"Status {r.status_code}: {r.text[:200]}")
    except Exception as e1:
        # Fallback: describe image via Groq llama-3.2-vision if key available
        try:
            groq_key = os.environ.get("GROQ_API_KEY", "")
            if groq_key:
                import json as _json
                groq_payload = {
                    "model": "llama-3.2-11b-vision-preview",
                    "messages": [
                        {"role": "user", "content": [
                            {"type": "text", "text": f"{system}\n\nПользователь: {message}"},
                            {"type": "image_url", "image_url": {"url": f"data:{image_mime};base64,{image_b64}"}}
                        ]}
                    ],
                    "max_tokens": 800
                }
                gr = requests.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
                    json=groq_payload, timeout=60
                )
                if gr.status_code == 200:
                    reply = gr.json()["choices"][0]["message"]["content"]
                else:
                    raise Exception(f"Groq vision error: {gr.status_code}")
            else:
                raise Exception("No groq key for vision")
        except Exception as e2:
            reply = f"Я вижу, что вы прислали изображение, но сейчас не могу его обработать. {message}"

    con.execute("INSERT INTO ai_chat_msgs(chat_id, role, content, created_at) VALUES(?,?,?,?)", (chat_id, "assistant", reply, now))
    msg_count = con.execute("SELECT COUNT(*) FROM ai_chat_msgs WHERE chat_id=? AND role='user'", (chat_id,)).fetchone()[0]
    if msg_count == 1:
        title = (message or "Изображение")[:40]
        con.execute("UPDATE ai_chats SET title=?, updated_at=? WHERE id=?", (title, now, chat_id))
    else:
        con.execute("UPDATE ai_chats SET updated_at=? WHERE id=?", (now, chat_id))
    con.commit()
    con.close()
    new_limits = _get_ai_limits(uid)
    return {"reply": reply, "limits": new_limits}

@app.post("/api/notifications/delete")
def notifications_delete(request: Request, payload: Dict[str, Any] = Body(...)):
    """Delete one or all notifications for the current user."""
    u = require_user(request)
    uid = int(u["id"])
    notif_id = payload.get("id")
    delete_all = bool(payload.get("all") or False)
    con = db_conn()
    if delete_all:
        con.execute("DELETE FROM user_notifications WHERE user_id=?", (uid,))
    elif notif_id:
        con.execute("DELETE FROM user_notifications WHERE user_id=? AND id=?", (uid, int(notif_id)))
    con.commit(); con.close()
    return {"ok": True}


# ── Site Visual Editor ────────────────────────────────────────────
SITE_CUSTOM_KEY = "site_visual_custom"

def _get_site_custom(con=None) -> dict:
    close = con is None
    if close:
        con = db_conn()
    try:
        row = con.execute("SELECT value FROM site_kv WHERE key=?", (SITE_CUSTOM_KEY,)).fetchone()
        if row:
            return json.loads(_rget(row, "value") or "{}")
    except Exception:
        pass
    finally:
        if close:
            con.close()
    return {"elements": {}, "global_css": "", "version": 1}

@app.get("/api/admin/site_custom")
def api_get_site_custom(request: Request):
    """Get all site visual customizations."""
    require_admin(request)
    data = _get_site_custom()
    return {"ok": True, "custom": data}

@app.post("/api/admin/site_custom")
def api_save_site_custom(request: Request, payload: Dict[str, Any] = Body(...)):
    """Save site visual customizations."""
    require_admin(request)
    custom = payload.get("custom") or {}
    # Validate structure
    if not isinstance(custom, dict):
        raise HTTPException(status_code=400, detail="Invalid custom data")
    elements = custom.get("elements") or {}
    if not isinstance(elements, dict):
        raise HTTPException(status_code=400, detail="Invalid elements")
    # Limit size
    value = json.dumps({"elements": elements, "global_css": str(custom.get("global_css",""))[:5000], "version": 1})
    if len(value) > 200_000:
        raise HTTPException(status_code=400, detail="Too much data")
    con = db_conn()
    try:
        con.execute(
            "INSERT INTO site_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (SITE_CUSTOM_KEY, value)
        )
    except Exception:
        con.execute("INSERT OR REPLACE INTO site_kv(key,value) VALUES(?,?)", (SITE_CUSTOM_KEY, value))
    con.commit()
    con.close()
    return {"ok": True}

@app.get("/api/site_custom")
def api_get_site_custom_public(request: Request):
    """Public endpoint — returns site customizations for injection."""
    data = _get_site_custom()
    return {"ok": True, "custom": data}
