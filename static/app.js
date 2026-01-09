const $ = (sel) => document.querySelector(sel);

let accountData = null;

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

function saveTpl(){
  localStorage.setItem("rst_title_tpl", $("#tplTitle")?.value || "");
  localStorage.setItem("rst_desc_tpl", $("#tplDesc")?.value || "");
}

function loadTpl(){
  if($("#tplTitle")) $("#tplTitle").value = localStorage.getItem("rst_title_tpl") || DEFAULT_TITLE;
  if($("#tplDesc")) $("#tplDesc").value = localStorage.getItem("rst_desc_tpl") || DEFAULT_DESC;
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
    $("#btnAnalyze").disabled = true;
    try{
      const cookie = ($("#cookie").value || ""); // do NOT trim
      const j = await apiPost("/api/analyze", {cookie});
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
  });

  // Copy
  $("#btnCopyTitle")?.addEventListener("click", ()=> copyText($("#outTitle").value));
  $("#btnCopyDesc")?.addEventListener("click", ()=> copyText($("#outDesc").value));
  $("#btnCopyAll")?.addEventListener("click", ()=> copyText($("#outTitle").value + "\n\n" + $("#outDesc").value));

  // AI: models
  await loadPollinationsModels();
  $("#aiProvider")?.addEventListener("change", async ()=>{
    const p = $("#aiProvider").value;
    if(p === "groq") setGroqModels(); else await loadPollinationsModels();
  });

  // AI generate
  $("#btnAIGen")?.addEventListener("click", async ()=>{
    const st = $("#aiStatus");
    setStatus(st, "Генерация…", "warn");
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
      // jump to main
      setActiveTab("main");
    }catch(e){
      setStatus(st, "Ошибка: " + e.message, "bad");
    }finally{
      $("#btnAIGen").disabled = false;
    }
  });
});
