const $ = (sel) => document.querySelector(sel);

let accountData = null;

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

function setupTabs(){
  document.querySelectorAll(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const id = btn.dataset.tab;
      document.querySelectorAll(".tabpane").forEach(p=>p.classList.remove("active"));
      $("#tab-"+id).classList.add("active");
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

      // parse SSE frames separated by double newline
      let idx;
      while((idx = buf.indexOf("\n\n")) !== -1){
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx+2);

        if(frame.startsWith("event: error")){
          // next lines contain data
          continue;
        }

        const dataLine = frame.split("\n").find(l=>l.startsWith("data: "));
        if(!dataLine) continue;
        const data = dataLine.slice(6);
        try{
          const obj = JSON.parse(data);
          if(obj.delta){
            full += obj.delta;
            bub.textContent = full;
            $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
          }
        }catch(_e){
          // ignore
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

window.addEventListener("load", async ()=>{
  setupTabs();
  setupChat();
  loadTpl();
  await loadPollinationsModels();

  // Analyze
  $("#btnAnalyze").addEventListener("click", async ()=>{
    const status = $("#status");
    setStatus(status, "Подключение…", "warn");
    $("#btnAnalyze").disabled = true;
    try{
      const cookie = $("#cookie").value.trim();
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
