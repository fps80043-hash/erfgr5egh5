import os
import re
import datetime
import random
import sqlite3

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(title="R$T Web")
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")


# Optional Postgres (Render)
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.lower().startswith("postgres")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except Exception:
    psycopg2 = None
    RealDictCursor = None

import json
import hashlib
import hmac
import secrets
import base64
from typing import Any, Dict, List, Tuple, Optional

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jose import jwt, JWTError

# Stripe (real payments)
try:
    import stripe
except Exception:
    stripe = None

# ----------------------------
# Config
# ----------------------------
DEFAULT_TIMEOUT = 30

BUILD_VERSION = os.environ.get("BUILD_VERSION", "5.3.15")

# Auth / DB
DB_PATH = os.environ.get("DB_PATH", "data.db")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
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
        urow = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
        oldb = int(_rget(urow, "balance") or 0) if urow else 0
        con.execute("UPDATE users SET balance=? WHERE id=?", (oldb + points, uid))
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
    urow = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
    oldb = int(_rget(urow, "balance") or 0) if urow else 0
    con.execute("UPDATE users SET balance=? WHERE id=?", (oldb + points, uid))
    con.execute(
        "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
        (uid, admin_id, points, reason or f"topup {topup_id}", ts),
    )
    return True

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
                "accepted_assets": CRYPTO_PAY_ACCEPTED_ASSETS,
                "min_fiat_cents": CRYPTO_PAY_MIN_FIAT_CENTS,
            },
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
    try:
        points = int(payload.get("points") or 0)
    except Exception:
        points = 0
    if points not in TOPUP_PACKS:
        raise HTTPException(status_code=400, detail=f"Invalid pack. Allowed: {TOPUP_PACKS}")

    if method not in ("crypto", "manual"):
        raise HTTPException(status_code=400, detail="method must be crypto or manual")

    con = db_conn()

    if method == "manual":
        tid = _insert_topup_row(con, int(u["id"]), "manual", "manual", points, 0, None, "pending", {"note": "manual topup request"})
        con.commit(); con.close()
        return {"ok": True, "id": tid, "status": "pending", "method": "manual"}

    # crypto
    if not cryptopay_enabled():
        con.close()
        raise HTTPException(status_code=500, detail="Crypto Pay is not configured")

    fiat_cents = _points_to_fiat_cents(points)
    tid = _insert_topup_row(con, int(u["id"]), "cryptopay", "crypto", points, fiat_cents, CRYPTO_PAY_FIAT, "pending", {"assets": CRYPTO_PAY_ACCEPTED_ASSETS})
    # Create invoice
    amount_str = _cents_to_amount_str(fiat_cents)
    desc = f"RST Balance Top-up ({points} pts)"
    try:
        inv = _cryptopay_call("createInvoice", {
            "amount": amount_str,
            "currency_type": "fiat",
            "fiat": CRYPTO_PAY_FIAT,
            "accepted_assets": ",".join(CRYPTO_PAY_ACCEPTED_ASSETS) if CRYPTO_PAY_ACCEPTED_ASSETS else None,
            "description": desc,
            "payload": str(tid),
            "allow_comments": False,
            "allow_anonymous": True,
        })
    except Exception as e:
        # mark failed
        ts = _now_utc_iso()
        con.execute("UPDATE topups SET status=?, meta=?, updated_at=? WHERE id=?", ("failed", json.dumps({"err": str(e)}), ts, tid))
        con.commit(); con.close()
        raise

    invoice_id = str(inv.get("invoice_id") or inv.get("id") or "")
    pay_url = inv.get("web_app_invoice_url") or inv.get("bot_invoice_url") or inv.get("pay_url") or ""
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
    return {"ok": True, "id": int(id), "status": status, "pay_url": pay_url, "points": points}

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
    row = con.execute("SELECT code, points, max_uses, uses FROM promo_codes WHERE code=?", (code,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Invalid promo code")

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
    # credit balance
    urow = con.execute("SELECT balance FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    oldb = int(_rget(urow, "balance") or 0) if urow else 0
    con.execute("UPDATE users SET balance=? WHERE id=?", (oldb + points, int(u["id"])))
    con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(u["id"]), None, points, f"promo {code}", ts))
    con.commit()
    con.close()
    return {"ok": True, "credited": points}

@app.post("/api/subscription/buy")
def api_subscription_buy(request: Request, payload: Dict[str, Any] = None):
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT balance, premium_until FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="User not found")
    bal = int(_rget(row, "balance") or 0)
    if bal < PREMIUM_PRICE_POINTS:
        con.close()
        raise HTTPException(status_code=400, detail="Not enough balance")

    now = _now_utc()
    cur_pu = _parse_iso(_rget(row, "premium_until") or "")
    base = cur_pu if (cur_pu and cur_pu > now) else now
    new_until = (base + datetime.timedelta(days=PREMIUM_PERIOD_DAYS)).isoformat()

    ts = _now_utc_iso()
    con.execute("UPDATE users SET balance=?, premium_until=? WHERE id=?", (bal - PREMIUM_PRICE_POINTS, new_until, int(u["id"])))
    con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(u["id"]), None, -PREMIUM_PRICE_POINTS, "premium buy", ts))
    con.commit()
    con.close()
    return {"ok": True, "premium_until": new_until}

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
        points = int(payload.get("points") or 0)
    except Exception:
        points = 0
    if points <= 0:
        raise HTTPException(status_code=400, detail="points must be > 0")
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
            "INSERT INTO promo_codes(code, points, max_uses, uses, created_by, created_at) VALUES(?,?,?,?,?,?)",
            (code, points, max_uses, 0, int(admin["id"]), ts),
        )
        con.commit()
    except Exception:
        con.close()
        raise HTTPException(status_code=400, detail="Promo code already exists")
    con.close()
    return {"ok": True, "code": code, "points": points, "max_uses": max_uses}

@app.get("/api/admin/promo/list")
def api_admin_promo_list(request: Request, limit: int = 100):
    admin = require_admin(request)
    limit = max(1, min(int(limit or 100), 500))
    con = db_conn()
    rows = con.execute("SELECT code, points, max_uses, uses, created_at FROM promo_codes ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    con.close()
    items = []
    for r in rows or []:
        items.append({
            "code": str(_rget(r, "code") or ""),
            "points": int(_rget(r, "points") or 0),
            "uses": int(_rget(r, "uses") or 0),
            "max_uses": int(_rget(r, "max_uses") or 0),
            "created_at": str(_rget(r, "created_at") or ""),
        })
    return {"ok": True, "items": items}

async def _cryptopay_webhook_impl(request: Request, token: Optional[str] = None):
    raw = await request.body()
    if CRYPTO_PAY_WEBHOOK_TOKEN:
        # if token path used, enforce match
        if token is not None and token != CRYPTO_PAY_WEBHOOK_TOKEN:
            raise HTTPException(status_code=403, detail="Invalid webhook token")
    sig = (request.headers.get("crypto-pay-api-signature") or "").strip()
    if not _cryptopay_verify_signature(raw, sig):
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

    con = db_conn()
    row = con.execute("SELECT id, status FROM topups WHERE provider=? AND invoice_id=?", ("cryptopay", inv_id)).fetchone()
    if not row:
        con.close()
        return {"ok": True}
    tid = int(_rget(row, "id") or 0)
    ts = _now_utc_iso()

    if upd in ("invoice_failed", "invoice_expired"):
        con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=?", ("failed" if upd=="invoice_failed" else "expired", ts, tid))
        con.commit(); con.close()
        return {"ok": True}

    # paid
    con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=?", ("paid", ts, tid))
    _credit_topup_once(con, tid, None, f"cryptopay invoice {inv_id}")
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/pay/cryptopay/webhook")
async def api_cryptopay_webhook(request: Request):
    return await _cryptopay_webhook_impl(request, None)

@app.post("/api/pay/cryptopay/webhook/{token}")
async def api_cryptopay_webhook_token(request: Request, token: str):
    return await _cryptopay_webhook_impl(request, token)


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

BALANCE_PER_CURRENCY = int(os.environ.get("BALANCE_PER_CURRENCY", "100") or 100)  # points per 1.00 currency
if BALANCE_PER_CURRENCY <= 0:
    BALANCE_PER_CURRENCY = 100

# Premium subscription (monthly)
STRIPE_PREMIUM_PRICE_ID = (os.environ.get("STRIPE_PREMIUM_PRICE_ID") or "").strip()
STRIPE_PREMIUM_PRICE_CENTS = int(os.environ.get("STRIPE_PREMIUM_PRICE_CENTS", "499") or 499)
if STRIPE_PREMIUM_PRICE_CENTS < 50:
    STRIPE_PREMIUM_PRICE_CENTS = 499

# ----------------------------
# Top-ups (CryptoBot / Crypto Pay) + Premium by balance
# ----------------------------
CRYPTO_PAY_TOKEN = (os.environ.get("CRYPTO_PAY_TOKEN") or os.environ.get("CRYPTOPAY_TOKEN") or "").strip()
CRYPTO_PAY_BASE_URL = (os.environ.get("CRYPTO_PAY_BASE_URL") or "https://pay.crypt.bot/api").strip().rstrip("/")
CRYPTO_PAY_FIAT = (os.environ.get("CRYPTO_PAY_FIAT") or "USD").strip().upper()
CRYPTO_PAY_ACCEPTED_ASSETS_RAW = os.environ.get("CRYPTO_PAY_ACCEPTED_ASSETS", "USDT,TON")
CRYPTO_PAY_ACCEPTED_ASSETS = [a.strip().upper() for a in CRYPTO_PAY_ACCEPTED_ASSETS_RAW.split(",") if a.strip()]
CRYPTO_PAY_WEBHOOK_TOKEN = (os.environ.get("CRYPTO_PAY_WEBHOOK_TOKEN") or "").strip()
CRYPTO_PAY_MIN_FIAT_CENTS = int(os.environ.get("CRYPTO_PAY_MIN_FIAT_CENTS", "100") or 100)  # 1.00 fiat by default

PREMIUM_PRICE_POINTS = int(os.environ.get("PREMIUM_PRICE_POINTS", "499") or 499)
PREMIUM_PERIOD_DAYS = int(os.environ.get("PREMIUM_PERIOD_DAYS", "30") or 30)
if PREMIUM_PRICE_POINTS < 1:
    PREMIUM_PRICE_POINTS = 499
if PREMIUM_PERIOD_DAYS < 1:
    PREMIUM_PERIOD_DAYS = 30

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
    url = f"{CRYPTO_PAY_BASE_URL}/{method.lstrip('/')}"
    r = requests.post(url, headers=_cryptopay_headers(), data=json.dumps(params or {}), timeout=DEFAULT_TIMEOUT)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Crypto Pay error: {r.status_code} {r.text[:300]}")
    try:
        j = r.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Crypto Pay invalid JSON response")
    if not j.get("ok"):
        raise HTTPException(status_code=502, detail=f"Crypto Pay not ok: {str(j)[:200]}")
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
# Brevo (email verification / reset)
BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email"
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "")
BREVO_SENDER_EMAIL = os.environ.get("BREVO_SENDER_EMAIL", "")
BREVO_SENDER_NAME = os.environ.get("BREVO_SENDER_NAME", "RST")
OTP_TTL_MINUTES = int(os.environ.get("OTP_TTL_MINUTES", "10"))
OTP_MAX_ATTEMPTS = int(os.environ.get("OTP_MAX_ATTEMPTS", "5"))

def send_brevo_email(to_email: str, subject: str, text_content: str, html_content: str = ""):
    if not BREVO_API_KEY:
        raise HTTPException(status_code=500, detail="Brevo is not configured (BREVO_API_KEY)")
    if not BREVO_SENDER_EMAIL:
        raise HTTPException(status_code=500, detail="Brevo sender is not configured (BREVO_SENDER_EMAIL)")
    payload = {
        "sender": {"name": BREVO_SENDER_NAME, "email": BREVO_SENDER_EMAIL},
        "to": [{"email": to_email}],
        "subject": subject,
        "textContent": text_content,
    }
    if html_content:
        payload["htmlContent"] = html_content
    r = requests.post(
        BREVO_EMAIL_URL,
        headers={"api-key": BREVO_API_KEY, "Content-Type": "application/json", "accept": "application/json"},
        data=json.dumps(payload),
        timeout=DEFAULT_TIMEOUT,
    )
    if r.status_code not in (200, 201, 202):
        raise HTTPException(status_code=502, detail=f"Brevo error: {r.status_code} {r.text[:300]}")

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

# ----------------------------
# DB helpers
# ----------------------------
class _PGResult:
    def __init__(self, rows):
        self._rows = rows or []
    def fetchone(self):
        return self._rows[0] if self._rows else None
    def fetchall(self):
        return self._rows

class _PGConn:
    def __init__(self, conn):
        self._conn = conn
    def execute(self, q, params=()):
        q = q.replace("?", "%s")
        q_strip = q.lstrip().lower()
        with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(q, params)
            if q_strip.startswith("select") or " returning " in q_strip:
                try:
                    rows = cur.fetchall()
                except Exception:
                    rows = []
                return _PGResult(rows)
            return _PGResult([])
    def commit(self):
        self._conn.commit()
    def close(self):
        self._conn.close()

def db_conn():
    """Returns a connection-like object with .execute/.commit/.close.

    - SQLite by default for local dev
    - Postgres when DATABASE_URL is present (Render)
    """
    if USE_PG:
        if psycopg2 is None:
            raise RuntimeError("psycopg2 is not installed, but DATABASE_URL is set")
        conn = psycopg2.connect(DATABASE_URL)
        return _PGConn(conn)

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con
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
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_ai INTEGER NOT NULL DEFAULT 1")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS case_next_at TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0")

        # moderation / audit fields
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_country TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_city TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TEXT")


        # Stripe subscription fields
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sub_id TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sub_status TEXT")
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sub_period_end TEXT")

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

        # Promo codes (FanPay / manual sales)
        con.execute("""
            CREATE TABLE IF NOT EXISTS promo_codes(
              code TEXT PRIMARY KEY,
              points INTEGER NOT NULL,
              max_uses INTEGER NOT NULL DEFAULT 1,
              uses INTEGER NOT NULL DEFAULT 0,
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
        con.execute("ALTER TABLE users ADD COLUMN credits_ai INTEGER NOT NULL DEFAULT 1")
    if "premium_until" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN premium_until TEXT")
    if "case_next_at" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN case_next_at TEXT")
    if "balance" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0")
    if "is_admin" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")

    # Migrations: moderation / audit fields
    cols = [r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "banned_until" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN banned_until TEXT")
    if "ban_reason" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN ban_reason TEXT")
    if "last_ip" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN last_ip TEXT")
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

    # simple IP -> Geo cache (best-effort)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ip_geo_cache(
          ip TEXT PRIMARY KEY,
          country TEXT,
          city TEXT,
          fetched_at TEXT NOT NULL
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

    con.commit()
    con.close()
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
        "SELECT credits_analyze, credits_ai, premium_until, case_next_at FROM users WHERE id=?",
        (uid,),
    ).fetchone()
    con.close()
    if not row:
        return {"credits_analyze": 0, "credits_ai": 0, "premium_until": None, "premium": False, "case_next_at": None}
    pu = _parse_iso(_rget(row, "premium_until") or "")
    premium = bool(pu and _now_utc() < pu)
    return {
        "credits_analyze": int(_rget(row, "credits_analyze") or 0),
        "credits_ai": int(_rget(row, "credits_ai") or 0),
        "premium_until": (_rget(row, "premium_until") or None),
        "premium": premium,
        "case_next_at": (_rget(row, "case_next_at") or None),
    }

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
    row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at FROM users WHERE id=?", (uid,)).fetchone()
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

def _touch_user_seen(uid: int, request: Request):
    ip = _client_ip(request)
    if not ip:
        return
    con = db_conn()
    try:
        country, city = _geo_cached(con, ip)
        con.execute(
            "UPDATE users SET last_ip=?, last_country=?, last_city=?, last_seen_at=? WHERE id=?",
            (ip, country, city, _now_utc_iso(), int(uid)),
        )
        con.commit()
    finally:
        con.close()

def _check_user_ban(uid: int):
    con = db_conn()
    row = con.execute("SELECT banned_until, ban_reason FROM users WHERE id=?", (int(uid),)).fetchone()
    con.close()
    if not row:
        return
    bu = _parse_iso(str(_rget(row, "banned_until") or ""))
    if bu and _now_utc() < bu:
        reason = str(_rget(row, "ban_reason") or "").strip() or "Banned"
        raise HTTPException(status_code=403, detail=f"banned:{reason}")
# ----------------------------
# Template helpers
# ----------------------------
class SafeDict(dict):
    def __missing__(self, key):
        return "{" + key + "}"

def safe_format(tpl: str, data: Dict[str, Any]) -> str:
    try:
        return tpl.format_map(SafeDict(**data))
    except Exception:
        return tpl

def clamp(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[:n]

def extract_title_desc(text: str) -> Tuple[str, str]:
    if not text:
        return "", ""
    t = text.strip().replace("```", "").strip()
    lines = t.splitlines()

    title = ""
    desc = ""

    t_idx = None
    d_idx = None
    for i, line in enumerate(lines):
        low = line.strip().lower()
        if t_idx is None and low.startswith("title:"):
            t_idx = i
        if d_idx is None and low.startswith("desc:"):
            d_idx = i

    if t_idx is not None:
        title = lines[t_idx].split(":", 1)[1].strip()
    if d_idx is not None:
        after = lines[d_idx].split(":", 1)
        if len(after) == 2 and after[1].strip():
            desc = after[1].strip()
            if d_idx + 1 < len(lines):
                desc += "\n" + "\n".join(lines[d_idx + 1:]).rstrip()
        else:
            desc = "\n".join(lines[d_idx + 1:]).rstrip()

    if title or desc:
        return title, desc

    if len(lines) == 1:
        return lines[0].strip(), ""
    return lines[0].strip(), "\n".join(lines[1:]).strip()

# ----------------------------
# Providers
# ----------------------------
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
    r = requests.post(POLLINATIONS_OPENAI_URL, json=payload, timeout=DEFAULT_TIMEOUT)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Pollinations error: {r.status_code} {r.text[:300]}")
    j = r.json()
    try:
        return j["choices"][0]["message"]["content"]
    except Exception:
        if isinstance(j, dict) and "text" in j:
            return str(j["text"])
        return r.text

def groq_chat(api_key: str, model: str, system: str, user: str, temperature: float = 0.9, max_tokens: int = 900) -> str:
    if not api_key:
        raise HTTPException(status_code=400, detail="GROQ_API_KEY is missing")
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
        timeout=DEFAULT_TIMEOUT,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Groq error: {r.status_code} {r.text[:300]}")
    j = r.json()
    return j["choices"][0]["message"]["content"]

def provider_chat(provider: str, model: str, system: str, user: str) -> str:
    provider = (provider or "pollinations").lower()
    model = model or "default"
    if provider == "blackbox":
        api_key = os.environ.get("BLACKBOX_API_KEY", "")
        return blackbox_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.9, max_tokens=800)
    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        return groq_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.9, max_tokens=800)
    # default pollinations
    return pollinations_chat(model=model, system=system, user=user, temperature=0.9, max_tokens=800)

def blackbox_chat(api_key: str, model: str, system: str, user: str, temperature: float = 0.9, max_tokens: int = 900) -> str:
    if not api_key:
        raise HTTPException(status_code=400, detail="BLACKBOX_API_KEY is missing")
    payload = {
        "model": model or "blackboxai/deepseek/deepseek-chat",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    r = requests.post(
        BLACKBOX_CHAT_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=DEFAULT_TIMEOUT,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"BlackBox error: {r.status_code} {r.text[:300]}")
    j = r.json()
    return j["choices"][0]["message"]["content"]

# ----------------------------
# Business logic
# ----------------------------
def build_sales_rule(mode: str, tone: str) -> str:
    mode_map = {
        "Рерайт": "Сохрани смысл и факты, сделай текст более продающим.",
        "Креатив": "Сохрани факты, но добавь креатив, эмоции и сильнее продай ценность.",
        "С нуля": "Сгенерируй объявление с нуля по фактам аккаунта.",
    }
    tone_map = {
        "Классика": "Уверенный продающий стиль без кринжа. Немного эмодзи.",
        "Люкс": "Премиум-стиль: редкость, статус, богатство аккаунта, уникальность. Красиво и дорого.",
        "Минимал": "Коротко, по фактам. Минимум воды и эмодзи.",
        "Доверие": "Прозрачность и доверие: чек-лист, гарантия, спокойный тон.",
    }
    return f"{mode_map.get(mode, mode_map['Рерайт'])}\n{tone_map.get(tone, tone_map['Классика'])}"

def roblox_analyze(cookie: str) -> Dict[str, Any]:
    cookie = (cookie or "")
    if not cookie.strip():
        raise HTTPException(status_code=400, detail="cookie is required")

    s = requests.Session()
    # do NOT trim/modify
    s.cookies[".ROBLOSECURITY"] = cookie

    r = s.get(RBX_AUTH, timeout=DEFAULT_TIMEOUT)
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Bad cookie (auth failed)")
    info = r.json() or {}
    uid = info.get("id")
    uname = info.get("name")
    if not uid:
        raise HTTPException(status_code=401, detail="Bad cookie (no user id)")

    rap_total = 0
    items: List[Tuple[str, int]] = []
    cur = ""
    for _ in range(25):
        rr = s.get(RBX_COLLECT.format(uid=uid, cur=cur), timeout=DEFAULT_TIMEOUT)
        if rr.status_code != 200:
            break
        jj = rr.json() or {}
        for it in jj.get("data", []) or []:
            rap = it.get("recentAveragePrice") or 0
            name = it.get("name") or it.get("assetName") or ""
            try:
                rap_int = int(rap) if rap is not None else 0
            except Exception:
                rap_int = 0
            rap_total += rap_int
            if name:
                items.append((name, rap_int))
        cur = jj.get("nextPageCursor") or ""
        if not cur:
            break

    donate_total = 0
    cur = ""
    for _ in range(25):
        rr = s.get(RBX_TX.format(uid=uid, cur=cur), timeout=DEFAULT_TIMEOUT)
        if rr.status_code != 200:
            break
        jj = rr.json() or {}
        for it in jj.get("data", []) or []:
            cur_obj = it.get("currency") or {}
            amt = cur_obj.get("amount", it.get("amount"))
            try:
                donate_total += abs(int(amt))
            except Exception:
                pass
        cur = jj.get("nextPageCursor") or ""
        if not cur:
            break

    robux = 0
    try:
        robux = int((s.get(RBX_ROBUX.format(uid=uid), timeout=DEFAULT_TIMEOUT).json() or {}).get("robux", 0))
    except Exception:
        robux = 0

    created_year = ""
    try:
        u = s.get(RBX_USER.format(uid=uid), timeout=DEFAULT_TIMEOUT).json() or {}
        created = str(u.get("created", ""))
        if created[:4].isdigit():
            created_year = created[:4]
    except Exception:
        created_year = ""

    year_tag = f"{created_year}Г" if created_year and int(created_year) <= 2017 else "NEW"
    donate_tag = f"{int(donate_total/1000)}K" if donate_total >= 1000 else str(donate_total)
    rap_tag = f"{int(rap_total/1000)}K" if rap_total >= 1000 else str(rap_total)

    inv_ru = "Скрыт"
    if items:
        items_sorted = sorted(items, key=lambda x: x[1], reverse=True)[:10]
        lines = []
        for nm, rp in items_sorted:
            lines.append(f"{nm} ({rp} RAP)" if rp > 0 else nm)
        inv_ru = " / ".join(lines)

    return {
        "user_id": uid,
        "username": uname or "",
        "profile_link": f"https://www.roblox.com/users/{uid}/profile",
        "robux": robux,
        "rap": rap_total,
        "rap_tag": rap_tag,
        "total": donate_total,
        "donate_tag": donate_tag,
        "year": created_year,
        "year_tag": year_tag,
        "inv_ru": inv_ru,
    }

# ----------------------------
# App
# ----------------------------

@app.middleware("http")
async def add_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path or ""
    # HTML: never cache (Cloudflare/browser)
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    # Static: long cache (we use versioned filenames)
    elif path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response



@app.on_event("startup")
def _startup():
    db_init()
    sync_admin_users()

templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    resp = templates.TemplateResponse("index.html", {"request": request})
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.get("/api/version")
def api_version():
    return {"ok": True, "version": BUILD_VERSION}

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

    con = db_conn()
    row = con.execute("SELECT username, email, balance, is_admin FROM users WHERE id=?", (u["id"],)).fetchone()
    # env fallback: allow making new users admins without restart
    db_admin = int(_rget(row, "is_admin") or 0) if row else 0
    env_admin = ((u["username"] or "").lower() in ADMIN_USERS_LC)
    is_admin = 1 if (db_admin == 1 or env_admin) else 0
    if env_admin and db_admin != 1:
        try:
            con.execute("UPDATE users SET is_admin=1 WHERE id=?", (u["id"],))
            con.commit()
        except Exception:
            pass
    con.close()

    lim = user_limits(int(u["id"]))
    return {"ok": True, "user": {
        "username": (str(_rget(row, "username") or (u["username"] or "")) if row else (u["username"] or "")),
        "email": (_rget(row, "email") if row else ""),
        "balance": int(_rget(row, "balance") or 0),
        "is_admin": is_admin,
        "limits": lim,
    }}

@app.get("/api/balance")
def api_balance(request: Request):
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT balance FROM users WHERE id=?", (u["id"],)).fetchone()
    con.close()
    return {"ok": True, "balance": int(_rget(row, "balance") or 0)}




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
        urow = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
        oldb = int(_rget(urow, "balance") or 0) if urow else 0
        con.execute("UPDATE users SET balance=? WHERE id=?", (oldb + points, uid))
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
    urow = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
    oldb = int(_rget(urow, "balance") or 0) if urow else 0
    con.execute("UPDATE users SET balance=? WHERE id=?", (oldb + points, uid))
    con.execute(
        "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
        (uid, admin_id, points, reason or f"topup {topup_id}", ts),
    )
    return True

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
                "accepted_assets": CRYPTO_PAY_ACCEPTED_ASSETS,
                "min_fiat_cents": CRYPTO_PAY_MIN_FIAT_CENTS,
            },
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
    try:
        points = int(payload.get("points") or 0)
    except Exception:
        points = 0
    if points not in TOPUP_PACKS:
        raise HTTPException(status_code=400, detail=f"Invalid pack. Allowed: {TOPUP_PACKS}")

    if method not in ("crypto", "manual"):
        raise HTTPException(status_code=400, detail="method must be crypto or manual")

    con = db_conn()

    if method == "manual":
        tid = _insert_topup_row(con, int(u["id"]), "manual", "manual", points, 0, None, "pending", {"note": "manual topup request"})
        con.commit(); con.close()
        return {"ok": True, "id": tid, "status": "pending", "method": "manual"}

    # crypto
    if not cryptopay_enabled():
        con.close()
        raise HTTPException(status_code=500, detail="Crypto Pay is not configured")

    fiat_cents = _points_to_fiat_cents(points)
    tid = _insert_topup_row(con, int(u["id"]), "cryptopay", "crypto", points, fiat_cents, CRYPTO_PAY_FIAT, "pending", {"assets": CRYPTO_PAY_ACCEPTED_ASSETS})
    # Create invoice
    amount_str = _cents_to_amount_str(fiat_cents)
    desc = f"RST Balance Top-up ({points} pts)"
    try:
        inv = _cryptopay_call("createInvoice", {
            "amount": amount_str,
            "currency_type": "fiat",
            "fiat": CRYPTO_PAY_FIAT,
            "accepted_assets": ",".join(CRYPTO_PAY_ACCEPTED_ASSETS) if CRYPTO_PAY_ACCEPTED_ASSETS else None,
            "description": desc,
            "payload": str(tid),
            "allow_comments": False,
            "allow_anonymous": True,
        })
    except Exception as e:
        # mark failed
        ts = _now_utc_iso()
        con.execute("UPDATE topups SET status=?, meta=?, updated_at=? WHERE id=?", ("failed", json.dumps({"err": str(e)}), ts, tid))
        con.commit(); con.close()
        raise

    invoice_id = str(inv.get("invoice_id") or inv.get("id") or "")
    pay_url = inv.get("web_app_invoice_url") or inv.get("bot_invoice_url") or inv.get("pay_url") or ""
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
    return {"ok": True, "id": int(id), "status": status, "pay_url": pay_url, "points": points}

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
    row = con.execute("SELECT code, points, max_uses, uses FROM promo_codes WHERE code=?", (code,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="Invalid promo code")

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
    # credit balance
    urow = con.execute("SELECT balance FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    oldb = int(_rget(urow, "balance") or 0) if urow else 0
    con.execute("UPDATE users SET balance=? WHERE id=?", (oldb + points, int(u["id"])))
    con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(u["id"]), None, points, f"promo {code}", ts))
    con.commit()
    con.close()
    return {"ok": True, "credited": points}

@app.post("/api/subscription/buy")
def api_subscription_buy(request: Request, payload: Dict[str, Any] = None):
    u = require_user(request)
    con = db_conn()
    row = con.execute("SELECT balance, premium_until FROM users WHERE id=?", (int(u["id"]),)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="User not found")
    bal = int(_rget(row, "balance") or 0)
    if bal < PREMIUM_PRICE_POINTS:
        con.close()
        raise HTTPException(status_code=400, detail="Not enough balance")

    now = _now_utc()
    cur_pu = _parse_iso(_rget(row, "premium_until") or "")
    base = cur_pu if (cur_pu and cur_pu > now) else now
    new_until = (base + datetime.timedelta(days=PREMIUM_PERIOD_DAYS)).isoformat()

    ts = _now_utc_iso()
    con.execute("UPDATE users SET balance=?, premium_until=? WHERE id=?", (bal - PREMIUM_PRICE_POINTS, new_until, int(u["id"])))
    con.execute("INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)", (int(u["id"]), None, -PREMIUM_PRICE_POINTS, "premium buy", ts))
    con.commit()
    con.close()
    return {"ok": True, "premium_until": new_until}

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
        points = int(payload.get("points") or 0)
    except Exception:
        points = 0
    if points <= 0:
        raise HTTPException(status_code=400, detail="points must be > 0")
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
            "INSERT INTO promo_codes(code, points, max_uses, uses, created_by, created_at) VALUES(?,?,?,?,?,?)",
            (code, points, max_uses, 0, int(admin["id"]), ts),
        )
        con.commit()
    except Exception:
        con.close()
        raise HTTPException(status_code=400, detail="Promo code already exists")
    con.close()
    return {"ok": True, "code": code, "points": points, "max_uses": max_uses}

@app.get("/api/admin/promo/list")
def api_admin_promo_list(request: Request, limit: int = 100):
    admin = require_admin(request)
    limit = max(1, min(int(limit or 100), 500))
    con = db_conn()
    rows = con.execute("SELECT code, points, max_uses, uses, created_at FROM promo_codes ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    con.close()
    items = []
    for r in rows or []:
        items.append({
            "code": str(_rget(r, "code") or ""),
            "points": int(_rget(r, "points") or 0),
            "uses": int(_rget(r, "uses") or 0),
            "max_uses": int(_rget(r, "max_uses") or 0),
            "created_at": str(_rget(r, "created_at") or ""),
        })
    return {"ok": True, "items": items}

async def _cryptopay_webhook_impl(request: Request, token: Optional[str] = None):
    raw = await request.body()
    if CRYPTO_PAY_WEBHOOK_TOKEN:
        # if token path used, enforce match
        if token is not None and token != CRYPTO_PAY_WEBHOOK_TOKEN:
            raise HTTPException(status_code=403, detail="Invalid webhook token")
    sig = (request.headers.get("crypto-pay-api-signature") or "").strip()
    if not _cryptopay_verify_signature(raw, sig):
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

    con = db_conn()
    row = con.execute("SELECT id, status FROM topups WHERE provider=? AND invoice_id=?", ("cryptopay", inv_id)).fetchone()
    if not row:
        con.close()
        return {"ok": True}
    tid = int(_rget(row, "id") or 0)
    ts = _now_utc_iso()

    if upd in ("invoice_failed", "invoice_expired"):
        con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=?", ("failed" if upd=="invoice_failed" else "expired", ts, tid))
        con.commit(); con.close()
        return {"ok": True}

    # paid
    con.execute("UPDATE topups SET status=?, updated_at=? WHERE id=?", ("paid", ts, tid))
    _credit_topup_once(con, tid, None, f"cryptopay invoice {inv_id}")
    con.commit(); con.close()
    return {"ok": True}

@app.post("/api/pay/cryptopay/webhook")
async def api_cryptopay_webhook(request: Request):
    return await _cryptopay_webhook_impl(request, None)

@app.post("/api/pay/cryptopay/webhook/{token}")
async def api_cryptopay_webhook_token(request: Request, token: str):
    return await _cryptopay_webhook_impl(request, token)


# ----------------------------
# Payments (Stripe)
# ----------------------------

@app.get("/api/pay/config")
def pay_config(request: Request):
    # Frontend uses this to decide whether to show Stripe buttons
    return {
        "ok": True,
        "stripe": {
            "enabled": stripe_enabled() and bool(STRIPE_PUBLISHABLE_KEY),
            "publishable_key": STRIPE_PUBLISHABLE_KEY,
            "currency": STRIPE_CURRENCY,
            "topup_packs": TOPUP_PACKS,
            "balance_per_currency": BALANCE_PER_CURRENCY,
            "premium": {
                "enabled": stripe_enabled(),
                "price_id": STRIPE_PREMIUM_PRICE_ID,
                "price_cents": STRIPE_PREMIUM_PRICE_CENTS,
                "interval": "month",
            },
        },
    }


@app.post("/api/pay/stripe/create")
def stripe_create_checkout(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    stripe_require()

    kind = (payload.get("kind") or "").strip().lower()
    if kind not in ("topup", "subscription"):
        raise HTTPException(status_code=400, detail="kind must be topup or subscription")

    base = _base_url(request)
    success_url = (payload.get("success_url") or "").strip() or (
        base + ("/?subscribed=1" if kind == "subscription" else "/?paid=1")
    )
    cancel_url = (payload.get("cancel_url") or "").strip() or (base + "/?canceled=1")

    created_at = _now_utc_iso()

    if kind == "topup":
        try:
            points = int(payload.get("points") or 0)
        except Exception:
            points = 0
        if points not in TOPUP_PACKS:
            raise HTTPException(status_code=400, detail=f"Invalid pack. Allowed: {TOPUP_PACKS}")

        cents = _points_to_cents(points)
        # Store as pending in DB (idempotent by session_id, but session is not created yet)
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": STRIPE_CURRENCY,
                    "unit_amount": cents,
                    "product_data": {"name": f"RST Balance Top-up ({points} pts)"},
                },
                "quantity": 1,
            }],
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={"uid": str(int(u["id"])), "kind": "topup", "points": str(points)},
        )

        con = db_conn()
        con.execute(
            "INSERT INTO payments(user_id,provider,kind,session_id,amount_points,amount_total,currency,status,meta,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at",
            (
                int(u["id"]),
                "stripe",
                "topup",
                str(session.id),
                int(points),
                int(cents),
                STRIPE_CURRENCY,
                "pending",
                json.dumps({"success_url": success_url, "cancel_url": cancel_url}),
                created_at,
                created_at,
            ),
        )
        con.commit()
        con.close()
        return {"ok": True, "url": session.url, "id": session.id}

    # subscription
    # If PRICE_ID is not configured, we create an inline recurring price.
    line_items = None
    if STRIPE_PREMIUM_PRICE_ID:
        line_items = [{"price": STRIPE_PREMIUM_PRICE_ID, "quantity": 1}]
    else:
        line_items = [{
            "price_data": {
                "currency": STRIPE_CURRENCY,
                "unit_amount": int(STRIPE_PREMIUM_PRICE_CENTS),
                "recurring": {"interval": "month"},
                "product_data": {"name": "RST Premium (Monthly)"},
            },
            "quantity": 1,
        }]

    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=line_items,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"uid": str(int(u["id"])), "kind": "subscription"},
        subscription_data={"metadata": {"uid": str(int(u["id"])), "kind": "premium"}},
    )

    con = db_conn()
    con.execute(
        "INSERT INTO payments(user_id,provider,kind,session_id,amount_points,amount_total,currency,status,meta,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at",
        (
            int(u["id"]),
            "stripe",
            "subscription",
            str(session.id),
            0,
            int(STRIPE_PREMIUM_PRICE_CENTS),
            STRIPE_CURRENCY,
            "pending",
            json.dumps({"success_url": success_url, "cancel_url": cancel_url}),
            created_at,
            created_at,
        ),
    )
    con.commit()
    con.close()
    return {"ok": True, "url": session.url, "id": session.id}


async def _fulfill_stripe_topup(session_id: str, uid: int, points: int, amount_total: int, currency: str):
    # Idempotent: if already paid -> do nothing
    con = db_conn()
    row = con.execute("SELECT status, amount_points FROM payments WHERE session_id=?", (session_id,)).fetchone()
    if row and str(_rget(row, "status") or "") == "paid":
        con.close()
        return

    # Update payment status
    ts = _now_utc_iso()
    con.execute(
        "INSERT INTO payments(user_id,provider,kind,session_id,amount_points,amount_total,currency,status,meta,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(session_id) DO UPDATE SET status=excluded.status, amount_points=excluded.amount_points, amount_total=excluded.amount_total, currency=excluded.currency, updated_at=excluded.updated_at",
        (uid, "stripe", "topup", session_id, int(points), int(amount_total or 0), str(currency or STRIPE_CURRENCY), "paid", "{}", ts, ts),
    )

    # Credit balance
    urow = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
    if urow:
        old_balance = int(_rget(urow, "balance") or 0)
        new_balance = old_balance + int(points)
        con.execute("UPDATE users SET balance=? WHERE id=?", (new_balance, uid))
        con.execute(
            "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
            (uid, None, int(points), f"stripe topup ({session_id})", ts),
        )
    con.commit()
    con.close()


async def _upsert_subscription_state(uid: int, customer_id: str, sub_id: str, status: str, period_end_iso: str):
    con = db_conn()
    con.execute(
        "UPDATE users SET stripe_customer_id=?, stripe_sub_id=?, stripe_sub_status=?, stripe_sub_period_end=?, premium_until=? WHERE id=?",
        (customer_id or None, sub_id or None, status or None, period_end_iso or None, period_end_iso or None, uid),
    )
    con.commit()
    con.close()


@app.post("/api/pay/stripe/webhook")
async def stripe_webhook(request: Request):
    stripe_require()
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=500, detail="Stripe webhook is not configured (STRIPE_WEBHOOK_SECRET)")

    payload = await request.body()
    sig = request.headers.get("stripe-signature") or ""
    try:
        event = stripe.Webhook.construct_event(payload=payload, sig_header=sig, secret=STRIPE_WEBHOOK_SECRET)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Stripe signature")

    et = event.get("type")

    if et == "checkout.session.completed":
        sess = event.get("data", {}).get("object", {}) or {}
        meta = sess.get("metadata") or {}
        kind = (meta.get("kind") or "").lower()
        try:
            uid = int(meta.get("uid") or 0)
        except Exception:
            uid = 0
        session_id = str(sess.get("id") or "")

        if kind == "topup" and uid > 0 and session_id:
            try:
                points = int(meta.get("points") or 0)
            except Exception:
                points = 0
            amount_total = int(sess.get("amount_total") or 0)
            currency = str(sess.get("currency") or STRIPE_CURRENCY)
            await _fulfill_stripe_topup(session_id, uid, points, amount_total, currency)

        if kind == "subscription" and uid > 0 and session_id:
            sub_id = str(sess.get("subscription") or "")
            customer_id = str(sess.get("customer") or "")
            # Mark payment as paid (idempotent)
            ts = _now_utc_iso()
            con = db_conn()
            con.execute(
                "INSERT INTO payments(user_id,provider,kind,session_id,amount_points,amount_total,currency,status,meta,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(session_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at",
                (uid, "stripe", "subscription", session_id, 0, int(STRIPE_PREMIUM_PRICE_CENTS), STRIPE_CURRENCY, "paid", "{}", ts, ts),
            )
            con.commit(); con.close()

            if sub_id:
                try:
                    sub = stripe.Subscription.retrieve(sub_id)
                    status = str(getattr(sub, "status", "") or "")
                    cpe = int(getattr(sub, "current_period_end", 0) or 0)
                    period_end_iso = datetime.datetime.utcfromtimestamp(cpe).isoformat() if cpe else None
                    if period_end_iso:
                        await _upsert_subscription_state(uid, customer_id, sub_id, status, period_end_iso)
                except Exception:
                    pass

    # Keep premium_until in sync on subscription changes
    if et in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        sub = event.get("data", {}).get("object", {}) or {}
        meta = sub.get("metadata") or {}
        sub_id = str(sub.get("id") or "")
        customer_id = str(sub.get("customer") or "")
        status = str(sub.get("status") or "")
        cpe = int(sub.get("current_period_end") or 0)
        period_end_iso = datetime.datetime.utcfromtimestamp(cpe).isoformat() if cpe else None

        uid = 0
        try:
            uid = int(meta.get("uid") or 0)
        except Exception:
            uid = 0
        if uid <= 0 and sub_id:
            # Fallback: find user by stored sub id
            con = db_conn()
            row = con.execute("SELECT id FROM users WHERE stripe_sub_id=?", (sub_id,)).fetchone()
            con.close()
            uid = int(_rget(row, "id") or 0) if row else 0

        if uid > 0 and period_end_iso:
            await _upsert_subscription_state(uid, customer_id, sub_id, status, period_end_iso)

    return {"ok": True}

@app.get("/api/admin/users")
def admin_users(request: Request, q: str = ""):
    require_admin(request)
    q = (q or "").strip().lower()
    con = db_conn()
    if q:
        like = f"%{q}%"
        rows = con.execute(
            "SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at FROM users WHERE lower(username) LIKE ? OR lower(email) LIKE ? ORDER BY id DESC LIMIT 25",
            (like, like),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at FROM users ORDER BY id DESC LIMIT 25"
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
        row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at FROM users WHERE id=?", (int(ident),)).fetchone()
    if not row and "@" in ident:
        row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at FROM users WHERE lower(email)=?", (ident.lower(),)).fetchone()
    if not row:
        row = con.execute("SELECT id, username, email, balance, is_admin, created_at, banned_until, ban_reason, last_ip, last_country, last_city, last_seen_at FROM users WHERE lower(username)=?", (ident.lower(),)).fetchone()
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
    new_balance = old_balance + delta
    if new_balance < 0:
        new_balance = 0
    applied_delta = new_balance - old_balance

    con.execute("UPDATE users SET balance=? WHERE id=?", (new_balance, user_id))
    con.execute(
        "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
        (user_id, int(admin["id"]), int(applied_delta), reason, datetime.datetime.utcnow().isoformat()),
    )
    con.commit()
    con.close()

    return {"ok": True, "user_id": user_id, "old_balance": old_balance, "new_balance": new_balance, "applied_delta": applied_delta}
@app.post("/api/auth/register_start")
def auth_register_start(payload: Dict[str, Any]):
    username = (payload.get("username") or "").strip()
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
    html = f"<div style='font-family:Arial,sans-serif'><h3>Код подтверждения</h3><p style='font-size:18px'><b>{code}</b></p><p>Действует {OTP_TTL_MINUTES} минут.</p></div>"
    send_brevo_email(email, "Код подтверждения регистрации", text, html)

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
        con.execute(
            "INSERT INTO users(username,password_hash,email,email_verified,created_at) VALUES(?,?,?,?,?)",
            (username, ph, email, 1, datetime.datetime.utcnow().isoformat()),
        )
        con.execute("DELETE FROM email_otps WHERE id=?", (row["id"],))
        con.commit()
    except Exception as e:
        # SQLite / Postgres unique violations
        if isinstance(e, sqlite3.IntegrityError) or (USE_PG and psycopg2 is not None and isinstance(e, psycopg2.IntegrityError)):
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
@app.post("/api/auth/reset_start")
def auth_reset_start(payload: Dict[str, Any]):
    email = (payload.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Email is required")

    con = db_conn()
    u = con.execute("SELECT id, username FROM users WHERE email=?", (email,)).fetchone()
    # anti-enumeration: always respond ok
    if not u:
        con.close()
        return {"ok": True}

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
    html = f"<div style='font-family:Arial,sans-serif'><h3>Сброс пароля</h3><p style='font-size:18px'><b>{code}</b></p><p>Действует {OTP_TTL_MINUTES} минут.</p></div>"
    send_brevo_email(email, "Сброс пароля", text, html)

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


@app.post("/api/auth/login")
def auth_login(request: Request, payload: Dict[str, Any]):
    ident = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    if not ident:
        raise HTTPException(status_code=400, detail="Login is required")

    con = db_conn()
    # allow login by username or email
    if "@" in ident:
        row = con.execute("SELECT id, username, password_hash, banned_until, ban_reason FROM users WHERE lower(email)=?", (ident.strip().lower(),)).fetchone()
    else:
        row = con.execute("SELECT id, username, password_hash, banned_until, ban_reason FROM users WHERE username=?", (ident,)).fetchone()
    con.close()

    if not row or not verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Wrong login or password")

    bu = _parse_iso(str(_rget(row, "banned_until") or ""))
    if bu and _now_utc() < bu:
        reason = str(_rget(row, "ban_reason") or "").strip() or "Banned"
        raise HTTPException(status_code=403, detail=f"Banned: {reason}")

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

@app.get("/api/user/templates")
def user_templates_get(request: Request):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    con = db_conn()
    row = con.execute("SELECT title_tpl, desc_tpl FROM templates WHERE user_id=?", (u["id"],)).fetchone()
    con.close()
    if not row:
        return {"ok": True, "title_tpl": "", "desc_tpl": ""}
    return {"ok": True, "title_tpl": row["title_tpl"], "desc_tpl": row["desc_tpl"]}

@app.post("/api/user/templates")
def user_templates_set(request: Request, payload: Dict[str, Any]):
    u = get_current_user(request)
    if not u:
        raise HTTPException(status_code=401, detail="Not logged in")
    title_tpl = payload.get("title_tpl") or ""
    desc_tpl = payload.get("desc_tpl") or ""
    con = db_conn()
    con.execute(
        "INSERT INTO templates(user_id,title_tpl,desc_tpl,updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(user_id) DO UPDATE SET title_tpl=excluded.title_tpl, desc_tpl=excluded.desc_tpl, updated_at=excluded.updated_at",
        (u["id"], title_tpl, desc_tpl, datetime.datetime.utcnow().isoformat()),
    )
    con.commit()
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

CASE_PRIZES = [
    # Weights ~ out of 10k. Rare prize P7D ~= 1.5%
    ("GEN10", 2500),
    ("AI3",   2400),
    ("P6H",   1800),
    ("P12H",  1200),
    ("P24H",   700),
    ("P2D",    650),
    ("P3D",    600),
    ("P7D",    150),
]

# Paid case (balance) — no captcha, always available (cost in RUB points)
CASE_PAID_PRICE = 17

# Better odds than free case
CASE_PAID_PRIZES = [
    # same rare chance (P7D ~= 1.5%), but overall slightly better distribution for premium
    ("GEN10", 2350),
    ("AI3",   2300),
    ("P6H",   1900),
    ("P12H",  1300),
    ("P24H",   750),
    ("P2D",    700),
    ("P3D",    700),
    ("P7D",    150),
]


# ----------------------------
# Case inventory (store case prizes; user redeems when wants)
# ----------------------------
CASE_INV_MAX = 10

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
    """Apply a stored prize to user account. Premium prizes are blocked if premium is already active."""
    con = db_conn()
    # premium active?
    row = con.execute("SELECT premium_until FROM users WHERE id=?", (int(uid),)).fetchone()
    cur = _parse_iso((_rget(row, "premium_until") if row else "") or "")
    premium_active = bool(cur and _now_utc() < cur)

    if prize == "GEN10":
        con.execute("UPDATE users SET credits_analyze=credits_analyze+10 WHERE id=?", (int(uid),))
    elif prize == "AI3":
        con.execute("UPDATE users SET credits_ai=credits_ai+3, credits_analyze=credits_analyze+3 WHERE id=?", (int(uid),))
    elif prize in ("P6H","P12H","P24H","P2D","P3D","P7D"):
        if premium_active:
            con.close()
            raise HTTPException(status_code=409, detail="Premium already active")
        delta = {
            "P6H": datetime.timedelta(hours=6),
            "P12H": datetime.timedelta(hours=12),
            "P24H": datetime.timedelta(hours=24),
            "P2D": datetime.timedelta(days=2),
            "P3D": datetime.timedelta(days=3),
            "P7D": datetime.timedelta(days=7),
        }[prize]
        con.close()
        _apply_premium(int(uid), delta)
        return

    con.commit()
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
        item_id = int(payload.get("id") or 0)
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
        item_id = int(payload.get("id") or 0)
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
        raise HTTPException(status_code=409, detail="Inventory full")
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

    # Store prize to inventory (user redeems later)
    _case_inventory_add(con, uid, prize)

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
        raise HTTPException(status_code=402, detail="Not enough balance")

    # inventory capacity check
    if _case_inventory_count_unused(con, uid) >= CASE_INV_MAX:
        con.close()
        raise HTTPException(status_code=409, detail="Inventory full")

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

    # Store prize to inventory (user redeems later)
    _case_inventory_add(con, uid, prize)

    # log spin
    con.execute("INSERT INTO case_spins(user_id, prize, ts) VALUES(?,?,?)", (uid, prize, ts))
    con.commit()
    con.close()

    return {"ok": True, "prize": prize, "price": CASE_PAID_PRICE, "limits": user_limits(uid)}


# Core endpoints
# ----------------------------
@app.post("/api/analyze")
def api_analyze(request: Request, payload: Dict[str, Any]):
    u = require_user(request)
    uid = int(u["id"])
    lim = user_limits(uid)
    if not lim["premium"] and lim["credits_analyze"] <= 0:
        raise HTTPException(status_code=402, detail="Limit reached (analyze)")

    cookie = payload.get("cookie", "")
    data = roblox_analyze(cookie)

    # spend only on success
    if not lim["premium"]:
        spend_credit(uid, "credits_analyze", 1)

    return {"ok": True, "data": data, "limits": user_limits(uid)}
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

    # Save generated templates for logged-in user
    u = get_current_user(request)
    if u and title and desc:
        con = db_conn()
        con.execute(
            "INSERT INTO templates(user_id,title_tpl,desc_tpl,updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET title_tpl=excluded.title_tpl, desc_tpl=excluded.desc_tpl, updated_at=excluded.updated_at",
            (u["id"], title, desc, datetime.datetime.utcnow().isoformat()),
        )
        con.commit()
        con.close()

    # spend only on success
    if not lim0["premium"]:
        spend_credit(uid, "credits_ai", 1)

    return {"ok": True, "title": title, "desc": desc, "raw": clamp(out, 7000)}

@app.post("/api/chat")
def api_chat(request: Request, payload: Dict[str, Any]):
    require_premium(request)
    # original chat feature is premium-only
    message = (payload.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")
    # For now, reuse AI generate provider/model pipeline as a chat reply:
    provider = (payload.get("provider") or "pollinations").lower()
    model = (payload.get("model") or "default").lower()
    system = "Ты дружелюбный помощник. Пиши на русском. Не упоминай ИИ."
    out = provider_chat(provider=provider, model=model, system=system, user=message)
    return {"ok": True, "reply": out}
@app.get("/api/health")
def api_health():
    return {"ok": True}