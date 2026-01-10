
function closeAllSelects(except=null){
  document.querySelectorAll(".cselect.open").forEach(w=>{
    if(except && w === except) return;
    w.classList.remove("open");
  });
}

function buildOptions(wrap, sel){
  const list = wrap.querySelector(".cselect-list");
  list.innerHTML = "";
  const btn = wrap.querySelector(".cselect-btn .cselect-text");

  if(!sel.options || sel.options.length === 0){
    const o = document.createElement("option");
    o.value = "Default";
    o.textContent = "Default";
    sel.appendChild(o);
    sel.value = "Default";
  }

  Array.from(sel.options).forEach(o=>{
    const div = document.createElement("div");
    div.className = "cselect-opt" + (o.value === sel.value ? " sel" : "");
    div.textContent = o.textContent || o.value;
    div.addEventListener("click", ()=>{
      sel.value = o.value;
      sel.dispatchEvent(new Event("change"));
      btn.textContent = o.textContent || o.value;
      buildOptions(wrap, sel);
      wrap.classList.remove("open");
    });
    list.appendChild(div);
  });

  const cur = (sel.selectedOptions && sel.selectedOptions[0]) ? sel.selectedOptions[0] : sel.options[0];
  if(cur) btn.textContent = cur.textContent || cur.value;
}

function enhanceSelect(sel){
  if(!sel || sel.dataset.enhanced === "1") return;
  sel.dataset.enhanced = "1";
  sel.classList.add("native-hidden");

  const wrap = document.createElement("div");
  wrap.className = "cselect";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cselect-btn";
  btn.innerHTML = `<span class="cselect-text"></span><span class="cselect-arrow">▾</span>`;

  const list = document.createElement("div");
  list.className = "cselect-list";

  wrap.appendChild(btn);
  wrap.appendChild(list);

  sel.parentNode.insertBefore(wrap, sel.nextSibling);

  btn.addEventListener("click", (e)=>{
    e.preventDefault();
    if(wrap.classList.contains("open")){
      wrap.classList.remove("open");
    }else{
      closeAllSelects(wrap);
      wrap.classList.add("open");
    }
  });

  buildOptions(wrap, sel);

  sel.addEventListener("change", ()=>{
    buildOptions(wrap, sel);
  });
}

function refreshSelect(sel){
  if(!sel) return;
  if(sel.dataset.enhanced !== "1") return;
  sel.dispatchEvent(new Event("change"));
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let accountData = null;

const toastQ = [];
let toastBusy = false;

function toastIcon(type){
  if(type === "bad") return "⛔";
  if(type === "warn") return "⚡";
  return "✅";
}

function toast(title, msg="", type="ok"){
  toastQ.push({title, msg, type});
  if(!toastBusy) drainToasts();
}

function drainToasts(){
  const box = document.getElementById("toasts");
  if(!box){ toastQ.length = 0; toastBusy = false; return; }
  const it = toastQ.shift();
  if(!it){ toastBusy = false; return; }
  toastBusy = true;

  const el = document.createElement("div");
  el.className = "toast " + it.type;
  el.innerHTML = `
    <div class="ico">${toastIcon(it.type)}</div>
    <div class="twrap">
      <div class="t1">${it.title}</div>
      ${it.msg ? `<div class="t2">${it.msg}</div>` : ``}
    </div>
  `;
  box.appendChild(el);

  const SHOW_MS = 2700;
  const GAP_MS  = 520;

  setTimeout(()=>{
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
  }, SHOW_MS);

  setTimeout(()=>{
    el.remove();
    setTimeout(drainToasts, GAP_MS);
  }, SHOW_MS + 280);
}


let currentUser = null;

const DEFAULT_TITLE = "⭐ ТОП {year_tag} | {donate_tag} ДОНАТА";
const DEFAULT_DESC = `✨ Аккаунт готов к игре!
👤 Ник: {username}
🔗 Профиль: {profile_link}
💰 Robux: {robux}
💎 RAP: {rap_tag}
💳 Донат/траты: {donate_tag}
📅 Год: {year_tag}
🧾 Инвентарь: {inv_ru}

✅ Плюсы:
— Быстрая выдача
— Прозрачная сделка
— Рекомендация: сменить почту/пароль после покупки`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------
// Toasts (queue + delay)
// -------------------------
let toastQ = [];
let toastBusy = false;


async function runToasts() {
  toastBusy = true;
  const box = $("#toasts");
  while (toastQ.length) {
    const item = toastQ.shift();
    if (!box) break;

    const el = document.createElement("div");
    el.className = "toast " + item.type;
    el.innerHTML =
      `<div class="t1">${escapeHtml(item.title)}</div>` +
      (item.msg ? `<div class="t2">${escapeHtml(item.msg)}</div>` : "") +
      `<div class="tprog"><span></span></div>`;

    box.appendChild(el);
    // animate progress
    const bar = el.querySelector(".tprog span");
    if (bar) {
      bar.style.width = "0%";
      requestAnimationFrame(() => (bar.style.width = "100%"));
    }

    // show time depends on message size
    const hold = 1700 + Math.min(1800, (item.msg || "").length * 18);
    await sleep(hold);

    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
    await sleep(360);
    el.remove();

    // small gap to avoid "double pop"
    await sleep(220);
  }
  toastBusy = false;
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// -------------------------
// Progress bars
// -------------------------
function startBar(barId, fillId) {
  const bar = document.getElementById(barId);
  const fill = document.getElementById(fillId);
  if (!bar || !fill) return () => {};
  bar.classList.add("active");
  fill.style.width = "0%";
  let p = 3 + Math.random() * 6;
  fill.style.width = p + "%";
  const t = setInterval(() => {
    p = Math.min(p + (2 + Math.random() * 10), 92);
    fill.style.width = p + "%";
  }, 240);

  return (ok = true) => {
    clearInterval(t);
    fill.style.width = ok ? "100%" : Math.max(p, 22) + "%";
    setTimeout(() => {
      bar.classList.remove("active");
      fill.style.width = "0%";
    }, 420);
  };
}

function setStatus(el, text, cls = "") {
  if (!el) return;
  el.className = "status " + cls;
  el.textContent = text;
}

// -------------------------
// API helpers
// -------------------------
async function apiGet(path) {
  const r = await fetch(path, { method: "GET" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.detail || `HTTP ${r.status}`);
  return j;
}

async function apiPost(path, payload) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.detail || `HTTP ${r.status}`);
  return j;
}

// -------------------------
// Templates
// -------------------------
let debSync = null;

function loadTpl() {
  const t = localStorage.getItem("rst_title_tpl");
  const d = localStorage.getItem("rst_desc_tpl");
  if ($("#tplTitle")) $("#tplTitle").value = t || DEFAULT_TITLE;
  if ($("#tplDesc")) $("#tplDesc").value = d || DEFAULT_DESC;
}

function saveTpl() {
  localStorage.setItem("rst_title_tpl", $("#tplTitle")?.value || "");
  localStorage.setItem("rst_desc_tpl", $("#tplDesc")?.value || "");

  if (currentUser) {
    if (debSync) clearTimeout(debSync);
    debSync = setTimeout(() => syncPush().catch(() => {}), 900);
  }
}

function resetTpl() {
  if ($("#tplTitle")) $("#tplTitle").value = DEFAULT_TITLE;
  if ($("#tplDesc")) $("#tplDesc").value = DEFAULT_DESC;
  saveTpl();
  renderPreview().catch(() => {});
  toast("Сброс", "Шаблоны восстановлены", "warn");
}

// -------------------------
// Main render
// -------------------------
function setFacts(d) {
  $("#f_username").textContent = d.username || "—";
  const link = $("#f_link");
  if (link) {
    link.textContent = d.profile_link || "—";
    link.href = d.profile_link || "#";
  }
  $("#f_robux").textContent = String(d.robux ?? "—");
  $("#f_rap").textContent = String(d.rap_tag ?? "—");
  $("#f_total").textContent = String(d.donate_tag ?? "—");
  $("#f_year").textContent = String(d.year_tag ?? "—");
  $("#f_inv").textContent = d.inv_ru || "—";
}

async function renderPreview() {
  const titleTpl = $("#tplTitle")?.value || "";
  const descTpl = $("#tplDesc")?.value || "";

  if (!accountData) {
    if ($("#outTitle")) $("#outTitle").value = "";
    if ($("#outDesc")) $("#outDesc").value = "";
    return;
  }
  const j = await apiPost("/api/preview", {
    data: accountData,
    title_template: titleTpl,
    desc_template: descTpl,
  });
  if ($("#outTitle")) $("#outTitle").value = j.title || "";
  if ($("#outDesc")) $("#outDesc").value = j.desc || "";
}

// Clipboard fallback
async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (_e2) {
      return false;
    }
  }
}

// -------------------------
// AI models
// -------------------------
async function setPollinationsModels() {
  const sel = $("#aiModel");
  if (!sel) return;
  sel.innerHTML = "";
  let models = ["openai", "mistral", "searchgpt"];
  try {
    const j = await apiGet("/api/models/pollinations");
    if (Array.isArray(j.models) && j.models.length) models = j.models;
  } catch (_e) {}
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  sel.value = safeModels[0] || "Default";
    refreshSelect($("#aiModel"));
}

function setGroqModels() {
  const sel = $("#aiModel");
  if (!sel) return;
  sel.innerHTML = "";
  [
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "gemma2-9b-it",
    "mixtral-8x7b-32768",
  ].forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  sel.value = "llama-3.3-70b-versatile";
}

function setBlackboxModels() {
  const sel = $("#aiModel");
  if (!sel) return;
  sel.innerHTML = "";
  // keep it simple: only DeepSeek variants
  [
    "blackboxai/deepseek/deepseek-chat:free",
    "blackboxai/deepseek/deepseek-chat",
  ].forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m.replace("blackboxai/", "BB: ");
    sel.appendChild(opt);
  });
  sel.value = "blackboxai/deepseek/deepseek-chat:free";
}

async function refreshModels() {
  const provider = $("#aiProvider")?.value || "pollinations";
  if (provider === "groq") setGroqModels();
  else if (provider === "blackbox") setBlackboxModels();
  else await setPollinationsModels();
}

// -------------------------
// Chat UI
// -------------------------
function pushMsg(who, text, me = false) {
  const log = $("#chatLog");
  if (!log) return;
  const wrap = document.createElement("div");
  wrap.className = "msg " + (me ? "me" : "bot");
  wrap.innerHTML = `<div class="mwho">${escapeHtml(who)}</div><div class="mtext"></div>`;
  wrap.querySelector(".mtext").textContent = text || "";
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

// -------------------------
// Profile sync
// -------------------------
async function syncPull() {
  const j = await apiGet("/api/user/templates");
  if ($("#tplTitle")) $("#tplTitle").value = j.title_tpl || DEFAULT_TITLE;
  if ($("#tplDesc")) $("#tplDesc").value = j.desc_tpl || DEFAULT_DESC;
  saveTpl();
  await renderPreview();
  toast("Профиль", "Шаблоны загружены", "ok");
}

async function syncPush() {
  const title_tpl = $("#tplTitle")?.value || "";
  const desc_tpl = $("#tplDesc")?.value || "";
  await apiPost("/api/user/templates", { title_tpl, desc_tpl });
  toast("Профиль", "Шаблоны сохранены", "ok");
}

async function chatPull() {
  const j = await apiGet("/api/user/chat_history");
  const log = $("#chatLog");
  if (!log) return;
  log.innerHTML = "";
  (j.messages || []).forEach((m) => {
    pushMsg(m.role === "user" ? "Ты" : "R$T", m.content, m.role === "user");
  });
  toast("Профиль", "История чата загружена", "ok");
}

async function chatClear() {
  await apiPost("/api/user/chat_clear", {});
  const log = $("#chatLog");
  if (log) log.innerHTML = "";
  toast("Профиль", "История чата очищена", "warn");
}

// -------------------------
// Logo burst + particles
// -------------------------
function spawnLogoBurst() {
  const logo = document.querySelector(".logo");
  if (!logo) return;
  const EM = ["💲", "💥", "💢", "⭐", "🔥"];
  // random chance, not always same cycle
  if (Math.random() < 0.58) return;
  const count = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const e = document.createElement("span");
    e.className = "emoji";
    e.textContent = EM[Math.floor(Math.random() * EM.length)];
    const ang = Math.random() * Math.PI * 2;
    const dist = 18 + Math.random() * 46;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - (10 + Math.random() * 10);
    const rot = -90 + Math.random() * 180 + "deg";
    e.style.setProperty("--dx", dx + "px");
    e.style.setProperty("--dy", dy + "px");
    e.style.setProperty("--rot", rot);
    e.style.fontSize = 14 + Math.random() * 10 + "px";
    logo.appendChild(e);
    setTimeout(() => e.remove(), 920);
  }
}


function spawnLogoStar(){
  const logo = document.querySelector(".logo");
  if(!logo) return;
  const e = document.createElement("span");
  e.className = "logoStar";
  e.textContent = "⭐";
  const dx = (-42 + Math.random()*84);
  const dy = -(24 + Math.random()*62); // only above
  e.style.setProperty("--dx", dx + "px");
  e.style.setProperty("--dy", dy + "px");
  logo.appendChild(e);
  setTimeout(()=> e.remove(), 1300);
}

function initParticles() {
  const canvas = document.getElementById("particles");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let w = 0,
    h = 0,
    dpr = 1;
  let particles = [];
  let N = 90;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(window.innerWidth * dpr);
    h = canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    N = window.innerWidth < 520 ? 55 : 90;
    particles = [];
    for (let i = 0; i < N; i++) particles.push(make());
  }

  function rnd(a, b) {
    return a + Math.random() * (b - a);
  }
  function make() {
    return {
      x: rnd(0, w),
      y: rnd(0, h),
      r: rnd(0.7, 2.2) * dpr,
      vx: rnd(-0.25, 0.25) * dpr,
      vy: rnd(-0.18, 0.22) * dpr,
      a: rnd(0.15, 0.85),
    };
  }

  function tick() {
    ctx.clearRect(0, 0, w, h);
    // dots
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -20) p.x = w + 20;
      if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20;
      if (p.y > h + 20) p.y = -20;

      ctx.beginPath();
      ctx.globalAlpha = p.a;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }

    // links
    ctx.globalAlpha = 0.08;
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i],
          b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 130 * dpr) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", resize);
  resize();
  tick();
}

// -------------------------
// Tabs
// -------------------------
function setTab(name) {
  $$(".pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".btab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
}

// -------------------------
// Auth UI
// -------------------------
function setAuthPane(which) {
  $$(".authTabs .pill").forEach((b) => b.classList.toggle("active", b.dataset.auth === which));
  const panes = {
    login: $("#authPaneLogin"),
    register: $("#authPaneRegister"),
    reset: $("#authPaneReset"),
  };
  Object.entries(panes).forEach(([k, el]) => {
    if (!el) return;
    el.style.display = k === which ? "block" : "none";
  });
}

async function refreshMe() {
  try {
    const j = await apiGet("/api/auth/me");
    currentUser = j.user;
  } catch (_e) {
    currentUser = null;
  }

  const st = $("#meStatus");
  const authBox = $("#authBox");
  const tools = $("#profileTools");
  const lo = $("#btnLogout");

  if (currentUser) {
    const extra = currentUser.email ? ` • ${currentUser.email}` : "";
    if (st) st.textContent = `${currentUser.username}${extra}`;
    if (authBox) authBox.style.display = "none";
    if (tools) tools.style.display = "block";
    if (lo) lo.style.display = "inline-flex";
  } else {
    if (st) st.textContent = "не вошёл";
    if (authBox) authBox.style.display = "block";
    if (tools) tools.style.display = "none";
    if (lo) lo.style.display = "none";
  }
}

// -------------------------
// Boot
// -------------------------
window.addEventListener("load", async () => {
  // nav
  $$(".navbtn").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $$(".btab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // particles + logo burst
  initParticles();
  setInterval(spawnLogoStar, 5000);

// load templates + cookie
  loadTpl();
  const c = localStorage.getItem("rst_cookie");
  if (c && $("#cookie")) $("#cookie").value = c;

  $("#tplTitle")?.addEventListener("input", () => {
    saveTpl();
    renderPreview().catch(() => {});
  });
  $("#tplDesc")?.addEventListener("input", () => {
    saveTpl();
    renderPreview().catch(() => {});
  });

  $("#btnSaveTpl")?.addEventListener("click", () => {
    saveTpl();
    toast("Сохранено", "Шаблоны сохранены локально", "ok");
  });
  $("#btnResetTpl")?.addEventListener("click", resetTpl);

  // copy
  $("#btnCopyTitle")?.addEventListener("click", async () => {
    const ok = await copyText($("#outTitle")?.value || "");
    toast(ok ? "Скопировано" : "Ошибка", ok ? "Заголовок в буфере" : "Не удалось скопировать", ok ? "ok" : "bad");
  });
  $("#btnCopyDesc")?.addEventListener("click", async () => {
    const ok = await copyText($("#outDesc")?.value || "");
    toast(ok ? "Скопировано" : "Ошибка", ok ? "Описание в буфере" : "Не удалось скопировать", ok ? "ok" : "bad");
  });
  $("#btnCopyAll")?.addEventListener("click", async () => {
    const all = `${$("#outTitle")?.value || ""}\n\n${$("#outDesc")?.value || ""}`.trim();
    const ok = await copyText(all);
    toast(ok ? "Скопировано" : "Ошибка", ok ? "Всё в буфере" : "Не удалось скопировать", ok ? "ok" : "bad");
  });

  // analyze
  $("#btnAnalyze")?.addEventListener("click", async () => {
    const cookie = $("#cookie")?.value || "";
    if (!cookie.trim()) return toast("Cookie", "Вставь .ROBLOSECURITY cookie", "warn");

    localStorage.setItem("rst_cookie", cookie);

    const stop = startBar("pbarAnalyze", "pfillAnalyze");
    setStatus($("#status"), "Проверяем…", "");
    try {
      const j = await apiPost("/api/analyze", { cookie });
      accountData = j.data;
      setFacts(accountData);
      await renderPreview();
      setStatus($("#status"), "Готово", "ok");
      toast("Аккаунт", "Данные получены", "ok");
      stop(true);
    } catch (e) {
      setStatus($("#status"), "Ошибка", "bad");
      toast("Ошибка", e.message, "bad");
      stop(false);
    }
  });

  // AI provider + models
  $("#aiProvider")?.addEventListener("change", async () => {
    await refreshModels();
    toast("AI", "Модели обновлены", "ok");
  });
  await refreshModels();

  // AI generate
  $("#btnAIGen")?.addEventListener("click", async () => {
    if (!accountData) return toast("AI", "Сначала сделай анализ cookie", "warn");

    const provider = $("#aiProvider")?.value || "pollinations";
    const model = $("#aiModel")?.value || "";
    const mode = $("#aiMode")?.value || "Рерайт";
    const tone = $("#aiTone")?.value || "Классика";
    const extra = $("#aiExtra")?.value || "";

    const stop = startBar("pbarAI", "pfillAI");
    setStatus($("#aiStatus"), "Генерация…", "");
    try {
      const j = await apiPost("/api/ai_generate", {
        provider,
        model,
        mode,
        tone,
        extra,
        data: accountData,
      });

      if ($("#aiRaw")) $("#aiRaw").textContent = j.raw || "";
      if (j.title) $("#tplTitle").value = j.title;
      if (j.desc) $("#tplDesc").value = j.desc;
      saveTpl();
      await renderPreview();
      setStatus($("#aiStatus"), "Готово", "ok");
      toast("AI", "Сгенерировано", "ok");
      stop(true);
    } catch (e) {
      setStatus($("#aiStatus"), "Ошибка", "bad");
      toast("Ошибка", e.message, "bad");
      stop(false);
    }
  });

  // Chat context toggle
  const ctx = $("#chatCtx");
  const ctxLabel = $("#chatCtxLabel");
  const renderCtxLabel = () => {
    if (!ctxLabel) return;
    ctxLabel.textContent = ctx?.checked ? "включён" : "выключен";
  };
  ctx?.addEventListener("change", renderCtxLabel);
  renderCtxLabel();

  // Chat send
  const sendChat = async () => {
    const msg = $("#chatMsg")?.value || "";
    if (!msg.trim()) return;
    const provider = $("#aiProvider")?.value || "pollinations";
    const model = $("#aiModel")?.value || "";
    const include_context = !!$("#chatCtx")?.checked;

    pushMsg("Ты", msg, true);
    $("#chatMsg").value = "";

    const stop = startBar("pbarChat", "pfillChat");
    try {
      const j = await apiPost("/api/chat", {
        provider,
        model,
        message: msg,
        include_context,
        data: accountData || {},
        title_template: $("#tplTitle")?.value || "",
        desc_template: $("#tplDesc")?.value || "",
        current_title: $("#outTitle")?.value || "",
        current_desc: $("#outDesc")?.value || "",
      });
      pushMsg("R$T", j.reply || "");
      stop(true);
    } catch (e) {
      pushMsg("R$T", `Ошибка: ${e.message}`);
      stop(false);
    }
  };

  $("#btnChatSend")?.addEventListener("click", sendChat);
  $("#chatMsg")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  // Auth tabs
  $$(".authTabs .pill").forEach((b) => b.addEventListener("click", () => setAuthPane(b.dataset.auth)));
  setAuthPane("login");

  // Login
  $("#btnLogin")?.addEventListener("click", async () => {
    try {
      const username = $("#loginUser")?.value || "";
      const password = $("#loginPass")?.value || "";
      await apiPost("/api/auth/login", { username, password });
      toast("Профиль", "Вход выполнен", "ok");
      await refreshMe();
      await syncPull().catch(() => {});
      await chatPull().catch(() => {});
    } catch (e) {
      toast("Ошибка", e.message, "bad");
    }
  });

  // Register start
  $("#btnRegStart")?.addEventListener("click", async () => {
    try {
      const username = $("#regUser")?.value || "";
      const email = $("#regEmail")?.value || "";
      const password = $("#regPass")?.value || "";
      await apiPost("/api/auth/register_start", { username, email, password });
      toast("Регистрация", "Код отправлен на почту", "ok");
      $("#regCode")?.focus();
    } catch (e) {
      toast("Ошибка", e.message, "bad");
    }
  });

  // Register confirm
  $("#btnRegConfirm")?.addEventListener("click", async () => {
    try {
      const email = $("#regEmail")?.value || "";
      const code = $("#regCode")?.value || "";
      await apiPost("/api/auth/register_confirm", { email, code });
      toast("Регистрация", "Готово — ты вошёл", "ok");
      await refreshMe();
      await syncPull().catch(() => {});
      await chatPull().catch(() => {});
    } catch (e) {
      toast("Ошибка", e.message, "bad");
    }
  });

  // Reset start
  $("#btnResetStart")?.addEventListener("click", async () => {
    try {
      const email = $("#resetEmail")?.value || "";
      await apiPost("/api/auth/reset_start", { email });
      toast("Сброс", "Если email существует — код отправлен", "ok");
      $("#resetCode")?.focus();
    } catch (e) {
      toast("Ошибка", e.message, "bad");
    }
  });

  // Reset confirm
  $("#btnResetConfirm")?.addEventListener("click", async () => {
    try {
      const email = $("#resetEmail")?.value || "";
      const code = $("#resetCode")?.value || "";
      const new_password = $("#resetPass")?.value || "";
      await apiPost("/api/auth/reset_confirm", { email, code, new_password });
      toast("Сброс", "Пароль обновлён", "ok");
      setAuthPane("login");
    } catch (e) {
      toast("Ошибка", e.message, "bad");
    }
  });

  // Logout + sync buttons
  $("#btnLogout")?.addEventListener("click", async () => {
    await apiPost("/api/auth/logout", {});
    toast("Профиль", "Выход выполнен", "warn");
    await refreshMe();
  });

  $("#btnSyncPull")?.addEventListener("click", () => syncPull().catch((e) => toast("Ошибка", e.message, "bad")));
  $("#btnSyncPush")?.addEventListener("click", () => syncPush().catch((e) => toast("Ошибка", e.message, "bad")));
  $("#btnChatPull")?.addEventListener("click", () => chatPull().catch((e) => toast("Ошибка", e.message, "bad")));
  $("#btnChatClear")?.addEventListener("click", () => chatClear().catch((e) => toast("Ошибка", e.message, "bad")));

  await refreshMe();

  // initial preview (if templates exist)
  renderPreview().catch(() => {});
});
