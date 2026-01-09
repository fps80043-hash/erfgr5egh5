import os
import re
import datetime
import sqlite3
from typing import Any, Dict, List, Tuple, Optional

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from passlib.context import CryptContext
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
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Pollinations (no key)
POLLINATIONS_OPENAI_URL = "https://text.pollinations.ai/openai"   # OpenAI-compatible
POLLINATIONS_MODELS_URL = "https://text.pollinations.ai/models"

# Groq (key required)
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

# BlackBox (key required)
BLACKBOX_CHAT_URL = "https://api.blackbox.ai/chat/completions"

# Roblox endpoints
RBX_AUTH = "https://users.roblox.com/v1/users/authenticated"
RBX_USER = "https://users.roblox.com/v1/users/{uid}"
RBX_ROBUX = "https://economy.roblox.com/v1/users/{uid}/currency"
RBX_COLLECT = "https://inventory.roblox.com/v1/users/{uid}/assets/collectibles?limit=100&cursor={cur}"
RBX_TX = "https://economy.roblox.com/v2/users/{uid}/transactions?transactionType=Purchase&limit=100&cursor={cur}"

# ----------------------------
# DB helpers
# ----------------------------
def db_conn():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def db_init():
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
    return {"ok": True, "user": {"username": u["username"]} if u else None}

@app.post("/api/auth/register")
def auth_register(payload: Dict[str, Any]):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    if len(username) < 3 or len(username) > 24:
        raise HTTPException(status_code=400, detail="Username: 3-24 symbols")
    if not re.match(r"^[a-zA-Z0-9_]+$", username):
        raise HTTPException(status_code=400, detail="Username: only A-Z, 0-9, _")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password: min 6 symbols")

    ph = pwd_context.hash(password)
    con = db_conn()
    try:
        con.execute(
            "INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
            (username, ph, datetime.datetime.utcnow().isoformat()),
        )
        con.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        con.close()
    return {"ok": True}

@app.post("/api/auth/login")
def auth_login(request: Request, payload: Dict[str, Any]):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""

    con = db_conn()
    row = con.execute("SELECT id, username, password_hash FROM users WHERE username=?", (username,)).fetchone()
    con.close()
    if not row or not pwd_context.verify(password, row["password_hash"]):
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
