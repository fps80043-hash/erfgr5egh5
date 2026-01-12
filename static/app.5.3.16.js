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

let toastLastAt = 0;
let toastNext = null;
let toastCooldownTimer = null;

function toastIcon(type){
  if(type === "bad") return "⛔";
  if(type === "warn") return "⚡";
  return "✅";
}

function toast(title, msg="", type="ok"){
  const now = Date.now();
  const COOLDOWN_MS = 800;
  if(now - toastLastAt < COOLDOWN_MS){
    toastNext = {title, msg, type};
    if(!toastCooldownTimer){
      const wait = COOLDOWN_MS - (now - toastLastAt);
      toastCooldownTimer = setTimeout(()=>{
        toastCooldownTimer = null;
        if(toastNext){
          const t = toastNext; toastNext = null;
          toastLastAt = Date.now();
          toastQ.push(t);
          while(toastQ.length > 2) toastQ.shift();
          if(!toastBusy) drainToasts();
        }
      }, wait);
    }
    return;
  }
  toastLastAt = now;
  toastQ.push({title, msg, type});
  while(toastQ.length > 2) toastQ.shift();
  if(!toastBusy) drainToasts();
}

function drainToasts(){
  const box = document.getElementById("toasts");
  if(!box){ toastQ.length = 0; return; }

  const MAX_VISIBLE = 2;

  while(box.children.length < MAX_VISIBLE){
    const it = toastQ.shift();
    if(!it) break;

    const el = document.createElement("div");
    el.className = "toast " + it.type;
    el.innerHTML = `
      <button class="x" type="button" aria-label="Close">×</button>
      <div class="ico">${toastIcon(it.type)}</div>
      <div class="twrap">
        <div class="t1">${it.title}</div>
        ${it.msg ? `<div class="t2">${it.msg}</div>` : ``}
      </div>
    `;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));

    const SHOW_MS = 2500;
    const hide = ()=>{ el.classList.remove("show"); };
    const cleanup = ()=>{
      if(el && el.parentNode) el.parentNode.removeChild(el);
      setTimeout(drainToasts, 80);
    };

    el.querySelector(".x")?.addEventListener("click", (e)=>{
      e.preventDefault();
      hide();
      setTimeout(cleanup, 220);
    });

    setTimeout(hide, SHOW_MS);
    setTimeout(cleanup, SHOW_MS + 260);
  }
}

let currentUser = null;

// Payments (Topups + Premium by balance)
let topupCfg = null;
let selectedPack = null;
let currentPaySeg = "topup";
let currentTopupMethod = "crypto";
let currentTopupId = null;

function moneyFmt(amount, currency){
  try{
    const cur = (currency || "usd").toUpperCase();
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(amount);
  }catch(_e){
    return String(amount) + " " + (currency || "");
  }
}

async function loadTopupConfig(){
  try{
    const j = await apiGet("/api/topup/config");
    topupCfg = j;
  }catch(_e){
    topupCfg = null;
  }
}

function setPaySeg(seg){
  currentPaySeg = seg;
  $$("#paySeg .segbtn").forEach(b=>b.classList.toggle("active", b.dataset.seg === seg));
  const p1 = $("#payPaneTopup");
  const p2 = $("#payPanePremium");
  if(p1) p1.style.display = (seg === "topup") ? "block" : "none";
  if(p2) p2.style.display = (seg === "premium") ? "block" : "none";
}

function setTopupMethod(method){
  currentTopupMethod = method;
  $$("#topupSeg .segbtn").forEach(b=>b.classList.toggle("active", b.dataset.method === method));
  const pC = $("#topupPaneCrypto");
  const pP = $("#topupPanePromo");
  const pM = $("#topupPaneManual");
  if(pC) pC.style.display = (method === "crypto") ? "block" : "none";
  if(pP) pP.style.display = (method === "promo") ? "block" : "none";
  if(pM) pM.style.display = (method === "manual") ? "block" : "none";
}

function renderPacks(){
  const grid = $("#topupPacks");
  if(!grid) return;
  grid.innerHTML = "";
  selectedPack = null;

  const packs = topupCfg?.topup?.packs || [];
  const rate = Number(topupCfg?.topup?.balance_per_currency || 100);
  const fiat = topupCfg?.topup?.crypto?.fiat || "USD";

  packs.forEach((points, idx)=>{
    const cost = (Number(points) / Math.max(rate, 1));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "packBtn" + (idx===0 ? " sel" : "");
    btn.innerHTML = `<div class="p1">${points} баланса</div><div class="p2">≈ ${moneyFmt(cost, fiat)}</div>`;
    btn.addEventListener("click", ()=>{
      selectedPack = Number(points);
      $$("#topupPacks .packBtn").forEach(x=>x.classList.remove("sel"));
      btn.classList.add("sel");
    });
    grid.appendChild(btn);
    if(idx===0) selectedPack = Number(points);
  });

  // premium price
  const premPrice = $("#premPrice");
  if(premPrice){
    const pts = Number(topupCfg?.premium?.price_points || 0);
    const days = Number(topupCfg?.premium?.period_days || 30);
    premPrice.textContent = pts ? (`${pts} баланса / ${days} дней`) : "—";
  }
}

function openPayModal(seg="topup"){
  const m = $("#payModal");
  if(!m) return;
  m.style.display = "flex";
  m.classList.add("open");
  requestAnimationFrame(()=>m.classList.add("vis"));
  setPaySeg(seg);
  renderPacks();
  setTopupMethod(currentTopupMethod || "crypto");
  setCryptoLink(null, null);
  currentTopupId = null;
  const mh = $("#manualHint"); if(mh) mh.textContent = "—";
}

function closePayModal(){
  const m = $("#payModal");
  if(!m) return;
  m.classList.remove("vis");
  m.classList.remove("open");
  setTimeout(()=>{ m.style.display = "none"; }, 180);
}


function setCryptoLink(payUrl, hintText){
  const box = $("#cryptoLinkBox");
  const link = $("#cryptoPayUrl");
  const tg = $("#cryptoTgUrl");
  const hint = $("#cryptoHint");
  if(box) box.style.display = payUrl ? "block" : "none";
  if(link) link.href = payUrl || "#";

  // Open inside Telegram via share URL (works on desktop/mobile)
  let tgUrl = "#";
  try{
    if(payUrl){
      tgUrl = "https://t.me/share/url?url=" + encodeURIComponent(payUrl) + "&text=" + encodeURIComponent("Оплатить инвойс CryptoBot");
    }
  }catch(_e){}
  if(tg) tg.href = tgUrl;

  if(hint) hint.textContent = hintText || "—";
}


async function startCryptoTopup(){
  if(!selectedPack) return toast("Пополнение", "Выбери пакет", "warn");
  try{
    const j = await apiPost("/api/topup/create", { method: "crypto", points: selectedPack });
    currentTopupId = j.id;
    if(j.pay_url){
      setCryptoLink(j.pay_url, "Инвойс создан. Оплати и нажми «Проверить».");
      try{ window.open(j.pay_url, "_blank"); }catch(_e){}
      toast("Пополнение", "Открыл оплату в новой вкладке", "ok");
    }else{
      toast("Пополнение", "Инвойс создан", "ok");
    }
  }catch(e){
    toast("Пополнение", e.message || "Ошибка", "bad");
  }
}

async function checkTopup(){
  if(!currentTopupId) return toast("Пополнение", "Сначала создай инвойс", "warn");
  try{
    const j = await apiGet("/api/topup/status?id=" + encodeURIComponent(String(currentTopupId)));
    if(j.status === "paid"){
      toast("Пополнение", "Оплата подтверждена, баланс зачислен ✅", "ok");
      setCryptoLink($("#cryptoPayUrl")?.href || "", "Оплачено ✅");
      await refreshMe();
    }else{
      toast("Пополнение", "Статус: " + (j.status || "pending"), "warn");
    }
  }catch(e){
    toast("Пополнение", e.message || "Ошибка", "bad");
  }
}

async function startManualTopup(){
  if(!selectedPack) return toast("Пополнение", "Выбери пакет", "warn");
  try{
    const j = await apiPost("/api/topup/create", { method: "manual", points: selectedPack });
    const hint = $("#manualHint");
    if(hint) hint.textContent = `Заявка #${j.id} создана. Ждём админа.`;
    toast("Пополнение", "Заявка создана", "ok");
  }catch(e){
    toast("Пополнение", e.message || "Ошибка", "bad");
  }
}

async function redeemPromo(){
  const inp = $("#promoCode");
  const code = (inp?.value || "").trim();
  if(!code) return toast("Промокод", "Введи код", "warn");
  try{
    const j = await apiPost("/api/topup/redeem", { code });
    toast("Промокод", `Зачислено: +${j.credited}`, "ok");
    if(inp) inp.value = "";
    await refreshMe();
    closePayModal();
  }catch(e){
    toast("Промокод", e.message || "Ошибка", "bad");
  }
}

async function buyPremiumBalance(){
  try{
    await apiPost("/api/subscription/buy", {});
    toast("Premium", "Premium активирован ✅", "ok");
    await refreshMe();
    closePayModal();
  }catch(e){
    toast("Premium", e.message || "Ошибка", "bad");
  }
}



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

function initTilt(){
  // Touch devices: skip tilt to avoid broken taps
  if(window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;

  const els = $$(".tilt");
  els.forEach(el=>{
    if(el.matches(":disabled")) return;

    const set = (e)=>{
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      const ry = (x - 0.5) * 10;   // deg
      const rx = -(y - 0.5) * 8;  // deg
      el.style.setProperty("--mx", (x*100).toFixed(2) + "%");
      el.style.setProperty("--my", (y*100).toFixed(2) + "%");
      el.style.setProperty("--rx", rx.toFixed(2) + "deg");
      el.style.setProperty("--ry", ry.toFixed(2) + "deg");
    };

    el.addEventListener("mouseenter", (e)=>{
      el.style.transition = "transform 140ms ease, box-shadow 160ms ease, border-color 160ms ease";
      set(e);
    });

    el.addEventListener("mousemove", (e)=>{
      // quick, but still smooth
      el.style.transition = "transform 70ms linear";
      set(e);
    });

    el.addEventListener("mouseleave", ()=>{
      // smooth return (prevents jerky re-hover)
      el.style.transition = "transform 280ms ease";
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
      el.style.setProperty("--mx", "50%");
      el.style.setProperty("--my", "50%");
    });
  });
}

// -------------------------

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
  const safeModels = (Array.isArray(models) && models.length) ? models : ["Default"];
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

  // Tools UX: always return to landing when opening tools tab
  if (name === "tools" && typeof toolsBack === "function") {
    toolsBack(true);
  }

  if(name === "profile"){
    refreshMe().catch(()=>{});
    txPull && txPull().catch(()=>{});
  }

}

let currentTool = null;

const TOOL_META = {
  gen: { title: "Генерация описания", sub: "Cookie → анализ → шаблон → результат" },
  chat:{ title: "AI чат", sub: "Отдельный чат с моделью (Premium)" },
  ai:  { title: "AI генератор", sub: "Сгенерирует новый заголовок и описание" },
  checker: { title: "Checker", sub: "Проверка аккаунтов / данных", soon: true },
  refresher: { title: "Refresher", sub: "Обновление/рефреш данных", soon: true },
  bulk: { title: "Bulk tools", sub: "Пакетные операции", soon: true },
};

function setTool(name){
  currentTool = name;
  const panes = {
    gen: $("#toolPaneGen"),
    ai: $("#toolPaneAI"),
    chat: $("#toolPaneChat"),
    soon: $("#toolPaneSoon"),
  };
  Object.entries(panes).forEach(([k, el]) => {
    if (!el) return;
    el.style.display = (k === name) ? "block" : "none";
  });
}

function toolsOpen(name){
  const meta = TOOL_META[name] || { title: "Инструмент", sub: "" };
  const landing = $("#toolsLanding");
  const topbar = $("#toolsTopbar");
  if (landing) landing.style.display = "none";
  if (topbar) topbar.style.display = "flex";

  const t = $("#toolsTitle");
  const s = $("#toolsSub");
  if (t) t.textContent = meta.title || "—";
  if (s) s.textContent = meta.sub || "";

  if (meta.soon) {
    const st = $("#soonTitle");
    const sd = $("#soonDesc");
    if (st) st.textContent = meta.title || "—";
    if (sd) sd.textContent = meta.sub || "—";
    setTool("soon");
    return;
  }

  setTool(name);
  // scroll to top of tools pane for clean UX
  const pane = $("#tab-tools");
  if (pane) pane.scrollIntoView({behavior:"smooth", block:"start"});
}

function toolsBack(silent=false){
  const landing = $("#toolsLanding");
  const topbar = $("#toolsTopbar");
  if (landing) landing.style.display = "block";
  if (topbar) topbar.style.display = "none";
  setTool(null); // hide all
  // hide panes
  $$(".toolPane").forEach(p => p.style.display = "none");
  currentTool = null;
  if (!silent) toast("Инструменты", "Выбери модуль", "ok");
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
  const caseBox = $("#caseBox");
  const limitsBox = $("#limitsBox");
  const balBox = $("#balanceBox");
  const balVal = $("#balanceValue");
  const premPayBox = $("#premiumPayBox");
  const premState = $("#premiumState");
  const premDesc = $("#premiumDesc");
  const btnTopUp = $("#btnTopUp");
  const btnBuyPremium = $("#btnBuyPremium");
  const adminBox = $("#adminBox");
  const adminUserCard = $("#adminUserCard");

  if (currentUser) {
    if(!topupCfg) await loadTopupConfig();
    const extra = currentUser.email ? ` • ${currentUser.email}` : "";
    if (st) st.textContent = `${currentUser.username}${extra}`;
    if (authBox) authBox.style.display = "none";
    if (tools) tools.style.display = "block";
    if (lo) lo.style.display = "inline-flex";
    if (caseBox) caseBox.style.display = "block";
    if (limitsBox) limitsBox.style.display = "block";
    if (balBox) balBox.style.display = "block";
    if (balVal) balVal.textContent = String(currentUser.balance ?? 0);

    const topBalBox = $("#topBalanceBox");
    const topBalVal = $("#topBalanceValue");
    if (topBalBox) topBalBox.style.display = "flex";
    if (topBalVal) topBalVal.textContent = String(currentUser.balance ?? 0);
    if (premPayBox) premPayBox.style.display = "block";
    if (adminBox) adminBox.style.display = (currentUser.is_admin ? "block" : "none");
    if (currentUser.is_admin){
      const tbox = $("#adminTopupsList");
      const pbox = $("#adminPromoList");
      if(tbox && (tbox.textContent || "").trim() === "—") adminTopupsRefresh();
      if(pbox && (pbox.textContent || "").trim() === "—") adminPromosRefresh();
    }
    if (!currentUser.is_admin && adminUserCard) adminUserCard.style.display = "none";


    const lim = currentUser.limits || null;
    if (lim) {
      const prem = !!lim.premium;
      const badge = $("#badgePremium");
      if (badge) badge.textContent = prem ? "PREMIUM" : "FREE";

      const a = $("#limAnalyze");
      const ai = $("#limAI");
      const pu = $("#limPremiumUntil");
      const cs = $("#limCase");
      if (a) a.textContent = prem ? "∞" : String(lim.credits_analyze ?? 0);
      if (ai) ai.textContent = prem ? "∞" : String(lim.credits_ai ?? 0);
      if (pu) pu.textContent = prem ? (lim.premium_until ? new Date(lim.premium_until).toLocaleString() : "активен") : "—";
      if (cs) cs.textContent = lim.case_next_at ? ("КД до " + new Date(lim.case_next_at).toLocaleString()) : "доступен";

      // Hide/lock chat UI for non-premium (server also blocks)
      const chatBox = $("#chatBox");
      const chatMsg = $("#chatMsg");
      const chatLog = $("#chatLog");
      const btnSend = $("#btnChatSend");
      if (!prem) {
        if (chatBox) chatBox.style.display = "none";
        if (chatMsg) chatMsg.value = "";
        if (btnSend) btnSend.disabled = true;
        if (chatLog && !chatLog.dataset.locked) {
          chatLog.dataset.locked = "1";
          const div = document.createElement("div");
          div.className = "muted";
          div.style.padding = "10px 2px";
          div.textContent = "Чат с ИИ доступен только в Premium.";
          chatLog.prepend(div);
        }
      } else {
        if (chatBox) chatBox.style.display = "flex";
        if (btnSend) btnSend.disabled = false;
      }

// Payment CTA state (topups + premium)
const cryptoOk = !!(topupCfg?.topup?.crypto?.enabled);
const promoOk  = !!(topupCfg?.topup?.promo?.enabled);
const manualOk = !!(topupCfg?.topup?.manual?.enabled);
const anyTopup = cryptoOk || promoOk || manualOk;
const premPricePts = Number(topupCfg?.premium?.price_points || 0);

if(premState) premState.textContent = prem ? "ACTIVE" : "FREE";
if(premDesc){
  if(prem){
    premDesc.textContent = lim.premium_until ? ("Premium активен до: " + new Date(lim.premium_until).toLocaleString()) : "Premium активен";
  }else{
    premDesc.textContent = premPricePts ? ("Premium стоит " + premPricePts + " баланса. Можно купить прямо здесь.") : "Premium можно купить за баланс.";
  }
}
if(btnTopUp) btnTopUp.disabled = !anyTopup;
if(btnBuyPremium) btnBuyPremium.disabled = prem || (premPricePts > 0 && Number(currentUser.balance || 0) < premPricePts);
    }

    // refresh case hint
    await caseStatus().catch(() => {});
  } else {
    if (st) st.textContent = "не вошёл";
    if (authBox) authBox.style.display = "block";
    if (tools) tools.style.display = "none";
    if (lo) lo.style.display = "none";
    if (caseBox) caseBox.style.display = "none";
    if (limitsBox) limitsBox.style.display = "none";

    if (balBox) balBox.style.display = "none";

    const topBalBox = $("#topBalanceBox");
    if (topBalBox) topBalBox.style.display = "none";
    if (premPayBox) premPayBox.style.display = "none";
    if (adminBox) adminBox.style.display = "none";
    if (adminUserCard) adminUserCard.style.display = "none";

    // also hide chat input if logged out
    const chatBox = $("#chatBox");
    const btnSend = $("#btnChatSend");
    if (chatBox) chatBox.style.display = "none";
    if (btnSend) btnSend.disabled = true;
  }
}


// -------------------------
// Admin: balance management
// -------------------------
let adminSelected = null;

function renderAdminTx(tx){
  const box = $("#adminTxBox");
  const list = $("#adminTxList");
  if(!box || !list) return;
  if(!tx || tx.length === 0){
    box.style.display = "none";
    list.innerHTML = "";
    return;
  }
  box.style.display = "block";
  list.innerHTML = tx.map(t=>{
    const when = t.ts ? new Date(t.ts).toLocaleString() : "";
    const delta = (t.delta >= 0 ? "+" : "") + String(t.delta);
    const reason = t.reason ? escapeHtml(t.reason) : "—";
    return `<div style="display:flex; gap:10px; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,.06)">
      <span class="mono" style="opacity:.9">${when}</span>
      <span class="mono" style="opacity:.95">${delta}</span>
      <span style="flex:1; text-align:right; opacity:.85">${reason}</span>
    </div>`;
  }).join("");
}

async function adminLoadTx(userId){
  try{
    const j = await apiGet(`/api/admin/tx?user_id=${encodeURIComponent(userId)}`);
    renderAdminTx(j.tx || []);
  }catch(_e){
    renderAdminTx([]);
  }
}

async function adminFind(){
  const ident = ($("#adminIdent")?.value || "").trim();
  if(!ident) return toast("Админ", "Введите username/email/id", "warn");
  try{
    const j = await apiGet(`/api/admin/user?ident=${encodeURIComponent(ident)}`);
    adminSelected = j.user;
    const card = $("#adminUserCard");
    if(card) card.style.display = "block";
    $("#adm_id").textContent = adminSelected.id;
    $("#adm_username").textContent = adminSelected.username;
    $("#adm_email").textContent = adminSelected.email || "—";
    $("#adm_balance").textContent = String(adminSelected.balance ?? 0);
    await adminLoadTx(adminSelected.id);
    toast("Админ", "Пользователь найден", "ok");
  }catch(e){
    adminSelected = null;
    const card = $("#adminUserCard");
    if(card) card.style.display = "none";
    toast("Админ", e.message, "bad");
  }
}

async function adminApply(){
  if(!adminSelected) return toast("Админ", "Сначала найди пользователя", "warn");
  const deltaRaw = ($("#adm_delta")?.value || "").trim();
  if(!deltaRaw) return toast("Админ", "Введите сумму", "warn");
  const delta = parseInt(deltaRaw, 10);
  if(!Number.isFinite(delta) || delta === 0) return toast("Админ", "Сумма должна быть числом (не 0)", "warn");
  const reason = ($("#adm_reason")?.value || "").trim();

  try{
    const j = await apiPost("/api/admin/balance_adjust", {
      user_id: adminSelected.id,
      delta,
      reason
    });
    // update UI
    adminSelected.balance = j.new_balance;
    $("#adm_balance").textContent = String(j.new_balance);
    $("#adm_delta").value = "";
    // if admin changed himself, refresh balance badge
    await refreshMe();
    await adminLoadTx(adminSelected.id);
    toast("Баланс обновлён", `${j.old_balance} → ${j.new_balance} (${(j.applied_delta>=0?"+":"") + j.applied_delta})`, "ok");
  }catch(e){
    toast("Ошибка", e.message, "bad");
  }
}


async function adminTopupsRefresh(){
  const box = $("#adminTopupsList");
  if(!box) return;
  box.textContent = "Загрузка…";
  try{
    const j = await apiGet("/api/admin/topups?status=pending&limit=100");
    const items = j.items || [];
    if(items.length === 0){
      box.textContent = "Заявок нет";
      return;
    }
    box.innerHTML = items.map(it=>{
      const when = it.created_at ? new Date(it.created_at).toLocaleString() : "";
      const who = escapeHtml(it.username || ("#" + it.user_id));
      return `<div style="display:flex; gap:10px; align-items:center; justify-content:space-between; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06)">
        <div style="flex:1; min-width:0">
          <div style="font-weight:700">${who}</div>
          <div class="muted" style="font-size:12px">#${it.id} • ${it.points} баланса • ${when}</div>
        </div>
        <div style="display:flex; gap:8px">
          <button class="btn" data-act="approve" data-id="${it.id}">✅</button>
          <button class="btn" data-act="reject" data-id="${it.id}">✖️</button>
        </div>
      </div>`;
    }).join("");
    // bind
    box.querySelectorAll("button[data-act]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        try{
          if(act === "approve"){
            await apiPost("/api/admin/topup/approve", { id: Number(id) });
            toast("Админ", "Зачислено ✅", "ok");
          }else{
            await apiPost("/api/admin/topup/reject", { id: Number(id) });
            toast("Админ", "Отклонено", "warn");
          }
          await adminTopupsRefresh();
          await refreshMe();
        }catch(e){
          toast("Админ", e.message || "Ошибка", "bad");
        }
      });
    });
  }catch(e){
    box.textContent = "Ошибка загрузки";
  }
}

async function adminPromosRefresh(){
  const box = $("#adminPromoList");
  if(!box) return;
  box.textContent = "Загрузка…";
  try{
    const j = await apiGet("/api/admin/promo/list?limit=100");
    const items = j.items || [];
    if(items.length === 0){
      box.textContent = "Промокодов нет";
      return;
    }
    box.innerHTML = items.map(p=>{
      const left = (Number(p.max_uses||0) - Number(p.uses||0));
      const when = p.created_at ? new Date(p.created_at).toLocaleString() : "";
      return `<div style="display:flex; gap:10px; align-items:center; justify-content:space-between; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06)">
        <div style="flex:1; min-width:0">
          <div class="mono" style="font-weight:800">${escapeHtml(p.code)}</div>
          <div class="muted" style="font-size:12px">${p.points} баланса • осталось: ${left}/${p.max_uses} • ${when}</div>
        </div>
        <button class="btn" data-copy="${escapeHtml(p.code)}">Копировать</button>
      </div>`;
    }).join("");
    box.querySelectorAll("button[data-copy]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const code = btn.dataset.copy || "";
        const ok = await copyText(code);
        toast(ok ? "Скопировано" : "Ошибка", ok ? "Промокод в буфере" : "Не удалось скопировать", ok ? "ok" : "bad");
      });
    });
  }catch(e){
    box.textContent = "Ошибка загрузки";
  }
}

async function adminPromoCreate(){
  const ptsRaw = ($("#adm_promo_points")?.value || "").trim();
  const maxRaw = ($("#adm_promo_max")?.value || "").trim();
  const codeRaw = ($("#adm_promo_code")?.value || "").trim();
  const points = parseInt(ptsRaw, 10);
  const max_uses = maxRaw ? parseInt(maxRaw, 10) : 1;
  if(!Number.isFinite(points) || points <= 0) return toast("Промокод", "Введите баланс (>0)", "warn");
  try{
    const j = await apiPost("/api/admin/promo/create", {
      points,
      max_uses: Number.isFinite(max_uses) && max_uses > 0 ? max_uses : 1,
      code: codeRaw || undefined,
    });
    toast("Промокод", `Создан: ${j.code}`, "ok");
    $("#adm_promo_code").value = j.code;
    await adminPromosRefresh();
  }catch(e){
    toast("Промокод", e.message || "Ошибка", "bad");
  }
}


// -------------------------
// Boot
// -------------------------
window.addEventListener("load", async () => {
  // nav
  $$(".navbtn").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $$(".btab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  $("#btnScrollCase")?.addEventListener("click", ()=>{ const el = $("#caseBox"); if(el) el.scrollIntoView({behavior:"smooth", block:"start"}); });

  // home CTAs
  $("#btnGoTools")?.addEventListener("click", ()=>setTab("tools"));
  $("#btnGoShop")?.addEventListener("click", ()=>setTab("shop"));

  // shop CTAs
  $("#btnTopUpShop")?.addEventListener("click", ()=>openPayModal("topup"));
  $("#btnOpenPremiumShop")?.addEventListener("click", ()=>openPayModal("premium"));
  $("#btnOpenPremium2")?.addEventListener("click", ()=>openPayModal("premium"));

// shop: search + sort with hints
const initShopSearchSort = ()=>{
  const input = $("#shopSearch");
  const sel = $("#shopSort");
  const grid = document.querySelector("#tab-shop .productGrid");
  if(!input || !sel || !grid) return;
  const cards = Array.from(grid.querySelectorAll(".productCard"));
  const meta = cards.map(el=>{
    const name = (el.querySelector(".productName")?.textContent || "").trim();
    const desc = (el.querySelector(".productDesc")?.textContent || "").trim();
    return { el, name, desc, key:(name+" "+desc).toLowerCase() };
  });
  const apply = ()=>{
    const q = (input.value||"").trim().toLowerCase();
    // filter
    meta.forEach(m=>{
      const ok = !q || m.key.includes(q);
      m.el.style.display = ok ? "" : "none";
    });
    // sort visible
    const mode = sel.value || "default";
    const vis = meta.filter(m=>m.el.style.display !== "none");
    if(mode === "name_asc"){
      vis.sort((a,b)=>a.name.localeCompare(b.name, "ru"));
    } else if(mode === "name_desc"){
      vis.sort((a,b)=>b.name.localeCompare(a.name, "ru"));
    }
    // re-append in order
    if(mode !== "default"){
      vis.forEach(m=>grid.appendChild(m.el));
    }
  };
  input.addEventListener("input", apply);
  sel.addEventListener("change", apply);
  apply();
};
initShopSearchSort();

  // header balance button
  $("#btnTopBalance")?.addEventListener("click", ()=>openPayModal("topup"));

  // tools switcher 
  $$(".toolCard").forEach(btn=>{
    const name = btn.dataset.tool;
    if(!name) return;
    btn.addEventListener("click", ()=>{
      toolsOpen(name);
    });
  });

  $("#btnToolsBack")?.addEventListener("click", ()=>toolsBack(true));
  $("#btnSoonBack")?.addEventListener("click", ()=>toolsBack(true));

  // show landing by default
  toolsBack(true);


// --- Case data (moved up to avoid TDZ) ---
let caseToken = "";
let caseSpinning = false;

const CASE_ITEMS = [
  { key:"GEN10", label:"+10 анализов", icon:"⚡", weight:450 },
  { key:"AI3",   label:"+3 генерации (AI+анализ)", icon:"✨", weight:350 },
  { key:"P6H",   label:"Premium 6 часов", icon:"💎", weight:100 },
  { key:"P12H",  label:"Premium 12 часов", icon:"💎", weight:50 },
  { key:"P24H",  label:"Premium 24 часа", icon:"💎", weight:25 },
  { key:"P2D",   label:"Premium 2 дня", icon:"💎", weight:12 },
  { key:"P3D",   label:"Premium 3 дня", icon:"💎", weight:8 },
  { key:"P7D",   label:"Premium 7 дней", icon:"💎", weight:5 },
];


// tilt effects
  initTilt();
  buildCaseUI();

  // profile modals
  $("#btnShowSavedTemplates")?.addEventListener("click", openSavedTemplates);
  $("#btnShowTx")?.addEventListener("click", openTxModal);

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
  ( $("#btnAiGenerate") || $("#btnAIGen") )?.addEventListener("click", async () => {
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
      if (currentUser && currentUser.limits && currentUser.limits.premium) {
        if (currentUser && currentUser.limits && currentUser.limits.premium) { await chatPull().catch(() => {}); }
      }
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
      if (currentUser && currentUser.limits && currentUser.limits.premium) {
        if (currentUser && currentUser.limits && currentUser.limits.premium) { await chatPull().catch(() => {}); }
      }
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

  // Admin panel
  $("#btnAdminFind")?.addEventListener("click", adminFind);
  $("#adminIdent")?.addEventListener("keydown", (e)=>{ if(e.key === "Enter") adminFind(); });
  $("#btnAdminApply")?.addEventListener("click", adminApply);
  $("#btnAdminTopupsRefresh")?.addEventListener("click", adminTopupsRefresh);
  $("#btnAdminPromosRefresh")?.addEventListener("click", adminPromosRefresh);
  $("#btnAdminPromoCreate")?.addEventListener("click", adminPromoCreate);

  // Payments
  await loadTopupConfig();
  $("#btnTopUp")?.addEventListener("click", () => openPayModal("topup"));
  $("#btnBuyPremium")?.addEventListener("click", () => openPayModal("premium"));
  $("#btnPayClose")?.addEventListener("click", closePayModal);
  $("#payBack")?.addEventListener("click", closePayModal);
  $$("#paySeg .segbtn").forEach(b=>b.addEventListener("click", ()=>setPaySeg(b.dataset.seg)));
  // Topup methods
  $$("#topupSeg .segbtn").forEach(b=>b.addEventListener("click", ()=>setTopupMethod(b.dataset.method)));
  $("#btnTopupCrypto")?.addEventListener("click", startCryptoTopup);
  $("#btnTopupCheck")?.addEventListener("click", checkTopup);
  $("#btnPromoRedeem")?.addEventListener("click", redeemPromo);
  $("#btnTopupManual")?.addEventListener("click", startManualTopup);
  $("#btnPayPremium")?.addEventListener("click", buyPremiumBalance);
  window.addEventListener("keydown", (e)=>{ if(e.key === "Escape") closePayModal(); });

  await refreshMe();

  // initial preview (if templates exist)
  renderPreview().catch(() => {});

// --- Case (shop) ---
function buildCaseUI(){
  // prizes modal list
  const list = $("#casePrizesList");
  if(list){
    list.innerHTML = "";
    const total = CASE_ITEMS.reduce((s,x)=>s+x.weight,0);
    CASE_ITEMS.forEach(it=>{
      const row = document.createElement("div");
      row.className = "prizeRow";
      const pct = ((it.weight/total)*100).toFixed(1) + "%";
      row.innerHTML = `
        <div class="prIco">${it.icon}</div>
        <div>
          <div class="prT">${it.label}</div>
          <div class="muted" style="font-size:12px">${it.key}</div>
        </div>
        <div class="prW">${pct}</div>
      `;
      list.appendChild(row);
    });
  }

  // reel
  const reel = $("#caseReel");
  if(reel){
    reel.innerHTML = "";
    const seq = [];
    // Build long sequence for smooth spin
    for(let i=0;i<7;i++){
      CASE_ITEMS.forEach(it=>seq.push(it));
    }
    // Extra random tail
    for(let i=0;i<18;i++){
      seq.push(CASE_ITEMS[Math.floor(Math.random()*CASE_ITEMS.length)]);
    }
    seq.forEach((it)=>{
      const d = document.createElement("div");
      d.className = "casePrize" + (it.key.startsWith("P") ? " prem" : "");
      d.dataset.prize = it.key;
      d.textContent = it.label;
      reel.appendChild(d);
    });
  }

  // modal open/close
  $("#btnCasePrizes")?.addEventListener("click", ()=>openCasePrizes());
  $("#btnCasePrizesClose")?.addEventListener("click", ()=>closeCasePrizes());
  $("#casePrizesBack")?.addEventListener("click", ()=>closeCasePrizes());
  window.addEventListener("keydown", (e)=>{ if(e.key==="Escape") closeCasePrizes(); });
}

function openCasePrizes(){
  const m = $("#casePrizesModal");
  if(m) m.style.display = "flex";
}

function closeCasePrizes(){
  const m = $("#casePrizesModal");
  if(m) m.style.display = "none";
}

function openSavedTemplates(){
  const m = $("#savedTemplatesModal");
  const list = $("#savedTemplatesList");
  if(list){
    const titleTpl = (localStorage.getItem("rst_title_tpl") || $("#tplTitle")?.value || "").trim();
    const descTpl  = (localStorage.getItem("rst_desc_tpl")  || $("#tplDesc")?.value || "").trim();
    list.innerHTML = "";

    const make = (name, val)=>{
      const row = document.createElement("div");
      row.className = "prizeRow";
      row.innerHTML = `
        <div class="prIco">📄</div>
        <div style="flex:1">
          <div class="prT">${escapeHtml(name)}</div>
          <pre class="rawbox" style="margin:8px 0 0 0; white-space:pre-wrap">${escapeHtml(val || "—")}</pre>
        </div>
      `;
      return row;
    };
    list.appendChild(make("Шаблон заголовка", titleTpl));
    list.appendChild(make("Шаблон описания", descTpl));
  }
  if(m) m.style.display = "flex";
}
function closeSavedTemplates(){
  const m = $("#savedTemplatesModal");
  if(m) m.style.display = "none";
}

async function openTxModal(){
  const m = $("#txModal");
  const list = $("#txList");
  if(list) list.innerHTML = "";
  if(m) m.style.display = "flex";
  if(!currentUser){
    if(list) list.innerHTML = '<div class="muted">Сначала войди в аккаунт.</div>';
    return;
  }
  try{
    const j = await apiGet("/api/user/tx?limit=50");
    const items = j.items || [];
    if(!items.length){
      if(list) list.innerHTML = '<div class="muted">Пока пусто.</div>';
      return;
    }
    if(list){
      list.innerHTML = "";
      items.forEach(it=>{
        const row = document.createElement("div");
        row.className = "prizeRow";
        const d = Number(it.delta || 0);
        const sign = d >= 0 ? "+" : "";
        const ts = it.ts ? new Date(it.ts).toLocaleString() : "—";
        row.innerHTML = `
          <div class="prIco">${d>=0?"💚":"🟥"}</div>
          <div style="flex:1">
            <div class="prT">${sign}${d}</div>
            <div class="muted" style="font-size:12px">${escapeHtml(it.reason || "")}</div>
          </div>
          <div class="prW">${escapeHtml(ts)}</div>
        `;
        list.appendChild(row);
      });
    }
  }catch(e){
    if(list) list.innerHTML = '<div class="muted">Ошибка: ' + escapeHtml(e.message || "—") + '</div>';
  }
}
function closeTxModal(){
  const m = $("#txModal");
  if(m) m.style.display = "none";
}

// modal close binds
$("#btnSavedTemplatesClose")?.addEventListener("click", closeSavedTemplates);
$("#savedTemplatesBack")?.addEventListener("click", closeSavedTemplates);
$("#btnTxClose")?.addEventListener("click", closeTxModal);
$("#txBack")?.addEventListener("click", closeTxModal);


async function caseStatus(){
  const st = await apiGet("/api/case/status").catch(()=>null);
  if(!st || !st.ok){ return null; }
  const hint = $("#caseHint");
  if(st.ready){
    if(hint) hint.textContent = "Доступен";
  }else{
    if(hint) hint.textContent = "КД до: " + (st.next_at ? new Date(st.next_at).toLocaleString() : "—");
  }
  return st;
}

function caseSpinTo(prizeKey){
  const reel = $("#caseReel");
  const vp = reel?.parentElement;
  if(!reel || !vp) return;
  const cards = Array.from(reel.querySelectorAll(".casePrize"));
  // pick a late occurrence of prize
  const idxs = cards.map((c,i)=>c.dataset.prize===prizeKey?i:-1).filter(i=>i>=0);
  const pick = idxs.filter(i=>i>12);
  const idx = (pick.length ? pick[Math.floor(Math.random()*pick.length)] : (idxs[0] ?? 0));
  const card = cards[idx];
  const vpRect = vp.getBoundingClientRect();
  const cRect = card.getBoundingClientRect();
  // compute current left of card relative to reel by using offsetLeft
  const targetLeft = card.offsetLeft;
  const target = targetLeft - (vpRect.width/2 - card.offsetWidth/2);

  // kick
  reel.style.transition = "none";
  reel.style.transform = "translateX(0px)";
  void reel.offsetWidth; // reflow
  reel.style.transition = "transform 3.1s cubic-bezier(.08,.82,.12,1)";
  reel.style.transform = `translateX(${-Math.max(0,target)}px)`;
}

$("#btnCaseChallenge")?.addEventListener("click", async () => {
  try{
    const ch = await apiGet("/api/case/challenge");
    caseToken = ch.token || "";
    toast("Кейс", `Капча: ${ch.a} + ${ch.b} = ?`, "inf");
    $("#caseResult") && ($("#caseResult").textContent = "Капча получена — введи ответ и крути 🎰");
  }catch(e){
    toast("Кейс", e.message || "Ошибка", "bad");
  }
});

$("#btnCaseOpen")?.addEventListener("click", async ()=>{
  if(!currentUser){ toast("Профиль","Сначала войди в аккаунт","warn"); try{ showTab("profile"); }catch(_e){} return; }

  if(caseSpinning) return;
  try{
    const answer = ($("#caseAnswer")?.value || "").trim();
    if(!caseToken){
      toast("Кейс", "Сначала получи капчу", "warn");
      return;
    }
    if(!answer){
      toast("Кейс", "Введи ответ капчи", "warn");
      return;
    }

    caseSpinning = true;
    const resBox = $("#caseResult");
    if(resBox) resBox.textContent = "Крутим…";

    // During request, give a tiny fake movement
    const reel = $("#caseReel");
    if(reel){
      reel.style.transition = "transform .35s ease";
      reel.style.transform = "translateX(-160px)";
    }

    const r = await apiPost("/api/case/open", { token: caseToken, answer });
    caseToken = "";

    // animate to final prize
    caseSpinTo(r.prize);

    const map = {
      GEN10: "+10 анализов",
      AI3: "+3 генерации (AI+анализ)",
      P6H: "Premium на 6 часов",
      P12H: "Premium на 12 часов",
      P24H: "Premium на 24 часа",
      P2D: "Premium на 2 дня",
      P3D: "Premium на 3 дня",
      P7D: "Premium на 7 дней",
    };

    setTimeout(async ()=>{
      if(resBox) resBox.textContent = "Выигрыш: " + (map[r.prize] || r.prize);
      toast("Кейс", "Выигрыш: " + (map[r.prize] || r.prize), "ok");
      caseSpinning = false;
      await refreshMe();
      await caseStatus().catch(()=>{});
    }, 3200);

  }catch(e){
    caseSpinning = false;
    toast("Кейс", e.message || "Ошибка", "bad");
  }
});


// --- Hotfix: Pay modal always closable (click backdrop) ---
(function payModalBackdropHotfix(){
  const onBackdrop = (e)=>{
    const m = document.getElementById("payModal");
    if(!m) return;
    if(m.style.display === "none") return;
    // if the modal itself is the overlay container, close when clicking directly on it
    if(e.target === m) {
      try{ closePayModal(); }catch(_e){}
    }
    // also close if clicked element explicitly marked as backdrop
    if(e.target && (e.target.classList?.contains("modalBackdrop") || e.target.dataset?.backdrop === "1")){
      try{ closePayModal(); }catch(_e){}
    }
  };
  document.addEventListener("pointerdown", onBackdrop, true);
})();

});


/* productCardGlowVars */
(function(){
  const onMove = (e)=>{
    const card = e.target.closest?.(".productCard");
    if(!card) return;
    const r = card.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1,r.width))*100;
    const y = ((e.clientY - r.top) / Math.max(1,r.height))*100;
    card.style.setProperty("--mx", x.toFixed(2)+"%");
    card.style.setProperty("--my", y.toFixed(2)+"%");
  };
  document.addEventListener("pointermove", onMove, {passive:true});
})();
