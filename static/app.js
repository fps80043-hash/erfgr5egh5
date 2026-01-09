const $ = (sel) => document.querySelector(sel);

let accountData = null;
let cookieSaved = false;

const DEFAULT_TPL_HEAD = "⭐ ТОП {year_tag} | {donate_tag} ДОНАТА";
const DEFAULT_TPL_BODY = `✨ Восхитительный аккаунт ждёт тебя! 👤 Ник: {username}
🔗 Ссылка: {profile_link}
💰 Robux: {robux}
💎 RAP: {rap_tag}
💳 Донат/траты: {donate_tag}
📅 Год: {year_tag}
🧾 Инвентарь: {inv_ru}

✨ Почему выбирают нас?
- Быстрая выдача после оплаты
- Гарантия и прозрачность сделки
- Выгодная цена

❗ Важно:
1) Проверь инвентарь и данные сразу после получения.
2) Сменить пароль/почту рекомендуется сразу.`;

function setStatus(el, text, cls=""){
  el.className = "status " + cls;
  el.textContent = text;
}

function saveTpl(){
  localStorage.setItem("tplHead", $("#tplHead").value || "");
  localStorage.setItem("tplBody", $("#tplBody").value || "");
}

function loadTpl(){
  $("#tplHead").value = localStorage.getItem("tplHead") || DEFAULT_TPL_HEAD;
  $("#tplBody").value = localStorage.getItem("tplBody") || DEFAULT_TPL_BODY;
}

async function api(path, payload){
  const r = await fetch(path, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload || {})
  });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok || !j.ok){
    const msg = (j && j.detail) ? j.detail : (j && j.error) ? j.error : ("HTTP " + r.status);
    throw new Error(msg);
  }
  return j;
}

async function renderPreview(){
  if(!accountData) return;
  const headTpl = $("#tplHead").value || "";
  const bodyTpl = $("#tplBody").value || "";
  const j = await api("/api/preview", {data: accountData, head_template: headTpl, body_template: bodyTpl});
  $("#outHead").value = j.head || "";
  $("#outBody").value = j.body || "";
}

function fillFacts(d){
  $("#f_username").textContent = d.username || "—";
  const link = d.profile_link || "";
  $("#f_link").textContent = link ? "Открыть" : "—";
  $("#f_link").href = link || "#";
  $("#f_robux").textContent = (d.robux ?? "—");
  $("#f_rap").textContent = (d.rap_tag ?? "—");
  $("#f_total").textContent = (d.donate_tag ?? "—");
  $("#f_year").textContent = (d.year_tag ?? "—");
  $("#f_age").textContent = (d.age ?? "—");
  $("#f_inv").textContent = (d.inv_ru ?? "—");
}

function copyText(text){
  if(!text) return;
  navigator.clipboard?.writeText(text).catch(()=>{});
}

async function loadPollinationsModels(){
  const r = await fetch("/api/models/pollinations");
  const j = await r.json().catch(()=>({models:["openai"]}));
  const sel = $("#aiModel");
  sel.innerHTML = "";
  (j.models || ["openai"]).slice(0, 20).forEach(m=>{
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  sel.value = "openai";
}


function parseSSE(buffer){
  // returns {events: [{event, data}], rest}
  const out = [];
  let idx;
  while((idx = buffer.indexOf("\n\n")) !== -1){
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);

    let ev = "message";
    let dataLines = [];
    raw.split("\n").forEach(line=>{
      if(line.startsWith("event:")){
        ev = line.slice(6).trim();
      }else if(line.startsWith("data:")){
        dataLines.push(line.slice(5).trimStart());
      }
    });
    if(dataLines.length){
      out.push({event: ev, data: dataLines.join("\n")});
    }
  }
  return {events: out, rest: buffer};
}

function setActiveTab(id){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===id));
  document.querySelectorAll('.btab').forEach(b=>b.classList.toggle('active', b.dataset.tab===id));
  document.querySelectorAll('.tabpane').forEach(p=>p.classList.remove('active'));
  const pane = document.getElementById('tab-'+id);
  if(pane) pane.classList.add('active');
  // scroll to top for mobile comfort
  window.scrollTo({top:0, behavior:'smooth'});
}

function setupTabs(){
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      
      
      const id = btn.dataset.tab;
      setActiveTab(id);
      
      
    });
  });
}



// --------------------
// Chat
// --------------------
let chatMessages = []; // {role, content}

function addMsg(role, content){
  const log = $("#chatLog");
  const wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "user" : "bot");

  const bub = document.createElement("div");
  bub.className = "bubble";

  if(role === "user"){
    bub.textContent = content;
  }else{
    bub.textContent = content;
  }

  wrap.appendChild(bub);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return bub;
}

function addTyping(){
  const log = $("#chatLog");
  const wrap = document.createElement("div");
  wrap.className = "msg bot";
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.innerHTML = `<span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>`;
  wrap.appendChild(bub);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return {wrap, bub};
}

async function chatSend(){
  const input = $("#chatInput");
  const txt = (input.value || "").trim();
  if(!txt) return;

  const st = $("#chatStatus");
  setStatus(st, "Отправка…", "warn");

  input.value = "";

  chatMessages.push({role:"user", content: txt});
  addMsg("user", txt);

  const typing = addTyping();

  const provider = $("#aiProvider").value;
  const model = $("#aiModel").value;

  // optional context about analyzed account
  const ctx = accountData ? (
    `Контекст (факты аккаунта): ник=${accountData.username}, robux=${accountData.robux}, rap=${accountData.rap_tag}, донат=${accountData.donate_tag}, год=${accountData.year_tag}.`
  ) : "";

  try{
    // Stream endpoint
    const res = await fetch("/api/chat_stream", {
      method:"POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        provider, model,
        system: ctx,
        messages: chatMessages
      })
    });
    if(!res.ok){
      const j = await res.json().catch(()=>({}));
      throw new Error(j.detail || ("HTTP " + res.status));
    }

    // Replace typing bubble with live text
    const bub = typing.bub;
    bub.textContent = "";
    let full = "";

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while(true){
      const {value, done} = await reader.read();
      if(done) break;
      buf += decoder.decode(value, {stream:true});

      let parsed;
      while(true){
        const {value, done} = await reader.read();
        if(done) break;
        buf += decoder.decode(value, {stream:true});
        parsed = parseSSE(buf);
        buf = parsed.rest;

        for(const ev of parsed.events){
          if(ev.event === "error"){
            try{
              const obj = JSON.parse(ev.data);
              throw new Error(obj.error || "stream error");
            }catch(_e){
              throw new Error("stream error");
            }
          }
          if(ev.event === "done"){
            // ignore
            continue;
          }
          // default message
          try{
            const obj = JSON.parse(ev.data);
            if(obj.delta){
              full += obj.delta;
              bub.textContent = full;
              $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
            }
          }catch(_e){
            // if server sends plain text chunks
            full += ev.data;
            bub.textContent = full;
          }
        }
      }

    chatMessages.push({role:"assistant", content: full});
    setStatus(st, "Готово ✅", "ok");
  }catch(e){
    // remove typing bubble
    typing.wrap.remove();
    setStatus(st, "Ошибка: " + e.message, "bad");
  }
}

function setupChat(){
  $("#btnChatSend").addEventListener("click", chatSend);
  $("#btnChatClear").addEventListener("click", ()=>{
    chatMessages = [];
    $("#chatLog").innerHTML = "";
    setStatus($("#chatStatus"), "Очищено", "");
  });

  // Ctrl+Enter to send
  $("#chatInput").addEventListener("keydown", (ev)=>{
    if(ev.ctrlKey && ev.key === "Enter"){
      ev.preventDefault();
      chatSend();
    }
  });
}


// --------------------
// Particles (background)
// --------------------
function initParticles(){
  const canvas = document.getElementById("particles");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  let w=0,h=0, dpr=1;
  const particles = [];
  const N = 80;

  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(window.innerWidth * dpr);
    h = canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
  }

  function rnd(a,b){return a + Math.random()*(b-a)}
  function make(){
    return {
      x: rnd(0,w),
      y: rnd(0,h),
      r: rnd(1.2, 3.2)*dpr,
      vx: rnd(-0.18, 0.18)*dpr,
      vy: rnd(-0.12, 0.12)*dpr,
      a: rnd(0.10, 0.55)
    }
  }

  function step(){
    ctx.clearRect(0,0,w,h);
    // soft glow dots + lines
    for(let i=0;i<particles.length;i++){
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if(p.x<0) p.x=w;
      if(p.x>w) p.x=0;
      if(p.y<0) p.y=h;
      if(p.y>h) p.y=0;

      ctx.beginPath();
      ctx.globalAlpha = p.a;
      ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle = "rgba(180,190,255,1)";
      ctx.fill();
    }
    // lines
    for(let i=0;i<particles.length;i++){
      for(let j=i+1;j<particles.length;j++){
        const a = particles[i], b = particles[j];
        const dx=a.x-b.x, dy=a.y-b.y;
        const dist = Math.sqrt(dx*dx+dy*dy);
        const max = 170*dpr;
        if(dist<max){
          ctx.globalAlpha = 0.08*(1 - dist/max);
          ctx.strokeStyle = "rgba(34,211,238,1)";
          ctx.lineWidth = 1*dpr;
          ctx.beginPath();
          ctx.moveTo(a.x,a.y);
          ctx.lineTo(b.x,b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
        // vignette
    const grd = ctx.createRadialGradient(w*0.5,h*0.45, Math.min(w,h)*0.15, w*0.5,h*0.5, Math.min(w,h)*0.65);
    grd.addColorStop(0,'rgba(0,0,0,0)');
    grd.addColorStop(1,'rgba(0,0,0,0.35)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grd;
    ctx.fillRect(0,0,w,h);

    requestAnimationFrame(step);
  }

  resize();
  window.addEventListener("resize", resize);
  particles.length = 0;
  for(let i=0;i<N;i++) particles.push(make());
      // vignette
    const grd = ctx.createRadialGradient(w*0.5,h*0.45, Math.min(w,h)*0.15, w*0.5,h*0.5, Math.min(w,h)*0.65);
    grd.addColorStop(0,'rgba(0,0,0,0)');
    grd.addColorStop(1,'rgba(0,0,0,0.35)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grd;
    ctx.fillRect(0,0,w,h);

    requestAnimationFrame(step);
}

window.addEventListener("load", async ()=>{
  setupTabs();
  setActiveTab('gen');
  setupChat();
  initParticles();
  loadTpl();
  // Restore cookie (stored only in your browser)
  const savedCookie = localStorage.getItem("rbst_cookie") || "";
  if(savedCookie && $("#cookie")) { $("#cookie").value = savedCookie; cookieSaved = true; }

  await loadPollinationsModels();

  
let debCookie = null;
const cookieEl = $("#cookie");
if(cookieEl){
  cookieEl.addEventListener("input", ()=>{
    if(debCookie) clearTimeout(debCookie);
    debCookie = setTimeout(()=>{
      localStorage.setItem("rbst_cookie", cookieEl.value || "");
      cookieSaved = true;
    }, 250);
  });
}


  // Analyze
  $("#btnAnalyze").addEventListener("click", async ()=>{
    const status = $("#status");
    setStatus(status, "Подключение…", "warn");
    $("#btnAnalyze").disabled = true;
    try{
      const cookie = $("#cookie").value;
      const j = await api("/api/analyze", {cookie});
      accountData = j.data;
      fillFacts(accountData);
      await renderPreview();
      setStatus(status, "Готово ✅", "ok");
    }catch(e){
      setStatus(status, "Ошибка: " + e.message, "bad");
    }finally{
      $("#btnAnalyze").disabled = false;
    }
  });

  // Save/Reset
  $("#btnSaveTpl").addEventListener("click", async ()=>{
    saveTpl();
    await renderPreview();
  });
  $("#btnResetTpl").addEventListener("click", async ()=>{
    localStorage.removeItem("tplHead");
    localStorage.removeItem("tplBody");
    loadTpl();
  // Restore cookie (stored only in your browser)
  const savedCookie = localStorage.getItem("rbst_cookie") || "";
  if(savedCookie && $("#cookie")) { $("#cookie").value = savedCookie; cookieSaved = true; }

    await renderPreview();
  });

  // Live preview
  $("#tplHead").addEventListener("input", ()=>{saveTpl(); if(accountData) renderPreview();});
  $("#tplBody").addEventListener("input", ()=>{saveTpl(); if(accountData) renderPreview();});

  // Copy
  $("#btnCopyHead").addEventListener("click", ()=> copyText($("#outHead").value));
  $("#btnCopyBody").addEventListener("click", ()=> copyText($("#outBody").value));
  $("#btnCopyAll").addEventListener("click", ()=> copyText($("#outHead").value + "\n\n" + $("#outBody").value));

  // Translate
  $("#btnTranslate").addEventListener("click", async ()=>{
    const enStatus = $("#enStatus");
    setStatus(enStatus, "EN: перевод…", "warn");
    try{
      const provider = $("#aiProvider").value;
      const model = $("#aiModel").value;
      const head = $("#outHead").value;
      const body = $("#outBody").value;
      const j = await api("/api/translate", {provider, model, head, body});
      $("#outHeadEn").value = j.head || "";
      $("#outBodyEn").value = j.body || "";
      $("#enBox").classList.remove("hidden");
      setStatus(enStatus, "EN: ✅ готов", "ok");
    }catch(e){
      setStatus(enStatus, "EN: ❌ " + e.message, "bad");
    }
  });

  // AI Generate
  $("#btnAIGen").addEventListener("click", async ()=>{
    const aiStatus = $("#aiStatus");
    setStatus(aiStatus, "Генерация…", "warn");
    $("#btnAIGen").disabled = true;
    try{
      if(!accountData) throw new Error("Сначала анализируй аккаунт");
      const provider = $("#aiProvider").value;
      const model = $("#aiModel").value;
      const mode = $("#aiMode").value;
      const tone = $("#aiTone").value;
      const extra = $("#aiExtra").value;

      const j = await api("/api/ai_generate", {provider, model, mode, tone, extra, data: accountData});
      $("#aiRaw").textContent = j.raw || "";
      $("#tplHead").value = j.head || $("#tplHead").value;
      $("#tplBody").value = j.body || $("#tplBody").value;
      saveTpl();
      await renderPreview();
      setStatus(aiStatus, "Готово ✅", "ok");
    }catch(e){
      setStatus(aiStatus, "Ошибка: " + e.message, "bad");
    }finally{
      $("#btnAIGen").disabled = false;
    }
  });

  // Provider changes: model list
  $("#aiProvider").addEventListener("change", async ()=>{
    const p = $("#aiProvider").value;
    const sel = $("#aiModel");
    sel.innerHTML = "";
    if(p === "pollinations"){
      await loadPollinationsModels();

  
let debCookie = null;
const cookieEl = $("#cookie");
if(cookieEl){
  cookieEl.addEventListener("input", ()=>{
    if(debCookie) clearTimeout(debCookie);
    debCookie = setTimeout(()=>{
      localStorage.setItem("rbst_cookie", cookieEl.value || "");
      cookieSaved = true;
    }, 250);
  });
}

    }else{
      // groq - show common models (you can extend)
      ["llama-3.3-70b-versatile","llama-3.1-70b-versatile","gemma2-9b-it","mixtral-8x7b-32768"].forEach(m=>{
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        sel.appendChild(opt);
      });
      sel.value = "llama-3.3-70b-versatile";
    }
  });
});
