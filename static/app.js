/*__GLOBAL_CASE_MODAL_V9__*/
/* BUILD: fix51 - improved username validation and logging */
(function(){
  // guaranteed global function for shop case buttons
  window.openCaseModal = function(mode){
    try{
      var m = document.getElementById('caseOpenModal');
      if(!m) return;
      m.style.display = 'flex';
      m.classList.remove('hidden');

      var free = document.getElementById('caseFreeBlock');
      var paid = document.getElementById('casePaidBlock');
      var badge = document.getElementById('caseModeBadge');

      if(badge) badge.textContent = (mode==='paid'?'PAID':'FREE');

      if(mode==='paid'){
        if(paid) paid.style.display='flex';
        if(free) free.style.display='none';
      } else {
        if(free) free.style.display='flex';
        if(paid) paid.style.display='none';
      }

      var res = document.getElementById('caseResult');
      if(res) res.textContent = '—';
    } catch(e){ console.warn('openCaseModal failed', e); }
  };
})();

function closeAllSelects(except=null){
  document.querySelectorAll(".cselect.open").forEach(w=>{
    if(except && w === except) return;
    w.classList.remove("open");
  });
}

// -------------------------
// Theme + particles (UI)
// -------------------------
function applyTheme(name){
  const t = (name === "night2") ? "night2" : "night";
  writeLS("theme", t);
  document.body.setAttribute("data-theme", t);
  document.body.classList.remove("theme-night","theme-night2");
  document.body.classList.add(t === "night2" ? "theme-night2" : "theme-night");
}
window.applyTheme = applyTheme;

function applyCursor(name){
  const v = (name === "neon-purple") ? "neon-purple" : "default";
  writeLS("cursor", v);
  document.body.setAttribute("data-cursor", v);
}
window.applyCursor = applyCursor;

function initParticles(forceRestart=false){
  const cv = document.getElementById("particles");
  if(!cv) return;

  if(cv.__fxRunning && !forceRestart) return;
  cv.__fxRunning = true;

  const ctx = cv.getContext("2d", { alpha: true });
  let w=0,h=0;
  const isMobile = window.matchMedia("(max-width: 980px)").matches;

  const theme = document.body.getAttribute("data-theme") || readLS("theme","night");
  const isSnow = (theme === "night");
  const isConst = (theme === "night2");

  // Night (v1): снег
  // Night v2: "старые" частицы с линиями (constellation)
  const cfg = isSnow ? {
    count: isMobile ? 40 : 90,
    // Snow: intentionally slower and smoother
    speed: isMobile ? 0.12 : 0.18,
    drift: isMobile ? 0.06 : 0.10,
    maxR:  isMobile ? 2.0 : 2.8,
    linkDist: 0,
  } : {
    count: isMobile ? 38 : 72,
    speed: isMobile ? 0.05 : 0.08,
    drift: isMobile ? 0.14 : 0.20,
    maxR:  isMobile ? 2.2 : 3.2,
    linkDist: isMobile ? 88 : 124,
  };

  let parts = [];
  let mouse = {x:0.5,y:0.5}, mouseT={x:0.5,y:0.5};

  function resize(){
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Use viewport size directly. Some mobile layouts can report tiny clientWidth
    // for the fixed canvas during initial render, which makes effects appear
    // bunched in the top-left corner.
    w = Math.max(1, window.innerWidth);
    h = Math.max(1, window.innerHeight);
    cv.width  = Math.floor(w*dpr);
    cv.height = Math.floor(h*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function rand(a,b){ return a + Math.random()*(b-a); }

  function seed(){
    parts = [];
    for(let i=0;i<cfg.count;i++){
      parts.push({
        x: rand(0,w), y: rand(0,h),
        vx: isSnow ? rand(-cfg.drift, cfg.drift) : rand(-cfg.speed, cfg.speed),
        vy: isSnow ? rand(cfg.speed*0.45, cfg.speed*0.90) : rand(cfg.speed*0.25, cfg.speed*0.95),
        r:  rand(0.9, cfg.maxR),
        a:  rand(0.16, 0.52),
        t:  rand(0, Math.PI*2),
        ts: rand(0.004, 0.012),
      });
    }
  }

  resize(); seed();
  window.addEventListener("resize", ()=>{ resize(); seed(); }, { passive:true });
  window.addEventListener("mousemove", (e)=>{ mouseT.x = e.clientX/Math.max(1,w); mouseT.y = e.clientY/Math.max(1,h); }, { passive:true });

  let last = performance.now();
  function frame(now){
    const dt = Math.min(34, now-last); last = now;

    mouse.x += (mouseT.x - mouse.x)*0.08;
    mouse.y += (mouseT.y - mouse.y)*0.08;
    const ox = (mouse.x-0.5) * (isMobile ? 8 : 18);
    const oy = (mouse.y-0.5) * (isMobile ? 6 : 14);

    ctx.clearRect(0,0,w,h);

	    // Constellation links (Night v2)
	    if(isConst && cfg.linkDist > 0){
	      const md = cfg.linkDist;
	      const md2 = md*md;
	      for(let i=0;i<parts.length;i++){
	        const a = parts[i];
	        for(let j=i+1;j<parts.length;j++){
	          const b = parts[j];
	          const dx = a.x - b.x;
	          const dy = a.y - b.y;
	          const d2 = dx*dx + dy*dy;
	          if(d2 > md2) continue;
	          const t = 1 - (d2/md2);
	          const alpha = Math.max(0, Math.min(0.22, 0.22*t));
	          ctx.beginPath();
	          ctx.moveTo(a.x+ox, a.y+oy);
	          ctx.lineTo(b.x+ox, b.y+oy);
	          ctx.strokeStyle = `rgba(120,160,255,${alpha})`;
	          ctx.lineWidth = 1;
	          ctx.stroke();
	        }
	      }
	    }

    for(const p of parts){
      p.t += p.ts*dt;
      p.x += (p.vx + Math.sin(p.t)*cfg.drift*0.02) * dt;
      p.y += (p.vy + Math.cos(p.t*0.9)*cfg.drift*0.02) * dt;

      if(p.y > h+12){ p.y = -12; p.x = rand(0,w); }
      if(p.x < -20) p.x = w+20;
      if(p.x > w+20) p.x = -20;

      const tw = Math.sin(p.t)*0.12 + 0.88;
      const rr = p.r*tw;
      const aa = p.a*tw;

      ctx.beginPath();
      ctx.arc(p.x+ox, p.y+oy, rr, 0, Math.PI*2);
      if(isSnow){
        ctx.shadowColor = 'rgba(240,245,255,.35)';
        ctx.shadowBlur = 10;
        ctx.fillStyle = `rgba(245,248,255,${Math.min(0.75, aa+0.10)})`;
      }else{
        ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(210,220,255,${aa})`;
      }
      ctx.fill();
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function isPremiumActive(){
  try{
    if(!currentUser) return false;
    const u = currentUser.premium_until;
    if(!u) return false;
    const t = new Date(u).getTime();
    return !isNaN(t) && t > Date.now();
  }catch(_e){ return false; }
}
function isWastePrizeWhilePremium(prize){
  if(!prize) return false;
  const p = String(prize).toUpperCase();
  if(p.startsWith("P")) return true;      // any Premium prize
  if(p === "AI3") return true;            // +AI generations
  if(p === "GEN10") return true;          // +Generations
  if(p === "REQ10" || p === "Q10") return true; // safety if you rename
  return false;
}

// Prize metadata (label + image) for inventory UI.
// Keep this mapping small and deterministic; unknown prizes fall back to raw code.
function _prizeMeta(prize){
  const p = String(prize || '').toUpperCase();

  // Premium prizes
  if(p === 'P6')  return { label: 'Premium 6ч',  img: '/static/prizes/premium_6h.png' };
  if(p === 'P12') return { label: 'Premium 12ч', img: '/static/prizes/premium_12h.png' };
  if(p === 'P24') return { label: 'Premium 24ч', img: '/static/prizes/premium_24h.png' };
  if(p === 'P2D') return { label: 'Premium 2д',  img: '/static/prizes/premium_2d.png' };
  if(p === 'P3D') return { label: 'Premium 3д',  img: '/static/prizes/premium_3d.png' };

  // Limits / bonuses
  if(p === 'AI3')   return { label: '+3 генерации', img: '' };
  if(p === 'GEN10') return { label: '+10 анализов', img: '' };
  if(p === 'REQ10' || p === 'Q10') return { label: '+10 запросов', img: '' };
  if(p === 'BAL50') return { label: '+50 ₽', img: '' };
  if(p === 'BAL100') return { label: '+100 ₽', img: '' };


  // If DB stores human labels (legacy), normalize by substring
  if(p.includes("АНАЛИЗ")) return { label: '+10 анализов', img: '' };
  if(p.includes("ГЕНЕРАЦ")) return { label: '+3 генерации', img: '' };
  if(p.includes("ЗАПРОС")) return { label: '+10 запросов', img: '' };
  if(p.includes("₽") || p.includes("RUB") || p.includes("BAL")) {
    // keep as-is
    return { label: prize, img: '' };
  }
  // Fallback: try to show prize icon if it exists by convention
  return { label: prize, img: '' };
}

function renderInv(inv){
  const list = $("#invModalList") || $("#invList");
  if(!list) return;
  const max = Number(inv.max || 10);
  const cnt = Number(inv.count || 0);
  const badge = $("#invCount") || $("#invBadge");
  const badge2 = $("#invModalCount");
  if(badge) badge.textContent = `${cnt}/${max}`;
  if(badge2) badge2.textContent = `${cnt}/${max}`;

  const premiumOn = isPremiumActive();
  const items = (inv.items || []);
  if(!items.length){
    list.innerHTML = `<div class="muted" style="padding:10px 2px;opacity:.75">Инвентарь пуст.</div>`;
    return;
  }

  list.innerHTML = items.map(it=>{
    const m = _prizeMeta(it.prize);
    const title = escapeHtml(m.label || it.prize);
    const dt = it.created_at ? escapeHtml(String(it.created_at).replace("T"," ").slice(0,19)) : "";
    const img = m.img ? `<img src="${m.img}" alt="">` : `<div class="ico" data-ico="gift"></div>`;
    const disabled = premiumOn && isWastePrizeWhilePremium(it.prize);
    const hint = disabled ? ` title="Premium активен — этот приз тратить не нужно"` : "";
    return `
      <div class="invItem">
        <div class="invIconWrap">${img}</div>
        <div class="invInfo">
          <div class="invTitle">${title}</div>
          <div class="invMeta">Получено: ${dt}</div>
        </div>
        <div class="invActions">
          <button class="btn invBtn" data-use-inv="${it.id}" ${disabled?'disabled':''}${hint}>Использовать</button>
          <button class="invBtnDanger" data-del-inv="${it.id}" title="Удалить">✕</button>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll("[data-use-inv]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = Number(btn.getAttribute("data-use-inv")||0);
      if(!id || btn.disabled) return;
      try{
        await apiPost("/api/inventory/use", {id});
        toast("Инвентарь", "Приз применён", "ok");
        await refreshMe();
      }catch(e){
        toast("Инвентарь", e.message || "Ошибка", "bad");
        await window.invPull().catch(()=>{});
      }
    });
  });

  list.querySelectorAll("[data-del-inv]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = Number(btn.getAttribute("data-del-inv")||0);
      if(!id) return;
      const ok = await confirmAction("Удалить этот приз из инвентаря? Это действие нельзя отменить.", "Удалить");
      if(!ok) return;
      try{
        await apiPost("/api/inventory/delete", {id});
        toast("Инвентарь", "Удалено", "ok");
        await window.invPull().catch(()=>{});
        await refreshMe().catch(()=>{});
      }catch(e){
        toast("Инвентарь", e.message || "Ошибка", "bad");
      }
    });
  });
}

async function invPull(){
  try{
    const j = await apiGet("/api/inventory/list");
    if(j && j.ok) renderInv(j);
    return j;
  }catch(e){
    // Render empty state so the modal isn't blank
    renderInv({max:10, count:0, items:[]});
    toast("Инвентарь", e?.message || "Не удалось загрузить", "bad");
    return null;
  }
}
window.invPull = invPull;

// ===== Inventory Modal (open from profile card) =====
function openInvModal(){
  const back = document.getElementById("invBack");
  const modal = document.getElementById("invModal");
  if(!back || !modal) return;
  back.classList.remove("hidden");
  modal.classList.remove("hidden");
  modal.classList.add("open");
  requestAnimationFrame(()=>modal.classList.add("vis"));
  // Pull latest when opened
  window.invPull && window.invPull().catch(()=>{});
}
function closeInvModal(){
  const back = document.getElementById("invBack");
  const modal = document.getElementById("invModal");
  if(!back || !modal) return;
  modal.classList.remove("vis");
  modal.classList.remove("open");
  back.classList.add("hidden");
  modal.classList.add("hidden");
}
window.openInvModal = openInvModal;
window.closeInvModal = closeInvModal;

// ===== Notifications Modal =====
let notifCache = { items: [], unread: 0 };

function openNotifModal(){
  const back = document.getElementById("notifBack");
  const modal = document.getElementById("notifModal");
  if(!back || !modal) return;
  back.classList.remove("hidden");
  modal.classList.remove("hidden");
  modal.classList.add("open");
  requestAnimationFrame(()=>modal.classList.add("vis"));
  notifPull().catch(()=>{});
}
function closeNotifModal(){
  const back = document.getElementById("notifBack");
  const modal = document.getElementById("notifModal");
  if(!back || !modal) return;
  modal.classList.remove("vis");
  modal.classList.remove("open");
  back.classList.add("hidden");
  modal.classList.add("hidden");
}
window.openNotifModal = openNotifModal;
window.closeNotifModal = closeNotifModal;

function renderNotifications(){
  const list = document.getElementById("notifList");
  const badge = document.getElementById("notifBadge");
  const cnt = document.getElementById("notifCount");
  if(cnt) cnt.textContent = String(notifCache.unread || 0);
  if(badge){
    const n = Number(notifCache.unread || 0);
    badge.textContent = (n > 99 ? "99+" : String(n));
    badge.classList.toggle("hidden", n <= 0);
  }
  if(!list) return;
  const items = notifCache.items || [];
  if(items.length === 0){
    list.innerHTML = `<div class="muted">Нет уведомлений</div>`;
    return;
  }
  list.innerHTML = items.map(it=>{
    const when = it.created_at ? new Date(it.created_at).toLocaleString() : "";
    const isRead = Number(it.is_read || 0) === 1;
    return `<div class="invItem ${isRead ? "" : "unread"}" data-id="${it.id}" style="align-items:flex-start">
      <div style="flex:1; min-width:0">
        <div style="font-weight:750; line-height:1.25">${escapeHtml(it.text || "")}</div>
        <div class="muted" style="font-size:12px; margin-top:4px">${when}</div>
      </div>
      ${isRead ? "" : `<span class="badge" style="margin-left:10px">new</span>`}
    </div>`;
  }).join("");
}

async function notifPull(){
  if(!currentUser) return;
  const j = await apiGet("/api/user/notifications?limit=50").catch(()=>null);
  if(j && j.ok){
    notifCache.items = j.items || [];
    notifCache.unread = j.unread || 0;
    renderNotifications();
  }
}

async function notifReadAll(){
  if(!currentUser) return;
  await apiPost("/api/user/notifications/read", {all:true});
  await notifPull();
}

document.addEventListener("DOMContentLoaded", ()=>{
  const b = document.getElementById("btnInvRefresh");
  if(b) b.addEventListener("click", ()=>window.invPull().catch(()=>{}));

  // Inventory modal open/close
  const invOpen = document.getElementById("btnInvOpen") || document.getElementById("invCard") || document.getElementById("invBox");
  if(invOpen) invOpen.addEventListener("click", (e)=>{
    // avoid opening when clicking inner buttons that have their own action
    const t = e.target;
    if(t && (t.closest && t.closest("button")) && (t.closest("#btnInvOpen")===null) && (t.closest("#invBox")===null) && (t.closest("#invCard")===null)){
      return;
    }
    openInvModal();
  });

  const invClose = document.getElementById("btnInvClose");
  const invBack = document.getElementById("invBack");
  if(invClose) invClose.addEventListener("click", closeInvModal);
  if(invBack) invBack.addEventListener("click", (e)=>{ if(e.target===invBack) closeInvModal(); });
  document.addEventListener("keydown", (e)=>{ if(e.key==="Escape"){ closeInvModal(); closeNotifModal(); closeAdminModal(); closeSettingsModal(); closeShopPanelModal(); } });



  // Notifications modal
  const nOpen = document.getElementById("btnNotifOpen");
  const nClose = document.getElementById("btnNotifClose");
  const nBack = document.getElementById("notifBack");
  const nRefresh = document.getElementById("btnNotifRefresh");
  const nReadAll = document.getElementById("btnNotifReadAll");
  if(nOpen) nOpen.addEventListener("click", ()=>openNotifModal());
  if(nClose) nClose.addEventListener("click", ()=>closeNotifModal());
  if(nBack) nBack.addEventListener("click", (e)=>{ if(e.target===nBack) closeNotifModal(); });
  if(nRefresh) nRefresh.addEventListener("click", ()=>notifPull().catch(()=>{}));
  if(nReadAll) nReadAll.addEventListener("click", ()=>notifReadAll().catch(()=>{}));

  // Admin modal
  const aOpen = document.getElementById("btnAdminOpen") || document.getElementById("adminCard");
  const aClose = document.getElementById("btnAdminClose");
  const aBack = document.getElementById("adminBack");
  if(aOpen) aOpen.addEventListener("click", ()=>{
    openAdminModal();
    adminUsersRefresh("").catch(()=>{});
    adminTopupsRefresh().catch(()=>{});
    adminPromosRefresh().catch(()=>{});
  });
  if(aClose) aClose.addEventListener("click", ()=>closeAdminModal());
  if(aBack) aBack.addEventListener("click", (e)=>{ if(e.target===aBack) closeAdminModal(); });

  // Settings modal
  const sOpen = document.getElementById("btnSettings");
  const sClose = document.getElementById("btnSettingsClose");
  const sModal = document.getElementById("settingsModal");
  if(sOpen) sOpen.addEventListener("click", ()=>openSettingsModal());
  if(sClose) sClose.addEventListener("click", ()=>closeSettingsModal());
  if(sModal) sModal.addEventListener("click", (e)=>{ if(e.target===sModal) closeSettingsModal(); });
  
  // Settings tabs
  document.querySelectorAll("#settingsModal .modalTabs .pill").forEach((b)=>{
    b.addEventListener("click", ()=>{
      document.querySelectorAll("#settingsModal .modalTabs .pill").forEach(x=>x.classList.toggle("active", x===b));
      const which = b.dataset.stab;
      const pa = document.getElementById("settingsPaneAppearance");
      const ps = document.getElementById("settingsPaneSecurity");
      if(pa) pa.style.display = (which==="appearance"?"block":"none");
      if(ps) ps.style.display = (which==="security"?"block":"none");
    });
  });

  // 2FA controls
  const tEn = document.getElementById("btnTwofaEnable");
  const tDis = document.getElementById("btnTwofaDisable");
  if(tEn) tEn.addEventListener("click", ()=>twofaEnableFlow().catch(()=>{}));
  if(tDis) tDis.addEventListener("click", ()=>twofaDisable().catch(()=>{}));

  
  // Security: change password / email
  const btnPwSave = document.getElementById("btnSecPwSave");
  const btnEmailSend = document.getElementById("btnSecEmailSend");
  const btnEmailConfirm = document.getElementById("btnSecEmailConfirm");

  if(btnPwSave) btnPwSave.addEventListener("click", async ()=>{
    const cur = (document.getElementById("secCurPw")?.value||"").trim();
    const n1 = (document.getElementById("secNewPw")?.value||"").trim();
    const n2 = (document.getElementById("secNewPw2")?.value||"").trim();
    if(!cur || !n1 || !n2) return toast("Заполни поля", "Нужны текущий и новый пароль", "bad");
    try{
      const j = await apiPost('/api/security/password', {current:cur, new:n1, new2:n2});
      if(j.ok){
        toast("Готово", "Пароль обновлён", "ok");
        document.getElementById("secCurPw").value="";
        document.getElementById("secNewPw").value="";
        document.getElementById("secNewPw2").value="";
      }else{
        toast("Ошибка", j.detail||"Не удалось", "bad");
      }
    }catch(e){
      toast("Ошибка", "Не удалось обновить пароль", "bad");
    }
  });

  if(btnEmailSend) btnEmailSend.addEventListener("click", async ()=>{
    const pw = (document.getElementById("secEmailPw")?.value||"").trim();
    const em = (document.getElementById("secNewEmail")?.value||"").trim();
    if(!pw || !em) return toast("Заполни поля", "Нужен пароль и новая почта", "bad");
    try{
      const j = await apiPost('/api/security/email_start', {password: pw, new_email: em});
      if(j.ok){
        toast("Код отправлен", "Проверь новую почту", "ok");
      }else{
        toast("Ошибка", j.detail||"Не удалось", "bad");
      }
    }catch(e){
      toast("Ошибка", "Не удалось отправить код", "bad");
    }
  });

  if(btnEmailConfirm) btnEmailConfirm.addEventListener("click", async ()=>{
    const em = (document.getElementById("secNewEmail")?.value||"").trim();
    const code = (document.getElementById("secEmailCode")?.value||"").trim();
    if(!em || !code) return toast("Заполни поля", "Нужны почта и код", "bad");
    try{
      const j = await apiPost('/api/security/email_confirm', {new_email: em, code});
      if(j.ok){
        toast("Готово", "Почта обновлена", "ok");
        await refreshMe();
      }else{
        toast("Ошибка", j.detail||"Не удалось", "bad");
      }
    }catch(e){
      toast("Ошибка", "Не удалось подтвердить почту", "bad");
    }
  });

// Admin shop panel
  const spOpen = document.getElementById("btnShopPanel");
  const spClose = document.getElementById("btnShopPanelClose");
  const spModal = document.getElementById("shopPanelModal");
  if(spOpen) spOpen.addEventListener("click", ()=>openShopPanelModal());
  const btnGoBuilder = document.getElementById("btnShopGoBuilder");
  const btnGoManage = document.getElementById("btnShopGoManage");
  if(btnGoBuilder) btnGoBuilder.addEventListener("click", ()=>{
    closeShopPanelModal();
    openShopConstructor({mode:"builder"});
  });
  if(btnGoManage) btnGoManage.addEventListener("click", ()=>{
    closeShopPanelModal();
    openShopConstructor({mode:"manage"});
  });

  if(spClose) spClose.addEventListener("click", ()=>closeShopPanelModal());
  if(spModal) spModal.addEventListener("click", (e)=>{ if(e.target===spModal) closeShopPanelModal(); });


  const btnFind = document.getElementById("btnAdminFind");
  const btnUsers = document.getElementById("btnAdminUsersRefresh");
  const btnApply = document.getElementById("btnAdminApply");
  const btnRename = document.getElementById("btnAdminRename");
  const btnBan = document.getElementById("btnAdminBan");
  const btnUnban = document.getElementById("btnAdminUnban");
  const btnNotify = document.getElementById("btnAdminNotify");
  const btnTop = document.getElementById("btnAdminTopupsRefresh");
  const btnPromo = document.getElementById("btnAdminPromosRefresh");
  const btnPromoCreate = document.getElementById("btnAdminPromoCreate");
  if(btnFind) btnFind.addEventListener("click", ()=>adminFind());
  if(btnUsers) btnUsers.addEventListener("click", ()=>adminUsersRefresh((document.getElementById("adminIdent")?.value||"").trim()));
  if(btnApply) btnApply.addEventListener("click", ()=>adminApply());
  if(btnRename) btnRename.addEventListener("click", ()=>adminRename());
  if(btnBan) btnBan.addEventListener("click", ()=>adminBan());
  if(btnUnban) btnUnban.addEventListener("click", ()=>adminUnban());
  if(btnNotify) btnNotify.addEventListener("click", ()=>adminNotify());
  if(btnTop) btnTop.addEventListener("click", ()=>adminTopupsRefresh());
  if(btnPromo) btnPromo.addEventListener("click", ()=>adminPromosRefresh());
  if(btnPromoCreate) btnPromoCreate.addEventListener("click", ()=>adminPromoCreate());

  // Debounced user list refresh while typing in ident field
  const identInp = document.getElementById("adminIdent");
  if(identInp){
    identInp.addEventListener("input", ()=>{
      clearTimeout(_adminUsersDeb);
      _adminUsersDeb = setTimeout(()=>adminUsersRefresh((identInp.value||"").trim()), 250);
    });
  }

  // prefs init
  const savedTheme = readLS("theme", "night");
  const theme = (savedTheme === "night2") ? "night2" : "night";
  applyTheme(theme);

  // Cursor
  const savedCursor = readLS("cursor", "neon-purple");
  const cur = (savedCursor === "neon-purple") ? "neon-purple" : "default";
  applyCursor(cur);

  // Number format
  const savedFmt = readLS("num_format", "comma");
  prefNumAbbr = (savedFmt === "abbr");

  const sel = document.getElementById("themeSelect");
  if(sel) sel.value = theme;

  const curSel = document.getElementById("cursorSelect");
  if(curSel) curSel.value = cur;

  const fmtSel = document.getElementById("numFormatSelect");
  if(fmtSel) fmtSel.value = (prefNumAbbr ? "abbr" : "comma");

  // Apply instantly (no apply button)
  if(sel){
    sel.addEventListener("change", async ()=>{
      applyTheme(sel.value);
      try{ await refreshMe(); }catch(_e){}
      toast("Тема", "Сохранено", "ok");
      // restart background FX for new theme
      try{ initParticles(true); }catch(_e){}
    });
  }
  if(curSel){
    curSel.addEventListener("change", ()=>{
      applyCursor(curSel.value);
      toast("Курсор", "Сохранено", "ok");
    });
  }
  if(fmtSel){
    fmtSel.addEventListener("change", async ()=>{
      prefNumAbbr = (fmtSel.value === "abbr");
      writeLS("num_format", prefNumAbbr ? "abbr" : "comma");
      try{ await refreshMe(); }catch(_e){}
      toast("Числа", "Сохранено", "ok");
    });
  }

  // particle / snow background
  initParticles();
  loadAndApplyShopConfig().catch(()=>{});

  // Initial auth state + UI (needed for guest layout)
  refreshMe().catch(()=>{});
});

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

// ---- UI preferences ----
let prefNumAbbr = false;

function readLS(key, fallback=null){
  try{ const v = localStorage.getItem(key); return (v===null||v===undefined) ? fallback : v; }catch(_e){ return fallback; }
}
function writeLS(key, val){
  try{ localStorage.setItem(key, val); }catch(_e){}
}

function formatMoney(val){
  const n = Math.round(Number(val || 0));
  if(prefNumAbbr){
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    const fmt = (x)=>{
      const s = x.toFixed(x < 10 ? 1 : 0);
      return s.replace(/\.0$/, "");
    };
    if(abs >= 1_000_000){
      return sign + fmt(abs/1_000_000) + "M";
    }
    if(abs >= 1_000){
      return sign + fmt(abs/1_000) + "K";
    }
    return sign + String(abs);
  }
  // grouped number with commas (1,700)
  try{ return new Intl.NumberFormat("en-US", {maximumFractionDigits:0}).format(n); }
  catch(_e){ return String(n); }
}


// ===== Confirm modal helper =====
let _confirmResolve = null;
function confirmAction(text, yesLabel="OK"){
  const back = document.getElementById("confirmBack");
  const modal = document.getElementById("confirmModal");
  const t = document.getElementById("confirmText");
  const yes = document.getElementById("btnConfirmYes");
  const no = document.getElementById("btnConfirmNo");
  const close = document.getElementById("btnConfirmClose");
  if(!back || !modal || !t || !yes || !no) return Promise.resolve(window.confirm(text));

  t.textContent = text || "Вы уверены?";
  yes.textContent = yesLabel || "OK";

  back.classList.remove("hidden");
  modal.classList.remove("hidden");
  // modal system uses .open/.vis for animations; add them so it's actually visible
  try{ modal.classList.add("open"); requestAnimationFrame(()=>modal.classList.add("vis")); }catch(_e){}

  const done = (v)=>{
    try{
      modal.classList.remove("vis");
      modal.classList.remove("open");
      back.classList.add("hidden");
      modal.classList.add("hidden");
    }catch(_e){}
    const r = _confirmResolve; _confirmResolve = null;
    if(r) r(!!v);
  };

  const onYes = ()=>{ cleanup(); done(true); };
  const onNo = ()=>{ cleanup(); done(false); };
  const onClose = ()=>{ cleanup(); done(false); };
  const onBack = (e)=>{ if(e.target===back){ cleanup(); done(false); } };

  function cleanup(){
    yes.removeEventListener("click", onYes);
    no.removeEventListener("click", onNo);
    if(close) close.removeEventListener("click", onClose);
    back.removeEventListener("click", onBack);
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(e){ if(e.key==="Escape"){ cleanup(); done(false);} }

  yes.addEventListener("click", onYes);
  no.addEventListener("click", onNo);
  if(close) close.addEventListener("click", onClose);
  back.addEventListener("click", onBack);
  document.addEventListener("keydown", onEsc);

  return new Promise(res=>{ _confirmResolve = res; });
}

const toastQ = [];
let toastBusy = false;

let toastLastAt = 0;
let toastNext = null;
let toastCooldownTimer = null;

// Deduplicate identical toasts that can happen when the same action
// triggers multiple handlers (e.g., mobile click/pointer quirks or legacy binds).
let toastLastSig = "";
let toastLastSigAt = 0;

function toastIcon(type){
  if(type === "bad") return "⛔";
  if(type === "warn") return "⚡";
  return "✅";
}

const TOAST_DELAY_MS = 400;

function toast(title, msg="", type="ok"){
  const now = Date.now();
  const sig = `${type}|${String(title)}|${String(msg)}`;

  // If the exact same toast is triggered twice in a short time window,
  // schedule it only once.
  if(sig === toastLastSig && (now - toastLastSigAt) < 1200){
    return;
  }
  toastLastSig = sig;
  toastLastSigAt = now;

  // Small delay to make UI feel smoother and to avoid "instant" spam.
  setTimeout(() => toastEnqueue(title, msg, type, sig), TOAST_DELAY_MS);
}

function toastEnqueue(title, msg="", type="ok", sig=null){
  const now = Date.now();
  const _sig = sig || `${type}|${String(title)}|${String(msg)}`;

  const COOLDOWN_MS = 800;
  if(now - toastLastAt < COOLDOWN_MS){
    // keep only the latest toast during cooldown
    toastNext = {title, msg, type, sig: _sig};
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
  toastQ.push({title, msg, type, sig: _sig});
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
// legacy alias used by some modules (shop builder, etc.)
let _me = null;

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
  // Pay modal is a full-screen backdrop that centers the card via flex.
  // Keep display as flex to respect the scoped CSS (#payModal.modal.open).
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
  _robuxState._swapT = setTimeout(()=>{ m.style.display = "none"; }, 180);
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
  // Touch devices: skip tilt to avoid broken taps + keep perf.
  // Allow hybrid devices (touch + mouse/trackpad) where (pointer: coarse) may still be true.
  if(window.matchMedia){
    const noHoverCoarse = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    const anyHover = window.matchMedia("(any-hover: hover)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    if(noHoverCoarse && !anyHover && !finePointer) return;
  }

  const els = $$(".tilt");
  els.forEach(el=>{
    // prevent double-binding (it caused flicker / "дёргание" after re-renders)
    if(el.dataset.tiltBound === "1") return;
    el.dataset.tiltBound = "1";

    if(el.matches(":disabled")) return;

    const isProduct = el.classList.contains("productCard") || el.closest(".productGrid");
    const maxY = isProduct ? 5.0 : 7.0;   // deg
    const maxX = isProduct ? 3.6 : 5.5;   // deg

    // Smooth animation (lerp) to avoid micro-jitter on high DPI / moving backgrounds
    let hover = false;
    let raf = 0;
    // dx/dy drive inner parallax (ekuve-like)
    let target = {rx:0, ry:0, mx:50, my:20, dx:0, dy:0};
    let cur    = {rx:0, ry:0, mx:50, my:20, dx:0, dy:0};

    const tick = ()=>{
      raf = 0;
      // lerp
      const k = 0.18;
      cur.rx += (target.rx - cur.rx) * k;
      cur.ry += (target.ry - cur.ry) * k;
      cur.mx += (target.mx - cur.mx) * k;
      cur.my += (target.my - cur.my) * k;
      cur.dx += (target.dx - cur.dx) * k;
      cur.dy += (target.dy - cur.dy) * k;

      el.style.setProperty("--rx", cur.rx.toFixed(2) + "deg");
      el.style.setProperty("--ry", cur.ry.toFixed(2) + "deg");
      el.style.setProperty("--mx", cur.mx.toFixed(2) + "%");
      el.style.setProperty("--my", cur.my.toFixed(2) + "%");
      el.style.setProperty("--dx", cur.dx.toFixed(2) + "px");
      el.style.setProperty("--dy", cur.dy.toFixed(2) + "px");

      if(hover){
        raf = requestAnimationFrame(tick);
      }
    };

    const schedule = ()=>{
      if(raf) return;
      raf = requestAnimationFrame(tick);
    };

    const setFromEvent = (e)=>{
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      target.mx = x*100;
      target.my = y*100;
      target.ry = (x - 0.5) * maxY;
      target.rx = -(y - 0.5) * maxX;
      // subtle inner parallax for product cards
      target.dx = (x - 0.5) * (isProduct ? 14 : 8);
      target.dy = (y - 0.5) * (isProduct ? 10 : 6);
      schedule();
    };

    el.addEventListener("mouseenter", (e)=>{
      hover = true;
      el.classList.remove("isLeaving");
      setFromEvent(e);
    });

    el.addEventListener("mousemove", (e)=>{
      if(!hover) return;
      setFromEvent(e);
    });

    el.addEventListener("mouseleave", ()=>{
      hover = false;
      el.classList.add("isLeaving");
      target = {rx:0, ry:0, mx:50, my:20, dx:0, dy:0};
      schedule();
      // after animation, drop leaving-state
      setTimeout(()=>el.classList.remove("isLeaving"), 260);
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
  const r = await fetch(path, { method: "GET", credentials: "include" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.detail || `HTTP ${r.status}`);
  return j;
}

async function apiPost(path, payload) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.detail || `HTTP ${r.status}`);
  return j;
}

// -------------------------
// Templates (v2: multiple templates + selected + AGE GROUP)
// -------------------------
let debTplSync = null;

let tplItems = [];
let tplSelectedId = null;
let tplLoadedFromServer = false;

function _ageGroupToInt(v){
  const n = parseInt(String(v ?? "").replace(/[^\d]/g,""), 10);
  return Number.isFinite(n) ? n : 13;
}
function _tplLocalLoad(){
  const t = localStorage.getItem("rst_title_tpl");
  const d = localStorage.getItem("rst_desc_tpl");
  const ag = localStorage.getItem("rst_age_group");
  if ($("#tplTitle")) $("#tplTitle").value = t || DEFAULT_TITLE;
  if ($("#tplDesc")) $("#tplDesc").value = d || DEFAULT_DESC;
  if ($("#tplAgeGroup")) $("#tplAgeGroup").value = String(_ageGroupToInt(ag || "13"));
}

function _tplLocalSave(){
  localStorage.setItem("rst_title_tpl", $("#tplTitle")?.value || "");
  localStorage.setItem("rst_desc_tpl", $("#tplDesc")?.value || "");
  localStorage.setItem("rst_age_group", String(_ageGroupToInt($("#tplAgeGroup")?.value || "13")));
}

function _tplFindById(id){
  return tplItems.find(x => String(x.id) === String(id));
}

function _tplUpdateDeleteBtn(){
  const btn = $("#btnTplDel");
  const sel = _tplFindById(tplSelectedId);
  if(!btn) return;
  const isDef = !!(sel && sel.is_default);
  btn.disabled = isDef || !sel;
  btn.title = isDef ? "Дефолтный шаблон удалить нельзя" : "";
}

function _tplRenderSelect(){
  const sel = $("#tplSelect");
  if(!sel) return;
  sel.innerHTML = "";
  for(const t of (tplItems || [])){
    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = t.is_default ? `${t.name} (default)` : t.name;
    sel.appendChild(opt);
  }
  if(tplSelectedId && _tplFindById(tplSelectedId)){
    sel.value = String(tplSelectedId);
  }else if(tplItems.length){
    tplSelectedId = tplItems[0].id;
    sel.value = String(tplSelectedId);
  }
  _tplUpdateDeleteBtn();
}

function _tplApplyCurrentToInputs(){
  const t = _tplFindById(tplSelectedId);
  if(!t) return;
  if ($("#tplTitle")) $("#tplTitle").value = t.title_tpl ?? "";
  if ($("#tplDesc")) $("#tplDesc").value = t.desc_tpl ?? "";
  if ($("#tplAgeGroup")) $("#tplAgeGroup").value = String(_ageGroupToInt(t.age_group));
  _tplLocalSave();
}

async function tplFetchAll(){
  if(!currentUser) {
    tplLoadedFromServer = false;
    _tplLocalLoad();
    return;
  }
  try{
    const j = await apiGet("/api/profile/templates");
    tplItems = j.items || [];
    tplSelectedId = j.selected_id || (tplItems[0]?.id ?? null);
    tplLoadedFromServer = true;
    _tplRenderSelect();
    _tplApplyCurrentToInputs();
  }catch(e){
    tplLoadedFromServer = false;
    _tplLocalLoad();
  }
}

async function tplSelect(id){
  tplSelectedId = id;
  _tplRenderSelect();
  _tplApplyCurrentToInputs();
  renderPreview().catch(()=>{});
  if(currentUser){
    try{ await apiPost("/api/profile/templates/select", { template_id: id }); }catch(_e){}
  }
}

async function tplCreate(){
  if(!currentUser){
    return toast("Шаблоны","Войди в аккаунт, чтобы создавать несколько шаблонов","warn");
  }
  const name = prompt("Название шаблона:");
  if(!name) return;
  try{
    const j = await apiPost("/api/profile/templates/create", { name });
    await tplFetchAll();
    if(j.id) await tplSelect(j.id);
    toast("Шаблоны","Создано","ok");
  }catch(e){
    toast("Шаблоны", e.message || "Не удалось создать", "bad");
  }
}

async function tplDelete(){
  const t = _tplFindById(tplSelectedId);
  if(!currentUser || !t) return;
  if(t.is_default){
    return toast("Шаблоны","Дефолтный шаблон удалить нельзя","warn");
  }
  if(!confirm(`Удалить шаблон «${t.name}»?`)) return;
  try{
    await apiPost("/api/profile/templates/delete", { template_id: t.id });
    await tplFetchAll();
    toast("Шаблоны","Удалено","ok");
  }catch(e){
    toast("Шаблоны", e.message || "Не удалось удалить", "bad");
  }
}

function saveTpl(){
  _tplLocalSave();

  if (!currentUser || !tplLoadedFromServer || !tplSelectedId) return;
  if (debTplSync) clearTimeout(debTplSync);
  debTplSync = setTimeout(async () => {
    try{
      await apiPost("/api/profile/templates/update", {
        template_id: tplSelectedId,
        title_tpl: $("#tplTitle")?.value || "",
        desc_tpl: $("#tplDesc")?.value || "",
        age_group: _ageGroupToInt($("#tplAgeGroup")?.value || "13"),
      });
    }catch(_e){}
  }, 650);
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
    data: Object.assign({}, accountData, { age_group: _ageGroupToInt($("#tplAgeGroup")?.value || "13") }),
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
  await tplFetchAll();
  await renderPreview().catch(()=>{});
  toast("Профиль", "Шаблоны загружены", "ok");
}

async function syncPush() {
  // принудительное сохранение текущего шаблона
  _tplLocalSave();
  if(!currentUser || !tplSelectedId) {
    toast("Профиль", "Сохранено локально", "ok");
    return;
  }
  try{
    await apiPost("/api/profile/templates/update", {
      template_id: tplSelectedId,
      title_tpl: $("#tplTitle")?.value || "",
      desc_tpl: $("#tplDesc")?.value || "",
      age_group: _ageGroupToInt($("#tplAgeGroup")?.value || "13"),
    });
    toast("Профиль", "Шаблон сохранён", "ok");
  }catch(e){
    toast("Профиль", e.message || "Не удалось сохранить", "bad");
  }
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


// (legacy particles init removed in Night v2)

// -------------------------
// Tabs
// -------------------------
function setTab(name) {
  const panes = $$(".pane");
  const next = document.getElementById("tab-" + name);
  const cur = panes.find(p => p.classList.contains("active"));

  // Cross-fade: fade current out, then fade next in
  const FADE_MS = 180;
  const IN_MS = 220;

  const activate = () => {
    panes.forEach((p) => {
      if (p === next) {
        p.classList.add("active");
        p.classList.add("in");
        setTimeout(() => p.classList.remove("in"), IN_MS);
      } else {
        p.classList.remove("active");
        p.classList.remove("in");
      }
    });
  };

  if (cur && cur !== next) {
    cur.classList.add("out");
    setTimeout(() => {
      cur.classList.remove("out");
      cur.classList.remove("active");
      activate();
    }, FADE_MS);
  } else {
    activate();
  }

  $$(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".btab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));

  // Tools UX: always return to landing when opening tools tab
  if (name === "tools" && typeof toolsBack === "function") {
    toolsBack(true);
  }

  if(name === "profile"){
    refreshMe().catch(()=>{});
    // txPull may be absent in some builds; guard safely
    if (typeof window.txPull === "function") window.txPull().catch(()=>{});
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
  _me = currentUser;

  const st = $("#meStatus");
  const pName = $("#pName");
  const pId = $("#pUserId");
  const pAv = $("#pAvatar");

  const authBox = $("#authBox");
  const tools = $("#profileTools");
  const lo = $("#btnLogout");
  const caseBox = $("#caseBox");
  const limitsBox = $("#limitsBox");
  const balBox = $("#balanceBox");
  const invBox = $("#invBox");
  const balVal = $("#balanceValue");
  const premPayBox = $("#premiumPayBox");
  const premState = $("#premiumState");
  const premDesc = $("#premiumDesc");
  const btnTopUp = $("#btnTopUp");
  const btnBuyPremium = $("#btnBuyPremium");
  const adminCard = $("#adminCard");
  const adminUserCard = $("#adminUserCard");
  const btnNotifOpen = $("#btnNotifOpen");

const btnSettings = $("#btnSettings");
const btnShopPanel = $("#btnShopPanel");


  document.body.classList.toggle("guest", !currentUser);
  document.body.classList.toggle("authed", !!currentUser);
  // mark admin in DOM for CSS/UI gates
  document.body.classList.toggle("admin", !!(currentUser && currentUser.is_admin));
  if(!currentUser){
    if ($("#btnSettings")) $("#btnSettings").style.display = "none";
    if ($("#btnShopPanel")) $("#btnShopPanel").style.display = "none";
  }

  if (currentUser) {
    if(!topupCfg) await loadTopupConfig();
    const extra = currentUser.email ? ` • ${currentUser.email}` : "";
    if (st) st.textContent = `${currentUser.username}${extra}`;
    if (pName) pName.textContent = currentUser.username;
    if (pId) pId.textContent = (currentUser.id ?? currentUser.user_id ?? "—");
    if (pAv) pAv.textContent = (currentUser.username || "?").slice(0,1).toUpperCase();
    if (authBox) authBox.style.display = "none";
    if (tools) tools.style.display = "block";
    if (lo) lo.style.display = "inline-flex";
    if (caseBox) caseBox.style.display = "block";
    if (limitsBox) limitsBox.style.display = "block";
    if (balBox) balBox.style.display = "block";
    if (invBox) invBox.style.display = "block";
    if (balVal) balVal.textContent = formatMoney(currentUser.balance ?? 0);

    const topBalBox = $("#topBalanceBox");
    const topBalVal = $("#topBalanceValue");
    if (topBalBox) topBalBox.style.display = "flex";
    if (topBalVal) topBalVal.textContent = `${formatMoney(currentUser.balance ?? 0)} ₽`;
    if (premPayBox) premPayBox.style.display = "block";
    if (adminCard) adminCard.style.display = (currentUser.is_admin ? "block" : "none");
    if (btnNotifOpen) btnNotifOpen.style.display = "inline-flex";
    if (btnSettings) btnSettings.style.display = "inline-flex";
    if (btnShopPanel) btnShopPanel.style.display = (currentUser.is_admin ? "inline-flex" : "none");
    try{ syncSettingsUI(); }catch(_e){}
    try{ await loadAndApplyShopConfig(); }catch(_e){}

    notifPull().catch(()=>{});
    if (currentUser.is_admin){
      const tbox = $("#adminTopupsList");
      const pbox = $("#adminPromosList");
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

    // refresh case hint (guarded)
    if (typeof window.caseStatus === "function") {
      await window.caseStatus().catch(() => {});
    }

    // refresh inventory (guarded)
    if (typeof window.invPull === "function") {
      await window.invPull().catch(() => {});
    }

    // 2FA recommendation (only if 2FA disabled and user didn't dismiss)
    try{
      const laterUntil = Number(localStorage.getItem("rst_twofa_later_until") || "0");
      const canShowLater = !(laterUntil && Date.now() < laterUntil);
      if (canShowLater && currentUser && !currentUser.twofa_email_enabled && !currentUser.hide_2fa_reminder) {
        if (typeof window.openTwofaRecommend === "function") window.openTwofaRecommend();
      }
    }catch(_e){}
  } else {
    if (st) st.textContent = "не вошёл";
    if (authBox) authBox.style.display = "block";
    if (tools) tools.style.display = "none";
    if (lo) lo.style.display = "none";
    if (caseBox) caseBox.style.display = "none";
    if (limitsBox) limitsBox.style.display = "none";

    if (balBox) balBox.style.display = "none";
    if (invBox) invBox.style.display = "none";

    const topBalBox = $("#topBalanceBox");
    if (topBalBox) topBalBox.style.display = "none";
    if (premPayBox) premPayBox.style.display = "none";
    if (adminCard) adminCard.style.display = "none";
    if (btnNotifOpen) btnNotifOpen.style.display = "none";
    if (adminUserCard) adminUserCard.style.display = "none";

    // also hide chat input if logged out
    const chatBox = $("#chatBox");
    const btnSend = $("#btnChatSend");
    if (chatBox) chatBox.style.display = "none";
    if (btnSend) btnSend.disabled = true;
  }
  // refresh templates (v2)
  try{ await tplFetchAll(); }catch(_e){}
}


// -------------------------
// Admin modal + management
// -------------------------
function openAdminModal(){
  const back = document.getElementById("adminBack");
  const modal = document.getElementById("adminModal");
  if(!back || !modal) return;
  back.classList.remove("hidden");
  modal.classList.remove("hidden");
  modal.classList.add("open");
  requestAnimationFrame(()=>modal.classList.add("vis"));
  // load admin widgets
  try{ adminRobuxRefreshAll?.(); }catch(_e){}
}
function closeAdminModal(){
  const back = document.getElementById("adminBack");
  const modal = document.getElementById("adminModal");
  if(!back || !modal) return;
  modal.classList.remove("vis");
  modal.classList.remove("open");
  back.classList.add("hidden");
  modal.classList.add("hidden");
}
window.openAdminModal = openAdminModal;
window.closeAdminModal = closeAdminModal;

// Existing admin functions below

let adminSelected = null;

function renderAdminUsers(users){
  const box = document.getElementById("adminUsersList");
  if(!box) return;
  const arr = Array.isArray(users) ? users : [];
  if(arr.length === 0){
    box.innerHTML = `<div class="muted" style="font-size:12px">Нет пользователей</div>`;
    return;
  }
  box.innerHTML = arr.map(u=>{
    const isAdmin = Number(u.is_admin||0)===1;
    const isBanned = !!u.banned_until;
    const tag = isBanned ? `<span class="badge" style="margin-left:8px">BAN</span>` : (isAdmin ? `<span class="badge" style="margin-left:8px">ADMIN</span>` : "");
    const sub = [u.last_country, u.last_city].filter(Boolean).join(", ") || "—";
    const created = u.created_at ? new Date(u.created_at).toLocaleDateString() : "";
    return `<button class="btn tilt" data-uid="${u.id}" type="button" style="width:100%; justify-content:space-between; text-align:left; padding:10px 12px; border-radius:14px">
      <span style="display:flex; flex-direction:column; gap:2px; min-width:0">
        <span style="display:flex; align-items:center; gap:8px; min-width:0">
          <b style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${escapeHtml(u.username||("#"+u.id))}</b>
          ${tag}
        </span>
        <span class="muted" style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">ID ${u.id} • ${sub}${created?` • ${created}`:""}</span>
      </span>
      <span class="mono" style="opacity:.85">${formatMoney(u.balance||0)} ₽</span>
    </button>`;
  }).join("");

  // click to load
  box.querySelectorAll("button[data-uid]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const uid = btn.getAttribute("data-uid");
      const inp = document.getElementById("adminIdent");
      if(inp) inp.value = uid;
      adminFind();
    });
  });
}

let _adminUsersDeb = null;
async function adminUsersRefresh(q=""){
  try{
    const j = await apiGet(`/api/admin/users?q=${encodeURIComponent(q||"")}`);
    if(j && j.ok) renderAdminUsers(j.users||[]);
  }catch(e){
    const box = document.getElementById("adminUsersList");
    if(box) box.innerHTML = `<div class="muted" style="font-size:12px">Ошибка загрузки пользователей</div>`;
  }
}

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
    const hint = $("#adminEmptyHint");
    if(hint) hint.style.display = "none";
    $("#adm_id").textContent = adminSelected.id;
    $("#adm_username").textContent = adminSelected.username;
    $("#adm_email").textContent = adminSelected.email || "—";
    $("#adm_balance").textContent = String(adminSelected.balance ?? 0);
    const created = adminSelected.created_at ? new Date(adminSelected.created_at).toLocaleString() : "—";
    $("#adm_created").textContent = created;
    const seen = adminSelected.last_seen_at ? new Date(adminSelected.last_seen_at).toLocaleString() : "—";
    $("#adm_seen").textContent = seen;
    $("#adm_ip").textContent = adminSelected.last_ip || "—";
    const geo = [adminSelected.last_country, adminSelected.last_city].filter(Boolean).join(", ");
    $("#adm_geo").textContent = geo || "—";
    const bu = adminSelected.banned_until ? new Date(adminSelected.banned_until).toLocaleString() : "—";
    $("#adm_ban").textContent = bu;

    await adminLoadTx(adminSelected.id);
    toast("Админ", "Пользователь найден", "ok");
  }catch(e){
    adminSelected = null;
    const card = $("#adminUserCard");
    if(card) card.style.display = "none";
    const hint = $("#adminEmptyHint");
    if(hint) hint.style.display = "block";
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



async function adminRename(){
  if(!adminSelected) return toast("Админ", "Сначала найди пользователя", "warn");
  const nu = ($("#adm_newname")?.value || "").trim();
  if(!nu) return toast("Админ", "Введите новый ник", "warn");
  try{
    const j = await apiPost("/api/admin/user/rename", {user_id: adminSelected.id, new_username: nu});
    adminSelected.username = j.username;
    $("#adm_username").textContent = j.username;
    $("#adm_newname").value = "";
    toast("Админ", "Ник обновлён", "ok");
  }catch(e){
    toast("Админ", e.message || "Ошибка", "bad");
  }
}

async function adminBan(){
  if(!adminSelected) return toast("Админ", "Сначала найди пользователя", "warn");
  const daysRaw = ($("#adm_bandays")?.value || "").trim();
  let days = null;
  if(daysRaw !== ""){
    const d = parseInt(daysRaw, 10);
    if(Number.isFinite(d)) days = d;
  }
  let reason = "";
  try{ reason = prompt("Причина бана (опционально):", "") || ""; }catch(_e){}
  try{
    const j = await apiPost("/api/admin/user/ban", {user_id: adminSelected.id, days, reason});
    adminSelected.banned_until = j.banned_until;
    $("#adm_ban").textContent = new Date(j.banned_until).toLocaleString();
    toast("Админ", "Забанен", "ok");
  }catch(e){
    toast("Админ", e.message || "Ошибка", "bad");
  }
}

async function adminUnban(){
  if(!adminSelected) return toast("Админ", "Сначала найди пользователя", "warn");
  try{
    await apiPost("/api/admin/user/unban", {user_id: adminSelected.id});
    adminSelected.banned_until = "";
    $("#adm_ban").textContent = "—";
    toast("Админ", "Разбан", "ok");
  }catch(e){
    toast("Админ", e.message || "Ошибка", "bad");
  }
}

async function adminNotify(){
  if(!adminSelected) return toast("Админ", "Сначала найди пользователя", "warn");
  const text = ($("#adm_notif")?.value || "").trim();
  if(!text) return toast("Админ", "Введите текст", "warn");
  try{
    await apiPost("/api/admin/notify", {user_id: adminSelected.id, text});
    $("#adm_notif").value = "";
    toast("Админ", "Отправлено", "ok");
  }catch(e){
    toast("Админ", e.message || "Ошибка", "bad");
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
  const box = $("#adminPromosList");
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
// Admin: Robux settings + orders
// -------------------------

async function adminRobuxLoadSettings(){
  const st = $("#adm_robux_status");
  const sub = $("#adm_robux_status_sub");
  try{
    const j = await apiGet("/api/admin/robux/settings");
    const s = j.settings || {};
    const eff = j.effective || {};
    // cookie: keep empty for safety; show mask in placeholder
    const inp = $("#adm_robux_cookie");
    if(inp){
      inp.value = "";
      inp.placeholder = s.cookie_mask ? ("COOKIE: " + s.cookie_mask) : ".ROBLOSECURITY=...";
    }
    if($("#adm_robux_min")) $("#adm_robux_min").value = String(s.min_amount ?? "");
    if($("#adm_robux_rub")) $("#adm_robux_rub").value = String(s.rub_per_robux ?? "");
    if($("#adm_robux_factor")) $("#adm_robux_factor").value = String(s.gp_factor ?? "");
    if($("#adm_robux_stock_show")) $("#adm_robux_stock_show").value = String(s.stock_show ?? "");
    if($("#adm_robux_stock_sell")) $("#adm_robux_stock_sell").value = String(s.stock_sell ?? "");
    if($("#adm_robux_reserve_seconds")) $("#adm_robux_reserve_seconds").value = String(s.reserve_seconds ?? "");

    if(st){
      if(eff.seller_configured){
        st.textContent = eff.env_override ? "✅ Продавец настроен (ENV override)" : "✅ Продавец настроен";
      }else{
        st.textContent = s.cookie_in_db ? "⚠️ Cookie в базе, но продавец не авторизован" : "⚠️ Cookie не задан";
      }
    }
    if(sub){
      sub.textContent = "Проверь продавца, чтобы увидеть ник и баланс Robux.";
    }
  }catch(e){
    if(st) st.textContent = "Ошибка загрузки";
    if(sub) sub.textContent = e.message || "";
  }
}

async function adminRobuxTestSeller(){
  const st = $("#adm_robux_status");
  const sub = $("#adm_robux_status_sub");
  try{
    const j = await apiGet("/api/admin/robux/seller_status");
    const s = j.seller || {};
    if(!s.configured){
      if(st) st.textContent = "⚠️ Продавец не настроен";
      if(sub) sub.textContent = "Проверь cookie (ENV или в админке)";
      return;
    }
    if(st) st.textContent = `✅ ${s.username} (id ${s.user_id})`;
    if(sub) sub.textContent = `Баланс Robux: ${s.robux}`;
  }catch(e){
    if(st) st.textContent = "Ошибка проверки";
    if(sub) sub.textContent = e.message || "";
  }
}

async function adminRobuxSaveSettings(){
  try{
    const payload = {
      min_amount: ($("#adm_robux_min")?.value||"").trim(),
      rub_per_robux: ($("#adm_robux_rub")?.value||"").trim(),
      gp_factor: ($("#adm_robux_factor")?.value||"").trim(),
      stock_show: ($("#adm_robux_stock_show")?.value||"").trim(),
      stock_sell: ($("#adm_robux_stock_sell")?.value||"").trim(),
      reserve_seconds: ($("#adm_robux_reserve_seconds")?.value||"").trim(),
    };
    // cookie: only send if user typed something
    const ck = ($("#adm_robux_cookie")?.value||"").trim();
    if(ck) payload.cookie = ck;

    await apiPost("/api/admin/robux/settings", payload);
    toast("Robux", "Сохранено", "ok");
    await adminRobuxLoadSettings();
    await adminRobuxTestSeller();
  }catch(e){
    toast("Robux", e.message || "Ошибка", "bad");
  }
}

function renderAdminRobuxOrders(items){
  const box = $("#adminRobuxOrdersList");
  if(!box) return;
  const arr = Array.isArray(items) ? items : [];
  if(arr.length === 0){
    box.innerHTML = `<div class="muted" style="font-size:12px">Заказов нет</div>`;
    return;
  }
  box.innerHTML = arr.map(it=>{
    const when = it.created_at ? new Date(it.created_at).toLocaleString() : "";
    const who = escapeHtml(it.username || ("#"+it.user_id));
    const st = (it.status||"").toUpperCase();
    const err = it.error ? `<div class="muted" style="font-size:12px; margin-top:4px">${escapeHtml(it.error)}</div>` : "";
    return `<div style="padding:10px 0; border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="display:flex; gap:10px; justify-content:space-between; align-items:flex-start">
        <div style="flex:1; min-width:0">
          <div style="font-weight:900">${who} <span class="badge" style="margin-left:8px">${st}</span></div>
          <div class="muted" style="font-size:12px">#${it.id} • ${it.robux_amount}R$ за ${it.rub_price}₽ • GP: ${it.gamepass_price} • ${escapeHtml(it.gamepass_owner||"")}</div>
          <div class="muted" style="font-size:12px">${when}</div>
          ${err}
        </div>
      </div>
    </div>`;
  }).join("");
}

async function adminRobuxLoadOrders(){
  const box = $("#adminRobuxOrdersList");
  if(box) box.textContent = "Загрузка…";
  try{
    const st = ($("#adm_robux_orders_status")?.value||"active").trim();
    const j = await apiGet(`/api/admin/robux/orders?status=${encodeURIComponent(st)}&limit=60`);
    renderAdminRobuxOrders(j.items||[]);
  }catch(e){
    if(box) box.textContent = "Ошибка загрузки";
  }
}

async function adminRobuxRefreshAll(){
  await adminRobuxLoadSettings();
  await adminRobuxLoadOrders();
}



// -------------------------
// Boot
// -------------------------
window.addEventListener("load", async () => {
  // nav
  $$(".navbtn").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $$(".btab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

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

const CASE_PAID_PRICE = 17;

const CASE_ITEMS = [
  { key:"GEN10", label:"+10 анализов", icon:"⚡", weight:450 },
  { key:"AI3",   label:"+3 генерации (AI+анализ)", icon:"✨", weight:350 },
  { key:"P6H",   label:"Premium 6 часов", icon:"💎", img:"/static/prizes/premium_6h.png", weight:100 },
  { key:"P12H",  label:"Premium 12 часов", icon:"💎", img:"/static/prizes/premium_12h.png", weight:50 },
  { key:"P24H",  label:"Premium 24 часа", icon:"💎", img:"/static/prizes/premium_24h.png", weight:25 },
  { key:"P2D",   label:"Premium 2 дня", icon:"💎", img:"/static/prizes/premium_2d.png", weight:12 },
  { key:"P3D",  label:"Premium 3 дня", icon:"💎", img:"/static/prizes/premium_3d.png", weight:8 },
  { key:"P7D",   label:"Premium 7 дней", icon:"💎", img:"/static/prizes/premium_7d.png", weight:5 },
];


// tilt effects
  initTilt();
  buildCaseUI();

  // profile modals
  // NOTE: openSavedTemplates may be absent in some builds; guard to avoid breaking the whole app.
  if (typeof openSavedTemplates !== "undefined") {
    $("#btnShowSavedTemplates")?.addEventListener("click", openSavedTemplates);
  }
  if (typeof openTxModal !== "undefined") {
    $("#btnShowTx")?.addEventListener("click", openTxModal);
  }

  // particles + logo burst
  initParticles();
  setInterval(spawnLogoStar, 5000);

// load templates + cookie
  tplFetchAll().catch(()=>{});
  const c = localStorage.getItem("rst_cookie");
  if (c && $("#cookie")) $("#cookie").value = c;

  // generator UX: auto preview toggle + variable chips
  const autoKey = "rst_auto_preview";
  const autoPreview = $("#autoPreview");
  if (autoPreview) {
    const v = localStorage.getItem(autoKey);
    autoPreview.checked = (v == null) ? true : (v === "1");
    autoPreview.addEventListener("change", () => {
      localStorage.setItem(autoKey, autoPreview.checked ? "1" : "0");
    });
  }

  // Remember last focused input for variable insertion
  let _genLastFocus = null;
  ["#tplTitle", "#tplDesc"].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("focus", () => { _genLastFocus = el; });
    el.addEventListener("click", () => { _genLastFocus = el; });
  });

  function insertAtCursor(el, text){
    if (!el || !text) return;
    try {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const v = el.value || "";
      el.value = v.slice(0, start) + text + v.slice(end);
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    } catch (_e) {
      // fallback
      el.value = (el.value || "") + text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    }
  }

  const varsRow = $("#varsRow");
  if (varsRow) {
    const vars = [
      "{username}", "{robux}", "{rap_tag}", "{donate_tag}", "{year_tag}", "{profile_link}", "{inv_ru}", "{age_group}"
    ];
    varsRow.innerHTML = vars.map(v => `<button type="button" class="varChip" data-var="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join("");
    varsRow.querySelectorAll("[data-var]").forEach(b => {
      b.addEventListener("click", () => insertAtCursor(_genLastFocus || $("#tplDesc") || $("#tplTitle"), b.getAttribute("data-var")));
    });
  }

  $("#btnBuildPreview")?.addEventListener("click", () => renderPreview().catch(() => {}));

  $("#tplTitle")?.addEventListener("input", () => {
    saveTpl();
    if ($("#autoPreview")?.checked) renderPreview().catch(() => {});
  });
  $("#tplDesc")?.addEventListener("input", () => {
    saveTpl();
    if ($("#autoPreview")?.checked) renderPreview().catch(() => {});
  });

  $("#btnSaveTpl")?.addEventListener("click", () => {
    saveTpl();
    toast("Сохранено", "Шаблоны сохранены локально", "ok");
  });
  $("#btnResetTpl")?.addEventListener("click", resetTpl);

  $("#tplSelect")?.addEventListener("change", (e)=>{
    const id = (e.target && e.target.value) ? e.target.value : null;
    if(id) tplSelect(id).catch(()=>{});
  });
  $("#tplAgeGroup")?.addEventListener("change", ()=>{
    saveTpl();
    if ($("#autoPreview")?.checked) renderPreview().catch(() => {});
  });
  $("#btnTplNew")?.addEventListener("click", ()=>tplCreate().catch(()=>{}));
  $("#btnTplDel")?.addEventListener("click", ()=>tplDelete().catch(()=>{}));

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

  // --- Auth wizard state (saved locally) ---
  const AUTH_DRAFT_KEY = "rst_auth_draft_v1";
  const authDraft = (() => {
    try { return JSON.parse(localStorage.getItem(AUTH_DRAFT_KEY) || "{}") || {}; } catch(_e){ return {}; }
  })();
  const saveDraft = () => {
    const d = {
      loginUser: $("#loginUser")?.value || "",
      loginPass: $("#loginPass")?.value || "",
      regUser: $("#regUser")?.value || "",
      regEmail: $("#regEmail")?.value || "",
      regPass: $("#regPass")?.value || "",
      regPass2: $("#regPass2")?.value || "",
      resetEmail: $("#resetEmail")?.value || "",
    };
    try { localStorage.setItem(AUTH_DRAFT_KEY, JSON.stringify(d)); } catch(_e){}
  };
  const restoreDraft = () => {
    const map = [
      ["loginUser","loginUser"],["loginPass","loginPass"],
      ["regUser","regUser"],["regEmail","regEmail"],["regPass","regPass"],["regPass2","regPass2"],
      ["resetEmail","resetEmail"]
    ];
    map.forEach(([k,id])=>{
      const el = $("#"+id);
      if(el && typeof authDraft[k] === "string" && authDraft[k]) el.value = authDraft[k];
    });
  };
  restoreDraft();
  ["loginUser","loginPass","regUser","regEmail","regPass","regPass2","resetEmail"].forEach(id=>{
    $("#"+id)?.addEventListener("input", saveDraft);
  });

  function authShowStep(flow, step){
    const box = document.querySelector(`.authSteps[data-flow="${flow}"]`);
    if(!box) return;
    box.querySelectorAll(".authStep").forEach(st=>{
      st.classList.toggle("active", String(st.dataset.step) === String(step));
    });

    // hints
    if(flow === "login"){
      const hint = $("#loginStepHint");
      if(hint) hint.textContent = step === 1 ? "Шаг 1 из 3 — логин или email" : (step === 2 ? "Шаг 2 из 3 — пароль" : "Шаг 3 из 3 — код из письма");
    }else if(flow === "reg"){
      const hint = $("#regStepHint");
      if(hint) hint.textContent = step === 1 ? "Шаг 1 из 3 — логин и email" : (step === 2 ? "Шаг 2 из 3 — пароль" : "Шаг 3 из 3 — код из письма");
    }else if(flow === "reset"){
      const hint = $("#resetStepHint");
      if(hint) hint.textContent = step === 1 ? "Шаг 1 из 2 — email" : "Шаг 2 из 2 — код и новый пароль";
    }
  }

  // Back buttons
  $$(".authBack").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const flow = btn.dataset.flow;
      const to = Number(btn.dataset.to||"1");
      authShowStep(flow, to);
    });
  });

  // default steps
  authShowStep("login", 1);
  authShowStep("reg", 1);
  authShowStep("reset", 1);

  // Login wizard
  $("#btnLoginNext1")?.addEventListener("click", ()=>{
    if(!($("#loginUser")?.value||"").trim()){
      toast("Вход", "Укажи логин или email", "warn");
      return;
    }
    authShowStep("login", 2);
    $("#loginPass")?.focus();
  });

  $("#btnLoginNext2")?.addEventListener("click", async ()=>{
    try{
      const username = ($("#loginUser")?.value||"").trim();
      const password = $("#loginPass")?.value || "";
      if(!username || !password){
        toast("Вход", "Заполни логин и пароль", "warn");
        return;
      }
      const res = await apiPost("/api/auth/login", { username, password });
      if(res && res.needs_2fa){
        authShowStep("login", 3);
        $("#loginCode")?.focus();
        toast("2FA", "Код отправлен на почту", "ok");
        return;
      }
      toast("Профиль", "Вход выполнен", "ok");
      await refreshMe();
      await syncPull().catch(() => {});
      if (currentUser && currentUser.limits && currentUser.limits.premium) { await chatPull().catch(() => {}); }
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  $("#btnLoginConfirm")?.addEventListener("click", async ()=>{
    try{
      const username = ($("#loginUser")?.value||"").trim();
      const code = ($("#loginCode")?.value||"").trim();
      if(!code){
        toast("2FA", "Введи код", "warn");
        return;
      }
      await apiPost("/api/auth/login_confirm", { username, code });
      toast("Профиль", "Вход выполнен", "ok");
      $("#loginCode").value = "";
      await refreshMe();
      await syncPull().catch(() => {});
      if (currentUser && currentUser.limits && currentUser.limits.premium) { await chatPull().catch(() => {}); }
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  // Register wizard
  $("#btnRegNext1")?.addEventListener("click", ()=>{
    const u = ($("#regUser")?.value||"").trim();
    const em = ($("#regEmail")?.value||"").trim();
    if(!u || !em){
      toast("Регистрация", "Укажи логин и email", "warn");
      return;
    }
    authShowStep("reg", 2);
    $("#regPass")?.focus();
  });

  $("#btnRegSendCode")?.addEventListener("click", async ()=>{
    try{
      const username = ($("#regUser")?.value||"").trim();
      const email = ($("#regEmail")?.value||"").trim();
      const p1 = $("#regPass")?.value || "";
      const p2 = $("#regPass2")?.value || "";
      if(!username || !email || !p1){
        toast("Регистрация", "Заполни все поля", "warn");
        return;
      }
      if(p1 !== p2){
        toast("Регистрация", "Пароли не совпадают", "warn");
        return;
      }
      await apiPost("/api/auth/register_start", { username, email, password: p1 });
      toast("Регистрация", "Код отправлен на почту", "ok");
      authShowStep("reg", 3);
      $("#regCode")?.focus();
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  $("#btnRegConfirm")?.addEventListener("click", async ()=>{
    try{
      const email = ($("#regEmail")?.value||"").trim();
      const code = ($("#regCode")?.value||"").trim();
      await apiPost("/api/auth/register_confirm", { email, code });
      toast("Регистрация", "Готово — ты вошёл", "ok");
      $("#regCode").value = "";
      await refreshMe();
      await syncPull().catch(() => {});
      if (currentUser && currentUser.limits && currentUser.limits.premium) { await chatPull().catch(() => {}); }
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  // Reset wizard
  $("#btnResetSendCode")?.addEventListener("click", async ()=>{
    try{
      const email = ($("#resetEmail")?.value||"").trim();
      if(!email){ toast("Сброс", "Укажи email", "warn"); return; }
      await apiPost("/api/auth/reset_start", { email });
      toast("Сброс", "Если email существует — код отправлен", "ok");
      authShowStep("reset", 2);
      $("#resetCode")?.focus();
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  $("#btnResetConfirm")?.addEventListener("click", async ()=>{
    try{
      const email = ($("#resetEmail")?.value||"").trim();
      const code = ($("#resetCode")?.value||"").trim();
      const new_password = $("#resetPass")?.value || "";
      await apiPost("/api/auth/reset_confirm", { email, code, new_password });
      toast("Сброс", "Пароль обновлён", "ok");
      authShowStep("reset", 1);
      setAuthPane("login");
      authShowStep("login", 1);
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  // 2FA recommendation + setup modals
  function modalOpen(backId, modalId){
    const back = $("#"+backId), modal = $("#"+modalId);
    if(!back || !modal) return;
    back.classList.remove("hidden");
    modal.classList.remove("hidden");
    modal.classList.add("open");
    requestAnimationFrame(()=>modal.classList.add("vis"));
  }
  function modalClose(backId, modalId){
    const back = $("#"+backId), modal = $("#"+modalId);
    if(!back || !modal) return;
    modal.classList.remove("vis");
    modal.classList.remove("open");
    back.classList.add("hidden");
    modal.classList.add("hidden");
  }
  window.openTwofaSetup = ()=>{ modalOpen("twofaSetBack","twofaSetModal"); $("#twofaSetStep1").style.display="block"; $("#twofaSetStep2").style.display="none"; };
  window.closeTwofaSetup = ()=> modalClose("twofaSetBack","twofaSetModal");
  window.openTwofaRecommend = ()=> modalOpen("twofaRecBack","twofaRecModal");
  window.closeTwofaRecommend = ()=> modalClose("twofaRecBack","twofaRecModal");

  $("#btnTwofaRecClose")?.addEventListener("click", window.closeTwofaRecommend);
  $("#twofaRecBack")?.addEventListener("click", window.closeTwofaRecommend);

  $("#btnTwofaRecLater")?.addEventListener("click", ()=>{
    try{ localStorage.setItem("rst_twofa_later_until", String(Date.now() + 24*60*60*1000)); }catch(_e){}
    window.closeTwofaRecommend();
  });

  $("#btnTwofaRecNever")?.addEventListener("click", async ()=>{
    try{
      await apiPost("/api/user/twofa_hide_reminder", {});
      window.closeTwofaRecommend();
      toast("2FA", "Ок, больше не напомню", "ok");
      await refreshMe();
    }catch(e){
      window.closeTwofaRecommend();
    }
  });

  $("#btnTwofaRecEnable")?.addEventListener("click", ()=>{
    window.closeTwofaRecommend();
    window.openTwofaSetup();
  });

  $("#btnTwofaSetClose")?.addEventListener("click", window.closeTwofaSetup);
  $("#twofaSetBack")?.addEventListener("click", window.closeTwofaSetup);

  $("#btnTwofaSend")?.addEventListener("click", async ()=>{
    try{
      await apiPost("/api/user/twofa_enable_start", {});
      $("#twofaSetStep1").style.display="none";
      $("#twofaSetStep2").style.display="block";
      $("#twofaEnableCode")?.focus();
      toast("2FA", "Код отправлен на почту", "ok");
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  $("#btnTwofaConfirm")?.addEventListener("click", async ()=>{
    try{
      const code = ($("#twofaEnableCode")?.value||"").trim();
      if(!code){ toast("2FA", "Введи код", "warn"); return; }
      await apiPost("/api/user/twofa_enable_confirm", { code });
      $("#twofaEnableCode").value = "";
      window.closeTwofaSetup();
      toast("2FA", "Включено", "ok");
      await refreshMe();
    }catch(e){
      toast("Ошибка", e.message, "bad");
    }
  });

  $("#btnTwofaDisable")?.addEventListener("click", async ()=>{
    try{
      await apiPost("/api/user/twofa_disable", {});
      window.closeTwofaSetup();
      toast("2FA", "Выключено", "warn");
      await refreshMe();
    }catch(e){
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
  $("#btnAdminRobuxRefresh")?.addEventListener("click", adminRobuxRefreshAll);
  $("#btnAdminRobuxSave")?.addEventListener("click", adminRobuxSaveSettings);
  $("#btnAdminRobuxTest")?.addEventListener("click", adminRobuxTestSeller);
  $("#btnAdminRobuxOrdersRefresh")?.addEventListener("click", adminRobuxLoadOrders);
  $("#adm_robux_orders_status")?.addEventListener("change", adminRobuxLoadOrders);
  $("#btnAdminRobuxCookieToggle")?.addEventListener("click", ()=>{ const i=$("#adm_robux_cookie"); if(!i) return; i.type = (i.type === 'password') ? 'text' : 'password'; });


  // Payments
  await loadTopupConfig();
  $("#btnTopUp")?.addEventListener("click", () => openPayModal("topup"));
  // Extra topup triggers (used by redesigned layout)
  document.querySelectorAll('[data-topup="1"]').forEach((el)=>{
    el.addEventListener("click", () => openPayModal("topup"));
  });
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
function buildCaseUI({ rebuildReel = true } = {}){
  // prizes modal list
  const list = $("#casePrizesList");
  if(list){
    list.innerHTML = "";
    const total = CASE_ITEMS.reduce((s,x)=>s+x.weight,0);
    CASE_ITEMS.forEach(it=>{
      const row = document.createElement("div");
      row.className = "prizeRow";
      const pct = ((it.weight/total)*100).toFixed(1) + "%";
      const icoHtml = it.img ? `<img class="prImg" src="${it.img}" alt="">` : `<div class="prIco">${it.icon}</div>`;
      row.innerHTML = `
        ${icoHtml}
        <div style="flex:1">
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
  if(reel && rebuildReel){
    reel.innerHTML = "";
    const seq = [];
    // Build long sequence for smooth spin
    for(let i=0;i<7;i++){
      CASE_ITEMS.forEach(it=>seq.push(it));
    }
    // Extra random tail
    for(let i=0;i<22;i++){
      seq.push(CASE_ITEMS[Math.floor(Math.random()*CASE_ITEMS.length)]);
    }
    seq.forEach((it)=>{
      const d = document.createElement("div");
      d.className = "casePrize" + (it.key.startsWith("P") ? " prem" : "");
      d.dataset.prize = it.key;
      d.innerHTML = `
        <div class="caseInner">
          ${it.img ? `<img class="caseImg" src="${it.img}" alt="">` : `<div class="caseIcon">${it.icon || "🎁"}</div>`}
          <div class="caseLbl">${escapeHtml(it.label)}</div>
        </div>
      `;
      reel.appendChild(d);
    });
    // reset position
    reel.style.transition = "none";
    reel.style.transform = "translateX(0)";
  }

  // prizes modal hooks (idempotent)
// (disabled: duplicate bindings handled by CaseModal module)   if($("#btnCasePrizes")) $("#btnCasePrizes").onclick = ()=>openCasePrizes();
// (disabled: duplicate bindings handled by CaseModal module)   if($("#btnCasePrizesClose")) $("#btnCasePrizesClose").onclick = ()=>closeCasePrizes();
// (disabled: duplicate bindings handled by CaseModal module)   if($("#casePrizesBack")) $("#casePrizesBack").onclick = ()=>closeCasePrizes();
}

function openCasePrizes(){
  const m = $("#casePrizesModal");
  if(!m) return;
  const b = $("#casePrizesBack");
  if(b){
    b.classList.remove("hidden");
    b.style.display = "block";
  }
  m.classList.remove("hidden");
  m.style.display = "block";
  m.classList.add("open");
  requestAnimationFrame(()=>m.classList.add("vis"));
}

function closeCasePrizes(){
  const m = $("#casePrizesModal");
  if(!m) return;
  m.classList.remove("vis");
  setTimeout(()=>{
    m.classList.remove("open");
    m.style.display = "none";
    m.classList.add("hidden");
    const b = $("#casePrizesBack");
    if(b){ b.style.display = "none"; b.classList.add("hidden"); }
  }, 190);
}

// Case open modal (free / paid)
let caseMode = "free"; // "free" | "paid"
function _setCaseLocked(v){
  const m = $("#caseOpenModal");
  if(!m) return;
  if(v) m.classList.add("locked");
  else m.classList.remove("locked");
}
function setCaseMode(mode){
  caseMode = mode;
  const badge = $("#caseModeBadge");
  const title = $("#caseModalTitle");
  const free = $("#caseFreeControls");
  const paid = $("#casePaidControls");
  if(mode === "paid"){
    if(title) title.textContent = "💸 Кейс за 17₽";
    if(badge) badge.textContent = "PAID";
    // paid controls are initially rendered with .hidden in HTML
    // (to avoid flashing). We must remove it explicitly here.
    if(free){
      free.style.display = "none";
    }
    if(paid){
      paid.classList.remove("hidden");
      paid.style.display = "flex";
    }
    $("#caseResult") && ($("#caseResult").textContent = "—");
  }else{
    if(title) title.textContent = "🎯 Кейс за капчу";
    if(badge) badge.textContent = "FREE";
    if(free){
      free.style.display = "flex";
    }
    if(paid){
      paid.style.display = "none";
      paid.classList.add("hidden");
    }
    $("#caseResult") && ($("#caseResult").textContent = "—");
  }
}

function openCaseModal(mode){
  const m = $("#caseOpenModal");
  if(!m) return;

  // auth guard
  if(!currentUser){
    toast("Профиль","Сначала войди в аккаунт","warn");
    try{ showTab("profile"); }catch(_e){}
    return;
  }

  // rebuild reel each open for fresh feel
  buildCaseUI({ rebuildReel: true });
  setCaseMode(mode);
  _setCaseLocked(false);

  const back = $("#caseOpenBack");
  if(back){
    back.classList.remove("hidden");
    back.style.display = "block";
  }
  m.classList.remove("hidden");

  // IMPORTANT: keep modal layout controlled by CSS (.modal.open).
  // Using flex here breaks the internal vertical layout (header/stage/controls).
  m.style.display = "block";
  m.classList.add("open");
  requestAnimationFrame(()=>m.classList.add("vis"));

  // refresh cooldown hint
  if (typeof window.caseStatus === "function") window.caseStatus().catch(()=>{});
}

function closeCaseModal(){
  if(caseSpinning) return; // do not allow closing while spinning
  const m = $("#caseOpenModal");
  if(!m) return;
  m.classList.remove("vis");
  setTimeout(()=>{
    m.classList.remove("open");
    m.style.display = "none";
    m.classList.add("hidden");
    const back = $("#caseOpenBack");
    if(back){ back.style.display = "none"; back.classList.add("hidden"); }
  }, 190);
}

// hooks
// (disabled: duplicate bindings handled by CaseModal module) $("#btnOpenCaseFree")?.addEventListener("click", ()=>window.openCaseModal("free"));
// (disabled: duplicate bindings handled by CaseModal module) $("#btnOpenCasePaid")?.addEventListener("click", ()=>window.openCaseModal("paid"));
// (disabled: duplicate bindings handled by CaseModal module) $("#btnCaseModalClose")?.addEventListener("click", closeCaseModal);
// (disabled: duplicate bindings handled by CaseModal module) $("#caseOpenBack")?.addEventListener("click", closeCaseModal);

// hooks
// (disabled: duplicate bindings handled by CaseModal module) window.addEventListener("keydown", (e)=>{
  if(false && e.key === "Escape"){
    if(!caseSpinning) closeCaseModal();
    closeCasePrizes();
  }
});

// --- sounds + helpers for reel tick (CS-like) ---
const caseAudio = (()=>{
  let ctx = null;
  const ensure = () => {
    if(ctx) return;
    try{ ctx = new (window.AudioContext || window.webkitAudioContext)(); }catch(_e){ ctx = null; }
  };
  const _beep = (freq, durMs, gain=0.08) => {
    if(!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = freq;
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.02, durMs/1000));
    o.connect(g); g.connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + Math.max(0.03, durMs/1000));
  };
  const tick = () => { ensure(); _beep(1850, 28, 0.08); };
  const open = () => { ensure(); _beep(520, 120, 0.14); setTimeout(()=>_beep(760, 90, 0.10), 70); };
  return { ensure, tick, open };
})();

function _getTranslateX(el){
  try{
    const tr = getComputedStyle(el).transform;
    if(!tr || tr === "none") return 0;
    const m = tr.match(/matrix\(([^)]+)\)/);
    if(m){
      const parts = m[1].split(",").map(x=>parseFloat(x.trim()));
      return parts[4] || 0;
    }
    const m3 = tr.match(/matrix3d\(([^)]+)\)/);
    if(m3){
      const parts = m3[1].split(",").map(x=>parseFloat(x.trim()));
      return parts[12] || 0;
    }
  }catch(_e){}
  return 0;
}

async function caseStatus(){
  const st = await apiGet("/api/case/status").catch(()=>null);
  if(!st || !st.ok){ return null; }
  const hint = $("#caseHint");
  const freeTxt = st.ready
    ? "Бесплатный: доступен"
    : ("Бесплатный КД до: " + (st.next_at ? new Date(st.next_at).toLocaleString() : "—"));
  const paidTxt = `Платный: без КД (${CASE_PAID_PRICE}₽)`;
  if(hint){
    hint.textContent = (caseMode === "paid") ? `${paidTxt} • ${freeTxt}` : freeTxt;
  }
  return st;
}

function caseSpinTo(prizeKey, durationMs=5200){
  const reel = $("#caseReel");
  const vp = reel?.parentElement;
  if(!reel || !vp) return { durationMs: 0 };

  reel.querySelectorAll(".casePrize.win").forEach(x=>x.classList.remove("win"));

  const cards = Array.from(reel.querySelectorAll(".casePrize"));
  const idxs = cards.map((c,i)=>c.dataset.prize===prizeKey?i:-1).filter(i=>i>=0);
  const pick = idxs.filter(i=>i>12);
  const idx = (pick.length ? pick[Math.floor(Math.random()*pick.length)] : (idxs[0] ?? 0));
  const card = cards[idx];

  const gap = parseFloat(getComputedStyle(reel).gap || "0") || 0;
  const step = (card?.offsetWidth || 180) + gap;

  const targetLeft = card.offsetLeft;
  const target = targetLeft - (vp.clientWidth/2 - card.offsetWidth/2);

  reel.style.transition = "none";
  reel.style.transform = `translateX(0px)`;
  void reel.offsetWidth;

  let lastIdx = -1;
  const tickTimer = setInterval(()=>{
    const x = _getTranslateX(reel);
    const center = (-x) + (vp.clientWidth/2);
    const i = Math.floor(center / step);
    if(i !== lastIdx){
      lastIdx = i;
      caseAudio.tick();
    }
  }, 28);

  requestAnimationFrame(()=>{
    reel.style.transition = `transform ${durationMs}ms cubic-bezier(.07,.85,.12,1)`;
    reel.style.transform = `translateX(${-Math.max(0, target)}px)`;
  });

  setTimeout(()=>{
    clearInterval(tickTimer);
    caseAudio.open();
    card.classList.add("win");
  }, Math.max(0, durationMs - 60));

  return { durationMs };
}

async function _caseGetCaptcha(){
  try{
    const ch = await apiGet("/api/case/challenge");
    caseToken = ch.token || "";
    toast("Кейс", `Капча: ${ch.a} + ${ch.b} = ?`, "inf");
    $("#caseResult") && ($("#caseResult").textContent = "Капча получена — введи ответ и крути 🎰");
  }catch(e){
    toast("Кейс", e.message || "Ошибка", "bad");
  }
}

// Support BOTH ids (old/new) so redesign doesn't break behavior.
// (disabled: duplicate bindings handled by CaseModal module) $("#btnCaseChallenge")?.addEventListener("click", _caseGetCaptcha);
// (disabled: duplicate bindings handled by CaseModal module) $("#btnCaseGetCaptcha")?.addEventListener("click", _caseGetCaptcha);

async function _caseOpenFree(){
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
    _setCaseLocked(true);
    const resBox = $("#caseResult");
    if(resBox) resBox.textContent = "Крутим…";

    const r = await apiPost("/api/case/open", { token: caseToken, answer });
    caseToken = "";

    caseAudio.ensure();
    const spin = caseSpinTo(r.prize);

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
      if(resBox) resBox.textContent = "Приз добавлен в инвентарь: " + (map[r.prize] || r.prize);
      toast("Кейс", "Приз в инвентаре: " + (map[r.prize] || r.prize), "ok");
      caseSpinning = false;
      _setCaseLocked(false);
      await refreshMe();
      await caseStatus().catch(()=>{});
    }, (spin.durationMs || 5200));

  }catch(e){
    caseSpinning = false;
    _setCaseLocked(false);
    toast("Кейс", e.message || "Ошибка", "bad");
  }
}

// Support BOTH ids (old/new)
// (disabled: duplicate bindings handled by CaseModal module) $("#btnCaseOpen")?.addEventListener("click", _caseOpenFree);
// (disabled: duplicate bindings handled by CaseModal module) $("#btnCaseOpenFree")?.addEventListener("click", _caseOpenFree);

// NOTE: paid-open handler is implemented in the CaseModal module below.
// The block that used to be here was partially commented and broke JS parsing.


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




/* -------------------------
   Transactions modal
--------------------------*/
function openTxModal(){
  const m = $("#txModal");
  if(!m) { toast("История транзакций скоро будет доступна"); return; }
  m.classList.add("open");
  m.setAttribute("aria-hidden","false");
  // lazy load
  txRefresh().catch(()=>{});
}
function closeTxModal(){
  const m = $("#txModal");
  if(!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden","true");
}
async function txRefresh(){
  const box = $("#txList");
  if(!box) return;
  if(!currentUser){ box.innerHTML = '<div class="muted">Нужно войти в аккаунт.</div>'; return; }

  box.innerHTML = '<div class="muted">Загрузка…</div>';
  try{
    const j = await apiGet('/api/tx');
    const items = (j.tx||[]);
    if(!items.length){ box.innerHTML = '<div class="muted">Транзакций пока нет.</div>'; return; }

    box.innerHTML = items.map(it=>{
      const t = it.ts ? new Date(it.ts).toLocaleString() : '';
      const delta = Number(it.delta||0);
      const sign = delta >= 0 ? '+' : '';
      const amt = sign + String(delta) + ' ₽';
      const reason = esc(String(it.reason||''));
      const who = (it.admin_id ? 'admin' : 'system');
      return `<div class="txRow">
        <div class="txMain">
          <div class="txTitle">${reason || 'Операция'}</div>
          <div class="txMeta">${t} • ${who}</div>
        </div>
        <div class="txAmt ${delta>=0?'pos':'neg'}">${amt}</div>
      </div>`;
    }).join('');
  }catch(e){
    box.innerHTML = '<div class="muted">Не удалось загрузить транзакции.</div>';
  }
}

async function templatesRefresh(){
  const box = $("#templatesList");
  if(!box) return;
  if(!currentUser){ box.innerHTML = '<div class="muted">Нужно войти в аккаунт.</div>'; return; }
  box.innerHTML = '<div class="muted">Загрузка…</div>';
  try{
    const j = await apiGet('/api/templates');
    const items = (j.items||[]);
    if(!items.length){ box.innerHTML = '<div class="muted">Сохранённых шаблонов пока нет.</div>'; return; }
    box.innerHTML = items.map(it=>{
      const t = it.created_at ? new Date(it.created_at).toLocaleString() : '';
      return `<div class="tplRow">
        <div class="tplMain">
          <div class="tplTitle">${escapeHtml(it.title||'Шаблон')}</div>
          <div class="tplMeta muted">${escapeHtml(t)}</div>
        </div>
        <button class="btn mini" data-tpl-id="${escapeHtml(String(it.id||''))}" type="button">Открыть</button>
      </div>`;
    }).join('');
    // open handler
    box.querySelectorAll('button[data-tpl-id]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const id = b.getAttribute('data-tpl-id');
        toast('Открытие шаблона: '+id);
      });
    });
  }catch(_e){
    box.innerHTML = '<div class="muted">Не удалось загрузить шаблоны.</div>';
  }
}

/* -------------------------
   Click delegation (safety)
--------------------------*/
document.addEventListener('click', (e)=>{
  const t = e.target;
  if(!t) return;
  if(t.closest && t.closest('#btnSettings')){ try{ openSettingsModal(); }catch(_e){} }
  if(t.closest && t.closest('#btnShopPanel')){ try{ openShopPanelModal(); }catch(_e){} }
  if(t.closest && t.closest('#btnShowTx')){ try{ openTxModal(); }catch(_e){} }
  if(t.closest && t.closest('#btnShowSavedTemplates')){ try{ openSavedTemplates(); }catch(_e){} }
  if(t.closest && t.closest('#btnTxRefresh')){ try{ txRefresh(); }catch(_e){} }
  if(t.closest && t.closest('#btnTxClose')){ try{ closeTxModal(); }catch(_e){} }
  if(t.closest && t.closest('#btnTemplatesClose')){ try{ closeSavedTemplates(); }catch(_e){} }
}, true);

/* -------------------------
   Templates modal
--------------------------*/
function openSavedTemplates(){
  const m = $("#templatesModal");
  if(!m){ toast("Шаблоны скоро будут доступны"); return; }
  m.classList.add("open");
  m.setAttribute("aria-hidden","false");
  templatesRefresh().catch(()=>{});
}
function closeSavedTemplates(){
  const m = $("#templatesModal");
  if(!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden","true");
}
async function templatesRefresh(){
  const box = $("#templatesList");
  if(!box) return;
  if(!currentUser){ box.innerHTML = '<div class="muted">Нужно войти в аккаунт.</div>'; return; }
  box.innerHTML = '<div class="muted">Загрузка…</div>';
  try{
    const j = await apiGet('/api/templates');
    const items = (j.items||j.templates||[]);
    if(!items.length){ box.innerHTML = '<div class="muted">Пока нет сохранённых шаблонов.</div>'; return; }
    box.innerHTML = items.map((it)=>{
      const t = it.ts ? new Date(it.ts).toLocaleString() : '';
      const title = esc(it.title||it.name||'Шаблон');
      const body = esc(it.body||it.text||'');
      return `<div class="tplRow">
        <div class="tplHead">
          <div class="tplTitle">${title}</div>
          <div class="tplMeta">${t}</div>
        </div>
        <div class="tplBody">${body}</div>
        <div class="tplBtns">
          <button class="btn mini" type="button" data-tplcopy="${encodeURIComponent(body)}">Копировать</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-tplcopy]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const txt = decodeURIComponent(b.getAttribute('data-tplcopy')||'');
        try{ navigator.clipboard.writeText(txt); toast('Шаблоны','Скопировано','ok'); }catch(e){ toast('Шаблоны','Не удалось скопировать','bad'); }
      });
    });
  }catch(e){
    box.innerHTML = '<div class="muted">Не удалось загрузить.</div>';
  }
}


/* -------------------------
   Settings modal
--------------------------*/
function openSettingsModal(){
  const m = $("#settingsModal");
  if(!m) return;
  m.classList.add("open");
  m.setAttribute("aria-hidden","false");
  // mount appearance card into modal
  const mount = $("#settingsAppearanceMount");
  const themeBox = $("#themeBox");
  if(mount && themeBox && !mount.contains(themeBox)){
    mount.appendChild(themeBox);
    themeBox.style.display = "block";
  }
  syncSettingsUI();
}
function closeSettingsModal(){
  const m = $("#settingsModal");
  if(!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden","true");
}
function syncSettingsUI(){
  const b = $("#twofaStateBadge");
  if(!b) return;
  const enabled = !!(currentUser && Number(currentUser.twofa_email_enabled||0)===1);
  b.textContent = enabled ? "ON" : "OFF";
  b.style.opacity = enabled ? "1" : ".8";
  const b2 = $("#twofaStateBadge");
  if(b2) b2.textContent = enabled ? "ON" : "OFF";
}

/* -------------------------
   Shop config (public) + admin builder
--------------------------*/
let _shopCfgCache = null;

async function loadAndApplyShopConfig(){
  try{
    const j = await apiGet("/api/shop_config");
    _shopCfgCache = j.config || null;
    applyShopConfig(_shopCfgCache);
  }catch(_e){}
}

function applyShopConfig(cfg){
  if(!cfg) return;
  // v2: categories + custom items
  const norm = normalizeShopCfg(cfg);
  _shopCfgCache = norm;
  renderShopFromCfg(norm);
}

function normalizeShopCfg(cfg){
  const out = (cfg && typeof cfg === 'object') ? JSON.parse(JSON.stringify(cfg)) : {};
  out.v = 2;
  out.items = out.items && typeof out.items==='object' ? out.items : {};
  // legacy order -> default category
  if(!Array.isArray(out.categories) || !out.categories.length){
    const legacyOrder = Array.isArray(out.order) ? out.order.slice() : [];
    const base = legacyOrder.length ? legacyOrder : ["prodTopup","prodPremium","prodCaseFree","prodCasePaid"].filter(id=>document.getElementById(id));
    out.categories = [{ id:"main", title:"Основное", order: base }];
  }else{
    out.categories = out.categories.map((c,i)=>({
      id: String(c.id||`cat_${i}`),
      title: String(c.title||"Категория"),
      order: Array.isArray(c.order)? c.order.map(String): []
    }));
  }
  // ensure every referenced item exists
  out.categories.forEach(cat=>{
    cat.order.forEach(id=>{ if(!out.items[id]) out.items[id] = {}; });
  });
  // add defaults for known static cards
  const def = _defaultShopCfg();
  Object.entries(def.items||{}).forEach(([id, it])=>{
    out.items[id] = Object.assign({}, it, out.items[id]||{});
  });
  // editor prefs
  out.editor = out.editor && typeof out.editor==='object' ? out.editor : {};
  return out;
}

let _shopActiveCat = "main";
let _shopEditorEnabled = false;
let _shopEditorMode = "builder";

function ensureShopInjected(){
  const tab = document.getElementById('tab-shop');
  if(!tab) return;
  if(document.getElementById('shopCatsBar')) return;
  const card = tab.querySelector('.card');
  if(!card) return;

  // category bar
  const cats = document.createElement('div');
  cats.id = 'shopCatsBar';
  cats.className = 'shopCatsBar';
  cats.innerHTML = `
    <div class="shopCatsLeft" id="shopCatsLeft"></div>
    <div class="shopCatsRight" id="shopCatsRight" style="display:none">
      <button class="btn mini" id="btnShopEdGrid" type="button">Сетка</button>
      <button class="btn mini" id="btnShopEdAddCat" type="button">+ Раздел</button>
      <button class="btn mini" id="btnShopEdAddItem" type="button">+ Товар</button>
      <button class="btn primary mini" id="btnShopEdSave" type="button">Сохранить</button>
      <button class="btn mini" id="btnShopEdExit" type="button">Выход</button>
    </div>
  `;
  card.insertBefore(cats, card.querySelector('.shopControls'));

  // editor panel
  const panel = document.createElement('div');
  panel.id = 'shopEditorPanel';
  panel.className = 'shopEditorPanel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="shopEdHead">
      <div class="shopEdTitle">Конструктор магазина</div>
      <div class="muted" style="font-size:12px">Перетаскивай карточки, редактируй поля, загружай баннеры — потом жми “Сохранить”.</div>
    </div>
    <div class="shopEdBody">
      <div class="shopEdCol">
        <div class="shopEdBlock">
          <div class="lbl" style="margin-bottom:8px">Разделы</div>
          <div id="shopEdCats"></div>
        </div>
        <div class="shopEdBlock" style="margin-top:12px">
          <div class="lbl" style="margin-bottom:8px">Товары в разделе</div>
          <div id="shopEdItems"></div>
        </div>
      </div>
      <div class="shopEdCol">
        <div class="shopEdBlock">
          <div class="lbl" style="margin-bottom:8px">Редактор товара</div>
          <div id="shopEdForm" class="muted" style="font-size:12px">Выбери товар слева.</div>
        </div>
      </div>
    </div>
  `;
  card.appendChild(panel);
  // overlay tools removed

  // events
  document.getElementById('btnShopEdGrid')?.addEventListener('click', ()=>{
    document.body.classList.toggle('shopGridOn');
  });
  document.getElementById('btnShopEdAddCat')?.addEventListener('click', ()=>shopEdAddCategory());
  document.getElementById('btnShopEdAddItem')?.addEventListener('click', ()=>shopEdAddItem());
  document.getElementById('btnShopEdSave')?.addEventListener('click', ()=>shopEdSave());
  document.getElementById('btnShopEdExit')?.addEventListener('click', ()=>shopEdExit());
}

function renderShopFromCfg(cfg){
  _shopCfgCache = cfg;
  ensureShopInjected();
  const catsLeft = document.getElementById('shopCatsLeft');
  if(!catsLeft) return;
  catsLeft.innerHTML = '';
  cfg.categories.forEach(cat=>{
    const b = document.createElement('button');
    b.className = 'pillbtn' + (cat.id===_shopActiveCat ? ' active':'' );
    b.type='button';
    b.textContent = cat.title;
    b.addEventListener('click', ()=>{ _shopActiveCat = cat.id; writeLS('shop_cat', _shopActiveCat); renderShopFromCfg(cfg); });
    catsLeft.appendChild(b);
  });
  const saved = readLS('shop_cat', _shopActiveCat);
  if(saved && cfg.categories.some(c=>c.id===saved)) _shopActiveCat = saved;

  const cat = cfg.categories.find(c=>c.id===_shopActiveCat) || cfg.categories[0];
  if(cat) _shopActiveCat = cat.id;

  // rebuild grid for category
  const grid = document.getElementById('shopGrid');
  if(!grid) return;

  // Keep existing static cards detached safely
  const allKnownIds = new Set();
  cfg.categories.forEach(c=>c.order.forEach(id=>allKnownIds.add(id)));
  // remove custom cards not in active cat
  Array.from(grid.querySelectorAll('.productCard')).forEach(el=>{
    // we'll append active ones after
  });

  // append cards for active cat
  grid.innerHTML = '';
  (cat.order||[]).forEach(id=>{
    const it = cfg.items[id] || (cfg.items[id] = {});
    const card = ensureShopCard(id, it);
    if(!card) return;
    if(it.hidden) card.style.display='none'; else card.style.display='';
    applyItemToCard(card, it);
    // enable drag in editor
    if(_shopEditorEnabled){
      card.setAttribute('draggable','true');
      card.classList.add('shopDraggable');
      card.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/plain', id); card.classList.add('dragging'); });
      card.addEventListener('dragend', ()=>{ card.classList.remove('dragging'); });
      card.addEventListener('dragover', (e)=>{ e.preventDefault(); });
      card.addEventListener('drop', (e)=>{
        e.preventDefault();
        const from = e.dataTransfer.getData('text/plain');
        const to = id;
        if(!from || from===to) return;
        const a = cat.order.indexOf(from);
        const b = cat.order.indexOf(to);
        if(a<0||b<0) return;
        cat.order.splice(a,1);
        cat.order.splice(b,0,from);
        renderShopFromCfg(cfg);
        shopEdRenderLists();
      });
    }else{
      card.removeAttribute('draggable');
      card.classList.remove('shopDraggable');
    }
    grid.appendChild(card);
  });

  // update editor toggle UI
  const right = document.getElementById('shopCatsRight');
  if(right) right.style.display = (_shopEditorEnabled ? 'flex':'none');
  const panel = document.getElementById('shopEditorPanel');
  if(panel) panel.style.display = (_shopEditorEnabled ? 'block':'none');
  if(_shopEditorEnabled){
    shopEdRenderLists();
  }

  // re-init tilt on new cards
  try{ initTilt(); }catch(_e){}

  // delegated click handler (keeps working after rerender)
  if(!_shopEditorEnabled){
    const g = document.getElementById('shopGrid');
    if(g && !g.dataset.shopDelegatedClick){
      g.dataset.shopDelegatedClick = '1';
      g.addEventListener('click', (e)=>{
        const btn = e.target.closest('button');
        const card = e.target.closest('.productCard');
        if(!card) return;
        // ignore clicks on editor controls
        if(_shopEditorEnabled) return;
        // allow click either on button or on card body
        if(btn || card){
          const id = card.dataset.prod || card.id;
          const it = (_shopCfgCache && _shopCfgCache.items && _shopCfgCache.items[id]) ? _shopCfgCache.items[id] : null;
          if(!it) return;
          handleShopItemAction(it);
        }
      });
    }
  }
}



function ensureShopCard(id, it){
  let el = document.getElementById(id);
  if(el) return el;
  // create custom product card
  el = document.createElement('div');
  el.id = id;
  el.className = 'productCard tilt pxtCard';
  el.dataset.prod = id;
  const btnText = esc(it.btnText || 'Открыть');
  const hintText = esc(it.startingAt || 'Starting at');
  el.innerHTML = `
    <div class="prodMedia">
      <img class="prodMediaArt" alt="" loading="lazy" style="display:none"/>
      <div class="prodMediaGlow"></div>
    </div>
    <div class="prodBody">
      <div class="prodHead">
        <div class="prodTitle">${esc(it.title||'Товар')}</div>
        <div class="prodTag">${esc(it.tag||'NEW')}</div>
      </div>
      <div class="prodDesc">${esc(it.desc||'Описание товара')}</div>
      <div class="prodFooter">
        <button class="btn pxtBtn prodBtn" type="button"><span class="ico" data-ico="cart" aria-hidden="true"></span> <span class="prodBtnText">${btnText}</span></button>
        <div class="prodPrice">
          <div class="priceHint"><span class="priceHintText">${hintText}</span></div>
          <div class="priceMain">${esc(it.price||'—')}</div>
        </div>
      </div>
    </div>
  `;
  return el;
}





function normBannerUrl(url){
  if(!url) return '';
  let u=String(url).trim();
  if(!u) return '';
  if(u.startsWith('http://')||u.startsWith('https://')||u.startsWith('data:')) return u;
  if(u.startsWith('/')) return encodeURI(u);
  // allow "static/"
  if(u.startsWith('static/')) return encodeURI('/'+u);
  // plain filename -> /static/banners/
  return encodeURI('/static/banners/'+u);
}




function inferShopAction(it){
  const tag=(it.tag||'').toLowerCase();
  const title=(it.title||'').toLowerCase();
  if(tag.includes('free') || title.includes('кейс') && tag.includes('free')) return 'case_free';
  if(tag.includes('paid') || title.includes('кейс') && tag.includes('paid')) return 'case_paid';
  if(tag.includes('robux') || title.includes('robux') || title.includes('робук') || tag.includes('робук')) return 'robux';
  return '';
}

function handleShopItemAction(it){
  if(!it) return;
  const isAdmin = !!(_me && _me.is_admin);
  if(it.testOnly && !isAdmin){
    toast('Магазин', 'Этот товар отмечен как тестовый (визуальный).', 'warn');
    return;
  }
  const act = (it.action || inferShopAction(it) || '').toLowerCase();
  if(act==='case_free') return window.openCaseModal('free');
  if(act==='case_paid') return window.openCaseModal('paid');
  if(act==='robux') return openRobuxModal();
  if(act==='premium') return openPayModal('premium');
  if(act==='topup') return openPayModal('topup');
  if(act==='link'){
    if(it.linkUrl){
      try{ window.open(it.linkUrl, '_blank', 'noopener'); }catch(_e){}
      return;
    }
    return toast('Магазин', 'Не указана ссылка', 'warn');
  }
  toast('Магазин', 'Для этого товара не выбрано действие.', 'warn');
}

// ----------------------------
// Robux purchase wizard (5 steps)
// ----------------------------
let _robuxState = {
  step:1,
  amount:50,
  quote:null,
  gamepass:null,
  order_id:null,
  reserve_expires_ts:0,
  pollT:null,
  quoteT:null,
  quoteCache:new Map(),
  gpMode:'url',
};

function _robuxById(id){ return document.getElementById(id); }


function _robuxPrefersReduced(){
  try{ return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(_e){ return false; }
}

function _robuxSwapPane(prev, next){
  if(_robuxState._swapT){ clearTimeout(_robuxState._swapT); _robuxState._swapT=null; }
  const prevPane = _robuxById('robuxStep'+prev);
  const nextPane = _robuxById('robuxStep'+next);
  if(!nextPane) return;

  // Make sure all panes exist and are in a consistent state.
  for(let i=1;i<=5;i++){
    const p = _robuxById('robuxStep'+i);
    if(!p) continue;
    if(i === next){
      p.classList.add('is-active');
      p.classList.remove('is-leaving');
    }else if(i === prev){
      p.classList.remove('is-active');
      p.classList.add('is-leaving');
    }else{
      p.classList.remove('is-active','is-leaving');
    }
  }

  // Cleanup leaving pane after transition (no display:none to avoid choppy animations)
  if(prevPane && prevPane !== nextPane){
    const done = (e)=>{
      // transitionend fires for each property; cleanup only once at the end
      if(e && e.propertyName && e.propertyName !== 'transform') return;
      prevPane.classList.remove('is-leaving');
      prevPane.removeEventListener('transitionend', done);
    };
    prevPane.addEventListener('transitionend', done);
    setTimeout(()=>done({propertyName:'transform'}), 320);
  }
}

function _robuxSetStep(step){
  const prev = _robuxState.step;
  _robuxState.step = step;

  const steps = _robuxById('robuxSteps');
  if(steps){
    [...steps.querySelectorAll('.robuxStep')].forEach(s=>s.classList.toggle('active', (s.dataset.step===String(step))));
  }

  // keep CSS-driven animation; avoid hard display:none swaps mid-transition
  if(prev!==step) _robuxSwapPane(prev, step);
}


function _robuxOpenUI(){
  const back=_robuxById('robuxBack');
  const m=_robuxById('robuxModal');
  if(back){ back.classList.remove('hidden'); back.style.display='block'; back.classList.add('open'); requestAnimationFrame(()=>back.classList.add('vis')); }
  if(m){ m.classList.remove('hidden'); m.style.display='block'; m.classList.add('open'); requestAnimationFrame(()=>m.classList.add('vis')); }
}

function _robuxCloseUI(){
  const back=_robuxById('robuxBack');
  const m=_robuxById('robuxModal');
  try{ if(_robuxState.pollT) clearInterval(_robuxState.pollT); }catch(_e){}
  _robuxState.pollT = null;
  if(!m) return;
  m.classList.remove('vis');
  if(back) back.classList.remove('vis');
  setTimeout(()=>{
    m.classList.remove('open');
    m.style.display='none';
    m.classList.add('hidden');
    if(back){ back.classList.remove('open'); back.style.display='none'; back.classList.add('hidden'); }
  }, 190);
}

function _robuxFmtTs(sec){
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s/60)).padStart(2,'0');
  const ss = String(s%60).padStart(2,'0');
  return `${mm}:${ss}`;
}

async function _robuxUpdateQuote(amount){
  const amt = parseInt(String(amount||'').replace(/[^\d]/g,''), 10);
  if(!amt || amt<1){
    _robuxState.quote = null;
    const rub=_robuxById('robuxRub');
    const gp=_robuxById('robuxGp');
    const need=_robuxById('robuxGpNeed');
    if(rub) rub.textContent = '—';
    if(gp) gp.textContent = '—';
    if(need) need.textContent = '—';
    return;
  }
  const key = String(amt);
  if(_robuxState.quoteCache.has(key)){
    const j = _robuxState.quoteCache.get(key);
    _applyRobuxQuote(j);
    return;
  }
  try{
    const j = await apiGet(`/api/robux/quote?amount=${encodeURIComponent(amt)}`);
    _robuxState.quoteCache.set(key, j);
    _applyRobuxQuote(j);
  }catch(e){
    toast('Robux', e.message||'Не удалось рассчитать цену', 'bad');
  }
}

function _applyRobuxQuote(j){
  _robuxState.quote = { robux:j.robux, rub_price:j.rub_price, gamepass_price:j.gamepass_price, stock_show:j.stock_show||0 };
  const rub=_robuxById('robuxRub');
  const gp=_robuxById('robuxGp');
  const need=_robuxById('robuxGpNeed');
  const howNeed=_robuxById('robuxHowNeed');
  const stock=_robuxById('robuxStock');
  if(rub) rub.textContent = `${_robuxState.quote.rub_price}₽`;
  if(gp) gp.textContent = `${_robuxState.quote.gamepass_price} R$`;
  if(need) need.textContent = `${_robuxState.quote.gamepass_price} Robux`;
  if(howNeed) howNeed.textContent = String(_robuxState.quote.gamepass_price||'');
  if(stock){
    const v = parseInt(_robuxState.quote.stock_show||0,10);
    stock.textContent = v>0 ? `В наличии: ${v} R$` : '';
  }
}

function _robuxScheduleQuote(amount){
  try{ if(_robuxState.quoteT) clearTimeout(_robuxState.quoteT); }catch(_e){}
  _robuxState.quoteT = setTimeout(()=>_robuxUpdateQuote(amount), 220);
}


async function _robuxInspectGamepass(opts){
  const url = (opts && opts.url) ? String(opts.url).trim() : '';
  const username = (opts && opts.username) ? String(opts.username).trim() : '';
  let mode = (opts && opts.mode) ? String(opts.mode).trim() : '';
  // Always send a mode; this prevents server-side "распознать ссылку" errors
  // when the user is actually searching by username.
  if(!mode) mode = (_robuxState.gpMode || (username ? 'username' : 'url'));
  mode = (mode === 'nick') ? 'username' : mode;

  const payload = { amount: _robuxState.amount, mode };
  if(mode === 'username'){
    if(username) payload.username = username;
  }else{
    if(url) payload.url = url;
  }

  const j = await apiPost('/api/robux/inspect', payload);
  _robuxState.gamepass = j.gamepass;

  // Render card
  const gp = _robuxState.gamepass || {};
  const card = _robuxById('robuxCheckCard');
  if(card){
    const hint = (j.mode === 'username') ? '<div class="muted" style="font-size:12px;margin-bottom:6px">Найдено по нику</div>' : '';
    card.innerHTML = `
      ${hint}
      <div style="font-weight:800">${escapeHtml(gp.name || '—')}</div>
      <div class="muted" style="margin-top:6px;font-size:12px">ID: ${escapeHtml(String(gp.gamepass_id || '—'))} • Цена: ${escapeHtml(String(gp.price || 0))} R$</div>
      <div class="muted" style="margin-top:4px;font-size:12px">Создатель: ${escapeHtml(gp.owner || '—')} (ID: ${escapeHtml(String(gp.owner_id || 0))})</div>
    `;
  }

  // If found by username, keep ID in the URL input for the next step
  const urlEl = _robuxById('robuxGpUrl');
  if(urlEl && gp && gp.gamepass_id) urlEl.value = String(gp.gamepass_id);
  return j;
}

function _robuxUpdateReserveUI(){
  const t = _robuxById('robuxTimer');
  if(!t) return;
  const now = Math.floor(Date.now()/1000);
  const left = (_robuxState.reserve_expires_ts||0) - now;
  if(left<=0){
    t.textContent = 'Бронь истекла';
    return;
  }
  t.textContent = `Бронь: ${_robuxFmtTs(left)}`;
}

function _robuxUpdateSettleUI(done_ts){
  const t = _robuxById('robuxSettleTimer');
  if(!t) return;
  const now = Math.floor(Date.now()/1000);
  const settle = (parseInt(done_ts||0,10) || now) + (5*24*60*60);
  const left = settle - now;
  if(left<=0){
    t.textContent = 'Зачисление: скоро';
    return;
  }
  const days = Math.floor(left/86400);
  const rem = left - days*86400;
  const hh = String(Math.floor(rem/3600)).padStart(2,'0');
  const mm = String(Math.floor((rem%3600)/60)).padStart(2,'0');
  const ss = String(rem%60).padStart(2,'0');
  t.textContent = `Зачисление через: ${days}д ${hh}:${mm}:${ss}`;
}

async function _robuxPollOrder(){
  if(!_robuxState.order_id) return;
  try{
    const j = await apiGet(`/api/robux/order?id=${encodeURIComponent(_robuxState.order_id)}`);
    const o = j.order;
    const st = (o.status||'');
    const statusEl = _robuxById('robuxStatus');
    if(statusEl){
      if(st==='reserved') statusEl.textContent = 'Бронь активна. Можешь оплатить сейчас или позже.';
      else if(st==='processing' || st==='paid') statusEl.textContent = 'Оплата принята. Покупаем геймпасс…';
      else if(st==='done') statusEl.textContent = 'Robux успешно отправлены ✅';
      else if(st==='failed') statusEl.textContent = `Ошибка: ${o.error||'неизвестно'}`;
      else if(st==='expired') statusEl.textContent = 'Бронь истекла. Деньги возвращены.';
      else if(st==='cancelled') statusEl.textContent = 'Заказ отменён. Деньги возвращены.';
      else statusEl.textContent = st;
    }
    _robuxState.reserve_expires_ts = parseInt(o.reserve_expires_ts||0,10) || 0;
    if(st==='reserved') _robuxUpdateReserveUI();
    if(st==='done'){
      localStorage.removeItem('robux_active_order');
      _robuxSetStep(5);
      _robuxUpdateSettleUI(o.done_ts||0);
    }
    if(st==='failed' || st==='expired' || st==='cancelled'){
      localStorage.removeItem('robux_active_order');
    }
  }catch(_e){
    // ignore transient
  }
}

async function _robuxResumeIfAny(){
  const saved = localStorage.getItem('robux_active_order');
  if(!saved) return false;
  const oid = parseInt(saved,10);
  if(!oid) { localStorage.removeItem('robux_active_order'); return false; }
  try{
    const j = await apiGet(`/api/robux/order?id=${encodeURIComponent(oid)}`);
    const o = j.order;
    const st = (o.status||'');
    _robuxState.order_id = oid;
    _robuxState.reserve_expires_ts = parseInt(o.reserve_expires_ts||0,10) || 0;
    if(st==='reserved' || st==='processing' || st==='paid'){
      _robuxSetStep(4);
      _robuxPollOrder();
      _robuxState.pollT = setInterval(_robuxPollOrder, 1000);
      return true;
    }
    if(st==='done'){
      _robuxSetStep(5);
      _robuxUpdateSettleUI(o.done_ts||0);
      localStorage.removeItem('robux_active_order');
      return true;
    }
    localStorage.removeItem('robux_active_order');
    return false;
  }catch(_e){
    localStorage.removeItem('robux_active_order');
    return false;
  }
}

async function openRobuxModal(){
  _robuxOpenUI();
  _robuxState.order_id = null;
  _robuxState.gamepass = null;
  _robuxState.quote = null;
  _robuxState.reserve_expires_ts = 0;
  _robuxState.gpMode = 'url';
  _robuxSetStep(1);

  const amount = _robuxById('robuxAmount');
  const slider = _robuxById('robuxSlider');

  if(!_robuxState._bound){
    if(amount){
      amount.addEventListener('input', ()=>{
        const raw = String(amount.value||'');
        const digits = raw.replace(/[^\d]/g,'');
        // allow empty while typing
        if(raw!==digits) amount.value = digits;
        if(digits===''){ _robuxScheduleQuote(0); return; }
        _robuxState.amount = parseInt(digits,10) || 0;
        if(slider) slider.value = String(Math.max(50, Math.min(5000, _robuxState.amount)));
        _robuxScheduleQuote(_robuxState.amount);
      }, {passive:true});
      amount.addEventListener('blur', ()=>{
        let v = parseInt(String(amount.value||'').replace(/[^\d]/g,''),10) || 0;
        if(v<50) v = 50;
        if(v>5000) v = 5000;
        _robuxState.amount = v;
        amount.value = String(v);
        if(slider) slider.value = String(v);
        _robuxScheduleQuote(v);
      });
      amount.addEventListener('focus', ()=>{
        amount.select?.();
      });
    }

    if(slider){
      slider.addEventListener('input', ()=>{
        const v = parseInt(slider.value,10) || 50;
        _robuxState.amount = v;
        if(amount) amount.value = String(v);
        _robuxScheduleQuote(v);
      }, {passive:true});
    }

    _robuxState._bound = true;
  }

  // Mode tabs (url/id vs username)
  const modeUrlBtn = _robuxById('robuxModeUrl');
  const modeNickBtn = _robuxById('robuxModeNick');
  const boxUrl = _robuxById('robuxModeUrlBox');
  const boxNick = _robuxById('robuxModeNickBox');
  const urlEl = _robuxById('robuxGpUrl');
  const userEl = _robuxById('robuxUsername');

  function _robuxSetMode(mode){
    _robuxState.gpMode = mode;
    if(modeUrlBtn){ modeUrlBtn.classList.toggle('active', mode==='url'); modeUrlBtn.setAttribute('aria-selected', mode==='url' ? 'true' : 'false'); }
    if(modeNickBtn){ modeNickBtn.classList.toggle('active', mode==='username'); modeNickBtn.setAttribute('aria-selected', mode==='username' ? 'true' : 'false'); }
    if(boxUrl) boxUrl.classList.toggle('hidden', mode!=='url');
    if(boxNick) boxNick.classList.toggle('hidden', mode!=='username');
    // Clear the inactive input to avoid accidental backend path
    if(mode==='url' && userEl) userEl.value = '';
    if(mode==='username' && urlEl) urlEl.value = '';
    const nickTestBtn = _robuxById('robuxNickTest');
    if(nickTestBtn) nickTestBtn.style.display = (mode==='username') ? 'inline-flex' : 'none';
  }

  if(!_robuxState._modeBound){
    if(modeUrlBtn) modeUrlBtn.onclick=()=>_robuxSetMode('url');
    if(modeNickBtn) modeNickBtn.onclick=()=>_robuxSetMode('username');
    _robuxState._modeBound = true;

	// (legacy gpHowModal removed)
  }
  _robuxSetMode(_robuxState.gpMode || 'url');

  // How-to modal (placeholder for screenshots)
  const howBtn = _robuxById('robuxHowTo');
  const howBack = _robuxById('robuxHowBack');
  const howModal = _robuxById('robuxHowModal');
  const howClose = _robuxById('robuxHowClose');
  const howOk = _robuxById('robuxHowOk');
  const howNeed = _robuxById('robuxHowNeed');
  if(howNeed && _robuxState.quote && _robuxState.quote.gamepass_price) howNeed.textContent = String(_robuxState.quote.gamepass_price);

  function _howOpen(){
    if(howBack){ howBack.classList.remove('hidden'); howBack.style.display='block'; howBack.classList.add('open'); requestAnimationFrame(()=>howBack.classList.add('vis')); }
    if(howModal){ howModal.classList.remove('hidden'); howModal.style.display='block'; howModal.classList.add('open'); requestAnimationFrame(()=>howModal.classList.add('vis')); }
  }
  function _howClose(){
    if(!howModal) return;
    howModal.classList.remove('vis'); if(howBack) howBack.classList.remove('vis');
    setTimeout(()=>{
      howModal.classList.remove('open'); howModal.style.display='none'; howModal.classList.add('hidden');
      if(howBack){ howBack.classList.remove('open'); howBack.style.display='none'; howBack.classList.add('hidden'); }
    }, 190);
  }

  if(howBtn) howBtn.onclick=_howOpen;
  if(howClose) howClose.onclick=_howClose;
  if(howOk) howOk.onclick=_howClose;
  if(howBack) howBack.onclick=_howClose;

  // preload quote
  _robuxScheduleQuote(_robuxState.amount);

  const closeBtn=_robuxById('robuxClose');
  const back=_robuxById('robuxBack');
  if(closeBtn) closeBtn.onclick=_robuxCloseUI;
  if(back) back.onclick=_robuxCloseUI;

  // Step 1 -> 2
  const next1=_robuxById('robuxNext1');
  if(next1) next1.onclick=()=>_robuxSetStep(2);

  
// Step 2 inspect
const btnCheck=_robuxById('robuxNext2');
if(btnCheck){
  btnCheck.onclick=async ()=>{
	const rawUrl = (urlEl && urlEl.value) ? urlEl.value.trim() : '';
	const rawUser = (userEl && userEl.value) ? userEl.value.trim() : '';

	// Determine mode from the actual active tab (never rely only on stored state)
	let mode = 'url';
	try{
	  if(modeNickBtn && modeNickBtn.classList.contains('active')) mode = 'username';
	  else if(modeUrlBtn && modeUrlBtn.classList.contains('active')) mode = 'url';
	  else mode = (_robuxState.gpMode || 'url');
	}catch(_e){ mode = (_robuxState.gpMode || 'url'); }
	if(mode !== 'url' && mode !== 'username') mode = 'url';
	_robuxState.gpMode = mode;

// Helpful fallback message if user filled the other field
if(mode === 'url'){
  if(!rawUrl){
    if(rawUser) return toast('Robux','Выбран поиск по ссылке/ID — переключись на вкладку «По нику» или вставь ссылку/ID','warn');
    return toast('Robux','Вставь ссылку или ID геймпасса','warn');
  }
	}else{
	  // Normalize and validate Roblox username
	  // First apply Cyrillic -> Latin mapping for common look-alike characters
	  const cyrToLat = {"А":"A","В":"B","Е":"E","К":"K","М":"M","Н":"H","О":"O","Р":"P","С":"C","Т":"T","Х":"X","У":"U","а":"a","в":"b","е":"e","к":"k","м":"m","н":"h","о":"o","р":"p","с":"c","т":"t","х":"x","у":"u"};
	  let u = String(rawUser||'').replace(/^@/,'').replace(/\s+/g,'');
	  u = u.replace(/[АВЕКМНОРСТХУавекмнорстху]/g, ch => cyrToLat[ch] || ch);
	  if(!u){
    if(rawUrl) return toast('Robux','Выбран поиск по нику — переключись на вкладку «По ссылке / ID» или введи ник Roblox','warn');
    return toast('Robux','Введи ник Roblox (латиница, цифры и _)','warn');
  }
	  if(!/^[A-Za-z0-9_]{3,20}$/.test(u)){
	    return toast('Robux','Ник Roblox должен быть латиницей (A-Z, 0-9, _). Буквы Б, Г, Д, Ж, З, И, Й, Л, Ф, Ц, Ч, Ш, Щ, Ы, Э, Ю, Я — не конвертируются!','warn');
	  }
}

_robuxState.gamepass = null;
_robuxSetStep(3);
const card = _robuxById('robuxCheckCard');
if(card) card.innerHTML = '<div class="muted">Проверяем…</div>';

try{
	  const payload = { amount: _robuxState.amount, mode };
	  if(mode === 'username'){
	    // Apply same normalization as validation
	    const cyrToLat = {"А":"A","В":"B","Е":"E","К":"K","М":"M","Н":"H","О":"O","Р":"P","С":"C","Т":"T","Х":"X","У":"U","а":"a","в":"b","е":"e","к":"k","м":"m","н":"h","о":"o","р":"p","с":"c","т":"t","х":"x","у":"u"};
	    let normalizedUser = String(rawUser||'').replace(/^@/,'').replace(/\s+/g,'');
	    normalizedUser = normalizedUser.replace(/[АВЕКМНОРСТХУавекмнорстху]/g, ch => cyrToLat[ch] || ch);
	    payload.username = normalizedUser;
  }else{
    // accept url or id
    payload.gamepass_url = rawUrl;
  }
  const j = await apiPost('/api/robux/inspect', payload);
  _robuxState.gamepass = j.gamepass;

  const gp = _robuxState.gamepass || {};
  if(card){
    const hint = (mode === 'username') ? '<div class="muted" style="font-size:12px;margin-bottom:6px">Найдено по нику</div>' : '';
    card.innerHTML = `
      ${hint}
      <div style="font-weight:800">${escapeHtml(gp.name || '—')}</div>
      <div class="muted" style="margin-top:6px;font-size:12px">ID: ${escapeHtml(String(gp.gamepass_id || '—'))} • Владелец: ${escapeHtml(String(gp.owner_name || '—'))} • Цена: ${escapeHtml(String(gp.price || 0))} R$</div>
    `;
  }
  // proceed to reserve step
  _robuxSetStep(4);
  _robuxRenderPayStep();
}catch(e){
  if(card) card.innerHTML = '<div class="muted">Ошибка проверки.</div>';
  toast('Robux', e.message||'Ошибка проверки геймпасса', 'bad');
  // go back to step2 to retry
  _robuxSetStep(2);
}
};
}
const back2=_robuxById('robuxBack2');
  if(back2) back2.onclick=()=>_robuxSetStep(1);

  // Step 3 reserve
  const payBtn=_robuxById('robuxPay');
  const back3=_robuxById('robuxBack3');
  if(back3) back3.onclick=()=>_robuxSetStep(2);

  
if(payBtn){
  payBtn.onclick=async ()=>{
const rawUrl = (urlEl && urlEl.value) ? urlEl.value.trim() : '';
const rawUser = (userEl && userEl.value) ? userEl.value.trim() : '';

let mode = (_robuxState.gpMode || 'url');
if(mode !== 'url' && mode !== 'username') mode = 'url';

if(!_robuxState.quote) return toast('Robux','Сначала выбери количество Robux','bad');

// Prefer inspected gamepass id (already validated server-side)
const gpId = (_robuxState.gamepass && _robuxState.gamepass.gamepass_id) ? String(_robuxState.gamepass.gamepass_id) : '';
const gpRef = gpId || rawUrl;

if(mode==='url'){
  if(!gpRef) return toast('Robux','Нужна ссылка или ID геймпасса','bad');
}else{
  if(!rawUser) return toast('Robux','Нужен ник Roblox (латиница/цифры/_)','bad');
  if(!gpRef) return toast('Robux','Не удалось определить геймпасс — нажми «Проверить» ещё раз','bad');
}

try{
  payBtn.disabled = true;
  _robuxSetStep(4);
  const st = _robuxById('robuxStatus');
  if(st) st.textContent = 'Создаём бронь…';

  const payload = { amount:_robuxState.amount, mode, gamepass_url: gpRef };
  if(mode==='username') payload.username = rawUser;

  const j = await apiPost('/api/robux/order_reserve', payload);
  _robuxState.order_id = j.order_id;
  _robuxState.reserve_expires_ts = parseInt(j.reserve_expires_ts||0,10) || 0;
  localStorage.setItem('robux_active_order', String(_robuxState.order_id));
  _robuxUpdateReserveUI();
  _robuxPollOrder();
  try{ if(_robuxState.pollT) clearInterval(_robuxState.pollT); }catch(_e){}
  _robuxState.pollT = setInterval(_robuxPollOrder, 1000);
}catch(e){
  _robuxSetStep(3);
  toast('Robux', e.message||'Не удалось создать бронь', 'bad');
}finally{
  payBtn.disabled = false;
}
};
}

  // Step 4 buttons
  const cancelBtn=_robuxById('robuxCancel');
  const payNowBtn=_robuxById('robuxPayNow');
  const payLaterBtn=_robuxById('robuxPayLater');

  if(cancelBtn){
    cancelBtn.onclick=async ()=>{
      if(!_robuxState.order_id) return;
      try{
        cancelBtn.disabled = true;
        if(payNowBtn) payNowBtn.disabled = true;
        const j = await apiPost('/api/robux/order_cancel', { order_id:_robuxState.order_id });
        localStorage.removeItem('robux_active_order');
        _robuxPollOrder();
        toast('Robux','Заказ отменён', 'ok');
      }catch(e){
        toast('Robux', e.message||'Не удалось отменить', 'bad');
      }finally{
        cancelBtn.disabled = false;
        if(payNowBtn) payNowBtn.disabled = false;
      }
    };
  }

  if(payNowBtn){
    payNowBtn.onclick=async ()=>{
      if(!_robuxState.order_id) return;
      try{
        payNowBtn.disabled = true;
        if(cancelBtn) cancelBtn.disabled = true;
        const j = await apiPost('/api/robux/order_pay', { order_id:_robuxState.order_id });
        _robuxPollOrder();
      }catch(e){
        toast('Robux', e.message||'Не удалось оплатить', 'bad');
      }finally{
        payNowBtn.disabled = false;
        if(cancelBtn) cancelBtn.disabled = false;
      }
    };
  }

  if(payLaterBtn){
    payLaterBtn.onclick=()=>{
      // keep reservation, close UI
      _robuxCloseUI();
      toast('Robux','Ок. Заказ сохранён в истории (бронь 7 минут).', 'ok');
    };
  }

  // Step 5
  const finish=_robuxById('robuxFinish');
  if(finish) finish.onclick=_robuxCloseUI;

  // Resume active order if exists
  await _robuxResumeIfAny();
}

try{ window.openRobuxModal = openRobuxModal; }catch(_e){}

// ----------------------------
// Robux Nick Test modal (separate flow, strictly by username)
// ----------------------------
const _rnt = { open:false, lastInspect:null, orderId:null, poll:null };

function _rntById(id){ return document.getElementById(id); }

function _rntOpen(){
  if(!currentUser){
    toast("Robux","Сначала войди в аккаунт","warn");
    try{ showTab("profile"); }catch(_e){}
    return;
  }
  const back=_rntById("robuxNickBack");
  const m=_rntById("robuxNickModal");
  if(back){ back.classList.remove("hidden"); back.style.display="block"; back.classList.add("open"); requestAnimationFrame(()=>back.classList.add("vis")); }
  if(m){ m.classList.remove("hidden"); m.style.display="block"; m.classList.add("open"); requestAnimationFrame(()=>m.classList.add("vis")); }
  _rnt.open = true;

  // prefill from main wizard (if available)
  const uMain = _robuxById("robuxUsername")?.value || "";
  const amtMain = _robuxById("robuxAmount")?.value || _robuxState.amount || "50";
  const u=_rntById("rntUsername");
  const a=_rntById("rntAmount");
  if(u && !u.value) u.value = (uMain||"").trim();
  if(a) a.value = String(parseInt(String(amtMain).replace(/[^\d]/g,""),10) || 50);

  _rnt.lastInspect = null;
  _rnt.orderId = null;
  _rntSetStatus("—");
  _rntRenderCard(null);
  _rntUpdateQuote();
}

function _rntClose(){
  const back=_rntById("robuxNickBack");
  const m=_rntById("robuxNickModal");
  if(!m) return;
  m.classList.remove("vis"); if(back) back.classList.remove("vis");
  setTimeout(()=>{
    m.classList.remove("open"); m.style.display="none"; m.classList.add("hidden");
    if(back){ back.classList.remove("open"); back.style.display="none"; back.classList.add("hidden"); }
  }, 190);
  _rnt.open = false;
  try{ if(_rnt.poll) clearInterval(_rnt.poll); }catch(_e){}
  _rnt.poll = null;
}

function _rntSetStatus(t){
  const st=_rntById("rntStatus");
  if(st) st.textContent = t || "—";
}

// Normalize Roblox username: trim, remove spaces and convert common Cyrillic look-alikes.
// NOTE: we map Cyrillic "У" to Latin "U" (users usually mean U, not Y).
function _rntNormalizeUsername(raw){
  let u = String(raw || "").trim();
  if(u.startsWith("@")) u = u.slice(1);
  u = u.replace(/\s+/g, "");
  const map = {
    "А":"A","В":"B","Е":"E","К":"K","М":"M","Н":"H","О":"O","Р":"P","С":"C","Т":"T","Х":"X","У":"U",
    "а":"a","в":"b","е":"e","к":"k","м":"m","н":"h","о":"o","р":"p","с":"c","т":"t","х":"x","у":"u",
  };
  return u.replace(/[АВЕКМНОРСТХУавекмнорстху]/g, (ch)=>map[ch] || ch);
}

function _rntRenderCard(info){
  const card=_rntById("rntCard");
  if(!card) return;
  if(!info){
    card.innerHTML = `<div class="muted">Нажми «Проверить», чтобы найти геймпасс.</div>`;
    return;
  }
  const gp = info.gamepass || {};
  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start">
      <div style="min-width:0">
        <div style="font-weight:900; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${escapeHtml(gp.name || "Gamepass")}</div>
        <div class="muted" style="margin-top:4px">Owner: <b>${escapeHtml(gp.owner || "—")}</b></div>
        <div class="muted">URL: <span class="mono" style="opacity:.9">${escapeHtml(gp.url || "—")}</span></div>
      </div>
      <div class="mono" style="font-weight:900">${escapeHtml(String(gp.price ?? "—"))} R$</div>
    </div>
  `;
}

async function _rntUpdateQuote(){
  const a=_rntById("rntAmount");
  const v = parseInt(String(a?.value||"").replace(/[^\d]/g,""),10) || 50;
  if(a) a.value = String(v);
  try{
    const j = await apiGet(`/api/robux/quote?robux_amount=${encodeURIComponent(v)}`);
    const rub=_rntById("rntRub");
    const gp=_rntById("rntGp");
    if(rub) rub.textContent = (j.rub_total != null) ? (String(j.rub_total) + " ₽") : "—";
    if(gp) gp.textContent = (j.gamepass_price != null) ? (String(j.gamepass_price) + " R$") : "—";
  }catch(_e){}
}

async function _rntInspect(){
  const u=_rntById("rntUsername");
  const a=_rntById("rntAmount");
  const username = _rntNormalizeUsername(u?.value || "");
  const v = parseInt(String(a?.value||"").replace(/[^\d]/g,""),10) || 50;
  if(!username) return toast("Robux","Введи ник Roblox","warn");
  _rntSetStatus("Ищу профиль/плейсы/геймпассы…");
  try{
    // Backend expects `amount`. Keep `robux_amount` as legacy alias too.
    // Also explicitly clear any url fields so the server won't accidentally infer URL mode.
    const j = await apiPost("/api/robux/inspect", {
      mode: "username",
      username,
      nick: username,
      amount: v,
      robux_amount: v,
      url: "",
      gamepass_url: "",
    });
    _rnt.lastInspect = j;
    _rntRenderCard(j);
    _rntSetStatus("Готово. Можно покупать.");
    await _rntUpdateQuote();
  }catch(e){
    _rnt.lastInspect = null;
    _rntRenderCard(null);
    _rntSetStatus("Ошибка: " + (e.message || "bad request"));
    toast("Robux", e.message || "Плохой запрос", "bad");
  }
}

async function _rntBuy(){
  const u=_rntById("rntUsername");
  const a=_rntById("rntAmount");
  const username = _rntNormalizeUsername(u?.value || "");
  const v = parseInt(String(a?.value||"").replace(/[^\d]/g,""),10) || 50;
  if(!username) return toast("Robux","Введи ник Roblox","warn");

  _rntSetStatus("Создаю заказ…");
  try{
    const r = await apiPost("/api/robux/order_reserve", {
      // Backend expects `amount`; keep `robux_amount` as alias.
      amount: v,
      robux_amount: v,
      username,
      nick: username,
      url: "",
      gamepass_url: "",
    });
    const oid = r.order_id;
    if(!oid) throw new Error("Не вернулся order_id");
    _rnt.orderId = oid;

    _rntSetStatus("Оплачиваю…");
    await apiPost("/api/robux/order_pay", { order_id: oid });

    _rntSetStatus("Оплачено. Жду выполнение…");
    try{ if(_rnt.poll) clearInterval(_rnt.poll); }catch(_e){}
    _rnt.poll = setInterval(async ()=>{
      try{
        const j = await apiGet(`/api/robux/order?id=${encodeURIComponent(oid)}`);
        const st = j.order?.status || "";
        if(st === "done"){
          _rntSetStatus("✅ Выполнено");
          clearInterval(_rnt.poll); _rnt.poll=null;
        }else if(st === "failed" || st === "cancelled" || st === "expired"){
          const err = j.order?.error || "";
          _rntSetStatus("❌ " + (err || st));
          clearInterval(_rnt.poll); _rnt.poll=null;
        }else{
          _rntSetStatus("⏳ " + (st || "processing"));
        }
      }catch(_e){}
    }, 1200);

    toast("Robux","Заказ создан и оплачен","ok");
  }catch(e){
    _rntSetStatus("Ошибка: " + (e.message || "bad request"));
    toast("Robux", e.message || "Не удалось", "bad");
  }
}

// bind controls (safe)
(function(){
  const btn=_rntById("robuxNickTest");
  if(btn) btn.addEventListener("click", _rntOpen);

  const back=_rntById("robuxNickBack");
  const closeTop=_rntById("robuxNickCloseTop");
  const close=_rntById("rntClose");
  const close2=_rntById("rntClose");
  [back, closeTop, close].forEach(x=>x && x.addEventListener("click", _rntClose));

  const amt=_rntById("rntAmount");
  if(amt) amt.addEventListener("input", ()=>_rntUpdateQuote().catch(()=>{}));
  const user=_rntById("rntUsername");
  if(user) user.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); _rntInspect().catch(()=>{}); } });

  const chk=_rntById("rntCheck");
  const buy=_rntById("rntBuy");
  if(chk) chk.addEventListener("click", ()=>_rntInspect().catch(()=>{}));
  if(buy) buy.addEventListener("click", ()=>_rntBuy().catch(()=>{}));
})();


// ----------------------------
// Purchases history (Robux only)
// ----------------------------
function _histById(id){ return document.getElementById(id); }
let _histState = { open:false, tick:null };

function _histOpen(){
  const back=_histById('historyBack');
  const m=_histById('historyModal');
  if(back){ back.classList.remove('hidden'); back.style.display='block'; back.classList.add('open'); requestAnimationFrame(()=>back.classList.add('vis')); }
  if(m){ m.classList.remove('hidden'); m.style.display='block'; m.classList.add('open'); requestAnimationFrame(()=>m.classList.add('vis')); }
  _histState.open = true;
}
function _histClose(){
  const back=_histById('historyBack');
  const m=_histById('historyModal');
  if(!m) return;
  m.classList.remove('vis'); if(back) back.classList.remove('vis');
  setTimeout(()=>{
    m.classList.remove('open'); m.style.display='none'; m.classList.add('hidden');
    if(back){ back.classList.remove('open'); back.style.display='none'; back.classList.add('hidden'); }
  }, 190);
  _histState.open = false;
  try{ if(_histState.tick) clearInterval(_histState.tick); }catch(_e){}
  _histState.tick = null;
}

function _statusLabel(st){
  const m = {
    reserved:'Бронь',
    processing:'Оплачено (обработка)',
    paid:'Оплачено',
    done:'Выполнено',
    failed:'Ошибка',
    cancelled:'Отменено',
    expired:'Истекло',
  };
  return m[st] || st;
}

function _renderHistory(items, nowTs){
  const list = _histById('historyList');
  const empty = _histById('historyEmpty');
  if(!list) return;
  list.innerHTML = '';
  if(!items || !items.length){
    if(empty) empty.style.display='block';
    return;
  }
  if(empty) empty.style.display='none';

  for(const it of items){
    const card = document.createElement('div');
    card.className = 'prizeCard';
    const created = it.created_at ? it.created_at.replace('T',' ').slice(0,19) : '';
    const st = it.status || '';
    const line = document.createElement('div');
    line.style.display='flex';
    line.style.justifyContent='space-between';
    line.style.gap='10px';
    line.innerHTML = `<div style="font-weight:900">Robux • ${it.robux_amount} R$</div><div class="muted" style="font-size:12px">${created}</div>`;
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.style.fontSize='12px';
    sub.style.marginTop='4px';
    sub.textContent = `Статус: ${_statusLabel(st)} • Сумма: ${it.rub_price}₽`;

    const btn = document.createElement('button');
    btn.className = 'btn mini';
    btn.type = 'button';
    btn.style.marginTop='10px';
    btn.textContent = 'Посмотреть детали';

    const det = document.createElement('div');
    det.className = 'muted';
    det.style.display='none';
    det.style.marginTop='10px';
    det.style.fontSize='12px';

    btn.onclick = async ()=>{
      if(det.dataset.loaded==='1'){
        det.style.display = (det.style.display==='none') ? 'block' : 'none';
        return;
      }
      try{
        btn.disabled = true;
        const j = await apiGet(`/api/purchases/detail?id=${encodeURIComponent(it.id)}`);
        const o = j.item;
        det.dataset.loaded='1';
        det.style.display='block';

        let extra = '';
        if(o.status==='done'){
          const settle = (parseInt(o.done_ts||0,10) || nowTs) + (5*24*60*60);
          extra = `Зачисление через: ${Math.max(0, settle - Math.floor(Date.now()/1000))} сек.`;
        }else if(o.status==='reserved'){
          const left = (parseInt(o.reserve_expires_ts||0,10) || 0) - Math.floor(Date.now()/1000);
          extra = `Бронь: ${_robuxFmtTs(left)}`;
        }
        det.innerHTML = `
          <div><b>Геймпасс:</b> ${escapeHtml(o.gamepass_name||'—')}</div>
          <div><b>Создатель:</b> ${escapeHtml(o.gamepass_owner||'—')}</div>
          <div><b>Цена геймпасса:</b> ${o.gamepass_price} R$</div>
          <div><b>Ссылка/ID:</b> ${escapeHtml(o.gamepass_url||'—')}</div>
          ${extra ? `<div style="margin-top:6px; font-weight:800">${escapeHtml(extra)}</div>` : ''}
        `;
      }catch(e){
        toast('История', e.message||'Не удалось загрузить детали', 'bad');
      }finally{
        btn.disabled = false;
      }
    };

    card.appendChild(line);
    card.appendChild(sub);
    card.appendChild(btn);
    card.appendChild(det);
    list.appendChild(card);
  }
}

async function openShopHistory(){
  _histOpen();
  const close = _histById('historyClose');
  const back = _histById('historyBack');
  if(close) close.onclick = _histClose;
  if(back) back.onclick = _histClose;

  try{
    const j = await apiGet('/api/purchases/history');
    _renderHistory(j.items||[], j.server_now_ts||Math.floor(Date.now()/1000));
    try{ if(_histState.tick) clearInterval(_histState.tick); }catch(_e){}
    _histState.tick = setInterval(async ()=>{
      if(!_histState.open) return;
      try{
        const jj = await apiGet('/api/purchases/history');
        _renderHistory(jj.items||[], jj.server_now_ts||Math.floor(Date.now()/1000));
      }catch(_e){}
    }, 3000);
  }catch(e){
    toast('История', e.message||'Не удалось загрузить историю', 'bad');
  }
}

document.addEventListener('click', (e)=>{
  const t = e.target;
  if(!t) return;
  const btn = t.closest && t.closest('#btnShopHistory');
  if(btn){
    e.preventDefault();
    openShopHistory();
  }
});


function applyItemToCard(card, it){
  const t = card.querySelector('.prodTitle');
  const d = card.querySelector('.prodDesc');
  const tag = card.querySelector('.prodTag');
  const price = card.querySelector('.priceMain');
  const hint = card.querySelector('.priceHint');
  const hintText = card.querySelector('.priceHintText');
  const btn = card.querySelector('.prodBtn');
  const btnText = card.querySelector('.prodBtnText');
  const art = card.querySelector('.prodMediaArt');

  // mark special card types (for CSS)
  try{
    const act = inferShopAction(it) || "";
    const isCase = (act === "case_free" || act === "case_paid");
    card.classList.toggle('isCase', isCase);
    card.classList.toggle('isCaseFree', act === 'case_free');
    card.classList.toggle('isCasePaid', act === 'case_paid');
  }catch(_e){}

  if(t) t.textContent = it.title || '';
  if(d) d.textContent = it.desc || '';
  if(tag) tag.textContent = it.tag || '';
  if(price) price.textContent = (it.price!=null ? String(it.price) : '');

  if(hintText) hintText.textContent = (it.startingAt!=null ? String(it.startingAt) : (hintText.textContent||'Starting at'));
  if(btnText) btnText.textContent = (it.btnText!=null ? String(it.btnText) : (btnText.textContent||'Открыть'));

  if(btn){
    btn.style.background = it.btnBg ? String(it.btnBg) : '';
    btn.style.color = it.btnColor ? String(it.btnColor) : '';
    btn.style.borderColor = it.btnBorder ? String(it.btnBorder) : '';
  }

  if(tag){
    tag.style.background = it.tagBg ? String(it.tagBg) : '';
    tag.style.color = it.tagColor ? String(it.tagColor) : '';
  }

  if(hint) hint.style.color = it.hintColor ? String(it.hintColor) : '';
  if(price) price.style.color = it.priceColor ? String(it.priceColor) : '';

  if(art){
    const b = normBannerUrl(it.banner);
    if(b){ art.style.display='block'; art.src=b; }
    else { art.style.display='none'; art.removeAttribute('src'); }
  }
}





async function openShopConstructor({mode="builder"}={}){
  // admin-only guard
  if(!_me || !_me.is_admin){
    toast('Панель магазина', 'Нет прав администратора', 'bad');
    return;
  }
  _shopEditorEnabled = true;
  _shopEditorMode = mode;
  try{ switchTab('shop'); }catch(_e){}
ensureShopInjected();
  const j = await apiGet('/api/shop_config');
  _shopCfgCache = normalizeShopCfg(j.config||{});
  if(mode==='manage'){
    // try select last or first item
    const cat = _shopCfgCache.categories.find(c=>c.id===_shopActiveCat) || _shopCfgCache.categories[0];
    _shopEdSelected = (cat?.order?.[0]) || null;
  }
  renderShopFromCfg(_shopCfgCache);
  toast('Конструктор', 'Режим конструктора включён', 'ok');
}

function shopEdExit(){
  _shopEditorEnabled = false;
  document.body.classList.remove('shopGridOn');
  if(_shopCfgCache) renderShopFromCfg(_shopCfgCache);
}

let _shopEdSelected = null;

function shopEdLiveApply(cfg, id){
  if(!cfg||!id) return;
  const it = cfg.items[id];
  const card = document.getElementById(id);
  if(card && it) {
    // keep dataset for clicks
    card.dataset.prod = id;
    applyItemToCard(card, it);
  }
  // update left list title/tag without rerender
  const row = document.querySelector(`.shopEdItem[data-id="${id}"]`);
  if(row){
    const tt = row.querySelector('.shopEdItemTitle');
    const muted = row.querySelector('.muted');
    if(tt) tt.textContent = it.title || id;
    if(muted) muted.textContent = it.tag || '';
  }
}


function shopEdRenderLists(){
  if(!_shopCfgCache) return;
  const cfg = _shopCfgCache;
  const cats = document.getElementById('shopEdCats');
  const items = document.getElementById('shopEdItems');
  const form = document.getElementById('shopEdForm');
  if(!cats||!items||!form) return;

  cats.innerHTML='';
  cfg.categories.forEach(cat=>{
    const row = document.createElement('div');
    row.className = 'shopEdCat' + (cat.id===_shopActiveCat ? ' active':'');
    row.innerHTML = `
      <button class="btn mini" type="button" data-act="sel">${esc(cat.title)}</button>
      <div class="shopEdCatBtns">
        <button class="btn mini" type="button" data-act="ren">✎</button>
        <button class="btn mini" type="button" data-act="del">🗑</button>
      </div>
    `;
    row.querySelector('[data-act="sel"]').addEventListener('click', ()=>{ _shopActiveCat = cat.id; renderShopFromCfg(cfg); });
    row.querySelector('[data-act="ren"]').addEventListener('click', ()=>{
      const n = prompt('Название раздела', cat.title||'');
      if(n){ cat.title = n.trim(); renderShopFromCfg(cfg); }
    });
    row.querySelector('[data-act="del"]').addEventListener('click', ()=>{
      if(cfg.categories.length<=1) return toast('Разделы', 'Нужен минимум 1 раздел', 'bad');
      if(!confirm('Удалить раздел? Товары из него не удалятся, их можно перенести вручную.')) return;
      cfg.categories = cfg.categories.filter(c=>c.id!==cat.id);
      if(_shopActiveCat===cat.id) _shopActiveCat = cfg.categories[0].id;
      renderShopFromCfg(cfg);
    });
    cats.appendChild(row);
  });

  const active = cfg.categories.find(c=>c.id===_shopActiveCat) || cfg.categories[0];
  items.innerHTML='';
  (active.order||[]).forEach(id=>{
    const it = cfg.items[id] || (cfg.items[id]={});
    const r = document.createElement('div');
    r.className = 'shopEdItem' + (_shopEdSelected===id ? ' active':'');
    r.draggable = true;
    r.dataset.id = id;
    r.innerHTML = `
      <div class="shopEdDrag">≡</div>
      <div class="shopEdItemMain">
        <div class="shopEdItemTitle">${esc(it.title||id)}</div>
        <div class="muted" style="font-size:11px">${esc(it.tag||'')}</div>
      </div>
      <button class="btn mini" type="button" data-act="hide">${it.hidden?'🙈':'👁'}</button>
    `;
    r.addEventListener('click', ()=>{ _shopEdSelected=id; shopEdRenderLists(); });
    r.querySelector('[data-act="hide"]').addEventListener('click', (e)=>{
      e.stopPropagation();
      it.hidden = !it.hidden;
      renderShopFromCfg(cfg);
    });
    r.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/plain', id); r.classList.add('dragging'); });
    r.addEventListener('dragend', ()=>r.classList.remove('dragging'));
    r.addEventListener('dragover', (e)=>e.preventDefault());
    r.addEventListener('drop', (e)=>{
      e.preventDefault();
      const from = e.dataTransfer.getData('text/plain');
      const to = id;
      if(!from||from===to) return;
      const a = active.order.indexOf(from);
      const b = active.order.indexOf(to);
      if(a<0||b<0) return;
      active.order.splice(a,1);
      active.order.splice(b,0,from);
      renderShopFromCfg(cfg);
    });
    items.appendChild(r);
  });

  if(!_shopEdSelected){
    form.innerHTML = `<div class="muted" style="font-size:12px">Выбери товар слева.</div>`;
    return;
  }
  const it = cfg.items[_shopEdSelected] || (cfg.items[_shopEdSelected]={});
  form.innerHTML = `
    <label class="lbl">Название</label>
    <input class="input" id="shopEdTitle" value="${esc(it.title||'')}" />
    <label class="lbl" style="margin-top:10px">Описание</label>
    <textarea class="input" id="shopEdDesc" rows="3" style="min-height:90px">${esc(it.desc||'')}</textarea>
    <div class="shopEdGrid2" style="margin-top:10px">
      <div>
        <label class="lbl">Цена/лейбл</label>
        <input class="input" id="shopEdPrice" value="${esc(it.price||'')}" />
      </div>
      <div>
        <label class="lbl">Тег</label>
        <input class="input" id="shopEdTag" value="${esc(it.tag||'')}" />
      </div>
    </div>
    <label class="lbl" style="margin-top:10px">Баннер</label>
    <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap">
      <input class="input" id="shopEdBanner" value="${esc(it.banner||'')}" placeholder="URL или загрузка ниже" style="flex:1" />
      <label class="btn mini" style="position:relative; overflow:hidden">
        Загрузить
        <input type="file" id="shopEdBannerFile" accept="image/*" style="position:absolute; inset:0; opacity:0; cursor:pointer" />
      </label>
    </div>

    <div class="shopEdGrid2" style="margin-top:10px">
      <div>
        <label class="lbl">Текст кнопки</label>
        <input class="input" id="shopEdBtnText" value="${esc(it.btnText||'')}" placeholder="Открыть" />
      </div>
      <div>
        <label class="lbl">Надпись над ценой</label>
        <input class="input" id="shopEdStarting" value="${esc(it.startingAt||'')}" placeholder="Starting at" />
      </div>
    </div>

    <div class="shopEdGrid2" style="margin-top:10px">
      <div>
        <label class="lbl">Действие товара</label>
        <select class="input" id="shopEdAction">
          <option value="none">— нет</option>
          <option value="case_free">Кейс (FREE)</option>
          <option value="case_paid">Кейс (PAID)</option>
          <option value="topup">Пополнение баланса</option>
          <option value="premium">Premium</option>
          <option value="link">Ссылка</option>
        </select>
      </div>
      <div>
        <label class="lbl">Тестовый товар</label>
        <label class="row" style="gap:10px; align-items:center">
          <input type="checkbox" id="shopEdTestOnly" ${it.testOnly?'checked':''} />
          <span class="muted" style="font-size:12px">показывать как визуальный</span>
        </label>
      </div>
    </div>

    <label class="lbl" style="margin-top:10px">Ссылка (если действие = Ссылка)</label>
    <input class="input" id="shopEdLink" value="${esc(it.linkUrl||'')}" placeholder="https://" />

    <div class="shopEdGrid2" style="margin-top:10px">
      <div>
        <label class="lbl">Цвет кнопки</label>
        <input class="input" id="shopEdBtnBg" value="${esc(it.btnBg||'')}" placeholder="#6b7cff или rgba()" />
      </div>
      <div>
        <label class="lbl">Цвет текста кнопки</label>
        <input class="input" id="shopEdBtnColor" value="${esc(it.btnColor||'')}" placeholder="#ffffff" />
      </div>
    </div>
    <div class="shopEdGrid2" style="margin-top:10px">
      <div>
        <label class="lbl">Цвет тега (фон)</label>
        <input class="input" id="shopEdTagBg" value="${esc(it.tagBg||'')}" placeholder="rgba()" />
      </div>
      <div>
        <label class="lbl">Цвет тега (текст)</label>
        <input class="input" id="shopEdTagColor" value="${esc(it.tagColor||'')}" placeholder="#fff" />
      </div>
    </div>

    <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap">
      <button class="btn mini" id="shopEdDelete" type="button">Удалить товар</button>
      <button class="btn mini" id="shopEdMove" type="button">Переместить в раздел…</button>
    </div>
  `;

  const bind = (id, key)=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('input', ()=>{ it[key] = el.type==='checkbox' ? !!el.checked : el.value; shopEdLiveApply(cfg, _shopEdSelected); });
  };
  bind('shopEdTitle','title');
  bind('shopEdDesc','desc');
  bind('shopEdPrice','price');
  bind('shopEdTag','tag');
  bind('shopEdBanner','banner');

  // set select current
  const actSel = document.getElementById('shopEdAction');
  if(actSel){ actSel.value = (it.action||'none'); }

  const bind2 = (id, key)=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('input', ()=>{
      it[key] = el.type==='checkbox' ? !!el.checked : el.value;
      shopEdLiveApply(cfg, _shopEdSelected);
    });
    el.addEventListener('change', ()=>{
      it[key] = el.type==='checkbox' ? !!el.checked : el.value;
      shopEdLiveApply(cfg, _shopEdSelected);
    });
  };
  bind2('shopEdBtnText','btnText');
  bind2('shopEdStarting','startingAt');
  bind2('shopEdLink','linkUrl');
  bind2('shopEdBtnBg','btnBg');
  bind2('shopEdBtnColor','btnColor');
  bind2('shopEdTagBg','tagBg');
  bind2('shopEdTagColor','tagColor');
  bind2('shopEdTestOnly','testOnly');
  if(actSel){
    actSel.addEventListener('change', ()=>{ it.action = actSel.value; shopEdLiveApply(cfg, _shopEdSelected); });
  }

  document.getElementById('shopEdBannerFile')?.addEventListener('change', async (e)=>{
    const f = e.target.files?.[0];
    if(!f) return;
    try{
      const url = await shopUploadBanner(f);
      it.banner = url;
      const inp = document.getElementById('shopEdBanner');
      if(inp) inp.value = url;
      renderShopFromCfg(cfg);
      toast('Баннер', 'Загружено', 'ok');
    }catch(err){
      toast('Баннер', err?.message||'Не удалось загрузить', 'bad');
    }
  });
  document.getElementById('shopEdDelete')?.addEventListener('click', ()=>{
    if(!confirm('Удалить товар из магазина?')) return;
    cfg.categories.forEach(c=>{ c.order = (c.order||[]).filter(x=>x!==_shopEdSelected); });
    delete cfg.items[_shopEdSelected];
    const el = document.getElementById(_shopEdSelected);
    if(el && el.id.startsWith('custom_')) el.remove();
    _shopEdSelected = null;
    renderShopFromCfg(cfg);
  });
  document.getElementById('shopEdMove')?.addEventListener('click', ()=>{
    const to = prompt('ID раздела: ' + cfg.categories.map(c=>c.id+':'+c.title).join(' | '), _shopActiveCat);
    if(!to) return;
    const dest = cfg.categories.find(c=>c.id===to.trim());
    if(!dest) return toast('Раздел', 'Не найден', 'bad');
    const src = cfg.categories.find(c=>c.id===_shopActiveCat);
    if(src) src.order = (src.order||[]).filter(x=>x!==_shopEdSelected);
    dest.order = dest.order||[];
    if(!dest.order.includes(_shopEdSelected)) dest.order.push(_shopEdSelected);
    _shopActiveCat = dest.id;
    renderShopFromCfg(cfg);
  });
}

function shopEdAddCategory(){
  if(!_shopCfgCache) return;
  const n = prompt('Название раздела', 'Новый раздел');
  if(!n) return;
  const id = 'cat_' + Math.random().toString(16).slice(2,8);
  _shopCfgCache.categories.push({id, title:n.trim(), order:[]});
  _shopActiveCat = id;
  renderShopFromCfg(_shopCfgCache);
}

function shopEdAddItem(){
  if(!_shopCfgCache) return;
  const title = prompt('Название товара', 'Новый товар');
  if(!title) return;
  const id = 'custom_' + Date.now();
  _shopCfgCache.items[id] = { title:title.trim(), desc:'', price:'', tag:'NEW', banner:'', hidden:false };
  const cat = _shopCfgCache.categories.find(c=>c.id===_shopActiveCat) || _shopCfgCache.categories[0];
  cat.order.push(id);
  _shopEdSelected = id;
  renderShopFromCfg(_shopCfgCache);
  toast('Товар', 'Добавлен (визуальный товар). Настрой поля справа.', 'ok');
}

async function shopUploadBanner(file){
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/admin/upload_banner', {method:'POST', body: fd, credentials:'include'});
  const j = await r.json().catch(()=>({}));
  if(!r.ok || !j.ok) throw new Error(j.detail||'upload failed');
  return j.url;
}

async function shopEdSave(){
  if(!_shopCfgCache) return;
  try{
    await apiPost('/api/admin/shop_config', {config: _shopCfgCache});
    toast('Магазин', 'Сохранено', 'ok');
  }catch(e){
    toast('Магазин', e?.message||'Ошибка сохранения', 'bad');
  }
}

function openShopPanelModal(){
  const m = $("#shopPanelModal");
  if(!m) return;
  m.classList.add("open");
  m.setAttribute("aria-hidden","false");

  // show gate first
  const gate = $("#shopGate");
  const wrap = $("#shopBuilderWrap");
  if(gate) gate.style.display = "flex";
  if(wrap) wrap.style.display = "none";
}
function closeShopPanelModal(){
  const m = $("#shopPanelModal");
  if(!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden","true");
}

function _defaultShopCfg(){
  return {
    order: ["prodCaseFree","prodCasePaid"],
    items: {
      prodCaseFree: { title:"Кейс за капчу", desc:"Открытие раз в 2 дня. Призы: бонусы и Premium. Только для авторизованных.", price:"48h", tag:"FREE", banner:"/static/banners/case_free.svg", hidden:false },
      prodCasePaid: { title:"Кейс за 17₽", desc:"Без капчи. Быстрый кейс за баланс. Призы начисляются в инвентарь.", price:"₽17", tag:"PAID", banner:"/static/banners/case_paid.svg", hidden:false }
    }
  };
}

function buildShopBuilderUI(){
  const list = $("#shopBuilderList");
  if(!list) return;
  list.innerHTML = "";
  const cfg = (_shopCfgCache ? JSON.parse(JSON.stringify(_shopCfgCache)) : _defaultShopCfg());
  // ensure ids exist
  const ids = (cfg.order && cfg.order.length) ? cfg.order.slice() : Object.keys(cfg.items||{});
  cfg.order = ids;

  function render(){
    list.innerHTML = "";
    cfg.order.forEach((id, idx)=>{
      const it = (cfg.items && cfg.items[id]) ? cfg.items[id] : (cfg.items[id] = {});
      const row = document.createElement("div");
      row.className = "shopItem";
      row.draggable = true;
      row.dataset.id = id;

      row.innerHTML = `
        <div class="shopDrag" title="Перетащить">≡</div>
        <div>
          <div class="shopRow">
            <div>
              <label class="lbl">Название (${id})</label>
              <input class="input" data-k="title" value="${esc(it.title||"")}" />
            </div>
            <div>
              <label class="lbl">Цена/лейбл</label>
              <input class="input" data-k="price" value="${esc(it.price||"")}" />
            </div>
          </div>

          <label class="lbl" style="margin-top:10px">Описание</label>
          <input class="input" data-k="desc" value="${esc(it.desc||"")}" />

          <div class="shopRow" style="margin-top:10px">
            <div>
              <label class="lbl">Баннер (путь)</label>
              <input class="input" data-k="banner" value="${esc(it.banner||"")}" placeholder="/static/banners/" />
            </div>
            <div>
              <label class="lbl">Тег</label>
              <input class="input" data-k="tag" value="${esc(it.tag||"")}" />
            </div>
          </div>

          <div class="row" style="margin-top:10px; gap:10px; flex-wrap:wrap; align-items:center">
            <label class="check">
              <input type="checkbox" data-k="hidden" ${it.hidden ? "checked":""}/>
              <span>Скрыть</span>
            </label>

            <div class="shopMiniBtns" style="margin-left:auto">
              <button class="btn mini" data-act="up" type="button">↑</button>
              <button class="btn mini" data-act="down" type="button">↓</button>
            </div>
          </div>
        </div>
      `;

      // inputs binding
      row.querySelectorAll("[data-k]").forEach(inp=>{
        const k = inp.dataset.k;
        inp.addEventListener("input", ()=>{
          if(inp.type === "checkbox") it[k] = inp.checked;
          else it[k] = inp.value;
        });
        inp.addEventListener("change", ()=>{
          if(inp.type === "checkbox") it[k] = inp.checked;
        });
      });

      row.querySelectorAll("[data-act]").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          const act = btn.dataset.act;
          const i = cfg.order.indexOf(id);
          if(act==="up" && i>0){
            cfg.order.splice(i,1);
            cfg.order.splice(i-1,0,id);
            render();
          }
          if(act==="down" && i<cfg.order.length-1){
            cfg.order.splice(i,1);
            cfg.order.splice(i+1,0,id);
            render();
          }
        });
      });

      // drag n drop
      row.addEventListener("dragstart", (e)=>{
        e.dataTransfer.setData("text/plain", id);
        row.style.opacity = ".6";
      });
      row.addEventListener("dragend", ()=>{
        row.style.opacity = "1";
      });
      row.addEventListener("dragover", (e)=>{
        e.preventDefault();
      });
      row.addEventListener("drop", (e)=>{
        e.preventDefault();
        const from = e.dataTransfer.getData("text/plain");
        const to = id;
        if(!from || from===to) return;
        const a = cfg.order.indexOf(from);
        const b = cfg.order.indexOf(to);
        if(a<0||b<0) return;
        cfg.order.splice(a,1);
        cfg.order.splice(b,0,from);
        render();
      });

      list.appendChild(row);
    });

    // attach buttons
    const save = $("#btnShopSave");
    const reset = $("#btnShopReset");
    if(save){
      save.onclick = async ()=>{
        try{
          await apiPost("/api/admin/shop_config", {config: cfg});
          toast("Магазин", "Сохранено", "ok");
          _shopCfgCache = cfg;
          applyShopConfig(cfg);
          closeShopPanelModal();
        }catch(e){
          toast("Магазин", (e?.message||"Ошибка сохранения"), "bad");
        }
      };
    }
    if(reset){
      reset.onclick = ()=>{
        _shopCfgCache = _defaultShopCfg();
        applyShopConfig(_shopCfgCache);
        buildShopBuilderUI();
      };
    }
  }

  render();
}

function esc(s){
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}



/* -------------------------
   Standalone shop builder page
--------------------------*/
async function initShopBuilderPage(){
  try{
    const j = await apiGet('/api/shop_config');
    _shopCfgCache = j.config || {};
  }catch(e){
    _shopCfgCache = _defaultShopCfg();
  }
  const cfg = (_shopCfgCache ? JSON.parse(JSON.stringify(_shopCfgCache)) : _defaultShopCfg());

  // normalize categories
  if(!Array.isArray(cfg.categories) || !cfg.categories.length){
    const all = {id:"all", name:"Все товары", order: Array.isArray(cfg.order)? cfg.order.slice() : Object.keys(cfg.items||{})};
    cfg.categories = [all];
  }else{
    cfg.categories.forEach(c=>{ if(!Array.isArray(c.order)) c.order=[]; if(!c.id) c.id = 'cat_'+Math.random().toString(16).slice(2); });
  }
  if(!cfg.items) cfg.items = {};
  if(!Array.isArray(cfg.order)) cfg.order = Object.keys(cfg.items);

  const catList = document.getElementById('catList');
  const sections = document.getElementById('shopSections');
  const editor = document.getElementById('shopBuilderList');
  const btnCatAdd = document.getElementById('btnCatAdd');
  const btnShopAdd = document.getElementById('btnShopAdd');
  const btnSave = document.getElementById('btnShopSave');
  const btnToShop = document.getElementById('btnBuilderToShop');

  let activeCat = cfg.categories[0]?.id || 'all';
  let activeItem = null;

  function getCat(id){ return cfg.categories.find(c=>c.id===id); }
  function ensureItem(id){
    if(!cfg.items[id]) cfg.items[id] = {title:"", desc:"", price:0, tag:"", banner:"", hidden:false};
    return cfg.items[id];
  }

  async function uploadBanner(file){
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/admin/upload_banner', {method:'POST', body: fd, credentials:'include'});
    const j = await r.json();
    if(!r.ok || !j.ok) throw new Error(j.detail || 'upload failed');
    return j.url;
  }

  function renderCats(){
    if(!catList) return;
    catList.innerHTML = '';
    cfg.categories.forEach(c=>{
      const b = document.createElement('button');
      b.type='button';
      b.className='catBtn' + (c.id===activeCat?' active':'');
      b.textContent = c.name || 'Раздел';
      b.addEventListener('click', ()=>{ activeCat=c.id; activeItem=null; renderAll(); });
      catList.appendChild(b);
    });
  }
  function normalizeBannerUrl(url){
    if(!url) return '';
    let u = String(url).trim();
    // absolute http(s)
    if(/^https?:\/\//i.test(u)) return u;
    // already absolute
    if(u.startsWith('/')) return encodeURI(u);
    // if points into static already
    if(u.startsWith('static/')) return encodeURI('/'+u);
    // filename only -> /static/banners/
    if(!u.includes('/')) return encodeURI('/static/banners/'+u);
    // relative path -> make absolute
    return encodeURI('/'+u);
  }


  function cardHtml(id, it){
    const price = (it.price != null) ? String(it.price) : '';
    const tag = it.tag || '';
    const bannerRaw = it.banner || '';
    const banner = normalizeBannerUrl(bannerRaw);
    return `<div class="productCard tilt" data-pid="${id}" style="${it.hidden?'opacity:.45':''}">
      <div class="prodArt"><img class="prodMediaArt" src="${esc(banner)}" alt=""></div>
      <div class="prodBody">
        <div class="prodTop">
          <div class="prodTitle">${esc(it.title||id)}</div>
          <div class="prodTag">${esc(tag)}</div>
        </div>
        <div class="prodDesc">${esc(it.desc||'')}</div>
        <div class="prodBottom">
          <div class="priceMain">${esc(price)}</div>
          <button class="btn pri" type="button">Открыть</button>
        </div>
      </div>
    </div>`;
  }

  function renderPreview(){
    if(!sections) return;
    sections.innerHTML = '';
    cfg.categories.forEach(cat=>{
      const wrap = document.createElement('section');
      wrap.className='shopSection glass';
      wrap.innerHTML = `<div class="shopSectionHead">
          <div class="h">${esc(cat.name||'Раздел')}</div>
          <div class="muted">${cat.order.length} товаров</div>
        </div>
        <div class="shopGrid2">${cat.order.map(id=>cardHtml(id, ensureItem(id))).join('')}</div>`;
      sections.appendChild(wrap);
    });

    // click select item
    sections.querySelectorAll('[data-pid]').forEach(el=>{
      el.addEventListener('click', ()=>{
        activeItem = el.getAttribute('data-pid');
        renderEditor();
      });
    });

    initTilt();
  }

  function renderEditor(){
    if(!editor) return;
    const cat = getCat(activeCat) || cfg.categories[0];
    const ids = (cat && Array.isArray(cat.order)) ? cat.order : [];
    editor.innerHTML = ids.map((id)=>{
      const it = ensureItem(id);
      const selected = (id===activeItem);
      return `<div class="shopItem ${selected?'active':''}" draggable="true" data-id="${id}">
        <div class="shopItemHead">
          <div class="shopItemId">${esc(id)}</div>
          <div class="shopMiniBtns">
            <button class="btn mini" data-act="del" type="button">Удалить</button>
          </div>
        </div>
        <div class="grid2">
          <div>
            <label class="lbl">Название</label>
            <input class="input" data-k="title" value="${esc(it.title||"")}" />
          </div>
          <div>
            <label class="lbl">Цена</label>
            <input class="input" data-k="price" value="${esc(it.price??"")}" />
          </div>
          <div class="span2">
            <label class="lbl">Описание</label>
            <textarea class="input" data-k="desc" rows="2">${esc(it.desc||"")}</textarea>
          </div>
          <div>
            <label class="lbl">Тег</label>
            <input class="input" data-k="tag" value="${esc(it.tag||"")}" />
          </div>
          <div>
            <label class="lbl">Раздел</label>
            <select class="input" data-k="cat">
              ${cfg.categories.map(c=>`<option value="${esc(c.id)}" ${c.id===activeCat?'selected':''}>${esc(c.name||c.id)}</option>`).join('')}
            </select>
          </div>
          <div class="span2">
            <label class="lbl">Баннер</label>
            <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap">
              <input class="input" data-k="banner" value="${esc(it.banner||"")}" placeholder="URL баннера или загрузи файл" style="flex:1; min-width:240px"/>
              <input type="file" accept="image/*" data-k="bannerFile" />
              <button class="btn mini" type="button" data-act="upload">Загрузить</button>
            </div>
          </div>
          <div class="span2 row" style="gap:10px; align-items:center">
            <label class="check">
              <input type="checkbox" data-k="hidden" ${it.hidden ? "checked":""}/>
              <span>Скрыть</span>
            </label>
            <button class="btn mini" type="button" data-act="select">Выбрать</button>
          </div>
        </div>
      </div>`;
    }).join('');

    // bind inputs + actions
    editor.querySelectorAll('.shopItem').forEach(row=>{
      const id = row.getAttribute('data-id');
      const it = ensureItem(id);
      row.querySelectorAll('[data-k]').forEach(inp=>{
        const k = inp.getAttribute('data-k');
        if(k==='bannerFile') return;
        inp.addEventListener('input', ()=>{
          if(k==='hidden') it.hidden = inp.checked;
          else if(k==='price') it.price = Number(inp.value||0);
          else if(k==='cat'){
            const from = getCat(activeCat);
            const to = getCat(inp.value);
            if(from && to && from!==to){
              from.order = from.order.filter(x=>x!==id);
              to.order.push(id);
              activeCat = to.id;
              renderAll();
            }
          }else it[k]=inp.value;
          renderPreview();
        });
        inp.addEventListener('change', ()=>{
          if(k==='hidden') it.hidden = inp.checked;
        });
      });

      row.addEventListener('click', (e)=>{
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if(act==='del'){
          // remove from cat
          cfg.categories.forEach(c=>c.order = (c.order||[]).filter(x=>x!==id));
          delete cfg.items[id];
          if(activeItem===id) activeItem=null;
          renderAll();
          e.stopPropagation();
          return;
        }
        if(act==='select'){
          activeItem=id;
          renderAll();
          e.stopPropagation();
          return;
        }
        if(act==='upload'){
          const f = row.querySelector('input[type="file"][data-k="bannerFile"]')?.files?.[0];
          if(!f){ toast('Баннер','Выбери файл','bad'); return; }
          uploadBanner(f).then(url=>{
            it.banner = url;
            const inp = row.querySelector('input[data-k="banner"]');
            if(inp) inp.value = url;
            toast('Баннер','Загружено','ok');
            renderPreview();
          }).catch(err=>toast('Баннер', err.message||'Ошибка', 'bad'));
          e.stopPropagation();
          return;
        }
      });

      // drag reorder inside cat
      row.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/plain', id); });
      row.addEventListener('dragover', (e)=>{ e.preventDefault(); });
      row.addEventListener('drop', (e)=>{
        e.preventDefault();
        const from = e.dataTransfer.getData('text/plain');
        if(!from || from===id) return;
        const cat = getCat(activeCat);
        const arr = cat.order;
        const a = arr.indexOf(from), b = arr.indexOf(id);
        if(a<0 || b<0) return;
        arr.splice(b,0,arr.splice(a,1)[0]);
        renderAll();
      });
    });
  }

  function renderAll(){
    renderCats();
    renderPreview();
    renderEditor();
  }

  if(btnCatAdd){
    btnCatAdd.addEventListener('click', ()=>{
      const name = prompt('Название раздела:', 'Новый раздел');
      if(!name) return;
      const id = 'cat_' + Math.random().toString(16).slice(2);
      cfg.categories.push({id, name, order: []});
      activeCat = id;
      renderAll();
    });
  }
  if(btnShopAdd){
    btnShopAdd.addEventListener('click', ()=>{
      const id = 'item_' + Math.random().toString(16).slice(2);
      ensureItem(id);
      const cat = getCat(activeCat) || cfg.categories[0];
      cat.order.push(id);
      activeItem = id;
      renderAll();
      setTimeout(()=>document.querySelector('.shopItem.active')?.scrollIntoView({behavior:'smooth', block:'center'}), 50);
    });
  }
  if(btnSave){
    btnSave.addEventListener('click', async ()=>{
      try{
        // maintain legacy order/items for shop page compatibility
        cfg.order = cfg.categories.flatMap(c=>c.order);
        await apiPost('/api/admin/shop_config', {config: cfg});
        toast('Магазин', 'Сохранено', 'ok');
      }catch(e){
        toast('Магазин', e.message||'Ошибка', 'bad');
      }
    });
  }
  if(btnToShop){
    btnToShop.addEventListener('click', ()=>{ window.location.href='/#shop'; });
  }

  renderAll();
}

document.addEventListener('DOMContentLoaded', ()=>{
    // Home page info blocks: enable tilt on desktop hover
    try{
      document.querySelectorAll('#tab-home .heroItem, #tab-home .card:not(.hero)').forEach(el=>{
        el.classList.add('tilt','tiltInfo');
      });
      if(typeof initTilt==='function') initTilt();
    }catch(_e){}

    // Enable tilt for home info blocks (desktop only)
    try{
      document.querySelectorAll('#tab-home .heroItem, #tab-home .card:not(.hero)').forEach(el=>{
        el.classList.add('tilt','tiltInfo');
      });
    }catch(_e){}

  if(window.__SHOP_BUILDER_PAGE__){
    initShopBuilderPage().catch(()=>{});
  }
});

// expose cases API for handlers
try{ window.openCaseModal = openCaseModal; }catch(e){}

/* ------------------------------------------------------------------
 * HOTFIX: Case modal stopped opening after Shop Editor changes.
 * In some builds the case logic ended up scoped inside a DOMContentLoaded
 * callback and never got exported, while the legacy window.openCaseModal
 * placeholder didn't add required classes (.open/.vis), so the modal
 * remained invisible.
 *
 * This block provides a standalone, resilient implementation and
 * force-exports window.openCaseModal/closeCaseModal.
 * ------------------------------------------------------------------ */
(function(){
  const toast = (t,m,k)=>{
    if(typeof window.toast === 'function') return window.toast(t,m,k);
    try{ alert(String(t||'') + (m?(': '+m):'')); }catch(_e){}
  };
  const byId = (id)=>document.getElementById(id);

  const CASE_PAID_PRICE = 17;
  const CASE_ITEMS = [
    { key:"GEN10", label:"+10 анализов", icon:"⚡", weight:2500 },
    { key:"AI3",   label:"+3 генерации (AI+анализ)", icon:"✨", weight:2400 },
    { key:"P6H",   label:"Premium 6 часов", icon:"💎", img:"/static/prizes/premium_6h.png", weight:1800 },
    { key:"P12H",  label:"Premium 12 часов", icon:"💎", img:"/static/prizes/premium_12h.png", weight:1200 },
    { key:"P24H",  label:"Premium 24 часа", icon:"💎", img:"/static/prizes/premium_24h.png", weight:700 },
    { key:"P2D",   label:"Premium 2 дня", icon:"💎", img:"/static/prizes/premium_2d.png", weight:650 },
    { key:"P3D",   label:"Premium 3 дня", icon:"💎", img:"/static/prizes/premium_3d.png", weight:600 },
    { key:"P7D",   label:"Premium 7 дней", icon:"💎", img:"/static/prizes/premium_7d.png", weight:150 },
  ];
  const itemByKey = Object.fromEntries(CASE_ITEMS.map(x=>[x.key,x]));

  const esc = (s)=>String(s==null?'':s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#39;');

  let caseMode = 'free';
  let caseToken = '';
  let caseSpinning = false;

  const fetchJson = async (url, opts={}) => {
    const headers = Object.assign({"Content-Type":"application/json"}, opts.headers||{});
    const r = await fetch(url, Object.assign({ credentials:'include', headers }, opts));
    const ct = (r.headers.get('content-type')||'').toLowerCase();
    let j = null;
    if(ct.includes('application/json')) j = await r.json().catch(()=>null);
    if(!j) j = { ok: r.ok };
    if(!r.ok && j && j.detail) throw new Error(j.detail);
    if(!r.ok && j && !j.ok && j.message) throw new Error(j.message);
    if(!r.ok && j && !j.ok && !j.detail) throw new Error('Request failed');
    return j;
  };

  const ensureAuth = async ()=>{
    try{
      // NOTE: main auth endpoint in this project is /api/auth/me
      const j = await fetchJson('/api/auth/me', { method:'GET', headers:{} });
      if(j && j.ok && j.user){
        // keep compatibility with the rest of the app that expects currentUser/_me
        try{ currentUser = j.user; }catch(_e){}
        try{ _me = j.user; }catch(_e){}
        try{ window.currentUser = j.user; }catch(_e){}
        try{ window._me = j.user; }catch(_e){}
        return true;
      }
    }catch(_e){}
    toast('Профиль','Сначала войди в аккаунт','warn');
    try{ if(typeof window.setTab==='function') window.setTab('profile'); }catch(_e){}
    try{ if(typeof window.showTab==='function') window.showTab('profile'); }catch(_e){}
    return false;
  };

  function setCaseMode(mode){
    caseMode = (mode==='paid') ? 'paid' : 'free';
    const badge = byId('caseModeBadge');
    const title = byId('caseModalTitle');
    const free = byId('caseFreeControls');
    const paid = byId('casePaidControls');
    const res  = byId('caseResult');
    if(res){ res.textContent='—'; res.classList.add('hidden'); }
    if(caseMode==='paid'){
      if(title) title.textContent = `💸 Кейс за ${CASE_PAID_PRICE}₽`;
      if(badge) badge.textContent = 'PAID';
      if(free) free.style.display='none';
      if(paid){ paid.classList.remove('hidden'); paid.style.display='block'; }
    }else{
      if(title) title.textContent = '🎯 Кейс за капчу';
      if(badge) badge.textContent = 'FREE';
      if(free) free.style.display='block';
      if(paid){ paid.style.display='none'; paid.classList.add('hidden'); }
    }
  }

  function buildPrizesList(){
    const list = byId('casePrizesList');
    if(!list) return;
    list.innerHTML='';
    const total = CASE_ITEMS.reduce((s,x)=>s+x.weight,0);
    CASE_ITEMS.forEach(it=>{
      const row = document.createElement('div');
      row.className='prizeRow';
      const pct = ((it.weight/total)*100).toFixed(1)+'%';
      const ico = it.img ? `<img class="prImg" src="${it.img}" alt="">` : `<div class="prIco">${it.icon||'🎁'}</div>`;
      row.innerHTML = `${ico}<div style="flex:1"><div class="prT">${escapeHtml(it.label)}</div><div class="muted" style="font-size:12px">${escapeHtml(it.key)}</div></div><div class="prW">${pct}</div>`;
      list.appendChild(row);
    });
  }

  function buildReel({ winningKey=null }={}){
    const reel = byId('caseReel');
    if(!reel) return;
    reel.innerHTML='';
    const seq = [];
    for(let i=0;i<8;i++) CASE_ITEMS.forEach(it=>seq.push(it));
    for(let i=0;i<18;i++) seq.push(CASE_ITEMS[Math.floor(Math.random()*CASE_ITEMS.length)]);

    // Put winningKey near the end so the spin looks long
    const stopIndex = Math.max(12, seq.length - 10);
    if(winningKey && itemByKey[winningKey]) seq[stopIndex] = itemByKey[winningKey];

    seq.forEach((it)=>{
      const d=document.createElement('div');
      d.className='casePrize' + (String(it.key||'').startsWith('P') ? ' prem' : '');
      d.dataset.prize = it.key;
      d.innerHTML = `<div class="caseInner">${it.img?`<img class="caseImg" src="${it.img}" alt="">`:`<div class="caseIcon">${it.icon||'🎁'}</div>`}<div class="caseLbl">${escapeHtml(it.label||it.key||'')}</div></div>`;
      reel.appendChild(d);
    });

    reel.style.transition='none';
    reel.style.transform='translateX(0px)';
    reel.dataset.stopIndex = String(stopIndex);
  }

  function openModalUI(){
    const back = byId('caseOpenBack');
    const m = byId('caseOpenModal');
    if(back){ back.classList.remove('hidden'); back.style.display='block'; }
    if(m){
      m.classList.remove('hidden');
      m.style.display='block';
      m.classList.add('open');
      requestAnimationFrame(()=>m.classList.add('vis'));
    }
  }

  function closeModalUI(){
    if(caseSpinning) return;
    const back = byId('caseOpenBack');
    const m = byId('caseOpenModal');
    if(!m) return;
    m.classList.remove('vis');
    setTimeout(()=>{
      m.classList.remove('open');
      m.style.display='none';
      m.classList.add('hidden');
      if(back){ back.style.display='none'; back.classList.add('hidden'); }
    }, 190);
  }

  function openPrizes(){
    buildPrizesList();
    const back = byId('casePrizesBack');
    const m = byId('casePrizesModal');
    if(back){ back.classList.remove('hidden'); back.style.display='block'; }
    if(m){ m.classList.remove('hidden'); m.style.display='block'; m.classList.add('open'); requestAnimationFrame(()=>m.classList.add('vis')); }
  }
  function closePrizes(){
    const back = byId('casePrizesBack');
    const m = byId('casePrizesModal');
    if(!m) return;
    m.classList.remove('vis');
    setTimeout(()=>{
      m.classList.remove('open');
      m.style.display='none';
      m.classList.add('hidden');
      if(back){ back.style.display='none'; back.classList.add('hidden'); }
    }, 190);
  }

  function showPrizeResult(key){
    const res = byId('caseResult');
    const it = itemByKey[key];
    if(!res) return;
    res.textContent = it ? `Вы выиграли: ${it.label}` : `Вы выиграли: ${key}`;
    res.classList.remove('hidden');
  }

  async function spinToPrize(prizeKey){
    const reel = byId('caseReel');
    const wrap = document.querySelector('#caseOpenModal .caseReelWrap');
    if(!reel || !wrap) return;

    buildReel({ winningKey: prizeKey });
    // Wait for layout
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const stopIndex = parseInt(reel.dataset.stopIndex||'0',10);
    const items = reel.querySelectorAll('.casePrize');
    const winEl = items[stopIndex] || items[items.length-1];
    if(!winEl) return;

    const wrapW = wrap.clientWidth;
    const x = winEl.offsetLeft + winEl.offsetWidth/2 - wrapW/2;
    caseSpinning = true;
    reel.style.transition = 'transform 4.2s cubic-bezier(.08,.66,.12,1)';
    reel.style.transform  = `translateX(${-x}px)`;
    await new Promise(r=>setTimeout(r, 4300));
    caseSpinning = false;
  }

  async function doFreeChallenge(){
    if(!(await ensureAuth())) return;
    try{
      const j = await fetchJson('/api/case/challenge', { method:'GET', headers:{} });
      caseToken = j.token || '';
      const hint = byId('caseHint');
      if(hint) hint.textContent = `Сколько будет ${j.a} + ${j.b}?`;
      const ans = byId('caseAnswer');
      if(ans){ ans.value=''; ans.focus(); }
    }catch(e){
      toast('Кейс', e.message || 'Не удалось получить капчу', 'bad');
    }
  }

  async function doFreeOpen(){
    if(!(await ensureAuth())) return;
    const answer = (byId('caseAnswer')?.value||'').trim();
    if(!caseToken){ toast('Кейс','Сначала получи капчу','warn'); return; }
    if(!answer){ toast('Кейс','Введи ответ капчи','warn'); return; }
    try{
      const r = await fetchJson('/api/case/open', { method:'POST', body: JSON.stringify({ token: caseToken, answer }) });
      await spinToPrize(r.prize);
      showPrizeResult(r.prize);
      toast('Кейс','Готово! Приз добавлен в инвентарь.','ok');
    }catch(e){
      toast('Кейс', e.message || 'Не удалось открыть кейс', 'bad');
    }
  }

  async function doPaidOpen(){
    if(!(await ensureAuth())) return;
    try{
      const r = await fetchJson('/api/case/open_paid', { method:'POST', body: JSON.stringify({}) });
      await spinToPrize(r.prize);
      showPrizeResult(r.prize);
      toast('Кейс','Готово! Приз добавлен в инвентарь.','ok');
    }catch(e){
      toast('Кейс', e.message || 'Не удалось открыть кейс', 'bad');
    }
  }

  async function openCaseModal(mode){
    const m = byId('caseOpenModal');
    if(!m) return;

    // Open instantly (no perceived lag), then validate auth + build heavy DOM on next frames.
    setCaseMode(mode);
    m.classList.add('loading');
    openModalUI();

    // Let the modal paint before network / heavy work
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

    if(!(await ensureAuth())){ 
      closeModalUI();
      m.classList.remove('loading');
      return;
    }

    // Build reel after modal is visible (reduces tap delay on mobile)
    buildReel({ winningKey:null });
    m.classList.remove('loading');
  }

  // Export globally (overrides any legacy placeholder)
  window.openCaseModal = openCaseModal;
  window.closeCaseModal = closeModalUI;

  // Bind UI once
  document.addEventListener('DOMContentLoaded', ()=>{
    // Buttons inside modal
    byId('btnCaseModalClose')?.addEventListener('click', closeModalUI);
    byId('caseOpenBack')?.addEventListener('click', closeModalUI);
    byId('btnCasePrizes')?.addEventListener('click', openPrizes);
    byId('btnCasePrizesClose')?.addEventListener('click', closePrizes);
    byId('casePrizesBack')?.addEventListener('click', closePrizes);

    byId('btnCaseGetCaptcha')?.addEventListener('click', doFreeChallenge);
    byId('btnCaseOpenFree')?.addEventListener('click', doFreeOpen);
    byId('btnCaseOpenPaid')?.addEventListener('click', doPaidOpen);

    // Legacy buttons (if they still exist somewhere in layout)
    byId('btnOpenCaseFree')?.addEventListener('click', ()=>openCaseModal('free'));
    byId('btnOpenCasePaid')?.addEventListener('click', ()=>openCaseModal('paid'));

    // ESC
    window.addEventListener('keydown', (e)=>{
      if(e.key==='Escape'){
        closeModalUI();
        closePrizes();
      }
    });
  }, { once:true });
})();