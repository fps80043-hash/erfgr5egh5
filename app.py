import os
import json
import datetime
from typing import Any, Dict, Optional, List, Tuple

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ----------------------------
# Config
# ----------------------------
POLLINATIONS_OPENAI_URL = "https://text.pollinations.ai/openai"  # OpenAI-compatible endpoint (no key required)
POLLINATIONS_MODELS_URL = "https://text.pollinations.ai/models"

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_CHAT_URL = f"{GROQ_BASE_URL}/chat/completions"

DEFAULT_TIMEOUT = 30

# Roblox endpoints (cookie-based private fields need .ROBLOSECURITY)
RBX_AUTH = "https://users.roblox.com/v1/users/authenticated"
RBX_USER = "https://users.roblox.com/v1/users/{uid}"
RBX_ROBUX = "https://economy.roblox.com/v1/users/{uid}/currency"
RBX_INV_PRIV = "https://accountsettings.roblox.com/v1/inventory-privacy"
RBX_COLLECT = "https://inventory.roblox.com/v1/users/{uid}/assets/collectibles?limit=100&cursor={cur}"
RBX_TX = "https://economy.roblox.com/v2/users/{uid}/transactions?transactionType=Purchase&limit=100&cursor={cur}"
RBX_BIRTH = "https://accountinformation.roblox.com/v1/birthdate"

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
        # If template is really broken, return raw
        return tpl

def clamp(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[:n]

def extract_head_body(text: str) -> Tuple[str, str]:
    """
    Extracts HEAD/BODY from model response.
    Expected:
      HEAD: ...
      BODY:
      ...
    Fallback: first line -> head, rest -> body.
    Always returns (head, body).
    """
    if not text:
        return "", ""
    t = text.strip().replace("```", "").strip()

    # try tags
    head = ""
    body = ""
    lower = t.lower()

    # Find "head:" and "body:"
    # Prefer line-based parsing to tolerate extra whitespace.
    lines = t.splitlines()
    head_idx = None
    body_idx = None
    for i, line in enumerate(lines):
        if head_idx is None and line.strip().lower().startswith("head:"):
            head_idx = i
        if body_idx is None and line.strip().lower().startswith("body:"):
            body_idx = i

    if head_idx is not None:
        head = lines[head_idx].split(":", 1)[1].strip()
    if body_idx is not None:
        # body can be on same line or following lines
        after = lines[body_idx].split(":", 1)
        if len(after) == 2 and after[1].strip():
            body = after[1].strip()
            if body_idx + 1 < len(lines):
                body += "\n" + "\n".join(lines[body_idx + 1 :]).rstrip()
        else:
            body = "\n".join(lines[body_idx + 1 :]).rstrip()

    if head or body:
        return head, body

    # fallback
    if len(lines) == 1:
        return lines[0].strip(), ""
    return lines[0].strip(), "\n".join(lines[1:]).strip()

def pollinations_chat(model: str, system: str, user: str, temperature: float = 1.0, max_tokens: int = 900) -> str:
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
        # Sometimes API can return plain text, be defensive
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

def build_sales_prompt(mode: str, tone: str) -> str:
    # Mode: rewrite / creative / from scratch
    mode_map = {
        "✏️ Рерайт (Легкий)": "Сохрани структуру и смысл, но перефразируй и сделай привлекательнее.",
        "🎨 Рерайт v2 (Креативный)": "Сохрани ключевые факты, но добавь креатив и сильнее продай ценность.",
        "✨ С Нуля (Новый)": "Сгенерируй новое объявление с нуля по фактам об аккаунте.",
    }
    tone_map = {
        "✨ Классика": "Уверенный продающий стиль, без лишнего пафоса. Умеренные эмодзи.",
        "💎 Люкс": "Премиум-объявление: подчёркивай редкость, ценность, статус, уникальность, богатство аккаунта.",
        "🧊 Минимал": "Коротко и сухо: факты, цифры, минимум эмодзи.",
        "🤝 Доверие": "Максимум доверия: гарантия, прозрачность, чек-лист проверки, аккуратный тон.",
    }
    return f"{mode_map.get(mode, mode_map['✏️ Рерайт (Легкий)'])}\n{tone_map.get(tone, tone_map['✨ Классика'])}"


def build_chat_system() -> str:
    return (
        "Ты помощник для подготовки продающих объявлений и шаблонов по Roblox-аккаунтам. "
        "Помогай улучшать заголовки и описания, подсказывай структуру, эмодзи, пункты гарантий. "
        "Пиши на русском, если пользователь не просит иначе. "
        "Не упоминай, что ты ИИ/нейросеть. "
        "Не используй markdown и блоки ```."
    )

def pollinations_chat_messages(model: str, messages, temperature: float = 0.9, max_tokens: int = 900) -> str:
    payload = {
        "model": model or "openai",
        "messages": messages,
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

def groq_chat_messages(api_key: str, model: str, messages, temperature: float = 0.9, max_tokens: int = 900) -> str:
    if not api_key:
        raise HTTPException(status_code=400, detail="GROQ_API_KEY is missing. Add it in Render -> Environment.")
    payload = {
        "model": model or "llama-3.3-70b-versatile",
        "messages": messages,
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

def clamp_chat_history(messages, max_chars: int = 16000):
    # Keep last messages within char budget to avoid huge requests.
    out = []
    total = 0
    for m in reversed(messages or []):
        role = m.get("role")
        content = str(m.get("content", ""))
        if role not in ("system", "user", "assistant"):
            continue
        total += len(content)
        if total > max_chars and out:
            break
        out.append({"role": role, "content": content[:6000]})
    return list(reversed(out))
def roblox_analyze(cookie: str) -> Dict[str, Any]:
    cookie = (cookie or "").strip()
    if not cookie:
        raise HTTPException(status_code=400, detail="cookie is required")

    s = requests.Session()
    s.cookies[".ROBLOSECURITY"] = cookie

    # Basic auth check
    r = s.get(RBX_AUTH, timeout=DEFAULT_TIMEOUT)
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Bad cookie (auth failed).")
    info = r.json()
    uid = info.get("id")
    uname = info.get("name")
    if not uid:
        raise HTTPException(status_code=401, detail="Bad cookie (no user id).")

    # Inventory privacy
    inv_priv = "NoOne"
    try:
        pr = s.get(RBX_INV_PRIV, timeout=DEFAULT_TIMEOUT).json()
        inv_priv = pr.get("inventoryPrivacy") or "NoOne"
    except Exception:
        inv_priv = "NoOne"

    # Collectibles -> RAP
    rap_total = 0
    items: List[Tuple[str, int]] = []
    cur = ""
    for _ in range(30):  # safety limit
        rr = s.get(RBX_COLLECT.format(uid=uid, cur=cur), timeout=DEFAULT_TIMEOUT)
        if rr.status_code != 200:
            break
        jj = rr.json() or {}
        for it in jj.get("data", []) or []:
            # RAP field is usually "recentAveragePrice" on collectibles response
            rap = it.get("recentAveragePrice") or it.get("recentAveragePricePrice") or 0
            name = ""
            try:
                name = it.get("name") or it.get("assetName") or ""
            except Exception:
                name = ""
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

    # Transactions purchases -> "donate total" (spend)
    donate_total = 0
    cur = ""
    for _ in range(30):
        rr = s.get(RBX_TX.format(uid=uid, cur=cur), timeout=DEFAULT_TIMEOUT)
        if rr.status_code != 200:
            break
        jj = rr.json() or {}
        for it in jj.get("data", []) or []:
            amt = None
            # currency.amount is typical
            cur_obj = it.get("currency") or {}
            amt = cur_obj.get("amount")
            if amt is None:
                amt = it.get("amount")
            try:
                donate_total += abs(int(amt))
            except Exception:
                pass
        cur = jj.get("nextPageCursor") or jj.get("nextPageCursor") or ""
        if not cur:
            break

    # Robux
    robux = 0
    try:
        robux = int(s.get(RBX_ROBUX.format(uid=uid), timeout=DEFAULT_TIMEOUT).json().get("robux", 0))
    except Exception:
        robux = 0

    # Created
    created_year = None
    try:
        u = s.get(RBX_USER.format(uid=uid), timeout=DEFAULT_TIMEOUT).json()
        created = str(u.get("created", ""))
        if created[:4].isdigit():
            created_year = int(created[:4])
    except Exception:
        created_year = None

    # Age tag (birthdate endpoint is auth-locked)
    age_tag = "Скрыт"
    try:
        b = s.get(RBX_BIRTH, timeout=DEFAULT_TIMEOUT).json()
        if all(k in b for k in ("birthYear", "birthMonth", "birthDay")):
            td = datetime.date.today()
            age = td.year - int(b["birthYear"]) - ((td.month, td.day) < (int(b["birthMonth"]), int(b["birthDay"])))
            age_tag = "13+" if age >= 13 else "<13"
    except Exception:
        pass

    # Derived tags
    year_tag = f"{created_year}Г" if created_year and created_year <= 2017 else "NEW"
    if donate_total >= 1000:
        donate_tag = f"{int(donate_total/1000)}K"
    else:
        donate_tag = str(donate_total)

    rap_tag = f"{int(rap_total/1000)}K" if rap_total >= 1000 else str(rap_total)

    # Inventory text
    inv_ru = "Скрыт" if inv_priv != "AllUsers" else "Открыт"
    if inv_priv == "AllUsers" and items:
        items_sorted = sorted(items, key=lambda x: x[1], reverse=True)[:12]
        lines = []
        for nm, rp in items_sorted:
            if rp > 0:
                lines.append(f"{nm} ({rp} RAP)")
            else:
                lines.append(nm)
        inv_ru = " / ".join(lines)

    return {
        "user_id": uid,
        "username": uname,
        "profile_link": f"https://www.roblox.com/users/{uid}/profile",
        "robux": robux,
        "rap": rap_total,
        "rap_tag": rap_tag,
        "total": donate_total,
        "donate_tag": donate_tag,
        "year": created_year or "",
        "year_tag": year_tag,
        "age": age_tag,
        "inv_ru": inv_ru,
    }

# ----------------------------
# App
# ----------------------------
app = FastAPI(title="Roblox Seller Tool Web")

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
        # Keep only strings
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
    head_tpl = payload.get("head_template") or ""
    body_tpl = payload.get("body_template") or ""
    head = safe_format(head_tpl, data)
    body = safe_format(body_tpl, data)
    return {"ok": True, "head": head, "body": body}

@app.post("/api/ai_generate")
def api_ai_generate(payload: Dict[str, Any]):
    provider = (payload.get("provider") or "pollinations").lower()
    model = payload.get("model") or ""
    mode = payload.get("mode") or "✏️ Рерайт (Легкий)"
    tone = payload.get("tone") or "✨ Классика"
    extra = payload.get("extra") or ""
    data = payload.get("data") or {}

    # Give model a structured brief
    sales_rule = build_sales_prompt(mode, tone)

    system = (
        "Ты копирайтер, который пишет продающие объявления для Roblox-аккаунтов. "
        "Пиши на русском. Не упоминай, что текст создан ИИ/нейросетью/генератором. "
        "Не используй markdown и блоки ```.\n\n"
        "ФОРМАТ ОТВЕТА СТРОГО ТАКОЙ:\n\n"
        "HEAD: <одна строка заголовка>\n"
        "BODY:\n<полное описание>\n"
    )

    facts = (
        f"Факты об аккаунте:\n"
        f"- Ник: {data.get('username','')}\n"
        f"- Ссылка: {data.get('profile_link','')}\n"
        f"- Robux: {data.get('robux','')}\n"
        f"- RAP: {data.get('rap_tag','')}\n"
        f"- Донат/траты: {data.get('donate_tag','')}\n"
        f"- Год: {data.get('year_tag','')}\n"
        f"- Возраст: {data.get('age','')}\n"
        f"- Инвентарь: {data.get('inv_ru','')}\n"
    )

    user = (
        f"{facts}\n"
        f"Инструкция:\n{sales_rule}\n"
        f"Доп. пожелания:\n{extra}\n"
        f"Сгенерируй HEAD и BODY."
    )

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        out = groq_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.9, max_tokens=900)
    else:
        # default: pollinations
        out = pollinations_chat(model=model or "openai", system=system, user=user, temperature=1.0, max_tokens=900)

    head, body = extract_head_body(out)
    return {"ok": True, "head": head, "body": body, "raw": clamp(out, 5000)}

@app.post("/api/translate")
def api_translate(payload: Dict[str, Any]):
    provider = (payload.get("provider") or "pollinations").lower()
    model = payload.get("model") or ""
    head = payload.get("head") or ""
    body = payload.get("body") or ""

    system = (
        "You are a translator. Translate to English. "
        "Keep variables like {username} unchanged. "
        "Return STRICTLY in this format:\n"
        "HEAD: <one line>\n"
        "BODY:\n<multiline text>\n"
        "No markdown, no code fences."
    )
    user = f"Translate this:\n\nHEAD:\n{head}\n\nBODY:\n{body}"

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        out = groq_chat(api_key=api_key, model=model, system=system, user=user, temperature=0.4, max_tokens=900)
    else:
        out = pollinations_chat(model=model or "openai", system=system, user=user, temperature=0.4, max_tokens=900)

    head_en, body_en = extract_head_body(out)
    return {"ok": True, "head": head_en, "body": body_en, "raw": clamp(out, 5000)}



@app.post("/api/chat")
def api_chat(payload: Dict[str, Any]):
    provider = (payload.get("provider") or "pollinations").lower()
    model = payload.get("model") or ""
    msgs = payload.get("messages") or []
    extra_system = payload.get("system") or ""

    # Build messages: system + history
    system = build_chat_system()
    if extra_system:
        system = system + " " + str(extra_system)

    messages = [{"role": "system", "content": system}] + clamp_chat_history(msgs)

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY", "")
        out = groq_chat_messages(api_key=api_key, model=model, messages=messages, temperature=0.9, max_tokens=900)
    else:
        out = pollinations_chat_messages(model=model or "openai", messages=messages, temperature=0.95, max_tokens=900)

    return {"ok": True, "text": clamp(out, 12000)}

@app.post("/api/chat_stream")
def api_chat_stream(payload: Dict[str, Any]):
    provider = (payload.get("provider") or "pollinations").lower()
    model = payload.get("model") or ""
    msgs = payload.get("messages") or []
    extra_system = payload.get("system") or ""

    system = build_chat_system()
    if extra_system:
        system = system + " " + str(extra_system)

    messages = [{"role": "system", "content": system}] + clamp_chat_history(msgs)

    def gen():
        # Let client show typing right away
        yield "event: status\ndata: started\n\n"
        try:
            if provider == "groq":
                api_key = os.environ.get("GROQ_API_KEY", "")
                full = groq_chat_messages(api_key=api_key, model=model, messages=messages, temperature=0.9, max_tokens=900)
            else:
                full = pollinations_chat_messages(model=model or "openai", messages=messages, temperature=0.95, max_tokens=900)
            full = clamp(str(full), 12000)

            # Chunked SSE (imitates streaming)
            step = 24
            for i in range(0, len(full), step):
                chunk = full[i:i+step]
                payload = json.dumps({"delta": chunk}, ensure_ascii=False)
                yield f"data: {payload}\n\n"
            yield "event: done\ndata: ok\n\n"
        except Exception as e:
            err = json.dumps({"error": str(e)}, ensure_ascii=False)
            yield f"event: error\ndata: {err}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
@app.get("/api/health")
def api_health():
    return {"ok": True, "service": "up"}
