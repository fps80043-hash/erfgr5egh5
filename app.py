import os
import re
import datetime
import sqlite3

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

# ----------------------------
# Config
# ----------------------------
DEFAULT_TIMEOUT = 30

# Auth / DB
DB_PATH = os.environ.get("DB_PATH", "data.db")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
JWT_ALG = "HS256"
SESSION_COOKIE = "rst_session"
PBKDF2_ITERS = int(os.environ.get('PBKDF2_ITERS', '200000'))

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
app = FastAPI(title="R$T Web")

@app.on_event("startup")
def _startup():
    db_init()

templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ----------------------------
# Auth / Profile API
# ----------------------------
@app.get("/api/auth/me")
def auth_me(request: Request):
    u = get_current_user(request)
    if not u:
        return {"ok": True, "user": None}
    con = db_conn()
    row = con.execute("SELECT email FROM users WHERE id=?", (u["id"],)).fetchone()
    con.close()
    return {"ok": True, "user": {"username": u["username"], "email": (row["email"] if row else "")}}


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
        raise HTTPException(status_code=400, detail="Username/email already exists")
    raise
finally:
    con.close()

    # auto-login
    con2 = db_conn()
    urow = con2.execute("SELECT id, username FROM users WHERE username=?", (username,)).fetchone()
    con2.close()
    token = make_token(int(urow["id"]), urow["username"])
    jr = JSONResponse({"ok": True, "user": {"username": urow["username"], "email": email}})
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
        row = con.execute("SELECT id, username, password_hash FROM users WHERE lower(email)=?", (ident.strip().lower(),)).fetchone()
    else:
        row = con.execute("SELECT id, username, password_hash FROM users WHERE username=?", (ident,)).fetchone()
    con.close()

    if not row or not verify_password(password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Wrong login or password")

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
# Core endpoints
# ----------------------------
@app.post("/api/analyze")
def api_analyze(payload: Dict[str, Any]):
    cookie = payload.get("cookie", "")
    data = roblox_analyze(cookie)
    return {"ok": True, "data": data}

@app.post("/api/preview")
def api_preview(payload: Dict[str, Any]):
    data = payload.get("data") or {}
    title_tpl = payload.get("title_template") or ""
    desc_tpl = payload.get("desc_template") or ""
    title = safe_format(title_tpl, data)
    desc = safe_format(desc_tpl, data)
    return {"ok": True, "title": title, "desc": desc}

@app.post("/api/ai_generate")
def api_ai_generate(request: Request, payload: Dict[str, Any]):
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

    return {"ok": True, "title": title, "desc": desc, "raw": clamp(out, 7000)}

@app.post("/api/chat")
def api_chat(request: Request, payload: Dict[str, Any]):
    provider = (payload.get("provider") or "pollinations").lower()
    model = payload.get("model") or ""
    message = payload.get("message") or ""
    include_context = bool(payload.get("include_context", True))
    data = payload.get("data") or {}
    title_tpl = payload.get("title_template") or ""
    desc_tpl = payload.get("desc_template") or ""
    current_title = payload.get("current_title") or ""
    current_desc = payload.get("current_desc") or ""

    if not message.strip():
        raise HTTPException(status_code=400, detail="message is empty")

    system = (
        "Ты помощник для продавца Roblox-аккаунтов. "
        "Отвечай коротко и по делу, на русском. "
        "Не упоминай, что ты ИИ/нейросеть/бот. "
        "Если спрашивают про безопасность сделки — предлагай безопасные советы."
    )

    ctx = ""
    if include_context:
        ctx = (
            "Контекст:\n"
            f"- Ник: {data.get('username','')}\n"
            f"- Профиль: {data.get('profile_link','')}\n"
            f"- Robux: {data.get('robux','')}\n"
            f"- RAP: {data.get('rap_tag','')}\n"
            f"- Донат/траты: {data.get('donate_tag','')}\n"
            f"- Год: {data.get('year_tag','')}\n"
            f"- Инвентарь: {data.get('inv_ru','')}\n"
            f"- Шаблон заголовка: {title_tpl}\n"
            f"- Шаблон описания: {desc_tpl}\n"
            f"- Текущий заголовок: {current_title}\n"
            f"- Текущее описание: {current_desc}\n"
        )

    user = (ctx + "\n\n" if ctx else "") + message

    if provider == "blackbox":
        api_key = os.environ.get("BLACKBOX_API_KEY", "")
        out = blackbox_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.85, max_tokens=900)
    elif provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        out = groq_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.85, max_tokens=900)
    else:
        out = pollinations_chat(model=model or "openai", system=system, user=user, temperature=0.9, max_tokens=900)

    u = get_current_user(request)
    if u:
        con = db_conn()
        now = datetime.datetime.utcnow().isoformat()
        con.execute("INSERT INTO chat_messages(user_id,role,content,ts) VALUES(?,?,?,?)", (u["id"], "user", message, now))
        con.execute("INSERT INTO chat_messages(user_id,role,content,ts) VALUES(?,?,?,?)", (u["id"], "assistant", out, now))
        con.commit()
        con.close()

    return {"ok": True, "reply": out}

@app.get("/api/health")
def api_health():
    return {"ok": True}