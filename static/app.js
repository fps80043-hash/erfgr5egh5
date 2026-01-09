const $ = (sel) => document.querySelector(sel);

let accountData = null;
let currentUser = null;

let toastQueue = [];
let toastBusy = false;
let toastLastAt = 0;

function toast(title, msg="", type="ok"){
  // merge duplicates
  const last = toastQueue.length ? toastQueue[toastQueue.length-1] : null;
  if(last && last.title===title && last.msg===msg && last.type===type) return;

  toastQueue.push({title, msg, type});
  if(!toastBusy) showNextToast();
}

function showNextToast(){
  const box = document.getElementById("toasts");
  if(!box){ toastQueue = []; toastBusy = false; return; }

  const item = toastQueue.shift();
  if(!item){ toastBusy = false; return; }
  toastBusy = true;

  const now = Date.now();
  const gap = Math.max(0, 420 - (now - toastLastAt)); // spacing between toasts
  toastLastAt = now + gap;

  setTimeout(()=>{
    const el = document.createElement("div");
    el.className = "toast " + item.type;
    const icon = item.type==="ok" ? "✅" : item.type==="warn" ? "⚠️" : "❌";
    el.innerHTML = `<div class="tTop"><div class="tIcon">${icon}</div><div class="tText"><div class="t1">${item.title}</div>${item.msg?`<div class="t2">${item.msg}</div>`:""}</div></div>`;
    box.appendChild(el);

    // enter animation
    requestAnimationFrame(()=> el.classList.add("show"));

    const life = 2600;
    setTimeout(()=>{ el.classList.remove("show"); el.classList.add("hide"); }, life);
    setTimeout(()=>{ el.remove(); showNextToast(); }, life + 420);
  }, gap);
}


function startBar(barId, fillId){
  const bar = document.getElementById(barId);
  const fill = document.getElementById(fillId);
  if(!bar || !fill) return ()=>{};
  bar.classList.add("active");
  fill.style.width = "0%";
  let p = 4 + Math.random()*6;
  fill.style.width = p + "%";
  const t = setInterval(()=>{
    p = Math.min(p + (3 + Math.random()*10), 92);
    fill.style.width = p + "%";
  }, 260);
  return (ok=true)=>{
    clearInterval(t);
    fill.style.width = ok ? "100%" : Math.max(p, 25) + "%";
    setTimeout(()=>{ bar.classList.remove("active"); }, 420);
  };
}


// Default templates
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

function setStatus(el, text, cls=""){
  if(!el) return;
  el.className = "status " + cls;
  el.textContent = text;
}

function copyText(text){
  if(!text) return;
  navigator.clipboard?.writeText(text).catch(()=>{});
}

let debSync = null;
function saveTpl(){
  localStorage.setItem("rst_title_tpl", $("#tplTitle")?.value || "");
  localStorage.setItem("rst_desc_tpl", $("#tplDesc")?.value || "");
  if(currentUser){
    if(debSync) clearTimeout(debSync);
    debSync = setTimeout(()=> syncPush().catch(()=>{}), 900);
  }
}


async function syncPull(){
  const j = await apiGet("/api/user/templates");
  const t = j.title_tpl || "";
  const d = j.desc_tpl || "";
  if(t) $("#tplTitle").value = t;
  if(d) $("#tplDesc").value = d;
  saveTpl();
  if(accountData) await renderPreview();
  toast("Синхронизация", "Шаблоны загружены", "ok");
}

async function syncPush(){
  const title_tpl = $("#tplTitle")?.value || "";
  const desc_tpl = $("#tplDesc")?.value || "";
  await apiPost("/api/user/templates", {title_tpl, desc_tpl});
  toast("Синхронизация", "Шаблоны сохранены", "ok");
}

async function chatPull(){
  const j = await apiGet("/api/user/chat_history");
  const log = $("#chatLog");
  if(!log) return;
  log.innerHTML = "";
  (j.messages || []).forEach(m=>{
    const who = m.role === "user" ? "Ты" : "R$T";
    const me = m.role === "user";
    pushMsg(who, m.content, me);
  });
  toast("Чат", "История загружена", "ok");
}

async function chatClear(){
  await apiPost("/api/user/chat_clear", {});
  const log = $("#chatLog");
  if(log) log.innerHTML = "";
  toast("Чат", "История очищена", "warn");
}

function loadTpl(){
  if($("#tplTitle")) $("#tplTitle").value = localStorage.getItem("rst_title_tpl") || DEFAULT_TITLE;
  if($("#tplDesc")) $("#tplDesc").value = localStorage.getItem("rst_desc_tpl") || DEFAULT_DESC;
}

async function apiGet(path){
  const r = await fetch(path, {method:'GET'});
  const j = await r.json().catch(()=> ({}));
  if(!r.ok || !j.ok){
    const msg = (j && j.detail) ? j.detail : ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return j;
}

async function apiPost(path, payload){
  const r = await fetch(path, {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload || {})
  });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok || !j.ok){
    const msg = (j && j.detail) ? j.detail : ("HTTP " + r.status);
    throw new Error(msg);
  }
  return j;
}

async function renderPreview(){
  if(!accountData) return;
  const titleTpl = $("#tplTitle")?.value || "";
  const descTpl = $("#tplDesc")?.value || "";
  const j = await apiPost("/api/preview", {data: accountData, title_template: titleTpl, desc_template: descTpl});
  if($("#outTitle")) $("#outTitle").value = j.title || "";
  if($("#outDesc")) $("#outDesc").value = j.desc || "";
}

function fillFacts(d){
  if(!d) return;
  $("#f_username").textContent = d.username || "—";
  const link = d.profile_link || "";
  $("#f_link").textContent = link ? "Открыть" : "—";
  $("#f_link").href = link || "#";
  $("#f_robux").textContent = (d.robux ?? "—");
  $("#f_rap").textContent = (d.rap_tag ?? "—");
  $("#f_total").textContent = (d.donate_tag ?? "—");
  $("#f_year").textContent = (d.year_tag ?? "—");
  $("#f_inv").textContent = (d.inv_ru ?? "—");
}

// Tabs (desktop + bottom nav)
function setActiveTab(id){
  document.querySelectorAll(".navbtn").forEach(b=>b.classList.toggle("active", b.dataset.tab===id));
  document.querySelectorAll(".btab").forEach(b=>b.classList.toggle("active", b.dataset.tab===id));
  document.querySelectorAll(".pane").forEach(p=>p.classList.remove("active"));
  const pane = document.getElementById("tab-"+id);
  if(pane) pane.classList.add("active");
  window.scrollTo({top:0, behavior:"smooth"});
}

function setupTabs(){
  document.querySelectorAll(".navbtn").forEach(btn=>{
    btn.addEventListener("click", ()=> setActiveTab(btn.dataset.tab));
  });
  document.querySelectorAll(".btab").forEach(btn=>{
    btn.addEventListener("click", ()=> setActiveTab(btn.dataset.tab));
  });
}

async function loadPollinationsModels(){
  const sel = $("#aiModel");
  if(!sel) return;
  sel.innerHTML = "";
  try{
    const r = await fetch("/api/models/pollinations");
    const j = await r.json().catch(()=>({models:["openai"]}));
    (j.models || ["openai"]).slice(0, 30).forEach(m=>{
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    sel.value = "openai";
  }catch(_e){
    ["openai","mistral"].forEach(m=>{
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    sel.value = "openai";
  }
}

function setGroqModels(){
  const sel = $("#aiModel");
  if(!sel) return;
  sel.innerHTML = "";
  ["llama-3.3-70b-versatile","llama-3.1-70b-versatile","gemma2-9b-it","mixtral-8x7b-32768"].forEach(m=>{
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  sel.value = "llama-3.3-70b-versatile";
}

// Particles (neon night)
function spawnLogoBurst(){
  const logo = document.querySelector(".logo");
  if(!logo) return;
  const EM = ["⭐"];
  // random chance, not always same cycle
  if(Math.random() < 0.35) return;
  const count = 1;
  for(let i=0;i<count;i++){
    const e = document.createElement("span");
    e.className = "emoji";
    e.textContent = EM[Math.floor(Math.random()*EM.length)];
    const ang = (Math.random()*Math.PI*2);
    const dist = 18 + Math.random()*46;
    const dx = Math.cos(ang)*dist;
    const dy = Math.sin(ang)*dist - (10 + Math.random()*10);
    const rot = (-90 + Math.random()*180) + "deg";
    e.style.setProperty("--dx", dx + "px");
    e.style.setProperty("--dy", dy + "px");
    e.style.setProperty("--rot", rot);
    e.style.fontSize = (14 + Math.random()*10) + "px";
    logo.appendChild(e);
    setTimeout(()=>e.remove(), 920);
  }
}

function initParticles(){
  const canvas = document.getElementById("particles");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  let w=0,h=0,dpr=1;
  let particles = [];
  let N = 90;

  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(window.innerWidth * dpr);
    h = canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    N = window.innerWidth < 520 ? 55 : 90;
    particles = [];
    for(let i=0;i<N;i++) particles.push(make());
  }
  function rnd(a,b){return a + Math.random()*(b-a)}
  function make(){
    return {
      x:rnd(0,w), y:rnd(0,h),
      r:rnd(1.1, 3.2)*dpr,
      vx:rnd(-0.18,0.18)*dpr,
      vy:rnd(-0.14,0.14)*dpr,
      a:rnd(0.10,0.55),
      hue:rnd(190, 290)
    };
  }

  function step(){
    ctx.clearRect(0,0,w,h);

    // dots
    for(const p of particles){
      p.x += p.vx; p.y += p.vy;
      if(p.x<0) p.x=w;
      if(p.x>w) p.x=0;
      if(p.y<0) p.y=h;
      if(p.y>h) p.y=0;

      ctx.beginPath();
      ctx.globalAlpha = p.a;
      ctx.fillStyle = `hsla(${p.hue}, 90%, 70%, 1)`;
      ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fill();
    }

    // lines
    const max = 170*dpr;
    for(let i=0;i<particles.length;i++){
      for(let j=i+1;j<particles.length;j++){
        const a = particles[i], b = particles[j];
        const dx=a.x-b.x, dy=a.y-b.y;
        const dist = Math.sqrt(dx*dx+dy*dy);
        if(dist<max){
          ctx.globalAlpha = 0.10*(1 - dist/max);
          ctx.strokeStyle = `hsla(200, 95%, 65%, 1)`;
          ctx.lineWidth = 1*dpr;
          ctx.beginPath();
          ctx.moveTo(a.x,a.y);
          ctx.lineTo(b.x,b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(step);
  }

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(step);
}

window.addEventListener("load", async ()=>{
  setupTabs();
  setActiveTab("main");
  initParticles();
  setInterval(spawnLogoBurst, 520);
  loadTpl();

  // Cookie local save (browser only)
  const cookieEl = $("#cookie");
  if(cookieEl){
    const saved = localStorage.getItem("rst_cookie") || "";
    if(saved) cookieEl.value = saved;
    let t = null;
    cookieEl.addEventListener("input", ()=>{
      if(t) clearTimeout(t);
      t = setTimeout(()=> localStorage.setItem("rst_cookie", cookieEl.value || ""), 250);
    });
  }

  // Analyze
  $("#btnAnalyze")?.addEventListener("click", async ()=>{
    const status = $("#status");
    setStatus(status, "Подключение…", "warn");
    const stopBar = startBar("pbarAnalyze","pfillAnalyze");
    toast("Подключение", "Читаю данные аккаунта…", "warn");
    $("#btnAnalyze").disabled = true;
    try{
      const cookie = ($("#cookie").value || ""); // do NOT trim
      const j = await apiPost("/api/analyze", {cookie});
      accountData = j.data;
      fillFacts(accountData);
      await renderPreview();
      setStatus(status, "Готово ✅", "ok");
      stopBar(true);
      toast("Готово", "Аккаунт проанализирован", "ok");
    }catch(e){
      setStatus(status, "Ошибка: " + e.message, "bad");
      stopBar(false);
      toast("Ошибка", e.message, "bad");
    }finally{
      $("#btnAnalyze").disabled = false;
    }
  });

  // Templates: save + live preview
  const onTplChange = async ()=>{
    saveTpl();
    if(accountData) await renderPreview();
  };
  $("#tplTitle")?.addEventListener("input", onTplChange);
  $("#tplDesc")?.addEventListener("input", onTplChange);

  $("#btnSaveTpl")?.addEventListener("click", onTplChange);
  $("#btnResetTpl")?.addEventListener("click", async ()=>{
    localStorage.removeItem("rst_title_tpl");
    localStorage.removeItem("rst_desc_tpl");
    loadTpl();
    if(accountData) await renderPreview();
    toast("Сброс", "Шаблоны восстановлены", "warn");
  });

  // Copy
  $("#btnCopyTitle")?.addEventListener("click", ()=>{ copyText($("#outTitle").value); toast("Скопировано", "Заголовок в буфере", "ok"); });
  $("#btnCopyDesc")?.addEventListener("click", ()=>{ copyText($("#outDesc").value); toast("Скопировано", "Описание в буфере", "ok"); });
  $("#btnCopyAll")?.addEventListener("click", ()=>{ copyText($("#outTitle").value + "\n\n" + $("#outDesc").value); toast("Скопировано", "Всё в буфере", "ok"); });

  // AI: models
  await loadPollinationsModels();
  $("#aiProvider")?.addEventListener("change", async ()=>{
    const p = $("#aiProvider").value;
    if(p === "groq") setGroqModels();
    else if(p === "blackbox") setBlackboxModels();
    else await loadPollinationsModels();
  });

  // Chat context label
  const ctxEl = $("#chatCtx");
  const ctxLabel = $("#chatCtxLabel");
  if(ctxEl && ctxLabel){
    const upd = ()=> ctxLabel.textContent = ctxEl.checked ? "включён" : "выключен";
    ctxEl.addEventListener("change", upd);
    upd();
  }

  function pushMsg(who, text, me=false){
    const log = $("#chatLog");
    if(!log) return;
    const m = document.createElement("div");
    m.className = "msg" + (me? " me":"");
    m.innerHTML = `<div class="who">${who}</div><div class="txt"></div>`;
    m.querySelector(".txt").textContent = text;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  }

  $("#btnChatSend")?.addEventListener("click", async ()=>{
    const inp = $("#chatMsg");
    if(!inp) return;
    const text = (inp.value || "");
    if(!text.trim()) return;
    inp.value = "";
    pushMsg("Ты", text, true);
    const stopBar = startBar("pbarChat","pfillChat");
    try{
      const provider = $("#aiProvider")?.value || "pollinations";
      const model = $("#aiModel")?.value || "";
      const include_context = $("#chatCtx")?.checked ?? true;
      const j = await apiPost("/api/chat", {
        provider,
        model,
        message: text,
        include_context,
        data: accountData || {},
        title_template: $("#tplTitle")?.value || "",
        desc_template: $("#tplDesc")?.value || "",
        current_title: $("#outTitle")?.value || "",
        current_desc: $("#outDesc")?.value || ""
      });
      pushMsg("R$T", j.reply || "…", false);
      stopBar(true);
    }catch(e){
      stopBar(false);
      toast("Ошибка", e.message, "bad");
      pushMsg("R$T", "Ошибка: " + e.message, false);
    }
  });

  $("#chatMsg")?.addEventListener("keydown", (ev)=>{
    if(ev.key === "Enter"){ ev.preventDefault(); $("#btnChatSend")?.click(); }
  });

  // AI generate
  $("#btnAIGen")?.addEventListener("click", async ()=>{
    const st = $("#aiStatus");
    setStatus(st, "Генерация…", "warn");
    const stopBar = startBar("pbarAI","pfillAI");
    toast("Генерация", "Готовлю новый текст…", "warn");
    $("#btnAIGen").disabled = true;
    try{
      if(!accountData) throw new Error("Сначала сделай анализ аккаунта");
      const provider = $("#aiProvider").value;
      const model = $("#aiModel").value;
      const mode = $("#aiMode").value;
      const tone = $("#aiTone").value;
      const extra = $("#aiExtra").value || "";

      const j = await apiPost("/api/ai_generate", {provider, model, mode, tone, extra, data: accountData});
      $("#aiRaw").textContent = j.raw || "";
      // Put generated text into templates
      if(j.title) $("#tplTitle").value = j.title;
      if(j.desc) $("#tplDesc").value = j.desc;
      saveTpl();
      await renderPreview();
      setStatus(st, "Готово ✅", "ok");
      stopBar(true);
      toast("Готово", "Шаблоны обновлены", "ok");
      // jump to main
      setActiveTab("main");
    }catch(e){
      setStatus(st, "Ошибка: " + e.message, "bad");
      stopBar(false);
      toast("Ошибка", e.message, "bad");
    }finally{
      $("#btnAIGen").disabled = false;
    }
  });

  // Auth / Profile
  async function refreshMe(){
    try{
      const j = await apiGet("/api/auth/me");
      currentUser = j.user;
    }catch(_e){
      currentUser = null;
    }
    const st = $("#meStatus");
    const authBox = $("#authBox");
    const tools = $("#profileTools");
    const lo = $("#btnLogout");
    if(currentUser){
      if(st) st.textContent = currentUser.username;
      if(authBox) authBox.style.display = "none";
      if(tools) tools.style.display = "block";
      if(lo) lo.style.display = "inline-flex";
    }else{
      if(st) st.textContent = "не вошёл";
      if(authBox) authBox.style.display = "block";
      if(tools) tools.style.display = "none";
      if(lo) lo.style.display = "none";
    }
  }

  $("#btnLogin")?.addEventListener("click", async ()=>{
    try{
      const username = $("#authUser")?.value || "";
      const password = $("#authPass")?.value || "";
      await apiPost("/api/auth/login", {username, password});
      toast("Профиль", "Вход выполнен", "ok");
      await refreshMe();
      await syncPull().catch(()=>{});
      await chatPull().catch(()=>{});
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  $("#btnRegister")?.addEventListener("click", async ()=>{
    try{
      const username = $("#authUser")?.value || "";
      const password = $("#authPass")?.value || "";
      await apiPost("/api/auth/register", {username, password});
      toast("Профиль", "Аккаунт создан — теперь войди", "ok");
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  $("#btnLogout")?.addEventListener("click", async ()=>{
    await apiPost("/api/auth/logout", {});
    toast("Профиль", "Выход выполнен", "warn");
    await refreshMe();
  });

  $("#btnSyncPull")?.addEventListener("click", ()=> syncPull().catch(e=>toast("Ошибка", e.message, "bad")));
  $("#btnSyncPush")?.addEventListener("click", ()=> syncPush().catch(e=>toast("Ошибка", e.message, "bad")));
  $("#btnChatPull")?.addEventListener("click", ()=> chatPull().catch(e=>toast("Ошибка", e.message, "bad")));
  $("#btnChatClear")?.addEventListener("click", ()=> chatClear().catch(e=>toast("Ошибка", e.message, "bad")));

  await refreshMe();

});


function setBlackboxModels(){
  const sel = $("#aiModel");
  if(!sel) return;
  sel.innerHTML = "";
  [
    "blackboxai/deepseek/deepseek-chat:free",
    "blackboxai/deepseek/deepseek-chat",
    "blackboxai/deepseek/deepseek-chat-v3-0324:free",
    "blackboxai/deepseek/deepseek-chat-v3-0324"
  ].forEach(m=>{
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m.replace("blackboxai/","BB: ");
    sel.appendChild(opt);
  });
  sel.value = "blackboxai/deepseek/deepseek-chat:free";
}
  // Profile (local)
  const pn = $("#profNick");
  if(pn){
    pn.value = localStorage.getItem("rst_nick") || "";
  }
  const ps = $("#profStatus");
  const updPS = (t)=>{ if(ps) ps.textContent = t; };
  $("#btnProfSave")?.addEventListener("click", ()=>{
    localStorage.setItem("rst_nick", pn?.value || "");
    updPS("сохранено");
    toast("Профиль", "Сохранено локально", "ok");
  });
  $("#btnProfReset")?.addEventListener("click", ()=>{
    localStorage.removeItem("rst_nick");
    if(pn) pn.value = "";
    updPS("сброшено");
    toast("Профиль", "Сброшено", "warn");
  });
