import os
import datetime
from typing import Any, Dict, List, Tuple

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ----------------------------
# Config
# ----------------------------
DEFAULT_TIMEOUT = 30

# Pollinations (no key)
POLLINATIONS_OPENAI_URL = "https://text.pollinations.ai/openai"   # OpenAI-compatible
POLLINATIONS_MODELS_URL = "https://text.pollinations.ai/models"

# Groq (key required)
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

# Roblox endpoints (cookie-based private fields need .ROBLOSECURITY)
RBX_AUTH = "https://users.roblox.com/v1/users/authenticated"
RBX_USER = "https://users.roblox.com/v1/users/{uid}"
RBX_ROBUX = "https://economy.roblox.com/v1/users/{uid}/currency"
RBX_COLLECT = "https://inventory.roblox.com/v1/users/{uid}/assets/collectibles?limit=100&cursor={cur}"
RBX_TX = "https://economy.roblox.com/v2/users/{uid}/transactions?transactionType=Purchase&limit=100&cursor={cur}"

# ----------------------------
# Helpers
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
    """
    Extracts "TITLE:" / "DESC:" response.
    Expected:
      TITLE: ...
      DESC:
      ...
    Fallback: first line -> title, rest -> desc.
    Always returns (title, desc).
    """
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
        raise HTTPException(status_code=400, detail="GROQ_API_KEY is missing. Add it in Render -> Environment.")
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
    # Do NOT alter cookie string (some users include trailing chars)
    s.cookies[".ROBLOSECURITY"] = cookie

    # Auth
    r = s.get(RBX_AUTH, timeout=DEFAULT_TIMEOUT)
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Bad cookie (auth failed).")
    info = r.json() or {}
    uid = info.get("id")
    uname = info.get("name")
    if not uid:
        raise HTTPException(status_code=401, detail="Bad cookie (no user id).")

    # Collectibles -> RAP (best-effort)
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

    # Transactions purchases -> spend (best-effort)
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

    # Robux
    robux = 0
    try:
        robux = int((s.get(RBX_ROBUX.format(uid=uid), timeout=DEFAULT_TIMEOUT).json() or {}).get("robux", 0))
    except Exception:
        robux = 0

    # Created year
    created_year = ""
    try:
        u = s.get(RBX_USER.format(uid=uid), timeout=DEFAULT_TIMEOUT).json() or {}
        created = str(u.get("created", ""))
        if created[:4].isdigit():
            created_year = created[:4]
    except Exception:
        created_year = ""

    # Tags
    year_tag = f"{created_year}Г" if created_year and int(created_year) <= 2017 else "NEW"
    donate_tag = f"{int(donate_total/1000)}K" if donate_total >= 1000 else str(donate_total)
    rap_tag = f"{int(rap_total/1000)}K" if rap_total >= 1000 else str(rap_total)

    # Inventory text (no privacy/settings calls; only if collectibles were readable)
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

templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/models/pollinations")
def pollinations_models():
    try:
        r = requests.get(POLLINATIONS_MODELS_URL, timeout=DEFAULT_TIMEOUT)
        if r.status_code != 200:
            return {"models": ["openai", "mistral", "searchgpt"]}
        models = r.json()
        models = [m for m in models if isinstance(m, str)]
        return {"models": models}
    except Exception:
        return {"models": ["openai", "mistral", "searchgpt"]}

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
def api_ai_generate(payload: Dict[str, Any]):
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

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        out = groq_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.9, max_tokens=900)
    else:
        out = pollinations_chat(model=model or "openai", system=system, user=user, temperature=0.95, max_tokens=900)

    title, desc = extract_title_desc(out)
    return {"ok": True, "title": title, "desc": desc, "raw": clamp(out, 7000)}

@app.get("/api/health")
def api_health():
    return {"ok": True}
