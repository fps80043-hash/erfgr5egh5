/**
 * RBX Store - Application JavaScript v2.0
 * Clean, modular code
 */
(function() {
  'use strict';

  // State
  const state = { user: null, ui: { tab: 'home' }, robux: { amount: 50, mode: 'username', purchaseMode: 'normal', quote: null, gamepass: null, usernameRaw: '', urlRaw: '' }, tools: { analysis: null, templates: null, selectedTemplateId: null, chatHistory: [] } };

  // Helpers
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const escapeHtml = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

  // Persist UI state (tab/robux)
  const LS_KEY = 'rst_ui_v2';
  function loadPersist() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) || {};
      if (v.tab) state.ui.tab = String(v.tab);
      if (v.robux) {
        const r = v.robux || {};
        if (r.amount) state.robux.amount = parseInt(r.amount) || state.robux.amount;
        if (r.mode) state.robux.mode = String(r.mode);
        if (r.purchaseMode) state.robux.purchaseMode = String(r.purchaseMode);
        state.robux.usernameRaw = String(r.usernameRaw || '');
        state.robux.urlRaw = String(r.urlRaw || '');
      }
    } catch (e) {}
  }
  function savePersist() {
    try {
      const payload = {
        tab: state.ui.tab,
        robux: {
          amount: state.robux.amount,
          mode: state.robux.mode,
          purchaseMode: state.robux.purchaseMode,
          usernameRaw: $('#robuxUsername')?.value || state.robux.usernameRaw || '',
          urlRaw: $('#robuxUrl')?.value || state.robux.urlRaw || ''
        }
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  // API
  const _userTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(_e) { return ''; } })();

  // ── Global timezone-aware date formatters ──────────────────────
  // Always read the *current* device timezone — no localStorage override,
  // so dates follow the user wherever they travel.
  function _getTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch(_e) { return 'UTC'; }
  }
  // Safely parse a UTC timestamp string from backend (no Z suffix) into a Date
  function _parseUtcTs(ts) {
    if (!ts) return null;
    try {
      const s = String(ts).trim();
      // If already has timezone info, parse directly
      if (s.includes('Z') || s.includes('+') || s.includes('-', 10)) return new Date(s);
      // Otherwise treat as UTC by appending Z
      return new Date(s + 'Z');
    } catch(_e) { return null; }
  }
  function _fmtDatetime(ts) {
    const d = _parseUtcTs(ts);
    if (!d || isNaN(d)) return ts ? String(ts).slice(0,16) : '—';
    try {
      return d.toLocaleString('ru-RU', { timeZone: _getTz(), day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    } catch(_e) { return d.toLocaleString('ru-RU'); }
  }
  function _fmtDate(ts) {
    const d = _parseUtcTs(ts);
    if (!d || isNaN(d)) return ts ? String(ts).slice(0,10) : '—';
    try {
      return d.toLocaleDateString('ru-RU', { timeZone: _getTz(), day:'numeric', month:'short', year:'numeric' });
    } catch(_e) { return d.toLocaleDateString('ru-RU'); }
  }

  async function api(endpoint, opts = {}) {
    const silent = opts.silent; delete opts.silent;
    const timeoutMs = opts.timeout || 60000; delete opts.timeout;
    const cfg = { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts };
    const tz = _getTz();
    if (tz) cfg.headers['X-Timezone'] = tz;
    if (opts.body && typeof opts.body === 'object') cfg.body = JSON.stringify(opts.body);
    
    // Add timeout via AbortController
    const controller = new AbortController();
    cfg.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    
    let res;
    try {
      res = await fetch(endpoint, cfg);
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        if (silent) return null;
        throw new Error('Превышено время ожидания. Попробуй ещё раз.');
      }
      throw e;
    }
    clearTimeout(timer);
    
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (silent) return null;
      // FastAPI validation errors come as: { detail: [ { msg, loc, ... }, ... ] }
      const detail = (data && (data.detail ?? data.message)) ?? null;
      let msg = '';
      if (Array.isArray(detail)) {
        msg = detail
          .map((e) => {
            if (!e) return '';
            if (typeof e === 'string') return e;
            const m = e.msg || e.message;
            const loc = Array.isArray(e.loc) ? e.loc.join('.') : '';
            return (loc ? `${loc}: ` : '') + (m || JSON.stringify(e));
          })
          .filter(Boolean)
          .join('; ');
      } else if (detail && typeof detail === 'object') {
        msg = JSON.stringify(detail);
      } else if (typeof detail === 'string') {
        msg = detail;
      }
      throw new Error(msg || `Error ${res.status}`);
    }
    return data;
  }

  // Small wrappers
  async function apiGet(endpoint) { return api(endpoint, { method: 'GET' }); }
  async function apiPost(endpoint, body) { return api(endpoint, { method: 'POST', body }); }

  // API (multipart/form-data)
  async function apiForm(endpoint, formData, opts = {}) {
    const cfg = { method: 'POST', credentials: 'same-origin', body: formData, ...opts };
    const res = await fetch(endpoint, cfg);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data && (data.detail ?? data.message)) ?? null;
      const msg = typeof detail === 'string' ? detail : (detail ? JSON.stringify(detail) : `Error ${res.status}`);
      throw new Error(msg);
    }
    return data;
  }

  // Toast
  function toast(msg, type = 'info') {
    const c = $('#toastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${escapeHtml(msg)}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:inherit;cursor:pointer;margin-left:8px">&times;</button>`;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
  }

  // Loading
  function loading(show) {
    const o = $('#loadingOverlay');
    if (o) o.classList.toggle('hidden', !show);
  }

  // Modal
  function modal(content, opts = {}) {
    const o = $('#modalOverlay'), m = $('#modalContent'), box = $('#modal');
    if (!o || !m || !box) return;

    // Reset size classes
    box.classList.remove('modal--wide', 'modal--xl');
    if (opts.size === 'wide') box.classList.add('modal--wide');
    if (opts.size === 'xl') box.classList.add('modal--xl');

    m.innerHTML = content;
    o.classList.remove('hidden');
    document.body.classList.add('modal-open');
    // Ensure content starts at top
    try { m.scrollTop = 0; } catch (e) {}
  }
  function closeModal() {
    const o = $('#modalOverlay'), m = $('#modalContent'), box = $('#modal');
    if (o) o.classList.add('hidden');
    document.body.classList.remove('modal-open');
    if (box) box.classList.remove('modal--wide', 'modal--xl');
    if (m) m.innerHTML = '';
    // Restore global close button
    const gc = document.getElementById('modalClose');
    if (gc) gc.style.display = '';
  }
  // Expose to global scope for inline onclick handlers
  window.closeModal = closeModal;
  window.modal = modal;
  window.toast = toast;
  window.loading = loading;
  window.escapeHtml = escapeHtml;

  // Tabs
  function _positionNavIndicator(tab) {
    const nav = document.getElementById('navDesktop');
    const indicator = document.getElementById('navIndicator');
    if (!nav || !indicator) return;
    const activeBtn = tab
      ? nav.querySelector(`.nav-btn[data-tab="${tab}"]`)
      : nav.querySelector('.nav-btn.active');
    if (!activeBtn) return;

    const _apply = () => {
      const navRect = nav.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      if (!navRect.width || !btnRect.width) return false;
      indicator.style.left = (btnRect.left - navRect.left) + 'px';
      indicator.style.width = btnRect.width + 'px';
      return true;
    };

    // Immediate try, then rAF, then fallback retries
    if (!_apply()) {
      requestAnimationFrame(() => {
        if (!_apply()) {
          setTimeout(() => { _apply(); }, 100);
          setTimeout(() => { _apply(); }, 300);
        }
      });
    }
  }

  function initTabs() {
    $$('.nav-btn[data-tab]:not([data-tab="tools"]), .nav-mobile-btn[data-tab]:not([data-tab="tools"])').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $$('[data-goto]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.goto)));
    _positionNavIndicator();
    // Multiple retries for fonts/layout settling
    setTimeout(_positionNavIndicator, 80);
    setTimeout(_positionNavIndicator, 300);
    document.fonts?.ready?.then(() => setTimeout(_positionNavIndicator, 50));
    // Watch for layout changes (e.g. sidebar opening)
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => _positionNavIndicator());
      const nav = document.getElementById('navDesktop');
      if (nav) ro.observe(nav);
    }
  }

  // Switch to shop with optional category selection
  window._switchShopCat = function(topCatId, subCatId) {
    switchTab('shop');
    if (topCatId) {
      state._shopActiveTopCat = topCatId;
      state._shopActiveCat = subCatId || topCatId;
    }
    setTimeout(renderShop, 100);
  };

  function switchTab(id) {
    if (id === 'tools') id = 'shop'; // Tools tab removed — redirect to shop
    state.ui.tab = id;
    savePersist();
    $$('.nav-btn, .nav-mobile-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${id}`));
    // Animate nav indicator
    _positionNavIndicator(id);
    if (id === 'robux') { startRobuxStock(); loadRobuxQuote(); updateRobuxStock(); loadRobuxRecentOrders();
      if (document.body.dataset.layout === 'landing') _initRobuxBanner();
    }
    if (id === 'admin') adminLoad();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Re-trigger reveal for newly visible tab
    setTimeout(initScrollReveal, 100);
    // Update sidebar if in dashboard mode
    if (document.body.dataset.layout === 'dashboard') {
      const sidebar = document.getElementById('layout-sidebar');
      sidebar?.querySelectorAll('.lsb-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === id);
      });
    }
    // Update cyber nav if in cyber mode
    if (document.body.dataset.layout === 'cyber') {
      document.querySelectorAll('.cyber-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.cyberTab === id);
      });
    }
    // Re-apply i18n on new tab content
    if ((localStorage.getItem('rst_lang') || 'ru') !== 'ru') setTimeout(window._applyI18n, 300);
  }

  // Auth
  async function checkAuth() {
    // Clear any leftover scroll lock from previous sessions
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    try {
      const data = await api('/api/auth/me');
      if (data.user) { state.user = data.user; updateAuthUI(); }
    } catch (e) { state.user = null; updateAuthUI(); }
  }

  // ── Scroll lock helper (used by overlays: ban, VPN, maintenance) ──
  function _lockBodyScroll(lock) {
    if (lock) {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    }
  }

  function _showBanScreen(reason, bannedUntil) {
    _lockBodyScroll(true);
    let overlay = document.getElementById('banOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'banOverlay';
      document.body.appendChild(overlay);
    }
    const untilTxt = bannedUntil ? ` до ${_fmtDatetime(bannedUntil)}` : ' навсегда';
    overlay.innerHTML = `
      <style>
        #banOverlay{position:fixed;inset:0;background:linear-gradient(135deg,#0a0010 0%,#110005 50%,#07000e 100%);z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px;overflow:hidden}
        #banOverlay::before{content:'';position:absolute;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,rgba(239,68,68,.08) 0%,transparent 70%);top:50%;left:50%;transform:translate(-50%,-50%);animation:banBeat 3s ease-in-out infinite}
        #banOverlay::after{content:'';position:absolute;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(239,68,68,.12) 0%,transparent 70%);top:50%;left:50%;transform:translate(-50%,-50%);animation:banBeat 3s ease-in-out infinite .4s}
        @keyframes banBeat{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.5}50%{transform:translate(-50%,-50%) scale(1.15);opacity:1}}
        .ban-card{max-width:440px;width:100%;background:rgba(15,5,10,.85);border:1px solid rgba(239,68,68,.3);border-radius:24px;padding:40px 32px;text-align:center;position:relative;z-index:2;backdrop-filter:blur(20px);box-shadow:0 0 60px rgba(239,68,68,.12),0 24px 80px rgba(0,0,0,.6);animation:banCardIn .6s cubic-bezier(.34,1.56,.64,1) both}
        @keyframes banCardIn{from{opacity:0;transform:translateY(30px) scale(.9)}to{opacity:1;transform:none}}
        .ban-icon-wrap{width:88px;height:88px;border-radius:50%;background:rgba(239,68,68,.1);border:2px solid rgba(239,68,68,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;animation:banIconPulse 2.5s ease-in-out infinite;font-size:44px}
        @keyframes banIconPulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.3)}50%{box-shadow:0 0 0 14px rgba(239,68,68,0)}}
        .ban-title{font-size:28px;font-weight:900;color:#ef4444;margin-bottom:6px;letter-spacing:-.5px;animation:banFadeUp .5s ease both .15s;opacity:0}
        .ban-subtitle{font-size:15px;color:rgba(255,255,255,.5);margin-bottom:22px;animation:banFadeUp .5s ease both .25s;opacity:0}
        @keyframes banFadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        .ban-reason-box{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);border-radius:14px;padding:14px 18px;margin-bottom:22px;text-align:left;animation:banFadeUp .5s ease both .35s;opacity:0}
        .ban-reason-label{font-size:10px;color:#ef4444;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
        .ban-reason-text{font-size:14px;color:rgba(255,255,255,.7);line-height:1.5}
        .ban-footer{font-size:12px;color:rgba(255,255,255,.25);border-top:1px solid rgba(255,255,255,.06);padding-top:16px;margin-top:4px;line-height:1.6;animation:banFadeUp .5s ease both .45s;opacity:0}
        .ban-btn{margin-top:14px;padding:11px 28px;background:linear-gradient(135deg,rgba(239,68,68,.15),rgba(239,68,68,.08));border:1px solid rgba(239,68,68,.35);color:#ef4444;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;animation:banFadeUp .5s ease both .5s;opacity:0;width:100%}
        .ban-btn:hover{background:rgba(239,68,68,.2);transform:translateY(-1px)}
        /* particles */
        .ban-particle{position:absolute;width:4px;height:4px;border-radius:50%;background:rgba(239,68,68,.4);animation:banParticle var(--dur,4s) ease-in-out var(--del,0s) infinite;left:var(--x,50%);top:var(--y,50%);pointer-events:none}
        @keyframes banParticle{0%,100%{transform:translate(0,0) scale(1);opacity:.3}50%{transform:translate(var(--tx,20px),var(--ty,-30px)) scale(1.5);opacity:.7}}
      </style>
      <div class="ban-particle" style="--x:15%;--y:20%;--dur:5s;--del:0s;--tx:30px;--ty:-40px"></div>
      <div class="ban-particle" style="--x:85%;--y:30%;--dur:4s;--del:.8s;--tx:-20px;--ty:30px"></div>
      <div class="ban-particle" style="--x:70%;--y:80%;--dur:6s;--del:1.5s;--tx:10px;--ty:-50px"></div>
      <div class="ban-particle" style="--x:25%;--y:70%;--dur:4.5s;--del:.3s;--tx:40px;--ty:20px"></div>
      <div class="ban-card">
        <div class="ban-icon-wrap">🚫</div>
        <div class="ban-title">Аккаунт заблокирован</div>
        <div class="ban-subtitle">Заблокирован администратором${untilTxt}</div>
        <div class="ban-reason-box">
          <div class="ban-reason-label">Причина блокировки</div>
          <div class="ban-reason-text">${escapeHtml(reason || 'Нарушение правил сервиса')}</div>
        </div>
        <div class="ban-footer">
          Если вы считаете это ошибкой — свяжитесь с поддержкой через другой аккаунт или напишите нам.<br>
          Создание новых аккаунтов для обхода блокировки ведёт к расширенному бану.
        </div>
        <button class="ban-btn" onclick="document.getElementById('banOverlay').remove(); fetch('/api/auth/logout',{method:'POST'}).finally(()=>location.reload())">
          Выйти из аккаунта
        </button>
      </div>`;
  }

  function _hideBanScreen() {
    document.getElementById('banOverlay')?.remove();
    _lockBodyScroll(false);
  }

  function updateAuthUI() {
    const auth = $('#authCard'), profile = $('#profileContent'), bal = $('#balanceBtn'), avatar = $('#avatarBtn');
    if (state.user) {
      // ── Full ban: block the entire UI ──────────────────────────
      if (state.user.banned && !state.user.is_admin) {
        _showBanScreen(state.user.ban_reason, state.user.banned_until);
        return;
      }
      _hideBanScreen();

      auth?.classList.add('hidden');
      profile?.classList.remove('hidden');
      bal?.classList.remove('hidden');
      const letter = (state.user.username || '?')[0].toUpperCase();
      const avUrl = (state.user.avatar_url || '').trim();

      // Header avatar
      const avatarImg = $('#avatarImg');
      const avatarLetter = $('#avatarLetter');
      if (avatarLetter) avatarLetter.textContent = letter;
      if (avatarImg && avUrl) {
        avatarImg.src = `${avUrl}${avUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
        avatarImg.classList.remove('hidden');
        avatarLetter?.classList.add('hidden');
      } else {
        avatarImg?.classList.add('hidden');
        avatarLetter?.classList.remove('hidden');
      }

      // Profile avatar
      const pImg = $('#profileAvatarImg');
      const pLetter = $('#profileAvatarLetter');
      const profileAvBg = $('#profileAvatar'); // parent circle div
      // Reset button (only when custom avatar is set)
      $('#btnAvatarReset')?.classList.toggle('hidden', !avUrl);
      if (pLetter) pLetter.textContent = letter;
      if (pImg && avUrl) {
        const ts = Date.now();
        pImg.src = `${avUrl}${avUrl.includes('?') ? '&' : '?'}v=${ts}`;
        pImg.style.display = 'block';
        pImg.classList.remove('hidden');
        pLetter && (pLetter.style.display = 'none');
        pLetter?.classList.add('hidden');
        if (profileAvBg) profileAvBg.style.background = 'transparent';
      } else {
        pImg && (pImg.style.display = 'none');
        pImg?.classList.add('hidden');
        pLetter && (pLetter.style.display = '');
        pLetter?.classList.remove('hidden');
        if (profileAvBg) profileAvBg.style.background = 'var(--accent-gradient)';
      }

      $('#profileName') && ($('#profileName').textContent = state.user.username || 'User');
      $('#profileId') && ($('#profileId').textContent = state.user.id ?? '—');
      updateBalance();
      updateStats();
      // Badges
      $('#badgePremium')?.classList.toggle('hidden', !isPremiumActive());
      $('#badgeAdmin')?.classList.toggle('hidden', !state.user.is_admin);
      // Profile analytics
      profileRefreshAnalytics(false).catch(() => {});
      // Update dropdown
      updateDropdownUser();
      // Sync balance display immediately from state (updateBalance() will refresh async)
      _applyBalance(state.user.balance ?? 0);
      const isAdmin = !!state.user.is_admin;
      $$('[data-tab="admin"]').forEach(b => b.classList.toggle('hidden', !isAdmin));
      // Show stats reset button only for admins
      const statsReset = document.getElementById('btnProfileStatsReset');
      if (statsReset) statsReset.classList.toggle('hidden', !isAdmin);
      // Start real-time polling for balance/premium
      startRealtimePolling();
      // Notifications
      document.getElementById('notifBellBtn')?.classList.remove('hidden');
      checkNotifBadge();
    } else {
      auth?.classList.remove('hidden');
      profile?.classList.add('hidden');
      bal?.classList.add('hidden');
      document.getElementById('notifBellBtn')?.classList.add('hidden');
      document.getElementById('notifDropdown')?.classList.add('hidden');
      $$('[data-tab="admin"]').forEach(b => b.classList.add('hidden'));
      stopRealtimePolling();
    }

    // Refresh Robux purchase mode toggle (depends on Premium)
    _updatePurchaseModeUI();
  }

  function _applyBalance(raw) {
    const b = typeof raw === 'number' ? raw : (parseInt(raw) || 0);
    const currency = localStorage.getItem('rst_currency') || 'rub';
    const rate = 0.011; // RUB to USD
    const symbol = currency === 'usd' ? '$' : '₽';
    const locale = currency === 'usd' ? 'en-US' : 'ru-RU';
    
    // Convert balance if USD
    const displayBalance = currency === 'usd' ? (b * rate).toFixed(2) : b.toLocaleString('ru-RU');
    const fmt = displayBalance + ' ' + symbol;
    
    // Update every possible element
    ['balanceValue', 'statBalance', 'dropdownBalance', 'profileBalanceVal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = fmt;
    });
    // Also update balance chip label
    const chip = document.getElementById('balanceChipLabel');
    if (chip) chip.textContent = fmt;
    if (state.user) state.user.balance = b;
    // Update premium badge
    const isPrem = isPremiumActive();
    document.getElementById('badgePremium')?.classList.toggle('hidden', !isPrem);
    document.getElementById('dropdownPremium')?.classList.toggle('hidden', !isPrem);
    // Update stats
    _applyStats();
  }

  function _applyStats() {
    if (!state.user) return;
    const pu = state.user.premium_until;
    const isPrem = isPremiumActive();
    const el = document.getElementById('statPremium');
    if (el) {
      if (isPrem && pu) {
        const d = new Date(pu.includes('Z') || pu.includes('+') ? pu : pu + 'Z');
        const now = new Date();
        const diffMs = d - now;
        const diffH = diffMs / 3600000;
        let timeStr;
        if (diffH < 1) timeStr = `${Math.floor(diffMs/60000)} мин.`;
        else if (diffH < 24) timeStr = `${Math.round(diffH)} ч.`;
        else {
          const days = Math.floor(diffMs / 86400000);
          timeStr = `${days} дн.`;
        }
        el.innerHTML = `<span style="font-size:13px;color:var(--accent-tertiary);font-weight:800">✅ Активен</span><br><span style="font-size:10px;color:var(--text-muted)">${_fmtDatetime(pu)}</span><br><span style="font-size:10px;color:#22c55e">ещё ${timeStr}</span>`;
      } else {
        el.innerHTML = `<span style="font-size:13px;color:var(--text-muted)">—</span>`;
      }
    }
    const credEl = document.getElementById('statGenerations');
    if (credEl) credEl.textContent = state.user.credits_analyze ?? '—';
    const aiEl = document.getElementById('statAI');
    if (aiEl) aiEl.textContent = state.user.credits_ai ?? '—';
  }

  async function updateBalance() {
    if (!state.user) return;
    _applyBalance(state.user.balance ?? 0);
    try {
      const d = await api('/api/balance', { silent: true });
      if (!d || d.balance === undefined) return;
      const b = typeof d.balance === 'number' ? d.balance : (parseInt(d.balance) || 0);
      _applyBalance(b);
    } catch (e) { /* silent */ }
  }

  async function refreshUserState() {
    // Full re-fetch of user state from server
    try {
      const data = await api('/api/auth/me');
      if (data && data.user) {
        state.user = data.user;
        updateAuthUI();
      }
    } catch(e) {}
  }

  async function showBalanceHistory() {
    try {
      loading(true);
      const d = await api('/api/balance/history?limit=20');
      const txs = d.history || [];
      const rows = txs.length === 0
        ? '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:20px">Транзакций нет</td></tr>'
        : txs.map(tx => {
            const sign = tx.delta >= 0 ? '+' : '';
            const color = tx.delta >= 0 ? '#22c55e' : '#ef4444';
            const date = tx.ts ? _fmtDatetime(tx.ts) : '—';
            return `<tr>
              <td style="color:${color};font-weight:700;padding:8px 10px">${sign}${fmtCurrency(tx.delta)}</td>
              <td style="color:var(--text-secondary);font-size:12px;padding:8px 10px">${escapeHtml(tx.reason||'—')}</td>
              <td style="color:var(--text-muted);font-size:11px;padding:8px 10px">${date}</td>
            </tr>`;
          }).join('');
      modal(`
        <h2 style="margin:0 0 16px">💳 История баланса</h2>
        <div style="overflow-x:auto;max-height:400px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
              <th style="text-align:left;padding:6px 10px;color:var(--text-muted)">Сумма</th>
              <th style="text-align:left;padding:6px 10px;color:var(--text-muted)">Причина</th>
              <th style="text-align:left;padding:6px 10px;color:var(--text-muted)">Дата</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:16px" onclick="closeModal()">Закрыть</button>
      `, {size:'wide'});
    } catch(e) { toast(e.message||'Ошибка', 'error'); }
    finally { loading(false); }
  }

  function updateStats() {
    _applyStats();
  }

  function isPremiumActive() {
    const pu = state.user?.premium_until;
    return !!pu && new Date(pu) > new Date();
  }

  // Helper: format currency based on user's currency setting
  function fmtCurrency(amount, options = {}) {
    const currency = localStorage.getItem('rst_currency') || 'rub';
    const rate = 0.011; // RUB to USD
    const symbol = currency === 'usd' ? '$' : '₽';
    
    if (currency === 'usd') {
      const usdAmount = (amount * rate).toFixed(2);
      return options.noSign ? usdAmount : usdAmount + ' ' + symbol;
    } else {
      const rubAmount = typeof amount === 'number' ? amount.toLocaleString('ru-RU') : amount;
      return options.noSign ? rubAmount : rubAmount + ' ' + symbol;
    }
  }

  // Avatar upload (Profile)
  function initAvatarUpload() {
    const input = $('#avatarFileInput');
    const trigger = $('#profileAvatar');
    const resetBtn = $('#btnAvatarReset');
    if (!input || !trigger) return;

    trigger.addEventListener('click', () => {
      if (!state.user) { showLogin(); return; }
      input.value = '';
      input.click();
    });

    // Reset (remove) avatar
    resetBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.user) { showLogin(); return; }
      if (!confirm('Сбросить аватар и вернуть стандартную иконку?')) return;
      try {
        loading(true);
        await api('/api/user/avatar/reset', { method: 'POST', body: JSON.stringify({}) });
        state.user.avatar_url = '';
        toast('Аватар сброшен', 'success');
        updateAuthUI();
      } catch (err) {
        toast(err.message || 'Ошибка', 'error');
      } finally {
        loading(false);
      }
    });

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!state.user) { toast('Нужна авторизация', 'error'); return; }
      if (file.size > 5 * 1024 * 1024) { toast('Файл слишком большой (до 5 МБ)', 'error'); return; }
      const okTypes = ['image/png', 'image/jpeg', 'image/webp'];
      if (!okTypes.includes(file.type)) { toast('Формат: PNG/JPG/WebP', 'error'); return; }

      // Show crop modal
      const reader = new FileReader();
      reader.onload = (ev) => _showAvatarCropModal(ev.target.result, file.type);
      reader.readAsDataURL(file);
    });
  }

  // ----------------------------
  // Profile Analytics (Chart.js)
  // ----------------------------
  let _profileChart = null;
  let _profileTxCache = { items: null, fetchedAt: 0 };
  const _profileChartState = { mode: 'all', days: 7 };

  function _fmtMoney(v) {
    const n = Math.round(Number(v || 0));
    const curr = localStorage.getItem('rst_currency') || 'rub';
    if (curr === 'usd') {
      const rate = parseFloat(localStorage.getItem('rst_exchange_rate') || '0') || 0.011;
      const usd = (n * rate).toFixed(2);
      return `${usd} $`;
    }
    return `${n.toLocaleString('ru-RU')} ₽`;
  }

  function _dateKeyFromTs(ts) {
    const s = String(ts || '');
    // FastAPI stores ISO like: 2026-01-28T12:34:56.123456
    if (s.length >= 10) return s.slice(0, 10);
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    } catch (e) {}
    return '';
  }

  function _keyToLabel(key) {
    // YYYY-MM-DD -> DD.MM
    if (!key || key.length < 10) return key || '';
    return `${key.slice(8, 10)}.${key.slice(5, 7)}`;
  }

  async function profileFetchTx(force = false) {
    if (!state.user) return [];
    const now = Date.now();
    if (!force && _profileTxCache.items && (now - _profileTxCache.fetchedAt) < 60_000) return _profileTxCache.items;
    const d = await api('/api/user/tx?limit=200');
    const items = Array.isArray(d.items) ? d.items : [];
    _profileTxCache = { items, fetchedAt: now };
    return items;
  }

  function profileAggregate(items, days) {
    const map = new Map(); // key -> {topups, spends, net}
    for (const it of (items || [])) {
      const key = _dateKeyFromTs(it.ts);
      if (!key) continue;
      const delta = Number(it.delta || 0);
      const cur = map.get(key) || { topups: 0, spends: 0, net: 0 };
      cur.net += delta;
      if (delta > 0) cur.topups += delta;
      if (delta < 0) cur.spends += Math.abs(delta);
      map.set(key, cur);
    }

    // Build continuous range
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));

    const labels = [];
    const topups = [];
    const spends = [];
    const net = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const v = map.get(key) || { topups: 0, spends: 0, net: 0 };
      labels.push(_keyToLabel(key));
      topups.push(v.topups);
      spends.push(v.spends);
      net.push(v.net);
    }

    const sumTopups = topups.reduce((a, b) => a + b, 0);
    const sumSpends = spends.reduce((a, b) => a + b, 0);
    const sumNet = net.reduce((a, b) => a + b, 0);

    return { labels, topups, spends, net, sumTopups, sumSpends, sumNet };
  }

  function profileRenderChart(agg) {
    const canvas = document.getElementById('profileChart');
    const empty = document.getElementById('profileChartEmpty');
    if (!canvas) return;

    // If Chart.js isn't loaded, show a simple fallback
    if (!window.Chart) {
      if (empty) { empty.textContent = 'График недоступен (Chart.js не загрузился)'; empty.classList.remove('hidden'); }
      return;
    }

    const mode = _profileChartState.mode || 'all';
    const datasets = [];
    if (mode === 'all' || mode === 'topups') {
      datasets.push({
        label: 'Пополнения',
        data: agg.topups,
        tension: 0.35,
        borderColor: 'rgba(138, 87, 255, 1)',
        backgroundColor: 'rgba(138, 87, 255, 0.18)',
        fill: false,
        pointRadius: 0,
        borderWidth: 2,
      });
    }
    if (mode === 'all' || mode === 'spends') {
      datasets.push({
        label: 'Траты',
        data: agg.spends,
        tension: 0.35,
        borderColor: 'rgba(239, 68, 68, 1)',
        backgroundColor: 'rgba(239, 68, 68, 0.16)',
        fill: false,
        pointRadius: 0,
        borderWidth: 2,
      });
    }

    const hasAny = (agg.topups.some(v => v > 0) || agg.spends.some(v => v > 0) || agg.net.some(v => v !== 0));
    if (empty) empty.classList.toggle('hidden', hasAny);

    // KPIs
    document.getElementById('kpiTopups') && (document.getElementById('kpiTopups').textContent = _fmtMoney(agg.sumTopups));
    document.getElementById('kpiSpends') && (document.getElementById('kpiSpends').textContent = _fmtMoney(agg.sumSpends));
    document.getElementById('kpiNet') && (document.getElementById('kpiNet').textContent = _fmtMoney(agg.sumNet));

    if (_profileChart) {
      _profileChart.destroy();
      _profileChart = null;
    }

    // Fix: constrain canvas parent to prevent infinite growth
    const wrap = canvas.parentElement;
    if (wrap) { wrap.style.height = '200px'; wrap.style.position = 'relative'; wrap.style.overflow = 'hidden'; }
    canvas.style.maxHeight = '200px';

    _profileChart = new Chart(canvas, {
      type: 'line',
      data: { labels: agg.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: '#cfcfe6', boxWidth: 10, boxHeight: 10 } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${_fmtMoney(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: 'rgba(255,255,255,0.65)' }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: {
              color: 'rgba(255,255,255,0.65)',
              callback: (v) => {
                const curr = localStorage.getItem('rst_currency') || 'rub';
                if (curr === 'usd') {
                  const rate = parseFloat(localStorage.getItem('rst_exchange_rate') || '0') || 0.011;
                  return '$' + (v * rate).toFixed(0);
                }
                return `${v}₽`;
              }
            }
          }
        }
      }
    });
  }

  async function profileRefreshAnalytics(force = false) {
    try {
      const card = document.getElementById('profileAnalyticsCard');
      if (!state.user || !card) return;
      const items = await profileFetchTx(force);
      const agg = profileAggregate(items, _profileChartState.days || 7);
      profileRenderChart(agg);
    } catch (e) {
      // silent
    }
  }

  function initProfileAnalytics() {
    const mode = document.getElementById('profileStatsMode');
    const range = document.getElementById('profileStatsRange');
    const btnRefresh = document.getElementById('btnProfileStatsRefresh');

    mode?.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      mode.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      _profileChartState.mode = b.dataset.mode || 'all';
      profileRefreshAnalytics(false).catch(() => {});
    });

    range?.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      range.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      _profileChartState.days = parseInt(b.dataset.days || '7') || 7;
      profileRefreshAnalytics(false).catch(() => {});
    });

    btnRefresh?.addEventListener('click', () => {
      // Clear cache so we fetch fresh data
      try { if (_profileTxCache) _profileTxCache.items = null; } catch(e) {}
      profileRefreshAnalytics(true).catch(() => {});
      toast('График обновлён', 'success');
    });

    // Show stats reset button ONLY for admins (set by updateAuthUI after auth)
    const btnReset = document.getElementById('btnProfileStatsReset');

    btnReset?.addEventListener('click', () => {
      // Admin-only: full period-based stats reset
      modal(`
        <div style="padding:4px 0">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            <div style="width:40px;height:40px;border-radius:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);display:flex;align-items:center;justify-content:center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </div>
            <div>
              <h3 style="margin:0 0 3px;font-size:17px">Сброс статистики</h3>
              <div style="font-size:12px;color:var(--text-muted)">Выберите период для удаления данных</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:8px" onclick="window._doResetStats('all')">
              <span style="color:#ef4444">🔥</span> Очистить всё
            </button>
            <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:8px" onclick="window._doResetStats('7d')">
              <span>📅</span> За последние 7 дней
            </button>
            <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:8px" onclick="window._doResetStats('30d')">
              <span>📅</span> За последние 30 дней
            </button>
            <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:8px" onclick="window._doResetStats('90d')">
              <span>📅</span> За последние 90 дней
            </button>
            <div style="display:flex;gap:8px;align-items:center;margin-top:4px;padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid var(--border-color)">
              <input type="date" id="resetStatsFrom" class="form-input" style="flex:1;font-size:12px">
              <span style="color:var(--text-muted);font-size:12px;flex-shrink:0">→</span>
              <input type="date" id="resetStatsTo" class="form-input" style="flex:1;font-size:12px">
              <button class="btn btn-secondary btn-sm" onclick="window._doResetStats('custom')">OK</button>
            </div>
          </div>
          <button class="btn btn-ghost" style="width:100%;margin-top:12px" onclick="closeModal()">Отмена</button>
        </div>
      `, { size: 'small' });
    });

    // Balance history -> switch to purchases tab
    document.getElementById('btnTransactions')?.addEventListener('click', () => switchProfileTab('purchases'));
    document.getElementById('btnBalanceHistory')?.addEventListener('click', () => switchProfileTab('purchases'));
    document.getElementById('btnTelegramLinkCode')?.addEventListener('click', async () => {
      try {
        loading(true);
        const d = await api('/api/user/telegram/link_code', { method: 'POST', body: {} });
        modal(`
          <div style="text-align:center;padding:6px 0 2px">
            <div style="width:56px;height:56px;border-radius:16px;background:rgba(59,130,246,.12);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </div>
            <h3 style="margin:0 0 8px;font-size:20px">Код для Telegram</h3>
            <div style="font-size:13px;color:var(--text-muted);line-height:1.55;margin-bottom:16px">Отправь этот код боту командой <code>/link ${escapeHtml(d.code || '')}</code>. Код действует 10 минут.</div>
            <div style="font-size:32px;font-weight:900;letter-spacing:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 14px;margin-bottom:16px">${escapeHtml(d.code || '')}</div>
            <button class="btn btn-primary" style="width:100%" onclick="navigator.clipboard?.writeText('${escapeHtml(d.code || '')}');toast('Код скопирован','success')">Скопировать код</button>
            <button class="btn btn-ghost" style="width:100%;margin-top:8px" onclick="closeModal()">Закрыть</button>
          </div>
        `, { size: 'small' });
      } catch (e) {
        toast(e.message || 'Не удалось создать код Telegram', 'error');
      } finally {
        loading(false);
      }
    });

    // Profile inner tabs
    $$('#profileInnerTabs .profile-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchProfileTab(btn.dataset.ptab));
    });

    // Purchases refresh
    document.getElementById('btnRefreshPurchases')?.addEventListener('click', () => loadPurchasesList());

    // Chat tab buttons
    document.getElementById('btnOpenSupportFromProfile')?.addEventListener('click', () => {
      const supportBtn = document.getElementById('btnSupport');
      supportBtn?.click();
    });
    document.getElementById('btnOpenAIFromProfile')?.addEventListener('click', () => {
      // Navigate to support and open AI chat
      const supportBtn = document.getElementById('btnSupport');
      if (supportBtn) { supportBtn.click(); setTimeout(() => document.querySelector('.sup-faq-btn[data-action="ai"]')?.click(), 400); }
    });
  }

  function switchProfileTab(tab) {
    $$('#profileInnerTabs .profile-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.ptab === tab));
    $$('.profile-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.ptabPane === tab));
    if (tab === 'purchases') loadPurchasesList();
  }

  // ── Shared purchases renderer (profile tab + popup modal) ──────
  let _purchasesPage = 0;
  const _PURCHASES_PER_PAGE = 8;
  let _purchasesData = [];
  const _PUR_ROW_H = 63;
  const _PUR_FIXED_H = _PURCHASES_PER_PAGE * _PUR_ROW_H + 8;

  function _buildPurchaseRows(slice, purchases) {
    const icons = {account:'👤',digital:'🔑',gift:'🎁',service:'🛠',robux:'🟣',other:'📦'};
    return slice.map(p => {
      const icon = icons[p.item_type] || '📦';
      let statusBadge = '';
      if (p.item_type === 'robux' && p.delivery?.status_text) {
        const sc = {done:'#22c55e',processing:'#f59e0b',paid:'#3b82f6',reserved:'#8b5cf6',refunded:'#ef4444',error:'#ef4444',expired:'#6b7280'};
        const col = sc[p.delivery.status] || '#8b5cf6';
        statusBadge = `<span style="font-size:10px;padding:2px 7px;border-radius:20px;background:${col}22;color:${col};font-weight:600">${escapeHtml(p.delivery.status_text)}</span>`;
      }
      return `<div class="pur-row" data-purchase-id="${p.id}" style="display:flex;gap:12px;align-items:center;padding:11px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);cursor:pointer;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,0.06)'" onmouseout="this.style.background='rgba(255,255,255,0.03)'">
        <div style="width:38px;height:38px;border-radius:10px;background:rgba(168,85,247,0.1);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            <span style="font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">${escapeHtml(p.product_title||'Товар')}</span>
            ${statusBadge}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${_fmtDatetime(p.ts)}</div>
        </div>
        ${p.price > 0 ? `<div style="font-size:13px;font-weight:700;color:#ef4444;flex-shrink:0">−${fmtCurrency(p.price)}</div>` : '<div style="font-size:12px;font-weight:700;color:#22c55e;flex-shrink:0">Бесплатно</div>'}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted);flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;
    }).join('');
  }

  function _renderPurchasesInto(cont, purchases, page, dir, idPrefix) {
    if (!cont) return;
    if (!purchases.length) {
      cont.innerHTML = `<div style="height:${_PUR_FIXED_H}px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--text-muted)">
        <div style="font-size:40px">🛍</div>
        <div style="font-weight:600;font-size:14px">Покупок пока нет</div>
        <div style="font-size:12px">Покупайте товары в магазине</div></div>`;
      return;
    }
    const total = purchases.length;
    const totalPages = Math.ceil(total / _PURCHASES_PER_PAGE);
    const start = page * _PURCHASES_PER_PAGE;
    const slice = purchases.slice(start, start + _PURCHASES_PER_PAGE);
    const animDir = dir === 'back' ? 'tuPageBack' : 'tuPageIn';
    const rowsHtml = _buildPurchaseRows(slice, purchases);

    const pagination = totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);margin-top:8px">
        <button class="btn btn-secondary btn-sm" id="${idPrefix}Prev" ${page===0?'disabled':''} style="gap:5px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>Назад
        </button>
        <span style="font-size:12px;color:var(--text-muted)">${page+1} / ${totalPages} &middot; ${total} шт.</span>
        <button class="btn btn-secondary btn-sm" id="${idPrefix}Next" ${page>=totalPages-1?'disabled':''} style="gap:5px">
          Вперёд<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>` : '';

    cont.innerHTML = `
      <style>
        @keyframes purIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        @keyframes purBack{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
        .pur-anim-in{animation:purIn .18s ease both}
        .pur-anim-back{animation:purBack .18s ease both}
      </style>
      <div class="pur-anim-${dir==='back'?'back':'in'}" style="display:flex;flex-direction:column;gap:6px;min-height:${_PUR_FIXED_H}px">
        ${rowsHtml}
      </div>
      ${pagination}`;

    cont.querySelectorAll('.pur-row[data-purchase-id]').forEach(el => {
      el.addEventListener('click', () => _showPurchaseDetail(purchases.find(p => p.id == el.dataset.purchaseId)));
    });
    document.getElementById(`${idPrefix}Prev`)?.addEventListener('click', () => _renderPurchasesInto(cont, purchases, page-1, 'back', idPrefix));
    document.getElementById(`${idPrefix}Next`)?.addEventListener('click', () => _renderPurchasesInto(cont, purchases, page+1, 'in', idPrefix));
  }

  async function loadPurchasesList(page = 0) {
    const cont = document.getElementById('purchasesListContent');
    if (!cont) return;
    if (page === 0) {
      _purchasesData = [];
      cont.innerHTML = `<div style="height:${_PUR_FIXED_H}px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)"><div class="spinner"></div></div>`;
      try {
        const d = await api('/api/purchases');
        _purchasesData = d.purchases || [];
      } catch(e) {
        cont.innerHTML = `<div style="height:${_PUR_FIXED_H}px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">Ошибка загрузки</div>`;
        return;
      }
    }
    _purchasesPage = page;
    _renderPurchasesInto(cont, _purchasesData, page, 'in', 'purTab');
  }
  const RARITY_NAMES = {1:'Common',2:'Rare',3:'Epic',4:'Legendary',5:'Mythic'};
  const RARITY_COLORS = {1:'#9ca3af',2:'#3b82f6',3:'#a855f7',4:'#f59e0b',5:'#ef4444'};
  const RARITY_EMOJIS = {1:'⭐',2:'🔷',3:'💎',4:'✨',5:'🌟'};

  async function loadProfileInventory() {
    const grid = document.getElementById('inventoryGrid');
    if (!grid) return;
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">Загрузка...</div>';
    try {
      const d = await api('/api/inventory/list');
      const items = d.items || [];
      if (!items.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">Инвентарь пуст. Откройте кейсы!</div>';
        return;
      }
      grid.innerHTML = items.map(item => {
        const tier = casePrizeTier(item.prize);
        const rName = RARITY_NAMES[tier] || 'Common';
        const rColor = RARITY_COLORS[tier] || '#9ca3af';
        const label = casePrizeLabel(item.prize);
        const ts = String(item.created_at || '').replace('T',' ').slice(0,16);
        return `<div class="inv-item t${tier}">
          <div class="inv-item-icon">${tier >= 4 ? '✨' : tier >= 3 ? '💎' : tier >= 2 ? '🔷' : '📦'}</div>
          <div class="inv-item-name">${escapeHtml(label)}</div>
          <div class="inv-item-rarity" style="color:${rColor}">${rName}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:6px">${escapeHtml(ts)}</div>
          <div style="display:flex;gap:4px;justify-content:center">
            <button class="btn btn-primary btn-sm" onclick="window._invUse(${item.id})">Применить</button>
            <button class="btn btn-secondary btn-sm" onclick="window._invDel(${item.id})">Удалить</button>
          </div>
        </div>`;
      }).join('');
    } catch(e) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">Ошибка загрузки</div>';
    }
  }

  // Global inventory actions
  window._invUse = async function(id) {
    try {
      loading(true);
      await api('/api/inventory/use', { method:'POST', body:{item_id:id} });
      toast('Приз применён!', 'success');
      await checkAuth();
      loadProfileInventory();
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
    finally { loading(false); }
  };
  window._invDel = async function(id) {
    if (!confirm('Удалить предмет?')) return;
    try {
      loading(true);
      await api('/api/inventory/delete', { method:'POST', body:{item_id:id} });
      toast('Удалено', 'success');
      loadProfileInventory();
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
    finally { loading(false); }
  };

  async function loadHistorySubTab(sub) {
    const cont = document.getElementById('historyPaneContent');
    if (!cont) return;
    cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Загрузка...</div>';
    try {
      if (sub === 'topups') {
        const items = await profileFetchTx(true);
        const rows = (items || []).filter(r => Number(r.delta || 0) > 0).slice(0, 50);
        cont.innerHTML = rows.length ? rows.map(r => _histRow(r)).join('') : '<div style="text-align:center;padding:24px;color:var(--text-muted)">Нет пополнений</div>';
      } else if (sub === 'purchases') {
        try {
          const d = await api('/api/purchases');
          const purchases = d.purchases || [];
          if (!purchases.length) {
            cont.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)"><div style="font-size:32px;margin-bottom:8px">🛍</div><div>Покупок пока нет</div><div style="font-size:12px;margin-top:6px">Покупайте товары в магазине или активируйте ваучеры</div></div>';
          } else {
            cont.innerHTML = purchases.map(p => {
                const icons = {account:'👤',digital:'🔑',gift:'🎁',service:'🛠',robux:'🟣',other:'📦'};
                const icon = icons[p.item_type] || '📦';
                // Robux status badge
                let statusBadge = '';
                if (p.item_type === 'robux' && p.delivery?.status_text) {
                  const sc = {done:'#22c55e',processing:'#f59e0b',paid:'#3b82f6',reserved:'#8b5cf6',refunded:'#ef4444',error:'#ef4444',expired:'#6b7280'};
                  const col = sc[p.delivery.status] || '#8b5cf6';
                  statusBadge = `<span style="font-size:10px;padding:2px 8px;border-radius:20px;background:${col}22;color:${col};font-weight:600;margin-left:6px">${escapeHtml(p.delivery.status_text)}</span>`;
                }
                return `
              <div class="purchase-row" data-purchase-id="${p.id}">
                <div class="purchase-icon">${icon}</div>
                <div class="purchase-info">
                  <div class="purchase-title">${escapeHtml(p.product_title||'Товар')}${statusBadge}</div>
                  <div class="purchase-meta">${escapeHtml((p.ts||'').replace('T',' ').slice(0,16))}</div>
                  ${p.note ? `<div class="purchase-note">📝 ${escapeHtml(p.note)}</div>` : ''}
                </div>
                <div class="${p.price>0?'purchase-price':'purchase-price free'}">${p.price>0?'−'+p.price+' ₽':'Бесплатно'}</div>
                <div class="purchase-arrow">›</div>
              </div>`}).join('');
            cont.querySelectorAll('[data-purchase-id]').forEach(el => {
              el.addEventListener('click', () => _showPurchaseDetail(purchases.find(p => p.id == el.dataset.purchaseId)));
            });
          }
        } catch(e) {
          cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Ошибка загрузки</div>';
        }
      } else {
        const toolName = sub === 'checker' ? 'checker' : 'description';
        const d = await api('/api/user/tool_history?tool=' + toolName);
        const items = d.items || [];
        cont.innerHTML = items.length ? items.map(h => {
          const ts = String(h.ts || '').replace('T',' ').slice(0,19);
          const ok = h.status === 'ok' || h.status === 'valid';
          return `<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="min-width:80px;font-size:12px;color:var(--text-muted)">${escapeHtml(ts)}</div>
            <div style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(h.result || h.input || '—')}</div>
            <div style="font-size:12px;color:${ok ? 'var(--success)' : 'var(--danger)'}">${ok ? 'OK' : escapeHtml(h.status)}</div></div>`;
        }).join('') : '<div style="text-align:center;padding:24px;color:var(--text-muted)">Нет записей</div>';
      }
    } catch(e) { cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Ошибка</div>'; }
  }
  function _purchaseRow(p) {
    const ts = String(p.ts || '').replace('T',' ').slice(0,16);
    const meta = {account:'👤 Аккаунт',digital:'🔑 Ключ',service:'🛠 Услуга',gift:'🎁 Гифт',other:'📦 Прочее'};
    const typeLabel = meta[p.item_type] || '📦 Товар';
    return `<div class="purchase-row" data-purchase-id="${p.id}" style="display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);cursor:pointer;margin-bottom:6px;transition:border-color .2s" onmouseover="this.style.borderColor='rgba(147,51,234,0.3)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.06)'">
      <div style="font-size:20px;flex-shrink:0">${typeLabel.split(' ')[0]}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.product_title||'Товар')}</div>
        <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(ts)} · ${typeLabel.split(' ').slice(1).join(' ')}</div>
        ${p.note ? `<div style="font-size:11px;color:var(--accent-tertiary);margin-top:2px">📝 ${escapeHtml(p.note)}</div>` : ''}
      </div>
      ${p.price > 0 ? `<div style="font-size:12px;font-weight:700;color:var(--danger);flex-shrink:0">−${fmtCurrency(p.price)}</div>` : '<div style="font-size:11px;color:#22c55e;flex-shrink:0">Бесплатно</div>'}
      <div style="color:var(--text-muted);font-size:16px">›</div>
    </div>`;
  }

  function _showPurchaseDetail(p) {
    if (!p) return;
    const d = p.delivery || {};
    const ts = String(p.ts || '').replace('T',' ').slice(0,16);
    const fmtDate = (s) => s ? String(s).replace('T',' ').slice(0,16) : '';
    // Build delivery display
    let deliveryHtml = '';
    if (p.item_type === 'robux') {
      // Robux order detail
      const statusColors = {done:'#22c55e',processing:'#f59e0b',paid:'#3b82f6',reserved:'#8b5cf6',cancelled:'#6b7280',refunded:'#ef4444',error:'#ef4444',expired:'#6b7280',failed:'#ef4444'};
      const sc = statusColors[d.status] || '#8b5cf6';
      const canCancel = ['paid'].includes(d.status);
      const canCancelBooking = d.status === 'reserved';
      deliveryHtml = `
        <div style="padding:20px;background:linear-gradient(135deg,${sc}08,${sc}04);border:1px solid ${sc}25;border-radius:16px;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <div style="width:44px;height:44px;border-radius:12px;background:${sc}18;display:flex;align-items:center;justify-content:center;font-size:20px">🟣</div>
            <div style="flex:1">
              <div style="font-weight:700;font-size:16px">${d.robux_amount || 0} Robux</div>
              <div style="display:inline-block;padding:3px 12px;border-radius:20px;background:${sc}20;color:${sc};font-weight:700;font-size:11px;margin-top:4px;letter-spacing:.3px">${escapeHtml(d.status_text || d.status || '—')}</div>
            </div>
          </div>

          <div style="display:grid;gap:8px">
            ${d.gamepass_name ? `<div style="display:flex;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,.03);border-radius:8px;font-size:13px"><span style="color:var(--text-muted)">Геймпасс</span><span style="font-weight:600">${escapeHtml(d.gamepass_name)}</span></div>` : ''}
            ${d.gamepass_owner ? `<div style="display:flex;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,.03);border-radius:8px;font-size:13px"><span style="color:var(--text-muted)">Владелец</span><span style="font-weight:600">${escapeHtml(d.gamepass_owner)}</span></div>` : ''}
            <div style="display:flex;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,.03);border-radius:8px;font-size:13px"><span style="color:var(--text-muted)">Списано</span><span style="font-weight:700;color:var(--danger)">−${fmtCurrency(p.price)}</span></div>
          </div>

          <!-- Timeline -->
          <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.06)">
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Хронология</div>
            <div style="display:grid;gap:6px;font-size:12px;color:var(--text-secondary)">
              ${d.created_at ? `<div style="display:flex;gap:8px;align-items:center"><span style="color:var(--text-muted);min-width:14px">📝</span> Заказ создан: <b>${fmtDate(d.created_at)}</b></div>` : ''}
              ${d.paid_at ? `<div style="display:flex;gap:8px;align-items:center"><span style="color:var(--text-muted);min-width:14px">💳</span> Оплачен: <b>${fmtDate(d.paid_at)}</b></div>` : ''}
              ${d.done_at ? `<div style="display:flex;gap:8px;align-items:center"><span style="color:#22c55e;min-width:14px">✅</span> Доставлено: <b>${fmtDate(d.done_at)}</b></div>` : ''}
              ${d.cancelled_at ? `<div style="display:flex;gap:8px;align-items:center"><span style="color:#6b7280;min-width:14px">🚫</span> Отменён: <b>${fmtDate(d.cancelled_at)}</b></div>` : ''}
            </div>
          </div>

          ${d.cancel_reason ? `<div style="margin-top:10px;padding:10px 12px;background:rgba(107,114,128,.08);border:1px solid rgba(107,114,128,.15);border-radius:10px;font-size:12px;color:var(--text-secondary)"><b>Причина отмены:</b> ${escapeHtml(d.cancel_reason)}</div>` : ''}
          ${d.error ? `<div style="margin-top:10px;padding:10px 12px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:10px;font-size:12px;color:var(--danger)"><b>Ошибка:</b> ${escapeHtml(d.error)}</div>` : ''}

          ${['paid','processing'].includes(d.status) ? `
            <div style="margin-top:12px;padding:12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:12px;font-size:12px;color:var(--text-secondary);text-align:center;line-height:1.5">
              Робуксы появятся в <b>Pending</b>. <a href="https://www.roblox.com/transactions" target="_blank" style="color:var(--accent-tertiary)">Проверить →</a>
            </div>` : ''}
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${d.gamepass_url ? `<a href="https://www.roblox.com/game-pass/${d.gamepass_url}" target="_blank" class="btn btn-secondary" style="flex:1;text-align:center;text-decoration:none;font-size:13px">Открыть геймпасс</a>` : ''}
          ${canCancel ? `<button class="btn btn-ghost" id="cancelOrderBtn" style="flex:1;color:var(--danger);font-size:13px;border:1px solid rgba(239,68,68,.2)">Отменить заказ</button>` : ''}
          ${canCancelBooking ? `<button class="btn btn-ghost" id="cancelOrderBtn" style="flex:1;color:var(--warning);font-size:13px;border:1px solid rgba(245,158,11,.2)">Отменить бронирование</button>` : ''}
        </div>`;
    } else if (p.item_type === 'account') {
      const login = d.login || d.username || '';
      const pass = d.password || d.pass || '';
      const email = d.email || '';
      const hasSteamGuard = !!(d.shared_secret);
      deliveryHtml = `
        <div class="deliv-card deliv-account">
          <div class="deliv-head">👤 Данные аккаунта</div>
          ${login ? `<div class="deliv-row"><span class="deliv-label">Логин</span><div class="deliv-val-wrap"><span class="deliv-val">${escapeHtml(login)}</span><button class="deliv-copy" data-copy="${escapeHtml(login)}">📋</button></div></div>` : ''}
          ${pass ? `<div class="deliv-row"><span class="deliv-label">Пароль</span><div class="deliv-val-wrap"><span class="deliv-val">${escapeHtml(pass)}</span><button class="deliv-copy" data-copy="${escapeHtml(pass)}">📋</button></div></div>` : ''}
          ${email ? `<div class="deliv-row"><span class="deliv-label">Email</span><div class="deliv-val-wrap"><span class="deliv-val">${escapeHtml(email)}</span><button class="deliv-copy" data-copy="${escapeHtml(email)}">📋</button></div></div>` : ''}
          ${d.extra ? `<div class="deliv-row"><span class="deliv-label">Инфо</span><div class="deliv-val">${escapeHtml(d.extra)}</div></div>` : ''}
        </div>
        ${hasSteamGuard ? `
        <div style="margin-top:12px;padding:16px;background:linear-gradient(135deg,rgba(34,197,94,.04),rgba(34,197,94,.01));border:1px solid rgba(34,197,94,.15);border-radius:14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
            <div style="width:32px;height:32px;border-radius:8px;background:rgba(34,197,94,.1);display:flex;align-items:center;justify-content:center;font-size:16px">🛡️</div>
            <div>
              <div style="font-weight:700;font-size:13px;color:#22c55e">Steam Guard</div>
              <div style="font-size:10px;color:var(--text-muted)">Двухфакторная аутентификация</div>
            </div>
          </div>
          <div style="text-align:center;padding:12px 16px;background:rgba(0,0,0,.15);border-radius:10px;border:1px solid rgba(34,197,94,.1)">
            <div id="steamGuardCode" style="font-family:'Share Tech Mono',monospace;font-size:36px;font-weight:900;letter-spacing:8px;color:#22c55e;text-shadow:0 0 24px rgba(34,197,94,.35)">—————</div>
            <div style="margin-top:10px;display:flex;align-items:center;justify-content:center;gap:8px">
              <div style="flex:1;max-width:140px;height:3px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden">
                <div id="steamGuardTimer" style="height:100%;width:100%;background:linear-gradient(90deg,#22c55e,#4ade80);transition:width 1s linear;border-radius:2px"></div>
              </div>
              <span id="steamGuardSec" style="font-size:10px;color:rgba(34,197,94,.6);font-family:'Share Tech Mono',monospace">30s</span>
            </div>
          </div>
          <div style="margin-top:10px;display:flex;gap:6px;justify-content:center">
            <button class="btn btn-sm" id="steamGuardCopy" style="background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.2);font-weight:700;padding:6px 18px;font-size:12px;border-radius:8px">📋 Копировать код</button>
            <button class="btn btn-sm" id="steamGuardRefresh" style="background:rgba(255,255,255,.03);color:var(--text-muted);border:1px solid rgba(255,255,255,.08);padding:6px 10px;border-radius:8px;font-size:12px">🔄</button>
          </div>
        </div>` : ''}
        ${(d.identity_secret && d.Session && d.Session.SteamLoginSecure) ? `
        <div style="margin-top:10px;border:1px solid rgba(59,130,246,.15);border-radius:14px;background:rgba(59,130,246,.02);overflow:hidden">
          <div style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(59,130,246,.08)">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:14px">🔄</span>
              <span style="font-weight:700;font-size:13px;color:#3b82f6">Подтверждения</span>
            </div>
            <button class="btn btn-sm" id="sgConfRefresh" style="background:rgba(59,130,246,.08);color:#3b82f6;border:1px solid rgba(59,130,246,.12);font-size:10px;padding:3px 10px;border-radius:6px">🔄 Обновить</button>
          </div>
          <div id="sgConfList" style="padding:10px 14px">
            <div style="text-align:center;color:var(--text-muted);font-size:12px;padding:8px 0">⏳ Загрузка...</div>
          </div>
        </div>` : ''}
        ${hasSteamGuard ? `
        <div style="margin-top:10px;text-align:center">
          <button class="btn btn-sm" id="sgRemoveGuard" style="background:rgba(239,68,68,.05);color:rgba(239,68,68,.5);border:1px solid rgba(239,68,68,.1);font-size:11px;padding:5px 14px;border-radius:8px">🗑 Удалить Steam Guard</button>
        </div>` : ''}`;
    } else if (p.item_type === 'digital' || p.item_type === 'gift') {
      const code = d.code || d.key || d.value || '';
      deliveryHtml = `
        <div class="deliv-card deliv-digital">
          <div class="deliv-head">🔑 Ваш код</div>
          <div class="deliv-row"><div class="deliv-val-wrap" style="flex:1"><span class="deliv-val deliv-val-lg">${escapeHtml(code)}</span><button class="deliv-copy" data-copy="${escapeHtml(code)}" style="margin-left:8px">📋 Скопировать</button></div></div>
          ${d.extra ? `<div class="deliv-row"><span class="deliv-label">Инфо</span><div class="deliv-val">${escapeHtml(d.extra)}</div></div>` : ''}
        </div>`;
    } else if (p.item_type === 'service') {
      const desc = d.description || d.info || Object.values(d).join(', ');
      deliveryHtml = `<div class="deliv-card deliv-service"><div class="deliv-head">🛠 Услуга</div><div class="deliv-row"><div class="deliv-val">${escapeHtml(desc)}</div></div></div>`;
    } else {
      const vals = Object.entries(d).map(([k,v]) => `<div class="deliv-row"><span class="deliv-label">${escapeHtml(k)}</span><div class="deliv-val">${escapeHtml(String(v))}</div></div>`).join('');
      deliveryHtml = `<div class="deliv-card deliv-other"><div class="deliv-head">📦 Данные</div>${vals}</div>`;
    }
    // Instruction if exists
    const instruction = d.instruction || d.instructions || d.guide || '';

    modal(`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <div style="flex:1"><h2 style="margin:0;font-size:18px">${escapeHtml(p.product_title||'Покупка')}</h2>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${escapeHtml(ts)}${p.price>0?' · −'+p.price+' ₽':' · Бесплатно'}</div>
        </div>
      </div>
      ${deliveryHtml}
      ${instruction ? `<div class="deliv-warn" style="margin-top:10px">📋 <b>Инструкция:</b><br>${escapeHtml(instruction)}</div>` : ''}
      <div style="margin-top:14px">
        <label class="form-label">📝 Заметка</label>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="purchaseNoteInput" value="${escapeHtml(p.note||'')}" placeholder="Добавьте заметку...">
          <button class="btn btn-secondary" id="purchaseNoteSave" style="white-space:nowrap">Сохранить</button>
        </div>
      </div>
      <!-- Пожаловаться -->
      <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px">
        <button class="btn btn-ghost btn-sm" id="btnComplain" style="color:var(--text-muted);font-size:12px;width:100%;display:flex;align-items:center;justify-content:center;gap:6px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Пожаловаться
        </button>
      </div>
    `, { size:'wide' });

    document.querySelectorAll('.deliv-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.copy||'').then(()=>toast('Скопировано!','success'));
      });
    });

    // ── Steam Guard auto-refresh ──
    if (d.shared_secret && p.id) {
      let _sgTimer = null;
      const _fetchSteamCode = async () => {
        try {
          const r = await api('/api/steam/guard_code', { method:'POST', body:{ purchase_id: p.id } });
          const codeEl = document.getElementById('steamGuardCode');
          const timerEl = document.getElementById('steamGuardTimer');
          const secEl = document.getElementById('steamGuardSec');
          if (codeEl) codeEl.textContent = r.code || '—————';
          if (secEl) secEl.textContent = (r.remaining||30) + 's';
          if (timerEl) timerEl.style.width = ((r.remaining||30)/30*100) + '%';
          // Countdown
          if (_sgTimer) clearInterval(_sgTimer);
          let rem = r.remaining || 30;
          _sgTimer = setInterval(() => {
            rem--;
            if (secEl) secEl.textContent = Math.max(0,rem) + 's';
            if (timerEl) timerEl.style.width = Math.max(0,rem/30*100) + '%';
            if (rem <= 0) { clearInterval(_sgTimer); _fetchSteamCode(); }
          }, 1000);
        } catch(e) {
          const codeEl = document.getElementById('steamGuardCode');
          if (codeEl) codeEl.textContent = 'ERROR';
        }
      };
      _fetchSteamCode(); // initial fetch
      // Copy button
      document.getElementById('steamGuardCopy')?.addEventListener('click', () => {
        const code = document.getElementById('steamGuardCode')?.textContent || '';
        if (code && code !== '—————' && code !== 'ERROR') {
          navigator.clipboard.writeText(code).then(() => toast('Steam Guard код скопирован!', 'success'));
        }
      });
      // Manual refresh
      document.getElementById('steamGuardRefresh')?.addEventListener('click', _fetchSteamCode);
    }

    // ── Steam Confirmations (real) ──
    if (d.identity_secret && d.Session && d.Session.SteamLoginSecure && p.id) {
      const _fetchConfs = async () => {
        const list = document.getElementById('sgConfList');
        if (!list) return;
        list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:8px 0"><div style="font-size:18px;margin-bottom:4px;animation:spin 1s linear infinite">⏳</div>Загрузка...</div>';
        try {
          const r = await api('/api/steam/confirmations', { method:'POST', body:{ purchase_id: p.id }});
          if (r.error) {
            list.innerHTML = `<div style="text-align:center;font-size:12px;color:var(--text-muted);padding:8px 0">${escapeHtml(r.error)}</div>`;
            return;
          }
          if (r.message) {
            list.innerHTML = `<div style="text-align:center;font-size:11px;color:var(--text-muted);padding:8px 0;line-height:1.5">${escapeHtml(r.message)}</div>`;
            return;
          }
          const confs = r.confirmations || [];
          if (!confs.length) {
            list.innerHTML = '<div style="text-align:center;font-size:12px;padding:12px 0"><div style="font-size:22px;margin-bottom:4px">✅</div><span style="color:var(--text-muted)">Нет ожидающих подтверждений</span></div>';
            return;
          }
          list.innerHTML = confs.map(c => `
            <div class="sgConf" style="padding:10px 12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:10px;margin-bottom:8px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <span style="font-size:14px">${c.type===1?'🔄':c.type===2?'💰':'📋'}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:600">${escapeHtml(c.headline||c.type_name||'Подтверждение')}</div>
                  ${c.summary ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.summary)}</div>` : ''}
                </div>
                <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(59,130,246,.1);color:#3b82f6;font-weight:600">${escapeHtml(c.type_name)}</span>
              </div>
              <div style="display:flex;gap:6px">
                <button class="btn btn-sm sgConfAct" data-cid="${c.id}" data-nonce="${c.nonce}" data-action="allow" style="flex:1;background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.2);font-weight:700;font-size:11px;padding:6px">✅ Подтвердить</button>
                <button class="btn btn-sm sgConfAct" data-cid="${c.id}" data-nonce="${c.nonce}" data-action="cancel" style="flex:1;background:rgba(239,68,68,.06);color:#ef4444;border:1px solid rgba(239,68,68,.15);font-weight:600;font-size:11px;padding:6px">❌ Отклонить</button>
              </div>
            </div>`).join('');
          // Wire up action buttons
          list.querySelectorAll('.sgConfAct').forEach(btn => {
            btn.addEventListener('click', async () => {
              const cid = btn.dataset.cid, nonce = btn.dataset.nonce, action = btn.dataset.action;
              btn.disabled = true; btn.textContent = '...';
              try {
                const res = await api('/api/steam/confirmations/respond', { method:'POST', body:{ purchase_id: p.id, conf_id: cid, conf_nonce: nonce, action }});
                if (res.success) {
                  toast(action==='allow' ? '✅ Подтверждено!' : '❌ Отклонено', 'success');
                  btn.closest('.sgConf')?.remove();
                  // Check if empty
                  if (!list.querySelector('.sgConf')) {
                    list.innerHTML = '<div style="text-align:center;font-size:12px;padding:12px 0"><div style="font-size:22px;margin-bottom:4px">✅</div><span style="color:var(--text-muted)">Все подтверждено</span></div>';
                  }
                } else {
                  toast('Ошибка Steam: ' + (res.error||'unknown'), 'error');
                  btn.disabled = false; btn.textContent = action==='allow'?'✅ Подтвердить':'❌ Отклонить';
                }
              } catch(e) { toast(e.message, 'error'); btn.disabled = false; }
            });
          });
        } catch(e) {
          list.innerHTML = `<div style="text-align:center;font-size:12px;color:#ef4444;padding:8px 0">${escapeHtml(e.message||'Ошибка')}</div>`;
        }
      };
      _fetchConfs();
      document.getElementById('sgConfRefresh')?.addEventListener('click', _fetchConfs);
    }

    // ── Remove Steam Guard ──
    document.getElementById('sgRemoveGuard')?.addEventListener('click', async () => {
      try {
        // Step 1: get info + revocation code
        const info = await api('/api/steam/remove_guard', { method:'POST', body:{ purchase_id: p.id }});
        if (info.needs_confirm) {
          modal(`
            <div style="text-align:center;padding:16px 0 8px">
              <div style="font-size:40px;margin-bottom:8px">⚠️</div>
              <h3 style="margin:0 0 8px;color:#ef4444">Удалить Steam Guard?</h3>
              <p style="color:var(--text-muted);font-size:13px;line-height:1.6;margin:0 0 16px">
                Данные Steam Guard будут удалены с нашего сервера.<br>
                Вы больше не сможете генерировать коды и подтверждать трейды здесь.
              </p>
              ${info.revocation_code ? `
              <div style="padding:10px 14px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.15);border-radius:10px;margin-bottom:14px;text-align:left">
                <div style="font-size:11px;color:#f59e0b;font-weight:700;margin-bottom:4px">📋 Код восстановления (R-код)</div>
                <div style="font-family:'Share Tech Mono',monospace;font-size:18px;font-weight:900;letter-spacing:3px;color:#f59e0b">${escapeHtml(info.revocation_code)}</div>
                <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Сохраните этот код! Он нужен для удаления Guard через Steam.</div>
              </div>` : ''}
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm" id="sgConfirmRemove" style="flex:1;background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.2);padding:10px;font-weight:700">🗑 Да, удалить</button>
              <button class="btn btn-sm" style="flex:1;background:rgba(255,255,255,.04);color:var(--text-muted);border:1px solid rgba(255,255,255,.08);padding:10px" onclick="closeModal()">Отмена</button>
            </div>
          `, {size:'default'});
          document.getElementById('sgConfirmRemove')?.addEventListener('click', async () => {
            try {
              const res = await api('/api/steam/remove_guard', { method:'POST', body:{ purchase_id: p.id, confirm: true }});
              closeModal();
              toast(res.message || 'Steam Guard удалён', 'success');
              // Refresh purchase detail
              setTimeout(() => _showPurchaseDetail(p), 300);
            } catch(e) { toast(e.message, 'error'); }
          });
        }
      } catch(e) { toast(e.message, 'error'); }
    });

    document.getElementById('purchaseNoteSave')?.addEventListener('click', async () => {
      const note = document.getElementById('purchaseNoteInput')?.value || '';
      try {
        await api(`/api/purchases/${p.id}/note`, { method:'POST', body:{ note }});
        p.note = note;
        toast('Заметка сохранена', 'success');
      } catch(e) { toast(e.message, 'error'); }
    });

    // Пожаловаться
    document.getElementById('btnComplain')?.addEventListener('click', () => {
      closeModal();
      modal(`
        <div style="text-align:center;margin-bottom:20px">
          <div style="width:52px;height:52px;border-radius:14px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);display:flex;align-items:center;justify-content:center;margin:0 auto 12px">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <h3 style="margin:0 0 6px">Жалоба по заказу</h3>
          <div style="font-size:13px;color:var(--text-muted)">${escapeHtml(p.product_title||'Покупка')} · #${p.id}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn btn-secondary" id="btnComplainForm" style="padding:14px;text-align:left;display:flex;align-items:center;gap:12px">
            <div style="width:36px;height:36px;border-radius:10px;background:rgba(var(--accent-rgb),0.1);flex-shrink:0;display:flex;align-items:center;justify-content:center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </div>
            <div>
              <div style="font-weight:600;font-size:14px">Заполнить заявку</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Описать проблему письменно</div>
            </div>
          </button>
          <button class="btn btn-secondary" id="btnComplainAssist" style="padding:14px;text-align:left;display:flex;align-items:center;gap:12px">
            <div style="width:36px;height:36px;border-radius:10px;background:rgba(34,197,94,0.1);flex-shrink:0;display:flex;align-items:center;justify-content:center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div>
              <div style="font-weight:600;font-size:14px">Открыть ассистент</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Задать вопрос поддержке напрямую</div>
            </div>
          </button>
        </div>
        <button class="btn btn-ghost btn-sm" style="width:100%;margin-top:10px" onclick="closeModal()">Отмена</button>
      `);

      document.getElementById('btnComplainForm')?.addEventListener('click', () => {
        closeModal();
        modal(`
          <h3 style="margin:0 0 14px">Заявка на жалобу</h3>
          <div class="form-group">
            <label class="form-label">Тема</label>
            <input class="form-input" id="complainSubject" value="Проблема с заказом #${p.id}: ${escapeHtml(p.product_title||'')}">
          </div>
          <div class="form-group" style="margin-top:10px">
            <label class="form-label">Опишите проблему</label>
            <textarea class="form-input" id="complainBody" rows="4" placeholder="Что именно пошло не так?"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="btn btn-primary" id="complainSubmitBtn" style="flex:1">Отправить</button>
            <button class="btn btn-ghost" style="flex:1" onclick="closeModal()">Отмена</button>
          </div>
        `);
        document.getElementById('complainSubmitBtn')?.addEventListener('click', async () => {
          const subject = document.getElementById('complainSubject')?.value || '';
          const body = document.getElementById('complainBody')?.value || '';
          if (!body.trim()) return toast('Опишите проблему', 'warning');
          try {
            loading(true);
            // Use /api/support/create — the proper support ticket endpoint
            await api('/api/support/create', { method:'POST', body:{
              subject: subject.slice(0, 200),
              text: body,
              category: 'other',
              attachment_urls: []
            }});
            closeModal();
            toast('✅ Жалоба отправлена! Мы рассмотрим её в ближайшее время.', 'success');
          } catch(e) {
            toast(e.message || 'Ошибка при отправке', 'error');
          } finally {
            loading(false);
          }
        });
      });

      document.getElementById('btnComplainAssist')?.addEventListener('click', () => {
        closeModal();
        // Navigate to support/assistant tab
        const assistTab = document.querySelector('[data-tab="support"], [data-tab="assistant"], [data-tab="chat"], #nav-support, #nav-assistant');
        if (assistTab) {
          assistTab.click();
        } else {
          // Try to open support modal if tab not found
          window.open('https://t.me/E6JLAHOC', '_blank');
        }
      });
    });

    // Cancel order handler (robux)
    document.getElementById('cancelOrderBtn')?.addEventListener('click', () => {
      const orderId = d.order_id;
      if (!orderId) return;
      closeModal();
      modal(`
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:32px;margin-bottom:8px">⚠️</div>
          <h3 style="margin:0 0 4px">Отменить заказ?</h3>
          <div style="color:var(--text-muted);font-size:13px">Средства будут возвращены на баланс</div>
        </div>
        <div class="form-group">
          <label class="form-label">Причина отмены</label>
          <select class="form-input" id="cancelReasonSelect">
            <option value="Передумал">Передумал покупать</option>
            <option value="Ошибка в заказе">Ошибка в заказе</option>
            <option value="Слишком долго">Слишком долгое ожидание</option>
            <option value="Другая причина">Другая причина</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn btn-ghost" id="confirmCancelBtn" style="flex:1;color:var(--danger);border:1px solid rgba(239,68,68,.3)">Отменить заказ</button>
          <button class="btn btn-secondary" id="keepOrderBtn" style="flex:1">Не отменять</button>
        </div>
      `);
      document.getElementById('confirmCancelBtn')?.addEventListener('click', async () => {
        const reason = document.getElementById('cancelReasonSelect')?.value || '';
        try {
          const res = await api('/api/robux/order_cancel', { method: 'POST', body: { order_id: orderId, reason } });
          closeModal();
          toast(`Заказ отменён. Возвращено ${res.refunded || 0} ₽`, 'success');
          updateBalance();
        } catch(e) { toast(e.message, 'error'); }
      });
      document.getElementById('keepOrderBtn')?.addEventListener('click', () => closeModal());
    });
  }

  function _histRow(r) {
    const d = Number(r.delta || 0), sign = d >= 0 ? '+' : '−', cls = d >= 0 ? 'var(--success)' : 'var(--danger)';
    const ts = String(r.ts || '').replace('T',' ').slice(0,19);
    return `<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="min-width:80px;font-size:12px;color:var(--text-muted)">${escapeHtml(ts)}</div>
      <div style="flex:1;font-size:13px">${escapeHtml(String(r.reason || '—'))}</div>
      <div style="font-weight:700;color:${cls}">${sign}${_fmtMoney(Math.abs(d))}</div></div>`;
  }

  async function showTransactionsModal() {
    modal(`
      <h2 style="margin:0 0 4px">История</h2>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:14px">${escapeHtml(state.user?.username || 'Пользователь')}</div>
      <div class="segmented" id="historyTabs" style="margin-bottom:14px">
        <button class="seg-btn active" data-htab="topups">Пополнения</button>
        <button class="seg-btn" data-htab="purchases">Покупки</button>
        <button class="seg-btn" data-htab="checker">Чекер</button>
        <button class="seg-btn" data-htab="descs">Описания</button>
      </div>
      <div id="historyContent" style="min-height:120px">
        <div style="text-align:center;padding:24px;color:var(--text-muted)">Загрузка...</div>
      </div>
    `, { size: 'wide' });

    let currentHTab = 'topups';

    document.getElementById('historyTabs')?.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('historyTabs').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentHTab = btn.dataset.htab;
        loadHistoryTab(currentHTab);
      });
    });

    loadHistoryTab('topups');

    async function loadHistoryTab(tab) {
      const cont = document.getElementById('historyContent');
      if (!cont) return;
      cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Загрузка...</div>';

      try {
        if (tab === 'topups') {
          const items = await profileFetchTx(true);
          const rows = (items || []).filter(r => Number(r.delta || 0) > 0).slice(0, 50);
          cont.innerHTML = rows.length ? rows.map(r => txRow(r)).join('') : emptyMsg('Нет пополнений');

        } else if (tab === 'purchases') {
          try {
            const d = await api('/api/purchases');
            const purchases = d.purchases || [];
            if (!purchases.length) { cont.innerHTML = emptyMsg('Нет покупок'); return; }
            cont.innerHTML = purchases.map(p => _purchaseRow(p)).join('');
            cont.querySelectorAll('[data-purchase-id]').forEach(el => {
              el.addEventListener('click', () => _showPurchaseDetail(purchases.find(x => x.id == el.dataset.purchaseId)));
            });
          } catch(e) {
            const items = await profileFetchTx(true);
            const rows = (items || []).filter(r => Number(r.delta || 0) < 0).slice(0, 50);
            cont.innerHTML = rows.length ? rows.map(r => txRow(r)).join('') : emptyMsg('Нет покупок');
          }
        } else if (tab === 'checker' || tab === 'descs') {
          const toolName = tab === 'checker' ? 'checker' : 'description';
          try {
            const d = await api('/api/user/tool_history?tool=' + toolName);
            const items = d.items || [];
            if (!items.length) { cont.innerHTML = emptyMsg(tab === 'checker' ? 'Нет проверок' : 'Нет генераций'); return; }
            cont.innerHTML = items.map(h => {
              const ts = String(h.ts || '').replace('T',' ').slice(0,19);
              const ok = h.status === 'ok' || h.status === 'valid';
              return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">'
                + '<div style="min-width:80px;font-size:12px;color:var(--text-muted)">' + escapeHtml(ts) + '</div>'
                + '<div style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(h.result || h.input || '—') + '</div>'
                + '<div style="font-size:12px;color:' + (ok ? 'var(--success)' : 'var(--danger)') + '">' + (ok ? 'OK' : h.status) + '</div></div>';
            }).join('');
          } catch(e) {
            cont.innerHTML = emptyMsg('История пока пуста');
          }
        }
      } catch(e) {
        cont.innerHTML = emptyMsg('Ошибка загрузки');
      }
    }

    function txRow(r) {
      const d = Number(r.delta || 0);
      const sign = d >= 0 ? '+' : '−';
      const cls = d >= 0 ? 'color:var(--success)' : 'color:var(--danger)';
      const ts = String(r.ts || '').replace('T',' ').slice(0,19);
      return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">'
        + '<div style="min-width:80px;font-size:12px;color:var(--text-muted)">' + escapeHtml(ts) + '</div>'
        + '<div style="flex:1;font-size:13px">' + escapeHtml(String(r.reason || '—')) + '</div>'
        + '<div style="font-weight:700;' + cls + '">' + sign + _fmtMoney(Math.abs(d)) + '</div></div>';
    }
    function emptyMsg(text) { return '<div style="text-align:center;padding:24px;color:var(--text-muted)">' + text + '</div>'; }
  }

  function _updatePurchaseModeUI() {
    const toggle = $('#purchaseModeCheck');
    const lockIcon = $('#autoModeLock');
    const labelNormal = $('#modeLabelNormal');
    const labelAuto = $('#modeLabelAuto');
    const desc = $('#modeDescription');
    const isPrem = isPremiumActive();

    if (!isPrem) {
      state.robux.purchaseMode = 'normal';
      if (toggle) { toggle.checked = false; toggle.disabled = true; }
      lockIcon?.classList.remove('hidden');
    } else {
      if (toggle) toggle.disabled = false;
      lockIcon?.classList.add('hidden');
    }

    const isAuto = state.robux.purchaseMode === 'auto';
    if (toggle) toggle.checked = isAuto;
    labelNormal?.classList.toggle('active-label', !isAuto);
    labelAuto?.classList.toggle('active-label', isAuto);

    if (desc) {
      desc.textContent = isAuto
        ? 'Авто-режим: если геймпасс не найден — создадим автоматически.'
        : 'Выбери количество, введи ник или ссылку, проверь и купи.';
    }
  }

  // Login
  function _escapeHtml(str){ return escapeHtml(str); }

  async function _captchaChallenge(purpose){
    try { return await api(`/api/captcha/challenge?purpose=${encodeURIComponent(purpose)}`); }
    catch(e){ return null; }
  }

  // Slider captcha HTML — auto-fills answer when dragged to end
  function _sliderCaptchaHTML(cap) {
    if (!cap) return '';
    return `<div class="captcha-slider-wrap" id="captchaSlider" data-answer="${cap.a + cap.b}" data-token="${_escapeHtml(cap.token)}">
      <div class="captcha-slider-track" id="captchaTrack"></div>
      <div class="captcha-slider-label" id="captchaLabel">Протяните для подтверждения →</div>
      <div class="captcha-slider-thumb" id="captchaThumb">
        <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <input type="hidden" id="captchaAnswerHidden" value="">
      <input type="hidden" id="captchaTokenHidden" value="${_escapeHtml(cap.token)}">
    </div>`;
  }

  function _initSliderCaptcha() {
    const wrap = document.getElementById('captchaSlider');
    if (!wrap) return;
    const thumb = document.getElementById('captchaThumb');
    const track = document.getElementById('captchaTrack');
    const label = document.getElementById('captchaLabel');
    const answer = parseInt(wrap.dataset.answer || '0');
    let dragging = false, startX = 0, thumbX = 0;
    const maxX = () => wrap.offsetWidth - thumb.offsetWidth - 4;

    const onStart = (x) => { dragging = true; startX = x - thumbX; };
    const onMove = (x) => {
      if (!dragging || wrap.classList.contains('done')) return;
      thumbX = Math.max(0, Math.min(x - startX, maxX()));
      thumb.style.left = thumbX + 'px';
      track.style.width = (thumbX + thumb.offsetWidth) + 'px';
      label.style.opacity = 1 - (thumbX / maxX());
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      if (thumbX >= maxX() * 0.9) {
        // Success!
        wrap.classList.add('done');
        thumb.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
        label.textContent = '✓ Подтверждено';
        document.getElementById('captchaAnswerHidden').value = answer;
      } else {
        // Reset
        thumbX = 0;
        thumb.style.left = '0';
        track.style.width = '0';
        label.style.opacity = 1;
      }
    };

    thumb.addEventListener('mousedown', e => { e.preventDefault(); onStart(e.clientX); });
    document.addEventListener('mousemove', e => onMove(e.clientX));
    document.addEventListener('mouseup', onEnd);
    thumb.addEventListener('touchstart', e => { e.preventDefault(); onStart(e.touches[0].clientX); }, {passive:false});
    document.addEventListener('touchmove', e => onMove(e.touches[0].clientX));
    document.addEventListener('touchend', onEnd);
  }

  // Get captcha values from slider
  function _getSliderCaptcha() {
    const ans = document.getElementById('captchaAnswerHidden')?.value || '';
    const token = document.getElementById('captchaTokenHidden')?.value || '';
    return { answer: ans, token: token };
  }

  function showLogin() {
    modal(`
      <div class="auth-card auth-form-section">
        <div class="auth-icon">
          <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 3L35 11v18l-15 8-15-8V11z" stroke="currentColor" stroke-width="1.2" opacity=".25"/>
            <path d="M20 7L31 13.5v13L20 33 9 26.5v-13z" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
            <path d="M14 15h6c2.5 0 4 1.5 4 3.5S22.5 22 20 22h-3l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
            <line x1="14" y1="15" x2="14" y2="27" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".85"/>
          </svg>
        </div>
        <div class="auth-logo"><span>RBX</span> <span>ST</span></div>
        <div class="auth-tabs" id="authTabs">
          <button class="auth-tab active" id="tabLogin">Вход</button>
          <button class="auth-tab" id="tabReg">Регистрация</button>
          <div class="auth-tab-indicator" id="authTabIndicator" style="left:0;width:50%"></div>
        </div>
        <div class="auth-subtitle">С возвращением</div>
        <form id="loginStep1">
          <div class="auth-input-group">
            <input type="text" class="auth-input" id="loginIdent" autocomplete="username" required placeholder="Введите email или логин">
          </div>
          <button type="submit" class="auth-submit">Продолжить</button>
        </form>
        <div class="auth-footer">
          <a href="#" id="toReset">Забыли пароль?</a>
        </div>
        <div class="auth-terms">Продолжая, вы соглашаетесь с условиями <a href="/agreement" target="_blank">RBX ST</a></div>
      </div>
    `);
    // Animate tab indicator
    requestAnimationFrame(() => {
      const ind = document.getElementById('authTabIndicator');
      if (ind) { ind.style.left = '0'; ind.style.width = '50%'; }
    });
    $('#loginStep1')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ident = ($('#loginIdent')?.value || '').trim();
      if (!ident) return toast('Введи логин или email', 'warning');
      showLoginStep2(ident);
    });
    $('#tabReg')?.addEventListener('click', e => { e.preventDefault(); showRegister(); });
    $('#toReset')?.addEventListener('click', e => { e.preventDefault(); showReset(); });
  }
  async function showLoginStep2(ident){
    const cap = await _captchaChallenge('login');
    modal(`
      <div class="auth-card auth-form-section">
        <a href="#" class="auth-back" id="loginBack">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          Назад
        </a>
        <div class="auth-icon">
          <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 3L35 11v18l-15 8-15-8V11z" stroke="currentColor" stroke-width="1.2" opacity=".25"/>
            <path d="M20 7L31 13.5v13L20 33 9 26.5v-13z" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
            <path d="M14 15h6c2.5 0 4 1.5 4 3.5S22.5 22 20 22h-3l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
            <line x1="14" y1="15" x2="14" y2="27" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".85"/>
          </svg>
        </div>
        <div class="auth-logo"><span>RBX</span> <span>ST</span></div>
        <div class="auth-steps" style="margin:12px 0 20px">
          <div class="auth-step-dot done"></div>
          <div class="auth-step-dot active"></div>
        </div>
        <form id="loginForm">
          <div class="auth-input-group">
            <label>Аккаунт</label>
            <input type="text" class="auth-input" id="loginIdent2" value="${_escapeHtml(ident)}" readonly style="opacity:.6">
          </div>
          <div class="auth-input-group">
            <label>Пароль</label>
            <input type="password" class="auth-input" id="loginPass" autocomplete="current-password" required placeholder="Введите пароль">
          </div>
          ${cap ? _sliderCaptchaHTML(cap) : ''}
          <button type="submit" class="auth-submit">Войти</button>
        </form>
        <div class="auth-footer">
          <a href="#" id="loginToReset">Забыли пароль?</a>
        </div>
      </div>
    `);

    if (cap) setTimeout(_initSliderCaptcha, 50);
    $('#loginBack')?.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    $('#loginToReset')?.addEventListener('click', (e) => { e.preventDefault(); showReset(); });

    $('#loginForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = $('#loginPass')?.value || '';
      if (!p) return toast('Введи пароль', 'warning');

      const sc = _getSliderCaptcha();
      const body = { username: ident, password: p };
      if (cap) {
        if (!sc.answer) return toast('Протяните ползунок для подтверждения', 'warning');
        body.captcha_token = sc.token; body.captcha_answer = sc.answer;
      }

      try{
        loading(true);
        const d = await api('/api/auth/login', { method:'POST', body });
        if (d.needs_2fa) {
          show2FA(ident);
          return;
        }
        closeModal();
        toast('Успешно!', 'success');
        await checkAuth();
      }catch(err){
        toast(err.message || 'Ошибка входа', 'error');
      }finally{ loading(false); }
    });
  }

  function show2FA(ident) {
    modal(`
      <h2 style="margin-bottom:14px;text-align:center">2FA</h2>
      <p style="text-align:center;color:var(--text-secondary);margin-bottom:18px">Код отправлен на почту, привязанную к аккаунту</p>
      <form id="tfaForm">
        <div class="form-group">
          <label class="form-label">Код</label>
          <input type="text" class="form-input" id="tfaCode" required maxlength="6" inputmode="numeric" pattern="[0-9]*" style="text-align:center;font-size:24px;letter-spacing:8px;padding:14px 10px;width:100%">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:10px">Подтвердить</button>
      </form>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn btn-secondary" id="tfaBack" style="flex:1">Назад</button>
      </div>
    `);
    $('#tfaBack')?.addEventListener('click', (e)=>{ e.preventDefault(); showLogin(); });
    const _tfaEl = $('#tfaCode');
    if (_tfaEl) {
      _tfaEl.addEventListener('paste', e => {
        e.preventDefault();
        const txt = (e.clipboardData||window.clipboardData).getData('text');
        _tfaEl.value = txt.replace(/\D/g, '').slice(0, 6);
        if (_tfaEl.value.length === 6) $('#tfaForm')?.dispatchEvent(new Event('submit', {cancelable:true}));
      });
      _tfaEl.addEventListener('input', () => {
        _tfaEl.value = _tfaEl.value.replace(/\D/g, '').slice(0, 6);
        if (_tfaEl.value.length === 6) setTimeout(() => $('#tfaForm')?.dispatchEvent(new Event('submit', {cancelable:true})), 150);
      });
    }
    $('#tfaForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const c = ($('#tfaCode')?.value || '').trim();
      if (!c) return toast('Введи код', 'warning');
      try {
        loading(true);
        await api('/api/auth/login_confirm', { method: 'POST', body: { username: ident, code: c } });
        closeModal(); toast('Успешно!', 'success'); await checkAuth();
      } catch (e) { toast(e.message || 'Ошибка', 'error'); } finally { loading(false); }
    });
  }

  function showRegister() {
    modal(`
      <div class="auth-card auth-form-section">
        <div class="auth-icon">
          <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 3L35 11v18l-15 8-15-8V11z" stroke="currentColor" stroke-width="1.2" opacity=".25"/>
            <path d="M20 7L31 13.5v13L20 33 9 26.5v-13z" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
            <path d="M14 15h6c2.5 0 4 1.5 4 3.5S22.5 22 20 22h-3l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
            <line x1="14" y1="15" x2="14" y2="27" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".85"/>
          </svg>
        </div>
        <div class="auth-logo"><span>RBX</span> <span>ST</span></div>
        <div class="auth-tabs" id="authTabs">
          <button class="auth-tab" id="tabLogin">Вход</button>
          <button class="auth-tab active" id="tabReg">Регистрация</button>
          <div class="auth-tab-indicator" id="authTabIndicator" style="left:50%;width:50%"></div>
        </div>
        <div class="auth-subtitle">Создайте аккаунт</div>
        <div class="auth-steps">
          <div class="auth-step-dot active"></div>
          <div class="auth-step-dot"></div>
          <div class="auth-step-dot"></div>
        </div>
        <form id="regStep1">
          <div class="auth-input-group">
            <input type="text" class="auth-input" id="regUser" required minlength="3" maxlength="20" placeholder="Придумайте логин (3–20 символов)">
          </div>
          <button type="submit" class="auth-submit">Продолжить</button>
        </form>
        <div class="auth-terms">Продолжая, вы соглашаетесь с условиями <a href="/agreement" target="_blank">RBX ST</a></div>
      </div>
    `);
    requestAnimationFrame(() => {
      const ind = document.getElementById('authTabIndicator');
      if (ind) { ind.style.left = '50%'; ind.style.width = '50%'; }
    });
    $('#regStep1')?.addEventListener('submit', (e)=>{
      e.preventDefault();
      const u = ($('#regUser')?.value || '').trim();
      if (!u) return toast('Введи логин', 'warning');
      showRegisterStep2(u);
    });
    $('#tabLogin')?.addEventListener('click', e => { e.preventDefault(); showLogin(); });
  }

  function showRegisterStep2(username){
    modal(`
      <div class="auth-card auth-form-section">
        <a href="#" class="auth-back" id="regBack1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          Назад
        </a>
        <div class="auth-icon">
          <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 3L35 11v18l-15 8-15-8V11z" stroke="currentColor" stroke-width="1.2" opacity=".25"/>
            <path d="M20 7L31 13.5v13L20 33 9 26.5v-13z" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
            <path d="M14 15h6c2.5 0 4 1.5 4 3.5S22.5 22 20 22h-3l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
            <line x1="14" y1="15" x2="14" y2="27" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".85"/>
          </svg>
        </div>
        <div class="auth-logo"><span>RBX</span> <span>ST</span></div>
        <div class="auth-steps" style="margin:12px 0 20px">
          <div class="auth-step-dot done"></div>
          <div class="auth-step-dot active"></div>
          <div class="auth-step-dot"></div>
        </div>
        <form id="regStep2">
          <div class="auth-input-group">
            <label>Email (необязательно)</label>
            <input type="email" class="auth-input" id="regEmail" placeholder="name@mail.com">
            <span style="font-size:11px;color:var(--text-muted);margin-top:4px;display:block">Для восстановления доступа и 2FA</span>
          </div>
          <button type="submit" class="auth-submit">Далее</button>
        </form>
        <div style="text-align:center;margin-top:10px">
          <a href="#" id="regSkipEmail" style="color:var(--text-muted);font-size:13px;text-decoration:none">Пропустить</a>
        </div>
      </div>
    `);

    $('#regBack1')?.addEventListener('click', (e)=>{ e.preventDefault(); showRegister(); });

    const goNext = (email) => showRegisterStep3(username, email);

    $('#regStep2')?.addEventListener('submit', (e)=>{
      e.preventDefault();
      const em = ($('#regEmail')?.value || '').trim();
      if (!em) return toast('Введи email или нажми "Пропустить"', 'info');
      goNext(em);
    });

    $('#regSkipEmail')?.addEventListener('click', (e)=>{
      e.preventDefault();
      // 3-option warning
      modal(`
        <h2 style="margin-bottom:10px">⚠️ Без почты</h2>
        <p style="color:var(--text-secondary);line-height:1.6">
          Вы уверены, что не хотите указать почту? Баланс, заказы и доступ к аккаунту могут быть утеряны при потере пароля.
        </p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px">
          <button class="btn btn-primary" id="bindNow">Привязать сейчас</button>
          <button class="btn btn-secondary" id="skipNow">Пропустить</button>
          <button class="btn btn-secondary" id="remindLater">Напомнить позже</button>
        </div>
      `);
      $('#bindNow')?.addEventListener('click', (ev)=>{ ev.preventDefault(); showRegisterStep2(username); });
      $('#skipNow')?.addEventListener('click', (ev)=>{ ev.preventDefault(); goNext(''); });
      $('#remindLater')?.addEventListener('click', (ev)=>{ ev.preventDefault(); try{ localStorage.setItem('email_remind_later_until', String(Date.now() + 7*24*3600*1000)); }catch(_){} goNext(''); });
    });
  }

  async function showRegisterStep3(username, email){
    const cap = await _captchaChallenge('register');
    modal(`
      <div class="auth-card auth-form-section">
        <a href="#" class="auth-back" id="regBack2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          Назад
        </a>
        <div class="auth-icon">
          <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 3L35 11v18l-15 8-15-8V11z" stroke="currentColor" stroke-width="1.2" opacity=".25"/>
            <path d="M20 7L31 13.5v13L20 33 9 26.5v-13z" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
            <path d="M14 15h6c2.5 0 4 1.5 4 3.5S22.5 22 20 22h-3l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
            <line x1="14" y1="15" x2="14" y2="27" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".85"/>
          </svg>
        </div>
        <div class="auth-logo"><span>RBX</span> <span>ST</span></div>
        <div class="auth-steps" style="margin:12px 0 20px">
          <div class="auth-step-dot done"></div>
          <div class="auth-step-dot done"></div>
          <div class="auth-step-dot active"></div>
        </div>
      <form id="regStep3">
        <div class="auth-input-group">
          <label>Логин</label>
          <input type="text" class="auth-input" value="${_escapeHtml(username)}" readonly style="opacity:.6">
        </div>
        <div class="auth-input-group">
          <label>Email</label>
          <input type="text" class="auth-input" value="${_escapeHtml(email || '— не указан —')}" readonly style="opacity:.6">
        </div>
        <div class="auth-input-group">
          <label>Пароль</label>
          <input type="password" class="auth-input" id="regPass" required minlength="6" placeholder="Минимум 6 символов">
        </div>

        <div ${cap ? '' : 'style="display:none"'}>
          ${cap ? _sliderCaptchaHTML(cap) : ''}
        </div>

        <label style="display:flex;align-items:flex-start;gap:8px;margin:12px 0;cursor:pointer;font-size:13px;color:var(--text-secondary)">
          <input type="checkbox" id="regTerms" style="margin-top:2px;min-width:16px">
          <span>Я принимаю <a href="/terms" target="_blank" style="color:var(--accent-primary)">пользовательское соглашение</a> и <a href="/privacy" target="_blank" style="color:var(--accent-primary)">политику конфиденциальности</a></span>
        </label>

        <button type="submit" class="auth-submit" style="margin-top:10px">Создать аккаунт</button>
      </form>
      </div>
    `);

    if (cap) setTimeout(_initSliderCaptcha, 50);
    $('#regBack2')?.addEventListener('click', (e)=>{ e.preventDefault(); showRegisterStep2(username); });

    $('#regStep3')?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const p = $('#regPass')?.value || '';
      if (!p) return toast('Введи пароль', 'warning');
      if (!$('#regTerms')?.checked) return toast('Необходимо принять пользовательское соглашение', 'warning');
      const sc = _getSliderCaptcha();
      const captcha_answer = sc.answer;
      const captcha_token = sc.token || (cap ? cap.token : '');
      if (cap && !captcha_answer) return toast('Протяните ползунок для подтверждения', 'warning');
      try{
        loading(true);
        if (email) {
          await api('/api/auth/register_start', { method:'POST', body: { username, email, password: p, captcha_token, captcha_answer } });
          showRegConfirm(email);
        } else {
          await api('/api/auth/register_direct', { method:'POST', body: { username, password: p, captcha_token, captcha_answer } });
          closeModal();
          toast('Аккаунт создан! Вы вошли.', 'success');
          await checkAuth();
        }
      }catch(err){
        toast(err.message || 'Ошибка регистрации', 'error');
      }finally{ loading(false); }
    });
  }

  function showRegConfirm(email) {
    modal(`
      <h2 style="margin-bottom:14px;text-align:center">Подтверждение</h2>
      <p style="text-align:center;color:var(--text-secondary);margin-bottom:16px">Код отправлен на ${_escapeHtml(email)}</p>
      <form id="regConfirm">
        <div class="form-group">
          <label class="form-label">Код</label>
          <input type="text" class="form-input" id="regCode" required maxlength="6" inputmode="numeric" pattern="[0-9]*" style="text-align:center;font-size:24px;letter-spacing:8px;padding:14px 10px;width:100%">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:10px">Подтвердить</button>
      </form>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn btn-secondary" id="regBack" style="flex:1">Назад</button>
        <button class="btn btn-secondary" id="regResend" style="flex:1">Отправить ещё раз</button>
      </div>
    `);

    // Handle paste: extract only digits, max 6
    const _codeEl = $('#regCode');
    if (_codeEl) {
      _codeEl.addEventListener('paste', e => {
        e.preventDefault();
        const txt = (e.clipboardData||window.clipboardData).getData('text');
        const digits = txt.replace(/\D/g, '').slice(0, 6);
        _codeEl.value = digits;
        if (digits.length === 6) $('#regConfirm')?.dispatchEvent(new Event('submit', {cancelable:true}));
      });
      _codeEl.addEventListener('input', () => {
        _codeEl.value = _codeEl.value.replace(/\D/g, '').slice(0, 6);
        if (_codeEl.value.length === 6) setTimeout(() => $('#regConfirm')?.dispatchEvent(new Event('submit', {cancelable:true})), 150);
      });
    }

    $('#regConfirm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const c = ($('#regCode')?.value || '').trim();
      if (!c) return toast('Введи код', 'warning');
      try {
        loading(true);
        await api('/api/auth/register_confirm', { method: 'POST', body: { email, code: c } });
        closeModal(); toast('Аккаунт создан! Вы вошли.', 'success'); await checkAuth();
      } catch (e) { toast(e.message || 'Ошибка', 'error'); } finally { loading(false); }
    });

    $('#regBack')?.addEventListener('click', e => { e.preventDefault(); showRegister(); });
    $('#regResend')?.addEventListener('click', async e => {
      e.preventDefault();
      try {
        loading(true);
        // resend works by calling start again; backend stores pending by email
        await api('/api/auth/register_resend', { method: 'POST', body: { email } });
        toast('Код отправлен повторно', 'success');
      } catch (e) {
        toast(e.message || 'Ошибка', 'error');
      } finally {
        loading(false);
      }
    });
  }

  // Password reset
  function showReset() {
    _captchaChallenge('reset').then((cap)=>{
      modal(`
        <div class="auth-card auth-form-section">
          <div class="auth-icon">
            <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 3L35 11v18l-15 8-15-8V11z" stroke="currentColor" stroke-width="1.2" opacity=".25"/>
            <path d="M20 7L31 13.5v13L20 33 9 26.5v-13z" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
            <path d="M14 15h6c2.5 0 4 1.5 4 3.5S22.5 22 20 22h-3l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
            <line x1="14" y1="15" x2="14" y2="27" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".85"/>
          </svg>
          </div>
          <div class="auth-logo"><span>RBX</span> <span>ST</span></div>
          <div class="auth-subtitle">Восстановление пароля</div>
          <form id="resetForm">
            <div class="auth-input-group">
              <label>Email</label>
              <input type="email" class="auth-input" id="resetEmail" required placeholder="Введите email аккаунта">
            </div>
            ${cap ? _sliderCaptchaHTML(cap) : ''}
            <button type="submit" class="auth-submit">Отправить код</button>
          </form>
          <div class="auth-footer">
            Вспомнили пароль? <a href="#" id="toLogin2">Войти</a>
          </div>
        </div>
      `);

      if (cap) setTimeout(_initSliderCaptcha, 50);
      $('#resetForm')?.addEventListener('submit', async e => {
        e.preventDefault();
        const em = ($('#resetEmail')?.value || '').trim();
        if (!em) return toast('Введи email', 'warning');
        const sc = _getSliderCaptcha();
        const body = { email: em };
        if (cap) {
          if (!sc.answer) return toast('Протяните ползунок для подтверждения', 'warning');
          body.captcha_token = sc.token; body.captcha_answer = sc.answer;
        }

        try {
          loading(true);
          await api('/api/auth/reset_start', { method: 'POST', body });
          showResetConfirm(em);
        } catch (e) {
          toast(e.message || 'Ошибка', 'error');
        } finally {
          loading(false);
        }
      });
      $('#toLogin2')?.addEventListener('click', e => { e.preventDefault(); showLogin(); });
    });
  }

  function showResetConfirm(em) {
    modal(`
      <h2 style="margin-bottom:14px;text-align:center">Новый пароль</h2>
      <div class="muted" style="text-align:center;margin-bottom:14px">Шаг 2/2</div>
      <p style="text-align:center;color:var(--text-secondary);margin-bottom:14px">Код отправлен на ${_escapeHtml(em)}</p>
      <form id="resetConfirmForm">
        <div class="form-group"><label class="form-label">Код</label><input type="text" class="form-input" id="resetCode" required style="text-align:center;font-size:20px;letter-spacing:6px"></div>
        <div class="form-group"><label class="form-label">Новый пароль</label><input type="password" class="form-input" id="resetPass" required minlength="6"><span class="form-hint">Минимум 6 символов</span></div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:10px">Сменить пароль</button>
      </form>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn btn-secondary" id="resetBack" style="flex:1">Назад</button>
        <button class="btn btn-secondary" id="resetResend" style="flex:1">Отправить ещё раз</button>
      </div>
    `);

    $('#resetConfirmForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const c = ($('#resetCode')?.value || '').trim();
      const p = $('#resetPass')?.value || '';
      if (!c || !p) return toast('Заполни поля', 'warning');
      try {
        loading(true);
        await api('/api/auth/reset_confirm', { method: 'POST', body: { email: em, code: c, new_password: p } });
        closeModal();
        toast('Пароль обновлён. Теперь войдите.', 'success');
        showLogin();
      } catch (e) {
        toast(e.message || 'Ошибка', 'error');
      } finally {
        loading(false);
      }
    });

    $('#resetBack')?.addEventListener('click', e => { e.preventDefault(); showReset(); });
    $('#resetResend')?.addEventListener('click', async e => {
      e.preventDefault();
      try {
        loading(true);
        await api('/api/auth/reset_start', { method: 'POST', body: { email: em } });
        toast('Код отправлен повторно', 'success');
      } catch (e) {
        toast(e.message || 'Ошибка', 'error');
      } finally {
        loading(false);
      }
    });
  }

  // Logout
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    state.user = null;
    updateAuthUI();
    toast('Вы вышли', 'info');
    switchTab('home');
  }

  // Robux
  async function loadRobuxQuote() {
    const amt = state.robux.amount || 0;
    if (amt <= 0) {
      // Show rate from stock endpoint
      try {
        const s = await api('/api/robux/stock', { silent: true });
        if (s?.rub_per_robux) {
          const currency = localStorage.getItem('rst_currency') || 'rub';
          const rate = currency === 'usd' ? (s.rub_per_robux * 0.011).toFixed(4) : s.rub_per_robux;
          const symbol = currency === 'usd' ? '$' : '₽';
          $('#robuxRate') && ($('#robuxRate').textContent = `Курс: ${rate} ${symbol}/R$`);
        }
      } catch(_){}
      return;
    }
    try {
      const d = await api(`/api/robux/quote?amount=${encodeURIComponent(amt)}`);
      state.robux.quote = d;
      $('#robuxPrice') && ($('#robuxPrice').textContent = fmtCurrency(d.rub_price || 0));
      $('#gamepassPrice') && ($('#gamepassPrice').textContent = `${d.gamepass_price || 0} R$`);
      const currency = localStorage.getItem('rst_currency') || 'rub';
      const rate = currency === 'usd' ? (d.rub_per_robux * 0.011).toFixed(4) : d.rub_per_robux;
      const symbol = currency === 'usd' ? '$' : '₽';
      $('#robuxRate') && ($('#robuxRate').textContent = `Курс: ${rate || '—'} ${symbol}/R$`);
    } catch (e) { /* silent for tab switch */ }
  }

  const debouncedQuote = debounce(loadRobuxQuote, 300);

  // Live stock (availability) for Robux page
  let robuxStockTimer = null;
  let _stockFails = 0;
  async function updateRobuxStock() {
    const badge = $('#robuxStockBadge');
    const el = $('#robuxStock');
    if (!badge || !el) return;
    // Stop polling after 3 consecutive failures
    if (_stockFails >= 3) {
      if (robuxStockTimer) { clearInterval(robuxStockTimer); robuxStockTimer = null; }
      return;
    }
    try {
      const d = await api('/api/robux/stock', { silent: true });
      if (!d) { _stockFails++; return; }
      _stockFails = 0;
      el.textContent = d.text || '—';
      // Sync landing hero stock display
      const heroStock = document.getElementById('robuxStockHero');
      if (heroStock) heroStock.textContent = d.text || '—';
      badge.classList.toggle('out', d.status === 'out_of_stock');
      // Keep rate display fresh with currency conversion
      if (d.rub_per_robux && $('#robuxRate')) {
        const currency = localStorage.getItem('rst_currency') || 'rub';
        const rate = currency === 'usd' ? (d.rub_per_robux * 0.011).toFixed(4) : d.rub_per_robux;
        const symbol = currency === 'usd' ? '$' : '₽';
        $('#robuxRate').textContent = `Курс: ${rate} ${symbol}/R$`;
      }
    } catch (e) {
      _stockFails++;
      el.textContent = '—';
    }
  }
  function startRobuxStock() {
    if (robuxStockTimer) return;
    updateRobuxStock();
    robuxStockTimer = setInterval(updateRobuxStock, 30000);
  }

  async function loadRobuxRecentOrders() {
    if (!state.user) return;
    const box = document.getElementById('robuxRecentOrders');
    if (!box) return;
    try {
      const d = await api('/api/purchases', { silent: true });
      if (!d) return;
      const items = (d.items || []).filter(p => p.item_type === 'robux').slice(0, 3);
      if (!items.length) { box.style.display = 'none'; return; }
      const sc = {done:'#22c55e',processing:'#f59e0b',paid:'#3b82f6',reserved:'#8b5cf6',cancelled:'#6b7280',error:'#ef4444'};
      const labels = {done:'Доставлено',processing:'В процессе',paid:'Ожидает',reserved:'Бронь',cancelled:'Отменён',error:'Ошибка'};
      box.style.display = 'block';
      box.innerHTML = `
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">Ваши заказы</div>
        ${items.map(p => {
          const st = p.delivery?.status || '';
          const col = sc[st] || '#8b5cf6';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)">
            <div style="width:6px;height:6px;border-radius:50%;background:${col};flex-shrink:0"></div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.product_title || '')}</div>
              <div style="font-size:11px;color:var(--text-muted)">${String(p.ts||'').replace('T',' ').slice(0,16)}</div>
            </div>
            <span style="font-size:10px;font-weight:700;color:${col};padding:2px 8px;background:${col}15;border-radius:10px">${labels[st]||st}</span>
          </div>`;
        }).join('')}
      `;
    } catch(e) { box.style.display = 'none'; }
  }

  function debounce(fn, d) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; }
  // Admin
  function _updateAdminTabsFade() {
    const tabsEl = document.getElementById('adminTabsScroll');
    const wrap = tabsEl?.parentElement;
    if (!tabsEl || !wrap) return;
    const { scrollLeft, scrollWidth, clientWidth } = tabsEl;
    wrap.classList.toggle('at-start', scrollLeft <= 4);
    wrap.classList.toggle('at-end', scrollLeft + clientWidth >= scrollWidth - 4);
  }

  async function adminLoad() {
    // Re-check auth in case state.user isn't loaded yet
    if (!state.user) {
      await checkAuth();
    }
    if (!state.user?.is_admin) { toast('Нет доступа', 'error'); switchTab('home'); return; }
    adminInitTabs();
    await adminShowPage(state.adminPage || 'dashboard');
  }

  
  function adminInitTabs(){
    if (state._adminTabsInit) return;
    state._adminTabsInit = true;

    // Fade indicators for horizontal scroll
    const tabsEl = document.getElementById('adminTabsScroll');
    const wrap = tabsEl?.parentElement;
    if (tabsEl && wrap) {
      _updateAdminTabsFade();
      tabsEl.addEventListener('scroll', _updateAdminTabsFade, { passive: true });
    }

    $$('.admin-tab[data-admin-tab]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const page = btn.dataset.adminTab;
        state.adminPage = page;
        await adminShowPage(page);
      });
    });

    // Buttons inside pages
    $('#btnAdminUsersLoad')?.addEventListener('click', ()=> adminLoadUsers());
    $('#btnAdminTopupsLoad')?.addEventListener('click', ()=> adminLoadTopups());
    $('#btnAdminPromoReload')?.addEventListener('click', ()=> adminLoadPromos());
    $('#btnAdminPromoCreate')?.addEventListener('click', ()=> adminCreatePromo());
    $('#btnAdminDiscCreate')?.addEventListener('click', ()=> adminCreateDiscount());
    $('#btnAdminDiscReload')?.addEventListener('click', ()=> adminLoadDiscounts());
    $('#btnAdminEmailTest')?.addEventListener('click', ()=> adminEmailTest());
    $('#btnDashRefresh')?.addEventListener('click', ()=> adminLoadDashboard());
    $('#btnAdminReviewsReload')?.addEventListener('click', ()=> adminLoadReviews());
    $('#btnAdminComplaintsReload')?.addEventListener('click', () => {
      const activeFilter = document.querySelector('.admin-complaint-filter.active');
      adminLoadComplaints(activeFilter?.dataset.cstatus || 'pending');
    });
    $$('.admin-complaint-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.admin-complaint-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        adminLoadComplaints(btn.dataset.cstatus);
      });
    });

    // Enter to search
    $('#adminUsersQuery')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); adminLoadUsers(); }});
    $('#adminTopupStatus')?.addEventListener('change', ()=> adminLoadTopups());

    // initial
    state.adminPage = state.adminPage || 'dashboard';
  }

  async function adminShowPage(page){
    $$('.admin-tab').forEach(b=> b.classList.toggle('active', b.dataset.adminTab === page));
    $$('.admin-page').forEach(p=> p.classList.toggle('active', p.dataset.adminPage === page));

    try{
      if (page === 'dashboard') await adminLoadDashboard();
      if (page === 'shop') await adminShopLoadAndRender();
      if (page === 'robux') { try{ await Promise.all([adminLoadSettings(), adminLoadAccounts(), updateAdminStockHint(), adminLoadOrders()]); }catch(_e){} }
      if (page === 'users') await adminLoadUsers();
      if (page === 'payments') await adminLoadTopups();
      if (page === 'promos') { await adminLoadPromos(); await adminLoadDiscounts(); }
      if (page === 'reviews') await adminLoadReviews();
      if (page === 'complaints') await adminLoadComplaints('pending');
      if (page === 'support') {
        await Promise.all([adminLoadTickets('open'), adminLoadAiChatUsers()]);
      }
      if (page === 'maintenance') { await adminLoadMaintenance(); _wireMaintBtn(); }
      if (page === 'email') {
        try{ await api('/api/admin/email_status', { silent: true }); }catch(e){}
      }
      if (page === 'siteeditor') {
        setTimeout(_initSiteEditorIfNeeded, 50);
      }
      // Scroll active tab into view
      setTimeout(() => {
        const activeTab = document.querySelector(`.admin-tab[data-admin-tab="${page}"]`);
        activeTab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        _updateAdminTabsFade();
      }, 50);
    }catch(e){}
  }

  async function adminLoadDashboard(){
    try{
      const d = await api('/api/admin/stats');
      const el = $('#adminDashboard');
      if(!el) return;
      const cards = [
        {label:'Пользователи', value: d.total_users || 0},
        {label:'Новые (7д)', value: d.new_users_7d || 0},
        {label:'Общий баланс', value: `${Number(d.total_balance||0).toFixed(0)}₽`},
        {label:'Ожидающие пополнения', value: d.pending_topups || 0},
        {label:'Оплачено', value: `${Number(d.paid_revenue||0).toFixed(0)}₽`},
        {label:'Активные заказы', value: d.active_orders || 0},
        {label:'Выполнено заказов', value: d.done_orders || 0},
        {label:'Premium', value: d.premium_users || 0},
        {label:'Промокоды', value: d.promo_codes || 0},
      ];
      el.innerHTML = `<div style="display:flex;justify-content:flex-end;gap:8px;grid-column:1/-1;margin-bottom:-8px">
        <button class="btn btn-secondary btn-sm" onclick="adminLoadDashboard()" style="font-size:11px">🔄 Обновить</button>
        <button class="btn btn-secondary btn-sm" onclick="adminResetStats()" style="font-size:11px;color:#ef4444">🗑 Сбросить статистику</button>
      </div>` + cards.map(c=>`
        <div class="admin-stat-card">
          <div class="admin-stat-value">${c.value}</div>
          <div class="admin-stat-label">${c.label}</div>
        </div>
      `).join('');
    }catch(e){
      const el = $('#adminDashboard');
      const is404 = (e.message || '').includes('404');
      if(el) el.innerHTML = `<div style="color:var(--text-muted);padding:24px;text-align:center;grid-column:1/-1">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" style="margin-bottom:12px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div style="font-size:15px;margin-bottom:6px">${is404 ? 'Сервер не поддерживает этот эндпоинт' : 'Ошибка загрузки'}</div>
        <div style="font-size:13px;opacity:0.6">${_escapeHtml(e.message || '')}</div>
        <div style="font-size:12px;opacity:0.4;margin-top:8px">Проверьте, что на сервере развёрнут актуальный app.py</div>
      </div>`;
    }
  }

  window.adminResetStats = function() {
    modal(`
      <div style="padding:4px 0">
        <h3 style="margin:0 0 16px;font-size:17px">🗑 Сброс статистики</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Выберите что сбросить:</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:10px" onclick="window._doResetStats('all')">
            <span style="font-size:16px">🔥</span> Очистить всё
          </button>
          <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:10px" onclick="window._doResetStats('7d')">
            <span style="font-size:16px">📅</span> За последние 7 дней
          </button>
          <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:10px" onclick="window._doResetStats('30d')">
            <span style="font-size:16px">📅</span> За последние 30 дней
          </button>
          <button class="btn btn-secondary" style="width:100%;justify-content:flex-start;gap:10px" onclick="window._doResetStats('90d')">
            <span style="font-size:16px">📅</span> За последние 90 дней
          </button>
          <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
            <input type="date" id="resetStatsFrom" class="form-input" style="flex:1;font-size:12px">
            <span style="color:var(--text-muted);font-size:12px">→</span>
            <input type="date" id="resetStatsTo" class="form-input" style="flex:1;font-size:12px">
            <button class="btn btn-secondary btn-sm" onclick="window._doResetStats('custom')">Очистить</button>
          </div>
        </div>
        <button class="btn btn-ghost" style="width:100%;margin-top:12px" onclick="closeModal()">Отмена</button>
      </div>
    `, { size: 'small' });
  };

  window._doResetStats = async function(period) {
    const payload = { period };
    if (period === 'custom') {
      payload.from = document.getElementById('resetStatsFrom')?.value || '';
      payload.to = document.getElementById('resetStatsTo')?.value || '';
      if (!payload.from || !payload.to) { toast('Выберите даты', 'warning'); return; }
    }
    try {
      await api('/api/admin/stats/reset', { method: 'POST', body: payload });
      toast('Статистика сброшена', 'success');
      closeModal();
      // Clear ALL caches and force fresh reload
      _profileTxCache = { items: null, fetchedAt: 0 };
      try { adminLoadDashboard(); } catch(e) {}
      setTimeout(() => profileRefreshAnalytics(true).catch(()=>{}), 200);
    } catch(e) {
      toast(e.message || 'Ошибка сброса', 'error');
    }
  };

  async function adminLoadUsers(){
    try{
      loading(true);
      const q = ($('#adminUsersQuery')?.value || '').trim();
      const d = await api(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      const tbody = $('#adminUsersTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      (d.users || []).forEach(u=>{
        const tr = document.createElement('tr');
        const prem = u.premium_until ? _fmtDatetime(u.premium_until) : '';
        tr.innerHTML = `
          <td>${u.id}</td>
          <td>${escapeHtml(u.username||'')}</td>
          <td>${escapeHtml(u.email||'')}</td>
          <td>${Number(u.balance||0).toFixed(2)}</td>
          <td>${u.premium_until ? `<span style="color:#a855f7">до ${_fmtDatetime(u.premium_until)}</span>` : '—'}</td>
          <td>${u.banned_until ? `<span style="color:#ef4444">до ${_fmtDatetime(u.banned_until)}</span>` : '—'}</td>
          <td><button class="btn btn-secondary btn-sm" data-user="${u.id}">Открыть</button></td>
        `;
        tr.querySelector('button')?.addEventListener('click', ()=> adminOpenUser(u.id));
        tbody.appendChild(tr);
      });
    }catch(e){
      toast(e.message || 'Ошибка', 'error');
    }finally{ loading(false); }
  }

  async function adminOpenUser(userId){
    try{
      loading(true);
      const _ud = await api(`/api/admin/user?ident=${encodeURIComponent(userId)}`);
      const tx = await api(`/api/admin/tx?user_id=${encodeURIComponent(userId)}`);
      loading(false);

      const u = _ud.user || _ud;

      const txRows = (tx.tx || tx.txs || []).slice(0, 20).map(t=> {
        const dt = t.ts ? _fmtDatetime(t.ts) : '';
        const sign = (t.delta||0) >= 0 ? '+' : '';
        const color = (t.delta||0) >= 0 ? '#22c55e' : '#ef4444';
        return `<tr>
          <td style="color:var(--text-muted);font-size:11px;white-space:nowrap">${escapeHtml(dt)}</td>
          <td style="color:${color};font-weight:700">${sign}${Number(t.delta||0).toFixed(2)} ₽</td>
          <td style="color:var(--text-secondary);font-size:12px">${escapeHtml(t.reason||'')}</td>
        </tr>`;
      }).join('');

      const premiumUntil = u.premium_until ? new Date(u.premium_until) : null;
      const isPremium = premiumUntil && premiumUntil > new Date();
      const lastSeenText = u.last_seen_at ? _fmtDatetime(u.last_seen_at) : '—';
      const regText = u.created_at ? _fmtDate(u.created_at) : '—';
      const ipText = u.last_ip || '—';
      const regionText = [u.last_city, u.last_country].filter(Boolean).join(', ') || '—';
      const caseCD = u.case_next_at ? new Date(u.case_next_at) : null;
      const paidCD = u.case_money_next_at ? new Date(u.case_money_next_at) : null;
      const now = new Date();

      modal(`
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          <div style="width:48px;height:48px;border-radius:50%;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;flex-shrink:0">${escapeHtml((u.username||'?')[0].toUpperCase())}</div>
          <div>
            <div style="font-size:18px;font-weight:700">${escapeHtml(u.username||'—')}</div>
            <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(u.email||'—')} · ID #${u.id}</div>
          </div>
          ${isPremium ? '<span style="background:var(--accent-gradient);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">⭐ Premium</span>' : ''}
          ${u.banned_until && new Date(u.banned_until) > now ? '<span style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">🚫 Забанен</span>' : ''}
        </div>

        <!-- Info grid -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Баланс</div>
            <div style="font-size:18px;font-weight:700;color:var(--accent-tertiary)">${Number(u.balance||0).toFixed(2)} ₽</div>
          </div>
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Premium до</div>
            <div style="font-size:13px;font-weight:600;color:${isPremium?'#fbbf24':'var(--text-muted)'}">${isPremium ? _fmtDate(premiumUntil.toISOString()) : 'Нет'}</div>
          </div>
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Последний вход</div>
            <div style="font-size:12px;font-weight:500">${lastSeenText}</div>
          </div>
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Регистрация</div>
            <div style="font-size:12px;font-weight:500">${regText}</div>
          </div>
        </div>

        <!-- IP/Region -->
        <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px 14px;margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap">
          <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">IP: </span><span style="font-size:13px;font-weight:600;font-family:monospace">${escapeHtml(ipText)}</span></div>
          <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">Регион: </span><span style="font-size:13px;font-weight:600">${escapeHtml(regionText)}</span></div>
        </div>

        <!-- Tabs -->
        <div style="display:flex;gap:3px;background:rgba(255,255,255,.03);border-radius:10px;padding:4px;margin-bottom:14px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none">
          <button class="admin-user-tab-btn active" data-autab="balance" style="flex:none;padding:8px 14px;border:none;border-radius:8px;background:var(--accent-gradient);color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">💰 Баланс</button>
          <button class="admin-user-tab-btn" data-autab="purchases" style="flex:none;padding:8px 14px;border:none;border-radius:8px;background:transparent;color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">🛒 Покупки</button>
          <button class="admin-user-tab-btn" data-autab="ban" style="flex:none;padding:8px 14px;border:none;border-radius:8px;background:transparent;color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">🚫 Бан</button>
          <button class="admin-user-tab-btn" data-autab="premium" style="flex:none;padding:8px 14px;border:none;border-radius:8px;background:transparent;color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">⭐ Prem</button>
          <button class="admin-user-tab-btn" data-autab="security" style="flex:none;padding:8px 14px;border:none;border-radius:8px;background:transparent;color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">🔐 Безоп.</button>
          <button class="admin-user-tab-btn" data-autab="notify" style="flex:none;padding:8px 14px;border:none;border-radius:8px;background:transparent;color:var(--text-muted);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">🔔 Уведом.</button>
        </div>

        <!-- Tab: Balance -->
        <div class="admin-user-tab active" data-autab="balance">
          <div class="grid-2" style="margin-bottom:10px">
            <div class="form-group">
              <label class="form-label">Изменить баланс (₽)</label>
              <input class="form-input" id="adminUserBalDelta" type="number" step="0.01" placeholder="+100 или -50">
            </div>
            <div class="form-group">
              <label class="form-label">Причина</label>
              <input class="form-input" id="adminUserBalReason" placeholder="ручная корректировка">
            </div>
          </div>
          <button class="btn btn-primary" style="width:100%" id="adminUserBalApply">Применить</button>
        </div>

        <!-- Tab: Purchases -->
        <div class="admin-user-tab hidden" data-autab="purchases">
          <div style="font-weight:700;font-size:13px;margin-bottom:10px;color:var(--text-secondary)">История покупок / пополнений</div>
          <div id="adminUserPurchases" style="max-height:320px;overflow-y:auto">
            <div style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px">Загрузка...</div>
          </div>
        </div>

        <!-- Tab: Ban -->
        <div class="admin-user-tab hidden" data-autab="ban">
          <!-- Warn system -->
          <div style="margin-bottom:14px;padding:12px 14px;background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.18);border-radius:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-weight:700;font-size:13px;color:#f59e0b">⚠️ Система варнов</div>
              <div id="adminUserWarnCount" style="font-size:12px;color:var(--text-muted)">Загрузка...</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
              ${[1,2,3].map(i=>`<div style="width:32px;height:32px;border-radius:8px;border:2px solid rgba(245,158,11,.3);display:flex;align-items:center;justify-content:center;font-size:16px" id="warnDot${i}">⚪</div>`).join('')}
            </div>
            <div class="form-group" style="margin-bottom:8px">
              <input class="form-input" id="adminUserWarnReason" placeholder="Причина варна..." style="font-size:13px">
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-sm" style="flex:1;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);color:#f59e0b" id="adminUserWarn">⚠️ Выдать варн</button>
              <button class="btn btn-secondary btn-sm" style="flex:1" id="adminUserRemoveWarn">Снять варн</button>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px">3 варна = автоматический постоянный бан</div>
          </div>

          <!-- Ban / Unban -->
          <div style="padding:12px 14px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.18);border-radius:12px">
            <div style="font-weight:700;font-size:13px;color:#ef4444;margin-bottom:10px">🚫 Прямой бан</div>
            <div style="display:flex;gap:8px;margin-bottom:8px">
              <div class="form-group" style="flex:1;margin:0">
                <input class="form-input" id="adminUserBanDays" type="number" min="0" value="7" placeholder="Дней (0=навсегда)">
              </div>
              <div class="form-group" style="flex:2;margin:0">
                <input class="form-input" id="adminUserBanReason" placeholder="Причина бана...">
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-danger" id="adminUserBan" style="flex:1">🚫 Забанить</button>
              <button class="btn btn-secondary" id="adminUserUnban" style="flex:1">✅ Разбанить</button>
              <button class="btn btn-secondary" id="adminUserRename" style="flex:1">✏️ Логин</button>
            </div>
          </div>
        </div>

        <!-- Tab: Premium -->
        <div class="admin-user-tab hidden" data-autab="premium">
          <div style="margin-bottom:10px;padding:10px 12px;background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.2);border-radius:10px;font-size:13px">
            Статус: <b style="color:${isPremium?'#fbbf24':'var(--text-muted)'}">${isPremium ? 'Активен до ' + premiumUntil.toLocaleString('ru-RU') : 'Не активен'}</b>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label class="form-label">Выдать на дней</label>
            <input class="form-input" id="adminUserPremDays" type="number" min="1" value="30" placeholder="30">
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" id="adminUserGrantPrem" style="flex:1">⭐ Выдать Premium</button>
            <button class="btn btn-danger" id="adminUserRevokePrem" style="flex:1">✕ Снять Premium</button>
          </div>
        </div>

        <!-- Tab: Security -->
        <div class="admin-user-tab hidden" data-autab="security">
          <div style="margin-bottom:14px">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Кулдаун кейсов</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
              <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:8px 12px">
                <div style="font-size:10px;color:var(--text-muted)">Бесплатный кейс</div>
                <div style="font-size:12px;font-weight:600;color:${caseCD && caseCD > now ? '#ef4444' : '#22c55e'}">${caseCD && caseCD > now ? 'Кулдаун до ' + caseCD.toLocaleString('ru-RU') : 'Готов'}</div>
              </div>
              <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:8px 12px">
                <div style="font-size:10px;color:var(--text-muted)">Платный кейс</div>
                <div style="font-size:12px;font-weight:600;color:${paidCD && paidCD > now ? '#ef4444' : '#22c55e'}">${paidCD && paidCD > now ? 'Кулдаун до ' + paidCD.toLocaleString('ru-RU') : 'Готов'}</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-secondary btn-sm" id="adminResetFreeCd" style="flex:1">Сбросить бесплатный</button>
              <button class="btn btn-secondary btn-sm" id="adminResetPaidCd" style="flex:1">Сбросить платный</button>
              <button class="btn btn-danger btn-sm" id="adminResetAllCd" style="flex:1">Сбросить все CD</button>
            </div>
          </div>
          <div style="border-top:1px solid var(--border-color);padding-top:14px">
            <div class="form-group" style="margin-bottom:8px">
              <label class="form-label">Новый пароль</label>
              <input class="form-input" id="adminUserNewPass" type="password" placeholder="Минимум 6 символов">
            </div>
            <button class="btn btn-secondary" style="width:100%" id="adminUserSetPass">🔑 Сменить пароль</button>
          </div>
        </div>

        <!-- Tab: Notify -->
        <div class="admin-user-tab hidden" data-autab="notify">
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label">Заголовок</label>
            <input class="form-input" id="adminUserNotifTitle" placeholder="Уведомление от администратора">
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label class="form-label">Сообщение</label>
            <textarea class="form-input" id="adminUserNotifMsg" rows="3" style="resize:vertical;min-height:80px" placeholder="Текст уведомления..."></textarea>
          </div>
          <button class="btn btn-primary" style="width:100%" id="adminUserSendNotif">🔔 Отправить уведомление</button>
        </div>

        <!-- Transactions -->
        <div style="border-top:1px solid var(--border-color);margin-top:16px;padding-top:14px">
          <div style="font-weight:700;margin-bottom:8px;font-size:14px">📋 Последние транзакции</div>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead><tr><th>Дата</th><th>Сумма</th><th>Причина</th></tr></thead>
              <tbody>${txRows || '<tr><td colspan="3" class="muted" style="text-align:center;padding:12px">Нет операций</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      `, { size: 'wide' });

      // Tab switching
      document.querySelectorAll('.admin-user-tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const tab = btn.dataset.autab;
          document.querySelectorAll('.admin-user-tab-btn').forEach(b => {
            b.style.background = 'transparent';
            b.style.color = 'var(--text-muted)';
          });
          btn.style.background = 'var(--accent-gradient)';
          btn.style.color = '#fff';
          document.querySelectorAll('.admin-user-tab').forEach(p => p.classList.add('hidden'));
          document.querySelector(`.admin-user-tab[data-autab="${tab}"]`)?.classList.remove('hidden');
          // Load purchases on tab open
          if (tab === 'purchases') await _loadAdminUserPurchases(u.id);
        });
      });

      // Load purchases helper
      async function _loadAdminUserPurchases(uid) {
        const el = document.getElementById('adminUserPurchases');
        if (!el) return;
        try {
          const d = await api(`/api/admin/user/purchases?user_id=${uid}`, { silent: true });
          const list = d?.purchases || [];
          if (!list.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px">Нет покупок</div>'; return; }
          const typeIcons = {topup:'💰',robux:'💎',premium:'⭐',shop:'🛒'};
          const stMap = {paid:'✅',done:'✅',pending:'⏳',active:'🔄',cancelled:'❌',error:'❌',expired:'⌛',refunded:'↩️'};
          const stColors = {paid:'#22c55e',done:'#22c55e',pending:'#f59e0b',active:'#3b82f6',cancelled:'#6b7280',error:'#ef4444',expired:'#6b7280',refunded:'#f59e0b'};
          el.innerHTML = `<table style="width:100%;font-size:12px;border-collapse:collapse">
            <thead><tr style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px">
              <th style="padding:6px 8px;text-align:left">Тип</th>
              <th style="padding:6px 8px;text-align:right">Сумма</th>
              <th style="padding:6px 8px;text-align:center">Статус</th>
              <th style="padding:6px 8px;text-align:left">Дата</th>
            </tr></thead>
            <tbody>${list.map(p => {
              const icon = typeIcons[p.type] || '📦';
              const label = p.label || p.method || p.provider || '—';
              const amt = p.fiat_cents ? (p.fiat_cents/100).toFixed(0) + ' ₽' : p.points ? p.points + ' pts' : '—';
              const st = p.status || '';
              const stIcon = stMap[st] || st;
              const stCol = stColors[st] || 'var(--text-muted)';
              return `<tr style="border-top:1px solid rgba(255,255,255,.04)">
                <td style="padding:7px 8px"><span style="margin-right:4px">${icon}</span>${escapeHtml(label)}</td>
                <td style="padding:7px 8px;text-align:right;font-weight:700;font-family:monospace">${amt}</td>
                <td style="padding:7px 8px;text-align:center;color:${stCol};font-size:11px">${stIcon}</td>
                <td style="padding:7px 8px;color:var(--text-muted);font-size:11px">${p.created_at ? new Date(p.created_at).toLocaleString('ru',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'}</td>
              </tr>`;
            }).join('')}</tbody></table>`;
        } catch(e) { el.innerHTML = `<div style="color:#ef4444;padding:10px;font-size:12px">Ошибка: ${e.message||'?'}</div>`; }
      }

      // Balance apply
      $('#adminUserBalApply')?.addEventListener('click', async ()=>{
        const delta = parseFloat($('#adminUserBalDelta')?.value || '0');
        const reason = ($('#adminUserBalReason')?.value || '').trim();
        if (!delta) return toast('Укажи delta', 'warning');
        try{
          loading(true);
          await api('/api/admin/balance_adjust', { method:'POST', body:{ user_id: u.id, delta, reason }});
          toast('Баланс обновлён', 'success');
          closeModal(); await adminLoadUsers();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

      // Ban
      $('#adminUserBan')?.addEventListener('click', async ()=>{
        const days = parseInt($('#adminUserBanDays')?.value || '7');
        const reason = ($('#adminUserBanReason')?.value || '').trim();
        if (!confirm(`Забанить пользователя${days?` на ${days} дней`:' навсегда'}?`)) return;
        try{
          loading(true);
          await api('/api/admin/user/ban', { method:'POST', body:{ user_id: u.id, days: days || undefined, reason }});
          toast('Бан применён', 'success');
          closeModal(); await adminLoadUsers();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

      // Unban
      $('#adminUserUnban')?.addEventListener('click', async ()=>{
        try{
          loading(true);
          await api('/api/admin/user/unban', { method:'POST', body:{ user_id: u.id }});
          toast('Разбан', 'success');
          closeModal(); await adminLoadUsers();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

      // Warn system: load warns when ban tab shown
      const loadWarnUI = async () => {
        try {
          const wd = await api(`/api/admin/user/warns?user_id=${u.id}`, { silent: true });
          const warns = wd.warns || [];
          const cnt = warns.length;
          const countEl = document.getElementById('adminUserWarnCount');
          if (countEl) countEl.textContent = `${cnt}/3 варна`;
          [1,2,3].forEach(i => {
            const dot = document.getElementById(`warnDot${i}`);
            if (dot) dot.textContent = i <= cnt ? '🟠' : '⚪';
          });
        } catch(_e) {}
      };

      document.querySelectorAll('.admin-user-tab-btn').forEach(btn => {
        if (btn.dataset.autab === 'ban') btn.addEventListener('click', loadWarnUI, { once: true });
      });

      $('#adminUserWarn')?.addEventListener('click', async () => {
        const reason = ($('#adminUserWarnReason')?.value || '').trim() || 'Нарушение правил';
        if (!confirm(`Выдать варн пользователю ${u.username}?\nПричина: ${reason}`)) return;
        try {
          loading(true);
          const r = await api('/api/admin/user/warn', { method:'POST', body:{ user_id: u.id, reason }});
          if (r.auto_banned) {
            toast(`🚫 ${u.username} автоматически забанен (${r.warn_count} варна)`, 'error');
          } else {
            toast(`⚠️ Варн выдан. Итого: ${r.warn_count}/3`, 'warning');
          }
          loadWarnUI();
          if (r.auto_banned) { closeModal(); await adminLoadUsers(); }
        } catch(e) { toast(e.message||'Ошибка', 'error'); } finally { loading(false); }
      });

      $('#adminUserRemoveWarn')?.addEventListener('click', async () => {
        if (!confirm(`Снять последний варн у ${u.username}?`)) return;
        try {
          loading(true);
          const r = await api('/api/admin/user/unwarn', { method:'POST', body:{ user_id: u.id }});
          toast(`Варн снят. Осталось: ${r.warn_count}/3`, 'success');
          loadWarnUI();
        } catch(e) { toast(e.message||'Ошибка', 'error'); } finally { loading(false); }
      });

      // Rename
      $('#adminUserRename')?.addEventListener('click', async ()=>{
        const newName = prompt('Новый логин:', u.username||'');
        if (!newName) return;
        try{
          loading(true);
          await api('/api/admin/user/rename', { method:'POST', body:{ user_id: u.id, new_username: newName.trim() }});
          toast('Логин обновлён', 'success');
          closeModal(); await adminLoadUsers();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

      // Grant premium
      $('#adminUserGrantPrem')?.addEventListener('click', async ()=>{
        const days = parseInt($('#adminUserPremDays')?.value || '30');
        try{
          loading(true);
          await api('/api/admin/user/set_premium', { method:'POST', body:{ user_id: u.id, action:'grant', days }});
          toast(`Premium выдан на ${days} дней`, 'success');
          closeModal(); await adminLoadUsers();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

      // Revoke premium
      $('#adminUserRevokePrem')?.addEventListener('click', async ()=>{
        if (!confirm('Снять Premium у пользователя?')) return;
        try{
          loading(true);
          await api('/api/admin/user/set_premium', { method:'POST', body:{ user_id: u.id, action:'revoke' }});
          toast('Premium снят', 'success');
          closeModal(); await adminLoadUsers();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

      // Reset cooldowns
      const resetCd = async (type) => {
        try{
          loading(true);
          await api('/api/admin/user/reset_cooldown', { method:'POST', body:{ user_id: u.id, type }});
          toast('Кулдаун сброшен', 'success');
          closeModal();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      };
      $('#adminResetFreeCd')?.addEventListener('click', ()=>resetCd('free'));
      $('#adminResetPaidCd')?.addEventListener('click', ()=>resetCd('paid'));
      $('#adminResetAllCd')?.addEventListener('click', ()=>resetCd('all'));

      // Set password
      $('#adminUserSetPass')?.addEventListener('click', async ()=>{
        const pw = $('#adminUserNewPass')?.value?.trim();
        if (!pw || pw.length < 6) return toast('Минимум 6 символов', 'warning');
        if (!confirm(`Сменить пароль для ${u.username}?`)) return;
        try{
          loading(true);
          await api('/api/admin/user/set_password', { method:'POST', body:{ user_id: u.id, password: pw }});
          toast('Пароль изменён', 'success');
          closeModal();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

      // Send notification
      $('#adminUserSendNotif')?.addEventListener('click', async ()=>{
        const title = ($('#adminUserNotifTitle')?.value||'').trim() || 'Уведомление от администратора';
        const message = ($('#adminUserNotifMsg')?.value||'').trim();
        if (!message) return toast('Введите текст уведомления', 'warning');
        try{
          loading(true);
          await api('/api/admin/notifications/send', { method:'POST', body:{ target:'user', user_id: String(u.id), title, message }});
          toast('Уведомление отправлено', 'success');
          closeModal();
        }catch(e){ toast(e.message||'Ошибка', 'error'); } finally{ loading(false); }
      });

    }catch(e){
      loading(false);
      toast(e.message || 'Ошибка', 'error');
    }
  }


  async function adminLoadTopups(){
    try{
      loading(true);
      const status = ($('#adminTopupStatus')?.value || 'pending');
      const d = await api(`/api/admin/topups?status=${encodeURIComponent(status)}`);
      const tbody = $('#adminTopupsTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      (d.items || []).forEach(t=>{
        const tr = document.createElement('tr');
        const dt = t.created_at ? _fmtDatetime(t.created_at) : '';
        tr.innerHTML = `
          <td>${t.id}</td>
          <td>${escapeHtml(t.username || String(t.user_id || '—'))}</td>
          <td>${t.points || 0}</td>
          <td>${escapeHtml((t.provider ? `${t.provider} / ` : '') + (t.method || ''))}</td>
          <td>${escapeHtml(t.status||'')}</td>
          <td>${escapeHtml(dt)}</td>
          <td>${status==='pending' ? `<button class="btn btn-secondary btn-sm" data-act="approve">Одобрить</button>
                                     <button class="btn btn-secondary btn-sm" data-act="reject" style="margin-left:6px">Отклонить</button>` : '—'}</td>
        `;
        if (status==='pending'){
          tr.querySelector('[data-act="approve"]')?.addEventListener('click', ()=> adminTopupAct(t.id,'approve'));
          tr.querySelector('[data-act="reject"]')?.addEventListener('click', ()=> adminTopupAct(t.id,'reject'));
        }
        tbody.appendChild(tr);
      });
    }catch(e){
      toast(e.message || 'Ошибка', 'error');
    }finally{ loading(false); }
  }

  async function adminTopupAct(id, act){
    try{
      loading(true);
      const url = act==='approve' ? '/api/admin/topup/approve' : '/api/admin/topup/reject';
      const reason = act==='reject' ? prompt('Причина (опционально):') || '' : '';
      await api(url, { method:'POST', body:{ id, reason }});
      toast('Готово', 'success');
      await adminLoadTopups();
    }catch(e){
      toast(e.message || 'Ошибка', 'error');
    }finally{ loading(false); }
  }

  async function adminLoadPromos(){
    try{
      loading(true);
      const d = await api('/api/admin/promo/list');
      const tbody = $('#adminPromoTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      (d.items || []).forEach(p=>{
        const tr = document.createElement('tr');
        const created = p.created_at ? _fmtDatetime(p.created_at) : '—';
        tr.innerHTML = `<td>${escapeHtml(p.code||'')}</td><td>${p.amount_rub||0} ₽</td><td>${p.uses||0}/${p.max_uses||0}</td><td>${escapeHtml(created)}</td><td style="white-space:nowrap"><button class="btn btn-secondary btn-sm" onclick="window._editPromo('${escapeHtml(p.code)}',${p.amount_rub||0},${p.max_uses||0})">✎</button> <button class="btn btn-secondary btn-sm" onclick="window._delPromo('${escapeHtml(p.code)}')">✕</button></td>`;
        tbody.appendChild(tr);
      });
    }catch(e){
      toast(e.message || 'Ошибка', 'error');
    }finally{ loading(false); }
  }
  window._editPromo = function(code, amt, mx) {
    modal(`<h3 style="margin:0 0 12px">Редактировать: ${escapeHtml(code)}</h3>
      <div class="form-group" style="margin-bottom:8px"><label class="form-label">Сумма (₽)</label><input class="form-input" id="_epAmt" type="number" value="${amt}"></div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Макс. использований</label><input class="form-input" id="_epMax" type="number" value="${mx}"></div>
      <div style="display:flex;gap:8px"><button class="btn btn-primary" id="_epSave" style="flex:1">Сохранить</button><button class="btn btn-secondary" onclick="closeModal()" style="flex:1">Отмена</button></div>`);
    document.getElementById('_epSave')?.addEventListener('click', async()=>{
      try{ await api('/api/admin/promo/edit',{method:'POST',body:{code,amount_rub:parseFloat(document.getElementById('_epAmt')?.value||0),max_uses:parseInt(document.getElementById('_epMax')?.value||1)}}); toast('Обновлено','success'); closeModal(); adminLoadPromos(); }catch(e){toast(e.message,'error');}
    });
  };
  window._delPromo = async function(code) {
    if(!confirm('Удалить промокод '+code+'?'))return;
    try{await api('/api/admin/promo/delete',{method:'POST',body:{code}});toast('Удалён','success');adminLoadPromos();}catch(e){toast(e.message,'error');}
  };

  async function adminCreatePromo(){
    const code = ($('#adminPromoCode')?.value || '').trim();
    const amount_rub = parseFloat($('#adminPromoAmountRub')?.value || '0') || 0;
    const max_uses = parseInt($('#adminPromoMaxUses')?.value || '100') || 100;
    if (!code) return toast('Укажи код', 'warning');
    if (amount_rub <= 0) return toast('Укажи сумму в ₽', 'warning');
    try{
      loading(true);
      await api('/api/admin/promo/create', { method:'POST', body:{ code, amount_rub, max_uses }});
      toast('Промокод создан!', 'success');
      await adminLoadPromos();
    }catch(e){
      toast(e.message || 'Ошибка', 'error');
    }finally{ loading(false); }
  }

  // ── Discount codes (скидки) ──
  async function adminLoadDiscounts() {
    try {
      const d = await api('/api/admin/discounts');
      const tbody = document.querySelector('#adminDiscTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      const codes = d.codes || [];
      if (!codes.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:16px">Нет скидок. Создайте первую!</td></tr>';
        return;
      }
      codes.forEach(dc => {
        const tr = document.createElement('tr');
        const discDisplay = dc.type === 'percent' ? dc.value + '%' : dc.value + '₽';
        const appliesMap = { all:'Всё', shop:'Магазин', robux:'Робуксы' };
        const exp = dc.expires_at ? new Date(dc.expires_at).toLocaleDateString('ru') : '—';
        const activeStyle = dc.active ? '' : 'opacity:0.4;';
        tr.style.cssText = activeStyle;
        tr.innerHTML = `
          <td style="font-weight:600;font-family:monospace">${escapeHtml(dc.code)}</td>
          <td style="color:var(--accent-tertiary);font-weight:700">-${discDisplay}</td>
          <td>${appliesMap[dc.applies_to] || dc.applies_to}</td>
          <td>${dc.min_purchase || 0}₽</td>
          <td>${dc.uses || 0}/${dc.max_uses || 0}</td>
          <td>${exp}</td>
          <td><button class="btn btn-secondary btn-sm" onclick="window._delDiscount('${escapeHtml(dc.code)}')">✕</button></td>
        `;
        tbody.appendChild(tr);
      });
    } catch(e) {
      const tbody = document.querySelector('#adminDiscTable tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#ef4444;padding:16px">Ошибка: ${e.message || 'неизвестная'}</td></tr>`;
    }
  }

  window._delDiscount = async function(code) {
    if (!confirm('Удалить скидку ' + code + '?')) return;
    try { await api('/api/admin/discount/delete', { method:'POST', body:{ code }}); toast('Удалено', 'success'); adminLoadDiscounts(); } catch(e) { toast(e.message, 'error'); }
  };

  async function adminCreateDiscount() {
    const code = ($('#adminDiscCode')?.value || '').trim();
    const type = $('#adminDiscType')?.value || 'percent';
    const value = parseFloat($('#adminDiscValue')?.value || '0') || 0;
    const applies_to = $('#adminDiscApplies')?.value || 'all';
    const min_purchase = parseFloat($('#adminDiscMin')?.value || '0') || 0;
    const max_uses = parseInt($('#adminDiscMaxUses')?.value || '100') || 100;
    const expires_at = $('#adminDiscExpires')?.value || '';
    const note = ($('#adminDiscNote')?.value || '').trim();
    if (!code) return toast('Укажи код', 'warning');
    if (value <= 0) return toast('Укажи значение скидки', 'warning');
    try {
      loading(true);
      await api('/api/admin/discount/create', { method:'POST', body:{ code, type, value, applies_to, min_purchase, max_uses, expires_at: expires_at || undefined, note }});
      toast('Скидка создана!', 'success');
      if ($('#adminDiscCode')) $('#adminDiscCode').value = '';
      await adminLoadDiscounts();
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
    finally { loading(false); }
  }

  async function adminEmailTest(){
    const email = ($('#adminEmailTo')?.value || '').trim();
    if (!email) return toast('Укажи email', 'warning');
    try{
      loading(true);
      await api('/api/admin/email_test', { method:'POST', body:{ to: email }});
      toast('Отправлено', 'success');
    }catch(e){
      toast(e.message || 'Ошибка', 'error');
    }finally{ loading(false); }
  }

async function adminLoadSettings() {
    try {
      const d = await api('/api/admin/robux/settings');
      const s = d.settings || d;
      $('#adminRublePerRobux') && ($('#adminRublePerRobux').value = s.rub_per_robux ?? '');
      $('#adminGpFactor') && ($('#adminGpFactor').value = s.gp_factor ?? '');
      $('#adminFeeRub') && ($('#adminFeeRub').value = s.fee_rub ?? s.commission_rub ?? '0');
      $('#adminStockSell') && ($('#adminStockSell').value = s.stock_sell ?? '');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function adminSaveSettings(e) {
    e?.preventDefault?.();
    try {
      const payload = {
        rub_per_robux: Number($('#adminRublePerRobux')?.value || 0),
        gp_factor: Number($('#adminGpFactor')?.value || 1.43),
        stock_sell: Number($('#adminStockSell')?.value || 0),
      };
      await api('/api/admin/robux/settings', { method: 'POST', body: payload });
      toast('Настройки Robux сохранены', 'success');
      await updateAdminStockHint();
      // Reload quote on the Robux page so user sees updated rate
      loadRobuxQuote();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function updateAdminStockHint() {
    const el = $('#adminStockHint');
    if (!el) return;
    try {
      const d = await api('/api/robux/stock', { silent: true }); if (!d) return;
      el.textContent = `Наличие сейчас: ${d.text || '—'} (резерв: ${d.reserved || 0}, аккаунтов: ${d.accounts || 0})`;
    } catch (e) { el.textContent = 'Наличие сейчас: —'; }
  }

  // --- Admin: Robux Orders ---
  let _adminOrderFilter = 'active';
  async function adminLoadOrders() {
    const box = $('#adminOrdersList');
    if (!box) return;
    box.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 8px"></div>Загрузка...</div>';
    try {
      const d = await api(`/api/admin/robux/orders?status=${_adminOrderFilter}&limit=50`);
      const items = d.items || [];
      if (!items.length) {
        box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Заказов нет</div>';
        return;
      }
      box.innerHTML = items.map(o => {
        const sc = {done:'#22c55e',processing:'#f59e0b',paid:'#3b82f6',reserved:'#8b5cf6',cancelled:'#6b7280',refunded:'#ef4444',error:'#ef4444',expired:'#6b7280',failed:'#ef4444',new:'#8b5cf6'};
        const labels = {done:'Доставлено',processing:'Отправляется',paid:'Ожидает',reserved:'Бронь',cancelled:'Отменён',refunded:'Возврат',error:'Ошибка',expired:'Истёк',failed:'Ошибка',new:'Новый'};
        const col = sc[o.status] || '#8b5cf6';
        const canCancel = ['reserved','paid','processing'].includes(o.status);
        const fmtDt = s => s ? String(s).replace('T',' ').slice(0,16) : '';
        return `<div style="padding:12px 14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-left:3px solid ${col};border-radius:10px;font-size:13px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <span style="font-weight:700;color:var(--accent-tertiary)">#${o.id}</span>
            <span style="font-weight:600">${escapeHtml(o.username || 'uid:'+o.user_id)}</span>
            <span style="margin-left:auto;padding:2px 10px;border-radius:20px;background:${col}18;color:${col};font-weight:700;font-size:11px">${labels[o.status]||o.status}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--text-secondary);font-size:12px">
            <span>🟣 ${o.robux_amount} R$ → ${fmtCurrency(o.rub_price)}</span>
            ${o.gamepass_owner ? `<span>👤 ${escapeHtml(o.gamepass_owner)}</span>` : ''}
            ${o.gamepass_name ? `<span>🎮 ${escapeHtml(o.gamepass_name)}</span>` : ''}
            <span>📅 ${fmtDt(o.created_at)}</span>
            ${o.done_at ? `<span>✅ ${fmtDt(o.done_at)}</span>` : ''}
            ${o.cancelled_at ? `<span>🚫 ${fmtDt(o.cancelled_at)}</span>` : ''}
          </div>
          ${o.error ? `<div style="margin-top:6px;padding:6px 10px;background:rgba(239,68,68,.06);border-radius:6px;font-size:11px;color:var(--danger)">${escapeHtml(o.error)}</div>` : ''}
          ${o.cancel_reason ? `<div style="margin-top:6px;padding:6px 10px;background:rgba(107,114,128,.06);border-radius:6px;font-size:11px;color:var(--text-muted)">Причина: ${escapeHtml(o.cancel_reason)} ${o.cancelled_by ? '('+escapeHtml(o.cancelled_by)+')' : ''}</div>` : ''}
          ${canCancel ? `<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" style="color:var(--danger);border:1px solid rgba(239,68,68,.2);font-size:11px;padding:4px 12px" onclick="window._adminCancelOrder(${o.id})">Отменить</button></div>` : ''}
        </div>`;
      }).join('');
    } catch(e) {
      box.innerHTML = `<div style="text-align:center;padding:24px;color:var(--danger)">${escapeHtml(e.message)}</div>`;
    }
  }

  window._adminCancelOrder = async function(orderId) {
    const reason = prompt('Причина отмены:', 'Отменён администратором');
    if (reason === null) return;
    try {
      await api('/api/admin/robux/order_cancel', { method: 'POST', body: { order_id: orderId, reason: reason || 'Отменён администратором' }});
      toast('Заказ отменён', 'success');
      adminLoadOrders();
      updateAdminStockHint();
    } catch(e) { toast(e.message, 'error'); }
  };

  function renderAdminAccounts(items) {
    const box = $('#adminAccountsList');
    if (!box) return;
    if (!items?.length) {
      box.innerHTML = '<div class="admin-hint">Аккаунтов пока нет. Добавь куки выше.</div>';
      return;
    }
    box.innerHTML = items.map(a => {
      const statusColor = a.is_active ? 'var(--success)' : 'var(--text-muted)';
      const statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};${a.is_active ? 'box-shadow:0 0 8px rgba(34,197,94,.4)' : ''};margin-right:6px;vertical-align:middle"></span>`;
      return `
      <div class="admin-item" style="border-left:3px solid ${statusColor}">
        <div class="admin-item-top">
          <div style="width:40px;height:40px;border-radius:10px;background:rgba(147,51,234,.08);border:1px solid rgba(147,51,234,.15);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🎮</div>
          <div class="admin-item-title" style="flex:1;min-width:0">
            <div class="main" style="display:flex;align-items:center;gap:6px">
              ${escapeHtml(a.label || a.roblox_username || ('Account #' + a.id))}
              <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${a.is_active ? 'rgba(34,197,94,.12)' : 'rgba(156,163,175,.12)'};color:${statusColor};font-weight:600">${a.is_active ? 'Активен' : 'Выключен'}</span>
            </div>
            <div class="sub" style="display:flex;gap:12px;margin-top:4px">
              <span>@${escapeHtml(a.roblox_username || '—')}</span>
              <span style="color:var(--accent-tertiary);font-weight:600">${a.robux_balance ?? 0} R$</span>
            </div>
            ${a.last_error ? `<div class="sub" style="color:var(--danger);opacity:.9;margin-top:2px">⚠ ${escapeHtml(a.last_error)}</div>` : ''}
          </div>
          <div class="admin-item-actions">
            <button class="btn btn-secondary" data-admin-act="refresh" data-id="${a.id}" title="Обновить">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
            <button class="btn btn-secondary" data-admin-act="toggle" data-id="${a.id}" data-active="${a.is_active ? 0 : 1}" title="${a.is_active ? 'Выключить' : 'Включить'}">
              ${a.is_active ? '⏸' : '▶'}
            </button>
            <button class="btn btn-danger" data-admin-act="delete" data-id="${a.id}" title="Удалить" style="padding:6px 10px;font-size:12px">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  async function adminLoadAccounts() {
    try {
      const d = await api('/api/admin/robux/accounts', { silent: true });
      if (d && d.items) renderAdminAccounts(d.items);
      else renderAdminAccounts([]);
    } catch (e) {
      renderAdminAccounts([]);
    }
  }

  async function adminAddAccount(e) {
    e?.preventDefault?.();
    const label = ($('#adminAccLabel')?.value || '').trim();
    const cookie = ($('#adminAccCookie')?.value || '').trim();
    if (!cookie) return toast('Вставь Cookie (.ROBLOSECURITY)', 'warning');
    try {
      loading(true);
      const d = await api('/api/admin/robux/accounts/add', { method: 'POST', body: { label, cookie } });
      toast(`Аккаунт добавлен: ${d.status?.username || ''} (${d.status?.robux ?? 0} R$)`, 'success');
      if ($('#adminAccLabel')) $('#adminAccLabel').value = '';
      if ($('#adminAccCookie')) $('#adminAccCookie').value = '';
      await adminLoadAccounts();
      await updateAdminStockHint();
    } catch (err) {
      toast(err.message || 'Ошибка добавления аккаунта', 'error');
    } finally {
      loading(false);
    }
  }

  async function adminRefreshAll() {
    try {
      loading(true);
      const d = await api('/api/admin/robux/accounts', { silent: true });
      const items = d?.items || [];
      let ok = 0, fail = 0;
      for (const a of items) {
        try {
          await api('/api/admin/robux/accounts/refresh', { method: 'POST', body: { id: a.id } });
          ok++;
        } catch (_) { fail++; }
      }
      toast(`Обновлено: ${ok} из ${items.length}${fail ? `, ошибок: ${fail}` : ''}`, ok ? 'success' : 'warning');
      await adminLoadAccounts();
      await updateAdminStockHint();
    } catch (err) {
      toast(err.message || 'Ошибка обновления', 'error');
    } finally {
      loading(false);
    }
  }

  async function adminItemAction(e) {
    const btn = e.target.closest('[data-admin-act]');
    if (!btn) return;
    const act = btn.dataset.adminAct;
    const id = parseInt(btn.dataset.id);
    if (!id) return;
    try {
      loading(true);
      if (act === 'toggle') {
        const isActive = parseInt(btn.dataset.active);
        await api('/api/admin/robux/accounts/toggle', { method: 'POST', body: { id, is_active: isActive } });
        toast(isActive ? 'Аккаунт включён' : 'Аккаунт выключен', 'success');
      } else if (act === 'delete') {
        if (!confirm('Удалить этот аккаунт?')) { loading(false); return; }
        await api('/api/admin/robux/accounts/delete', { method: 'POST', body: { id } });
        toast('Аккаунт удалён', 'success');
      } else if (act === 'refresh') {
        await api('/api/admin/robux/accounts/refresh', { method: 'POST', body: { id } });
        toast('Аккаунт обновлён', 'success');
      }
      await adminLoadAccounts();
      await updateAdminStockHint();
    } catch (err) {
      toast(err.message || 'Ошибка', 'error');
    } finally {
      loading(false);
    }
  }


// Admin: Shop editor -------------------------------------------------
function adminShopEnsureDraft(cfg) {
  const base = cfg && typeof cfg === 'object' ? cfg : shopDefaultConfig();
  const draft = JSON.parse(JSON.stringify(base));
  draft.categories = Array.isArray(draft.categories) ? draft.categories : [];
  draft.items = Array.isArray(draft.items) ? draft.items : [];
  // Ensure ids
  draft.categories.forEach((c, idx) => {
    if (!c.id) c.id = `cat_${idx + 1}`;
    if (c.sort == null) c.sort = (idx + 1) * 10;
    if (c.visible == null) c.visible = true;
  });
  draft.items.forEach((it, idx) => {
    if (!it.id) it.id = `item_${idx + 1}`;
    if (it.sort == null) it.sort = (idx + 1) * 10;
    if (it.visible == null) it.visible = true;
    if (!it.category_id && draft.categories[0]) it.category_id = draft.categories[0].id;
  });
  return draft;
}

// NOTE: Historically the app expected an initAuth() initializer.
// Some builds referenced it from boot(), and if it's missing the whole
// JS boot chain crashes -> "0 реакции" на все кнопки.
// Keep this as a compatibility shim.
function initAuth() {
  // Auth UI is handled by showLogin/showRegister/showReset + checkAuth()
  // Event listeners are wired in boot(). Nothing required here.
}

async function adminShopLoadAndRender() {
  const catsEl = $('#adminShopCats');
  const itemsEl = $('#adminShopItems');
  // If markup isn't present (older build) — just skip
  if (!catsEl || !itemsEl) return;

  await loadShopConfig();
  state.adminShopDraft = adminShopEnsureDraft(state.shopConfig);
  adminShopRender();
}

// ── Shop Editor Toggle (admin panel → inline shop editor) ────
async function adminToggleShopEditor() {
  if (state.shopEditorMode) {
    state.shopEditorMode = false;
    state.adminShopDraft = null;
    document.getElementById('shopEditorBanner')?.classList.add('hidden');
    const btn = document.getElementById('btnToggleShopEditor');
    if (btn) { btn.textContent = '✏ Включить режим редактора'; btn.className = 'btn btn-primary'; }
    renderShop();
  } else {
    state.shopEditorMode = true;
    state.adminShopDraft = JSON.parse(JSON.stringify(state.shopConfig||{categories:[],items:[]}));
    document.getElementById('shopEditorBanner')?.classList.remove('hidden');
    const btn = document.getElementById('btnToggleShopEditor');
    if (btn) { btn.textContent = '⏹ Выключить редактор'; btn.className = 'btn btn-danger'; }
    // Navigate to shop tab
    document.querySelector('[data-tab="shop"]')?.click();
  }
}

// Wire toggle button on first load
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnToggleShopEditor')?.addEventListener('click', adminToggleShopEditor);
});


function adminShopRender() {
  const draft = state.adminShopDraft;
  if (!draft) return;

  const catsEl = $('#adminShopCats');
  const itemsEl = $('#adminShopItems');
  if (!catsEl || !itemsEl) return;

  const cats = [...draft.categories].sort((a,b)=> (a.sort??0)-(b.sort??0));
  const items = [...draft.items].sort((a,b)=> (a.sort??0)-(b.sort??0));

  catsEl.innerHTML = cats.map((c) => `
    <div class="list-item">
      <div class="list-item-main">
        <input class="input input-sm" data-cat-field="title" data-cat-id="${escapeHtml(c.id)}" value="${escapeHtml(c.title || '')}" placeholder="Название категории" />
        <div class="row gap-8 mt-6">
          <label class="switch">
            <input type="checkbox" data-cat-field="visible" data-cat-id="${escapeHtml(c.id)}" ${c.visible!==false?'checked':''}/>
            <span>Показывать</span>
          </label>
          <button class="btn btn-ghost btn-xs" data-cat-move="up" data-cat-id="${escapeHtml(c.id)}">↑</button>
          <button class="btn btn-ghost btn-xs" data-cat-move="down" data-cat-id="${escapeHtml(c.id)}">↓</button>
          <button class="btn btn-danger btn-xs" data-cat-del="${escapeHtml(c.id)}">Удалить</button>
        </div>
      </div>
    </div>
  `).join('');

  itemsEl.innerHTML = items.map((it) => `
    <div class="card product-editor">
      <div class="row between gap-10">
        <div class="muted">ID: <span class="mono">${escapeHtml(it.id)}</span></div>
        <label class="switch">
          <input type="checkbox" data-item-field="visible" data-item-id="${escapeHtml(it.id)}" ${it.visible!==false?'checked':''}/>
          <span>Показывать</span>
        </label>
      </div>

      <div class="grid-2 mt-10">
        <div class="field">
          <label class="muted">Название</label>
          <input class="input input-sm" data-item-field="title" data-item-id="${escapeHtml(it.id)}" value="${escapeHtml(it.title || '')}" />
        </div>
        <div class="field">
          <label class="muted">Подзаголовок</label>
          <input class="input input-sm" data-item-field="subtitle" data-item-id="${escapeHtml(it.id)}" value="${escapeHtml(it.subtitle || '')}" />
        </div>

        <div class="field">
          <label class="muted">Цена (₽)</label>
          <input class="input input-sm" type="number" min="0" step="1" data-item-field="price_rub" data-item-id="${escapeHtml(it.id)}" value="${escapeHtml(String(it.price_rub ?? ''))}" />
        </div>

        <div class="field">
          <label class="muted">Бейдж</label>
          <input class="input input-sm" data-item-field="badge" data-item-id="${escapeHtml(it.id)}" value="${escapeHtml(it.badge || '')}" placeholder="Напр: Популярно" />
        </div>

        <div class="field">
          <label class="muted">Категория</label>
          <select class="input input-sm" data-item-field="category_id" data-item-id="${escapeHtml(it.id)}">
            ${cats.map((c) => `<option value="${escapeHtml(c.id)}" ${it.category_id===c.id?'selected':''}>${escapeHtml(c.title||c.id)}</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label class="muted">Баннер</label>
          <div class="row gap-8">
            <input class="input input-sm" data-item-field="banner_url" data-item-id="${escapeHtml(it.id)}" value="${escapeHtml(it.banner_url || '')}" placeholder="URL или загрузи файл" />
            <input type="file" accept="image/*" data-item-upload="${escapeHtml(it.id)}" />
          </div>
        </div>
      </div>

      <div class="row gap-8 mt-10">
        <button class="btn btn-ghost btn-xs" data-item-move="up" data-item-id="${escapeHtml(it.id)}">↑</button>
        <button class="btn btn-ghost btn-xs" data-item-move="down" data-item-id="${escapeHtml(it.id)}">↓</button>
        <button class="btn btn-danger btn-xs" data-item-del="${escapeHtml(it.id)}">Удалить</button>
      </div>
    </div>
  `).join('');

  // Bind inputs
  catsEl.querySelectorAll('[data-cat-field]').forEach((el) => {
    const id = el.getAttribute('data-cat-id');
    const field = el.getAttribute('data-cat-field');
    el.addEventListener('input', () => {
      const c = draft.categories.find((x) => x.id === id);
      if (!c) return;
      if (field === 'visible') return;
      c[field] = el.value;
    });
    if (el.type === 'checkbox') {
      el.addEventListener('change', () => {
        const c = draft.categories.find((x) => x.id === id);
        if (!c) return;
        c.visible = !!el.checked;
      });
    }
  });

  itemsEl.querySelectorAll('[data-item-field]').forEach((el) => {
    const id = el.getAttribute('data-item-id');
    const field = el.getAttribute('data-item-field');
    const isCheck = el.type === 'checkbox';
    const on = isCheck ? 'change' : 'input';
    el.addEventListener(on, () => {
      const it = draft.items.find((x) => x.id === id);
      if (!it) return;
      if (field === 'price_rub') it.price_rub = Number(el.value || 0);
      else if (field === 'visible') it.visible = !!el.checked;
      else it[field] = el.value;
    });
  });

  // Uploads
  itemsEl.querySelectorAll('[data-item-upload]').forEach((inp) => {
    const id = inp.getAttribute('data-item-upload');
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const fd = new FormData();
        fd.append('file', f);
        const r = await fetch('/api/admin/upload_banner', { method: 'POST', body: fd, credentials: 'include' });
        const j = await r.json();
        if (!r.ok || !j?.ok) throw new Error(j?.error || 'upload failed');
        const it = draft.items.find((x) => x.id === id);
        if (it) it.banner_url = j.url;
        adminShopRender();
        toast('Баннер загружен', 'ok');
      } catch (e) {
        toast('Не удалось загрузить баннер', 'err');
      }
    });
  });

  // Delete/move
  catsEl.querySelectorAll('[data-cat-del]').forEach((btn) => btn.addEventListener('click', () => adminShopDeleteCat(btn.getAttribute('data-cat-del'))));
  catsEl.querySelectorAll('[data-cat-move]').forEach((btn) => btn.addEventListener('click', () => adminShopMoveCat(btn.getAttribute('data-cat-id'), btn.getAttribute('data-cat-move'))));
  itemsEl.querySelectorAll('[data-item-del]').forEach((btn) => btn.addEventListener('click', () => adminShopDeleteItem(btn.getAttribute('data-item-del'))));
  itemsEl.querySelectorAll('[data-item-move]').forEach((btn) => btn.addEventListener('click', () => adminShopMoveItem(btn.getAttribute('data-item-id'), btn.getAttribute('data-item-move'))));
}

function adminShopAddCat() {
  const draft = state.adminShopDraft;
  if (!draft) return;
  const id = `cat_${Date.now()}`;
  draft.categories.push({ id, title: 'Новая категория', sort: (draft.categories.length + 1) * 10, visible: true });
  // Default category for items if none
  adminShopRender();
}
function adminShopDeleteCat(id) {
  const draft = state.adminShopDraft;
  if (!draft) return;
  draft.categories = draft.categories.filter((c) => c.id !== id);
  // Reassign items
  const fallback = draft.categories[0]?.id || 'robux';
  draft.items.forEach((it) => { if (it.category_id === id) it.category_id = fallback; });
  adminShopRender();
}
function adminShopMoveCat(id, dir) {
  const draft = state.adminShopDraft;
  if (!draft) return;
  const cats = [...draft.categories].sort((a,b)=> (a.sort??0)-(b.sort??0));
  const idx = cats.findIndex((c) => c.id === id);
  const swap = dir === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swap < 0 || swap >= cats.length) return;
  const a = cats[idx], b = cats[swap];
  const t = a.sort; a.sort = b.sort; b.sort = t;
  draft.categories = cats;
  adminShopRender();
}

function adminShopAddItem() {
  const draft = state.adminShopDraft;
  if (!draft) return;
  const id = `item_${Date.now()}`;
  const cat = draft.categories[0]?.id || 'robux';
  draft.items.push({ id, title: 'Новый товар', subtitle: '', price_rub: 0, badge: '', category_id: cat, banner_url: '', visible: true, sort: (draft.items.length + 1) * 10 });
  adminShopRender();
}
function adminShopDeleteItem(id) {
  const draft = state.adminShopDraft;
  if (!draft) return;
  draft.items = draft.items.filter((i) => i.id !== id);
  adminShopRender();
}
function adminShopMoveItem(id, dir) {
  const draft = state.adminShopDraft;
  if (!draft) return;
  const items = [...draft.items].sort((a,b)=> (a.sort??0)-(b.sort??0));
  const idx = items.findIndex((i) => i.id === id);
  const swap = dir === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swap < 0 || swap >= items.length) return;
  const a = items[idx], b = items[swap];
  const t = a.sort; a.sort = b.sort; b.sort = t;
  draft.items = items;
  adminShopRender();
}

async function adminShopSave() {
  const draft = state.adminShopDraft;
  if (!draft) return;
  try {
    const r = await apiPost('/api/admin/shop_config', { config: draft });
    if (!r?.ok) throw new Error(r?.error || 'save failed');
    state.shopConfig = draft;
    renderShop();
    toast('Магазин сохранён', 'ok');
  } catch (e) {
    toast('Не удалось сохранить магазин', 'err');
  }
}

  function initRobux() {
    const amtInput = $('#robuxAmount');
    const uInput = $('#robuxUsername');
    const urlInput = $('#robuxUrl');

    if (amtInput) amtInput.value = String(state.robux.amount);
    if (uInput && state.robux.usernameRaw) uInput.value = state.robux.usernameRaw;
    if (urlInput && state.robux.urlRaw) urlInput.value = state.robux.urlRaw;

    const applyModeUI = () => {
      $$('.mode-tab[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === state.robux.mode));
      const cap = state.robux.mode.charAt(0).toUpperCase() + state.robux.mode.slice(1);
      $$('.mode-content').forEach(x => x.classList.toggle('active', x.id === `mode${cap}`));
    };
    applyModeUI();

    // Purchase mode toggle
    const toggleCheck = $('#purchaseModeCheck');
    if (toggleCheck) {
      if (state.robux.purchaseMode === 'auto' && !isPremiumActive()) state.robux.purchaseMode = 'normal';
      toggleCheck.checked = state.robux.purchaseMode === 'auto';
      toggleCheck.addEventListener('change', () => {
        if (toggleCheck.checked && !isPremiumActive()) {
          toggleCheck.checked = false;
          toast('Авто-режим доступен только для Premium', 'warning');
          return;
        }
        state.robux.purchaseMode = toggleCheck.checked ? 'auto' : 'normal';
        state.robux.gamepass = null;
        const buyBtn = $('#btnRobuxBuy');
        if (buyBtn) buyBtn.disabled = true;
        _updatePurchaseModeUI();
        savePersist();
      });
    }
    _updatePurchaseModeUI();

    if (amtInput) {
      amtInput.addEventListener('input', () => {
        state.robux.amount = Math.max(10, Math.min(100000, parseInt(amtInput.value) || 50));
        savePersist();
        debouncedQuote();
      });
    }

    $$('.quick-btn[data-amount]').forEach(b => {
      b.addEventListener('click', () => {
        state.robux.amount = parseInt(b.dataset.amount) || 50;
        if (amtInput) amtInput.value = String(state.robux.amount);
        $$('.quick-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        savePersist();
        loadRobuxQuote();
      });
    });

    $$('.mode-tab[data-mode]').forEach(b => {
      b.addEventListener('click', () => {
        state.robux.mode = b.dataset.mode;
        applyModeUI();
        savePersist();
      });
    });

    uInput?.addEventListener('input', () => { state.robux.usernameRaw = uInput.value; savePersist(); });
    urlInput?.addEventListener('input', () => { state.robux.urlRaw = urlInput.value; savePersist(); });

    // Buttons
    $('#btnRobuxCheck')?.addEventListener('click', () => robuxCheck());
    $('#btnRobuxBuy')?.addEventListener('click', robuxBuy);

    loadRobuxQuote();
  }

  // Cyrillic to Latin mapping
  const cyrToLat = {
    'А':'A','В':'B','Е':'E','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','Х':'X','У':'U',
    'а':'a','в':'b','е':'e','к':'k','м':'m','н':'h','о':'o','р':'p','с':'c','т':'t','х':'x','у':'u'
  };
  function normalizeUsername(s) {
    return (s || '').trim().replace(/^@/, '').replace(/\s+/g, '').replace(/[АВЕКМНОРСТХУавекмнорстху]/g, c => cyrToLat[c] || c);
  }

  async function robuxCheck() {
    const mode = state.robux.mode;
    const purchaseMode = state.robux.purchaseMode;
    let username = '', url = '';

    if (mode === 'username') {
      const raw = $('#robuxUsername')?.value || '';
      username = normalizeUsername(raw);
      if (!username) return toast('Введи ник Roblox', 'warning');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return toast('Ник должен быть латиницей (A-Z, 0-9, _)', 'warning');
      }
    } else {
      url = $('#robuxUrl')?.value?.trim() || '';
      if (!url) return toast('Вставь ссылку на геймпасс', 'warning');
    }

    state.robux.usernameRaw = $('#robuxUsername')?.value || state.robux.usernameRaw;
    state.robux.urlRaw = $('#robuxUrl')?.value || state.robux.urlRaw;
    savePersist();

    modal(`<div style="text-align:center;padding:24px 0"><div class="spinner" style="margin:0 auto 12px"></div><div style="color:var(--text-muted)">Ищем геймпасс...</div></div>`);

    try {
      const payload = { amount: state.robux.amount, mode };
      if (mode === 'username') payload.username = username;
      else payload.gamepass_url = url;

      const d = await api('/api/robux/inspect', { method: 'POST', timeout: 90000, body: payload });
      state.robux.gamepass = d.gamepass;
      const gp = d.gamepass || {};
      const thumb = gp.thumbnail_url || gp.thumb || '';
      closeModal();
      _showGamepassFoundModal(gp, thumb);

    } catch (e) {
      state.robux.gamepass = null;
      closeModal();
      const errMsg = e?.message || 'Подходящий геймпасс не найден';
      if (purchaseMode === 'auto' && isPremiumActive()) {
        _showAutoCreateModal(errMsg);
      } else {
        _showGamepassNotFoundModal(errMsg);
      }
    }
  }

  function _showGamepassFoundModal(gp, thumb) {
    const q = state.robux.quote || {};
    const rubPrice = q.rub_price || 0;
    modal(`
      <div style="text-align:center">
        <div style="width:56px;height:56px;margin:0 auto 12px;border-radius:50%;background:rgba(34,197,94,0.12);display:flex;align-items:center;justify-content:center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h3 style="margin:0 0 4px">Геймпасс найден!</h3>
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Можно покупать</div>
      </div>
      <div class="card" style="padding:12px;display:flex;gap:12px;align-items:center;margin-bottom:14px">
        ${thumb ? `<img src="${thumb}" style="width:52px;height:52px;border-radius:8px;object-fit:cover">` : ''}
        <div style="min-width:0;flex:1">
          <div style="font-weight:700;font-size:14px">${escapeHtml(gp.name || '—')}</div>
          <div style="font-size:12px;color:var(--text-muted)">Владелец: ${escapeHtml(gp.owner || '—')}</div>
          <div style="font-size:13px;color:var(--success);font-weight:700;margin-top:2px">${gp.price || 0} R$</div>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="display:flex;gap:0;align-items:stretch;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;background:rgba(255,255,255,.02)">
          <input class="form-input" id="robuxDiscountInput" placeholder="🏷 Промокод на скидку" style="flex:1;font-size:13px;padding:10px 14px;text-transform:uppercase;border:none;background:transparent;border-radius:0">
          <button class="btn btn-ghost btn-sm" id="robuxDiscountApply" style="flex-shrink:0;padding:10px 16px;font-size:12px;border-radius:0;border-left:1px solid rgba(255,255,255,.08);font-weight:600;color:var(--accent-tertiary)">Применить</button>
        </div>
        <div id="robuxDiscountInfo" style="display:none;font-size:12px;color:#22c55e;margin-top:6px;text-align:center"></div>
      </div>
      <div id="robuxPriceDisplay" style="text-align:center;font-size:20px;font-weight:800;color:var(--accent-primary);margin-bottom:12px">${fmtCurrency(rubPrice)}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="popupBuyBtn" style="flex:1">Купить</button>
        <button class="btn btn-secondary" id="popupCloseBtn" style="flex:1">Закрыть</button>
      </div>
    `);
    // Discount for robux
    let _rbxDisc = '';
    setTimeout(() => {
      document.getElementById('robuxDiscountApply')?.addEventListener('click', async () => {
        const code = (document.getElementById('robuxDiscountInput')?.value||'').trim().toUpperCase();
        if (!code) return;
        try {
          const r = await api('/api/discount/validate', { method:'POST', body:{ code, order_type:'robux', amount: rubPrice }});
          _rbxDisc = code;
          state.robux._discountCode = code;
          state.robux._discountAmount = r.discount_amount || 0;
          const newPrice = Math.max(0, rubPrice - (r.discount_amount || 0));
          document.getElementById('robuxPriceDisplay').innerHTML = `<s style="font-size:14px;color:var(--text-muted);font-weight:400">${fmtCurrency(rubPrice)}</s> ${fmtCurrency(newPrice)}`;
          document.getElementById('robuxDiscountInfo').style.display = 'block';
          document.getElementById('robuxDiscountInfo').textContent = `✅ ${r.display} применена!`;
          toast('Промокод применён!', 'success');
        } catch(e) { toast(e.message || 'Промокод недействителен', 'error'); state.robux._discountCode = ''; state.robux._discountAmount = 0; }
      });
      document.getElementById('robuxDiscountInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); document.getElementById('robuxDiscountApply')?.click(); }
      });
    }, 50);
    $('#popupBuyBtn')?.addEventListener('click', () => { closeModal(); robuxBuy(); });
    $('#popupCloseBtn')?.addEventListener('click', () => closeModal());
    const buyBtn = $('#btnRobuxBuy');
    if (buyBtn) buyBtn.disabled = false;
  }

  function _showGamepassNotFoundModal(errMsg) {
    const q = state.robux.quote || {};
    const gpPrice = q.gamepass_price || Math.ceil(state.robux.amount * 1.43);
    modal(`
      <div style="text-align:center">
        <div style="width:56px;height:56px;margin:0 auto 12px;border-radius:50%;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        </div>
        <h3 style="margin:0 0 4px">Геймпасс не найден</h3>
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px;line-height:1.5">${escapeHtml(errMsg)}</div>
      </div>
      <div class="card" style="padding:12px;margin-bottom:14px">
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">
          <b>Что делать:</b><br>
          1. Откройте Roblox Studio → ваша игра<br>
          2. Создайте Game Pass с ценой <b>${gpPrice} R$</b> (с учётом комиссии)<br>
          3. Убедитесь что он публичный и на продаже
        </div>
      </div>
      ${isPremiumActive() ? `<div class="alert" style="background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.25);border-radius:12px;padding:12px;margin-bottom:14px;font-size:13px"><b>Совет:</b> Переключи на <b>Авто-режим</b> — мы создадим геймпасс автоматически!</div>` : ''}
      <div style="display:flex;gap:8px">
        <a href="https://create.roblox.com/dashboard/creations" target="_blank" class="btn btn-primary" style="flex:1;text-align:center;text-decoration:none">Создать геймпасс</a>
        <button class="btn btn-secondary" id="popupRetryBtn" style="flex:1">Повторить</button>
      </div>
    `);
    $('#popupRetryBtn')?.addEventListener('click', () => { closeModal(); robuxCheck(); });
  }

  function _showAutoCreateModal(errMsg) {
    const q = state.robux.quote || {};
    const gpPrice = q.gamepass_price || Math.ceil(state.robux.amount * 1.43);
    modal(`
      <div style="text-align:center">
        <div style="width:56px;height:56px;margin:0 auto 12px;border-radius:50%;background:rgba(168,85,247,0.12);display:flex;align-items:center;justify-content:center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </div>
        <h3 style="margin:0 0 4px">Авто-создание геймпасса</h3>
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px;line-height:1.5">
          Геймпасс не найден. Вставь куки — мы создадим его автоматически.
        </div>
      </div>
      <div class="card" style="padding:12px;margin-bottom:14px">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">
          Будет создан геймпасс с ценой <b>${gpPrice} R$</b> на твоей игре.
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label" style="font-size:12px">Куки .ROBLOSECURITY</label>
          <textarea class="form-input" id="autoCookieInput" rows="3" placeholder="_|WARNING:-DO-NOT-SHARE-THIS.--..." style="font-size:12px;font-family:monospace;resize:vertical"></textarea>
        </div>
      </div>
      <div class="alert" style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:12px;padding:10px;margin-bottom:14px;font-size:12px;color:var(--text-muted)">
        Куки используются единоразово для создания геймпасса и не сохраняются.
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="autoCreateBtn" style="flex:1">Создать геймпасс</button>
        <button class="btn btn-secondary" id="autoCloseBtn" style="flex:1">Отмена</button>
      </div>
    `);
    $('#autoCloseBtn')?.addEventListener('click', () => closeModal());
    $('#autoCreateBtn')?.addEventListener('click', () => _doAutoCreateGamepass());
  }

  async function _doAutoCreateGamepass() {
    const cookie = ($('#autoCookieInput')?.value || '').trim();
    if (!cookie) return toast('Вставь куки', 'warning');

    closeModal();
    modal(`<div style="text-align:center;padding:24px 0"><div class="spinner" style="margin:0 auto 12px"></div><div id="autoCreateStatus" style="color:var(--text-muted);font-size:13px;line-height:1.5">Проверяем куки...</div></div>`);
    const statusEl = document.getElementById('autoCreateStatus');

    try {
      if (statusEl) statusEl.textContent = 'Проверяем куки и ищем игры...';
      const valResp = await api('/api/robux/validate_buyer_cookie', { method: 'POST', timeout: 90000, body: { cookie } });

      if (!valResp.has_games) {
        closeModal();
        modal(`
          <div style="text-align:center">
            <div style="width:56px;height:56px;margin:0 auto 12px;border-radius:50%;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            </div>
            <h3 style="margin:0 0 4px">Нет игр</h3>
            <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
              У аккаунта <b>${escapeHtml(valResp.username || '')}</b> нет публичных игр.<br>
              Создай хотя бы одну игру в Roblox Studio.
            </div>
          </div>
          <button class="btn btn-secondary" id="noGamesCloseBtn" style="width:100%">Закрыть</button>
        `);
        $('#noGamesCloseBtn')?.addEventListener('click', () => closeModal());
        return;
      }

      if (statusEl) statusEl.textContent = `Аккаунт: ${valResp.username}. Создаём геймпасс...`;

      const createResp = await api('/api/robux/auto_create_gamepass', {
        method: 'POST', timeout: 120000,
        body: { cookie, amount: state.robux.amount, universe_id: valResp.universes[0]?.id || 0 }
      });

      state.robux.gamepass = createResp.gamepass;
      closeModal();
      const gp = createResp.gamepass || {};
      const thumb = gp.thumbnail_url || gp.thumb || '';

      modal(`
        <div style="text-align:center">
          <div style="width:56px;height:56px;margin:0 auto 12px;border-radius:50%;background:rgba(34,197,94,0.12);display:flex;align-items:center;justify-content:center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h3 style="margin:0 0 4px">Геймпасс создан!</h3>
          <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Теперь можно купить</div>
        </div>
        <div class="card" style="padding:12px;display:flex;gap:12px;align-items:center;margin-bottom:14px">
          ${thumb ? `<img src="${thumb}" style="width:52px;height:52px;border-radius:8px;object-fit:cover">` : ''}
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;font-size:14px">${escapeHtml(gp.name || '—')}</div>
            <div style="font-size:12px;color:var(--text-muted)">Владелец: ${escapeHtml(gp.owner || createResp.buyer?.username || '—')}</div>
            <div style="font-size:13px;color:var(--success);font-weight:700;margin-top:2px">${gp.price || 0} R$</div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="autoPopupBuyBtn" style="flex:1">Купить</button>
          <button class="btn btn-secondary" id="autoPopupCloseBtn" style="flex:1">Закрыть</button>
        </div>
      `);
      $('#autoPopupBuyBtn')?.addEventListener('click', () => { closeModal(); robuxBuy(); });
      $('#autoPopupCloseBtn')?.addEventListener('click', () => closeModal());
      const buyBtn = $('#btnRobuxBuy');
      if (buyBtn) buyBtn.disabled = false;

    } catch (e) {
      closeModal();
      toast(e.message || 'Ошибка создания геймпасса', 'error');
    }
  }

  function _buyStepsHTML(activeIdx) {
    const steps = ['Бронь','Оплата','Готово'];
    return `<div class="buy-steps">${steps.map((s, i) => {
      const dotCls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
      const icon = i < activeIdx ? '✓' : (i + 1);
      return (i > 0 ? `<div class="buy-step-line${i <= activeIdx ? ' done' : ''}"></div>` : '') +
        `<div class="buy-step"><div class="buy-step-dot ${dotCls}">${icon}</div><div class="buy-step-label">${s}</div></div>`;
    }).join('')}</div>`;
  }

  async function robuxBuy() {
    if (!state.user) return toast('Сначала войди в аккаунт', 'warning');
    if (!state.robux.gamepass) return toast('Сначала проверь геймпасс', 'warning');

    const gp = state.robux.gamepass;
    const gpId = gp.gamepass_id;
    const q = state.robux.quote || {};

    // Step 0 — Reserve
    modal(`
      <div style="text-align:center;padding:16px 0 8px">
        ${_buyStepsHTML(0)}
        <div class="spinner" style="margin:12px auto"></div>
        <div id="buyStatusText" style="color:var(--text-muted);font-size:13px">Бронируем заказ...</div>
      </div>
    `);

    try {
      const reserveData = await api('/api/robux/order_reserve', { method: 'POST', timeout: 120000, body: {
        amount: state.robux.amount,
        gamepass_url: String(gpId),
      }});

      // Step 1 — Pay
      const qLen = reserveData.queue?.queue_length || 0;
      const qEst = reserveData.queue?.estimated_seconds || 0;
      const queueNote = qLen > 1 ? `<div style="margin-top:8px;padding:8px 12px;background:rgba(147,51,234,.06);border-radius:10px;font-size:12px;color:var(--text-secondary);text-align:center">В очереди: ${qLen} заказов · ~${Math.ceil(qEst / 60)} мин</div>` : '';
      closeModal();
      modal(`
        <div style="text-align:center;padding:16px 0 8px">
          ${_buyStepsHTML(1)}
          <div class="spinner" style="margin:12px auto"></div>
          <div style="color:var(--text-muted);font-size:13px">Оплачиваем и выкупаем геймпасс...</div>
          ${queueNote}
        </div>
      `);

      await api('/api/robux/order_pay', { method: 'POST', timeout: 120000, body: { order_id: reserveData.order_id } });

      // Fetch queue info
      let queueHtml = '';
      try {
        const qInfo = await api('/api/robux/queue', { silent: true });
        if (qInfo && qInfo.queue_length > 1) {
          const mins = Math.ceil((qInfo.estimated_seconds || 60) / 60);
          queueHtml = `
            <div style="padding:12px;background:rgba(147,51,234,0.06);border:1px solid rgba(147,51,234,0.15);border-radius:12px;margin-bottom:14px;text-align:center">
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">В очереди: ${qInfo.queue_length} заказов</div>
              <div style="font-size:14px;font-weight:700;color:var(--accent-tertiary)">Примерное ожидание: ~${mins} мин</div>
              <div id="queueCountdown" style="font-size:20px;font-weight:800;color:var(--accent-primary);margin-top:6px;font-variant-numeric:tabular-nums"></div>
            </div>`;
        }
      } catch(_){}

      // Step 2 — Done!
      closeModal();
      modal(`
        <div style="text-align:center;padding:12px 0 4px">
          ${_buyStepsHTML(3)}
        </div>
        <div style="text-align:center;margin-bottom:16px">
          <div style="width:60px;height:60px;margin:8px auto 12px;border-radius:50%;background:rgba(34,197,94,0.12);display:flex;align-items:center;justify-content:center">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h3 style="margin:0 0 4px">Заказ оформлен!</h3>
          <div style="color:var(--text-muted);font-size:13px">Геймпасс <b>${escapeHtml(gp.name || '')}</b> выкупается</div>
        </div>
        <div style="padding:14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:14px;margin-bottom:14px">
          <div style="font-size:13px;color:var(--text-secondary);display:grid;gap:8px">
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)"><span>Робуксов</span><b style="color:var(--accent-tertiary)">${state.robux.amount} R$</b></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)"><span>Списано</span><b style="color:var(--danger)">−${q.rub_price ? fmtCurrency(q.rub_price) : '—'}</b></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0"><span>Статус</span><b style="color:var(--success)">В обработке ✓</b></div>
          </div>
        </div>
        ${queueHtml}
        <div style="padding:12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:12px;margin-bottom:14px;font-size:12px;color:var(--text-secondary);line-height:1.5;text-align:center">
          Робуксы появятся в <b>Pending</b>. Проверь транзакции Roblox.
        </div>
        <div style="display:flex;gap:8px">
          <a href="https://www.roblox.com/transactions" target="_blank" class="btn btn-primary" style="flex:1;text-align:center;text-decoration:none">Проверить Pending</a>
          <button class="btn btn-secondary" id="buyDoneBtn" style="flex:1">Закрыть</button>
        </div>
      `);
      $('#buyDoneBtn')?.addEventListener('click', () => closeModal());

      // Start countdown timer if queue exists
      const cdEl = document.getElementById('queueCountdown');
      if (cdEl) {
        let secs = 0;
        try { const qi = await api('/api/robux/queue', {silent:true}); secs = qi?.estimated_seconds || 120; } catch(_){ secs = 120; }
        const _cdInterval = setInterval(() => {
          if (secs <= 0) { cdEl.textContent = 'Готово!'; clearInterval(_cdInterval); return; }
          secs--;
          const m = Math.floor(secs / 60);
          const s = secs % 60;
          cdEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
        }, 1000);
      }

      updateBalance();
      updateRobuxStock();
      state.robux.gamepass = null;
      const buyBtn = $('#btnRobuxBuy');
      if (buyBtn) buyBtn.disabled = true;

    } catch (e) {
      closeModal();
      toast(e.message || 'Ошибка при покупке', 'error');
    }
  }

  // ═══════════════════════════════════════════════
  // Top-up — multi-step animated modal
  // ═══════════════════════════════════════════════
  function showTopUp() {
    if (!state.user) return toast('Сначала войди', 'warning');

    // State
    let tuStep = 1;      // 1=method, 2=amount, 3=paying/pending, 4=history
    let tuMethod = null; // 'yookassa'|'robokassa'|'crypto'|'manual'|'promo'
    let tuAmt = 100;
    let tuTopupId = null;
    let tuPollTimer = null;

    // Method config (shown on step 1) — only CryptoBot active
    const methods = [
      { id: 'platega', label: 'СБП / Карта РФ',   sub: 'Быстрый перевод через СБП или карту', fee: '~3.5%',
        icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
        color: '#22c55e' },
      { id: 'crypto', label: 'CryptoBot',       sub: 'USDT, TON, BTC и другие', fee: '0%',
        icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-8.609 3.33c-2.068.8-4.133 1.598-5.724 2.21a405.15 405.15 0 0 1-2.849 1.09c-.42.147-.99.332-1.473.901-.728.968.193 1.798.919 2.286 1.61.516 3.275 1.009 4.654 1.472.846 2.524 1.738 5.048 2.585 7.602.267.794.71 1.8 1.479 2.024a1.954 1.954 0 0 0 1.96-.47l2.357-2.248 4.773 3.515a2.262 2.262 0 0 0 3.341-1.354l3.566-15.133a2.236 2.236 0 0 0-2.016-2.868z" fill="#2aabee"/></svg>`,
        color: '#2aabee' },
      { id: 'promo',  label: 'Промокод',        sub: 'Бесплатные бонусы', fee: '0%',
        icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12V22H4V12"/><path d="M22 7H2v5h20V7z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>`,
        color: '#f59e0b' },
      { id: 'history', label: 'Мои пополнения', sub: 'История и проверка оплат', fee: null,
        icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        color: '#8b5cf6' },
    ];

    // CSS (injected once)
    const tuCss = `
      <style id="tuCssBlock">
        .tu-wrap{position:relative;overflow:hidden;min-height:200px}
        .tu-slide{animation:tuIn .22s cubic-bezier(.4,0,.2,1) both}
        .tu-slide-back{animation:tuInBack .22s cubic-bezier(.4,0,.2,1) both}
        @keyframes tuIn{from{opacity:0;transform:translateX(28px)}to{opacity:1;transform:none}}
        @keyframes tuInBack{from{opacity:0;transform:translateX(-28px)}to{opacity:1;transform:none}}
        .tu-header{display:flex;align-items:center;gap:10px;margin-bottom:18px}
        .tu-back-btn{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background .15s}
        .tu-back-btn:hover{background:rgba(255,255,255,0.1)}
        .tu-title{font-size:17px;font-weight:700;flex:1}
        .tu-steps{display:flex;gap:5px;align-items:center}
        .tu-step-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.15);transition:all .25s}
        .tu-step-dot.active{width:18px;border-radius:3px;background:var(--accent-primary)}
        .tu-method-list{display:flex;flex-direction:column;gap:8px}
        .tu-method-btn{display:flex;align-items:center;gap:12px;padding:13px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:13px;cursor:pointer;transition:all .18s;text-align:left}
        .tu-method-btn:hover{background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.13)}
        .tu-method-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .tu-method-info{flex:1}
        .tu-method-name{font-size:14px;font-weight:600;color:var(--text-primary)}
        .tu-method-sub{font-size:12px;color:var(--text-muted);margin-top:1px}
        .tu-fee{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px}
        .tu-fee-free{background:rgba(34,197,94,0.12);color:#22c55e}
        .tu-fee-paid{background:rgba(245,158,11,0.12);color:#f59e0b}

        /* Amount step redesign */
        .tu-amt-display{text-align:center;margin:8px 0 20px;position:relative}
        .tu-amt-display-num{font-size:48px;font-weight:900;letter-spacing:-2px;line-height:1;color:#ffffff !important;-webkit-text-fill-color:#fff !important;transition:all .12s;display:block;text-align:center}
        .tu-amt-display-sym{font-size:28px;font-weight:700;color:rgba(255,255,255,.6);vertical-align:super;margin-right:4px}
        .tu-amt-display-input{position:absolute;inset:0;opacity:0;width:100%;cursor:text}
        .tu-presets{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:18px}
        .tu-preset-chip{padding:7px 16px;border-radius:30px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;color:#fff}
        .tu-preset-chip:hover{background:rgba(255,255,255,0.09);border-color:rgba(255,255,255,0.16)}
        .tu-preset-chip.sel{background:rgba(var(--accent-rgb),0.15);border-color:rgba(var(--accent-rgb),0.5);color:var(--accent-primary)}
        .tu-adj-btns{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:20px}
        .tu-adj-btn{width:46px;height:46px;border-radius:50%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff !important;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,transform .12s;line-height:1;flex-shrink:0;position:relative;z-index:2}
        .tu-adj-btn:hover{background:rgba(255,255,255,0.18) !important;border-color:rgba(255,255,255,.28);transform:scale(1.08)}
        .tu-adj-btn:active{transform:scale(.93)}

        .tu-custom-wrap{display:flex;align-items:center;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;overflow:hidden;margin-bottom:16px}
        .tu-custom-wrap:focus-within{border-color:rgba(var(--accent-rgb),0.4)}
        .tu-custom-input{flex:1;background:none;border:none;outline:none;padding:11px 12px;font-size:15px;font-weight:600;color:var(--text-primary)}
        .tu-custom-sym{padding:0 14px 0 4px;font-size:14px;color:var(--text-muted)}
        .tu-summary{background:rgba(var(--accent-rgb),0.06);border:1px solid rgba(var(--accent-rgb),0.15);border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;font-size:13px}
        .tu-summary-method{color:var(--text-muted)}
        .tu-summary-amt{font-size:18px;font-weight:800;color:var(--text-primary)}
        .tu-hist-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px}
        .tu-hist-status{font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px}

        /* Fixed-height paginated list */
        .tu-paged-wrap{position:relative;overflow:hidden}
        .tu-page-inner{display:flex;flex-direction:column;gap:6px;animation:tuPageIn .18s ease both}
        @keyframes tuPageIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .tu-page-back .tu-page-inner{animation:tuPageBack .18s ease both}
        @keyframes tuPageBack{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
        .tu-paged-pagination{display:flex;align-items:center;justify-content:space-between;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);margin-top:10px}
      </style>`;

    function tuRender(step, direction = 'forward') {
      const cls = direction === 'back' ? 'tu-slide-back' : 'tu-slide';
      const wrap = document.getElementById('tuWrap');
      if (!wrap) return;
      wrap.innerHTML = `<div class="${cls}">${tuStepHtml(step)}</div>`;
      tuBindStep(step);
    }

    function tuStepHtml(step) {
      const dots = [1,2,3].map(i => `<div class="tu-step-dot${i===step?' active':''}"></div>`).join('');
      const backBtn = step > 1 && step < 4
        ? `<button class="tu-back-btn" id="tuBackBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>`
        : '<div style="width:32px"></div>';

      if (step === 1) {
        // Method selection
        return `
          <div class="tu-header">
            ${backBtn}
            <div class="tu-title">Способ оплаты</div>
            <div class="tu-steps">${dots}</div>
          </div>
          <div class="tu-method-list">
            ${methods.map(m => `
              <button class="tu-method-btn" data-method="${m.id}">
                <div class="tu-method-icon" style="background:${m.color}18">${m.icon}</div>
                <div class="tu-method-info">
                  <div class="tu-method-name">${m.label}</div>
                  <div class="tu-method-sub">${m.sub}</div>
                </div>
                ${m.fee !== null ? `<span class="tu-fee ${m.fee==='0%'?'tu-fee-free':'tu-fee-paid'}">${m.fee}</span>` : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted)"><polyline points="9 18 15 12 9 6"/></svg>'}
              </button>`).join('')}
          </div>`;

      } else if (step === 2) {
        // Amount selection — clean card redesign (no circle)
        const m = methods.find(x => x.id === tuMethod) || {};
        const curr = localStorage.getItem('rst_currency') || 'rub';
        const isUsd = curr === 'usd';
        const rate = parseFloat(localStorage.getItem('rst_exchange_rate') || '0') || 0.011;
        const sym = isUsd ? '$' : '₽';
        const presetsRub = [50, 100, 300, 500, 1000, 2000, 5000];
        const fmtNum = (v) => isUsd ? (v*rate).toFixed(2) : v;
        const chipLabel = (v) => isUsd ? `$${(v*rate).toFixed(0)}` : (v>=1000 ? (v/1000).toFixed(v%1000?1:0)+'к' : String(v));
        const displayNum = fmtNum(tuAmt);
        return `
          <div class="tu-header">
            ${backBtn}
            <div class="tu-title">Сумма пополнения</div>
            <div class="tu-steps">${dots}</div>
          </div>

          <!-- Method badge -->
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:16px">
            <div style="width:28px;height:28px;border-radius:7px;background:${m.color||'#7c3aed'}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">${m.icon||'💳'}</div>
            <div style="font-size:13px;font-weight:600;flex:1">${m.label||''}</div>
            ${m.fee && m.fee!=='0%' ? `<span class="tu-fee tu-fee-paid">+${m.fee}</span>` : `<span class="tu-fee tu-fee-free">0% комиссия</span>`}
          </div>

          <!-- Main amount card (flat, no circle) -->
          <div style="background:linear-gradient(135deg,rgba(var(--accent-rgb),.1),rgba(var(--accent-rgb),.04));border:1px solid rgba(var(--accent-rgb),.2);border-radius:18px;padding:24px 20px 20px;margin-bottom:16px;position:relative;overflow:hidden">
            <div style="position:absolute;top:0;right:0;width:100px;height:100px;background:radial-gradient(circle,rgba(var(--accent-rgb),.12),transparent 70%);pointer-events:none"></div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.4);margin-bottom:10px">Введите сумму</div>
            <!-- Editable big number -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
              <button class="tu-adj-btn" id="tuAdjMinus" title="-50" style="color:#fff !important;flex-shrink:0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <div style="flex:1;text-align:center;cursor:pointer;position:relative" id="tuAmtClickArea">
                <span class="tu-amt-display-num" id="tuAmtNum" style="color:#fff !important;-webkit-text-fill-color:#fff !important;font-size:52px;font-weight:900;letter-spacing:-2px;display:block;line-height:1">${displayNum}</span>
                <span style="font-size:20px;font-weight:700;color:rgba(255,255,255,.45);letter-spacing:.5px">${sym}</span>
                <div style="font-size:11px;color:rgba(255,255,255,.3);margin-top:4px">нажмите для ввода</div>
              </div>
              <button class="tu-adj-btn" id="tuAdjPlus" title="+50" style="color:#fff !important;flex-shrink:0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
            <!-- Preset chips -->
            <div class="tu-presets" style="justify-content:center">
              ${presetsRub.map(p => `<button class="tu-preset-chip${p===tuAmt?' sel':''}" data-preset="${p}">${chipLabel(p)}${!isUsd?'₽':''}</button>`).join('')}
            </div>
          </div>

          <!-- Info row -->
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:10px;margin-bottom:14px;font-size:12px">
            <span style="color:rgba(255,255,255,.4)">Минимум 10 ₽</span>
            <span>${m.fee && m.fee!=='0%' ? `Комиссия: <b style="color:#f59e0b">${m.fee}</b>` : '<b style="color:#22c55e">Без комиссии</b>'}</span>
          </div>

          <button class="btn btn-primary" style="width:100%;padding:15px;font-size:16px;font-weight:700;border-radius:14px" id="tuNextBtn">
            Пополнить ${fmtNum(tuAmt)} ${sym}
          </button>`;

      } else if (step === 3) {
        // Confirm & pay
        const m = methods.find(x => x.id === tuMethod) || {};
        const feeAmt = m.fee && m.fee !== '0%' ? Math.ceil(tuAmt * parseFloat(m.fee) / 100) : 0;
        const total = tuAmt + feeAmt;
        return `
          <div class="tu-header">
            ${backBtn}
            <div class="tu-title">Подтверждение</div>
            <div class="tu-steps">${dots}</div>
          </div>
          <div class="tu-summary">
            <div>
              <div class="tu-summary-method">${m.label}</div>
              ${feeAmt ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">+${fmtCurrency(feeAmt)} комиссия</div>` : ''}
            </div>
            <div class="tu-summary-amt">${fmtCurrency(tuAmt)}</div>
          </div>
          ${feeAmt ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;margin-bottom:12px">Итого спишется: <b>${fmtCurrency(total)}</b></div>` : ''}
          <button class="btn btn-primary" style="width:100%;padding:14px;font-size:15px;font-weight:700" id="tuPayBtn">
            Пополнить ${fmtCurrency(tuAmt)}
          </button>`;

      } else if (step === 4) {
        // Pending crypto/kassa
        return `
          <div style="text-align:center;padding:8px 0 4px">
            <div style="width:60px;height:60px;border-radius:18px;background:rgba(var(--accent-rgb),0.1);border:1px solid rgba(var(--accent-rgb),0.2);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="var(--accent-primary)" stroke-width="2"/><path d="M12 6v6l4 2" stroke="var(--accent-primary)" stroke-width="2" stroke-linecap="round"/></svg>
            </div>
            <h3 style="margin:0 0 6px">Ожидаем оплату</h3>
            <p style="color:var(--text-muted);font-size:13px;margin:0 0 20px" id="tuPendingDesc">Баланс обновится автоматически после оплаты.</p>
            <button class="btn btn-primary" style="width:100%;margin-bottom:10px" id="btnCheckTopup">Проверить оплату</button>
            <button class="btn btn-ghost btn-sm" style="width:100%" onclick="closeModal()">Закрыть</button>
          </div>`;

      } else if (step === 5) {
        // History — fixed-height container prevents resize on pagination
        const HIST_H = 8 * 63 + 8;
        return `
          <div class="tu-header">
            <button class="tu-back-btn" id="tuBackBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
            <div class="tu-title">Мои пополнения</div>
            <div style="width:32px"></div>
          </div>
          <div id="tuHistoryList" style="min-height:${HIST_H}px;display:flex;align-items:center;justify-content:center"><div class="spinner"></div></div>`;
      }
      return '';
    }

    function tuBindStep(step) {
      // Back button
      document.getElementById('tuBackBtn')?.addEventListener('click', () => {
        tuStep = step === 5 ? 1 : step - 1;
        tuRender(tuStep, 'back');
      });

      if (step === 1) {
        // Method buttons
        document.querySelectorAll('.tu-method-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            tuMethod = btn.dataset.method;
            if (tuMethod === 'promo') { closeModal(); showPromoInput(); return; }
            if (tuMethod === 'history') { tuStep = 5; tuRender(5); tuLoadHistory(); return; }
            tuStep = 2;
            tuRender(2);
          });
        });
      } else if (step === 2) {
        const curr2 = localStorage.getItem('rst_currency') || 'rub';
        const isUsd2 = curr2 === 'usd';
        const rate2 = parseFloat(localStorage.getItem('rst_exchange_rate') || '0') || 0.011;
        const toRub = (userVal) => isUsd2 ? Math.round(userVal / rate2) : Math.round(Number(userVal));
        const toUser = (rubVal) => isUsd2 ? (rubVal * rate2).toFixed(2) : rubVal;
        const minRub = 10;

        // Update the big display number
        const updateDisplay = () => {
          const numEl = document.getElementById('tuAmtNum');
          const btn = document.getElementById('tuNextBtn');
          const sym = isUsd2 ? '$' : '₽';
          if (numEl) {
            numEl.textContent = toUser(tuAmt);
            // Ensure white color stays (overrides any CSS cascade)
            numEl.style.color = '#fff';
            numEl.style.webkitTextFillColor = '#fff';
          }
          if (btn) btn.textContent = `Пополнить ${toUser(tuAmt)} ${sym}`;
          document.querySelectorAll('.tu-preset-chip').forEach(b => b.classList.toggle('sel', parseInt(b.dataset.preset) === tuAmt));
        };

        // Preset chips
        document.querySelectorAll('.tu-preset-chip').forEach(b => {
          b.addEventListener('click', () => {
            tuAmt = parseInt(b.dataset.preset);
            updateDisplay();
          });
        });

        // Click on amount circle → floating input (no overflow)
        document.getElementById('tuAmtClickArea')?.addEventListener('click', () => {
          const numEl = document.getElementById('tuAmtNum');
          const circle = document.getElementById('tuAmtClickArea');
          if (!numEl || !circle) return;
          if (document.getElementById('tuAmtFloatInput')) return;

          // Build a small modal-style input
          const overlay = document.createElement('div');
          overlay.id = 'tuAmtFloatInput';
          Object.assign(overlay.style, {
            position:'fixed', inset:'0', zIndex:'10000',
            display:'flex', alignItems:'center', justifyContent:'center',
            background:'rgba(0,0,0,.55)', backdropFilter:'blur(4px)'
          });
          overlay.innerHTML = `<div style="background:var(--bg-card);border:1px solid rgba(var(--accent-rgb),.4);border-radius:16px;padding:20px 24px;display:flex;flex-direction:column;gap:10px;min-width:200px;box-shadow:0 8px 40px rgba(0,0,0,.4)">
            <div style="font-size:12px;color:var(--text-muted);text-align:center;font-weight:600;letter-spacing:.5px">ВВЕДИТЕ СУММУ (₽)</div>
            <input id="tuAmtRealInput" type="number" min="\${minRub}" step="1" value="\${tuAmt}"
              style="text-align:center;font-size:32px;font-weight:800;color:#fff;background:rgba(255,255,255,.06);border:1px solid rgba(var(--accent-rgb),.3);border-radius:10px;padding:8px 12px;outline:none;width:100%;letter-spacing:-1px">
            <div style="display:flex;gap:8px">
              <button id="tuAmtConfirm" style="flex:1;padding:10px;background:var(--accent-gradient);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer">Принять</button>
              <button id="tuAmtCancel" style="padding:10px 14px;background:rgba(255,255,255,.06);color:var(--text-muted);border:1px solid rgba(255,255,255,.1);border-radius:10px;font-size:13px;cursor:pointer">✕</button>
            </div>
          </div>`;
          document.body.appendChild(overlay);

          const inp = document.getElementById('tuAmtRealInput');
          setTimeout(() => { inp?.focus(); inp?.select(); }, 50);

          const confirm = () => {
            const v = parseFloat(inp.value);
            if (!isNaN(v) && v > 0) { tuAmt = Math.max(minRub, toRub(v)); }
            overlay.remove(); updateDisplay();
          };
          document.getElementById('tuAmtConfirm')?.addEventListener('click', confirm);
          document.getElementById('tuAmtCancel')?.addEventListener('click', () => overlay.remove());
          inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') overlay.remove(); });
          overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        });

        // Adjust buttons — step = 50 or 10% of current amount (whichever is larger)
        const adjStep = () => Math.max(50, Math.round(tuAmt * 0.1 / 50) * 50);
        document.getElementById('tuAdjMinus')?.addEventListener('click', () => {
          tuAmt = Math.max(minRub, tuAmt - adjStep());
          updateDisplay();
        });
        document.getElementById('tuAdjPlus')?.addEventListener('click', () => {
          tuAmt = tuAmt + adjStep();
          updateDisplay();
        });

        document.getElementById('tuNextBtn')?.addEventListener('click', () => {
          if (tuAmt < minRub) return toast('Минимум 10 ₽', 'warning');
          tuStep = 3;
          tuRender(3);
        });
      } else if (step === 3) {
        document.getElementById('tuPayBtn')?.addEventListener('click', tuExecutePay);
      } else if (step === 4) {
        // Auto-poll every 5 seconds
        if (tuTopupId) {
          const desc = document.getElementById('tuPendingDesc');
          if (tuMethod === 'crypto' && desc) desc.textContent = 'Оплати инвойс в @CryptoBot и вернись сюда. Автопроверка каждые 5 сек.';
          if (tuMethod === 'platega' && desc) desc.textContent = 'Оплати через СБП или карту на открывшейся странице. Баланс зачислится автоматически.';
          if ((tuMethod === 'yookassa' || tuMethod === 'robokassa') && desc) desc.textContent = 'Оплати на странице банка и вернись. Баланс зачтётся автоматически.';

          tuPollTimer = setInterval(async () => {
            try {
              const endpoint = `/api/topup/status?id=${tuTopupId}`;
              const st = await api(endpoint, { silent: true });
              if (st && (st.status === 'paid' || st.credited)) {
                clearInterval(tuPollTimer);
                await refreshUserState();
                closeModal();
                toast('Баланс пополнен!', 'success');
              }
            } catch(e) {}
          }, 5000);
        }
        document.getElementById('btnCheckTopup')?.addEventListener('click', async () => {
          clearInterval(tuPollTimer);
          const btn = document.getElementById('btnCheckTopup');
          if (btn) { btn.disabled = true; btn.textContent = 'Проверяем...'; }
          try {
            const endpoint = `/api/topup/status?id=${tuTopupId}`;
            const st = await api(endpoint, { silent: true });
            if (st && (st.status === 'paid' || st.credited)) {
              await refreshUserState();
              closeModal();
              toast('Баланс пополнен!', 'success');
            } else {
              toast('Оплата ещё не прошла', 'info');
              if (btn) { btn.disabled = false; btn.textContent = 'Проверить ещё раз'; }
              // Restart poll
              tuPollTimer = setInterval(async () => {
                try {
                  const st2 = await api(endpoint, { silent: true });
                  if (st2 && (st2.status === 'paid' || st2.credited)) {
                    clearInterval(tuPollTimer);
                    await refreshUserState();
                    closeModal();
                    toast('Баланс пополнен!', 'success');
                  }
                } catch(e) {}
              }, 5000);
            }
          } catch(e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Проверить ещё раз'; }
          }
        });
      }
    }

    let _histPage = 0;
    const _HIST_PER_PAGE = 8;
    let _histData = [];

    async function tuLoadHistory() {
      const list = document.getElementById('tuHistoryList');
      if (!list) return;
      list.innerHTML = '<div style="height:440px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)"><div class="spinner"></div></div>';
      try {
        const d = await api('/api/topup/my?limit=100', { silent: true });
        _histData = d?.topups || d?.items || [];
        _histPage = 0;
        _renderHistPage(list, 'in');
      } catch(e) {
        list.innerHTML = '<div style="height:440px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">Ошибка загрузки</div>';
      }
    }

    function _renderHistPage(list, dir = 'in') {
      if (!list) return;
      const rows = _histData;
      const FIXED_H = 440; // Fixed container height

      if (!rows.length) {
        list.innerHTML = `<div style="height:${FIXED_H}px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--text-muted)">
          <div style="font-size:32px">💸</div><div>Пополнений пока нет</div></div>`;
        return;
      }

      const total = rows.length;
      const totalPages = Math.ceil(total / _HIST_PER_PAGE);
      const start = _histPage * _HIST_PER_PAGE;
      const slice = rows.slice(start, start + _HIST_PER_PAGE);

      const statusCfg = {
        paid:     { label:'✅ Зачислено',  color:'#22c55e' },
        credited: { label:'✅ Зачислено',  color:'#22c55e' },
        pending:  { label:'⏳ Ожидание',   color:'#f59e0b' },
        active:   { label:'⏳ Ожидание',   color:'#f59e0b' },
        expired:  { label:'⏰ Истёк',      color:'#6b7280' },
        failed:   { label:'❌ Ошибка',     color:'#ef4444' },
      };
      const methodIcon = { yookassa:'💳', robokassa:'💳', crypto:'🤖', manual:'💵', cardlink:'💳' };

      const animClass = dir === 'back' ? 'tu-page-back' : '';
      const itemsHtml = slice.map(r => {
        const st = String(r.status || '');
        const cfg = statusCfg[st] || { label: st || '—', color: '#6b7280' };
        const ts = _fmtDatetime(r.created_at);
        const pts = parseInt(r.points || 0);
        const isPending = st === 'pending' || st === 'active';
        return `<div class="tu-history-row" data-tid="${r.id}" style="display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);${isPending ? 'cursor:pointer;' : ''}transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,0.055)'" onmouseout="this.style.background='rgba(255,255,255,0.03)'">
          <div class="tu-hist-icon" style="background:${cfg.color}18">${methodIcon[r.method] || '💰'}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px;color:${pts > 0 ? '#22c55e' : 'var(--text-primary)'}">+${pts} ₽</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${ts}</div>
          </div>
          <div class="tu-hist-status" style="background:${cfg.color}18;color:${cfg.color}">${cfg.label}</div>
        </div>`;
      }).join('');

      const paginationHtml = totalPages > 1 ? `
        <div class="tu-paged-pagination">
          <button class="btn btn-secondary btn-sm" id="histPrev" ${_histPage === 0 ? 'disabled' : ''} style="gap:5px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg> Назад
          </button>
          <span style="font-size:12px;color:var(--text-muted)">${_histPage + 1} / ${totalPages}</span>
          <button class="btn btn-secondary btn-sm" id="histNext" ${_histPage >= totalPages - 1 ? 'disabled' : ''} style="gap:5px">
            Вперёд <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>` : '';

      // Items container with fixed min-height so modal doesn't resize
      const itemsMinH = _HIST_PER_PAGE * 60; // ~60px per row
      list.innerHTML = `
        <div class="tu-paged-wrap ${animClass}" style="min-height:${itemsMinH}px">
          <div class="tu-page-inner">${itemsHtml}</div>
        </div>
        ${paginationHtml}`;

      document.getElementById('histPrev')?.addEventListener('click', () => { _histPage--; _renderHistPage(list, 'back'); });
      document.getElementById('histNext')?.addEventListener('click', () => { _histPage++; _renderHistPage(list, 'in'); });

      // Click pending to check
      list.querySelectorAll('.tu-history-row[data-tid]').forEach(row => {
        const r = rows.find(x => String(x.id) === row.dataset.tid);
        if (r && (r.status === 'pending' || r.status === 'active')) {
          row.addEventListener('click', async () => {
            row.style.opacity = '0.5';
            try {
              const s = await api(`/api/topup/status?id=${r.id}`, { silent: true });
              if (s && (s.status === 'paid' || s.credited)) {
                await refreshUserState(); closeModal(); toast('Баланс пополнен!', 'success');
              } else { toast('Оплата не найдена', 'info'); }
            } catch(e) {}
            row.style.opacity = '1';
          });
        }
      });
    }

    async function tuExecutePay() {
      const btn = document.getElementById('tuPayBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Обработка...'; }
      if (tuMethod === 'manual') {
        try {
          loading(true);
          const d = await api('/api/topup/create', { method: 'POST', body: { amount: tuAmt, method: 'manual' } });
          closeModal();
          modal(`
            <div style="text-align:center;padding:12px 0">
              <div style="font-size:44px;margin-bottom:12px">📝</div>
              <h3>Заявка создана</h3>
              <p style="color:var(--text-muted);font-size:13px">Заявка #${d.id||'—'} на ${fmtCurrency(tuAmt)} создана.<br>Переведите средства и ожидайте подтверждения.</p>
              <button class="btn btn-primary" style="width:100%;margin-top:18px" onclick="closeModal()">Понятно</button>
            </div>`);
        } catch(e) { toast(e.message, 'error'); if(btn){btn.disabled=false;btn.textContent=`Пополнить ${fmtCurrency(tuAmt)}`;} }
        finally { loading(false); }
        return;
      }
      try {
        loading(true);
        const apiMethod = tuMethod === 'yookassa' ? 'yookassa' : (tuMethod === 'robokassa' ? 'robokassa' : (tuMethod === 'crypto' ? 'cryptobot' : (tuMethod === 'platega' ? 'platega' : tuMethod)));
        const d = await api('/api/topup/create', { method: 'POST', body: { amount: tuAmt, method: apiMethod } });
        tuTopupId = d.id;

        if (d.pay_url) {
          const url = d.pay_url;
          const tgMatch = url.match(/t\.me\/\$([A-Za-z0-9_-]+)/);
          if (tgMatch) {
            const a = document.createElement('a');
            a.href = `tg://invoice?slug=${tgMatch[1]}`;
            a.click();
            setTimeout(() => window.open(url, '_blank'), 1500);
          } else {
            window.open(url, '_blank');
          }
        }
        tuStep = 4;
        tuRender(4);
      } catch(e) {
        toast(e.message, 'error');
        if(btn){btn.disabled=false;btn.textContent=`Пополнить ${fmtCurrency(tuAmt)}`;}
      } finally { loading(false); }
    }

    // Render modal wrapper
    modal(`
      ${tuCss}
      <div class="tu-wrap" id="tuWrap"></div>
    `, { size: 'wide' });

    // Cleanup poll on close
    const origClose = closeModal;
    const _tuCloseHook = () => { if (tuPollTimer) clearInterval(tuPollTimer); };
    $('#modalClose')?.addEventListener('click', _tuCloseHook, { once: true });

    // Render step 1
    tuRender(1);
  }

  function showPromoInput() {
    modal(`
      <h2 style="margin-bottom:24px;text-align:center">Промокод</h2>
      <form id="promoForm">
        <div class="form-group">
          <label class="form-label">Введи промокод</label>
          <input type="text" class="form-input" id="promoCode" required style="text-transform:uppercase">
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px">Активировать</button>
      </form>
    `);
    $('#promoForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const code = $('#promoCode')?.value?.trim();
      if (!code) return;
      try {
        loading(true);
        const d = await api('/api/topup/redeem', { method: 'POST', body: { code } });
        closeModal();
        // Apply balance immediately from response
        if (d && typeof d.new_balance === 'number') {
          if (state.user) state.user.balance = d.new_balance;
          _applyBalance(d.new_balance);
        }
        const credited = d?.credited ?? '?';
        toast(`✅ Промокод активирован! +${credited} ₽`, 'success');
        // Full refresh after short delay
        setTimeout(refreshUserState, 800);
      } catch (e) { toast(e.message, 'error'); } finally { loading(false); }
    });
  }

  // Init
    // Shop (storefront) ---------------------------------------------
  function shopDefaultConfig() {
    return {
      categories: [
        { id: "robux", title: "Robux", sort: 10, visible: true },
        { id: "premium", title: "Premium", sort: 20, visible: true },
        { id: "services", title: "Услуги", sort: 30, visible: true },
      ],
      items: [
        {
          id: "robux_1000",
          title: "1000 Robux",
          subtitle: "Моментальная выдача",
          price_rub: 500,
          badge: "Популярно",
          category_id: "robux",
          banner_url: "",
          visible: true,
          sort: 10,
        },
        {
          id: "premium_1m",
          title: "Premium 1 месяц",
          subtitle: "Официальная подписка",
          price_rub: 449,
          badge: "Лучший выбор",
          category_id: "premium",
          banner_url: "",
          visible: true,
          sort: 20,
        },
      ],
      ui: { card_style: "glass" },
    };
  }

  async function loadShopConfig() {
    try {
      const r = await api('/api/shop_config', { silent: true }); if (!r) return;
      if (r?.ok && r.config && typeof r.config === 'object') {
        state.shopConfig = r.config;
        return;
      }
    } catch (e) {}
    state.shopConfig = shopDefaultConfig();
  }

  function shopGetCategories() {
    const cfg = state.shopConfig || shopDefaultConfig();
    const cats = Array.isArray(cfg.categories) ? cfg.categories : [];
    return cats.filter(c => c && c.visible !== false).sort((a,b) => (a.sort ?? 0) - (b.sort ?? 0));
  }
  function shopGetItems() {
    const cfg = state.shopConfig || shopDefaultConfig();
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    return items.filter(i => i && i.visible !== false).sort((a,b) => (a.sort ?? 0) - (b.sort ?? 0));
  }


  // ════════════════════════════════════════════════════════
  // SHOP SYSTEM — Dynamic rendering + Editor + Vouchers
  // ════════════════════════════════════════════════════════

  const ITEM_TYPE_META = {
    account: { label: 'Аккаунт',  icon: '👤', color: '#22c55e' },
    digital: { label: 'Ключи',    icon: '🔑', color: '#f59e0b' },
    service: { label: 'Услуга',   icon: '🛠',  color: '#3b82f6' },
    gift:    { label: 'Гифт',     icon: '🎁', color: '#ec4899' },
    other:   { label: 'Прочее',   icon: '📦', color: '#8b5cf6' },
    special: { label: '',          icon: '⚡', color: '#9333ea' },
  };

  function _badgeCls(badge) {
    const b = (badge||'').toLowerCase();
    if (b==='хит'||b==='hot') return 'hot';
    if (b==='free'||b==='бесплатно') return 'free';
    if (b==='new'||b==='новый') return 'new';
    return '';
  }

  // ── Currency conversion helpers ──
  const _currSymbol = { rub: '₽', usd: '$', eur: '€' };
  function _convertPrice(rubPrice) {
    const curr = localStorage.getItem('rst_currency') || 'rub';
    if (curr === 'rub') return { val: rubPrice, sym: '₽' };
    const rate = parseFloat(localStorage.getItem('rst_exchange_rate') || '0') || (curr === 'usd' ? 0.011 : 1);
    if (!rate || rate <= 0) return { val: rubPrice, sym: '₽' };
    return { val: Math.ceil(rubPrice * rate * 100) / 100, sym: _currSymbol[curr] || curr.toUpperCase() };
  }
  function _priceDisplay(it) {
    if (it.price_display) return it.price_display;
    const p = Number(it.price_rub);
    if (!p) return '<span class="price-free">Бесплатно</span>';
    const { val, sym } = _convertPrice(p);
    const formatted = sym === '₽' ? val.toLocaleString('ru-RU') : val.toLocaleString('en-US', {minimumFractionDigits:0,maximumFractionDigits:2});
    return `<strong>${formatted}</strong> ${sym}`;
  }

  function _specialBtn(action, featured) {
    const cls = featured ? 'btn btn-primary' : 'btn btn-secondary';
    const map = {
      premium: `<button class="${cls}" id="btnBuyPremium">Купить</button>`,
      case_free: `<button class="${cls}" id="btnCaseFree">Получить</button>`,
      case_paid: `<button class="${cls}" id="btnCasePaid">Открыть</button>`,
      case_money: `<button class="${cls}" id="btnCaseMoney">Открыть</button>`,
      robux: `<button class="${cls}" data-goto="robux">Купить</button>`,
      tools: `<button class="${cls}" data-goto="shop">Магазин</button>`,
      topup: `<button class="${cls}" id="btnTopUp">Пополнить</button>`,
    };
    return map[action] || `<button class="${cls}">Получить</button>`;
  }

  function _cardHtml(it, editorMode) {
    const featured = it.featured ? ' featured' : '';
    const badgeCls = _badgeCls(it.badge);
    const badgeHtml = it.badge ? `<div class="product-badge ${badgeCls}">${escapeHtml(it.badge)}</div>` : '';
    const stock = it._stock !== undefined ? it._stock : null;
    const isHidden = editorMode && it.visible === false;
    const isUnlimited = !!it.unlimited;
    const stockBadge = editorMode
      ? (isUnlimited
          ? `<div style="position:absolute;top:8px;left:8px;background:rgba(99,102,241,0.85);color:#fff;border-radius:8px;padding:2px 8px;font-size:10px;font-weight:700;z-index:4">♾ Безлимит</div>`
          : (stock !== null
              ? `<div style="position:absolute;top:8px;left:8px;background:${stock===0?'rgba(239,68,68,0.85)':stock<=3?'rgba(245,158,11,0.85)':'rgba(34,197,94,0.85)'};color:#fff;border-radius:8px;padding:2px 8px;font-size:10px;font-weight:700;z-index:4">${stock===0?'Нет':'🗃 '+stock}</div>`
              : ''))
      : '';
    const visBtn = editorMode
      ? `<button class="product-vis-btn" data-vis-item="${escapeHtml(it.id)}" title="${it.visible!==false?'Скрыть товар':'Показать товар'}" style="position:absolute;top:8px;right:42px;z-index:5;background:${it.visible!==false?'rgba(34,197,94,0.9)':'rgba(239,68,68,0.9)'};border:none;border-radius:8px;padding:4px 7px;cursor:pointer;color:#fff;display:flex;align-items:center;gap:3px;font-size:10px;font-weight:700;backdrop-filter:blur(4px)">${
          it.visible !== false
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
        }</button>`
      : '';
    const editBtn = editorMode
      ? `<button class="product-edit-overlay-btn" data-edit-item="${escapeHtml(it.id)}" title="Редактировать">✏️</button>`
      : '';
    const _imgs = Array.isArray(it.images) && it.images.length ? it.images : (it.banner_url ? [it.banner_url] : []);
    const _thumb = _imgs[0] || '';
    const bannerHtml = _thumb
      ? `<div class="product-banner"${_imgs.length > 1 ? ' style="cursor:pointer"' : ''}><img src="${escapeHtml(_thumb)}" alt="${escapeHtml(it.title||'')}">
           ${_imgs.length > 1 ? `<div class="product-img-count">📷 ${_imgs.length}</div>` : ''}
           ${badgeHtml}${editBtn}${visBtn}${stockBadge}</div>`
      : `<div class="product-banner"><div class="product-banner-placeholder">
           <span style="font-size:36px">${(ITEM_TYPE_META[it.item_type]||ITEM_TYPE_META.other).icon}</span>
         </div>${badgeHtml}${editBtn}${visBtn}${stockBadge}</div>`;

    const hasDesc = !!(it.description_html || it.subtitle);
    const descBtn = hasDesc
      ? `<button class="btn btn-ghost btn-sm product-info-btn" data-info-id="${escapeHtml(it.id)}" title="Описание">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
           Описание
         </button>` : '';

    const buyBtn = it.item_type === 'special'
      ? _specialBtn(it.special_action, it.featured)
      : `<button class="btn btn-primary" data-shop-buy="${escapeHtml(it.id)}">Купить</button>`;

    const oosHtml = (it.out_of_stock && !isUnlimited)
      ? `<div class="product-oos-overlay"><div class="product-oos-label">Нет в наличии</div></div>`
      : '';
    const buyBtnFinal = (it.out_of_stock && !isUnlimited)
      ? `<button class="btn btn-secondary" disabled style="opacity:0.5;cursor:default">Нет в наличии</button>`
      : buyBtn;
    const hiddenStyle = isHidden ? 'opacity:0.45;' : '';

    const dragAttr = editorMode ? ` draggable="true" data-drag-item="${escapeHtml(it.id)}"` : '';
    return `<div class="product-card-wrapper"${dragAttr} data-product-id="${escapeHtml(it.id)}">
      <div class="product-card${featured}" data-product-id="${escapeHtml(it.id)}" data-price="${Number(it.price_rub)||0}" style="position:relative;${hiddenStyle}">
        ${oosHtml}
        ${bannerHtml}
        <div class="product-body">
          <h3 class="product-title">${escapeHtml(it.title||'')}</h3>
          <p class="product-desc">${it.description_html ? it.description_html.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>') : escapeHtml(it.subtitle||'')}</p>
          <div class="product-footer">
            <span class="product-price">${_priceDisplay(it)}</span>
            <div class="product-actions">${descBtn}${buyBtnFinal}</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderShop() {
    const tabsEl = document.getElementById('shopTabsContainer');
    const gridEl = document.getElementById('shopDynamicGrid');
    if (!tabsEl || !gridEl) return;

    const cfg = (state.shopEditorMode && state.adminShopDraft) ? state.adminShopDraft : (state.shopConfig || {categories:[],items:[]});
    const editorMode = !!state.shopEditorMode;

    // Force-clear browser autofill on search
    const _srchEl = document.getElementById('shopSearch');
    if (_srchEl && !_srchEl._userTyped) {
      _srchEl.value = '';
    }
    const searchQ = (_srchEl?.value || '').toLowerCase().trim();
    const sort = document.getElementById('shopSort')?.value || 'popular';

    // === Build category + subcategory tabs ===
    const allCats = (cfg.categories || [])
      .filter(c => editorMode || c.visible !== false)
      .sort((a,b) => (a.sort||0)-(b.sort||0));
    
    // Top-level categories (no parent_id)
    const topCats = allCats.filter(c => !c.parent_id);
    // Subcategories of active top category
    const activeTopId = state._shopActiveTopCat || (topCats[0]||{}).id || '';
    const subCats = allCats.filter(c => c.parent_id === activeTopId);

    if (!topCats.length) {
      tabsEl.innerHTML = '';
      gridEl.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)">Магазин пуст</div>';
      return;
    }

    // Ensure active top cat is valid
    if (!state._shopActiveTopCat || !topCats.find(c => c.id === state._shopActiveTopCat)) {
      state._shopActiveTopCat = topCats[0].id;
    }
    // Active category = subcategory if selected, else top category
    if (subCats.length > 0) {
      if (!state._shopActiveCat || (!subCats.find(c => c.id === state._shopActiveCat) && state._shopActiveCat !== state._shopActiveTopCat)) {
        state._shopActiveCat = subCats[0].id;
      }
    } else {
      state._shopActiveCat = state._shopActiveTopCat;
    }

    // Check if Beta shop UI is enabled
    // Beta is now default — classic can be enabled via settings
    const shopBeta = localStorage.getItem('rst_shop_beta') !== '0';

    if (shopBeta) {
      // ── Beta: two separate card blocks ──
      // Block 1: top categories (plain separate block, no sliding indicator)
      let tabsHtml = `<div class="shop-seg-wrap">
        <div class="shop-seg shop-seg-top-wrap" id="shopTopSegControl">
          <div class="shop-seg-indicator" id="shopTopSegIndicator"></div>
          ${topCats.map((c, idx) => {
            const active = c.id === state._shopActiveTopCat ? ' active' : '';
            const dim = !c.visible ? ' style="opacity:.4"' : '';
            const eBtn = editorMode ? `<button class="shop-tab-edit-btn" data-edit-cat="${escapeHtml(c.id)}" title="⚙">⚙</button>` : '';
            return `<button class="shop-seg-btn${active}" data-shop-tab="${escapeHtml(c.id)}" data-top-cat="1"${dim}>${escapeHtml(c.title)}${eBtn}</button>`;
          }).join('')}
          ${editorMode ? `<button class="shop-seg-btn shop-tab-add" id="btnShopAddCatInline">+</button>` : ''}
        </div>
      </div>`;

      // Block 2: subcategories with sliding indicator (only when subcats exist)
      let subTabsHtml = '';
      if (subCats.length > 0 || editorMode) {
        const allSubActive = state._shopActiveCat === state._shopActiveTopCat ? ' active' : '';
        subTabsHtml = `<div class="shop-pills-row">
          <div class="shop-seg" id="shopSegControl" style="flex:none;display:inline-flex;gap:0;">
            <div class="shop-seg-indicator" id="shopSegIndicator"></div>
            <button class="shop-seg-btn${allSubActive}" data-sub-tab="${escapeHtml(state._shopActiveTopCat)}">Все</button>`;
        subTabsHtml += subCats.map(sc => {
          const active = sc.id === state._shopActiveCat ? ' active' : '';
          const dim = sc.visible === false ? ' style="opacity:.4"' : '';
          const eBtn = editorMode ? `<button class="shop-tab-edit-btn" data-edit-cat="${escapeHtml(sc.id)}">⚙</button>` : '';
          return `<button class="shop-seg-btn${active}" data-sub-tab="${escapeHtml(sc.id)}"${dim}>${escapeHtml(sc.title)}${eBtn}</button>`;
        }).join('');
        if (editorMode) subTabsHtml += `<button class="shop-seg-btn shop-tab-add" id="btnShopAddSubCat" style="flex:none">+ Подкат.</button>`;
        subTabsHtml += `</div></div>`;
      }
      tabsEl.innerHTML = tabsHtml + subTabsHtml;

      // Position BOTH indicators after render
      requestAnimationFrame(() => {
        // Sub-category indicator
        const seg = document.getElementById('shopSegControl');
        const ind = document.getElementById('shopSegIndicator');
        const activeBtn = seg?.querySelector('.shop-seg-btn.active');
        if (seg && ind && activeBtn) {
          const segRect = seg.getBoundingClientRect();
          const btnRect = activeBtn.getBoundingClientRect();
          ind.style.left = (btnRect.left - segRect.left) + 'px';
          ind.style.width = btnRect.width + 'px';
        }
        // Top-category indicator
        const topSeg = document.getElementById('shopTopSegControl');
        const topInd = document.getElementById('shopTopSegIndicator');
        const topActiveBtn = topSeg?.querySelector('.shop-seg-btn.active');
        if (topSeg && topInd && topActiveBtn) {
          const r1 = topSeg.getBoundingClientRect();
          const r2 = topActiveBtn.getBoundingClientRect();
          topInd.style.left = (r2.left - r1.left + topSeg.scrollLeft) + 'px';
          topInd.style.width = r2.width + 'px';
          topInd.style.opacity = '1';
        }
      });

      // Wire top category buttons
      tabsEl.querySelectorAll('.shop-seg-btn[data-top-cat]').forEach(btn => {
        btn.addEventListener('click', e => {
          if (e.target.closest('.shop-tab-edit-btn')) return;
          // Animate top indicator immediately
          const topSeg = document.getElementById('shopTopSegControl');
          const topInd = document.getElementById('shopTopSegIndicator');
          if (topSeg && topInd) {
            const r1 = topSeg.getBoundingClientRect();
            const r2 = btn.getBoundingClientRect();
            topInd.style.left = (r2.left - r1.left + topSeg.scrollLeft) + 'px';
            topInd.style.width = r2.width + 'px';
          }
          state._shopActiveTopCat = btn.dataset.shopTab;
          state._shopActiveCat = null;
          if (_srchEl) { _srchEl.value = ''; _srchEl._userTyped = false; }
          setTimeout(renderShop, 240);
        });
      });
      // Wire subcategory buttons (inside shopSegControl)
      tabsEl.querySelectorAll('#shopSegControl .shop-seg-btn[data-sub-tab]').forEach(btn => {
        btn.addEventListener('click', e => {
          if (e.target.closest('.shop-tab-edit-btn')) return;
          // Animate indicator before re-render
          const seg = document.getElementById('shopSegControl');
          const ind = document.getElementById('shopSegIndicator');
          if (seg && ind) {
            const segRect = seg.getBoundingClientRect();
            const btnRect = btn.getBoundingClientRect();
            ind.style.left = (btnRect.left - segRect.left) + 'px';
            ind.style.width = btnRect.width + 'px';
          }
          state._shopActiveCat = btn.dataset.subTab;
          setTimeout(renderShop, 260);
        });
      });

    } else {
      // ── Default: classic tab UI (improved visuals) ──
      // Top-level category tabs
      let tabsHtml = topCats.map(c => {
        const active = c.id === state._shopActiveTopCat ? ' active' : '';
        const dim = !c.visible ? ' style="opacity:.45"' : '';
        const eBtn = editorMode ? `<button class="shop-tab-edit-btn" data-edit-cat="${escapeHtml(c.id)}" title="Настройки категории" style="margin-left:4px;padding:2px 5px;font-size:12px;background:rgba(255,255,255,0.1);border:none;border-radius:4px;cursor:pointer;color:inherit;vertical-align:middle">⚙</button>` : '';
        return `<button class="shop-tab${active}" data-shop-tab="${escapeHtml(c.id)}" data-top-cat="1"${dim}>${escapeHtml(c.title)}${eBtn}</button>`;
      }).join('');
      if (editorMode) tabsHtml += `<button class="shop-tab shop-tab-add" id="btnShopAddCatInline">+ Категория</button>`;

      // Subcategory row — "Все" always first
      let subTabsHtml = '';
      if (subCats.length > 0 || editorMode) {
        const allSubActive = state._shopActiveCat === state._shopActiveTopCat ? ' active' : '';
        subTabsHtml = `<div class="shop-sub-tabs">`;
        subTabsHtml += `<button class="shop-sub-tab${allSubActive}" data-sub-tab="${escapeHtml(state._shopActiveTopCat)}">Все</button>`;
        subTabsHtml += subCats.map(sc => {
          const active = sc.id === state._shopActiveCat ? ' active' : '';
          const dim = sc.visible === false ? ' style="opacity:.45"' : '';
          const eBtn = editorMode ? `<button class="shop-tab-edit-btn" data-edit-cat="${escapeHtml(sc.id)}" style="margin-left:3px;padding:1px 4px;font-size:10px;background:rgba(255,255,255,0.1);border:none;border-radius:3px;cursor:pointer;color:inherit">⚙</button>` : '';
          return `<button class="shop-sub-tab${active}" data-sub-tab="${escapeHtml(sc.id)}"${dim}>${escapeHtml(sc.title)}${eBtn}</button>`;
        }).join('');
        if (editorMode) subTabsHtml += `<button class="shop-sub-tab shop-sub-tab-add" id="btnShopAddSubCat">+ Подкатегория</button>`;
        subTabsHtml += `</div>`;
      }

      tabsEl.innerHTML = tabsHtml + subTabsHtml;

      // Wire top tabs
      tabsEl.querySelectorAll('.shop-tab[data-top-cat]').forEach(btn => {
        btn.addEventListener('click', e => {
          if (e.target.closest('.shop-tab-edit-btn')) return;
          state._shopActiveTopCat = btn.dataset.shopTab;
          state._shopActiveCat = null;
          if (_srchEl) { _srchEl.value = ''; _srchEl._userTyped = false; }
          renderShop();
        });
      });
      // Wire sub tabs
      tabsEl.querySelectorAll('.shop-sub-tab[data-sub-tab]').forEach(btn => {
        btn.addEventListener('click', e => {
          if (e.target.closest('.shop-tab-edit-btn')) return;
          state._shopActiveCat = btn.dataset.subTab;
          renderShop();
        });
      });
    } // end Beta/Classic split

    // Shared: editor button wiring (both modes)
    tabsEl.querySelectorAll('.shop-tab-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _shopEditCat(btn.dataset.editCat); });
    });
    document.getElementById('btnShopAddCatInline')?.addEventListener('click', _shopAddCat);
    document.getElementById('btnShopAddSubCat')?.addEventListener('click', () => {
      const cfg2 = _shopDraftEnsure();
      const newSub = { id:'subcat_'+Date.now(), title:'Подкатегория', sort:((subCats.length)+1)*10, visible:true, parent_id: state._shopActiveTopCat };
      cfg2.categories = cfg2.categories||[];
      cfg2.categories.push(newSub);
      state._shopActiveCat = newSub.id;
      _shopEditCat(newSub.id);
    });

    // Items — filter by active category (top or sub)
    let items;
    if (state._shopActiveCat === state._shopActiveTopCat && subCats.length > 0) {
      // "Все" tab: show items from all subcats + items directly in top cat
      const subIds = subCats.map(s => s.id);
      items = (cfg.items||[]).filter(it => it.category_id === state._shopActiveTopCat || subIds.includes(it.category_id));
    } else {
      items = (cfg.items||[]).filter(it => it.category_id === state._shopActiveCat);
    }
    if (!editorMode) items = items.filter(it => it.visible !== false && !(it.out_of_stock && !it.unlimited));
    if (searchQ) items = items.filter(it => ((it.title||'')+(it.subtitle||'')).toLowerCase().includes(searchQ));
    if (sort === 'price-asc') items.sort((a,b) => (a.price_rub||0)-(b.price_rub||0));
    else if (sort === 'price-desc') items.sort((a,b) => (b.price_rub||0)-(a.price_rub||0));
    else items.sort((a,b) => (a.sort||0)-(b.sort||0));

    const addCard = editorMode
      ? `<div class="product-card-wrapper"><div class="shop-add-item-card" data-add-item-cat="${escapeHtml(state._shopActiveCat)}">
           <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
           <div style="font-size:13px;color:var(--text-muted);margin-top:8px">Добавить товар</div>
         </div></div>` : '';

    gridEl.innerHTML = `<div class="shop-tab-content active"><div class="shop-grid">
      ${items.map(it => _cardHtml(it, editorMode)).join('')}${addCard}
    </div></div>`;

    // Wire interactions
    gridEl.querySelectorAll('.product-info-btn[data-info-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = (cfg.items||[]).find(i => i.id === btn.dataset.infoId);
        if (it) _showProductInfoModal(it);
      });
    });
    gridEl.querySelectorAll('[data-shop-buy]').forEach(btn => {
      btn.addEventListener('click', () => _shopBuyItem(btn.dataset.shopBuy));
    });
    gridEl.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.goto));
    });
    if (editorMode) {
      gridEl.querySelectorAll('[data-edit-item]').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); _shopEditItem(btn.dataset.editItem); });
      });
      gridEl.querySelectorAll('[data-add-item-cat]').forEach(btn => {
        btn.addEventListener('click', () => _shopAddItem(btn.dataset.addItemCat));
      });
      // Visibility toggle buttons (eye icons)
      gridEl.querySelectorAll('[data-vis-item]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const cfg2 = _shopDraftEnsure();
          const it = (cfg2.items||[]).find(i => i.id === btn.dataset.visItem);
          if (!it) return;
          it.visible = (it.visible === false) ? true : false;
          renderShop();
          _shopAutoSave();
          toast(it.visible ? '👁 Товар показан' : '🙈 Товар скрыт', 'success');
        });
      });
    }
    // Re-bind special buttons
    $('#btnBuyPremium')?.addEventListener('click', showPremium);
    $('#btnCaseFree')?.addEventListener('click', () => showCaseRoulette('free'));
    $('#btnCasePaid')?.addEventListener('click', () => showCaseRoulette('paid'));
    $('#btnCaseMoney')?.addEventListener('click', () => showCaseRoulette('money'));
    $('#btnTopUp')?.addEventListener('click', showTopUp);
    // 3D tilt
    if (typeof init3DProductCards === 'function') setTimeout(init3DProductCards, 50);
  }

  function bindTiltCards() { /* handled by init3DProductCards */ }
  // ═══════════════════════════════════════════════════════
  // BETA+ CARD — enhanced product card with hover FX
  // ═══════════════════════════════════════════════════════
  function _cardHtmlBeta(it, editorMode) {
    const featured = it.featured;
    const badgeCls = _badgeCls(it.badge);
    const badgeHtml = it.badge ? `<div class="product-badge ${badgeCls}">${escapeHtml(it.badge)}</div>` : '';
    const isHidden = editorMode && it.visible === false;
    const isUnlimited = !!it.unlimited;
    const stock = it._stock !== undefined ? it._stock : null;
    const isOos = it.out_of_stock && !isUnlimited;

    const stockBadge = editorMode
      ? (isUnlimited
          ? `<div class="bcard-stock-badge" style="background:rgba(99,102,241,.85)">♾</div>`
          : (stock !== null ? `<div class="bcard-stock-badge" style="background:${stock===0?'rgba(239,68,68,.85)':stock<=3?'rgba(245,158,11,.85)':'rgba(34,197,94,.85)'}">${stock===0?'OOS':stock}</div>` : ''))
      : '';
    const visBtn = editorMode
      ? `<button class="product-vis-btn" data-vis-item="${escapeHtml(it.id)}" title="${it.visible!==false?'Скрыть':'Показать'}" style="position:absolute;top:8px;right:42px;z-index:5;background:${it.visible!==false?'rgba(34,197,94,.9)':'rgba(239,68,68,.9)'};border:none;border-radius:7px;padding:4px 7px;cursor:pointer;color:#fff;font-size:10px;font-weight:700">${it.visible!==false?'👁':'🙈'}</button>`
      : '';
    const editBtn = editorMode
      ? `<button class="product-edit-overlay-btn" data-edit-item="${escapeHtml(it.id)}" title="Редактировать">✏️</button>`
      : '';

    const _imgs = Array.isArray(it.images) && it.images.length ? it.images : (it.banner_url ? [it.banner_url] : []);
    const _thumb = _imgs[0] || '';

    // Gradient background for cards without image
    const typeColors = {
      robux: ['#7c3aed','#a855f7'], premium: ['#f59e0b','#ef4444'], case: ['#06b6d4','#3b82f6'],
      gamepass: ['#10b981','#22c55e'], other: ['#6366f1','#8b5cf6']
    };
    const [c1, c2] = typeColors[it.item_type] || typeColors.other;
    const placeholderBg = `linear-gradient(135deg,${c1},${c2})`;

    const imgHtml = _thumb
      ? `<div class="bcard-img-wrap">${badgeHtml}${editBtn}${visBtn}${stockBadge}
           <img src="${escapeHtml(_thumb)}" alt="${escapeHtml(it.title||'')}" class="bcard-img">
           ${_imgs.length > 1 ? `<div class="bcard-img-count">📷 ${_imgs.length}</div>` : ''}
           <div class="bcard-img-overlay"></div>
         </div>`
      : `<div class="bcard-img-wrap" style="background:${placeholderBg}">${badgeHtml}${editBtn}${visBtn}${stockBadge}
           <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:4px;padding:16px">
             <span style="font-size:40px;line-height:1">${(ITEM_TYPE_META[it.item_type]||ITEM_TYPE_META.other).icon}</span>
             <span style="font-size:10px;font-weight:700;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.5px">${(ITEM_TYPE_META[it.item_type]||ITEM_TYPE_META.other).label||it.item_type||''}</span>
           </div>
           <div class="bcard-img-overlay"></div>
         </div>`;

    const hasDesc = !!(it.description_html || it.subtitle);
    const descBtn = hasDesc
      ? `<button class="btn btn-ghost btn-sm bcard-info-btn product-info-btn" data-info-id="${escapeHtml(it.id)}">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
         </button>`
      : '';

    const buyBtn = it.item_type === 'special'
      ? _specialBtn(it.special_action, featured)
      : `<button class="btn btn-primary bcard-buy-btn" data-shop-buy="${escapeHtml(it.id)}">Купить</button>`;
    const buyBtnFinal = isOos
      ? `<button class="btn btn-secondary bcard-buy-btn" disabled style="opacity:.5;cursor:default">Нет в наличии</button>`
      : buyBtn;

    const oosOverlay = isOos
      ? `<div class="product-oos-overlay"><div class="product-oos-label">Нет в наличии</div></div>` : '';
    const hiddenStyle = isHidden ? 'opacity:.4;' : '';
    const featuredStyle = featured ? ';outline:2px solid rgba(var(--accent-rgb),.5);outline-offset:2px' : '';
    const dragAttr = editorMode ? ` draggable="true" data-drag-item="${escapeHtml(it.id)}"` : '';

    return `<div class="product-card-wrapper bcard-wrapper" data-product-id="${escapeHtml(it.id)}"${dragAttr}>
      <div class="bcard${featured?' bcard-featured':''}" data-product-id="${escapeHtml(it.id)}" data-price="${Number(it.price_rub)||0}" style="${hiddenStyle}${featuredStyle}">
        ${oosOverlay}
        ${imgHtml}
        <div class="bcard-body">
          <div class="bcard-title">${escapeHtml(it.title||'')}</div>
          ${it.subtitle ? `<div class="bcard-sub">${escapeHtml(it.subtitle)}</div>` : ''}
          <div class="bcard-footer">
            <div class="bcard-price">${_priceDisplay(it)}</div>
            <div class="bcard-actions">
              ${descBtn}
              ${buyBtnFinal}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  async function initShop() {
    await loadShopConfig();
    state.adminShopDraft = null;

    // Clear search on each shop load (prevent browser autofill)
    const searchEl = document.getElementById('shopSearch');
    if (searchEl) {
      searchEl.value = '';
      searchEl._userTyped = false;
      const _debouncedRender = debounce(renderShop, 150);
      // Track actual user input
      searchEl.addEventListener('input', () => { searchEl._userTyped = true; _debouncedRender(); });
      searchEl.addEventListener('focus', () => { if (!searchEl._userTyped) searchEl.value = ''; });
      // Periodically clear autofill for first 3 seconds
      let _clearCount = 0;
      const _clearInt = setInterval(() => {
        if (!searchEl._userTyped && searchEl.value) searchEl.value = '';
        if (++_clearCount > 6) clearInterval(_clearInt);
      }, 500);
    }
    document.getElementById('shopSort')?.addEventListener('change', renderShop);

    // Editor banner buttons
    document.getElementById('btnShopEditorSave')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnShopEditorSave');
      if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Сохранение...'; }
      try {
        const draft = state.adminShopDraft || state.shopConfig;
        await api('/api/admin/shop_config', { method: 'POST', body: { config: draft } });
        state.shopConfig = JSON.parse(JSON.stringify(draft));
        state.adminShopDraft = JSON.parse(JSON.stringify(draft));
        toast('✅ Магазин сохранён!', 'success');
        renderShop();
      } catch(e) { toast('❌ ' + (e.message||'Ошибка сохранения'), 'error'); }
      finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '💾 Сохранить'; }
      }
    });
    document.getElementById('btnShopEditorExit')?.addEventListener('click', async () => {
      state.shopEditorMode = false;
      document.getElementById('shopEditorBanner')?.classList.add('hidden');
      state.adminShopDraft = null;
      const btn = document.getElementById('btnToggleShopEditor');
      if (btn) { btn.textContent = '✏ Включить режим редактора'; btn.className = 'btn btn-primary'; }
      await loadShopConfig();
      renderShop();
    });
    document.getElementById('btnShopEditorAddCat')?.addEventListener('click', _shopAddCat);
    document.getElementById('btnShopEditorAddItem')?.addEventListener('click', () => {
      const cfg = state.adminShopDraft || state.shopConfig || {};
      _shopAddItem(state._shopActiveCat || (cfg.categories||[])[0]?.id || '');
    });

    document.querySelectorAll('[data-tab="shop"]').forEach(el => {
      el.addEventListener('click', () => setTimeout(renderShop, 0));
    });

    handleVoucherFromUrl();
    renderShop();
  }

  // ── Voucher handling ──────────────────────────────────────────
  async function handleVoucherFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('voucher');
    if (!code) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('voucher');
    history.replaceState({}, '', url.toString());
    document.querySelector('[data-tab="shop"]')?.click();
    await new Promise(r => setTimeout(r, 350));
    showVoucherModal(code.toUpperCase());
  }

  function showVoucherModal(code) {
    if (state.user) {
      modal(`
        <div style="text-align:center;padding:8px 0 20px">
          <div style="font-size:48px">🎁</div>
          <h2 style="margin:10px 0 6px">Ваучер</h2>
          <div style="font-size:22px;font-weight:800;letter-spacing:3px;color:var(--accent-tertiary);font-family:monospace;background:rgba(147,51,234,0.1);padding:10px 20px;border-radius:10px;display:inline-block;margin-bottom:8px">${escapeHtml(code)}</div>
          <p style="color:var(--text-muted);font-size:13px">Нажмите, чтобы получить товар на аккаунт</p>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" style="width:100%;padding:14px;font-size:16px" id="btnClaimVoucher">🎁 Получить товар</button>
          <button class="btn btn-ghost" style="width:100%" id="btnVoucherCancel">Отмена</button>
        </div>
      `);
      document.getElementById('btnVoucherCancel')?.addEventListener('click', () => closeModal());
      document.getElementById('btnClaimVoucher')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnClaimVoucher');
        const cancelBtn = document.getElementById('btnVoucherCancel');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Получаем...'; }
        if (cancelBtn) cancelBtn.disabled = true;
        try {
          const d = await api('/api/shop/voucher/claim', { method: 'POST', body: { code } });
          closeModal();
          await refreshUserState();
          // Handle out_of_stock same as buy
          if (d.out_of_stock && d.product_id) {
            const cfg2 = state.adminShopDraft || state.shopConfig;
            if (cfg2) {
              const it2 = (cfg2.items||[]).find(i => i.id === d.product_id);
              if (it2) { it2.out_of_stock = true; }
            }
          }
          setTimeout(() => loadShopConfig().then(() => renderShop()).catch(()=>{}), 500);
          _shopDeliveryModal(d);
        } catch(e) {
          toast(e.message||'Ошибка', 'error');
          if (btn) { btn.disabled = false; btn.textContent = '🎁 Получить товар'; }
          if (cancelBtn) cancelBtn.disabled = false;
        }
      });
    } else {
      modal(`
        <div style="text-align:center;padding:8px 0 20px">
          <div style="font-size:52px">🎁</div>
          <h2 style="margin:10px 0 6px">Получить подарок</h2>
          <p style="color:var(--text-muted);font-size:13px;line-height:1.5;max-width:280px;margin:0 auto">Введите email — мы доставим товар и создадим аккаунт автоматически</p>
        </div>
        <div style="background:rgba(147,51,234,0.1);border:1px solid rgba(147,51,234,0.2);border-radius:12px;padding:12px 16px;margin-bottom:20px;text-align:center">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Ваучер</div>
          <div style="font-size:20px;font-weight:800;letter-spacing:3px;color:var(--accent-tertiary);font-family:monospace">${escapeHtml(code)}</div>
        </div>
        <div class="form-group">
          <label class="form-label">📧 Ваш Email</label>
          <input type="email" class="form-input" id="voucherEmail" placeholder="example@mail.com" autofocus style="font-size:16px;padding:14px">
        </div>
        <button class="btn btn-primary" style="width:100%;margin-top:14px;padding:14px;font-size:15px;font-weight:700" id="btnClaimVoucherEmail">🎁 Получить товар</button>
        <button class="btn btn-ghost btn-sm" style="width:100%;margin-top:8px" onclick="closeModal()">Отмена</button>
        <div style="margin-top:14px;padding:12px 14px;background:rgba(255,255,255,0.03);border-radius:10px;font-size:12px;color:var(--text-muted);line-height:1.6">
          📬 Если аккаунта нет — он создаётся автоматически. Пароль придёт на email.<br>🔒 Данные в безопасности.
        </div>
      `);
      const doClaimByEmail = async () => {
        const email = document.getElementById('voucherEmail')?.value?.trim();
        if (!email || !email.includes('@')) return toast('Введите корректный email', 'warning');
        try {
          loading(true);
          const d = await api('/api/shop/voucher/register-and-claim', { method: 'POST', body: { code, email } });
          closeModal();
          if (d.auto_registered) {
            modal(`
              <div style="text-align:center;margin-bottom:20px">
                <div style="font-size:48px">✅</div>
                <h2 style="margin:10px 0 4px">Аккаунт создан!</h2>
                <p style="color:var(--text-muted);font-size:13px">Данные для входа отправлены на email</p>
              </div>
              <div class="deliv-card deliv-account" style="margin-bottom:16px">
                <div class="deliv-head">🔐 Данные для входа</div>
                <div class="deliv-row"><div class="deliv-label">Логин</div>
                  <div class="deliv-val-wrap"><code class="deliv-val">${escapeHtml(d.username||'')}</code>
                  <button class="deliv-copy" data-copy="${escapeHtml(d.username||'')}">📋</button></div></div>
                <div class="deliv-row"><div class="deliv-label">Email</div>
                  <div class="deliv-val-wrap"><code class="deliv-val">${escapeHtml(email)}</code></div></div>
                <div class="deliv-row"><div class="deliv-label">Пароль</div>
                  <div class="deliv-val-wrap"><code class="deliv-val">${escapeHtml(d.password||'')}</code>
                  <button class="deliv-copy" data-copy="${escapeHtml(d.password||'')}">📋</button></div></div>
              </div>
              <button class="btn btn-primary" style="width:100%" id="btnSeeDelivery">🎁 Посмотреть товар</button>
            `);
            document.querySelectorAll('.deliv-copy').forEach(btn =>
              btn.addEventListener('click', () => navigator.clipboard.writeText(btn.dataset.copy||'').then(() => toast('Скопировано!', 'success'))));
            document.getElementById('btnSeeDelivery')?.addEventListener('click', () => { closeModal(); _shopDeliveryModal(d); });
          } else {
            _shopDeliveryModal(d);
          }
        } catch(e) { toast(e.message||'Ошибка', 'error'); }
        finally { loading(false); }
      };
      document.getElementById('btnClaimVoucherEmail')?.addEventListener('click', doClaimByEmail);
      document.getElementById('voucherEmail')?.addEventListener('keydown', e => { if (e.key==='Enter') doClaimByEmail(); });
    }
  }

  // ── Delivery modal ────────────────────────────────────────────
  function _shopDeliveryModal(d) {
    const title = d.product_title || 'Товар получен!';
    const del = d.delivery || {};
    const type = d.item_type || 'other';

    // Helper: build a styled delivery field
    const field = (label, value, canCopy = true) => value ? `
      <div class="deliv-field-row">
        <div class="deliv-field-label">${label}</div>
        <div class="deliv-field-value">${escapeHtml(String(value))}</div>
        ${canCopy ? `<button class="deliv-copy-btn" data-copy="${escapeHtml(String(value))}">📋</button>` : ''}
      </div>` : '';

    const extra = del.extra || del.info || del.note || '';
    const instruction = del.instruction || del.instructions || del.guide || '';

    let deliveryHtml = '';
    if (type === 'account') {
      const hasSG = !!(del.shared_secret);
      deliveryHtml = `
        <div class="deliv-field-group">
          <div style="padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.05)">👤 Данные аккаунта</div>
          ${field('Логин', del.login || del.username)}
          ${field('Пароль', del.password || del.pass)}
          ${field('Email', del.email, false)}
        </div>
        ${hasSG ? `
        <div class="deliv-field-group" style="margin-top:10px;border-color:rgba(34,197,94,.2);background:rgba(34,197,94,.02)">
          <div style="padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#22c55e;border-bottom:1px solid rgba(34,197,94,.1)">🛡️ Steam Guard (SDA)</div>
          <div style="text-align:center;padding:14px 12px">
            <div id="sgDelivCode" style="font-family:'Share Tech Mono',monospace;font-size:28px;font-weight:900;letter-spacing:5px;color:#22c55e;text-shadow:0 0 16px rgba(34,197,94,.3)">загрузка...</div>
            <div style="margin-top:8px;display:flex;align-items:center;justify-content:center;gap:8px">
              <div style="width:100px;height:3px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden"><div id="sgDelivTimer" style="height:100%;width:100%;background:#22c55e;transition:width 1s linear;border-radius:2px"></div></div>
              <span id="sgDelivSec" style="font-size:10px;color:var(--text-muted)">30s</span>
            </div>
            <button class="btn btn-sm" id="sgDelivCopy" style="margin-top:8px;background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.2);font-weight:700;padding:5px 14px;font-size:11px">📋 Копировать код</button>
          </div>
        </div>` : ''}`;
    } else if (type === 'digital' || type === 'gift') {
      const icon = type === 'gift' ? '🎁' : '🔑';
      const val = del.code || del.key || del.gift_code || del.value || JSON.stringify(del);
      deliveryHtml = `
        <div class="deliv-field-group">
          <div style="padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.05)">${icon} ${type==='gift'?'Гифт-код':'Ключ / Код'}</div>
          <div class="deliv-field-row">
            <div class="deliv-field-value" style="font-size:16px;letter-spacing:2px;flex:1">${escapeHtml(val)}</div>
            <button class="deliv-copy-btn" data-copy="${escapeHtml(val)}">📋 Скопировать</button>
          </div>
        </div>`;
    } else {
      const val = del.description || del.info || del.text || del.value || del.code || JSON.stringify(del);
      deliveryHtml = `
        <div class="deliv-field-group">
          <div style="padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.05)">📦 ${type==='service'?'Услуга':'Товар'}</div>
          <div style="padding:12px 14px;font-size:13px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap">${escapeHtml(val)}</div>
        </div>`;
    }

    // Extra / instruction block
    const extraBlock = extra ? `
      <div class="deliv-extra-label" style="margin-top:12px">📌 Дополнительно</div>
      <div class="deliv-extra">${escapeHtml(extra)}</div>` : '';

    const instrBlock = instruction ? `
      <div class="deliv-extra-label" style="margin-top:12px">📋 Инструкция</div>
      <div class="deliv-extra">${escapeHtml(instruction)}</div>` : '';

    modal(`
      <div style="text-align:center;padding:8px 0 20px">
        <div style="font-size:52px">🎉</div>
        <h2 style="margin:10px 0 4px">${escapeHtml(title)}</h2>
        <p style="color:var(--text-muted);font-size:13px">Покупка завершена — данные ниже</p>
      </div>
      ${deliveryHtml}
      ${extraBlock}${instrBlock}
      <div class="deliv-warn" style="margin-top:12px">⚠️ Сохраните данные — найти их можно в <b>Профиль → История → Покупки</b></div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-primary" style="flex:1" onclick="closeModal()">✅ Сохранил, закрыть</button>
      </div>
    `, {size:'wide'});

    document.querySelectorAll('.deliv-copy-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        navigator.clipboard.writeText(btn.dataset.copy||'').then(()=>toast('Скопировано!','success')));
    });

    // ── Steam Guard in delivery modal ──
    if (del.shared_secret && d.purchase_id) {
      let _sgT = null;
      const _fetchSG = async () => {
        try {
          const r = await api('/api/steam/guard_code', { method:'POST', body:{ purchase_id: d.purchase_id } });
          const el = document.getElementById('sgDelivCode');
          const te = document.getElementById('sgDelivTimer');
          const se = document.getElementById('sgDelivSec');
          if (el) el.textContent = r.code || '—————';
          if (se) se.textContent = (r.remaining||30) + 's';
          if (te) te.style.width = ((r.remaining||30)/30*100) + '%';
          if (_sgT) clearInterval(_sgT);
          let rem = r.remaining || 30;
          _sgT = setInterval(() => {
            rem--;
            if (se) se.textContent = Math.max(0,rem) + 's';
            if (te) te.style.width = Math.max(0,rem/30*100) + '%';
            if (rem <= 0) { clearInterval(_sgT); _fetchSG(); }
          }, 1000);
        } catch(e) {
          const el = document.getElementById('sgDelivCode');
          if (el) el.textContent = 'ОШИБКА';
        }
      };
      _fetchSG();
      document.getElementById('sgDelivCopy')?.addEventListener('click', () => {
        const code = document.getElementById('sgDelivCode')?.textContent || '';
        if (code && code !== 'загрузка...' && code !== 'ОШИБКА') {
          navigator.clipboard.writeText(code).then(() => toast('Steam Guard код скопирован!', 'success'));
        }
      });
    }
  }


  // ── Product description modal ─────────────────────────────────
  function _showProductInfoModal(it) {
    const meta = ITEM_TYPE_META[it.item_type||'other']||ITEM_TYPE_META.other;
    const badgeCls = _badgeCls(it.badge);
    const badgeHtml = it.badge ? `<span class="product-badge ${badgeCls}" style="position:static;font-size:11px">${escapeHtml(it.badge)}</span>` : '';
    const _imgs = Array.isArray(it.images) && it.images.length ? it.images : (it.banner_url ? [it.banner_url] : []);
    let _galIdx = 0;
    const _galId = 'fpGal_' + Date.now();
    const _renderGal = (idx) => {
      const img = document.getElementById(_galId + '_img');
      const dots = document.getElementById(_galId + '_dots');
      if (img) { img.src = _imgs[idx] || ''; _galIdx = idx; }
      if (dots) dots.innerHTML = _imgs.map((_,i) => 
        `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 3px;cursor:pointer;background:${i===idx?'#c084fc':'rgba(255,255,255,0.25)'}" data-gal-dot="${i}"></span>`
      ).join('');
    };
    const bannerHtml = _imgs.length
      ? `<div class="fp-modal-gallery" id="${_galId}">
           <img class="fp-modal-banner" id="${_galId}_img" src="${escapeHtml(_imgs[0])}" alt="${escapeHtml(it.title||'')}">
           ${_imgs.length > 1 ? `
             <button class="fp-gal-btn fp-gal-prev" id="${_galId}_prev">‹</button>
             <button class="fp-gal-btn fp-gal-next" id="${_galId}_next">›</button>
             <div class="fp-gal-dots" id="${_galId}_dots">
               ${_imgs.map((_,i) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 3px;cursor:pointer;background:${i===0?'#c084fc':'rgba(255,255,255,0.25)'}" data-gal-dot="${i}"></span>`).join('')}
             </div>` : ''}
         </div>`
      : `<div class="fp-modal-banner-placeholder"><span style="font-size:60px">${meta.icon}</span></div>`;
    const price = _priceDisplay(it);
    const descHtml = it.description_html
      ? `<div class="fp-modal-desc">${it.description_html.replace(/\n/g, '<br>')}</div>`
      : it.subtitle ? `<div class="fp-modal-desc"><p>${escapeHtml(it.subtitle)}</p></div>` : '';
    const overlay = document.createElement('div');
    overlay.className = 'fp-modal-overlay';
    overlay.id = 'fpModalOverlay';
    overlay.innerHTML = `<div class="fp-modal">
      ${bannerHtml}
      <div class="fp-modal-body">
        <div class="fp-modal-header">
          <div class="fp-modal-title-block">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
              <h2 class="fp-modal-title">${escapeHtml(it.title||'')}</h2>${badgeHtml}
            </div>
            <div class="fp-modal-meta">
              <span class="fp-modal-price">${price}</span>
              <span class="fp-modal-tag" style="background:${meta.color}22;border-color:${meta.color}55;color:${meta.color}">${meta.icon} ${meta.label}</span>
            </div>
          </div>
          <button class="fp-modal-close" id="fpModalClose">×</button>
        </div>
        ${descHtml ? '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.07);margin:16px 0">' + descHtml : ''}
        <div class="fp-modal-footer">
          <button class="btn btn-ghost" onclick="document.getElementById('fpModalOverlay')?.remove()">Закрыть</button>
          <button class="btn btn-primary" id="fpModalBuy">${it.item_type==='special'?'Перейти':'Купить'}</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    if (window._applyI18n) window._applyI18n();
    overlay.addEventListener('click', e => { if (e.target===overlay) overlay.remove(); });
    overlay.querySelector('#fpModalClose')?.addEventListener('click', () => overlay.remove());

    // Gallery navigation
    const _imgs2 = Array.isArray(it.images) && it.images.length ? it.images : (it.banner_url ? [it.banner_url] : []);
    if (_imgs2.length > 1) {
      const galId2 = overlay.querySelector('[id^="fpGal_"]')?.id;
      let galIdx2 = 0;
      const goGal = (dir) => {
        galIdx2 = (galIdx2 + dir + _imgs2.length) % _imgs2.length;
        const img = overlay.querySelector('[id$="_img"]');
        if (img) img.src = _imgs2[galIdx2];
        overlay.querySelectorAll('[data-gal-dot]').forEach(d => {
          d.style.background = parseInt(d.dataset.galDot) === galIdx2 ? '#c084fc' : 'rgba(255,255,255,0.25)';
        });
      };
      overlay.querySelector('[id$="_prev"]')?.addEventListener('click', (e) => { e.stopPropagation(); goGal(-1); });
      overlay.querySelector('[id$="_next"]')?.addEventListener('click', (e) => { e.stopPropagation(); goGal(1); });
      overlay.querySelectorAll('[data-gal-dot]').forEach(d => {
        d.addEventListener('click', (e) => { e.stopPropagation(); goGal(parseInt(d.dataset.galDot) - galIdx2); });
      });
    }
    overlay.querySelector('#fpModalBuy')?.addEventListener('click', () => {
      overlay.remove();
      if (it.item_type==='special') {
        if (it.special_action==='premium') showPremium();
        else if (it.special_action==='case_free') showCaseRoulette('free');
        else if (it.special_action==='case_paid') showCaseRoulette('paid');
        else if (it.special_action==='robux') switchTab('robux');
        else if (it.special_action==='tools') switchTab('tools');
        else if (it.special_action==='topup') showTopUp();
      } else { _shopBuyItem(it.id); }
    });
    document.addEventListener('keydown', function h(e) { if (e.key==='Escape') { overlay.remove(); document.removeEventListener('keydown',h); } });
  }

  // ── Buy item ──────────────────────────────────────────────────
  async function _shopBuyItem(productId) {
    if (!state.user) return showLogin();
    const cfg = state.shopConfig || {};
    const it = (cfg.items||[]).find(i => i.id === productId);
    const title = it?.title || productId;
    const price = it?.price_rub || 0;
    // Show confirmation with discount code
    let _discountCode = '';
    let _discountAmount = 0;
    const confirmed = await new Promise(resolve => {
      modal(`
        <div style="text-align:center;padding:8px 0 12px">
          <div style="font-size:42px;margin-bottom:8px">🛒</div>
          <h2 style="margin:0 0 8px">Подтверждение покупки</h2>
          <p style="color:var(--text-muted);font-size:14px;margin:0">${escapeHtml(title)}</p>
          <div id="buyPriceDisplay" style="font-size:28px;font-weight:800;color:var(--accent-primary);margin:14px 0">${fmtCurrency(price)}</div>
          <div id="buyDiscountInfo" style="display:none;font-size:12px;color:#22c55e;margin:-6px 0 10px"></div>
        </div>
        <div style="display:flex;gap:0;align-items:stretch;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;background:rgba(255,255,255,.02);margin-bottom:14px">
          <input class="form-input" id="buyDiscountInput" placeholder="🏷 Промокод на скидку" style="flex:1;font-size:13px;padding:10px 14px;text-transform:uppercase;border:none;background:transparent;border-radius:0">
          <button class="btn btn-ghost btn-sm" id="buyDiscountApply" style="flex-shrink:0;padding:10px 16px;font-size:12px;border-radius:0;border-left:1px solid rgba(255,255,255,.08);font-weight:600;color:var(--accent-tertiary)">Применить</button>
        </div>
        <p style="color:var(--text-muted);font-size:11px;margin:0 0 14px;text-align:center">Средства списываются с баланса</p>
        <div style="display:flex;gap:10px">
          <button class="btn btn-primary" style="flex:1;padding:14px" id="confirmBuyYes">Купить</button>
          <button class="btn btn-ghost" style="flex:1" id="confirmBuyNo">Отмена</button>
        </div>
      `);
      // Discount apply - use setTimeout to ensure DOM is ready
      setTimeout(() => {
        document.getElementById('buyDiscountApply')?.addEventListener('click', async () => {
          const code = (document.getElementById('buyDiscountInput')?.value||'').trim().toUpperCase();
          if (!code) { toast('Введите промокод', 'warning'); return; }
          try {
            const r = await api('/api/discount/validate', { method:'POST', body:{ code, order_type:'shop', amount:price }});
            _discountCode = code;
            _discountAmount = r.discount_amount || 0;
            const newPrice = Math.max(0, price - _discountAmount);
            document.getElementById('buyPriceDisplay').innerHTML = `<s style="font-size:18px;color:var(--text-muted);font-weight:400">${fmtCurrency(price)}</s> ${fmtCurrency(newPrice)}`;
            document.getElementById('buyDiscountInfo').style.display = 'block';
            document.getElementById('buyDiscountInfo').textContent = `✅ Скидка ${r.display || ('-' + _discountAmount + '₽')} применена!`;
            toast('Промокод применён!', 'success');
          } catch(e) { toast(e.message || 'Промокод недействителен', 'error'); _discountCode = ''; _discountAmount = 0; }
        });
        document.getElementById('buyDiscountInput')?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); document.getElementById('buyDiscountApply')?.click(); }
        });
      }, 50);
      document.getElementById('confirmBuyYes')?.addEventListener('click', () => { closeModal(); resolve(true); });
      document.getElementById('confirmBuyNo')?.addEventListener('click', () => { closeModal(); resolve(false); });
    });
    if (!confirmed) return;
    try {
      loading(true);
      const body = {};
      if (_discountCode) body.discount_code = _discountCode;
      const d = await api('/api/shop/buy/'+encodeURIComponent(productId), { method:'POST', body });
      if (state.user && typeof d.new_balance === 'number') {
        _applyBalance(d.new_balance);
      } else {
        await refreshUserState();
      }
      if (d.out_of_stock) {
        const cfg2 = state.adminShopDraft || state.shopConfig;
        if (cfg2) {
          const it2 = (cfg2.items||[]).find(i => i.id === productId);
          if (it2) { it2.out_of_stock = true; renderShop(); }
        }
      }
      setTimeout(() => loadShopConfig().then(() => renderShop()).catch(()=>{}), 500);
      _shopDeliveryModal(d);
    } catch(e) { toast(e.message||'Ошибка покупки', 'error'); }
    finally { loading(false); }
  }

  // ── Shop Editor ───────────────────────────────────────────────
  function _shopDraftEnsure() {
    if (!state.adminShopDraft) {
      state.adminShopDraft = JSON.parse(JSON.stringify(state.shopConfig||{categories:[],items:[]}));
    }
    return state.adminShopDraft;
  }

  function _shopAddCat() {
    const cfg = _shopDraftEnsure();
    const newCat = { id:'cat_'+Date.now(), title:'Новая категория', sort:((cfg.categories||[]).length+1)*10, visible:true, banner_url:'' };
    cfg.categories = cfg.categories||[];
    cfg.categories.push(newCat);
    state._shopActiveTopCat = newCat.id;
    state._shopActiveCat = newCat.id;
    _shopEditCat(newCat.id);
  }

  function _shopEditCat(catId) {
    const cfg = _shopDraftEnsure();
    const cat = (cfg.categories||[]).find(c=>c.id===catId);
    if (!cat) return;
    // Build parent options: only top-level cats (no parent_id) can be parents, excluding self
    const topCats = (cfg.categories||[]).filter(c => !c.parent_id && c.id !== catId);
    const parentOpts = `<option value="">— Корневая категория —</option>` +
      topCats.map(c => `<option value="${escapeHtml(c.id)}" ${c.id===cat.parent_id?'selected':''}>${escapeHtml(c.title)}</option>`).join('');
    modal(`
      <h2 style="margin:0 0 20px;font-size:18px">✏️ ${cat.parent_id ? 'Подкатегория' : 'Категория'}</h2>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div><label class="form-label">Название</label><input class="form-input" id="scat_title" value="${escapeHtml(cat.title||'')}"></div>
        <div><label class="form-label">Родительская категория</label><select class="form-input" id="scat_parent">${parentOpts}</select></div>
        <div><label class="form-label">URL баннера (опционально)</label><input class="form-input" id="scat_banner" value="${escapeHtml(cat.banner_url||'')}"></div>
        <div><label class="form-label">Порядок</label><input class="form-input" id="scat_sort" type="number" value="${cat.sort||10}"></div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="scat_vis" ${cat.visible!==false?'checked':''}>Показывать</label>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <button class="btn btn-primary" style="flex:1" id="scatSave">💾 Сохранить</button>
        <button class="btn btn-ghost btn-sm" style="color:#ef4444" id="scatDel">🗑 Удалить</button>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Отмена</button>
      </div>
    `);
    document.getElementById('scatSave')?.addEventListener('click', () => {
      cat.title = document.getElementById('scat_title')?.value?.trim()||cat.title;
      cat.parent_id = document.getElementById('scat_parent')?.value || '';
      if (!cat.parent_id) delete cat.parent_id; // Remove empty parent_id
      cat.banner_url = document.getElementById('scat_banner')?.value?.trim()||'';
      cat.sort = parseInt(document.getElementById('scat_sort')?.value)||cat.sort;
      cat.visible = document.getElementById('scat_vis')?.checked!==false;
      closeModal(); renderShop();
      _shopAutoSave();
    });
    document.getElementById('scatDel')?.addEventListener('click', () => {
      const isParent = !cat.parent_id;
      const childCats = isParent ? (cfg.categories||[]).filter(c => c.parent_id === catId).map(c => c.id) : [];
      const msg = isParent && childCats.length
        ? `Удалить категорию, ${childCats.length} подкатегорий и все их товары?`
        : 'Удалить категорию и все её товары?';
      if (!confirm(msg)) return;
      // Remove this cat + child subcats
      const removeIds = [catId, ...childCats];
      cfg.categories = (cfg.categories||[]).filter(c => !removeIds.includes(c.id));
      cfg.items = (cfg.items||[]).filter(i => !removeIds.includes(i.category_id));
      state._shopActiveCat = null;
      state._shopActiveTopCat = (cfg.categories||[])[0]?.id || '';
      closeModal(); renderShop();
      _shopAutoSave();
    });
  }

  function _shopAddItem(catId) {
    const cfg = _shopDraftEnsure();
    const newIt = { id:'item_'+Date.now(), title:'Новый товар', subtitle:'Описание', price_rub:0, badge:'', category_id:catId, banner_url:'', visible:true, sort:((cfg.items||[]).filter(i=>i.category_id===catId).length+1)*10, item_type:'digital', description_html:'' };
    cfg.items = cfg.items||[];
    cfg.items.push(newIt);
    _shopEditItem(newIt.id);
  }

  function _shopEditItem(itemId) {
    const cfg = _shopDraftEnsure();
    const it = (cfg.items||[]).find(i=>i.id===itemId);
    if (!it) return;
    const allCats = (cfg.categories||[]).sort((a,b) => (a.sort||0)-(b.sort||0));
    const topCatsForDropdown = allCats.filter(c => !c.parent_id);
    let catOptsHtml = '';
    for (const tc of topCatsForDropdown) {
      catOptsHtml += `<option value="${escapeHtml(tc.id)}" ${tc.id===it.category_id?'selected':''}>${escapeHtml(tc.title)}</option>`;
      const subs = allCats.filter(c => c.parent_id === tc.id);
      for (const sc of subs) {
        catOptsHtml += `<option value="${escapeHtml(sc.id)}" ${sc.id===it.category_id?'selected':''}>⠀↳ ${escapeHtml(sc.title)}</option>`;
      }
    }
    const cats = catOptsHtml;
    const types = [['account','👤 Аккаунт (логин+пароль)'],['digital','🔑 Ключи / Код'],['service','🛠 Услуга'],['gift','🎁 Гифт'],['other','📦 Прочее'],['special','⚡ Встроенная функция']];
    const typeOpts = types.map(([v,l])=>`<option value="${v}" ${v===it.item_type?'selected':''}>${l}</option>`).join('');
    const specOpts = ['premium','case_free','case_paid','case_money','robux','tools','topup'].map(a=>`<option value="${a}" ${a===it.special_action?'selected':''}>${a}</option>`).join('');
    modal(`
      <h2 style="margin:0 0 16px;font-size:18px">✏️ Товар</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><label class="form-label">Название</label><input class="form-input" id="sit_title" value="${escapeHtml(it.title||'')}"></div>
        <div><label class="form-label">Категория</label><select class="form-input" id="sit_cat">${cats}</select></div>
        <div><label class="form-label">Тип товара</label><select class="form-input" id="sit_type">${typeOpts}</select></div>
        <div><label class="form-label">Цена (₽)</label><input class="form-input" id="sit_price" type="number" min="0" value="${Number(it.price_rub)||0}"></div>
        <div><label class="form-label">Бейдж</label><input class="form-input" id="sit_badge" value="${escapeHtml(it.badge||'')}" placeholder="ХИТ, NEW, FREE..."></div>
        <div style="grid-column:1/-1">
          <label class="form-label">📸 Фото товара (до 15 шт.)</label>
          <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap" id="sit_img_preview"></div>
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <label class="btn btn-secondary" style="cursor:pointer;flex:1;text-align:center;padding:10px">
              📁 Загрузить с устройства
              <input type="file" id="sit_upload" accept="image/*" multiple style="display:none">
            </label>
          </div>
          <div style="position:relative">
            <textarea class="form-input" id="sit_images" rows="3" placeholder="или вставьте URL изображений по одному в строку..." style="font-size:12px;font-family:monospace;resize:vertical">${escapeHtml((Array.isArray(it.images)&&it.images.length?it.images:it.banner_url?[it.banner_url]:[]).join('\n'))}</textarea>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Первое фото — главное для карточки. Максимум 15.</div>
        </div>
      </div>
      <div id="sit_specRow" style="display:${it.item_type==='special'?'block':'none'};margin-bottom:10px">
        <label class="form-label">⚡ Встроенная функция</label>
        <select class="form-input" id="sit_spec">${specOpts}</select>
        <div class="form-hint" style="font-size:11px;color:var(--text-muted);margin-top:4px">Товар откроет встроенную страницу сайта вместо инвентарной доставки</div>
      </div>
      <div style="margin-bottom:10px"><label class="form-label">Краткое описание (subtitle)</label><input class="form-input" id="sit_sub" value="${escapeHtml(it.subtitle||'')}"></div>
      <div style="margin-bottom:10px"><label class="form-label">Полное описание (HTML, можно с тегами)</label>
        <textarea class="form-input" id="sit_desc" rows="3" style="font-family:monospace;font-size:12px;resize:vertical">${escapeHtml(it.description_html||'')}</textarea>
      </div>
      <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="sit_vis" ${it.visible!==false?'checked':''}>Показывать</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="sit_feat" ${it.featured?'checked':''}>Хит (featured)</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer" title="Один товар на складе — покупают бесконечно (ссылка, гайд и т.д.)"><input type="checkbox" id="sit_unlimited" ${it.unlimited?'checked':''}>♾ Безлимитный</label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" style="flex:1;min-width:100px" id="sitSave">💾 Сохранить</button>
        <button class="btn btn-ghost btn-sm" id="sitInv">📦 Склад</button>
        <button class="btn btn-ghost btn-sm" id="sitVou">🎁 Ваучеры</button>
        <button class="btn btn-ghost btn-sm" style="color:#ef4444" id="sitDel">🗑</button>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Отмена</button>
      </div>
    `, {size:'wide'});
    document.getElementById('sit_type')?.addEventListener('change', e => {
      document.getElementById('sit_specRow').style.display = e.target.value==='special' ? '' : 'none';
    });
    // Image preview render
    const _renderImgPreview = () => {
      const prev = document.getElementById('sit_img_preview');
      if (!prev) return;
      const ta = document.getElementById('sit_images');
      const urls = (ta?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
      prev.innerHTML = urls.slice(0,15).map((url,i) => `
        <div style="position:relative;flex-shrink:0">
          <img src="${escapeHtml(url)}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,0.12)" onerror="this.style.background='rgba(255,255,255,0.05)';this.src=''">
          ${i===0?'<div style="position:absolute;bottom:2px;left:2px;background:var(--accent-primary);color:#fff;font-size:8px;padding:1px 4px;border-radius:4px">Главное</div>':''}
          <button onclick="this.closest('[style]').remove();_refreshImgTA()" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#ef4444;border:none;color:#fff;font-size:10px;cursor:pointer;line-height:1;padding:0" data-url="${escapeHtml(url)}">×</button>
        </div>`).join('');
      // wire remove buttons
      prev.querySelectorAll('[data-url]').forEach(btn => {
        btn.addEventListener('click', () => {
          const ta = document.getElementById('sit_images');
          if (ta) {
            const lines = ta.value.split('\n').map(s=>s.trim()).filter(s=>s && s!==btn.dataset.url);
            ta.value = lines.join('\n');
            _renderImgPreview();
          }
        });
      });
    };
    window._refreshImgTA = _renderImgPreview;
    document.getElementById('sit_images')?.addEventListener('input', _renderImgPreview);
    _renderImgPreview();

    // Image upload handler (supports multiple files)
    document.getElementById('sit_upload')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const ta = document.getElementById('sit_images');
      const existing = (ta?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
      let uploaded = 0;
      for (const file of files) {
        if (existing.length >= 15) { toast('Максимум 15 фотографий', 'warning'); break; }
        try {
          loading(true);
          const fd = new FormData();
          fd.append('file', file);
          const r = await fetch('/api/admin/upload_banner', { method:'POST', body:fd, credentials:'include' });
          const j = await r.json();
          if (!r.ok || !j?.ok) throw new Error(j?.detail || 'Ошибка загрузки');
          existing.push(j.url);
          uploaded++;
        } catch(err) { toast(err.message || 'Ошибка загрузки', 'error'); break; }
        finally { loading(false); }
      }
      if (ta) ta.value = existing.join('\n');
      if (uploaded > 0) { toast(`✅ Загружено ${uploaded} фото`, 'success'); _renderImgPreview(); }
      e.target.value = '';
    });
    document.getElementById('sitSave')?.addEventListener('click', () => {
      it.title = document.getElementById('sit_title')?.value?.trim()||it.title;
      it.category_id = document.getElementById('sit_cat')?.value||it.category_id;
      it.item_type = document.getElementById('sit_type')?.value||'digital';
      it.price_rub = parseFloat(document.getElementById('sit_price')?.value)||0;
      it.badge = document.getElementById('sit_badge')?.value?.trim()||'';
      const _rawImgs = (document.getElementById('sit_images')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,15);
      it.images = _rawImgs;
      it.banner_url = _rawImgs[0] || '';  // compat
      it.subtitle = document.getElementById('sit_sub')?.value?.trim()||'';
      it.description_html = document.getElementById('sit_desc')?.value?.trim()||'';
      it.visible = document.getElementById('sit_vis')?.checked!==false;
      it.featured = !!document.getElementById('sit_feat')?.checked;
      it.unlimited = !!document.getElementById('sit_unlimited')?.checked;
      if (it.item_type==='special') it.special_action = document.getElementById('sit_spec')?.value||'';
      closeModal(); renderShop();
      // Auto-save to server
      _shopAutoSave();
    });
    // Helper: save current form state before navigating away
    function _sitSaveState() {
      it.title = document.getElementById('sit_title')?.value?.trim()||it.title;
      it.category_id = document.getElementById('sit_cat')?.value||it.category_id;
      it.item_type = document.getElementById('sit_type')?.value||'digital';
      it.price_rub = parseFloat(document.getElementById('sit_price')?.value)||0;
      it.badge = document.getElementById('sit_badge')?.value?.trim()||'';
      const _rawImgs = (document.getElementById('sit_images')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,15);
      it.images = _rawImgs;
      it.banner_url = _rawImgs[0]||'';
      it.subtitle = document.getElementById('sit_sub')?.value?.trim()||'';
      it.description_html = document.getElementById('sit_desc')?.value?.trim()||'';
      it.visible = document.getElementById('sit_vis')?.checked!==false;
      it.featured = !!document.getElementById('sit_feat')?.checked;
      it.unlimited = !!document.getElementById('sit_unlimited')?.checked;
      if (it.item_type==='special') it.special_action = document.getElementById('sit_spec')?.value||'';
      _shopAutoSave(); // auto-save to server
    }

    document.getElementById('sitInv')?.addEventListener('click', () => { _sitSaveState(); closeModal(); _shopInventoryModal(it.id); });
    document.getElementById('sitVou')?.addEventListener('click', () => { _sitSaveState(); closeModal(); _shopVouchersModal(it.id, it.title); });
    document.getElementById('sitDel')?.addEventListener('click', () => {
      if (!confirm('Удалить товар?')) return;
      cfg.items = (cfg.items||[]).filter(i=>i.id!==itemId);
      closeModal(); renderShop();
      _shopAutoSave();
    });
  }

  async function _shopInventoryModal(productId) {
    modal(`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <button class="btn btn-ghost btn-sm" id="invBackToEdit" style="padding:6px 12px;flex-shrink:0">← К товару</button>
        <h2 style="margin:0;font-size:18px;flex:1">📦 Склад — ${escapeHtml(productId)}</h2>
      </div>
      <div id="invBody"><div class="spinner"></div></div>
    `, {size:'wide'});
    document.getElementById('invBackToEdit')?.addEventListener('click', () => {
      // Don't close/reopen - directly call edit which replaces modal content
      if (!state.shopEditorMode) state.shopEditorMode = true;
      _shopDraftEnsure();
      _shopEditItem(productId);
    });
    try {
      const d = await api('/api/admin/shop/inventory/'+encodeURIComponent(productId));
      const body = document.getElementById('invBody'); if (!body) return;
      const items = d.items||[];

      // Determine product type to show right form
      const cfg = state.adminShopDraft || state.shopConfig || {};
      const item = (cfg.items||[]).find(i => i.id === productId) || {};
      const defaultType = item.item_type || 'digital';

      body.innerHTML = `
        <div style="margin-bottom:16px;padding:16px;background:rgba(255,255,255,0.03);border-radius:12px;border:1px solid rgba(255,255,255,0.07)">
          <div style="font-weight:700;font-size:14px;margin-bottom:12px">➕ Добавить позицию</div>
          <select class="form-input" id="invType" style="margin-bottom:12px">
            <option value="account" ${defaultType==='account'?'selected':''}>👤 Аккаунт</option>
            <option value="digital" ${defaultType==='digital'?'selected':''}>🔑 Цифровой ключ / код</option>
            <option value="gift" ${defaultType==='gift'?'selected':''}>🎁 Гифт-код</option>
            <option value="service" ${defaultType==='service'?'selected':''}>🛠 Услуга</option>
          </select>

          <!-- Форма для аккаунта -->
          <div id="invFormAccount">
            <div class="grid-2" style="gap:8px;margin-bottom:8px">
              <div><label class="form-label" style="font-size:11px">Логин</label><input class="form-input" id="invLogin" placeholder="username" autocomplete="off"></div>
              <div><label class="form-label" style="font-size:11px">Пароль</label><input class="form-input" id="invPass" placeholder="password" autocomplete="off"></div>
            </div>
            <div style="margin-bottom:8px"><label class="form-label" style="font-size:11px">Email (если есть)</label><input class="form-input" id="invEmail" placeholder="account@example.com" autocomplete="off"></div>
            <details style="margin-bottom:8px;border:1px solid rgba(124,58,237,.15);border-radius:10px;padding:0;background:rgba(124,58,237,.03)">
              <summary style="padding:10px 14px;cursor:pointer;font-size:12px;font-weight:600;color:var(--accent-tertiary);user-select:none;list-style:none;display:flex;align-items:center;gap:6px">
                <span style="font-size:14px">🛡️</span> Steam Guard (SDA)
                <span style="margin-left:auto;font-size:10px;color:var(--text-muted)">опционально</span>
              </summary>
              <div style="padding:0 14px 12px">
                <div style="margin-bottom:8px"><label class="form-label" style="font-size:11px">shared_secret (Base64)</label><input class="form-input" id="invSharedSecret" placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxx=" autocomplete="off" style="font-family:monospace;font-size:12px"></div>
                <div style="margin-bottom:6px"><label class="form-label" style="font-size:11px">identity_secret (Base64)</label><input class="form-input" id="invIdentitySecret" placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxx=" autocomplete="off" style="font-family:monospace;font-size:12px"></div>
                <div style="font-size:10px;color:var(--text-muted);line-height:1.5;margin-bottom:8px">Из maFiles SDA. Покупатель сможет генерировать Steam Guard коды прямо на сайте.</div>
                <button class="btn btn-sm btn-ghost" id="invImportMaFile" style="width:100%;font-size:11px;padding:6px;border:1px dashed rgba(124,58,237,.2)">📁 Импорт из .maFile (JSON)</button>
              </div>
            </details>
            <div><label class="form-label" style="font-size:11px">📌 Дополнительно (инструкции, примечания)</label><textarea class="form-input" id="invExtra" rows="2" placeholder="Например: подключён к Xbox, пин-код почты: 1234, инструкция по использованию..." style="resize:vertical;font-size:13px"></textarea></div>
          </div>

          <!-- Форма для ключей/кодов -->
          <div id="invFormDigital" style="display:none">
            <div><label class="form-label" style="font-size:11px">Ключ / Код (по одному в строке для массового добавления)</label>
            <textarea class="form-input" id="invKeys" rows="4" placeholder="XXXX-XXXX-XXXX&#10;YYYY-YYYY-YYYY" style="font-family:monospace;font-size:12px;resize:vertical"></textarea></div>
            <div style="margin-top:8px"><label class="form-label" style="font-size:11px">📌 Инструкция / Примечание (общее для всех ключей)</label>
            <textarea class="form-input" id="invExtraDigital" rows="2" placeholder="Как активировать: перейди на..." style="resize:vertical;font-size:13px"></textarea></div>
          </div>

          <!-- Форма для услуги -->
          <div id="invFormService" style="display:none">
            <div><label class="form-label" style="font-size:11px">Описание услуги / Инструкция</label>
            <textarea class="form-input" id="invServiceDesc" rows="4" placeholder="Что включено и как получить услугу..." style="resize:vertical;font-size:13px"></textarea></div>
          </div>

          <button class="btn btn-primary" id="invAddBtn" style="margin-top:12px;width:100%">➕ Добавить</button>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-weight:700;font-size:13px">Позиции: <span style="color:var(--success)">${d.available||0}</span> свободно из ${d.total||0}</div>
        </div>
        ${items.length ? `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:12px;color:var(--text-muted)">
              <label style="cursor:pointer;display:flex;align-items:center;gap:6px">
                <input type="checkbox" id="invSelectAll"> Выбрать все свободные
              </label>
            </div>
            <button id="invMassDelete" class="btn btn-danger btn-xs" style="display:none">🗑 Удалить выбранные</button>
          </div>
          <div style="max-height:280px;overflow-y:auto;border:1px solid rgba(255,255,255,0.07);border-radius:10px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:rgba(255,255,255,0.04);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);position:sticky;top:0">
              <th style="padding:8px 6px;width:32px"></th><th style="padding:8px 10px;text-align:left">#</th><th style="padding:8px 10px;text-align:left">Предпросмотр</th><th style="padding:8px 10px;text-align:left">Статус</th><th style="padding:8px 6px;width:36px"></th>
            </tr></thead>
            <tbody>${items.map(r=>`<tr style="border-top:1px solid rgba(255,255,255,0.05);${r.sold?'opacity:0.55':''}" data-inv-row="${r.id}">
              <td style="padding:6px 6px;text-align:center">${!r.sold?`<input type="checkbox" class="inv-chk" data-inv-id="${r.id}" style="accent-color:var(--accent-primary)">`:''}</td>
              <td style="padding:6px 10px;color:var(--text-muted);font-size:11px">#${r.id}</td>
              <td style="padding:6px 10px;font-family:monospace;font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)">${escapeHtml(r.preview||'—')}</td>
              <td style="padding:6px 10px;font-size:11px;font-weight:700">
                ${r.sold
                  ? `<div style="display:flex;flex-direction:column;gap:2px"><span style="color:#ef4444;background:#ef444420;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:700">🔴 ПРОДАН</span>${r.sold_at?`<span style="font-size:10px;color:var(--text-muted)">${String(r.sold_at||'').slice(0,10)}</span>`:''}</div>`
                  : '<span style="color:#22c55e;background:#22c55e20;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:700">🟢 Свободен</span>'}
              </td>
              <td style="padding:6px 6px;text-align:center">${!r.sold?`<button class="btn btn-ghost btn-xs" data-del-inv="${r.id}" style="color:#ef4444;font-size:11px;padding:2px 6px">🗑</button>`:''}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : '<div style="text-align:center;padding:30px;color:var(--text-muted)"><div style="font-size:28px;margin-bottom:8px">📭</div>Склад пуст</div>'}
      `;

      // Show/hide form sections based on type
      const updateForm = () => {
        const type = body.querySelector('#invType')?.value || 'digital';
        body.querySelector('#invFormAccount').style.display = type==='account' ? '' : 'none';
        body.querySelector('#invFormDigital').style.display = (type==='digital'||type==='gift') ? '' : 'none';
        body.querySelector('#invFormService').style.display = type==='service' ? '' : 'none';
      };
      updateForm();
      body.querySelector('#invType')?.addEventListener('change', updateForm);

      // maFile JSON import
      body.querySelector('#invImportMaFile')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.maFile,.json';
        input.onchange = (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = (ev) => {
            try {
              const data = JSON.parse(ev.target.result);
              if (data.shared_secret) {
                const ss = body.querySelector('#invSharedSecret');
                if (ss) ss.value = data.shared_secret;
              }
              if (data.identity_secret) {
                const is = body.querySelector('#invIdentitySecret');
                if (is) is.value = data.identity_secret;
              }
              if (data.account_name) {
                const lg = body.querySelector('#invLogin');
                if (lg && !lg.value) lg.value = data.account_name;
              }
              // Store full maFile data for Session, device_id etc.
              body._maFileData = data;
              const parts = [];
              if (data.Session?.SteamID) parts.push('SteamID');
              if (data.Session?.SteamLoginSecure) parts.push('Session');
              if (data.device_id) parts.push('DeviceID');
              toast('✅ maFile импортирован' + (parts.length ? ' ('+parts.join(', ')+')' : ''), 'success');
            } catch(err) {
              toast('Ошибка парсинга JSON: ' + err.message, 'error');
            }
          };
          reader.readAsText(file);
        };
        input.click();
      });

      body.querySelector('#invAddBtn')?.addEventListener('click', async () => {
        const type = body.querySelector('#invType')?.value||'digital';
        let payload = { product_id: productId, item_type: type };

        if (type === 'account') {
          const login = body.querySelector('#invLogin')?.value?.trim();
          const pass = body.querySelector('#invPass')?.value?.trim();
          const email = body.querySelector('#invEmail')?.value?.trim();
          const extra = body.querySelector('#invExtra')?.value?.trim();
          const sharedSecret = body.querySelector('#invSharedSecret')?.value?.trim();
          const identitySecret = body.querySelector('#invIdentitySecret')?.value?.trim();
          if (!login || !pass) return toast('Логин и пароль обязательны', 'warning');
          const item = { login, password: pass };
          if (email) item.email = email;
          if (extra) item.extra = extra;
          if (sharedSecret) item.shared_secret = sharedSecret;
          if (identitySecret) item.identity_secret = identitySecret;
          // Include full Session data from maFile import
          if (body._maFileData) {
            if (body._maFileData.Session) item.Session = body._maFileData.Session;
            if (body._maFileData.device_id) item.device_id = body._maFileData.device_id;
            if (body._maFileData.serial_number) item.serial_number = body._maFileData.serial_number;
            if (body._maFileData.revocation_code) item.revocation_code = body._maFileData.revocation_code;
            if (body._maFileData.uri) item.uri = body._maFileData.uri;
            if (body._maFileData.server_time) item.server_time = body._maFileData.server_time;
            if (body._maFileData.token_gid) item.token_gid = body._maFileData.token_gid;
            if (body._maFileData.steam_id) item.steam_id = body._maFileData.steam_id;
          }
          payload.items = [item];
        } else if (type === 'digital' || type === 'gift') {
          const keys = (body.querySelector('#invKeys')?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
          const extra = body.querySelector('#invExtraDigital')?.value?.trim();
          if (!keys.length) return toast('Введите хотя бы один ключ', 'warning');
          payload.items = keys.map(k => ({ code: k, extra: extra||undefined }));
        } else {
          const desc = body.querySelector('#invServiceDesc')?.value?.trim();
          if (!desc) return toast('Введите описание', 'warning');
          payload.items = [{ description: desc }];
        }

        try {
          loading(true);
          await api('/api/admin/shop/inventory/add', { method:'POST', body: payload });
          toast(`✅ Добавлено ${payload.items.length} позиций`, 'success');
          // Reload config to pick up cleared out_of_stock flag
          await loadShopConfig();
          if (state.adminShopDraft) {
            const freshCfg = state.shopConfig || {};
            // Sync out_of_stock from fresh config into draft
            (freshCfg.items||[]).forEach(fi => {
              const di = (state.adminShopDraft.items||[]).find(i => i.id === fi.id);
              if (di) { delete di.out_of_stock; if (fi.out_of_stock) di.out_of_stock = true; }
            });
          }
          renderShop(); // Refresh the shop grid immediately
          closeModal();
          _shopInventoryModal(productId);
        } catch(e) { toast(e.message, 'error'); }
        finally { loading(false); }
      });

      body.querySelectorAll('[data-del-inv]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Удалить позицию?')) return;
          try {
            await api('/api/admin/shop/inventory/'+btn.dataset.delInv, { method:'DELETE', body:{} });
            btn.closest('tr')?.remove();
            toast('Удалено', 'success');
          } catch(e) { toast(e.message, 'error'); }
        });
      });

      // Mass delete: checkbox logic
      const selectAll = body.querySelector('#invSelectAll');
      const massDeleteBtn = body.querySelector('#invMassDelete');
      const updateMassBtn = () => {
        const checked = body.querySelectorAll('.inv-chk:checked').length;
        if (massDeleteBtn) massDeleteBtn.style.display = checked > 0 ? 'inline-flex' : 'none';
        if (massDeleteBtn) massDeleteBtn.textContent = `🗑 Удалить (${checked})`;
      };
      selectAll?.addEventListener('change', () => {
        body.querySelectorAll('.inv-chk').forEach(c => { c.checked = selectAll.checked; });
        updateMassBtn();
      });
      body.querySelectorAll('.inv-chk').forEach(c => c.addEventListener('change', updateMassBtn));
      massDeleteBtn?.addEventListener('click', async () => {
        const ids = [...body.querySelectorAll('.inv-chk:checked')].map(c => parseInt(c.dataset.invId));
        if (!ids.length) return;
        if (!confirm(`Удалить ${ids.length} позиций? Это действие необратимо.`)) return;
        try {
          loading(true);
          let deleted = 0;
          for (const id of ids) {
            try {
              await api('/api/admin/shop/inventory/'+id, { method:'DELETE', body:{} });
              body.querySelector(`[data-inv-row="${id}"]`)?.remove();
              deleted++;
            } catch(e) {}
          }
          toast(`✅ Удалено ${deleted} позиций`, 'success');
          updateMassBtn();
          if (selectAll) selectAll.checked = false;
        } finally { loading(false); }
      });
    } catch(e) { const b=document.getElementById('invBody'); if(b) b.innerHTML=`<div style="color:#ef4444;padding:20px;text-align:center">${escapeHtml(e.message)}</div>`; }
  }

  async function _shopVouchersModal(productId, productTitle) {
    modal(`<h2 style="margin:0 0 16px;font-size:18px">🎁 Ваучеры — ${escapeHtml(productTitle||productId)}</h2><div id="vouBody"><div class="spinner"></div></div>`, {size:'wide'});
    const load = async () => {
      const d = await api('/api/admin/shop/vouchers?product_id='+encodeURIComponent(productId));
      const vs = d.vouchers||[];
      const body = document.getElementById('vouBody'); if (!body) return;
      body.innerHTML = `
        <div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.07)">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px">Создать ваучер</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div style="flex:1;min-width:100px"><label class="form-label">Использований</label><input class="form-input" id="vouUses" type="number" min="1" value="1"></div>
            <div style="flex:2;min-width:140px"><label class="form-label">Заметка</label><input class="form-input" id="vouNote" placeholder="Для кого?"></div>
          </div>
          <button class="btn btn-primary btn-sm" id="vouCreate" style="margin-top:8px">✨ Создать</button>
        </div>
        ${vs.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid rgba(255,255,255,0.07);border-radius:8px;overflow:hidden">
          <thead><tr style="background:rgba(255,255,255,0.04)"><th style="padding:8px 10px;text-align:left">Код</th><th style="padding:8px 10px;text-align:left">Исп.</th><th style="padding:8px 10px;text-align:left">Заметка</th><th style="padding:8px 10px"></th></tr></thead>
          <tbody>${vs.map(v=>`<tr style="border-top:1px solid rgba(255,255,255,0.05)">
            <td style="padding:6px 10px"><code style="color:var(--accent-tertiary);letter-spacing:1px">${escapeHtml(v.code)}</code></td>
            <td style="padding:6px 10px;color:${v.uses_left>0?'#22c55e':'#ef4444'}">${v.uses_left}/${v.uses_total||1}</td>
            <td style="padding:6px 10px;color:var(--text-muted)">${escapeHtml(v.note||'—')}</td>
            <td style="padding:6px 10px;display:flex;gap:6px">
              <button class="btn btn-ghost btn-xs" data-copy-v="${escapeHtml(location.origin+'/v/'+v.code)}">📋</button>
              <button class="btn btn-ghost btn-xs" data-del-v="${v.id}" style="color:#ef4444">🗑</button>
            </td></tr>`).join('')}</tbody>
        </table>` : '<p style="color:var(--text-muted);text-align:center;padding:16px">Ваучеров нет</p>'}
      `;
      body.querySelector('#vouCreate')?.addEventListener('click', async () => {
        const uses = parseInt(body.querySelector('#vouUses')?.value)||1;
        const note = body.querySelector('#vouNote')?.value?.trim()||'';
        try { loading(true); const r=await api('/api/admin/shop/voucher/create',{method:'POST',body:{product_id:productId,uses_total:uses,note}}); toast(`Ваучер: ${r.code}`,'success'); load(); }
        catch(e){ toast(e.message,'error'); } finally{ loading(false); }
      });
      body.querySelectorAll('[data-copy-v]').forEach(btn=>btn.addEventListener('click',()=>navigator.clipboard.writeText(btn.dataset.copyV||'').then(()=>toast('Скопировано!','success'))));
      body.querySelectorAll('[data-del-v]').forEach(btn=>btn.addEventListener('click',async()=>{
        if(!confirm('Удалить?'))return;
        await api('/api/admin/shop/voucher/'+btn.dataset.delV,{method:'DELETE',body:{}});
        btn.closest('tr')?.remove(); toast('Удалён','success');
      }));
    };
    try { await load(); } catch(e){ const b=document.getElementById('vouBody'); if(b) b.innerHTML=`<p style="color:#ef4444">${escapeHtml(e.message)}</p>`; }
  }


  // ── Auto-save shop config ──────────────────────────────────────
  async function _shopAutoSave() {
    if (!state.adminShopDraft) return;
    // Debounce: cancel pending saves
    if (_shopAutoSave._timer) clearTimeout(_shopAutoSave._timer);
    _shopAutoSave._timer = setTimeout(async () => {
      try {
        await api('/api/admin/shop_config', { method: 'POST', body: { config: state.adminShopDraft } });
        state.shopConfig = JSON.parse(JSON.stringify(state.adminShopDraft));
        toast('💾 Сохранено!', 'success');
      } catch(e) {
        toast('❌ Ошибка сохранения: ' + (e.message||'Проверьте соединение'), 'error');
      }
    }, 300);
  }

  function initShopTabs() { /* tabs now rendered by renderShop() */ }


  function initTools() {
    // Tool page navigation
    document.querySelectorAll('[data-tool-page]').forEach(btn => {
      btn.addEventListener('click', () => _toolSwitchPage(btn.dataset.toolPage));
    });
    document.querySelectorAll('[data-goto-tool]').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); _toolSwitchPage(el.dataset.gotoTool); });
    });

    // Legacy tool button support
    document.querySelectorAll('[data-tool]:not(.disabled)').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const id = el.getAttribute('data-tool');
        if (!state.user) return showLogin();
        if (id === 'desc-gen' || id === 'generator') _toolSwitchPage('descgen');
        else if (id === 'ai-chat' || id === 'chat') _toolSwitchPage('aichat');
        else if (id === 'roblox-checker' || id === 'checker') _toolSwitchPage('checker');
      });
    });

    // Mass Checker
    _initChecker();
    // Single Checker
    _initSingleChecker();
    // DescGen
    _initDescGen();
    // AI Chat
    _initAiChat();
    // Proxy Checker
    _initProxyChecker();
    // Checker mode toggle buttons
    document.querySelectorAll('.checker-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => _setCheckerMode(btn.dataset.checkerMode));
    });
  }

  function _toolSwitchPage(pageId, checkerMode) {
    // singlechecker is now part of the unified checker page
    if (pageId === 'singlechecker') { pageId = 'checker'; checkerMode = checkerMode || 'single'; }
    if (!state.user && pageId !== 'overview') return showLogin();
    document.querySelectorAll('.tool-page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tools-nav-btn').forEach(b => b.classList.remove('active'));
    const page = document.getElementById('toolPage' + pageId.charAt(0).toUpperCase() + pageId.slice(1));
    if (page) page.classList.add('active');
    else document.getElementById('toolPageOverview')?.classList.add('active');
    const navBtn = document.querySelector(`.tools-nav-btn[data-tool-page="${pageId}"]`);
    if (navBtn) navBtn.classList.add('active');
    else document.querySelector('.tools-nav-btn[data-tool-page="overview"]')?.classList.add('active');
    // Switch checker mode if specified
    if (checkerMode && (pageId === 'checker')) _setCheckerMode(checkerMode);
  }

  function _setCheckerMode(mode) {
    document.querySelectorAll('.checker-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.checkerMode === mode));
    document.getElementById('checkerSingleMode')?.classList.toggle('hidden', mode !== 'single');
    document.getElementById('checkerMassMode')?.classList.toggle('hidden', mode !== 'mass');
  }

  // ═══ MASS CHECKER ═══
  let _checkerJobId = null;
  let _checkerPollTimer = null;

  function _initChecker() {
    const dropZone = document.getElementById('checkerDropZone');
    const fileInput = document.getElementById('checkerFileInput');
    const selectBtn = document.getElementById('checkerSelectBtn');

    selectBtn?.addEventListener('click', () => fileInput?.click());
    dropZone?.addEventListener('click', (e) => { if (e.target === dropZone || e.target.closest('.checker-upload-title') || e.target.closest('.checker-upload-desc')) fileInput?.click(); });

    // Drag & drop
    ['dragenter','dragover'].forEach(ev => dropZone?.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => dropZone?.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
    dropZone?.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (file) _checkerProcessFile(file);
    });
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) _checkerProcessFile(file);
    });

    document.getElementById('checkerNewBtn')?.addEventListener('click', _checkerReset);
    document.getElementById('checkerDownloadBtn')?.addEventListener('click', _checkerDownload);
  }

  function _checkerProcessFile(file) {
    if (file.size > 20 * 1024 * 1024) return toast('Файл слишком большой (макс. 20 МБ)', 'error');
    if (!file.name.endsWith('.txt')) return toast('Поддерживается только .txt формат', 'warning');
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      _checkerStart(text);
    };
    reader.readAsText(file);
  }

  async function _checkerStart(text) {
    try {
      const res = await api('/api/tools/checker/start', { method: 'POST', body: { text } });
      _checkerJobId = res.job_id;
      // Show progress
      document.getElementById('checkerDropZone')?.classList.add('hidden');
      document.getElementById('checkerProgress')?.classList.remove('hidden');
      document.getElementById('checkerResults')?.classList.add('hidden');
      document.getElementById('checkerCount').textContent = `0 / ${res.total}`;
      // Start polling
      _checkerPollTimer = setInterval(_checkerPoll, 1500);
    } catch(e) {
      toast(e.message || 'Ошибка', 'error');
    }
  }

  async function _checkerPoll() {
    if (!_checkerJobId) return;
    try {
      const d = await api(`/api/tools/checker/status/${_checkerJobId}`, { silent: true });
      if (!d) return;
      const pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
      document.getElementById('checkerBar').style.width = pct + '%';
      document.getElementById('checkerCount').textContent = `${d.done} / ${d.total}`;

      // Live stats
      const ls = document.getElementById('checkerLiveStats');
      if (ls && d.stats) {
        const s = d.stats;
        ls.innerHTML = `
          <div class="checker-stat"><div class="checker-stat-val" style="color:#22c55e">${s.valid}</div><div class="checker-stat-label">Валид</div></div>
          <div class="checker-stat"><div class="checker-stat-val" style="color:#ef4444">${s.invalid}</div><div class="checker-stat-label">Невалид</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.total_robux.toLocaleString()}</div><div class="checker-stat-label">Robux</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.total_rap.toLocaleString()}</div><div class="checker-stat-label">RAP</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.premium}</div><div class="checker-stat-label">Premium</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.with_card}</div><div class="checker-stat-label">Card</div></div>
        `;
      }

      if (d.status === 'done') {
        clearInterval(_checkerPollTimer);
        _checkerPollTimer = null;
        _checkerShowResults();
      }
    } catch(e) {}
  }

  async function _checkerShowResults() {
    try {
      const d = await api(`/api/tools/checker/results/${_checkerJobId}`);
      document.getElementById('checkerProgress')?.classList.add('hidden');
      document.getElementById('checkerResults')?.classList.remove('hidden');

      const sg = document.getElementById('checkerStatsGrid');
      if (sg && d.stats) {
        const s = d.stats;
        sg.innerHTML = `
          <div class="checker-stat"><div class="checker-stat-val" style="color:#22c55e">${d.valid}</div><div class="checker-stat-label">Валид</div></div>
          <div class="checker-stat"><div class="checker-stat-val" style="color:#ef4444">${d.invalid}</div><div class="checker-stat-label">Невалид</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.total_robux.toLocaleString()}</div><div class="checker-stat-label">Robux All</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.total_rap.toLocaleString()}</div><div class="checker-stat-label">RAP All</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${(s.total_donate||0).toLocaleString()}</div><div class="checker-stat-label">Donate All</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.premium}</div><div class="checker-stat-label">Premium</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.email_verified}</div><div class="checker-stat-label">Email</div></div>
          <div class="checker-stat"><div class="checker-stat-val">${s.with_card}</div><div class="checker-stat-label">Card</div></div>
        `;
      }

      const cc = document.getElementById('checkerCategories');
      if (cc && d.categories) {
        const catColors = {
          'robux_1k+': '#22c55e', 'robux_100+': '#4ade80', 'rap_5k+': '#f59e0b', 'rap_500+': '#fbbf24',
          'premium': '#a855f7', 'email_verified': '#3b82f6', 'has_card': '#ef4444',
          'donate_10k+': '#ec4899', 'basic': '#6b7280',
        };
        const catNames = {
          'robux_1k+': 'Robux 1K+', 'robux_100+': 'Robux 100+', 'rap_5k+': 'RAP 5K+', 'rap_500+': 'RAP 500+',
          'premium': 'Premium', 'email_verified': 'Email Verified', 'has_card': 'Has Card',
          'donate_10k+': 'Donate 10K+', 'basic': 'Basic',
        };
        cc.innerHTML = `<div class="checker-cats-title">Категории</div>` + Object.entries(d.categories).sort((a,b) => b[1]-a[1]).map(([cat, cnt]) => {
          const col = catColors[cat] || '#6b7280';
          return `<div class="checker-cat">
            <span class="checker-cat-name"><span style="width:8px;height:8px;border-radius:50%;background:${col};display:inline-block"></span>${catNames[cat] || cat}</span>
            <span class="checker-cat-count" style="background:${col}18;color:${col}">${cnt}</span>
          </div>`;
        }).join('');

        // Top accounts table
        if (d.top_accounts && d.top_accounts.length) {
          const tableHtml = `
          <div class="checker-top-title">🏆 Топ аккаунты (по Robux)</div>
          <div class="checker-top-table-wrap">
            <table class="checker-top-table">
              <thead><tr><th>#</th><th>Никнейм</th><th>Robux</th><th>RAP</th><th>Premium</th><th>Email</th><th>Card</th></tr></thead>
              <tbody>
                ${d.top_accounts.map((a, i) => `<tr>
                  <td class="checker-top-rank">${i+1}</td>
                  <td class="checker-top-user">${escapeHtml(a.username||'?')}</td>
                  <td style="color:${a.robux>0?'#22c55e':'var(--text-muted)'};font-weight:700">${(a.robux||0).toLocaleString()}</td>
                  <td>${(a.rap||0).toLocaleString()}</td>
                  <td>${a.premium?'<span style="color:#a855f7;font-weight:700">✓</span>':'<span style="color:var(--text-muted)">✗</span>'}</td>
                  <td>${a.email_verified?'<span style="color:#3b82f6">✓</span>':'<span style="color:var(--text-muted)">✗</span>'}</td>
                  <td>${a.card>0?'<span style="color:#f59e0b">✓</span>':'<span style="color:var(--text-muted)">✗</span>'}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
          cc.insertAdjacentHTML('beforeend', tableHtml);
        }
      }
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
  }

  function _checkerDownload() {
    if (!_checkerJobId) return;
    window.open(`/api/tools/checker/download/${_checkerJobId}`, '_blank');
  }

  function _checkerReset() {
    _checkerJobId = null;
    if (_checkerPollTimer) { clearInterval(_checkerPollTimer); _checkerPollTimer = null; }
    document.getElementById('checkerDropZone')?.classList.remove('hidden');
    document.getElementById('checkerProgress')?.classList.add('hidden');
    document.getElementById('checkerResults')?.classList.add('hidden');
    document.getElementById('checkerFileInput').value = '';
  }

  // ═══ DESCRIPTION GENERATOR (cookie-based) ═══
  function _initDescGen() {
    document.getElementById('descgenGenerateBtn')?.addEventListener('click', _descgenGenerate);
    document.getElementById('descgenCopyBtn')?.addEventListener('click', () => {
      const title = document.getElementById('descgenResultTitle')?.textContent || '';
      const desc = document.getElementById('descgenResultDesc')?.textContent || '';
      navigator.clipboard?.writeText(title + '\n\n' + desc).then(() => toast('Скопировано!', 'success'));
    });
    _descgenLoadHistory();
  }

  async function _descgenGenerate() {
    const cookie = (document.getElementById('descgenCookie')?.value || '').trim();
    if (!cookie || cookie.length < 30) return toast('Вставь валидный cookie', 'warning');
    if (!state.user) return showLogin();
    const mode = document.getElementById('descgenMode')?.value || 'Продающий';
    const tone = document.getElementById('descgenTone')?.value || 'Классика';
    const extra = document.getElementById('descgenExtra')?.value || '';
    const btn = document.getElementById('descgenGenerateBtn');
    const statusEl = document.getElementById('descgenStatus');
    try {
      if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;margin:0 auto"></div>'; }
      if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Проверяем аккаунт...'; }
      // Step 1: check cookie
      const check = await api('/api/roblox/check_cookie', { method: 'POST', timeout: 60000, body: { cookie } });
      if (statusEl) statusEl.textContent = 'Генерируем описание...';
      // Step 2: generate description with full account data
      const data = {
        username: check?.user?.username || '',
        user_id: check?.user?.id || '',
        robux: check?.robux?.balance || 0,
        rap: check?.inventory?.collectibles_rap || 0,
        is_premium: check?.robux?.is_premium || false,
        limiteds: check?.inventory?.collectibles_count || 0,
        groups: check?.groups?.total_groups || 0,
        friends: check?.social?.friends || 0,
        followers: check?.social?.followers || 0,
        donate_year: check?.transactions?.donate_year || 0,
        account_age: check?.user?.account_age_days || 0,
        games: check?.games?.created_games || 0,
        badges: check?.badges?.count || 0,
      };
      const d = await api('/api/tools/generate_description', {
        method: 'POST', timeout: 90000,
        body: { username: data.username, mode, tone, extra, data }
      });
      const out = document.getElementById('descgenOutput');
      out?.classList.remove('hidden');
      document.getElementById('descgenResultTitle').textContent = d.title || '';
      document.getElementById('descgenResultDesc').textContent = d.desc || d.description || '';
      if (statusEl) statusEl.style.display = 'none';
      toast('Описание готово!', 'success');
      _descgenLoadHistory();
    } catch(e) {
      toast(e.message || 'Ошибка', 'error');
      if (statusEl) { statusEl.textContent = 'Ошибка: ' + (e.message || ''); statusEl.style.color = '#ef4444'; }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Проверить и сгенерировать'; }
    }
  }

  // ═══ SINGLE CHECKER ═══
  function _initSingleChecker() {
    document.getElementById('singleCheckerBtn')?.addEventListener('click', async () => {
      const cookie = (document.getElementById('singleCheckerCookie')?.value || '').trim();
      if (!cookie || cookie.length < 30) return toast('Вставь валидный cookie', 'warning');
      if (!state.user) return showLogin();
      const btn = document.getElementById('singleCheckerBtn');
      const resultEl = document.getElementById('singleCheckerResult');
      try {
        if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;margin:0 auto"></div>'; }
        const d = await api('/api/roblox/check_cookie', { method: 'POST', timeout: 60000, body: { cookie } });
        const u = d.user || {};
        const r = d.robux || {};
        const s = d.social || {};
        const inv = d.inventory || {};
        const gr = d.groups || {};
        const gm = d.games || {};
        const sec = d.security || {};
        const tx = d.transactions || {};
        const priv = d.privacy || {};
        const badges = d.badges || {};

        // Helper badge pill
        const pill = (label, ok, color) => `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;background:rgba(${ok?'34,197,94':'107,114,128'},.12);color:${ok?(color||'#22c55e'):'#6b7280'}">${label}</span>`;
        const statBox = (val, label, color) => `<div class="chk-stat"><div class="chk-stat-val" style="${color?'color:'+color:''}">${val}</div><div class="chk-stat-label">${label}</div></div>`;
        const secRow = (icon, label, val, ok) => `<div class="chk-sec-item ${ok?'ok':'off'}"><span class="chk-sec-icon">${icon}</span><span class="chk-sec-label">${label}</span><span class="chk-sec-val">${val}</span></div>`;

        if (resultEl) {
          resultEl.classList.remove('hidden');
          resultEl.innerHTML = `
<div class="chk-result-card">
  <!-- Header -->
  <div class="chk-header">
    ${u.avatar_url ? `<img src="${escapeHtml(u.avatar_url)}" class="chk-avatar">` : `<div class="chk-avatar-fallback"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`}
    <div class="chk-header-info">
      <div class="chk-username">${escapeHtml(u.username||'?')} ${u.display_name && u.display_name !== u.username ? `<span class="chk-displayname">(@${escapeHtml(u.display_name)})</span>` : ''}</div>
      <div class="chk-meta">ID: ${u.id||'—'} · ${u.account_age_days||0} дн · ${u.country||''}</div>
      <div class="chk-pills">
        ${r.is_premium ? pill('PREMIUM', true, '#a855f7') : ''}
        ${sec.has_2fa ? pill('2FA', true, '#22c55e') : ''}
        ${u.voice_verified ? pill('VOICE ID', true, '#06b6d4') : ''}
        ${u.verified_age ? pill('18+', true, '#f59e0b') : ''}
        ${u.is_banned ? pill('BANNED', false) : pill('АКТИВЕН', true, '#22c55e')}
      </div>
    </div>
  </div>

  <!-- Main Stats Grid -->
  <div class="chk-stats-section">
    <div class="chk-section-label">💰 Финансы</div>
    <div class="chk-stats-grid">
      ${statBox((r.balance||0).toLocaleString(), 'Robux', '#22c55e')}
      ${statBox((r.pending||0).toLocaleString(), 'Pending', '')}
      ${statBox((inv.collectibles_rap||0).toLocaleString(), 'RAP', '#f59e0b')}
      ${statBox((tx.donate_year||0).toLocaleString(), 'Donate/год', '')}
      ${statBox(r.billing_credit||0, 'Credit', '')}
      ${statBox(inv.has_card ? '✓' : '✗', 'Карта', inv.has_card ? '#22c55e' : '#6b7280')}
    </div>
  </div>

  <div class="chk-stats-section">
    <div class="chk-section-label">👥 Социальное</div>
    <div class="chk-stats-grid">
      ${statBox(s.friends||0, 'Друзья', '')}
      ${statBox(s.followers||0, 'Фолловеры', '')}
      ${statBox(s.followings||0, 'Фолловинги', '')}
      ${statBox(gr.total_groups||0, 'Групп', '')}
      ${statBox(gr.owned_groups||0, 'Своих групп', '')}
      ${statBox((gr.groups_members||0).toLocaleString(), 'Участников', '')}
    </div>
  </div>

  <div class="chk-stats-section">
    <div class="chk-section-label">🎮 Рублокс</div>
    <div class="chk-stats-grid">
      ${statBox(inv.collectibles_count||0, 'Лимитки', '')}
      ${statBox(inv.gamepasses||0, 'Геймпассы', '')}
      ${statBox(badges.count||0, 'Бейджи', '')}
      ${statBox(gm.created_games||0, 'Игры', '')}
      ${statBox((gm.total_visits||0).toLocaleString(), 'Визиты', '')}
      ${statBox(u.roblox_badges||0, 'Roblox бейджи', '')}
    </div>
  </div>

  <!-- Security Section -->
  <div class="chk-stats-section">
    <div class="chk-section-label">🔐 Безопасность</div>
    <div class="chk-security-grid">
      ${secRow('✉️', 'Email', sec.email_verified ? (sec.email||'Подтверждён') : 'Не подтверждён', sec.email_verified)}
      ${secRow('📱', 'Телефон', sec.phone_verified ? (sec.phone||'Подтверждён') : 'Не привязан', sec.phone_verified)}
      ${secRow('🔒', 'PIN-код', sec.has_pin ? 'Установлен' : 'Не установлен', sec.has_pin)}
      ${secRow('🛡️', '2FA', sec.has_2fa ? 'Включён' : 'Выключен', sec.has_2fa)}
      ${secRow('💬', 'Голос', u.voice_verified ? 'Верифицирован' : 'Нет', u.voice_verified)}
      ${secRow('🔄', 'Сессии', sec.sessions||0, sec.sessions > 0)}
    </div>
  </div>

  <!-- Privacy Section -->
  <div class="chk-stats-section">
    <div class="chk-section-label">🕵️ Приватность</div>
    <div class="chk-privacy-row">
      <div class="chk-privacy-item"><span>Инвентарь</span><span class="chk-privacy-val">${priv.inventory||'—'}</span></div>
      <div class="chk-privacy-item"><span>Трейдинг</span><span class="chk-privacy-val">${priv.trade||'—'}</span></div>
      <div class="chk-privacy-item"><span>Можно торговать</span><span class="chk-privacy-val" style="color:${priv.can_trade?'#22c55e':'#6b7280'}">${priv.can_trade?'✓ Да':'✗ Нет'}</span></div>
    </div>
  </div>

  ${gr.groups_list && gr.groups_list.length ? `
  <div class="chk-stats-section">
    <div class="chk-section-label">🏠 Топ группы</div>
    <div class="chk-groups-list">
      ${gr.groups_list.map(g => `<div class="chk-group-item"><span class="chk-group-name">${escapeHtml(g.name||g||'')}</span></div>`).join('')}
    </div>
  </div>` : ''}
</div>`;
        }
        toast('Аккаунт проверен!', 'success');
      } catch(e) {
        toast(e.message || 'Ошибка проверки', 'error');
        if (resultEl) { resultEl.classList.remove('hidden'); resultEl.innerHTML = `<div style="padding:16px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:12px;color:#ef4444;font-size:13px">${escapeHtml(e.message || 'Ошибка')}</div>`; }
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>Проверить аккаунт'; }
      }
    });
  }

  async function _descgenLoadHistory() {
    const list = document.getElementById('descgenHistoryList');
    if (!list || !state.user) return;
    try {
      const d = await api('/api/user/tool_history?tool=description', { silent: true });
      if (!d) return;
      const items = d.items || [];
      if (!items.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px">Пока нет истории</div>'; return; }
      list.innerHTML = items.slice(0, 8).map(it => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px">
          <div><span style="font-weight:600">${escapeHtml(it.input || '')}</span> <span style="color:var(--text-muted)">${escapeHtml(it.result || '')}</span></div>
          <span style="color:var(--text-muted);font-size:11px">${String(it.ts||'').slice(0,10)}</span>
        </div>
      `).join('');
    } catch(e) {}
  }

  // ═══ AI MULTI-CHAT ═══
  let _aiCurrentChatId = null;
  let _aiChats = [];
  let _aiPendingImage = null; // File object waiting to be sent with next message
  let _aiLimits = null;

  function _initAiChat() {
    document.getElementById('aichatSendBtn')?.addEventListener('click', _aiSendMessage);
    document.getElementById('aichatInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _aiSendMessage(); }
    });
    // Image attachment button
    document.getElementById('aichatImgBtn')?.addEventListener('click', () => {
      document.getElementById('aichatImageInput')?.click();
    });
    document.getElementById('aichatImageInput')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) { toast('Файл слишком большой (макс 4MB)', 'warning'); return; }
      _aiPendingImage = file;
      const btn = document.getElementById('aichatImgBtn');
      if (btn) {
        btn.style.background = 'rgba(var(--accent-rgb),.2)';
        btn.style.borderColor = 'rgba(var(--accent-rgb),.5)';
        btn.title = `📷 ${file.name}`;
      }
      const inp = document.getElementById('aichatInput');
      if (inp && !inp.value) inp.placeholder = `📷 ${file.name} — напиши вопрос или нажми отправить`;
      toast(`📷 Скриншот прикреплён: ${file.name}`, 'success');
      e.target.value = '';
    });
    document.getElementById('aichatInput')?.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });
    document.getElementById('aiNewChatBtn')?.addEventListener('click', _aiCreateChat);
    _aiLoadChats();
    _aiLoadLimits();
  }

  async function _aiLoadLimits() {
    try {
      const d = await api('/api/ai/limits', { silent: true });
      if (!d) return;
      _aiLimits = d;
      _aiRenderLimits();
    } catch(e) {}
  }

  function _aiRenderLimits() {
    const el = document.getElementById('aiLimitsDisplay');
    if (!el || !_aiLimits) return;
    const l = _aiLimits;
    const msgPct = l.max_messages > 0 ? Math.min(100, (l.messages_used / l.max_messages) * 100) : 100;
    const periodText = l.period === 'week' ? '/нед' : '';
    const premBadge = l.premium ? '<span style="color:var(--accent-tertiary);font-weight:600">\u2605 Premium</span>' : '';
    el.innerHTML = `${premBadge}
      <span>\ud83d\udcac ${l.messages_used}/${l.max_messages}${periodText}</span>
      <div class="ai-limit-bar"><div class="ai-limit-bar-fill" style="width:${msgPct}%;${msgPct>=90?'background:#ef4444':''}"></div></div>
      <span>\ud83d\udcc2 ${l.chats_used}/${l.max_chats}</span>`;
  }

  async function _aiLoadChats() {
    try {
      const d = await api('/api/ai/chats', { silent: true });
      if (!d) return;
      _aiChats = d.chats || [];
      _aiRenderChatList();
      if (_aiChats.length > 0 && !_aiCurrentChatId) {
        _aiSelectChat(_aiChats[0].id);
      }
    } catch(e) {}
  }

  function _aiRenderChatList() {
    const list = document.getElementById('aiChatList');
    if (!list) return;
    if (_aiChats.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:16px">Нет чатов</div>';
      return;
    }
    list.innerHTML = _aiChats.map(c => `
      <div class="aichat-list-item${c.id === _aiCurrentChatId ? ' active' : ''}" data-chat-id="${c.id}">
        <span class="chat-title">${escapeHtml(c.title)}</span>
        <button class="chat-del" data-del-chat="${c.id}" title="Удалить">\u2715</button>
      </div>
    `).join('');
    list.querySelectorAll('.aichat-list-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.chat-del')) return;
        _aiSelectChat(Number(el.dataset.chatId));
      });
    });
    list.querySelectorAll('.chat-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _aiDeleteChat(Number(btn.dataset.delChat));
      });
    });
  }

  async function _aiSelectChat(chatId) {
    _aiCurrentChatId = chatId;
    _aiRenderChatList();
    document.getElementById('aiInputArea').style.display = 'flex';
    const container = document.getElementById('aichatMessages');
    container.innerHTML = '<div style="text-align:center;padding:40px"><div class="spinner" style="width:20px;height:20px"></div></div>';
    try {
      const d = await api(`/api/ai/chats/${chatId}/messages`, { silent: true });
      if (!d) return;
      const msgs = d.messages || [];
      if (msgs.length === 0) {
        container.innerHTML = '<div class="aichat-welcome"><div class="aichat-welcome-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><h3>\u041d\u043e\u0432\u044b\u0439 \u0447\u0430\u0442</h3><p>\u041d\u0430\u043f\u0438\u0448\u0438 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435, \u0447\u0442\u043e\u0431\u044b \u043d\u0430\u0447\u0430\u0442\u044c</p></div>';
      } else {
        container.innerHTML = msgs.map(m =>
          `<div class="aichat-msg ${m.role === 'user' ? 'user' : 'ai'}">${escapeHtml(m.content)}</div>`
        ).join('');
        container.scrollTop = container.scrollHeight;
      }
    } catch(e) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:#ef4444">Ошибка загрузки</div>';
    }
  }

  async function _aiCreateChat() {
    try {
      const d = await api('/api/ai/chats', { method: 'POST' });
      if (!d || !d.id) return;
      _aiChats.unshift({ id: d.id, title: d.title, created_at: d.created_at, updated_at: d.created_at });
      _aiSelectChat(d.id);
      _aiRenderChatList();
      _aiLoadLimits();
      toast('Чат создан', 'success');
    } catch(e) {
      toast(e.message || 'Не удалось создать чат', 'error');
    }
  }

  async function _aiDeleteChat(chatId) {
    if (!confirm('Удалить этот чат?')) return;
    try {
      await api(`/api/ai/chats/${chatId}`, { method: 'DELETE' });
      _aiChats = _aiChats.filter(c => c.id !== chatId);
      if (_aiCurrentChatId === chatId) {
        _aiCurrentChatId = null;
        document.getElementById('aiInputArea').style.display = 'none';
        document.getElementById('aichatMessages').innerHTML = '<div class="aichat-welcome"><div class="aichat-welcome-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><h3>Выбери или создай чат</h3><p>Нажми «Новый чат» чтобы начать</p></div>';
        if (_aiChats.length > 0) _aiSelectChat(_aiChats[0].id);
      }
      _aiRenderChatList();
      _aiLoadLimits();
      toast('Чат удалён', 'success');
    } catch(e) {
      toast(e.message || 'Ошибка', 'error');
    }
  }

  async function _aiSendMessage() {
    if (!_aiCurrentChatId) return toast('Сначала создай чат', 'warning');
    const input = document.getElementById('aichatInput');
    const msg = (input?.value || '').trim();
    const hasImage = !!_aiPendingImage;
    if (!msg && !hasImage) return;
    if (!state.user) return;

    input.value = '';
    input.style.height = 'auto';
    input.placeholder = 'Напиши сообщение или прикрепи скриншот...';

    const imageFile = _aiPendingImage;
    _aiPendingImage = null;
    // Reset image button style
    const imgBtn = document.getElementById('aichatImgBtn');
    if (imgBtn) { imgBtn.style.background = ''; imgBtn.style.borderColor = ''; imgBtn.title = 'Прикрепить скриншот'; }

    const container = document.getElementById('aichatMessages');
    container?.querySelector('.aichat-welcome')?.remove();

    // Show user message with image preview if any
    const userDiv = document.createElement('div');
    userDiv.className = 'aichat-msg user';
    if (hasImage) {
      const imgPreviewUrl = URL.createObjectURL(imageFile);
      userDiv.innerHTML = `${msg ? `<div style="margin-bottom:8px">${escapeHtml(msg)}</div>` : ''}
        <img src="${imgPreviewUrl}" style="max-width:200px;max-height:150px;border-radius:10px;display:block;border:1px solid rgba(255,255,255,.15)" onload="this.style.opacity=1" style="opacity:0;transition:opacity .3s">`;
    } else {
      userDiv.textContent = msg;
    }
    container?.appendChild(userDiv);
    container.scrollTop = container.scrollHeight;

    const aiDiv = document.createElement('div');
    aiDiv.className = 'aichat-msg ai';
    aiDiv.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><div class="spinner" style="width:16px;height:16px"></div><span style="font-size:12px;color:rgba(255,255,255,.4)">${hasImage ? 'Анализирую изображение...' : 'Думаю...'}</span></div>`;
    container?.appendChild(aiDiv);
    container.scrollTop = container.scrollHeight;

    const useSiteContext = document.getElementById('aiSiteContextToggle')?.checked ?? true;

    try {
      let d;
      if (hasImage) {
        // Read file as base64
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(imageFile);
        });
        d = await api(`/api/ai/chats/${_aiCurrentChatId}/send_vision`, {
          method: 'POST', timeout: 120000,
          body: {
            message: msg || 'Что изображено на скриншоте? Ответь на русском.',
            image_base64: base64,
            image_mime: imageFile.type || 'image/jpeg',
            site_context: useSiteContext
          }
        });
      } else {
        d = await api(`/api/ai/chats/${_aiCurrentChatId}/send`, {
          method: 'POST', timeout: 90000,
          body: { message: msg, site_context: useSiteContext }
        });
      }

      const reply = d.reply || 'Нет ответа';
      // Render reply with basic markdown support
      aiDiv.innerHTML = _renderAiReply(reply);
      if (d.limits) { _aiLimits = d.limits; _aiRenderLimits(); }
      const chat = _aiChats.find(c => c.id === _aiCurrentChatId);
      if (chat && chat.title === 'Новый чат') {
        chat.title = (msg || 'Изображение').slice(0, 40) + (msg.length > 40 ? '...' : '');
        _aiRenderChatList();
      }
    } catch(e) {
      const errDetail = e.detail || e.message || 'Неизвестная ошибка';
      aiDiv.innerHTML = `<div style="color:#ef4444;font-size:13px">❌ Ошибка AI: <code style="background:rgba(239,68,68,.1);padding:2px 6px;border-radius:4px;font-size:11px">${escapeHtml(errDetail)}</code></div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Попробуй ещё раз или создай заявку в поддержку</div>`;
    }
    container.scrollTop = container.scrollHeight;
  }

  function _renderAiReply(text) {
    // Simple markdown: bold, code, newlines
    let h = escapeHtml(text);
    h = h.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,.08);border-radius:4px;padding:1px 5px;font-family:monospace;font-size:12px">$1</code>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  // Keep old toolShow* for backward compat
  function toolShowChat() { _toolSwitchPage('aichat'); }
  function toolShowChecker() { _toolSwitchPage('checker', 'single'); }
  function toolShowRobloxCookieChecker() { _toolSwitchPage('checker', 'single'); }
  function toolShowGenerator() { _toolSwitchPage('descgen'); }

  // ═══ PROXY CHECKER ═══
  let _proxyJobId = null;
  let _proxyPollTimer = null;

  function _initProxyChecker() {
    const fileInput = document.getElementById('proxyFileInput');
    const selectBtn = document.getElementById('proxySelectBtn');
    const uploadZone = document.getElementById('proxyUploadZone');

    selectBtn?.addEventListener('click', () => fileInput?.click());
    ['dragenter','dragover'].forEach(ev => uploadZone?.addEventListener(ev, e => { e.preventDefault(); uploadZone.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => uploadZone?.addEventListener(ev, e => { e.preventDefault(); uploadZone.classList.remove('dragover'); }));
    uploadZone?.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (file) _proxyProcessFile(file);
    });
    fileInput?.addEventListener('change', () => {
      if (fileInput.files?.[0]) _proxyProcessFile(fileInput.files[0]);
    });
    document.getElementById('proxyNewBtn')?.addEventListener('click', _proxyReset);
    document.getElementById('proxyCopyGoodBtn')?.addEventListener('click', () => {
      const ta = document.getElementById('proxyGoodTextarea');
      if (ta) {
        navigator.clipboard?.writeText(ta.value).then(() => toast('Скопировано!', 'success'));
      }
    });
    document.getElementById('proxyDownloadGoodBtn')?.addEventListener('click', () => {
      const ta = document.getElementById('proxyGoodTextarea');
      if (!ta || !ta.value) return;
      const blob = new Blob([ta.value], { type: 'text/plain' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'good_proxies.txt' });
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function _proxyProcessFile(file) {
    if (file.size > 20 * 1024 * 1024) return toast('Файл слишком большой (макс. 20 МБ)', 'error');
    const reader = new FileReader();
    reader.onload = e => _proxyStart(e.target.result);
    reader.readAsText(file);
  }

  async function _proxyStart(text) {
    const threads = parseInt(document.getElementById('proxyThreadsInput')?.value || '80', 10);
    try {
      const res = await api('/api/tools/proxy/start', { method: 'POST', body: { text, threads } });
      _proxyJobId = res.job_id;
      document.getElementById('proxyUploadZone')?.classList.add('hidden');
      document.getElementById('proxyProgress')?.classList.remove('hidden');
      document.getElementById('proxyResults')?.classList.add('hidden');
      document.getElementById('proxyCount').textContent = `0 / ${res.total}`;
      _proxyPollTimer = setInterval(_proxyPoll, 1200);
    } catch(e) {
      toast(e.message || 'Ошибка запуска', 'error');
    }
  }

  async function _proxyPoll() {
    if (!_proxyJobId) return;
    try {
      const d = await api(`/api/tools/proxy/status/${_proxyJobId}`, { silent: true });
      if (!d) return;
      const pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
      document.getElementById('proxyBar').style.width = pct + '%';
      document.getElementById('proxyCount').textContent = `${d.done} / ${d.total}`;
      const ls = document.getElementById('proxyLiveStats');
      if (ls) ls.innerHTML = `
        <div class="checker-stat"><div class="checker-stat-val" style="color:#10b981">${d.good}</div><div class="checker-stat-label">Рабочих</div></div>
        <div class="checker-stat"><div class="checker-stat-val" style="color:#ef4444">${d.bad}</div><div class="checker-stat-label">Мёртвых</div></div>
        <div class="checker-stat"><div class="checker-stat-val">${d.avg_ms||'—'}</div><div class="checker-stat-label">Сред. пинг (мс)</div></div>
      `;
      if (d.status === 'done') {
        clearInterval(_proxyPollTimer);
        _proxyPollTimer = null;
        _proxyShowResults();
      }
    } catch(e) {}
  }

  async function _proxyShowResults() {
    try {
      const d = await api(`/api/tools/proxy/results/${_proxyJobId}`);
      document.getElementById('proxyProgress')?.classList.add('hidden');
      document.getElementById('proxyResults')?.classList.remove('hidden');
      const sg = document.getElementById('proxyStatsGrid');
      const pct = d.total > 0 ? Math.round((d.good / d.total) * 100) : 0;
      if (sg) sg.innerHTML = `
        <div class="chk-stat"><div class="chk-stat-val" style="color:#10b981">${d.good}</div><div class="chk-stat-label">Рабочих</div></div>
        <div class="chk-stat"><div class="chk-stat-val" style="color:#ef4444">${d.bad}</div><div class="chk-stat-label">Нерабочих</div></div>
        <div class="chk-stat"><div class="chk-stat-val">${d.total}</div><div class="chk-stat-label">Всего</div></div>
        <div class="chk-stat"><div class="chk-stat-val" style="color:${pct>30?'#22c55e':'#f59e0b'}">${pct}%</div><div class="chk-stat-label">Выживших</div></div>
      `;
      const ta = document.getElementById('proxyGoodTextarea');
      if (ta) ta.value = d.good_text || '';
      toast(`Готово! Рабочих: ${d.good} из ${d.total}`, 'success');
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
  }

  function _proxyReset() {
    _proxyJobId = null;
    if (_proxyPollTimer) { clearInterval(_proxyPollTimer); _proxyPollTimer = null; }
    document.getElementById('proxyUploadZone')?.classList.remove('hidden');
    document.getElementById('proxyProgress')?.classList.add('hidden');
    document.getElementById('proxyResults')?.classList.add('hidden');
    document.getElementById('proxyFileInput').value = '';
  }



  function toolShowImage(){
    modal(`
      <h2 style="margin:0 0 14px 0">🎨 Генерация изображений</h2>
      <div class="muted" style="margin-bottom:14px">Grok-2 Image через Puter. Возвращается картинка в высоком качестве (без ключей).</div>

      <div class="form-group">
        <label class="form-label">Промпт</label>
        <textarea class="form-input" id="toolImgPrompt" rows="4" placeholder="Напр: Neon cyber banner, realistic premium card, purple glow..."></textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Модель</label>
        <select class="form-input" id="toolImgModel">
          <option value="grok-2-image">Grok-2 Image</option>
        </select>
        <div class="form-hint">У Grok-2 Image нет настроек качества/размера (по документации Puter).</div>
      </div>

      <button class="btn btn-primary" style="width:100%" id="toolImgGenBtn">Сгенерировать</button>

      <div id="toolImgOut" class="card hidden" style="margin-top:14px;padding:14px"></div>
    `);

    document.getElementById('toolImgGenBtn')?.addEventListener('click', async ()=>{
      const prompt = (document.getElementById('toolImgPrompt')?.value || '').trim();
      if (!prompt) return toast('Введи промпт', 'warning');
      if (!state.user) return showLogin();
      try{
        loading(true);

        // Consume AI credit / check premium
        await api('/api/ai/consume', { method: 'POST', body: { kind: 'img', amount: 1 } });

        if (!window.puter?.ai?.txt2img) throw new Error('Puter AI не загрузился. Перезагрузи страницу.');

        const img = await puter.ai.txt2img({ prompt, provider: 'xai', model: 'grok-2-image' });
        const out = document.getElementById('toolImgOut');
        if (out){
          out.innerHTML = '';
          img.style.maxWidth = '100%';
          img.style.borderRadius = '16px';
          out.appendChild(img);
          out.classList.remove('hidden');
        }
        toast('Готово', 'success');
        await checkAuth();
      }catch(e){
        toast(e.message || 'Ошибка генерации', 'error');
      }finally{ loading(false); }
    });
  }

  // ══════════════════════════════════════════════════════════
  // CASES v2 — Roulette System
  // ══════════════════════════════════════════════════════════

  // RARITY_NAMES, RARITY_COLORS, RARITY_EMOJIS declared earlier

  const CASE_FALLBACK_LABELS = {
    P5M: '⭐ Premium 5 минут',
    P15M: '🔷 Premium 15 минут',
    P30M: '💎 Premium 30 минут',
    P1H:  '✨ Premium 1 час',
    P1D:  '🌟 Premium 1 день',
    P6H:  '✨ Premium 6 часов',
    P12H: '💎 Premium 12 часов',
    P2D:  '🌟 Premium 2 дня',
    P3D:  '🌟 Premium 3 дня',
    B17:  '💰 +17 ₽ на баланс',
    'M+1':'💸 +1 ₽',
    'M+2':'💸 +2 ₽',
    M0:   '😶 Ничего',
    'M-2':'💥 -2 ₽',
    GEN10:'🤖 10 AI кредитов',
    AI3:  '🔍 3 анализа',
  };

  let _caseCfgCache = null;
  let _caseLabelMap = {};
  let _caseTierMap = {};
  let _caseKindMap = {};

  const _FALLBACK_CASE_CFG = {
    ok: true,
    cases: [
      { id:'free', title:'Бесплатный кейс', desc:'Открывается раз в 2 дня. Выиграй Premium!', price:0, cooldown_h:48,
        prizes: [
          {code:'P5M',  weight:5000,label:'⭐ Premium 5 минут',  tier:1, kind:'premium'},
          {code:'P15M', weight:2500,label:'🔷 Premium 15 минут', tier:2, kind:'premium'},
          {code:'P30M', weight:1500,label:'💎 Premium 30 минут', tier:3, kind:'premium'},
          {code:'P1H',  weight:800, label:'✨ Premium 1 час',     tier:4, kind:'premium'},
          {code:'P1D',  weight:200, label:'🌟 Premium 1 день',    tier:5, kind:'premium'},
        ]},
      { id:'paid', title:'Платный кейс', desc:'Стоит 17 ₽. Лучшие шансы!', price:17, cooldown_h:0,
        prizes: [
          {code:'P30M', weight:3000,label:'💎 Premium 30 минут', tier:3, kind:'premium'},
          {code:'P1H',  weight:2500,label:'✨ Premium 1 час',     tier:4, kind:'premium'},
          {code:'B17',  weight:2000,label:'💰 +17 ₽',            tier:3, kind:'balance'},
          {code:'P1D',  weight:1500,label:'🌟 Premium 1 день',    tier:5, kind:'premium'},
          {code:'P2D',  weight:700, label:'🌟 Premium 2 дня',     tier:5, kind:'premium'},
          {code:'P3D',  weight:300, label:'🌟 Premium 3 дня',     tier:5, kind:'premium'},
        ]},
      { id:'money', title:'Денежный кейс', desc:'Чистое везение: ±₽', price:0, cooldown_h:24,
        prizes: [
          {code:'M+1',weight:1,label:'+1 ₽',   tier:2,kind:'balance'},
          {code:'M+2',weight:1,label:'+2 ₽',   tier:3,kind:'balance'},
          {code:'M0', weight:1,label:'Ничего', tier:1,kind:'none'},
          {code:'M-2',weight:1,label:'-2 ₽',   tier:1,kind:'penalty'},
        ]},
    ]
  };

  async function ensureCaseConfig(){
    if (_caseCfgCache) return _caseCfgCache;
    let cfg;
    try { cfg = await api('/api/cases/config', { silent: true }); } catch(_){ cfg = null; }
    if (!cfg || !cfg.cases) cfg = _FALLBACK_CASE_CFG;
    _caseCfgCache = cfg;
    _caseLabelMap = {};  _caseTierMap = {};  _caseKindMap = {};
    (cfg?.cases || []).forEach(c => {
      (c.prizes || []).forEach(p => {
        if (!_caseLabelMap[p.code]) _caseLabelMap[p.code] = p.label;
        if (!_caseTierMap[p.code])  _caseTierMap[p.code]  = Number(p.tier || 1);
        if (!_caseKindMap[p.code])  _caseKindMap[p.code]  = p.kind || 'unknown';
      });
    });
    return cfg;
  }

  function casePrizeLabel(code){
    const k = String(code || '').trim();
    return _caseLabelMap[k] || CASE_FALLBACK_LABELS[k] || `🎁 ${k}`;
  }
  function casePrizeTier(code){
    const k = String(code || '').trim();
    return Number(_caseTierMap[k] || 1);
  }

  // ── WebAudio Engine ─────────────────────────────────────
  let _aud = null;
  function _audio(){
    if (_aud) return _aud;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { _aud = new Ctx(); } catch(_){ return null; }
    return _aud;
  }

  function _soundEnabled(){ try { return localStorage.getItem('rst_sound') !== '0'; } catch(_){ return true; } }
  function _tone(freq, t, dur, type='sine', gain=0.08){
    if (!_soundEnabled()) return;
    const ctx = _audio(); if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, dur));
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + Math.max(0.05, dur) + 0.05);
    } catch(_){}
  }

  // Tick sound — pitch rises as reel slows down
  function _playCaseTick(progressRatio){
    if (!_soundEnabled()) return;
    const ctx = _audio(); if (!ctx) return;
    const t = ctx.currentTime;
    // progressRatio 0→1: faster early, slower later
    // Base pitch 600Hz → rises toward win
    const pitch = 600 + progressRatio * 600;
    const vol = 0.07 + progressRatio * 0.09;
    _tone(pitch,     t,      0.035, 'square', vol);
    _tone(pitch*1.5, t+0.01, 0.025, 'sine',   vol * 0.5);
  }

  // Win sound — dramatic rarity-scaled fanfare
  function playCaseWinSfx(tier){
    const ctx = _audio(); if (!ctx) return;
    const t = ctx.currentTime;
    const tr = Number(tier || 1);

    if (tr <= 1){
      // Common — soft ding
      _tone(880, t,      0.18, 'sine',     0.15);
      _tone(1100,t+0.12, 0.15, 'sine',     0.12);
    } else if (tr === 2){
      // Rare — ascending chime
      _tone(440, t,      0.22, 'triangle', 0.18);
      _tone(660, t+0.10, 0.22, 'triangle', 0.20);
      _tone(880, t+0.20, 0.25, 'sine',     0.20);
      _tone(1100,t+0.30, 0.20, 'sine',     0.16);
    } else if (tr === 3){
      // Epic — chord burst
      _tone(165, t,      0.50, 'sawtooth', 0.12);
      _tone(330, t,      0.45, 'triangle', 0.18);
      _tone(495, t+0.06, 0.42, 'triangle', 0.20);
      _tone(660, t+0.14, 0.40, 'sine',     0.22);
      _tone(880, t+0.24, 0.35, 'sine',     0.20);
      _tone(1100,t+0.34, 0.28, 'sine',     0.16);
    } else if (tr === 4){
      // Legendary — brass fanfare
      _tone(110, t,      0.60, 'sawtooth', 0.16);
      _tone(220, t,      0.55, 'sawtooth', 0.20);
      _tone(330, t+0.06, 0.52, 'triangle', 0.24);
      _tone(440, t+0.14, 0.50, 'triangle', 0.26);
      _tone(660, t+0.22, 0.46, 'sine',     0.24);
      _tone(880, t+0.32, 0.40, 'sine',     0.22);
      _tone(1100,t+0.42, 0.32, 'sine',     0.18);
      _tone(1320,t+0.52, 0.24, 'sine',     0.14);
    } else {
      // Mythic — full orchestral explosion
      _tone(55,  t,      0.80, 'sawtooth', 0.14);
      _tone(110, t,      0.75, 'sawtooth', 0.18);
      _tone(165, t+0.04, 0.70, 'triangle', 0.22);
      _tone(220, t+0.08, 0.68, 'triangle', 0.26);
      _tone(330, t+0.14, 0.62, 'triangle', 0.28);
      _tone(440, t+0.20, 0.58, 'sine',     0.28);
      _tone(550, t+0.26, 0.52, 'sine',     0.26);
      _tone(660, t+0.32, 0.48, 'sine',     0.24);
      _tone(880, t+0.40, 0.42, 'sine',     0.22);
      _tone(1100,t+0.48, 0.36, 'sine',     0.20);
      _tone(1320,t+0.56, 0.28, 'sine',     0.16);
      _tone(1760,t+0.64, 0.22, 'sine',     0.13);
      _tone(2200,t+0.72, 0.18, 'sine',     0.10);
    }
  }

  // ── Particle burst ────────────────────────────────────────
  function _spawnParticles(tier){
    const existing = document.getElementById('caseParticles');
    if (existing) existing.remove();
    const canvas = document.createElement('canvas');
    canvas.id = 'caseParticles';
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const tierColors = {
      1: ['#9ca3af','#d1d5db','#e5e7eb'],
      2: ['#3b82f6','#60a5fa','#93c5fd','#dbeafe'],
      3: ['#a855f7','#c084fc','#d8b4fe','#e9d5ff'],
      4: ['#f59e0b','#fbbf24','#fde68a','#fffbeb'],
      5: ['#ef4444','#f97316','#fbbf24','#ec4899','#ff6b6b'],
    };
    const colors = tierColors[tier] || tierColors[1];
    const count = [20, 35, 55, 80, 130][tier - 1] || 20;

    const particles = Array.from({length: count}, () => ({
      x: canvas.width / 2,
      y: canvas.height / 2,
      vx: (Math.random() - 0.5) * (8 + tier * 5),
      vy: (Math.random() * -15) - (tier * 2),
      r: 3 + Math.random() * (tier * 2.5),
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: 1,
      spin: (Math.random() - 0.5) * 0.2,
      shape: Math.random() > 0.5 ? 'circle' : 'star',
    }));

    let frame;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      particles.forEach(p => {
        p.vy += 0.4;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.015;
        if (p.alpha <= 0) return;
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin * Date.now() / 100);
        if (p.shape === 'star') {
          ctx.beginPath();
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
            ctx.lineTo(Math.cos(a) * p.r, Math.sin(a) * p.r);
            const b = a + Math.PI / 5;
            ctx.lineTo(Math.cos(b) * p.r * 0.4, Math.sin(b) * p.r * 0.4);
          }
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });
      if (alive) { frame = requestAnimationFrame(draw); }
      else { canvas.remove(); }
    };
    frame = requestAnimationFrame(draw);
    setTimeout(() => { cancelAnimationFrame(frame); canvas.remove(); }, 5000);
  }

  // ── Result modal ──────────────────────────────────────────
  function showCaseResultModal(prize, opts = {}){
    const tier = casePrizeTier(prize);
    const rName = RARITY_NAMES[tier] || 'Common';
    const rColor = RARITY_COLORS[tier] || '#9ca3af';
    const icon = RARITY_EMOJIS[tier] || '⭐';
    const label = casePrizeLabel(prize);
    const subtitle = opts.subtitle || 'Приз добавлен в инвентарь.';

    const tierBg = {
      1:'rgba(156,163,175,0.15)',
      2:'rgba(59,130,246,0.15)',
      3:'rgba(168,85,247,0.18)',
      4:'rgba(245,158,11,0.18)',
      5:'rgba(239,68,68,0.20)'
    }[tier] || 'rgba(255,255,255,0.05)';

    modal(`
      <div class="case-result">
        <div class="case-result-glow t${tier}">${icon}</div>
        <div style="font-size:22px;font-weight:900;margin-bottom:6px;letter-spacing:-0.5px">${escapeHtml(label)}</div>
        <div class="case-result-tier-badge" style="color:${rColor};background:${tierBg};border:1px solid ${rColor}40">
          ${rName.toUpperCase()}
        </div>
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:20px">${escapeHtml(subtitle)}</div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button class="btn btn-primary" id="caseResInv">🎒 Инвентарь</button>
          <button class="btn btn-secondary" id="caseResClose">Закрыть</button>
        </div>
      </div>
    `);
    document.getElementById('caseResInv')?.addEventListener('click', e => {
      e.preventDefault(); closeModal(); switchTab('profile');
      setTimeout(() => switchProfileTab('inventory'), 200);
    });
    document.getElementById('caseResClose')?.addEventListener('click', e => { e.preventDefault(); closeModal(); });
    _spawnParticles(tier);
    playCaseWinSfx(tier);
  }

  // ── Case inventory modal ──────────────────────────────────
  async function showCaseInventory(){
    if (!state.user) return showLogin();
    modal(`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h2 style="margin:0;font-size:18px">🎒 Инвентарь призов</h2>
      </div>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">Призы из кейсов хранятся тут.</div>
      <div id="caseInvMeta" style="font-size:12px;color:var(--text-muted);margin-bottom:10px"></div>
      <div id="caseInvList"></div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-secondary" id="caseInvRefresh" style="flex:1">🔄 Обновить</button>
        <button class="btn btn-primary" id="caseInvClose" style="flex:1">Закрыть</button>
      </div>
    `, { size:'wide' });

    const meta = document.getElementById('caseInvMeta');
    const list = document.getElementById('caseInvList');

    const render = (d) => {
      if (meta) meta.textContent = `Слотов: ${d.count||0}/${d.max||0}`;
      const items = d.items || [];
      if (!list) return;
      if (!items.length){
        list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)"><div style="font-size:36px;margin-bottom:8px">🎁</div>Пока пусто</div>`;
        return;
      }
      list.innerHTML = items.map(it => {
        const tier = casePrizeTier(it.prize);
        const rColor = RARITY_COLORS[tier] || '#9ca3af';
        const icon = RARITY_EMOJIS[tier] || '⭐';
        const dt = it.created_at ? _fmtDatetime(it.created_at) : '';
        return `
          <div class="inv-item t${tier}" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;border:1px solid ${rColor}30;background:${rColor}08;margin-bottom:8px">
            <div style="font-size:26px;flex-shrink:0">${icon}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:13px">${escapeHtml(casePrizeLabel(it.prize))}</div>
              <div style="font-size:11px;color:${rColor};font-weight:700;text-transform:uppercase;letter-spacing:.5px">${RARITY_NAMES[tier]||'Common'}</div>
              ${dt ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${escapeHtml(dt)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button class="btn btn-primary btn-sm" data-action="use" data-id="${it.id}">✅ Активировать</button>
              <button class="btn btn-ghost btn-sm" data-action="del" data-id="${it.id}" style="color:#ef4444">🗑</button>
            </div>
          </div>`;
      }).join('');
    };

    const load = async () => {
      try {
        loading(true);
        const d = await api('/api/inventory/list');
        render(d);
      } catch(e){ toast(e.message || 'Ошибка', 'error'); }
      finally { loading(false); }
    };

    document.getElementById('caseInvRefresh')?.addEventListener('click', e => { e.preventDefault(); load(); });
    document.getElementById('caseInvClose')?.addEventListener('click', e => { e.preventDefault(); closeModal(); });
    list?.addEventListener('click', async e => {
      const btn = e.target?.closest?.('[data-action]'); if (!btn) return;
      const action = btn.dataset.action;
      const id = Number(btn.dataset.id || 0); if (!id) return;
      try {
        loading(true);
        if (action === 'use'){
          const res = await api('/api/inventory/use', { method:'POST', body:{ id } });
          toast(`✅ Активировано: ${casePrizeLabel(res.prize)}`, 'success');
          playCaseWinSfx(casePrizeTier(res.prize));
          await checkAuth();
        } else {
          await api('/api/inventory/delete', { method:'POST', body:{ id } });
          toast('Удалено', 'success');
        }
        await load();
      } catch(err){ toast(err.message || 'Ошибка', 'error'); }
      finally { loading(false); }
    });
    await load();
  }

  function _caseEmoji(id){ return {free:'🎁',paid:'💎',money:'💸'}[id] || '🎰'; }
  function _formatWhenNext(iso){
    if (!iso) return '';
    const d = new Date(iso);
    return isFinite(d.getTime()) ? d.toLocaleString('ru') : '';
  }

  // ── Main Roulette Modal ───────────────────────────────────
  async function showCaseRoulette(caseId){
    if (!state.user) return showLogin();
    let cfg;
    try { cfg = await ensureCaseConfig(); }
    catch(e){ return toast(e.message || 'Ошибка загрузки', 'error'); }

    const c = (cfg?.cases || []).find(x => x.id === caseId);
    if (!c) return toast('Кейс не найден', 'error');

    const lim = state.user?.limits || {};
    const nextKey = (caseId === 'money') ? 'case_money_next_at' : 'case_next_at';
    const nextAt = lim[nextKey] || null;
    const invFull = (lim.case_inv_count || 0) >= (lim.case_inv_max || 3);
    const ready = !invFull && (!nextAt || (Date.now() >= new Date(nextAt + (nextAt.includes('Z') ? '' : 'Z')).getTime()));

    // Build prize pills
    const prizeHtml = (c.prizes || []).slice(0, 8).map(p =>
      `<div class="case-prize-pill t${p.tier}" title="${p.label}">${escapeHtml(p.label)}</div>`
    ).join('');

    modal(`
      <div style="text-align:center;margin-bottom:4px">
        <div style="font-size:32px;margin-bottom:4px">${_caseEmoji(caseId)}</div>
        <h2 style="margin:0 0 4px;font-size:20px;font-weight:900">${escapeHtml(c.title||'Кейс')}</h2>
        <div style="font-size:13px;color:var(--text-muted)">${escapeHtml(c.desc||'')}</div>
      </div>

      <div class="case-prize-list">${prizeHtml}</div>

      <div class="case-roulette">
        <div class="case-roulette-pointer"></div>
        <div class="case-roulette-window">
          <div class="case-roulette-track" id="caseTrack"></div>
        </div>
      </div>

      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-primary" id="caseOpenBtn" style="flex:2;font-size:15px;font-weight:800;padding:12px" ${ready ? '' : 'disabled'}>
          ${c.price ? `🎰 Открыть за ${fmtCurrency(c.price)}` : '🎰 Открыть бесплатно'}
        </button>
        <button class="btn btn-secondary" id="caseInvBtn" style="flex:1">🎒 Инвентарь</button>
      </div>
      <div id="caseCooldownHint" style="text-align:center;margin-top:10px;font-size:12px;color:var(--text-muted)">
        ${invFull ? '🎒 <b style="color:#ef4444">Инвентарь полон — примените или удалите предметы</b>' : ready ? '✅ Готово к открытию' : `⏰ Можно открыть: <b>${escapeHtml(_formatWhenNext(nextAt))}</b>`}
      </div>
      <div style="display:flex;justify-content:center;gap:16px;margin-top:8px;font-size:11px;color:var(--text-muted)">
        ${c.price ? `<span>📅 Сегодня: <b>${lim.case_paid_today||0}/${lim.case_paid_daily_limit||2}</b></span>` : ''}
        <span>🎒 Инвентарь: <b>${lim.case_inv_count||0}/${lim.case_inv_max||3}</b></span>
      </div>
    `, { size:'wide' });

    document.getElementById('caseInvBtn')?.addEventListener('click', e => {
      e.preventDefault(); closeModal(); showCaseInventory();
    });

    const track = document.getElementById('caseTrack');
    const openBtn = document.getElementById('caseOpenBtn');
    const hint = document.getElementById('caseCooldownHint');
    const ITEM_W = 168; // 158px + 10px gap

    // Fill initial display reel
    const fillReel = (pool, count = 22) => {
      if (!track) return;
      const items = Array.from({length: count}, () => pool[Math.floor(Math.random() * pool.length)]);
      track.innerHTML = items.map(code => {
        const t = casePrizeTier(code);
        const emo = RARITY_EMOJIS[t] || '⭐';
        const rName = RARITY_NAMES[t] || 'Common';
        return `<div class="case-item tier-${t}">
          <div class="case-item-icon">${emo}</div>
          <div class="case-item-title">${escapeHtml(casePrizeLabel(code))}</div>
          <div class="case-item-rarity" style="color:${RARITY_COLORS[t]}">${rName}</div>
        </div>`;
      }).join('');
      track.style.transition = 'none';
      track.style.transform = 'translate3d(0,0,0)';
    };

    const pool = (c.prizes || []).map(p => p.code);
    fillReel(pool);

    // ── SPIN ──────────────────────────────────────────────
    openBtn?.addEventListener('click', async e => {
      e.preventDefault();
      if (!state.user) return showLogin();
      if (openBtn.disabled) return;

      try {
        openBtn.disabled = true;
        if (hint) hint.textContent = '🎲 Крутим...';

        // Unlock AudioContext on user gesture
        try { const ac = _audio(); if (ac?.state === 'suspended') await ac.resume(); } catch(_){}

        loading(true);
        const res = await api('/api/cases/spin', { method:'POST', body:{ case_id: caseId } });
        loading(false);

        // Update balance immediately
        if (res.balance !== undefined && state.user){
          state.user.balance = res.balance;
          _applyBalance(res.balance);
        }

        const reel = res.reel || [];
        const winIndex = Number(res.win_index || 0);
        const win = res.win || {};
        const winTier = Number(win.tier || 1);

        if (!track || !reel.length){ 
          showCaseResultModal(win.code, { subtitle: 'Приз начислен!' });
          await checkAuth();
          return;
        }

        // Build visual reel from server data
        track.innerHTML = reel.map((code, i) => {
          const t = casePrizeTier(code);
          const emo = RARITY_EMOJIS[t] || '⭐';
          const rName = RARITY_NAMES[t] || 'Common';
          return `<div class="case-item tier-${t}" data-reel-idx="${i}">
            <div class="case-item-icon">${emo}</div>
            <div class="case-item-title">${escapeHtml(casePrizeLabel(code))}</div>
            <div class="case-item-rarity" style="color:${RARITY_COLORS[t]}">${rName}</div>
          </div>`;
        }).join('');

        // Calculate scroll target using actual DOM measurement
        const windowEl = track.parentElement;
        const windowCenter = (windowEl?.clientWidth || 640) / 2;
        // Measure actual position of winning element
        void track.offsetHeight; // ensure layout
        const winEl = track.children[winIndex];
        let target;
        if (winEl) {
          const winCenter = winEl.offsetLeft + winEl.offsetWidth / 2;
          // We need to scroll so winCenter aligns with windowCenter
          // Track padding already positions item 0 near center,
          // so target = winCenter - windowCenter
          target = Math.max(0, Math.round(winCenter - windowCenter));
        } else {
          target = winIndex * ITEM_W;
        }
        // Add small random offset so it doesn't land perfectly center (more realistic)
        target += Math.round((Math.random() - 0.5) * 30);

        track.style.transition = 'none';
        track.style.transform = 'translate3d(0,0,0)';
        void track.offsetHeight; // reflow

        // Synchronised tick sounds — tick when a new card crosses center
        let lastTickIdx = -1;
        let spinStart = performance.now();
        const SPIN_DUR = 5200; // ms

        const tickLoop = () => {
          if (!track || track.dataset.stopped) return;
          const elapsed = performance.now() - spinStart;
          const progress = Math.min(1, elapsed / SPIN_DUR);

          // Current scroll position via matrix
          const m = new DOMMatrix(getComputedStyle(track).transform);
          const scrollX = Math.abs(m.m41);
          const idx = Math.floor(scrollX / ITEM_W);

          if (idx !== lastTickIdx){
            lastTickIdx = idx;
            // Volume and pitch scale with progress (higher pitch near end)
            _playCaseTick(progress);
          }
          if (progress < 1) requestAnimationFrame(tickLoop);
        };
        requestAnimationFrame(tickLoop);
        spinStart = performance.now();

        // Start animation
        requestAnimationFrame(() => {
          track.style.transition = `transform ${SPIN_DUR/1000}s cubic-bezier(0.05, 0.85, 0.10, 1.00)`;
          track.style.transform = `translate3d(${-target}px,0,0)`;
        });

        // On finish
        track.addEventListener('transitionend', async () => {
          track.dataset.stopped = '1';

          // Highlight winning card
          const winCard = track.querySelector(`[data-reel-idx="${winIndex}"]`);
          if (winCard){
            winCard.classList.add('case-item-win');
            // Brief pause to see the winner
            await new Promise(r => setTimeout(r, 650));
          }

          closeModal();
          showCaseResultModal(win.code, {
            title: `${_caseEmoji(caseId)} ${c.title}`,
            subtitle: winTier >= 4 ? '🎊 НЕВЕРОЯТНАЯ УДАЧА! Приз начислен!' :
                      winTier === 3 ? '🎉 Отличный приз! Добавлен в инвентарь.' :
                      'Приз добавлен в инвентарь.',
          });
          await checkAuth();
        }, { once: true });

      } catch(err){
        loading(false);
        openBtn.disabled = false;
        if (hint) hint.textContent = '❌ Ошибка. Попробуй ещё раз.';
        toast(err.message || 'Ошибка', 'error');
      }
    });
  }

  // ════════════════════════════════════════════════════════
  // SETTINGS FUNCTIONS (called from profile settings tab HTML)
  // ════════════════════════════════════════════════════════
  window._saveSetting = async function(key, value) {
    // Store in localStorage for UI preferences
    try { localStorage.setItem('rbx_setting_' + key, JSON.stringify(value)); } catch(e) {}
    // Could also POST to /api/user/settings if needed
  };

  window._changePassword = async function() {
    const old_ = document.getElementById('settingsSecOldPwd')?.value?.trim();
    const new1 = document.getElementById('settingsSecNewPwd')?.value?.trim();
    if (!old_ || !new1) return toast('Заполните оба поля', 'warning');
    if (new1.length < 6) return toast('Пароль мин. 6 символов', 'warning');
    const btn = document.querySelector('[onclick="window._changePassword()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
    try {
      await api('/api/security/password', { method: 'POST', body: { current: old_, new: new1, new2: new1 } });
      toast('✅ Пароль изменён!', 'success');
      if (document.getElementById('settingsSecOldPwd')) document.getElementById('settingsSecOldPwd').value = '';
      if (document.getElementById('settingsSecNewPwd')) document.getElementById('settingsSecNewPwd').value = '';
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Сменить пароль'; } }
  };

  window._changeEmail = async function() {
    const newEmail = document.getElementById('settingsNewEmail')?.value?.trim();
    if (!newEmail) return toast('Введите новый email', 'warning');
    const pwd = prompt('Введите текущий пароль для подтверждения:');
    if (!pwd) return;
    try {
      await api('/api/security/email_start', { method: 'POST', body: { new_email: newEmail, password: pwd } });
      toast('📧 Код подтверждения отправлен на ' + newEmail, 'success');
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
  };

  window._toggle2faEmail = async function() {
    const btn = document.getElementById('btn2faEmail');
    const isOn = state.user?.twofa_email_enabled;
    try {
      await api('/api/security/2fa_email', { method: 'POST', body: { enabled: !isOn } });
      if (state.user) state.user.twofa_email_enabled = isOn ? 0 : 1;
      toast(isOn ? '2FA отключена' : '🛡 2FA включена', 'success');
      if (btn) btn.style.background = isOn ? '' : 'var(--accent-primary)';
      const status = document.getElementById('twofa2Status');
      if (status) status.textContent = isOn ? '' : '✅ 2FA активна';
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
  };

    // ════════════════════════════════════════════════════════
  // PURCHASES POPUP (from avatar dropdown)
  // ════════════════════════════════════════════════════════
  async function showPurchasesPopup() {
    if (!state.user) return showLogin();
    modal(`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(168,85,247,0.12);display:flex;align-items:center;justify-content:center;font-size:18px">🛍</div>
        <h2 style="margin:0;font-size:18px;font-weight:800">Мои покупки</h2>
      </div>
      <div id="purchasesPopupBody" style="min-height:${_PUR_FIXED_H}px;display:flex;align-items:center;justify-content:center"><div class="spinner"></div></div>
    `, { size: 'wide' });
    try {
      const d = await api('/api/purchases');
      const purchases = d.purchases || [];
      const body = document.getElementById('purchasesPopupBody');
      if (!body) return;
      body.style.display = '';
      body.style.alignItems = '';
      body.style.justifyContent = '';
      _renderPurchasesInto(body, purchases, 0, 'in', 'purPop');
    } catch(e) {
      const body = document.getElementById('purchasesPopupBody');
      if (body) body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Ошибка загрузки</div>';
    }
  }

  // ════════════════════════════════════════════════════════
  // SETTINGS POPUP (from avatar dropdown)
  // ════════════════════════════════════════════════════════
  function showSettingsPopup() {
    if (!state.user) return showLogin();
    const u = state.user;
    const is2fa = u.twofa_email_enabled;
    const savedLang = localStorage.getItem('rst_lang') || 'ru';
    const savedTz = localStorage.getItem('rst_tz') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
    const savedAccent = localStorage.getItem('rst_accent') || 'purple';
    const savedRadius = localStorage.getItem('rst_radius') || 'default';
    const savedTheme = localStorage.getItem('rst_theme') || 'dark';
    const savedLayout = localStorage.getItem('rst_layout') || 'classic';

    const tzList = ['Europe/Moscow','Europe/Samara','Asia/Yekaterinburg','Asia/Omsk','Asia/Krasnoyarsk','Asia/Irkutsk','Asia/Yakutsk','Asia/Vladivostok','Asia/Magadan','Asia/Kamchatka','Europe/Kaliningrad','Europe/Minsk','Europe/Kiev','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','Asia/Tokyo','Asia/Shanghai','Asia/Kolkata','UTC'];
    const tzOpts = tzList.map(tz => `<option value="${tz}" ${tz===savedTz?'selected':''}>${tz.replace(/_/g,' ')}</option>`).join('');

    // Inject toggle styles once (was previously embedded inside <label> which is invalid HTML)
    if (!document.getElementById('s-toggle-styles')) {
      const _st = document.createElement('style'); _st.id = 's-toggle-styles';
      _st.textContent = `.s-toggle-label{position:relative;display:inline-block;width:42px;height:24px;cursor:pointer;flex-shrink:0}
.s-toggle-input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:2}
.s-slider{position:absolute;inset:0;border-radius:24px;background:rgba(255,255,255,0.12);transition:background .25s;pointer-events:none}
.s-slider-knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .25s;box-shadow:0 1px 4px rgba(0,0,0,.3);display:block}
.s-toggle-input:checked ~ .s-slider{background:var(--accent-primary)}
.s-toggle-input:checked ~ .s-slider .s-slider-knob{left:21px}`;
      document.head.appendChild(_st);
    }
    const _toggle = (id, checked) => `<label class="s-toggle-label">
      <input type="checkbox" id="${id}" ${checked?'checked':''} class="s-toggle-input">
      <span class="s-slider"><span class="s-slider-knob"></span></span>
    </label>`;

    const _row = (label, sub, right) => `<div class="s-row">
      <div class="s-row-text"><div class="s-row-label">${label}</div><div class="s-row-sub">${sub}</div></div>
      <div class="s-row-right">${right}</div>
    </div>`;

    const accentColors = [
      {id:'purple', label:'Фиолет', color:'#7c3aed'},
      {id:'blue',   label:'Синий',  color:'#2563eb'},
      {id:'cyan',   label:'Циан',   color:'#0891b2'},
      {id:'green',  label:'Зелёный',color:'#16a34a'},
      {id:'orange', label:'Оранж',  color:'#ea580c'},
      {id:'pink',   label:'Розовый',color:'#db2777'},
    ];

    // Hide global modal close button (settings has its own)
    const globalClose = document.getElementById('modalClose');
    if (globalClose) globalClose.style.display = 'none';
    modal(`
      <div class="s-modal-inner">
        <div class="s-modal-header">
          <div class="s-modal-title">⚙️ Настройки</div>
          <button class="btn btn-ghost btn-sm s-modal-close" onclick="closeModal()">✕</button>
        </div>

        <!-- Tabs -->
        <div class="s-tabs-wrap" id="sTabs">
          <div class="s-tab-indicator" id="sTabIndicator"></div>
          <button class="s-tab active" data-stab="general">🌐 Общие</button>
          <button class="s-tab" data-stab="security">🔒 Безопасность</button>
          <button class="s-tab" data-stab="notif">🔔 Уведомления</button>
          <button class="s-tab" data-stab="design">🎨 Оформление</button>
        </div>

        <!-- Pane container with fixed height for no-jump -->
        <div class="s-panes-wrap" id="sPanesWrap" style="position:relative;overflow:hidden;height:390px">

          <!-- General -->
          <div class="s-pane active" data-spane="general" style="overflow-y:auto;height:100%;padding-right:2px">
            <div class="s-profile-card">
              <div class="s-avatar">${escapeHtml((u.username||'?')[0].toUpperCase())}</div>
              <div>
                <div class="s-profile-name">${escapeHtml(u.username||'')}</div>
                <div class="s-profile-email">${escapeHtml(u.email||'Email не указан')}</div>
              </div>
            </div>
            ${_row('Язык интерфейса', 'Выбор языка и валюты',
              `<select id="sLang" class="form-input s-select">
                <option value="ru" ${savedLang==='ru'?'selected':''}>🇷🇺 Русский (₽)</option>
                <option value="en" ${savedLang==='en'?'selected':''}>🇬🇧 English ($)</option>
              </select>`
            )}
            ${_row('Предотвратить закрытие окон', 'Клик в пустую область не закрывает модальные окна',
              _toggle('sPreventCloseToggle', localStorage.getItem('rst_prevent_close') === '1')
            )}
            ${_row('Звуковые эффекты', 'Звук при загрузке и взаимодействиях',
              _toggle('sSoundToggle', localStorage.getItem('rst_sound') !== '0')
            )}
          </div>

          <!-- Security -->
          <div class="s-pane" data-spane="security" style="display:none;overflow-y:auto;height:100%;padding-right:2px">
            <div class="s-section-title">🔑 Смена пароля</div>
            <input class="form-input s-input" id="sOldPwd" type="password" placeholder="Текущий пароль">
            <input class="form-input s-input" id="sNewPwd" type="password" placeholder="Новый пароль (мин. 6)">
            <input class="form-input s-input" id="sNewPwd2" type="password" placeholder="Повторите новый пароль">
            <button class="btn btn-primary s-btn-full" id="sBtnPwd">Сменить пароль</button>

            <div class="s-divider"></div>
            <div class="s-section-title">✉️ Смена Email</div>
            <div class="s-hint">Текущий: <b>${escapeHtml(u.email||'—')}</b></div>
            <input class="form-input s-input" id="sNewEmail" type="email" placeholder="Новый email">
            <input class="form-input s-input" id="sEmailPwd" type="password" placeholder="Пароль для подтверждения">
            <button class="btn btn-primary s-btn-full" id="sBtnEmail">Сменить Email</button>

            <div class="s-divider"></div>
            ${_row('2FA по Email', 'Код подтверждения при каждом входе', _toggle('s2faToggle', is2fa))}

            <div class="s-divider"></div>
            <button class="btn btn-ghost s-btn-full s-btn-danger" id="sBtnLogoutAll">⚠ Выйти на всех устройствах</button>
            <div style="height:8px"></div>
          </div>

          <!-- Notifications -->
          <div class="s-pane" data-spane="notif" style="display:none;overflow-y:auto;height:100%;padding-right:2px">
            ${_row('Email-рассылка', 'Новости, акции и спецпредложения', _toggle('sNotifMail', false))}
            ${_row('Push-уведомления', 'Уведомления в браузере', `<span class="s-badge-soon">Скоро</span>`)}
            ${_row('Уведомления о заказах', 'Email после каждой покупки', _toggle('sNotifOrders', true))}
          </div>

          <!-- Design -->
          <div class="s-pane" data-spane="design" style="display:none;overflow-y:auto;height:100%;padding-right:2px">
            <div class="s-section-title">🎨 Акцентный цвет</div>
            <div class="s-accent-grid" id="sAccentGrid">
              ${accentColors.map(c => `
                <button class="s-accent-btn ${savedAccent===c.id?'active':''}" data-accent="${c.id}" style="--ac:${c.color}">
                  <span class="s-accent-swatch" style="background:${c.color}"></span>
                  <span>${c.label}</span>
                </button>
              `).join('')}
              <button class="s-accent-btn ${savedAccent==='custom'?'active':''}" data-accent="custom" style="--ac:${localStorage.getItem('rst_accent_custom')||'#7c3aed'}">
                <span class="s-accent-swatch" style="background:conic-gradient(red,yellow,lime,aqua,blue,magenta,red);border:2px solid rgba(255,255,255,.15)"></span>
                <span>Свой</span>
              </button>
            </div>
            <div id="sCustomColorWrap" style="display:${savedAccent==='custom'?'flex':'none'};align-items:center;gap:10px;margin-top:8px;padding:8px 12px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.06)">
              <input type="color" id="sCustomColorInput" value="${localStorage.getItem('rst_accent_custom')||'#7c3aed'}" style="width:40px;height:32px;border:none;border-radius:8px;cursor:pointer;background:transparent">
              <span style="font-size:12px;color:var(--text-secondary)">Выбери любой цвет</span>
            </div>

            <div class="s-divider"></div>
            <div class="s-section-title">📐 Закруглённость</div>
            <div class="s-radius-row">
              <button class="s-radius-btn ${savedRadius==='sharp'?'active':''}" data-radius="sharp">▪ Острые</button>
              <button class="s-radius-btn ${savedRadius==='default'?'active':''}" data-radius="default">◼ Стандарт</button>
              <button class="s-radius-btn ${savedRadius==='round'?'active':''}" data-radius="round">● Круглые</button>
            </div>

            <div class="s-divider"></div>
            <div class="s-section-title">🌙 Тема оформления</div>
            <div class="s-radius-row" id="sThemeRow" style="flex-wrap:wrap">
              <button class="s-radius-btn ${savedTheme==='dark'?'active':''}" data-theme="dark">🌑 Дефолт</button>
              <button class="s-radius-btn ${savedTheme==='glass'?'active':''}" data-theme="glass">🧊 Стекло</button>
              <button class="s-radius-btn ${savedTheme==='neon'?'active':''}" data-theme="neon">💜 Неон</button>
              <button class="s-radius-btn ${savedTheme==='v3'?'active':''}" data-theme="v3">🎮 V3 Gaming</button>
            </div>

            <div class="s-divider"></div>
            <div class="s-section-title">🖥 Интерфейс</div>
            <div class="s-radius-row" id="sLayoutRow">
              <button class="s-radius-btn ${savedLayout==='classic'?'active':''}" data-layout="classic">🏠 Классик</button>
              <button class="s-radius-btn ${savedLayout==='dashboard'?'active':''}" data-layout="dashboard">📊 Dashboard</button>
              <button class="s-radius-btn ${savedLayout==='landing'?'active':''}" data-layout="landing">🌌 Landing</button>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:8px;padding:0 2px">
              ${savedLayout==='dashboard'?'📊 Боковая панель слева, плотная сетка':''}
              ${savedLayout==='landing'?'🌌 Landing — полный редизайн сайта в стиле лендинга с частицами и анимациями':''}
              ${savedLayout==='classic'?'🏠 Стандартный интерфейс':''}
            </div>

            <div class="s-divider"></div>
            ${_row('Анимации', 'Плавные переходы и эффекты', _toggle('sAnimToggle', true))}
            <div class="s-divider"></div>
            <div class="s-section-title">🛍 Магазин</div>
            ${_row('Расширенный интерфейс (Beta+)', 'Визуальные карточки с анимацией и эффектами', _toggle('sShopBetaToggle', localStorage.getItem('rst_shop_beta') !== '0'))}
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;padding:0 2px">Перезагрузит магазин для применения</div>
            <div class="s-divider"></div>
            <div class="s-section-title">🎬 Загрузочный экран</div>
            ${_row('Пропустить загрузку', 'Сразу показать сайт без splash-экрана', _toggle('sSkipSplash', localStorage.getItem('rst_skip_splash')==='1'))}
            ${_row('Звук при загрузке', 'Музыка и эффекты на загрузочном экране', _toggle('sSplashSound', localStorage.getItem('rst_splash_mute')!=='1'))}
            <div style="height:8px"></div>
          </div>

        </div><!-- /s-panes-wrap -->
      </div>
    `, { size: 'wide' });

    // ── Position indicator under active tab ──
    function _positionIndicator() {
      const activeTab = document.querySelector('#sTabs .s-tab.active');
      const indicator = document.getElementById('sTabIndicator');
      const wrap = document.getElementById('sTabs');
      if (!activeTab || !indicator || !wrap) return;
      const wRect = wrap.getBoundingClientRect();
      const tRect = activeTab.getBoundingClientRect();
      indicator.style.width = tRect.width + 'px';
      indicator.style.left = (tRect.left - wRect.left) + 'px';
    }

    // ── Tab switch with swipe ──
    let _currentTab = 'general';
    const tabOrder = ['general','security','notif','design'];

    function _switchSettingsTab(newTab) {
      const fromIdx = tabOrder.indexOf(_currentTab);
      const toIdx = tabOrder.indexOf(newTab);
      if (fromIdx === toIdx) return;
      const dir = toIdx > fromIdx ? 1 : -1;

      const fromPane = document.querySelector(`.s-pane[data-spane="${_currentTab}"]`);
      const toPane = document.querySelector(`.s-pane[data-spane="${newTab}"]`);
      if (!fromPane || !toPane) return;

      // Prepare toPane off-screen
      toPane.style.display = '';
      toPane.style.position = 'absolute';
      toPane.style.top = '0'; toPane.style.left = '0'; toPane.style.right = '0';
      toPane.style.transform = `translateX(${dir * 100}%)`;
      toPane.style.opacity = '0';
      toPane.style.transition = 'none';

      requestAnimationFrame(() => {
        fromPane.style.transition = 'transform 0.28s cubic-bezier(0.4,0,0.2,1), opacity 0.28s';
        fromPane.style.position = 'absolute';
        fromPane.style.top = '0'; fromPane.style.left = '0'; fromPane.style.right = '0';
        toPane.style.transition = 'transform 0.28s cubic-bezier(0.4,0,0.2,1), opacity 0.28s';
        fromPane.style.transform = `translateX(${-dir * 35}%)`;
        fromPane.style.opacity = '0';
        toPane.style.transform = 'translateX(0)';
        toPane.style.opacity = '1';

        setTimeout(() => {
          fromPane.style.display = 'none';
          fromPane.style.position = '';
          fromPane.style.transform = '';
          fromPane.style.opacity = '';
          fromPane.style.transition = '';
          toPane.style.position = '';
          toPane.style.transition = '';
          fromPane.classList.remove('active');
          toPane.classList.add('active');
          _currentTab = newTab;
        }, 290);
      });

      // Update tab buttons
      document.querySelectorAll('#sTabs .s-tab').forEach(b => b.classList.toggle('active', b.dataset.stab === newTab));
      setTimeout(_positionIndicator, 0);
    }

    document.querySelectorAll('#sTabs .s-tab').forEach(btn => {
      btn.addEventListener('click', () => _switchSettingsTab(btn.dataset.stab));
    });
    setTimeout(_positionIndicator, 50);

    // ── General: language with real reload + auto currency ──
    document.getElementById('sLang')?.addEventListener('change', e => {
      const lang = e.target.value;
      localStorage.setItem('rst_lang', lang);
      // Auto-set currency based on language
      localStorage.setItem('rst_currency', lang === 'en' ? 'usd' : 'rub');
      localStorage.setItem('rst_exchange_rate', lang === 'en' ? '0.011' : '1');
      toast(lang === 'en' ? '🌐 Language changed — reloading...' : '🌐 Язык изменён — перезагружаем...', 'success');
      setTimeout(() => location.reload(), 900);
    });

    // Old timezone override removed — we now always use the device timezone.
    try { localStorage.removeItem('rst_tz'); } catch(_){}

    document.getElementById('sPreventCloseToggle')?.addEventListener('change', e => {
      localStorage.setItem('rst_prevent_close', e.target.checked ? '1' : '0');
      toast(e.target.checked ? 'Закрытие по клику отключено' : 'Закрытие по клику включено', 'success');
    });

    document.getElementById('sSoundToggle')?.addEventListener('change', e => {
      localStorage.setItem('rst_sound', e.target.checked ? '1' : '0');
      toast(e.target.checked ? '🔊 Звук включён' : '🔇 Звук выключен', 'success');
    });

    // ── Security ──
    document.getElementById('sBtnPwd')?.addEventListener('click', async () => {
      const btn = document.getElementById('sBtnPwd');
      const old_ = document.getElementById('sOldPwd')?.value?.trim();
      const new1 = document.getElementById('sNewPwd')?.value?.trim();
      const new2 = document.getElementById('sNewPwd2')?.value?.trim();
      if (!old_ || !new1 || !new2) return toast('Заполните все поля', 'warning');
      if (new1 !== new2) return toast('Пароли не совпадают', 'warning');
      if (new1.length < 6) return toast('Пароль слишком короткий (мин. 6 символов)', 'warning');
      btn.disabled = true; btn.textContent = '⏳...';
      try {
        await api('/api/security/password', { method: 'POST', body: { current: old_, new: new1, new2: new2 } });
        toast('✅ Пароль изменён!', 'success');
        ['sOldPwd','sNewPwd','sNewPwd2'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
      } catch(e) { toast(e.message || 'Ошибка', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Сменить пароль'; }
    });

    document.getElementById('sBtnEmail')?.addEventListener('click', async () => {
      const btn = document.getElementById('sBtnEmail');
      const newEmail = document.getElementById('sNewEmail')?.value?.trim();
      const pwd = document.getElementById('sEmailPwd')?.value?.trim();
      if (!newEmail || !pwd) return toast('Заполните все поля', 'warning');
      btn.disabled = true; btn.textContent = '⏳...';
      try {
        await api('/api/security/email_start', { method: 'POST', body: { new_email: newEmail, password: pwd } });
        toast('📧 Код подтверждения отправлен на ' + newEmail, 'success');
      } catch(e) { toast(e.message || 'Ошибка', 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Сменить Email'; }
    });

    const tgl = document.getElementById('s2faToggle');
    tgl?.addEventListener('change', async () => {
      const enabled = tgl.checked;
      const slider = tgl.parentElement?.querySelector('.s-slider');
      if (slider) { slider.style.background = enabled ? 'var(--accent-primary)' : 'rgba(255,255,255,0.12)'; const knob = slider.querySelector('span'); if(knob) knob.style.left = enabled ? '21px' : '3px'; }
      try {
        await api('/api/security/2fa_email', { method: 'POST', body: { enabled } });
        if (state.user) state.user.twofa_email_enabled = enabled ? 1 : 0;
        toast(enabled ? '🛡 2FA включена' : '2FA отключена', 'success');
      } catch(e) {
        toast(e.message || 'Ошибка', 'error'); tgl.checked = !enabled;
        if (slider) { slider.style.background = !enabled ? 'var(--accent-primary)' : 'rgba(255,255,255,0.12)'; const knob = slider.querySelector('span'); if(knob) knob.style.left = !enabled ? '21px' : '3px'; }
      }
    });

    document.getElementById('sBtnLogoutAll')?.addEventListener('click', async () => {
      if (!confirm('Выйти на всех устройствах?')) return;
      try { await api('/api/auth/logout', { method: 'POST' }); } catch(_) {}
      closeModal(); location.reload();
    });

    // ── Design ──
    document.querySelectorAll('#sAccentGrid .s-accent-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sAccentGrid .s-accent-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const accent = btn.dataset.accent;
        localStorage.setItem('rst_accent', accent);
        // Show/hide custom color picker
        const cw = document.getElementById('sCustomColorWrap');
        if (cw) cw.style.display = accent === 'custom' ? 'flex' : 'none';
        _applyAccentColor(accent);
        toast('🎨 Цвет применён', 'success');
      });
    });

    // Custom color picker
    document.getElementById('sCustomColorInput')?.addEventListener('input', (e) => {
      const hex = e.target.value;
      localStorage.setItem('rst_accent_custom', hex);
      localStorage.setItem('rst_accent', 'custom');
      _applyAccentColor('custom');
    });

    document.querySelectorAll('#sPanesWrap [data-radius]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sPanesWrap [data-radius]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        localStorage.setItem('rst_radius', btn.dataset.radius);
        _applyRadius(btn.dataset.radius);
        toast('📐 Стиль применён', 'success');
      });
    });

    document.querySelectorAll('#sThemeRow [data-theme]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sThemeRow [data-theme]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        localStorage.setItem('rst_theme', btn.dataset.theme);
        _applyTheme(btn.dataset.theme);
        toast('🌙 Тема применена', 'success');
      });
    });

    document.querySelectorAll('#sLayoutRow [data-layout]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sLayoutRow [data-layout]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const layout = btn.dataset.layout;
        localStorage.setItem('rst_layout', layout);
        _applyLayout(layout);
        const labels = { classic:'🏠 Классический интерфейс', dashboard:'📊 Dashboard — боковая панель', landing:'🌌 Landing — полный редизайн' };
        toast(labels[layout] || '🖥 Интерфейс изменён', 'success');
      });
    });

    // ── Shop Beta toggle ──
    const shopBetaTgl = document.getElementById('sShopBetaToggle');
    shopBetaTgl?.addEventListener('change', () => {
      const enabled = shopBetaTgl.checked;
      const slider = shopBetaTgl.parentElement?.querySelector('.s-slider');
      if (slider) {
        slider.style.background = enabled ? 'var(--accent-primary)' : 'rgba(255,255,255,0.12)';
        const knob = slider.querySelector('span');
        if (knob) knob.style.left = enabled ? '21px' : '3px';
      }
      localStorage.setItem('rst_shop_beta', enabled ? '1' : '0');      toast(enabled ? '🛍 Beta-магазин включён' : '🛍 Классический магазин', 'success');
      // Re-render shop if it's currently visible
      if (state.ui?.tab === 'shop') setTimeout(renderShop, 200);
    });

    // Skip splash toggle
    const _skipEl = document.getElementById('sSkipSplash');
    if (_skipEl) {
      _skipEl.addEventListener('change', function() {
        localStorage.setItem('rst_skip_splash', _skipEl.checked ? '1' : '0');
        toast(_skipEl.checked ? '⏩ Загрузка будет пропущена' : '🎬 Загрузочный экран включён', 'success');
      });
    }
    // Splash sound toggle
    const _sndEl = document.getElementById('sSplashSound');
    if (_sndEl) {
      _sndEl.addEventListener('change', function() {
        localStorage.setItem('rst_splash_mute', _sndEl.checked ? '0' : '1');
        toast(_sndEl.checked ? '🔊 Звук загрузки включён' : '🔇 Звук загрузки выключен', 'success');
      });
    }
  }

  function _applyAccentColor(accent) {
    const accentMap = {
      purple: { primary: '#9333ea', secondary: '#7c3aed', tertiary: '#c084fc', gradient: 'linear-gradient(135deg,#7c3aed 0%,#9333ea 50%,#c084fc 100%)', glow: 'rgba(147,51,234,0.45)', rgb: '147,51,234' },
      blue:   { primary: '#3b82f6', secondary: '#2563eb', tertiary: '#93c5fd', gradient: 'linear-gradient(135deg,#2563eb,#3b82f6,#93c5fd)', glow: 'rgba(59,130,246,0.45)', rgb: '59,130,246' },
      cyan:   { primary: '#06b6d4', secondary: '#0891b2', tertiary: '#67e8f9', gradient: 'linear-gradient(135deg,#0891b2,#06b6d4,#67e8f9)', glow: 'rgba(6,182,212,0.45)', rgb: '6,182,212' },
      green:  { primary: '#22c55e', secondary: '#16a34a', tertiary: '#86efac', gradient: 'linear-gradient(135deg,#16a34a,#22c55e,#86efac)', glow: 'rgba(34,197,94,0.45)', rgb: '34,197,94' },
      orange: { primary: '#f97316', secondary: '#ea580c', tertiary: '#fdba74', gradient: 'linear-gradient(135deg,#ea580c,#f97316,#fdba74)', glow: 'rgba(249,115,22,0.45)', rgb: '249,115,22' },
      pink:   { primary: '#ec4899', secondary: '#db2777', tertiary: '#f9a8d4', gradient: 'linear-gradient(135deg,#db2777,#ec4899,#f9a8d4)', glow: 'rgba(236,72,153,0.45)', rgb: '236,72,153' },
    };
    let c;
    if (accent === 'custom') {
      const hex = localStorage.getItem('rst_accent_custom') || '#7c3aed';
      const rr = parseInt(hex.slice(1,3),16), gg = parseInt(hex.slice(3,5),16), bb = parseInt(hex.slice(5,7),16);
      const lighter = `rgb(${Math.min(255,rr+60)},${Math.min(255,gg+60)},${Math.min(255,bb+60)})`;
      const darker = `rgb(${Math.max(0,rr-30)},${Math.max(0,gg-30)},${Math.max(0,bb-30)})`;
      c = { primary: hex, secondary: darker, tertiary: lighter, gradient: `linear-gradient(135deg,${darker},${hex},${lighter})`, glow: `rgba(${rr},${gg},${bb},0.45)`, rgb: `${rr},${gg},${bb}` };
    } else {
      c = accentMap[accent] || accentMap.purple;
    }
    const root = document.documentElement;
    root.style.setProperty('--accent-primary', c.primary);
    root.style.setProperty('--accent-secondary', c.secondary);
    root.style.setProperty('--accent-tertiary', c.tertiary);
    root.style.setProperty('--accent-gradient', c.gradient);
    root.style.setProperty('--accent-glow', c.glow);
    root.style.setProperty('--accent-rgb', c.rgb);
    // Update nav indicator color
    document.getElementById('navIndicator')?.style.setProperty('background', `rgba(${c.rgb},0.15)`);
    document.getElementById('navIndicator')?.style.setProperty('border-color', `rgba(${c.rgb},0.25)`);
  }

  function _applyRadius(radius) {
    const radiusMap = { sharp: { lg: '6px', md: '4px', sm: '3px' }, default: { lg: '16px', md: '10px', sm: '6px' }, round: { lg: '24px', md: '16px', sm: '10px' } };
    const r = radiusMap[radius] || radiusMap.default;
    const root = document.documentElement;
    root.style.setProperty('--radius-lg', r.lg);
    root.style.setProperty('--radius-md', r.md);
    root.style.setProperty('--radius-sm', r.sm);
  }

  function _applyTheme(theme) {
    document.getElementById('theme-style')?.remove();
    document.body.dataset.theme = theme;
    document.documentElement.dataset.theme = theme;

    const themeCSS = {
      dark: '',
      amoled: `
        :root, [data-theme="amoled"] {
          --bg-primary:#000; --bg-secondary:#050508; --bg-tertiary:#0a0a0f;
          --bg-card:rgba(5,5,10,0.95); --bg-card-solid:#06060c; --bg-glass:rgba(255,255,255,0.015);
          --bg-glass-hover:rgba(255,255,255,0.03); --bg-elevated:#0a0a10;
          --border-color:rgba(255,255,255,0.04); --border-hover:rgba(255,255,255,0.08);
        }
        body { background:#000 !important; }
        .header { background:rgba(0,0,0,0.96) !important; border-bottom-color:rgba(255,255,255,0.03) !important; }
        .ambient-orb { opacity:0.1 !important; }
      `,
      dim: `
        :root, [data-theme="dim"] {
          --bg-primary:#1a1b2e; --bg-secondary:#1f2040; --bg-tertiary:#252648;
          --bg-card:rgba(30,32,60,0.85); --bg-card-solid:#1f2040; --bg-glass:rgba(255,255,255,0.04);
          --bg-glass-hover:rgba(255,255,255,0.07); --bg-elevated:#2a2c50;
          --border-color:rgba(var(--accent-rgb),0.12); --border-hover:rgba(var(--accent-rgb),0.25);
        }
        body { background:#1a1b2e !important; }
        .header { background:rgba(20,21,42,0.92) !important; }
        .ambient-orb { opacity:0.25 !important; }
      `,

      glass: `
        /* ═══════════ GLASS — iOS frosted glass ═══════════ */
        :root, [data-theme="glass"] {
          --bg-primary: #080712; --bg-secondary: rgba(255,255,255,0.03);
          --bg-tertiary: rgba(255,255,255,0.05);
          --bg-card: rgba(255,255,255,0.025) !important;
          --bg-card-solid: rgba(16,14,30,0.55);
          --bg-glass: rgba(255,255,255,0.03); --bg-glass-hover: rgba(255,255,255,0.06);
          --bg-elevated: rgba(255,255,255,0.04);
          --border-color: rgba(255,255,255,0.07);
          --border-hover: rgba(255,255,255,0.14);
          --border-glow: rgba(255,255,255,0.2);
        }
        body { background: #080712 !important; }

        /* Vivid orbs = the "wallpaper" behind glass */
        .ambient-orb { opacity: 1 !important; filter: blur(60px) !important; }
        .ambient-orb.orb-1 { background: radial-gradient(circle,rgba(124,58,237,.5),rgba(79,70,229,.25)) !important; width:500px !important; height:500px !important; }
        .ambient-orb.orb-2 { background: radial-gradient(circle,rgba(168,85,247,.35),rgba(236,72,153,.15)) !important; width:450px !important; height:450px !important; }
        .ambient-orb.orb-3 { background: radial-gradient(circle,rgba(99,102,241,.3),rgba(59,130,246,.12)) !important; width:350px !important; height:350px !important; }

        /* ── Frosted glass surfaces ── */
        .hero-card, .feature-card, .review-card, .faq-item, .cta-card,
        .robux-card, .tool-card, .product-card, .stat-card, .admin-stat-card,
        .profile-card, .support-card, .robux-trust-panel, .robux-info-card,
        .analytics-card, .checker-profile-card, .shop-editor-banner,
        .action-card, .sfaq-group, .robux-banner-slot {
          background: rgba(255,255,255,0.06) !important;
          backdrop-filter: blur(40px) saturate(1.8) brightness(1.1) !important;
          -webkit-backdrop-filter: blur(40px) saturate(1.8) brightness(1.1) !important;
          border: 1px solid rgba(255,255,255,0.13) !important;
          border-top-color: rgba(255,255,255,0.22) !important;
          box-shadow: 0 8px 32px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(255,255,255,0.03) !important;
          transition: all .3s ease !important;
        }
        .feature-card:hover, .tool-card:hover, .product-card:hover,
        .review-card:hover, .stat-card:hover, .admin-stat-card:hover,
        .action-card:hover {
          background: rgba(255,255,255,0.09) !important;
          border-color: rgba(255,255,255,0.2) !important;
          border-top-color: rgba(255,255,255,0.3) !important;
          box-shadow: 0 12px 44px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.18) !important;
          transform: translateY(-2px) !important;
        }

        /* ── Header ── */
        .header {
          background: rgba(8,7,20,0.3) !important;
          backdrop-filter: blur(48px) saturate(2) !important;
          -webkit-backdrop-filter: blur(48px) saturate(2) !important;
          border-bottom: 1px solid rgba(255,255,255,0.1) !important;
          box-shadow: 0 4px 30px rgba(0,0,0,0.12), inset 0 -1px 0 rgba(255,255,255,0.04) !important;
        }
        .nav-desktop {
          background: rgba(255,255,255,0.05) !important;
          backdrop-filter: blur(20px) !important;
          border: 1px solid rgba(255,255,255,0.1) !important;
          border-top-color: rgba(255,255,255,0.16) !important;
        }
        .nav-mobile {
          background: rgba(8,7,20,0.35) !important;
          backdrop-filter: blur(36px) saturate(1.8) !important;
          border-top: 1px solid rgba(255,255,255,0.1) !important;
        }

        /* ── Modals ── */
        .modal-overlay { background: rgba(0,0,0,0.18) !important; backdrop-filter: blur(20px) saturate(1.5) !important; }
        .modal-content {
          background: rgba(16,14,32,0.4) !important;
          backdrop-filter: blur(52px) saturate(2.2) brightness(1.05) !important;
          -webkit-backdrop-filter: blur(52px) saturate(2.2) brightness(1.05) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          border-top-color: rgba(255,255,255,0.25) !important;
          box-shadow: 0 24px 80px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.14) !important;
        }
        .user-dropdown, .notif-dropdown {
          background: rgba(16,14,32,0.35) !important;
          backdrop-filter: blur(44px) saturate(2) !important;
          border: 1px solid rgba(255,255,255,0.12) !important;
          border-top-color: rgba(255,255,255,0.2) !important;
        }

        /* ── Inputs & buttons ── */
        .form-input, .pill { background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.1) !important; backdrop-filter: blur(12px) !important; }
        .form-input:focus { border-color: rgba(255,255,255,0.25) !important; box-shadow: 0 0 0 3px rgba(var(--accent-rgb),0.08) !important; }
        .btn-primary { box-shadow: 0 4px 18px rgba(var(--accent-rgb),0.25), inset 0 1px 0 rgba(255,255,255,0.15) !important; }
        .btn-secondary, .quick-btn, .mode-tab { background: rgba(255,255,255,0.04) !important; backdrop-filter: blur(14px) !important; border: 1px solid rgba(255,255,255,0.09) !important; border-top-color: rgba(255,255,255,0.14) !important; }
        .balance-chip { background: rgba(var(--accent-rgb),0.1) !important; backdrop-filter: blur(16px) !important; border: 1px solid rgba(var(--accent-rgb),0.2) !important; }
        .profile-tabs, .purchase-mode-toggle { background: rgba(255,255,255,0.04) !important; backdrop-filter: blur(20px) !important; border: 1px solid rgba(255,255,255,0.09) !important; }
      `,

      neon: `
        /* ═══════════ NEON — glowing accent everywhere ═══════════ */
        :root, [data-theme="neon"] {
          --bg-primary: #050310; --bg-secondary: #08051a;
          --bg-tertiary: #0b0820;
          --bg-card: rgba(8,5,22,0.9) !important;
          --bg-card-solid: #08051a;
          --bg-glass: rgba(var(--accent-rgb),0.02); --bg-glass-hover: rgba(var(--accent-rgb),0.05);
          --bg-elevated: rgba(var(--accent-rgb),0.04);
          --border-color: rgba(var(--accent-rgb),0.15);
          --border-hover: rgba(var(--accent-rgb),0.35);
          --border-glow: rgba(var(--accent-rgb),0.6);
        }
        body { background: #050310 !important; }
        .ambient-orb { opacity: 0.45 !important; }

        .header {
          background: rgba(5,3,16,0.9) !important;
          border-bottom: 1px solid rgba(var(--accent-rgb),0.15) !important;
          box-shadow: 0 0 25px rgba(var(--accent-rgb),0.04) !important;
        }

        .hero-card, .feature-card, .review-card, .faq-item, .cta-card,
        .robux-card, .tool-card, .product-card, .stat-card, .admin-stat-card,
        .profile-card, .support-card, .robux-trust-panel, .robux-info-card,
        .analytics-card, .checker-profile-card, .shop-editor-banner,
        .action-card, .sfaq-group, .robux-banner-slot {
          background: rgba(8,5,22,0.85) !important;
          border: 1px solid rgba(var(--accent-rgb),0.18) !important;
          box-shadow: 0 0 18px rgba(var(--accent-rgb),0.05), 0 4px 20px rgba(0,0,0,0.25) !important;
          transition: all .3s ease !important;
        }
        .feature-card:hover, .tool-card:hover, .product-card:hover,
        .review-card:hover, .stat-card:hover, .admin-stat-card:hover,
        .action-card:hover {
          border-color: rgba(var(--accent-rgb),0.45) !important;
          box-shadow: 0 0 35px rgba(var(--accent-rgb),0.12), 0 0 70px rgba(var(--accent-rgb),0.04), 0 8px 32px rgba(0,0,0,0.3) !important;
          transform: translateY(-3px) !important;
        }

        .nav-desktop {
          background: rgba(var(--accent-rgb),0.04) !important;
          border: 1px solid rgba(var(--accent-rgb),0.12) !important;
          box-shadow: 0 0 12px rgba(var(--accent-rgb),0.03) !important;
        }
        .nav-btn.active { text-shadow: 0 0 8px rgba(var(--accent-rgb),0.3) !important; }
        .nav-mobile {
          background: rgba(5,3,16,0.95) !important;
          border-top: 1px solid rgba(var(--accent-rgb),0.15) !important;
          box-shadow: 0 -4px 20px rgba(var(--accent-rgb),0.03) !important;
        }

        .btn-primary {
          box-shadow: 0 0 22px rgba(var(--accent-rgb),0.35), 0 0 44px rgba(var(--accent-rgb),0.08) !important;
          text-shadow: 0 0 8px rgba(255,255,255,0.2) !important;
        }
        .btn-primary:hover {
          box-shadow: 0 0 32px rgba(var(--accent-rgb),0.5), 0 0 64px rgba(var(--accent-rgb),0.12) !important;
        }

        .form-input, .pill {
          background: rgba(var(--accent-rgb),0.03) !important;
          border: 1px solid rgba(var(--accent-rgb),0.12) !important;
        }
        .form-input:focus {
          border-color: rgba(var(--accent-rgb),0.45) !important;
          box-shadow: 0 0 20px rgba(var(--accent-rgb),0.12), 0 0 4px rgba(var(--accent-rgb),0.25) !important;
        }

        .modal-overlay { background: rgba(2,1,8,0.85) !important; }
        .modal-content {
          background: #08051a !important;
          border: 1px solid rgba(var(--accent-rgb),0.22) !important;
          box-shadow: 0 0 50px rgba(var(--accent-rgb),0.08), 0 20px 60px rgba(0,0,0,0.4) !important;
        }
        .user-dropdown, .notif-dropdown {
          background: #08051a !important;
          border: 1px solid rgba(var(--accent-rgb),0.18) !important;
          box-shadow: 0 0 30px rgba(var(--accent-rgb),0.06) !important;
        }

        .gradient-text { text-shadow: 0 0 40px rgba(var(--accent-rgb),0.35) !important; }

        .quick-btn, .mode-tab, .btn-secondary {
          border: 1px solid rgba(var(--accent-rgb),0.1) !important;
        }
        .quick-btn:hover, .quick-btn.active, .mode-tab.active {
          border-color: rgba(var(--accent-rgb),0.4) !important;
          box-shadow: 0 0 14px rgba(var(--accent-rgb),0.12) !important;
          background: rgba(var(--accent-rgb),0.08) !important;
        }
        .balance-chip {
          background: rgba(var(--accent-rgb),0.12) !important;
          box-shadow: 0 0 12px rgba(var(--accent-rgb),0.15) !important;
        }
        .profile-tabs, .purchase-mode-toggle {
          background: rgba(var(--accent-rgb),0.03) !important;
          border: 1px solid rgba(var(--accent-rgb),0.1) !important;
        }

        /* Neon glow on hero title */
        .hero-title { text-shadow: 0 0 60px rgba(var(--accent-rgb),0.2) !important; }
      `,

      v3: `
        /* ═══════════ V3 — Gaming Marketplace (Playerok-style) ═══════════ */
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        
        :root, [data-theme="v3"] {
          --bg-primary: #13151b;
          --bg-secondary: #1a1d27;
          --bg-tertiary: #21242f;
          --bg-card: #1a1d27 !important;
          --bg-card-solid: #1a1d27;
          --bg-glass: rgba(255,255,255,0.02);
          --bg-glass-hover: rgba(255,255,255,0.05);
          --bg-elevated: #21242f;
          --text-primary: #e4e7ec;
          --text-secondary: rgba(228,231,236,0.6);
          --text-muted: rgba(228,231,236,0.3);
          --accent-primary: #5b6eea;
          --accent-secondary: #4c5fd7;
          --accent-tertiary: #8b9cf5;
          --accent-gradient: linear-gradient(135deg, #4c5fd7 0%, #5b6eea 50%, #8b9cf5 100%);
          --accent-glow: rgba(91,110,234,0.25);
          --accent-rgb: 91,110,234;
          --success: #22c55e; --warning: #f59e0b; --danger: #ef4444;
          --border-color: rgba(255,255,255,0.05);
          --border-hover: rgba(255,255,255,0.1);
          --radius-sm:8px; --radius-md:12px; --radius-lg:16px; --radius-xl:20px;
          --font-sans: 'Inter','Outfit',-apple-system,sans-serif;
          --font-display: 'Inter',var(--font-sans);
          --header-height: 56px;
        }
        body[data-theme="v3"] { background: #13151b !important; font-family: 'Inter',-apple-system,sans-serif !important; }

        /* ── No ambient orbs — clean bg ── */
        [data-theme="v3"] .ambient-orb { display: none !important; }

        /* ── Header — compact, dark, Playerok-style ── */
        [data-theme="v3"] .header {
          background: #1a1d27 !important;
          border-bottom: 1px solid rgba(255,255,255,0.04) !important;
          box-shadow: none !important;
          height: 56px !important;
          backdrop-filter: none !important;
        }
        [data-theme="v3"] .header-content { gap: 12px !important; }
        [data-theme="v3"] .logo-text-main { color: #5b6eea !important; font-weight: 800 !important; }
        [data-theme="v3"] .logo-text-sub { display: none !important; }

        /* Nav — pill-style tabs */
        [data-theme="v3"] .nav-desktop { 
          background: rgba(255,255,255,0.03) !important; 
          border-radius: 10px !important; 
          padding: 3px !important; 
          gap: 0 !important;
        }
        [data-theme="v3"] .nav-item {
          border-radius: 8px !important; font-weight: 500 !important; 
          font-size: 13px !important; padding: 6px 14px !important;
          color: var(--text-secondary) !important;
          transition: all .15s ease !important;
        }
        [data-theme="v3"] .nav-item:hover { 
          background: rgba(255,255,255,0.05) !important; 
          color: var(--text-primary) !important; 
        }
        [data-theme="v3"] .nav-item.active { 
          background: rgba(91,110,234,0.12) !important; 
          color: #8b9cf5 !important; 
        }
        [data-theme="v3"] .nav-indicator { 
          display: none !important; 
        }

        /* Balance chip */
        [data-theme="v3"] .balance-chip {
          background: rgba(91,110,234,0.1) !important; 
          border: 1px solid rgba(91,110,234,0.2) !important;
          color: #8b9cf5 !important; font-weight: 700 !important;
          border-radius: 10px !important;
        }

        /* ── Cards — flat, no shadows, rounded ── */
        [data-theme="v3"] .hero-card, [data-theme="v3"] .feature-card, 
        [data-theme="v3"] .review-card, [data-theme="v3"] .faq-item, 
        [data-theme="v3"] .cta-card, [data-theme="v3"] .robux-card, 
        [data-theme="v3"] .tool-card, [data-theme="v3"] .product-card, 
        [data-theme="v3"] .stat-card, [data-theme="v3"] .admin-stat-card,
        [data-theme="v3"] .profile-card, [data-theme="v3"] .support-card, 
        [data-theme="v3"] .robux-trust-panel, [data-theme="v3"] .robux-info-card,
        [data-theme="v3"] .analytics-card, [data-theme="v3"] .action-card,
        [data-theme="v3"] .robux-banner-slot {
          background: #1a1d27 !important;
          border: 1px solid rgba(255,255,255,0.04) !important;
          box-shadow: none !important;
          border-radius: 14px !important;
        }
        [data-theme="v3"] .feature-card:hover, [data-theme="v3"] .tool-card:hover, 
        [data-theme="v3"] .product-card:hover, [data-theme="v3"] .review-card:hover,
        [data-theme="v3"] .stat-card:hover, [data-theme="v3"] .action-card:hover {
          background: #21242f !important;
          border-color: rgba(91,110,234,0.12) !important;
          transform: translateY(-2px) !important;
          box-shadow: 0 4px 16px rgba(0,0,0,0.2) !important;
        }

        /* Product cards — more compact, game-icon style */
        [data-theme="v3"] .product-card { border-radius: 14px !important; overflow: hidden !important; }
        [data-theme="v3"] .product-banner { border-radius: 0 !important; }
        [data-theme="v3"] .product-banner img { border-radius: 0 !important; }
        [data-theme="v3"] .product-card:hover .product-banner img { transform: scale(1.05) translateZ(0) !important; }

        /* ── Buttons — clean, flat ── */
        [data-theme="v3"] .btn-primary {
          background: #5b6eea !important; color: #fff !important;
          border: none !important; box-shadow: none !important;
          border-radius: 10px !important; font-weight: 600 !important;
        }
        [data-theme="v3"] .btn-primary:hover { 
          background: #4c5fd7 !important; 
          transform: translateY(-1px) !important; 
          box-shadow: 0 4px 12px rgba(91,110,234,0.25) !important;
        }
        [data-theme="v3"] .btn-secondary {
          background: rgba(255,255,255,0.04) !important;
          border: 1px solid rgba(255,255,255,0.08) !important;
          border-radius: 10px !important;
        }
        [data-theme="v3"] .btn-secondary:hover {
          background: rgba(255,255,255,0.07) !important;
          border-color: rgba(255,255,255,0.12) !important;
        }

        /* ── Inputs ── */
        [data-theme="v3"] .form-input, [data-theme="v3"] .auth-input {
          background: rgba(255,255,255,0.03) !important;
          border: 1px solid rgba(255,255,255,0.06) !important;
          border-radius: 10px !important; font-size: 14px !important;
        }
        [data-theme="v3"] .form-input:focus, [data-theme="v3"] .auth-input:focus {
          border-color: rgba(91,110,234,0.4) !important;
          box-shadow: 0 0 0 3px rgba(91,110,234,0.08) !important;
          background: rgba(255,255,255,0.04) !important;
        }

        /* ── Modal — clean dark ── */
        [data-theme="v3"] .modal-overlay { background: rgba(0,0,0,0.65) !important; backdrop-filter: blur(8px) !important; }
        [data-theme="v3"] .modal {
          background: #1a1d27 !important;
          border: 1px solid rgba(255,255,255,0.06) !important;
          box-shadow: 0 24px 64px rgba(0,0,0,0.5) !important;
          border-radius: 16px !important;
        }

        /* ── Dropdowns ── */
        [data-theme="v3"] .user-dropdown, [data-theme="v3"] .notif-dropdown {
          background: #1e2130 !important;
          border: 1px solid rgba(255,255,255,0.06) !important;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important;
          border-radius: 14px !important;
        }

        /* ── Gradient text ── */
        [data-theme="v3"] .gradient-text {
          background: linear-gradient(135deg, #e4e7ec 30%, #8b9cf5 100%) !important;
          -webkit-background-clip: text !important;
          -webkit-text-fill-color: transparent !important;
          text-shadow: none !important;
        }

        /* ── Tabs & chips ── */
        [data-theme="v3"] .quick-btn, [data-theme="v3"] .mode-tab {
          border: 1px solid rgba(255,255,255,0.05) !important;
          border-radius: 10px !important; background: transparent !important;
        }
        [data-theme="v3"] .quick-btn:hover, [data-theme="v3"] .quick-btn.active, 
        [data-theme="v3"] .mode-tab.active {
          background: rgba(91,110,234,0.1) !important;
          border-color: rgba(91,110,234,0.25) !important;
          color: #8b9cf5 !important;
        }

        /* ── Auth forms ── */
        [data-theme="v3"] .auth-icon { 
          background: rgba(91,110,234,0.08) !important; 
          border-color: rgba(91,110,234,0.15) !important; 
        }
        [data-theme="v3"] .auth-icon svg { color: #8b9cf5 !important; }
        [data-theme="v3"] .auth-submit { background: #5b6eea !important; box-shadow: none !important; border-radius: 10px !important; }
        [data-theme="v3"] .auth-submit:hover { background: #4c5fd7 !important; }
        [data-theme="v3"] .auth-tab.active { color: #8b9cf5 !important; }
        [data-theme="v3"] .auth-tab-indicator { background: #5b6eea !important; box-shadow: none !important; }
        [data-theme="v3"] .auth-step-dot.active { background: #5b6eea !important; box-shadow: 0 0 6px rgba(91,110,234,0.35) !important; }
        [data-theme="v3"] .auth-step-dot.done { background: rgba(91,110,234,0.35) !important; }

        /* ── Slider captcha ── */
        [data-theme="v3"] .captcha-slider-thumb { background: #5b6eea !important; box-shadow: 0 2px 8px rgba(91,110,234,0.25) !important; }
        [data-theme="v3"] .captcha-slider-wrap.done .captcha-slider-thumb { background: #22c55e !important; }

        /* ── Scrollbar ── */
        [data-theme="v3"] ::-webkit-scrollbar { width: 5px; height: 5px; }
        [data-theme="v3"] ::-webkit-scrollbar-track { background: transparent; }
        [data-theme="v3"] ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 3px; }
        [data-theme="v3"] ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.12); }
        [data-theme="v3"] ::selection { background: rgba(91,110,234,0.25); }

        /* ── Mobile nav ── */
        [data-theme="v3"] .nav-mobile {
          background: #1a1d27 !important;
          border-top: 1px solid rgba(255,255,255,0.04) !important;
          box-shadow: none !important;
        }
        [data-theme="v3"] .nav-mobile-item.active { color: #5b6eea !important; }
        [data-theme="v3"] .nav-mobile-item.active svg { stroke: #5b6eea !important; }

        /* ── Section headings ── */
        [data-theme="v3"] h1, [data-theme="v3"] h2, [data-theme="v3"] h3 { font-family: 'Inter',sans-serif !important; }
        
        /* ── Home page — marketplace feel ── */
        [data-theme="v3"] .home-section { padding: 16px 0 !important; }
        [data-theme="v3"] .section-title { font-size: 18px !important; font-weight: 700 !important; }

        /* ── Clean toast ── */
        [data-theme="v3"] .toast { border-radius: 12px !important; backdrop-filter: blur(12px) !important; }
      `
    };

    if (themeCSS[theme]) {
      const style = document.createElement('style');
      style.id = 'theme-style';
      style.textContent = themeCSS[theme];
      document.head.appendChild(style);
    }
  }

  const _layoutCSS = {
    classic: '',

    // Dashboard: fixed left sidebar, no mobile nav
    dashboard: `
      @media (min-width: 769px) {
        body[data-layout="dashboard"] .nav-desktop,
        body[data-layout="dashboard"] .nav-indicator { display:none !important; }
        body[data-layout="dashboard"] .header { left:220px !important; }
        body[data-layout="dashboard"] .header-content { max-width:none !important; padding-left:16px !important; }
        body[data-layout="dashboard"] .main { padding-left:220px !important; padding-bottom:24px !important; }
        body[data-layout="dashboard"] .nav-mobile { display:none !important; }
        body[data-layout="dashboard"] #layout-sidebar { display:flex !important; }
        body[data-layout="dashboard"] .home-section { padding:18px 0; }
        body[data-layout="dashboard"] .container { padding:18px; }
      }
      #layout-sidebar {
        display:none; position:fixed; top:0; left:0; width:220px; height:100vh;
        background:rgba(7,6,14,0.98); border-right:1px solid rgba(var(--accent-rgb),0.12);
        backdrop-filter:blur(20px); flex-direction:column; z-index:200; overflow:hidden;
      }
      .lsb-head {
        padding:18px 18px 14px; border-bottom:1px solid rgba(var(--accent-rgb),0.08); margin-bottom:6px;
      }
      .lsb-logo-line {
        font-family:var(--font-display); font-size:16px; font-weight:800;
        background:var(--accent-gradient); -webkit-background-clip:text;
        -webkit-text-fill-color:transparent; background-clip:text;
      }
      .lsb-logo-sub { font-size:10px; color:var(--text-muted); letter-spacing:2px; text-transform:uppercase; margin-top:2px; }
      .lsb-nav { flex:1; padding:6px 10px; display:flex; flex-direction:column; gap:2px; overflow-y:auto; }
      .lsb-btn {
        position:relative; display:flex; align-items:center; gap:11px;
        padding:10px 12px; border-radius:10px; background:transparent; border:none;
        color:var(--text-secondary); font-family:var(--font-sans); font-size:13px;
        font-weight:500; cursor:pointer; transition:all .18s; text-align:left; width:100%;
      }
      .lsb-btn::before {
        content:''; position:absolute; left:0; top:8px; bottom:8px; width:3px;
        background:var(--accent-gradient); border-radius:0 3px 3px 0;
        transform:scaleY(0); transition:transform .22s cubic-bezier(.4,0,.2,1);
      }
      .lsb-btn:hover { background:rgba(var(--accent-rgb),0.06); color:var(--text-primary); }
      .lsb-btn.active { background:rgba(var(--accent-rgb),0.1); color:#fff; font-weight:600; }
      .lsb-btn.active::before { transform:scaleY(1); }
      .lsb-btn svg { width:16px; height:16px; flex-shrink:0; opacity:0.6; transition:opacity .15s; }
      .lsb-btn.active svg { opacity:1; }
      .lsb-footer { padding:14px 18px; border-top:1px solid rgba(255,255,255,0.05); font-size:11px; color:var(--text-muted); }
    `,

    // Landing: refined aesthetic — particles, cursor glow, polished cards. No layout breaking.
    landing: `
      /* ─── Fixed background layer ─── */
      #landing-cursor-glow {
        position: fixed !important; width: 500px; height: 500px; border-radius: 50%;
        background: radial-gradient(circle, rgba(139,92,246,0.06) 0%, transparent 68%);
        pointer-events: none; z-index: 0; transform: translate(-50%,-50%); top:-300px; left:-300px;
      }
      #landing-canvas { position:fixed !important; top:0; left:0; width:100%; height:100%; z-index:0; pointer-events:none; }
      .landing-orb { position:fixed !important; border-radius:50%; filter:blur(90px); pointer-events:none; z-index:0; }
      .landing-orb-1 { width:450px;height:450px;background:rgba(139,92,246,0.08);top:-80px;right:-120px;animation:landOrb 9s ease-in-out infinite; }
      .landing-orb-2 { width:380px;height:380px;background:rgba(99,102,241,0.06);bottom:5%;left:-80px;animation:landOrb 11s ease-in-out infinite reverse; }
      .landing-orb-3 { width:260px;height:260px;background:rgba(168,85,247,0.05);top:45%;left:48%;animation:landOrb 13s ease-in-out infinite; }
      @keyframes landOrb { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(28px,-24px) scale(1.08)} 66%{transform:translate(-18px,18px) scale(0.93)} }

      /* ─── Base ─── */
      body[data-layout="landing"] { background:#07060e !important; }
      body[data-layout="landing"] .main { position:relative !important; z-index:1 !important; background:transparent !important; }
      body[data-layout="landing"] .tab-content { background:transparent !important; }
      body[data-layout="landing"] .container { background:transparent !important; }
      body[data-layout="landing"] .header { z-index:100 !important; }
      body[data-layout="landing"] .nav-mobile { z-index:100 !important; }
      body[data-layout="landing"] #toastContainer,
      body[data-layout="landing"] .modal-overlay,
      body[data-layout="landing"] #vpnOverlay,
      body[data-layout="landing"] #banOverlay { z-index:9999 !important; }

      /* ─── Header ─── */
      body[data-layout="landing"] .header {
        background:rgba(7,6,14,0.5) !important; backdrop-filter:blur(24px) !important;
        -webkit-backdrop-filter:blur(24px) !important; border-bottom:1px solid rgba(255,255,255,0.055) !important; box-shadow:none !important;
      }
      body[data-layout="landing"] .nav-desktop { background:transparent !important; border:none !important; box-shadow:none !important; gap:2px !important; }
      body[data-layout="landing"] .nav-btn {
        background:transparent !important; border:none !important; box-shadow:none !important; border-radius:0 !important;
        color:rgba(240,237,246,0.58) !important; font-size:14px !important; font-weight:500 !important;
        padding:8px 14px !important; transition:color .25s ease !important; position:relative !important;
      }
      body[data-layout="landing"] .nav-btn::after {
        content:"" !important; position:absolute !important; bottom:0; left:14px; right:14px;
        height:2px !important; background:var(--accent-gradient) !important; border-radius:2px !important;
        transform:scaleX(0) !important; transition:transform .28s ease !important; transform-origin:center !important;
      }
      body[data-layout="landing"] .nav-btn:hover { color:rgba(240,237,246,0.95) !important; background:transparent !important; transform:none !important; }
      body[data-layout="landing"] .nav-btn:hover::after,
      body[data-layout="landing"] .nav-btn.active::after { transform:scaleX(1) !important; }
      body[data-layout="landing"] .nav-btn.active { color:#fff !important; background:transparent !important; font-weight:600 !important; }
      body[data-layout="landing"] .nav-indicator { display:none !important; }
      body[data-layout="landing"] #balanceBtn {
        background:linear-gradient(135deg,rgba(124,58,237,0.85),rgba(109,40,217,0.85)) !important;
        box-shadow:0 0 18px rgba(124,58,237,0.28) !important; border-radius:10px !important;
        border:1px solid rgba(124,58,237,0.35) !important; font-weight:600 !important;
      }
      body[data-layout="landing"] #balanceBtn:hover { transform:translateY(-1px) !important; box-shadow:0 0 28px rgba(124,58,237,0.42) !important; }
      body[data-layout="landing"] .nav-mobile {
        background:rgba(7,6,14,0.88) !important; backdrop-filter:blur(20px) !important;
        border-top:1px solid rgba(255,255,255,0.06) !important; box-shadow:none !important;
      }
      body[data-layout="landing"] .user-dropdown {
        background:rgba(11,9,20,0.96) !important; border:1px solid rgba(255,255,255,0.08) !important;
        backdrop-filter:blur(20px) !important; border-radius:16px !important; box-shadow:0 20px 60px rgba(0,0,0,.5) !important;
      }

      /* ─── Glass mixin for ALL card surfaces ─── */
      body[data-layout="landing"] .hero-card,
      body[data-layout="landing"] .feature-card,
      body[data-layout="landing"] .trust-card,
      body[data-layout="landing"] .step-item,
      body[data-layout="landing"] .review-card,
      body[data-layout="landing"] .faq-item,
      body[data-layout="landing"] .cta-card,
      body[data-layout="landing"] .auth-card,
      body[data-layout="landing"] .robux-card,
      body[data-layout="landing"] .tool-card,
      body[data-layout="landing"] .stat-card,
      body[data-layout="landing"] .admin-stat-card,
      body[data-layout="landing"] .profile-card,
      body[data-layout="landing"] .checker-profile-card,
      body[data-layout="landing"] .support-card,
      body[data-layout="landing"] .shop-editor-banner,
      body[data-layout="landing"] .product-card {
        background:rgba(255,255,255,0.03) !important;
        border:1px solid rgba(255,255,255,0.08) !important;
        backdrop-filter:blur(12px) !important; -webkit-backdrop-filter:blur(12px) !important;
        box-shadow:0 4px 24px rgba(0,0,0,0.22) !important;
        transition:all .45s cubic-bezier(.23,1,.32,1) !important;
      }

      /* ─── Hover lifts ─── */
      body[data-layout="landing"] .feature-card:hover,
      body[data-layout="landing"] .trust-card:hover,
      body[data-layout="landing"] .step-item:hover,
      body[data-layout="landing"] .tool-card:hover,
      body[data-layout="landing"] .admin-stat-card:hover,
      body[data-layout="landing"] .stat-card:hover {
        transform:translateY(-7px) !important;
        background:rgba(255,255,255,0.05) !important;
        border-color:rgba(139,92,246,0.22) !important;
        box-shadow:0 20px 56px rgba(0,0,0,0.28),0 0 36px rgba(139,92,246,0.08) !important;
      }
      body[data-layout="landing"] .product-card:hover {
        transform:translateY(-5px) scale(1.01) !important;
        border-color:rgba(139,92,246,0.25) !important;
        box-shadow:0 14px 44px rgba(0,0,0,0.28),0 0 28px rgba(139,92,246,0.1) !important;
        background:rgba(255,255,255,0.05) !important;
      }
      body[data-layout="landing"] .review-card:hover {
        transform:translateY(-4px) !important;
        border-color:rgba(139,92,246,0.2) !important;
        box-shadow:0 12px 36px rgba(0,0,0,0.25) !important;
      }
      body[data-layout="landing"] .faq-item:hover { border-color:rgba(139,92,246,0.18) !important; }
      body[data-layout="landing"] .auth-card:hover { transform:none !important; }

      /* ─── Hero card: borderless transparent ─── */
      body[data-layout="landing"] .hero-card {
        background:transparent !important; border:none !important; box-shadow:none !important;
        backdrop-filter:none !important; text-align:center !important; max-width:800px !important; margin:0 auto !important;
      }
      body[data-layout="landing"] .hero-card:hover { transform:none !important; }
      body[data-layout="landing"] .cta-card {
        background:linear-gradient(135deg,rgba(139,92,246,0.07),rgba(99,102,241,0.03)) !important;
        border:1px solid rgba(139,92,246,0.15) !important; border-radius:26px !important; text-align:center !important;
      }
      body[data-layout="landing"] .cta-card:hover { transform:none !important; box-shadow:none !important; }

      /* ─── Hero section layout ─── */
      body[data-layout="landing"] .home-hero {
        min-height:86vh !important; display:flex !important; align-items:center !important;
        padding-top:120px !important; padding-bottom:60px !important;
      }
      body[data-layout="landing"] .home-hero .container { display:flex !important; justify-content:center !important; }
      body[data-layout="landing"] .hero-title {
        font-size:clamp(44px,7vw,88px) !important; font-weight:900 !important;
        line-height:1.0 !important; letter-spacing:-2.5px !important; text-align:center !important;
      }
      body[data-layout="landing"] .hero-desc {
        font-size:clamp(15px,1.8vw,19px) !important; color:rgba(240,237,246,0.52) !important;
        line-height:1.75 !important; text-align:center !important; max-width:540px !important; margin:0 auto 44px !important;
      }
      body[data-layout="landing"] .hero-badge {
        display:inline-flex !important; align-items:center !important; gap:8px !important;
        padding:7px 18px !important; border-radius:100px !important;
        background:rgba(139,92,246,0.08) !important; border:1px solid rgba(139,92,246,0.2) !important;
        font-size:12px !important; color:#a78bfa !important; font-weight:500 !important; margin-bottom:28px !important;
      }
      body[data-layout="landing"] .hero-actions { justify-content:center !important; gap:14px !important; }
      body[data-layout="landing"] .hero-trust { justify-content:center !important; margin-top:28px !important; }

      /* ─── Gradient text ─── */
      body[data-layout="landing"] .gradient-text {
        background:linear-gradient(135deg,#a78bfa,#c084fc,#8b5cf6,#818cf8) !important;
        background-size:200% auto !important; -webkit-background-clip:text !important;
        -webkit-text-fill-color:transparent !important; background-clip:text !important;
        animation:landGradShift 4s ease infinite !important;
      }
      @keyframes landGradShift { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }

      /* ─── Robux landing hero: show/hide by CSS, not JS timing ─── */
      body[data-layout="landing"] #robuxDefaultHeader { display: none !important; }
      body[data-layout="landing"] #robuxLandingHero   { display: block !important; }

      /* ─── Section labels & titles ─── */
      body[data-layout="landing"] .section-label {
        background:transparent !important; border:none !important; padding:0 !important; border-radius:0 !important;
        color:#a78bfa !important; font-size:11px !important; font-weight:700 !important;
        text-transform:uppercase !important; letter-spacing:2.5px !important;
        display:inline-flex !important; align-items:center !important; gap:8px !important; margin-bottom:12px !important;
      }
      body[data-layout="landing"] .section-label::before {
        content:"" !important; width:18px !important; height:2px !important;
        background:linear-gradient(90deg,#7c3aed,#a78bfa) !important; border-radius:1px !important;
        display:inline-block !important; flex-shrink:0 !important;
      }
      body[data-layout="landing"] .section-title {
        font-size:clamp(26px,4vw,46px) !important; font-weight:800 !important; letter-spacing:-1.5px !important; line-height:1.1 !important;
      }
      body[data-layout="landing"] .section-header,
      body[data-layout="landing"] .section-head { background:transparent !important; }
      body[data-layout="landing"] .section-header h1 {
        font-size:clamp(22px,3vw,34px) !important; font-weight:800 !important; letter-spacing:-1px !important;
      }

      /* ─── Buttons ─── */
      body[data-layout="landing"] .btn-primary {
        border-radius:13px !important; box-shadow:0 4px 26px rgba(124,58,237,0.28) !important; font-weight:600 !important;
      }
      body[data-layout="landing"] .btn-primary:hover {
        transform:translateY(-2px) !important; box-shadow:0 8px 36px rgba(124,58,237,0.4) !important;
      }
      body[data-layout="landing"] .btn-secondary {
        border-radius:13px !important; background:rgba(255,255,255,0.04) !important;
        border:1px solid rgba(255,255,255,0.1) !important; backdrop-filter:blur(6px) !important;
      }
      body[data-layout="landing"] .btn-secondary:hover {
        background:rgba(255,255,255,0.08) !important; border-color:rgba(255,255,255,0.18) !important;
        transform:translateY(-2px) !important; box-shadow:none !important;
      }

      /* ─── Feature & tool icons ─── */
      body[data-layout="landing"] .feature-icon {
        background:rgba(124,58,237,0.09) !important; border:1px solid rgba(124,58,237,0.15) !important; border-radius:14px !important;
      }
      body[data-layout="landing"] .feature-card:hover .feature-icon {
        background:rgba(124,58,237,0.16) !important; box-shadow:0 0 22px rgba(124,58,237,0.22) !important; transform:scale(1.08) !important;
      }
      body[data-layout="landing"] .tool-card-icon {
        background:rgba(124,58,237,0.09) !important; border:1px solid rgba(124,58,237,0.15) !important; border-radius:14px !important;
      }

      /* ─── Stats ─── */
      body[data-layout="landing"] .trust-num {
        font-family:'JetBrains Mono','Outfit',monospace !important; font-size:30px !important;
        font-weight:800 !important; letter-spacing:-1px !important;
      }
      body[data-layout="landing"] .trust-label {
        font-size:11px !important; text-transform:uppercase !important; letter-spacing:1.2px !important; color:rgba(240,237,246,0.38) !important;
      }
      body[data-layout="landing"] .step-num {
        background:linear-gradient(135deg,rgba(124,58,237,0.18),rgba(109,40,217,0.12)) !important;
        border:1px solid rgba(124,58,237,0.22) !important; border-radius:14px !important;
        color:#a78bfa !important; font-weight:800 !important; box-shadow:0 0 18px rgba(124,58,237,0.12) !important;
      }

      /* ─── FAQ ─── */
      body[data-layout="landing"] .faq-question { font-weight:600 !important; transition:color .25s !important; }
      body[data-layout="landing"] .faq-question:hover { color:#a78bfa !important; }

      /* ─── ROBUX TAB ─── */
      body[data-layout="landing"] .robux-banner-slot {
        background:rgba(255,255,255,0.02) !important; border:1px solid rgba(255,255,255,0.07) !important;
        border-radius:18px !important; backdrop-filter:blur(8px) !important;
      }
      body[data-layout="landing"] .robux-trust-panel .trust-item,
      body[data-layout="landing"] .trust-item {
        background:rgba(255,255,255,0.025) !important; border:1px solid rgba(255,255,255,0.07) !important;
        border-radius:14px !important; backdrop-filter:blur(8px) !important;
      }
      body[data-layout="landing"] .robux-form-section,
      body[data-layout="landing"] .robux-amount-grid .amount-btn,
      body[data-layout="landing"] .amount-option {
        background:rgba(255,255,255,0.03) !important; border:1px solid rgba(255,255,255,0.08) !important;
        border-radius:12px !important;
      }
      body[data-layout="landing"] .amount-option.selected,
      body[data-layout="landing"] .amount-btn.selected {
        background:rgba(124,58,237,0.15) !important; border-color:rgba(124,58,237,0.4) !important;
        box-shadow:0 0 16px rgba(124,58,237,0.2) !important;
      }
      body[data-layout="landing"] .stock-badge {
        background:rgba(34,197,94,0.08) !important; border:1px solid rgba(34,197,94,0.2) !important; border-radius:10px !important;
      }

      /* ─── SHOP TAB ─── */
      body[data-layout="landing"] .shop-tabs,
      body[data-layout="landing"] .shop-cats-row {
        background:rgba(255,255,255,0.02) !important; border:1px solid rgba(255,255,255,0.06) !important;
        border-radius:14px !important; backdrop-filter:blur(8px) !important;
      }
      body[data-layout="landing"] .cat-btn,
      body[data-layout="landing"] .shop-tab-btn {
        border-radius:10px !important; transition:all .2s !important;
      }
      body[data-layout="landing"] .cat-btn.active,
      body[data-layout="landing"] .shop-tab-btn.active {
        background:rgba(124,58,237,0.15) !important; border-color:rgba(124,58,237,0.35) !important;
        box-shadow:0 0 14px rgba(124,58,237,0.18) !important; color:#a78bfa !important;
      }
      body[data-layout="landing"] .shop-editor-banner {
        background:rgba(255,255,255,0.025) !important; border:1px solid rgba(124,58,237,0.18) !important;
        border-radius:14px !important; backdrop-filter:blur(8px) !important;
      }
      body[data-layout="landing"] .product-banner {
        border-radius:12px 12px 0 0 !important; overflow:hidden !important;
      }
      body[data-layout="landing"] .product-badge {
        backdrop-filter:blur(6px) !important; background:rgba(7,6,14,0.7) !important;
      }

      /* ─── PROFILE TAB ─── */
      body[data-layout="landing"] .profile-card { overflow:hidden !important; }
      body[data-layout="landing"] .profile-card-bg {
        background:linear-gradient(180deg,rgba(124,58,237,0.12) 0%,transparent 100%) !important;
      }
      body[data-layout="landing"] .profile-stat {
        background:rgba(255,255,255,0.025) !important; border:1px solid rgba(255,255,255,0.07) !important;
        border-radius:12px !important; backdrop-filter:blur(6px) !important;
      }
      body[data-layout="landing"] .profile-stat:hover {
        background:rgba(124,58,237,0.08) !important; border-color:rgba(124,58,237,0.2) !important;
      }
      body[data-layout="landing"] .profile-premium-badge {
        background:linear-gradient(90deg,rgba(245,158,11,0.15),rgba(239,68,68,0.1)) !important;
        border:1px solid rgba(245,158,11,0.3) !important;
      }
      body[data-layout="landing"] .purchase-row,
      body[data-layout="landing"] .order-row {
        background:rgba(255,255,255,0.02) !important; border:1px solid rgba(255,255,255,0.06) !important;
        border-radius:12px !important; transition:all .2s !important;
      }
      body[data-layout="landing"] .purchase-row:hover,
      body[data-layout="landing"] .order-row:hover {
        background:rgba(124,58,237,0.05) !important; border-color:rgba(124,58,237,0.18) !important;
      }
      body[data-layout="landing"] .referral-card,
      body[data-layout="landing"] .promo-card {
        background:rgba(255,255,255,0.025) !important; border:1px solid rgba(255,255,255,0.07) !important;
        border-radius:16px !important; backdrop-filter:blur(8px) !important;
      }

      /* ─── Form inputs everywhere ─── */
      body[data-layout="landing"] .form-input,
      body[data-layout="landing"] input.form-input,
      body[data-layout="landing"] textarea.form-input,
      body[data-layout="landing"] select.form-input {
        background:rgba(255,255,255,0.04) !important; border:1px solid rgba(255,255,255,0.09) !important;
        border-radius:11px !important; transition:border-color .25s,box-shadow .25s !important;
      }
      body[data-layout="landing"] .form-input:focus {
        border-color:rgba(124,58,237,0.4) !important; box-shadow:0 0 0 3px rgba(124,58,237,0.1) !important;
      }

      /* ─── Modal ─── */
      body[data-layout="landing"] .modal-overlay { backdrop-filter:blur(10px) !important; background:rgba(5,4,12,0.72) !important; }
      body[data-layout="landing"] .modal {
        background:rgba(11,9,20,0.94) !important; border:1px solid rgba(124,58,237,0.13) !important;
        border-radius:22px !important; box-shadow:0 30px 80px rgba(0,0,0,0.55),0 0 50px rgba(124,58,237,0.07) !important;
        backdrop-filter:blur(24px) !important;
      }

      /* ─── Admin ─── */
      body[data-layout="landing"] .admin-table thead th { background:rgba(255,255,255,0.03) !important; }
      body[data-layout="landing"] .admin-table tr:hover td { background:rgba(124,58,237,0.04) !important; }

      /* ─── Ambient bg off ─── */
      body[data-layout="landing"] .ambient-bg { display:none !important; }
      body[data-layout="landing"] .hero-card::after { display:none !important; }
    `
  };


  function _applyLayout(layout) {
    document.getElementById('layout-style')?.remove();
    document.getElementById('layout-sidebar')?.remove();
    // Clean up landing elements if switching away
    document.getElementById('landing-canvas')?.remove();
    document.getElementById('landing-cursor-glow')?.remove();
    document.querySelectorAll('.landing-orb').forEach(e => e.remove());
    // Restore landing tab structures if switching away
    if (document.body.dataset.layout === 'landing' && layout !== 'landing') {
      _restoreLandingTabs();
    }
    if (window._landingMouseListener) {
      document.removeEventListener('mousemove', window._landingMouseListener);
      window._landingMouseListener = null;
    }
    if (window._landingAnimFrame) {
      cancelAnimationFrame(window._landingAnimFrame);
      window._landingAnimFrame = null;
    }
    if (window._landingGlowFrame) {
      cancelAnimationFrame(window._landingGlowFrame);
      window._landingGlowFrame = null;
    }

    document.body.dataset.layout = layout;

    if (_layoutCSS[layout]) {
      const style = document.createElement('style');
      style.id = 'layout-style';
      style.textContent = _layoutCSS[layout];
      document.head.appendChild(style);
    }

    if (layout === 'dashboard') _createDashboardSidebar();

    if (layout === 'landing') {
      _initLandingEffects();
      _restructureLandingTabs();
    }

    // Nav indicator only for classic mode
    const ind = document.getElementById('navIndicator');
    if (ind) ind.style.display = layout === 'classic' ? '' : 'none';
  }

  // ── Landing tab restructure: visual overhaul of Robux, Shop, Profile ──
  function _restructureLandingTabs() {
    // Hero show/hide is handled by CSS (body[data-layout="landing"] rules)
    // Just sync the stock value and init the banner
    const stock = document.getElementById('robuxStock');
    const heroStock = document.getElementById('robuxStockHero');
    if (stock && heroStock) heroStock.textContent = stock.textContent;

    // ── GIF banner: intro plays once → fade out → loop gif appears ──
    setTimeout(_initRobuxBanner, 50);

    // Inject landing-specific CSS for tab layouts
    const existing = document.getElementById('landing-tabs-style');
    if (existing) existing.remove();
    const s = document.createElement('style');
    s.id = 'landing-tabs-style';
    s.textContent = `
      /* ── ROBUX tab in landing: GIF banner above, centered calculator below ── */
      body[data-layout="landing"] #tab-robux .container {
        display: flex !important; flex-direction: column !important; align-items: center !important;
      }
      body[data-layout="landing"] #robuxLandingHero {
        width: 100% !important; max-width: 100% !important;
      }
      body[data-layout="landing"] #tab-robux .robux-page-layout {
        display: flex !important; flex-direction: column !important; align-items: center !important; gap: 20px !important;
        width: 100% !important; max-width: 860px !important;
      }
      body[data-layout="landing"] #tab-robux .robux-left-col {
        order: 2 !important; width: 100% !important; max-width: 860px !important;
      }
      body[data-layout="landing"] #tab-robux .robux-trust-panel {
        grid-template-columns: repeat(4, 1fr) !important;
        background: rgba(255,255,255,.02) !important; border: 1px solid rgba(255,255,255,.07) !important;
        border-radius: 18px !important; padding: 14px !important; backdrop-filter: blur(8px) !important;
      }
      body[data-layout="landing"] #tab-robux .trust-item {
        flex-direction: column !important; align-items: center !important; text-align: center !important;
        background: transparent !important; border: none !important; padding: 10px 4px !important;
      }
      body[data-layout="landing"] #tab-robux .trust-icon {
        width: 38px !important; height: 38px !important; border-radius: 12px !important;
        background: rgba(124,58,237,.1) !important; border: 1px solid rgba(124,58,237,.2) !important; margin-bottom: 8px !important;
      }
      body[data-layout="landing"] #tab-robux .robux-banner-slot { display: none !important; }
      body[data-layout="landing"] #tab-robux .robux-card {
        order: 1 !important; width: 100% !important; max-width: 460px !important;
        border-radius: 24px !important; overflow: hidden !important;
        background: rgba(255,255,255,.03) !important; border: 1px solid rgba(124,58,237,.18) !important;
        backdrop-filter: blur(16px) !important; box-shadow: 0 0 60px rgba(124,58,237,.1), 0 20px 60px rgba(0,0,0,.3) !important;
      }
      body[data-layout="landing"] #tab-robux .robux-header {
        background: linear-gradient(135deg,rgba(124,58,237,.12),rgba(109,40,217,.06)) !important;
        border-bottom: 1px solid rgba(124,58,237,.12) !important; padding: 18px 22px !important;
      }
      body[data-layout="landing"] #tab-robux .robux-header h2 { font-size: 18px !important; font-weight: 800 !important; }
      body[data-layout="landing"] #tab-robux .stock-badge { display: none !important; }
      body[data-layout="landing"] #tab-robux .quick-btn {
        background: rgba(255,255,255,.04) !important; border: 1px solid rgba(255,255,255,.1) !important;
        border-radius: 10px !important; transition: all .2s !important;
      }
      body[data-layout="landing"] #tab-robux .quick-btn:hover,
      body[data-layout="landing"] #tab-robux .quick-btn.active {
        background: rgba(124,58,237,.18) !important; border-color: rgba(124,58,237,.4) !important; color: #a78bfa !important;
      }
      body[data-layout="landing"] #tab-robux .robux-info-grid {
        margin-top: 24px !important; max-width: 860px !important; margin-left: auto !important; margin-right: auto !important;
      }

      /* ── SHOP tab: editorial header + wider grid ── */
      body[data-layout="landing"] #tab-shop .section-header {
        background: transparent !important; margin-bottom: 0 !important;
      }
      body[data-layout="landing"] #tab-shop .section-header h1 {
        font-size: 32px !important; font-weight: 900 !important; letter-spacing: -1px !important;
      }
      body[data-layout="landing"] #tab-shop .shop-tabs { margin-top: 16px !important; }
      body[data-layout="landing"] #tab-shop .shop-toolbar {
        background: rgba(255,255,255,.025) !important; border: 1px solid rgba(255,255,255,.07) !important;
        border-radius: 14px !important; backdrop-filter: blur(8px) !important;
        padding: 10px 14px !important; margin: 14px 0 !important;
        display: flex !important; gap: 12px !important; align-items: flex-end !important;
      }
      body[data-layout="landing"] #tab-shop .shop-toolbar .field {
        display: flex !important; flex-direction: column !important; gap: 4px !important; flex: 1 !important;
      }
      body[data-layout="landing"] #tab-shop .shop-toolbar .input {
        background: rgba(255,255,255,.05) !important; border: 1px solid rgba(255,255,255,.1) !important;
        border-radius: 10px !important; height: 36px !important;
      }
      body[data-layout="landing"] #tab-shop .shop-grid {
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)) !important; gap: 16px !important;
      }
      body[data-layout="landing"] #tab-shop .product-card {
        border-radius: 18px !important;
      }
      body[data-layout="landing"] #tab-shop .shop-tabs .tab-btn,
      body[data-layout="landing"] #tab-shop .tab-bar .tab-btn {
        border-radius: 10px !important; padding: 6px 16px !important; font-weight: 600 !important;
        transition: all .2s !important;
      }

      /* ── PROFILE tab: full-width hero card + bento grid ── */
      body[data-layout="landing"] #tab-profile .profile-content > div {
        display: flex !important; flex-direction: column !important; gap: 16px !important; max-width: 820px !important; margin: 0 auto !important;
      }
      body[data-layout="landing"] #tab-profile .profile-content > div > div:first-child {
        width: 100% !important; max-width: 100% !important;
      }
      body[data-layout="landing"] #tab-profile .profile-content > div > div:first-child > div:first-child {
        display: flex !important; flex-direction: row !important; align-items: center !important;
        gap: 20px !important; text-align: left !important; padding: 24px !important;
        background: linear-gradient(135deg,rgba(124,58,237,.1),rgba(79,70,229,.06)) !important;
        border: 1px solid rgba(124,58,237,.18) !important; border-radius: 20px !important;
      }
      body[data-layout="landing"] #tab-profile #profileAvatar {
        width: 72px !important; height: 72px !important; flex-shrink: 0 !important; margin: 0 !important;
      }
      body[data-layout="landing"] #tab-profile #profileName {
        font-size: 24px !important; font-weight: 900 !important; letter-spacing: -0.5px !important;
      }
      body[data-layout="landing"] #tab-profile .profile-content > div > div:first-child > div:nth-child(2) {
        grid-template-columns: repeat(4, 1fr) !important; gap: 10px !important;
      }
      body[data-layout="landing"] #tab-profile .profile-content > div > div:first-child > div:nth-child(2) > div {
        border-radius: 14px !important; background: rgba(255,255,255,.03) !important;
        border: 1px solid rgba(255,255,255,.07) !important;
        backdrop-filter: blur(8px) !important;
      }
      body[data-layout="landing"] #tab-profile .action-card {
        background: rgba(255,255,255,.03) !important; border: 1px solid rgba(255,255,255,.07) !important;
        border-radius: 14px !important; backdrop-filter: blur(6px) !important; transition: all .25s !important;
      }
      body[data-layout="landing"] #tab-profile .action-card:hover {
        background: rgba(255,255,255,.05) !important; border-color: rgba(124,58,237,.2) !important;
        transform: translateX(4px) !important;
      }
      body[data-layout="landing"] #tab-profile .profile-content > div > div:last-child {
        width: 100% !important;
      }
      body[data-layout="landing"] #tab-profile .profile-tabs {
        background: rgba(255,255,255,.03) !important; border: 1px solid rgba(255,255,255,.07) !important;
        border-radius: 14px !important; backdrop-filter: blur(8px) !important;
      }
      body[data-layout="landing"] #tab-profile .profile-tab-btn {
        border-radius: 10px !important; font-weight: 600 !important; transition: all .2s !important;
      }
      body[data-layout="landing"] #tab-profile .profile-tab-btn.active {
        background: rgba(124,58,237,.18) !important; color: #a78bfa !important;
      }
      body[data-layout="landing"] #tab-profile .analytics-card {
        background: rgba(255,255,255,.02) !important; border: 1px solid rgba(255,255,255,.07) !important;
        border-radius: 18px !important; backdrop-filter: blur(8px) !important;
      }
      @media(min-width:640px) {
        body[data-layout="landing"] #tab-profile .profile-content > div {
          flex-direction: row !important; flex-wrap: wrap !important;
        }
        body[data-layout="landing"] #tab-profile .profile-content > div > div:first-child {
          width: 260px !important; flex-shrink: 0 !important;
        }
        body[data-layout="landing"] #tab-profile .profile-content > div > div:first-child > div:first-child {
          flex-direction: column !important; text-align: center !important;
        }
        body[data-layout="landing"] #tab-profile .profile-content > div > div:first-child > div:nth-child(2) {
          grid-template-columns: 1fr 1fr !important;
        }
        body[data-layout="landing"] #tab-profile .profile-content > div > div:last-child {
          flex: 1 !important; min-width: 0 !important;
        }
      }
    `;
    document.head.appendChild(s);
  }

  function _restoreLandingTabs() {
    document.getElementById('landing-tabs-style')?.remove();
  }

  function _initRobuxBanner() {
    // Holographic banner is pure CSS — no JS needed
    // Just ensure it's visible
    const hero = document.getElementById('rlhHologram');
    if (hero) hero.style.opacity = '1';
  }

  function _initLandingEffects() {
    // ── Cursor glow ──
    const glow = document.createElement('div');
    glow.id = 'landing-cursor-glow';
    document.body.appendChild(glow);

    // ── Floating orbs ──
    [1,2,3].forEach(n => {
      const orb = document.createElement('div');
      orb.className = `landing-orb landing-orb-${n}`;
      document.body.appendChild(orb);
    });

    // ── Particle canvas ──
    const canvas = document.createElement('canvas');
    canvas.id = 'landing-canvas';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let cw = canvas.width = window.innerWidth;
    let ch = canvas.height = window.innerHeight;
    const _rsz = () => { cw = canvas.width = window.innerWidth; ch = canvas.height = window.innerHeight; };
    window.addEventListener('resize', _rsz);

    const mouse = { x: -9999, y: -9999 };

    class P {
      constructor() { this.reset(true); }
      reset(init) {
        this.x = Math.random() * cw;
        this.y = init ? Math.random() * ch : -5;
        this.r = Math.random() * 1.4 + 0.4;
        this.vx = (Math.random() - 0.5) * 0.3;
        this.vy = (Math.random() - 0.5) * 0.3;
        this.a = Math.random() * 0.35 + 0.07;
        this.ba = this.a;
        this.hue = 252 + Math.random() * 42;
      }
      step() {
        this.x += this.vx; this.y += this.vy;
        const dx = mouse.x - this.x, dy = mouse.y - this.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < 16900) {
          const d = Math.sqrt(d2);
          const f = (130 - d) / 130 * 0.014;
          this.x -= dx * f; this.y -= dy * f;
          this.a = Math.min(this.ba + 0.28, 0.7);
        } else {
          this.a += (this.ba - this.a) * 0.04;
        }
        if (this.x < -5 || this.x > cw+5 || this.y < -5 || this.y > ch+5) this.reset(false);
      }
      draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r, 0, 6.283);
        ctx.fillStyle = `hsla(${this.hue},66%,72%,${this.a})`;
        ctx.fill();
      }
    }

    const particles = Array.from({length:85}, () => new P());

    function drawLines() {
      const len = particles.length;
      for (let i = 0; i < len; i++) {
        for (let j = i+1; j < len; j++) {
          const dx = particles[i].x-particles[j].x, dy = particles[i].y-particles[j].y;
          const d2 = dx*dx + dy*dy;
          if (d2 < 11881) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(139,92,246,${0.048*(1-Math.sqrt(d2)/109)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
    }

    const animate = () => {
      if (document.body.dataset.layout !== 'landing') return;
      ctx.clearRect(0, 0, cw, ch);
      particles.forEach(p => { p.step(); p.draw(); });
      drawLines();
      window._landingAnimFrame = requestAnimationFrame(animate);
    };
    animate();

    // Cinematic glow auto-animation instead of mouse tracking
    let _glowAngle = 0;
    window._landingGlowFrame = null;
    const _animateGlow = () => {
      if (document.body.dataset.layout !== 'landing') { window._landingGlowFrame = null; return; }
      _glowAngle += 0.003;
      // Figure-8 path across the viewport
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const rx = window.innerWidth * 0.35;
      const ry = window.innerHeight * 0.25;
      const gx = cx + Math.sin(_glowAngle) * rx;
      const gy = cy + Math.sin(_glowAngle * 2) * ry;
      glow.style.left = gx + 'px';
      glow.style.top = gy + 'px';
      // Also move particles attraction point
      mouse.x = gx; mouse.y = gy;
      window._landingGlowFrame = requestAnimationFrame(_animateGlow);
    };
    _animateGlow();
    // Keep mouse listener but only for subtle offset, not direct tracking
    window._landingMouseListener = () => {}; // no-op
    document.addEventListener('mousemove', window._landingMouseListener);
  }

    function _createDashboardSidebar() {
    const tabs = [
      { id:'home',    icon:'<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>', label:'Главная' },
      { id:'robux',   icon:'<circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/>', label:'Robux' },
      { id:'shop',    icon:'<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>', label:'Магазин' },
      { id:'profile', icon:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', label:'Профиль' },
    ];
    const activeTab = state.ui?.tab || 'home';
    const sidebar = document.createElement('nav');
    sidebar.id = 'layout-sidebar';
    sidebar.innerHTML = `
      <div class="lsb-head">
        <div class="lsb-logo-line">RBX ST</div>
        <div class="lsb-logo-sub">Shop · Tools</div>
      </div>
      <div class="lsb-nav">
        ${tabs.map(t => `<button class="lsb-btn ${t.id===activeTab?'active':''}" data-tab="${t.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${t.icon}</svg>
          <span>${t.label}</span>
        </button>`).join('')}
      </div>
      <div class="lsb-footer"></div>
    `;
    document.body.prepend(sidebar);
    // Wire ONLY sidebar buttons — no listeners added to existing nav-btn
    sidebar.querySelectorAll('.lsb-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  // Apply saved design on page load
  (function _initDesignSettings() {
    const accent = localStorage.getItem('rst_accent');
    const radius = localStorage.getItem('rst_radius');
    const theme  = localStorage.getItem('rst_theme');
    const layout = localStorage.getItem('rst_layout');
    if (accent && accent !== 'purple') _applyAccentColor(accent);
    if (radius && radius !== 'default') _applyRadius(radius);
    if (theme  && theme  !== 'dark')   _applyTheme(theme);
    // Migrate old compact/minimal layouts
    const validLayouts = ['classic','dashboard','landing'];
    const safeLayout = validLayouts.includes(layout) ? layout : (layout==='minimal'?'landing':'classic');
    if (safeLayout !== 'classic') {
      _applyLayout(safeLayout);
      // Init banner after render if landing
      if (safeLayout === 'landing') setTimeout(_initRobuxBanner, 300);
    }
    if (layout && !validLayouts.includes(layout)) localStorage.setItem('rst_layout', 'classic');
  })();


  // ── i18n: полноценная локализация через TreeWalker + MutationObserver ──
  const _i18n = {
    ru: {},
    en: {
      // Navigation
      'Главная': 'Home', 'Инструменты': 'Tools',
      'Магазин': 'Shop', 'Профиль': 'Profile', 'Админ': 'Admin',
      'Пополнить': 'Add funds', 'Мои покупки': 'My orders',
      'Мои обращения': 'My tickets', 'Настройки': 'Settings', 'Выйти': 'Sign out',
      'Войти': 'Sign in', 'Регистрация': 'Sign up',
      // Actions
      'Оставить отзыв': 'Write a review',
      'Купить': 'Buy', 'Получить': 'Get free', 'Получить бесплатно': 'Get free', 'Открыть': 'Open', 'Бесплатно': 'Free', 'Нет в наличии': 'Out of stock', 'Описание': 'Description',
      'Бесплатно': 'Free', 'Подробнее': 'Details',
      'Все товары': 'All', 'Новинки': 'New',
      'Популярное': 'Popular', 'Скидки': 'Sale',
      'Закрыть': 'Close', 'Перейти': 'Go to', 'Отмена': 'Cancel',
      'Отправить': 'Submit', 'Сохранить': 'Save',
      'Загрузка...': 'Loading...', 'Ошибка': 'Error',
      'Подтвердить': 'Confirm', 'Удалить': 'Delete',
      'Редактировать': 'Edit', 'Назад': 'Back', 'Вперёд': 'Next',
      // Sections
      'Возможности': 'Features', 'Как это работает': 'How it works',
      'Частые вопросы': 'FAQ', 'Отзывы': 'Reviews',
      'Что говорят пользователи': 'What users say',
      'Четыре простых шага': 'Four simple steps',
      'Всё что нужно — в одном месте': 'Everything you need — in one place',
      // Search & Filter
      'Поиск': 'Search', 'Сортировка': 'Sort by',
      'По популярности': 'Popular', 'Дешевле': 'Price ↑', 'Дороже': 'Price ↓',
      'Поиск товаров...': 'Search products...', 'Ваш профиль': 'Your profile',
      'История покупок': 'Purchase history', 'Рефералы': 'Referrals',
      'Промокод': 'Promo code', 'Пополнить баланс': 'Add funds',
      'В наличии': 'In stock', 'Нет в наличии': 'Out of stock',
      'Скоро': 'Soon', 'Хит': 'Hot', 'Описание': 'Info',
      // Hero Section
      'Магазин цифровых услуг': 'Digital services store',
      'Покупка Robux, генератор описаний, AI-помощник и Premium подписка.': 'Robux purchase, description generator, AI assistant and Premium subscription.',
      'Безопасно, быстро и удобно.': 'Safe, fast and convenient.',
      'Безопасные платежи': 'Secure payments',
      'Мгновенная выдача': 'Instant delivery',
      'Поддержка 24/7': '24/7 Support',
      // Features
      'Robux по нику': 'Robux by username',
      'Вводишь ник — система находит профиль, игры и геймпасс автоматически': 'Enter username — system finds profile, games and gamepass automatically',
      'Генератор описаний': 'Description Generator',
      'Анализ публичного профиля по нику и генерация текста по шаблону': 'Public profile analysis by username and text generation by template',
      'AI помощник': 'AI Assistant',
      'Чат с ИИ для создания уникальных текстов под любой стиль': 'AI chat for creating unique texts in any style',
      'Premium': 'Premium',
      'Безлимитные запросы, приоритет и расширенные возможности': 'Unlimited requests, priority and extended features',
      // FAQ
      'Как давно вы на рынке?': 'How long have you been on the market?',
      'RBX ST работает с начала 2026 года. За это время мы обслужили сотни клиентов и продолжаем расти. Команда состоит из людей, которые сами играют в Roblox и понимают, что нужно игрокам.': 'RBX ST has been operating since early 2026. During this time we have served hundreds of clients and continue to grow. The team consists of people who play Roblox themselves and understand what players need.',
      'Можно ли вам доверять?': 'Can you be trusted?',
      'Мы работаем открыто — у нас есть отзывы реальных пользователей, Telegram-канал и поддержка 24/7. Все транзакции проходят через безопасные методы, мы не просим пароли от аккаунтов. Если что-то пойдёт не так — мы всегда на связи.': 'We operate openly — we have reviews from real users, a Telegram channel and 24/7 support. All transactions go through secure methods, we do not ask for account passwords. If something goes wrong — we are always available.',
      'Не забанят ли меня за покупку Robux у вас?': 'Will I get banned for buying Robux from you?',
      'Нет. Доставка идёт через геймпассы — это штатный механизм Roblox. Мы не используем эксплойты и не трогаем твой аккаунт. Нужен только ник, и Robux поступают как обычная покупка геймпасса.': 'No. Delivery is via gamepasses — this is a standard Roblox mechanism. We do not use exploits and do not touch your account. We only need your username, and Robux arrive as a normal gamepass purchase.',
      'Что делать, если Robux не пришли?': 'What to do if Robux did not arrive?',
      'Подожди 10–15 минут — Roblox иногда задерживает зачисление. Если прошло больше получаса — напиши в поддержку с номером заказа, разберёмся и решим вопрос.': 'Wait 10–15 minutes — Roblox sometimes delays crediting. If more than half an hour has passed — write to support with your order number, we will sort it out and solve the issue.',
      'Какие инструменты есть и что из них бесплатно?': 'What tools are available and what is free?',
      'Как быстро доставляют товары из магазина?': 'How fast are shop orders delivered?',
      'Большинство товаров доставляются автоматически сразу после оплаты. Robux — в течение нескольких минут после подтверждения. Если что-то пошло не так — обращайтесь в поддержку, разберёмся.': "Most items are delivered automatically right after payment. Robux within a few minutes after confirmation. Contact support if needed.",
      'Чекер аккаунтов, прокси-чекер и AI-чат доступны бесплатно с ограничениями. Генератор описаний и расширенный доступ к AI — по Premium-подписке. Подписка стоит 109 ₽ на 50 дней.': 'Account checker, proxy checker and AI chat are available for free with limitations. Description generator and extended AI access — via Premium subscription. Subscription costs $1.2 for 50 days.',
      // CTA
      'Готов начать?': 'Ready to start?',
      'Покупай Robux, проверяй аккаунты и используй AI-инструменты — всё в одном месте': 'Buy Robux, check accounts and use AI tools — all in one place',
      'Покупай Robux, приобретай аккаунты и эксклюзивные товары — всё в одном месте': 'Buy Robux, get accounts and exclusive items — all in one place',
      // Robux Page
      'Покупка Robux': 'Buy Robux',
      'Быстро и безопасно. Вводишь ник — получаешь Robux.': 'Fast and secure. Enter username — get Robux.',
      'В наличии': 'In stock',
      'Безопасно': 'Secure',
      'Транзакции через геймпассы': 'Transactions via gamepasses',
      'Быстро': 'Fast',
      'Доставка от 1 минуты': 'Delivery from 1 minute',
      'Выгодно': 'Profitable',
      'Курс ниже рынка': 'Rate below market',
      'Поддержка': 'Support',
      'Помощь 24/7': '24/7 Help',
      'Калькулятор': 'Calculator',
      'Курс': 'Rate',
      'Количество Robux': 'Robux amount',
      'К оплате': 'To pay',
      'Цена геймпасса': 'Gamepass price',
      'Обычный': 'Normal',
      'Авто': 'Auto',
      'По нику': 'By username',
      'По ссылке': 'By URL',
      'Ник Roblox': 'Roblox username',
      'Латиница, цифры и подчёркивание. Без кириллицы!': 'Latin letters, numbers and underscores. No Cyrillic!',
      'Ссылка на геймпасс': 'Gamepass URL',
      'Проверить': 'Check',
      'Проверяем...': 'Checking...',
      // Tools
      'Чекер аккаунтов': 'Account Checker',
      'Проверь аккаунт по cookie — получи полную статистику: RAP, баланс, 2FA, группы, инвентарь и многое другое.': 'Check account by cookie — get full statistics: RAP, balance, 2FA, groups, inventory and more.',
      'Одиночный': 'Single',
      'RAP & 2FA': 'RAP & 2FA',
      'ИИ': 'AI',
      'Шаблоны': 'Templates',
      'Чат с ИИ': 'AI Chat',
      'Умный ассистент по Roblox — поможет с любыми вопросами 24/7. Отвечает мгновенно.': 'Smart Roblox assistant — will help with any questions 24/7. Responds instantly.',
      '24/7': '24/7',
      'Roblox эксперт': 'Roblox expert',
      'Прокси Чекер': 'Proxy Checker',
      'Загрузи файл с прокси — узнай какие рабочие, их скорость и протоколы. Экспорт рабочих в один клик.': 'Upload file with proxies — find out which ones work, their speed and protocols. Export working ones in one click.',
      'HTTP/SOCKS': 'HTTP/SOCKS',
      'До 200 потоков': 'Up to 200 threads',
      'Массовый чекер': 'Mass Checker',
      'Загрузи файл с куки для массовой проверки аккаунтов. Функция временно недоступна — ведутся работы.': 'Upload file with cookies for mass account checking. Feature temporarily unavailable — work in progress.',
      'Временно закрыт': 'Temporarily closed',
      'Скоро вернётся': 'Will return soon',
      'Назад': 'Back',
      'Cookie (.ROBLOSECURITY)': 'Cookie (.ROBLOSECURITY)',
      'Вставь .ROBLOSECURITY cookie аккаунта...': 'Paste .ROBLOSECURITY account cookie...',
      'Проверить аккаунт': 'Check account',
      'Загрузи файл с куки': 'Upload file with cookies',
      'Перетащи .txt файл сюда или нажми для выбора': 'Drag .txt file here or click to select',
      'Макс. 20 МБ · одна куки на строку': 'Max 20 MB · one cookie per line',
      'Выбрать файл': 'Select file',
      'Проверка аккаунтов...': 'Checking accounts...',
      // Notifications
      'Уведомления': 'Notifications',
      'Прочитать все': 'Mark all as read',
      'Нет уведомлений': 'No notifications',
      // Profile
      'Баланс': 'Balance',
      'Пополнить': 'Add funds',
      'История операций': 'Transaction history',
      'Premium подписка': 'Premium subscription',
      'Активна': 'Active',
      'Не активна': 'Not active',
      'Дней осталось': 'Days left',
      'Активировать': 'Activate',
      'Продлить': 'Extend',
      // Settings
      'Язык': 'Language',
      'Тема': 'Theme',
      'Уведомления': 'Notifications',
      'Конфиденциальность': 'Privacy',
      'Безопасность': 'Security',
      'Пароль': 'Password',
      'Email': 'Email',
      'Телефон': 'Phone',
      'Двухфакторная аутентификация': 'Two-factor authentication',
      'Включить': 'Enable',
      'Отключить': 'Disable',
      // Common
      'Успешно': 'Success',
      'Готово': 'Done',
      'Применить': 'Apply',
      'Очистить': 'Clear',
      'Сбросить': 'Reset',
      'Обновить': 'Refresh',
      'Добавить': 'Add',
      'Создать': 'Create',
      'Изменить': 'Change',
      'Просмотр': 'View',
      'Статус': 'Status',
      'Дата': 'Date',
      'Время': 'Time',
      'Сумма': 'Amount',
      'Тип': 'Type',
      'Описание': 'Description',
      'Комментарий': 'Comment',
      'Примечание': 'Note',
      'Действия': 'Actions',
      'Результат': 'Result',
      'Данные': 'Data',
      'Информация': 'Information',
      'Помощь': 'Help',
      'Поддержка': 'Support',
      'Контакты': 'Contacts',
      'Документы': 'Documents',
      'Политика конфиденциальности': 'Privacy Policy',
      'Пользовательское соглашение': 'Terms of Service',
      'Публичная оферта': 'Public Offer',
      // Messages
      'Превышено время ожидания. Попробуй ещё раз.': 'Timeout exceeded. Try again.',
      'Нет данных для отображения': 'No data to display',
      'Покупок пока нет': 'No purchases yet',
      'Приобретайте товары и они появятся здесь': 'Make purchases and they will appear here',
      'Вы уверены?': 'Are you sure?',
      'Это действие нельзя отменить': 'This action cannot be undone',
      'Обработка...': 'Processing...',
      'Подождите...': 'Please wait...',
      'Успешно сохранено': 'Successfully saved',
      'Ошибка сохранения': 'Save error',
      'Попробуйте ещё раз': 'Try again',
      'Связаться с поддержкой': 'Contact support',
      // Footer
      'Все права защищены': 'All rights reserved',
      'Разработано': 'Developed by',
      'Сайт работает с 2026 года': 'Site has been operating since 2026',
      // Settings Modal
      '⚙️ Настройки': '⚙️ Settings',
      '🌐 Общие': '🌐 General',
      '🔒 Безопасность': '🔒 Security',
      '🔔 Уведомления': '🔔 Notifications',
      '🎨 Оформление': '🎨 Design',
      'Язык интерфейса': 'Interface language',
      'Выбор языка и валюты': 'Language and currency',
      'Часовой пояс': 'Timezone',
      'Для отображения дат и времени': 'For dates and time display',
      'Предотвратить закрытие окон': 'Prevent window close',
      'Клик в пустую область не закрывает модальные окна': 'Clicking empty area does not close modal windows',
      '🔑 Смена пароля': '🔑 Change password',
      'Текущий пароль': 'Current password',
      'Новый пароль (мин. 6)': 'New password (min. 6)',
      'Повторите новый пароль': 'Repeat new password',
      'Сменить пароль': 'Change password',
      '✉️ Смена Email': '✉️ Change Email',
      'Текущий:': 'Current:',
      'Новый email': 'New email',
      'Пароль для подтверждения': 'Password to confirm',
      'Сменить Email': 'Change Email',
      '2FA по Email': '2FA via Email',
      'Код подтверждения при каждом входе': 'Confirmation code on each login',
      '⚠ Выйти на всех устройствах': '⚠ Sign out on all devices',
      'Email-рассылка': 'Email newsletter',
      'Новости, акции и спецпредложения': 'News, promotions and special offers',
      'Push-уведомления': 'Push notifications',
      'Уведомления в браузере': 'Browser notifications',
      'Скоро': 'Soon',
      'Уведомления о заказах': 'Order notifications',
      'Email после каждой покупки': 'Email after each purchase',
      '🎨 Акцентный цвет': '🎨 Accent color',
      'Фиолет': 'Purple', 'Синий': 'Blue', 'Зелёный': 'Green',
      'Оранж': 'Orange', 'Розовый': 'Pink',
      '📐 Закруглённость': '📐 Border radius',
      '▪ Острые': '▪ Sharp', '◼ Стандарт': '◼ Default', '● Круглые': '● Round',
      '🌙 Тема оформления': '🌙 Theme',
      '🌑 Тёмная': '🌑 Dark', '⚫ AMOLED': '⚫ AMOLED', '🌫 Dim': '🌫 Dim',
      '🖥 Интерфейс': '🖥 Interface',
      '🏠 Классик': '🏠 Classic', '📊 Dashboard': '📊 Dashboard', '✦ Minimal': '✦ Minimal',
      'Анимации': 'Animations',
      'Плавные переходы и эффекты': 'Smooth transitions and effects',
      '🛍 Магазин': '🛍 Shop',
      'Новый интерфейс (Beta)': 'New interface (Beta)',
      'Сегментированные категории и пилюли': 'Segmented categories and pills',
      'Перезагрузит магазин для применения': 'Will reload shop to apply',
      // Shop
      'Цена': 'Price', 'Товар': 'Product', 'Категория': 'Category',
      'Корзина': 'Cart', 'Итого': 'Total',
      'Оформить заказ': 'Place order', 'Списано с баланса': 'Debited from balance',
      'Товар доставлен': 'Product delivered', 'Ожидание': 'Pending',
      'Выполнен': 'Completed', 'Отменён': 'Cancelled', 'Ошибка доставки': 'Delivery error',
      'Нет товаров в этой категории': 'No products in this category',
      'Мгновенная доставка': 'Instant delivery',
      // Profile
      'Ваш баланс': 'Your balance', 'Мой профиль': 'My profile',
      'Присоединился': 'Joined', 'Email подтверждён': 'Email verified',
      'Email не подтверждён': 'Email not verified',
      'Реферальная ссылка': 'Referral link', 'Скопировано!': 'Copied!',
      'Приглашённых': 'Invited', 'Заработано': 'Earned',
      'Нет обращений': 'No tickets', 'Нет уведомлений': 'No notifications',
      // Tools page
      'Мощные инструменты для работы с Roblox': 'Powerful tools for Roblox',
      'Обзор': 'Overview', 'Чекер': 'Checker', 'Описания': 'Descriptions',
      'AI Chat': 'AI Chat', 'Прокси': 'Proxy',
      'Привет! Я ИИ-ассистент RBX ST': 'Hi! I am RBX ST AI assistant',
      'Создай чат, чтобы начать общение': 'Create a chat to start',
      'Напиши сообщение...': 'Write a message...',
      'Новый чат': 'New chat', 'Нет чатов': 'No chats',
      'Выбери или создай чат': 'Select or create a chat',
      'Нажми «Новый чат» чтобы начать': 'Click "New chat" to start',
      'Чат создан': 'Chat created',
      'Контекст сайта': 'Site context',
      // Robux
      'Найдено': 'Found', 'Игры:': 'Games:', 'Геймпассы:': 'Gamepasses:',
      'Профиль найден': 'Profile found', 'Профиль не найден': 'Profile not found',
      'Геймпасс создаётся...': 'Creating gamepass...', 'Геймпасс создан': 'Gamepass created',
      'Оплатить с баланса': 'Pay from balance', 'Оплатить': 'Pay',
      'Заказ создан': 'Order created', 'Заказ выполнен': 'Order completed',
      'Ожидание оплаты': 'Waiting for payment',
      // Topup
      'Пополнение баланса': 'Top up balance',
      'Карта / СБП': 'Card / FPS', 'Перевод вручную': 'Manual transfer',
      'Подтверждение администратором': 'Admin confirmation',
      'Бесплатные бонусы': 'Free bonuses',
      'Мои пополнения': 'My top-ups', 'История и проверка оплат': 'History and payment check',
      // Support widget
      'Привет! Чем могу помочь?': 'Hi! How can I help?',
      '💎 Robux и доставка': '💎 Robux and delivery',
      '💳 Оплата и возвраты': '💳 Payments and refunds',
      '🎁 Кейсы и призы': '🎁 Cases and prizes',
      '👤 Аккаунт и Premium': '👤 Account and Premium',
      '⚠️ Сообщить об ошибках': '⚠️ Report bugs',
      'Не нашли ответ?': "Didn't find an answer?",
      'Написать в TG': 'Write on TG',
      'Начать чат': 'Start chat',
      'Назад к FAQ': 'Back to FAQ',
      // Checker
      'Загрузи файл с прокси': 'Upload proxy file',
      'Перетащи .txt файл или нажми для выбора': 'Drag .txt file or click to select',
      'Потоки:': 'Threads:', 'Проверка прокси...': 'Checking proxies...',
      '📊 Итог': '📊 Summary',
      '💰 Финансы': '💰 Finance', '👥 Социальное': '👥 Social',
      '🎮 Рублокс': '🎮 Roblox', '🔐 Безопасность': '🔐 Security',
      '🕵️ Приватность': '🕵️ Privacy', '🏠 Топ группы': '🏠 Top groups',
      'Друзья': 'Friends', 'Фолловеры': 'Followers', 'Фолловинги': 'Following',
      'Групп': 'Groups', 'Своих групп': 'Own groups', 'Участников': 'Members',
      'Лимитки': 'Limiteds', 'Геймпассы': 'Gamepasses', 'Бейджи': 'Badges',
      'Игры': 'Games', 'Визиты': 'Visits',
      'Подтверждён': 'Verified', 'Не подтверждён': 'Not verified',
      'Не привязан': 'Not linked', 'Установлен': 'Set', 'Не установлен': 'Not set',
      'Включён': 'Enabled', 'Выключен': 'Disabled',
      'Верифицирован': 'Verified', 'Сессии': 'Sessions',
      'Инвентарь': 'Inventory', 'Трейдинг': 'Trading',
      'Можно торговать': 'Can trade', 'Да': 'Yes', 'Нет': 'No',
      'Аккаунт проверен!': 'Account checked!',
      'Ошибка проверки': 'Check error',
      'АКТИВЕН': 'ACTIVE',
      // Homepage extra
      'Возможные вопросы': 'Frequently Asked Questions',
      'Новинка 2026': 'New in 2026',
      'Следите за обновлениями в': 'Follow updates on',
      'Мы скоро появимся с новостями': 'We will be back soon with news',
      'Магазин цифровых услуг': 'Digital services store',
      // Robux flow
      'Купить Robux': 'Buy Robux',
      'Покупка по нику': 'Buy by username',
      'Покупка по ссылке': 'Buy by URL',
      'Самый простой способ — укажи ник и количество Robux.': 'The simplest way — enter username and Robux amount.',
      'Введи ник Roblox и количество R$': 'Enter Roblox username and R$ amount',
      'Система найдёт профиль и публичные игры': 'System will find profile and public games',
      'Система сама создаст геймпасс': 'System will create a gamepass automatically',
      'Подберёт геймпасс с нужной ценой': 'Will find gamepass with the right price',
      'Робуксы поступят тебе на счёт!': 'Robux will be credited to your account!',
      'Если у тебя есть готовый геймпасс — вставь ссылку.': 'If you have a ready gamepass — paste the URL.',
      'Вставь в поле и нажми «Купить»': 'Paste in the field and click "Buy"',
      'Скопируй ссылку на геймпасс': 'Copy the gamepass link',
      'Создай геймпасс в Roblox Studio': 'Create a gamepass in Roblox Studio',
      'Установи нужную цену и опубликуй': 'Set the desired price and publish',
      'Для Premium — геймпасс создаётся автоматически.': 'For Premium — gamepass is created automatically.',
      'Если геймпасс не найден — вставь куки': 'If gamepass not found — paste cookie',
      'Покупка произойдёт мгновенно!': 'Purchase will happen instantly!',
      'К оплате:': 'To pay:',
      'Цена:': 'Price:',
      'Цена геймпасса:': 'Gamepass price:',
      'Включи авто-режим переключателем': 'Enable auto-mode with the switch',
      'Курс: — ₽/R$': 'Rate: — ₽/R$',
      '— R$': '— R$', '— ₽': '— $',
      // Profile extras
      'Статистика': 'Statistics',
      'Пополнения и траты': 'Top-ups and spending',
      'Пополнено': 'Topped up', 'Потрачено': 'Spent', 'Итог': 'Total',
      'Покупки': 'Purchases', 'Мои предметы': 'My items',
      'История': 'History', '0 ₽': '0 $',
      '7д': '7d', '30д': '30d', '90д': '90d', 'Всё': 'All',
      // Topup
      'Сумма пополнения': 'Top-up amount',
      'Способ:': 'Method:', 'Продолжить': 'Continue',
      'CryptoBot / промокод': 'CryptoBot / promo code',
      'Мои пополнения': 'My top-ups',
      // Tools & Checker
      'Новая проверка': 'New check',
      'Копировать': 'Copy', '📋 Копировать': '📋 Copy',
      'Генератор Описаний': 'Description Generator',
      'Создавай продающие описания для аккаунтов с помощью ИИ или готовых шаблонов. Копируй одним кликом.': 'Create selling descriptions for accounts using AI or ready templates. Copy in one click.',
      'Авто-покупка': 'Auto-purchase',
      'Стиль': 'Style', 'Тон': 'Tone',
      'Агрессивный': 'Aggressive', 'Дружелюбный': 'Friendly',
      'Информативный': 'Informative', 'Короткий': 'Short',
      'Рерайт': 'Rewrite', 'Пожелания (необязательно)': 'Wishes (optional)',
      // Proxy checker
      '✅ Рабочие прокси': '✅ Working proxies',
      'Форматы: host:port · user:pass@host:port · protocol://host:port': 'Formats: host:port · user:pass@host:port · protocol://host:port',
      'Поддерживаются форматы: с префиксом .ROBLOSECURITY= и без него': 'Supported formats: with .ROBLOSECURITY= prefix and without',
      // Auth
      'Войдите в аккаунт': 'Sign in to your account',
      'Авторизуйтесь для доступа к инструментам и покупкам': 'Sign in for access to tools and purchases',
      'Забыл пароль': 'Forgot password',
      // Support FAQ
      'Как купить Robux?': 'How to buy Robux?',
      'Как пополнить баланс?': 'How to top up balance?',
      'Как купить Premium?': 'How to buy Premium?',
      'Что даёт Premium?': 'What does Premium give?',
      'Безопасно ли покупать?': 'Is it safe to buy?',
      'Сколько ждать доставку?': 'How long to wait for delivery?',
      'Как работают кейсы?': 'How do cases work?',
      'Ошибка при оплате': 'Payment error',
      'Не получил приз из кейса': 'Did not receive case prize',
      'Как оформить возврат или замену?': 'How to request refund or replacement?',
      'Сколько рассматривается заявка?': 'How long does a request take?',
      'Другая проблема': 'Other problem',
      'Баги, лагает сайт, что-то не работает': 'Bugs, site lag, something not working',
      'Написать': 'Write', 'Найти': 'Find', 'Сообщение': 'Message',
      // Shop extras
      'Выбирай товар — дальше всё сделаем автоматически': 'Choose a product — we will do the rest automatically',
      'Сначала дешёвые': 'Cheapest first', 'Сначала дорогие': 'Most expensive first',
      'Нет данных': 'No data',
      'Загрузка отзывов...': 'Loading reviews...',
      '⭐ Отзывы': '⭐ Reviews',
      // Admin panel
      'Админ-панель': 'Admin panel',
      'Быстрые действия': 'Quick actions',
      '🛡 Admin': '🛡 Admin',
      '📊 Все': '📊 All',
      '🔵 Активные': '🔵 Active',
      '🚫 Отменённые': '🚫 Cancelled',
      '✅ Завершённые': '✅ Completed',
      'Открытые': 'Open', 'Закрытые': 'Closed',
      'Ожидают': 'Pending', 'Оплачены': 'Paid', 'Отменены': 'Cancelled',
      'Платежи': 'Payments', 'Метод': 'Method', 'Код': 'Code',
      'Бан': 'Ban', 'Создан': 'Created', 'Создано': 'Created',
      'Использований': 'Uses', 'Лимит использований': 'Usage limit',
      'История заказов Robux': 'Robux order history',
      'Все покупки робуксов с деталями и статусами': 'All Robux purchases with details and statuses',
      'Заявки на пополнение и статусы оплат': 'Top-up requests and payment statuses',
      'Поиск, бан, баланс, история операций': 'Search, ban, balance, transaction history',
      'Управление тикетами пользователей': 'User ticket management',
      'Все диалоги пользователей с ИИ-ассистентом. ⚠️ — просил оператора': 'All user AI assistant dialogs. ⚠️ — requested operator',
      'Модерация отзывов': 'Review moderation',
      'Создание и список промо': 'Create and list promos',
      'Управление магазином и Roblox-аккаунтами': 'Shop and Roblox account management',
      'Roblox: аккаунты': 'Roblox: accounts',
      'Robux: настройки': 'Robux: settings',
      'Аккаунты-продавцы для автоматической покупки геймпассов': 'Seller accounts for automatic gamepass purchase',
      'Начисление баланса (₽)': 'Balance credit ($)',
      '💰 Цена за 1 Robux (₽)': '💰 Price per 1 Robux ($)',
      '📐 Коэф. геймпасса': '📐 Gamepass coefficient',
      '📊 Лимит продажи': '📊 Sale limit',
      '🏷 Комиссия (₽)': '🏷 Commission ($)',
      '📝 Название': '📝 Name',
      '📧 Email': '📧 Email',
      '🔑 Cookie (.ROBLOSECURITY)': '🔑 Cookie (.ROBLOSECURITY)',
      'Цены, коэффициенты и лимиты': 'Prices, coefficients and limits',
      'Режим тех. работ': 'Maintenance mode',
      'Режим тех. работ блокирует все API кроме авторизации': 'Maintenance mode blocks all API except auth',
      'Техническое обслуживание': 'Maintenance',
      '🔧 Тех. работы': '🔧 Maintenance',
      'Отправить тест': 'Send test',
      '📢 Отправить уведомление': '📢 Send notification',
      'Отправляйте уведомления пользователям на сайт': 'Send notifications to users on site',
      '🔔 Рассылка': '🔔 Mailing', '🔔 Рассылка уведомлений': '🔔 Notification mailing',
      'Статус Brevo и тестовые письма': 'Brevo status and test emails',
      'Подсказка: проверь BREVO_API_KEY / BREVO_SENDER / домен-отправитель.': 'Hint: check BREVO_API_KEY / BREVO_SENDER / sender domain.',
      '💾 Хранилище данных': '💾 Data storage',
      'Проверь, что БД на persistent volume — иначе данные пропадут при редеплое': 'Check that DB is on persistent volume — otherwise data is lost on redeploy',
      '🔄 Обновить конфиг': '🔄 Update config',
      '🔄 Пересчитать балансы из истории': '🔄 Recalculate balances from history',
      '🔍 Проверить колонку balance в БД': '🔍 Check balance column in DB',
      'Скачать архив': 'Download archive',
      'Режим редактора': 'Editor mode', 'Режим редактора активен': 'Editor mode active',
      'Редактор магазина': 'Shop editor',
      'Нажми «Включить режим редактора»': 'Click "Enable editor mode"',
      'Включи режим редактора — затем перейди во вкладку «Магазин» и редактируй прямо на странице': 'Enable editor mode — then go to "Shop" tab and edit directly on page',
      'Нажимай ✏ на карточках, добавляй товары и категории': 'Click ✏ on cards, add products and categories',
      'Нажми «💾 Сохранить» в жёлтой панели вверху магазина': 'Click "💾 Save" in the yellow bar at top of shop',
      '+ Категория': '+ Category', '+ Товар': '+ Product',
      '↩ Сброс к умолчаниям': '↩ Reset to defaults',
      '⭐ Premium': '⭐ Premium',
      '👥 Пользователи': '👥 Users',
      '🟣 Robux': '🟣 Robux',
      '💬 Заявки': '💬 Tickets',
      '💬 История ИИ-чатов': '💬 AI chat history',
      '💳 Платежи': '💳 Payments',
      '📋 Заявки в поддержку': '📋 Support tickets',
      '🎟 Промокоды': '🎟 Promo codes',
      '🎁 Все ваучеры': '🎁 All vouchers',
      '🏪 Магазин': '🏪 Shop',
      'Премиум': 'Premium',
      '✕ Выйти': '✕ Sign out',
      'выключен': 'disabled',
      // Missing translations
      'Гость': 'Guest',
      'В наличии:': 'In stock:',
      'Выбери количество, введи ник или ссылку, проверь и купи.': 'Choose amount, enter username or URL, check and buy.',
      'Продающий': 'Selling',
      'Классика': 'Classic',
      '💾 Сохранить': '💾 Save',
      'Пользователь': 'User',
      'Пополнения': 'Top-ups',
      'Траты': 'Spending',
      'Промокоды': 'Promo codes',
      'Пользователи': 'Users',
      'Логин': 'Login',
      'Польз.': 'User',
      'Условия возврата': 'Refund policy',
      '© 2026 RBX ST. Все права защищены.': '© 2026 RBX ST. All rights reserved.',
      'Не нашли ответ?': "Didn't find an answer?",
      '⟳': '⟳', '⚙️': '⚙️', '🗑': '🗑', '📋': '📋', '📢': '📢', '🔗': '🔗', '»': '»', '✕': '✕',
    }
  };

  let _i18nObserving = false;
  // ── Currency conversion (independent of language) ──
  function _applyCurrency() {
    const curr = localStorage.getItem('rst_currency') || 'rub';
    if (curr === 'rub') return;
    const rate = 0.011; // approximate RUB to USD
    const sym = '$';

    const _convertCurrency = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName?.toUpperCase();
          if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','CODE','PRE'].includes(tag)) return NodeFilter.FILTER_REJECT;
          if (!node.textContent.includes('₽')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      nodes.forEach(tn => {
        tn.textContent = tn.textContent.replace(/([−\-]?)(\d[\d\s,.]*)\s*₽/g, (match, sign, num) => {
          const val = parseFloat(num.replace(/\s/g, '').replace(',', '.'));
          if (isNaN(val)) return match;
          const usd = (val * rate).toFixed(2);
          return sign + sym + usd;
        });
        tn.textContent = tn.textContent.replace(/₽\/R\$/g, sym + '/R$');
        tn.textContent = tn.textContent.replace(/₽/g, sym);
      });
    };

    _convertCurrency(document.body);

    // Observe new DOM nodes
    if (!window._currObserving) {
      window._currObserving = true;
      new MutationObserver(mutations => {
        if ((localStorage.getItem('rst_currency') || 'rub') === 'rub') return;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) _convertCurrency(node);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  window._applyCurrency = _applyCurrency;

  function _applyI18n() {
    const lang = localStorage.getItem('rst_lang') || 'ru';
    // Always apply currency regardless of language
    _applyCurrency();
    if (lang === 'ru') return;
    const dict = _i18n[lang];
    if (!dict || !Object.keys(dict).length) return;

    const _translateNode = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName?.toUpperCase();
          if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','CODE','PRE'].includes(tag)) return NodeFilter.FILTER_REJECT;
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      nodes.forEach(tn => {
        const trimmed = tn.textContent.trim();
        if (dict[trimmed] !== undefined) {
          tn.textContent = tn.textContent.replace(trimmed, dict[trimmed]);
        }
      });
    };

    _translateNode(document.body);
    document.querySelectorAll('[placeholder]').forEach(el => {
      const ph = el.getAttribute('placeholder');
      if (ph && dict[ph]) el.setAttribute('placeholder', dict[ph]);
    });

    // Re-render shop to apply currency conversion
    if (typeof renderShop === 'function') {
      try { renderShop(); } catch(e) {}
    }

    if (!_i18nObserving) {
      _i18nObserving = true;
      new MutationObserver(mutations => {
        const lang = localStorage.getItem('rst_lang') || 'ru';
        if (lang === 'ru') return;
        const dict = _i18n[lang];
        if (!dict) return;
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) _translateNode(node);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  window._applyI18n = _applyI18n;

    // ====== USER DROPDOWN MENU ======
  function initUserDropdown() {
    const btn = $('#avatarBtn');
    const dd = $('#userDropdown');
    if (!btn || !dd) return;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // If not logged in, show login
      if (!state.user) { showLogin(); return; }
      dd.classList.toggle('show');
    });

    document.addEventListener('click', (e) => {
      if (!dd.contains(e.target) && !btn.contains(e.target)) {
        dd.classList.remove('show');
      }
    });

    // Dropdown items
    dd.querySelectorAll('.dropdown-item[data-tab]').forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.dataset.tab;
        dd.classList.remove('show');
        if (tab) switchTab(tab);
      });
    });

    $('#dropdownTopUp')?.addEventListener('click', () => {
      dd.classList.remove('show');
      showTopUp();
    });

    $('#dropdownMyPurchases')?.addEventListener('click', () => {
      dd.classList.remove('show');
      showPurchasesPopup();
    });

    $('#dropdownMyTickets')?.addEventListener('click', () => {
      dd.classList.remove('show');
      showSupportModal();
    });

    $('#dropdownSettings')?.addEventListener('click', () => {
      dd.classList.remove('show');
      showSettingsPopup();
    });

    $('#dropdownLogout')?.addEventListener('click', () => {
      dd.classList.remove('show');
      api('/api/auth/logout', { method: 'POST' }).then(() => location.reload()).catch(() => location.reload());
    });
  }

  // Update dropdown with user data
  function updateDropdownUser() {
    if (!state.user) return;
    const uname = $('#dropdownUsername');
    const bal = $('#dropdownBalance');
    if (uname) uname.textContent = state.user.username || 'Гость';
    if (bal) bal.textContent = (state.user.balance ?? 0) + ' ₽';
  }

  // ====== SUPPORT FAB ======
  function initSupportFab() {
    const fabBtn = $('#supportFabBtn');
    const panel = $('#supportPanel');
    if (!fabBtn || !panel) return;

    fabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = panel.classList.toggle('show');
      fabBtn.classList.toggle('open', isOpen);
    });

    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && !fabBtn.contains(e.target)) {
        panel.classList.remove('show');
        fabBtn.classList.remove('open');
      }
    });

    // Close btn inside panel
    panel.querySelector('.support-close')?.addEventListener('click', () => {
      panel.classList.remove('show');
      fabBtn.classList.remove('open');
    });

    // FAQ inline buttons (legacy)
    panel.querySelectorAll('.support-faq-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const answerId = btn.dataset.answer;
        const answerEl = panel.querySelector(`[data-faq-answer="${answerId}"]`);
        panel.querySelectorAll('.support-faq-answer.show').forEach(a => {
          if (a !== answerEl) a.classList.remove('show');
        });
        answerEl?.classList.toggle('show');
      });
    });

    // FAQ accordion groups
    panel.querySelectorAll('.sfaq-group-hdr').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const body = hdr.nextElementSibling;
        const isOpen = body?.classList.contains('open');
        panel.querySelectorAll('.sfaq-group-body.open').forEach(b => {
          b.classList.remove('open');
          b.previousElementSibling?.classList.remove('open');
        });
        if (!isOpen && body) {
          body.classList.add('open');
          hdr.classList.add('open');
        }
      });
    });

    // FAQ quick answers
    panel.querySelectorAll('.sfaq-q').forEach(btn => {
      btn.addEventListener('click', () => {
        const answer = btn.dataset.a;
        if (!answer) return;
        // Show answer inline
        const existing = btn.nextElementSibling;
        if (existing?.classList.contains('sfaq-answer')) {
          existing.remove();
          return;
        }
        // Remove other answers
        panel.querySelectorAll('.sfaq-answer').forEach(a => a.remove());
        const div = document.createElement('div');
        div.className = 'sfaq-answer';
        div.innerHTML = '<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;padding:10px 12px;background:rgba(147,51,234,0.06);border-left:2px solid var(--accent-primary);border-radius:0 8px 8px 0;margin-top:6px;margin-bottom:4px">' + escapeHtml(answer) + '</div>';
        btn.insertAdjacentElement('afterend', div);
      });
    });

    // Contact admin button
    panel.querySelector('#supportContactAdmin')?.addEventListener('click', () => {
      window.open('https://t.me/E6JLAHOC', '_blank');
    });

    // Start AI chat button
    panel.querySelector('#supportStartChat')?.addEventListener('click', () => {
      _initSupportChat(panel);
    });

    // Back to FAQ
    panel.querySelector('#supportBackToFaq')?.addEventListener('click', () => {
      panel.querySelector('#supportViewFaq').style.display = '';
      panel.querySelector('#supportViewChat').style.display = 'none';
    });

    // Submit ticket
    panel.querySelector('#supportSubmitTicket')?.addEventListener('click', () => {
      const wrap = panel.querySelector('.support-ticket-form');
      if (wrap) wrap.classList.toggle('show');
    });

    panel.querySelector('#supportSendTicket')?.addEventListener('click', async () => {
      const text = panel.querySelector('#supportTicketText')?.value?.trim();
      if (!text) { toast('Введите описание', 'warning'); return; }
      try {
        await api('/api/support/create', { method:'POST', body:{ subject:'Обращение в поддержку', text, category:'other', attachment_urls:[] }});
        toast('✅ Заявка отправлена! Мы ответим в течение 24ч.', 'success');
        panel.querySelector('#supportTicketText').value = '';
        panel.querySelector('.support-ticket-form')?.classList.remove('show');
      } catch(e) {
        toast(e.message || 'Ошибка при отправке', 'error');
      }
    });
  }

  // ====== SUPPORT AI CHAT ======
  let _supportHistory = [];

  function _initSupportChat(panel) {
    panel.querySelector('#supportViewFaq').style.display = 'none';
    const chatView = panel.querySelector('#supportViewChat');
    chatView.style.display = 'flex';
    chatView.style.flexDirection = 'column';
    chatView.style.padding = '0';

    const msgs = panel.querySelector('#supportChatMsgs');
    const input = panel.querySelector('#supportChatInput');
    const sendBtn = panel.querySelector('#supportChatSend');
    if (!msgs || !input || !sendBtn) return;

    if (_supportHistory.length === 0) {
      // Load persisted history from server for logged-in users
      if (state.user) {
        msgs.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px">Загрузка истории...</div>';
        api('/api/support/ai_history', { silent: true }).then(hist => {
          msgs.innerHTML = '';
          if (hist?.messages?.length) {
            _supportHistory = hist.messages.map(m => ({ role: m.role, content: m.content }));
            hist.messages.forEach(m => _addSupportMsg(msgs, m.role === 'user' ? 'user' : 'bot', m.content));
          } else {
            _addSupportMsg(msgs, 'bot', 'Привет! 👋 Я AI-ассистент RBX ST. Чем могу помочь?');
          }
          msgs.scrollTop = msgs.scrollHeight;
        }).catch(() => {
          msgs.innerHTML = '';
          _addSupportMsg(msgs, 'bot', 'Привет! 👋 Я AI-ассистент RBX ST. Чем могу помочь?');
        });
      } else {
        _addSupportMsg(msgs, 'bot', 'Привет! 👋 Я AI-ассистент RBX ST. Чем могу помочь?');
      }
    } else {
      msgs.innerHTML = '';
      _supportHistory.forEach(m => _addSupportMsg(msgs, m.role === 'user' ? 'user' : 'bot', m.content));
    }

    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      _addSupportMsg(msgs, 'user', text);
      _supportHistory.push({ role: 'user', content: text });
      const typing = document.createElement('div');
      typing.className = 'sup-msg bot typing';
      typing.innerHTML = '<span></span><span></span><span></span>';
      msgs.appendChild(typing);
      msgs.scrollTop = msgs.scrollHeight;
      try {
        // Use dedicated support AI endpoint (no credits needed, uses context)
        const r = await api('/api/support/ai_chat', {
          method: 'POST',
          timeout: 90000,
          body: {
            message: text,
            history: _supportHistory.slice(-10).map(m => ({ role: m.role, content: m.content }))
          }
        });
        typing.remove();
        const reply = r?.response || r?.reply || 'Не смог ответить. Попробуй спросить иначе.';
        _supportHistory.push({ role: 'assistant', content: reply });
        _addSupportMsg(msgs, 'bot', reply);
        if (_supportHistory.length >= 4 || r.escalated) {
          panel.querySelector('#supportEscalateBtns').style.display = 'flex';
        }
      } catch(e) {
        typing.remove();
        let errMsg;
        if (e.message?.includes('401') || e.message?.includes('403')) {
          errMsg = 'Войдите в аккаунт, чтобы использовать AI-чат!';
        } else {
          errMsg = '❌ Ошибка AI-чата: ' + (e.detail || e.message || 'Неизвестная ошибка') + '\n\nПопробуй написать нам в Telegram!';
        }
        _addSupportMsg(msgs, 'bot', errMsg);
        panel.querySelector('#supportEscalateBtns').style.display = 'flex';
      }
    };

    sendBtn.onclick = send;
    input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

    // Escalate buttons
    panel.querySelector('#supportEscalateTg')?.addEventListener('click', () => {
      window.open('https://t.me/E6JLAHOC', '_blank');
    });
    panel.querySelector('#supportEscalateTicket')?.addEventListener('click', () => {
      if (state.user) showSupportModal();
      else showLogin();
      panel.classList.remove('show');
    });
  }

  function _addSupportMsg(container, role, text) {
    const div = document.createElement('div');
    div.className = `sup-msg ${role}`;
    // Render AI responses with basic formatting
    if (role === 'bot' && text) {
      let s = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
      // Convert bullet points
      s = s.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
          return `<div style="display:flex;gap:6px;margin:2px 0 2px 4px"><span style="color:var(--accent-tertiary);flex-shrink:0;margin-top:2px">•</span><span>${trimmed.slice(2)}</span></div>`;
        }
        return line ? line : '<div style="height:6px"></div>';
      }).join('');
      div.innerHTML = `<div style="line-height:1.55">${s}</div>`;
    } else {
      div.textContent = text;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

    // ====== LEGAL MODAL ======
  function initLegalModal() {
    const overlay = $('#legalModal');
    const content = $('#legalContent');
    const closeBtn = $('#legalModalClose');
    if (!overlay) return;

    const legalData = {
      terms: {
        title: 'Пользовательское соглашение',
        body: `
        <p>Дата редакции: январь 2026 г.</p>
        <p>Настоящее соглашение регулирует условия использования платформы RBX ST (далее — «Сервис»).</p>
        <p><strong>1. Предмет соглашения</strong></p>
        <p>1.1. Сервис предоставляет услуги по приобретению виртуальной валюты и цифровых товаров для платформы Roblox. Приобретаемые товары являются виртуальными; физическая доставка не осуществляется.</p>
        <p>1.2. Используя Сервис, вы подтверждаете, что вам исполнилось 18 лет, либо вы действуете с согласия законного представителя.</p>
        <p><strong>2. Права и обязанности</strong></p>
        <p>2.1. Пользователь обязан предоставлять достоверные данные при регистрации и не допускать использования своего аккаунта третьими лицами.</p>
        <p>2.2. Запрещается: использование Сервиса в мошеннических целях, создание нескольких аккаунтов для обхода ограничений, использование автоматических скриптов и ботов.</p>
        <p>2.3. Администрация вправе ограничить или заблокировать доступ при нарушении настоящего соглашения.</p>
        <p><strong>3. Ответственность</strong></p>
        <p>3.1. Сервис предоставляется «как есть». Администрация не гарантирует бесперебойную работу и не несёт ответственности за действия платформы Roblox.</p>
        <p>3.2. Ответственность Сервиса ограничена суммой оплаченного заказа.</p>`
      },
      privacy: {
        title: 'Политика конфиденциальности',
        body: `
        <p>Дата редакции: январь 2026 г.</p>
        <p>Настоящая политика описывает, какие данные мы собираем и как их используем.</p>
        <p><strong>1. Какие данные мы собираем</strong></p>
        <p>При регистрации: email и логин. При использовании Сервиса: история транзакций, IP-адреса, данные о сессиях. Платёжные данные обрабатываются платёжным провайдером и не хранятся на наших серверах.</p>
        <p><strong>2. Как мы используем данные</strong></p>
        <p>Для выполнения заказов, обеспечения безопасности, обратной связи и улучшения Сервиса. Мы не продаём и не передаём личные данные третьим лицам, за исключением случаев, предусмотренных законодательством РФ.</p>
        <p><strong>3. Хранение и защита</strong></p>
        <p>Данные хранятся на защищённых серверах с использованием шифрования. Вы вправе запросить удаление своих данных, обратившись в поддержку.</p>
        <p><strong>4. Cookie</strong></p>
        <p>Мы используем технические cookie для обеспечения работы Сервиса. Используя Сервис, вы соглашаетесь с их применением.</p>`
      },
      refund: {
        title: 'Условия возврата',
        body: `
        <p>Дата редакции: январь 2026 г.</p>
        <p><strong>1. Когда возврат возможен</strong></p>
        <p>1.1. Возврат осуществляется, если цифровой товар не был доставлен в течение 24 часов после подтверждения оплаты по причинам, не зависящим от покупателя.</p>
        <p>1.2. После успешной доставки товара возврат не производится, поскольку виртуальные товары не подлежат возврату согласно ст. 25 Закона РФ «О защите прав потребителей».</p>
        <p><strong>2. Как оформить возврат</strong></p>
        <p>2.1. Обратитесь в поддержку через форму на сайте или в Telegram, указав номер заказа и причину обращения.</p>
        <p>2.2. Заявки рассматриваются в течение 1–3 рабочих дней.</p>
        <p>2.3. Средства возвращаются тем же способом, которым была произведена оплата.</p>
        <p><strong>3. Спорные ситуации</strong></p>
        <p>Если вы считаете, что ваш вопрос решён несправедливо — свяжитесь с нами. Мы стараемся решать все споры в пользу клиента.</p>`
      },
      contacts: {
        title: 'Контакты',
        body: `
        <p>По всем вопросам обращайтесь через удобный для вас способ:</p>
        <p style="margin-top:16px"><strong>📧 Email:</strong><br>rbx3697@gmail.com</p>
        <p style="margin-top:12px"><strong>💬 Telegram:</strong><br><a href="https://t.me/E6JLAHOC" target="_blank" style="color:var(--accent-tertiary)">@E6JLAHOC</a></p>
        <p style="margin-top:16px;font-size:12px;color:var(--text-muted)">Время ответа: обычно в течение нескольких часов.</p>`
      }
    };

    // Footer legal links
    document.querySelectorAll('[data-legal]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const key = link.dataset.legal;
        const data = legalData[key];
        if (data && content) {
          content.innerHTML = `<h2>${data.title}</h2>${data.body}`;
          overlay.classList.add('show');
        }
      });
    });

    closeBtn?.addEventListener('click', () => overlay.classList.remove('show'));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('show');
    });
  }

  // ====== CHART SIZE FIX ======
  function fixChartSize() {
    const canvas = document.getElementById('profileChart');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    if (wrap) {
      wrap.style.position = 'relative';
      wrap.style.height = '200px';
      wrap.style.overflow = 'hidden';
    }
    canvas.style.maxHeight = '200px';
  }

  // ====== REVIEWS ======
  let _reviewsPage = 0;
  const _REVIEWS_PER_PAGE = 6; // homepage preview

  // Build one review card HTML — premium redesign
  // Sort state
  let _revSortMode = 'default';

  function _sortReviews(reviews) {
    if (!reviews) return [];
    const arr = [...reviews];
    if (_revSortMode === 'best')    return arr.sort((a,b) => b.rating - a.rating);
    if (_revSortMode === 'worst')   return arr.sort((a,b) => a.rating - b.rating);
    if (_revSortMode === 'premium') return arr.sort((a,b) => (b.is_premium?1:0) - (a.is_premium?1:0));
    return arr; // default: server order
  }

  function _truncName(name, max = 10) {
    if (!name) return '?';
    return name.length > max ? name.slice(0, max) + '…' : name;
  }

  function _buildReviewCard(r, idx, opts = {}) {
    const { animate = true, fullText = false } = opts;
    const initials = (r.username || '?')[0].toUpperCase();
    const shortName = _truncName(r.username, 10);
    const date = r.created_at ? _fmtDate(r.created_at) : '';
    const isOwn = state.user && (String(r.user_id) === String(state.user.id));
    const isPremium = !!r.is_premium;
    const pc = typeof r.purchase_count === 'number' ? r.purchase_count : 0;

    // Inject keyframes once
    if (!document.getElementById('revKf')) {
      const s = document.createElement('style');
      s.id = 'revKf';
      s.textContent = `
        @keyframes revPremSpin { to { transform: rotate(360deg); } }
        @keyframes revPremShimmer { 0%{opacity:.55} 50%{opacity:1} 100%{opacity:.55} }
        @keyframes revPremPulse { 0%,100%{box-shadow:0 0 18px rgba(124,58,237,.35),0 0 40px rgba(109,40,217,.15)} 50%{box-shadow:0 0 30px rgba(124,58,237,.6),0 0 60px rgba(109,40,217,.28)} }
        @keyframes revPremStarPop { 0%,100%{transform:scale(1) translateY(0)} 50%{transform:scale(1.18) translateY(-2px)} }
        @keyframes revPremScanLine { 0%{top:-100%;opacity:.6} 100%{top:200%;opacity:0} }
        @keyframes revPremCornerGlow { 0%,100%{opacity:.4} 50%{opacity:.9} }
      `;
      document.head.appendChild(s);
    }

    // Avatar
    const avatarStyle = isPremium
      ? `border:2.5px solid rgba(124,58,237,.7);box-shadow:0 0 12px rgba(124,58,237,.6),0 0 24px rgba(109,40,217,.3)`
      : `border:2px solid rgba(124,58,237,.22)`;
    const avatarBg = isPremium ? 'linear-gradient(135deg,#4c1d95,#7c3aed)' : 'var(--accent-gradient)';
    const avatarHtml = r.avatar_url
      ? `<img src="${escapeHtml(r.avatar_url)}" alt="" style="width:42px;height:42px;border-radius:50%;object-fit:cover;flex-shrink:0;${avatarStyle}">`
      : `<div style="width:42px;height:42px;border-radius:50%;background:${avatarBg};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;flex-shrink:0;${avatarStyle}">${escapeHtml(initials)}</div>`;

    // Stars — fixed row, no shift
    const stars = Array.from({length:5}, (_,i) => {
      const filled = i < r.rating;
      const st = isPremium && filled
        ? `display:inline-block;color:#a78bfa;font-size:13px;animation:revPremStarPop 1.6s ease-in-out ${i*0.13}s infinite`
        : `color:${filled?'#f59e0b':'rgba(255,255,255,.14)'};font-size:13px`;
      return `<span style="${st}">★</span>`;
    }).join('');

    const profileLink = `onclick="window._viewUserProfile(${r.user_id},'${escapeHtml(r.username)}')" style="cursor:pointer"`;
    const reportBtn = !isOwn
      ? `<button onclick="window._reportReview(${r.id})" title="Пожаловаться" style="position:absolute;top:10px;right:10px;width:26px;height:26px;border-radius:7px;background:transparent;border:1px solid rgba(255,255,255,.07);cursor:pointer;font-size:11px;color:var(--text-muted);display:flex;align-items:center;justify-content:center;transition:all .15s;z-index:2" onmouseover="this.style.background='rgba(239,68,68,.1)';this.style.borderColor='rgba(239,68,68,.3)'" onmouseout="this.style.background='transparent';this.style.borderColor='rgba(255,255,255,.07)'">🚩</button>` : '';
    const editBtn = isOwn
      ? `<button onclick="window._editMyReview()" title="Редактировать отзыв" style="position:absolute;top:10px;right:10px;width:26px;height:26px;border-radius:7px;background:transparent;border:1px solid rgba(255,255,255,.07);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;z-index:2" onmouseover="this.style.background='rgba(124,58,237,.15)';this.style.borderColor='rgba(124,58,237,.4)'" onmouseout="this.style.background='transparent';this.style.borderColor='rgba(255,255,255,.07)'"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 1 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>` : '';

    // Text — always clamped to 3 lines, read more button if needed
    const txt = r.text || '';
    const MAXCHARS = 130;
    let textHtml;
    if (fullText || txt.length === 0) {
      textHtml = `<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.65;flex:1;min-height:40px">${txt ? escapeHtml(txt) : '<span style="color:var(--text-muted);font-style:italic">Без комментария</span>'}</div>`;
    } else {
      const clampStyle = 'overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical';
      textHtml = `<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.65;${clampStyle}">${escapeHtml(txt)}</div>
        ${txt.length > MAXCHARS ? `<button onclick="window._openFullReview(${r.id})" style="font-size:11px;color:var(--accent-tertiary);background:none;border:none;cursor:pointer;padding:2px 0;text-align:left;font-weight:600;flex-shrink:0">Читать полностью ›</button>` : ''}`;
    }

    const animStyle = animate ? 'opacity:0;transform:translateY(16px);' : 'opacity:1;transform:translateY(0);';

    // ── PREMIUM CARD: single grid item, box-shadow glow, corner accents ──
    if (isPremium) {
      const corners = `
        <div style="position:absolute;top:-1px;left:-1px;width:16px;height:16px;border-top:2px solid rgba(167,139,250,.85);border-left:2px solid rgba(167,139,250,.85);border-radius:18px 0 0 0;pointer-events:none;animation:revPremCornerGlow 2s ease-in-out infinite"></div>
        <div style="position:absolute;top:-1px;right:-1px;width:16px;height:16px;border-top:2px solid rgba(167,139,250,.85);border-right:2px solid rgba(167,139,250,.85);border-radius:0 18px 0 0;pointer-events:none;animation:revPremCornerGlow 2s ease-in-out .5s infinite"></div>
        <div style="position:absolute;bottom:-1px;left:-1px;width:16px;height:16px;border-bottom:2px solid rgba(167,139,250,.85);border-left:2px solid rgba(167,139,250,.85);border-radius:0 0 0 18px;pointer-events:none;animation:revPremCornerGlow 2s ease-in-out 1s infinite"></div>
        <div style="position:absolute;bottom:-1px;right:-1px;width:16px;height:16px;border-bottom:2px solid rgba(167,139,250,.85);border-right:2px solid rgba(167,139,250,.85);border-radius:0 0 18px 0;pointer-events:none;animation:revPremCornerGlow 2s ease-in-out 1.5s infinite"></div>`;
      const scanLine = `<div style="position:absolute;left:0;right:0;height:1.5px;background:linear-gradient(90deg,transparent,rgba(139,92,246,.65),rgba(167,139,250,.85),rgba(139,92,246,.65),transparent);animation:revPremScanLine 3s linear infinite;pointer-events:none"></div>`;
      const topGlow = `<div style="position:absolute;top:0;left:15%;right:15%;height:1px;background:linear-gradient(90deg,transparent,rgba(167,139,250,.7),transparent);animation:revPremShimmer 2s ease-in-out infinite;pointer-events:none"></div>`;

      return `<div class="review-card revealed" data-rev-id="${r.id}" data-rev-idx="${idx}" data-premium="1"
        style="position:relative;overflow:hidden;background:linear-gradient(145deg,rgba(12,4,26,.97),rgba(6,2,16,.98));border:1px solid rgba(124,58,237,.45);border-radius:18px;padding:13px;${animStyle}transition:opacity .4s ease,transform .4s cubic-bezier(.34,1.2,.64,1),box-shadow .2s,border-color .2s;display:flex;flex-direction:column;gap:0;animation:revPremPulse 3s ease-in-out infinite"
        onmouseover="this.style.borderColor='rgba(139,92,246,.75)';this.style.animationPlayState='paused';this.style.transform='translateY(-2px)'"
        onmouseout="this.style.borderColor='rgba(124,58,237,.45)';this.style.animationPlayState='running';this.style.transform=''">
        ${corners}${topGlow}${scanLine}
        ${editBtn || reportBtn}
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:7px;padding-right:30px">
          <div ${profileLink}>${avatarHtml}</div>
          <div style="min-width:0;flex:1;display:flex;flex-direction:column;gap:2px">
            <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
              <span ${profileLink} style="font-weight:700;font-size:13px;color:#c4b5fd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px;transition:color .15s" onmouseover="this.style.color='#a78bfa'" onmouseout="this.style.color='#c4b5fd'" title="${escapeHtml(r.username)}">${escapeHtml(shortName)}</span>
              <div style="display:inline-flex;align-items:center">${stars}</div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-height:18px">
              <span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;color:#a78bfa;background:rgba(124,58,237,.15);border:1px solid rgba(124,58,237,.4);border-radius:5px;padding:1px 5px;font-weight:700;flex-shrink:0"><span style="animation:revPremStarPop 2s ease-in-out infinite;display:inline-block">👑</span> PREMIUM</span>
              <span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;color:${pc>0?'#86efac':'rgba(255,255,255,.3)'};background:${pc>0?'rgba(34,197,94,.08)':'rgba(255,255,255,.03)'};border:1px solid ${pc>0?'rgba(34,197,94,.18)':'rgba(255,255,255,.07)'};border-radius:5px;padding:1px 5px;font-weight:600;flex-shrink:0"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>${pc} ${pc===1?'покупка':pc<5&&pc>0?'покупки':'покупок'}</span>
            </div>
            <div style="font-size:10px;color:rgba(167,139,250,.4)">${date}</div>
          </div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:3px">${textHtml}</div>
      </div>`;
    }

    // ── NORMAL CARD ──
    const borderCol = 'rgba(255,255,255,0.08)';
    const hoverBorder = 'rgba(124,58,237,.25)';
    return `<div class="review-card revealed" data-rev-id="${r.id}" data-rev-idx="${idx}"
      style="position:relative;overflow:hidden;background:var(--bg-card);border:1px solid ${borderCol};border-radius:18px;padding:13px;${animStyle}transition:opacity .4s ease,transform .4s cubic-bezier(.34,1.2,.64,1),box-shadow .2s,border-color .2s;display:flex;flex-direction:column;gap:0"
      onmouseover="this.style.boxShadow='0 8px 28px rgba(0,0,0,.28)';this.style.borderColor='${hoverBorder}';this.style.transform='translateY(-2px)'"
      onmouseout="this.style.boxShadow='';this.style.borderColor='${borderCol}';this.style.transform=''">
      ${editBtn || reportBtn}
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:7px;padding-right:30px">
        <div ${profileLink}>${avatarHtml}</div>
        <div style="min-width:0;flex:1;display:flex;flex-direction:column;gap:2px">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
            <span ${profileLink} style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;transition:color .15s" onmouseover="this.style.color='var(--accent-tertiary)'" onmouseout="this.style.color=''" title="${escapeHtml(r.username)}">${escapeHtml(shortName)}</span>
            <div style="display:inline-flex;align-items:center">${stars}</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-height:18px">
            <span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;color:${pc>0?'#86efac':'rgba(255,255,255,.3)'};background:${pc>0?'rgba(34,197,94,.08)':'rgba(255,255,255,.03)'};border:1px solid ${pc>0?'rgba(34,197,94,.18)':'rgba(255,255,255,.07)'};border-radius:5px;padding:1px 5px;font-weight:600;flex-shrink:0"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>${pc} ${pc===1?'покупка':pc<5&&pc>0?'покупки':'покупок'}</span>
          </div>
          <div style="font-size:10px;color:var(--text-muted)">${date}</div>
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:3px">${textHtml}</div>
    </div>`;
  }

  // Open full review text in a modal
  window._openFullReview = function(revId) {
    const r = (state._allReviews || []).find(x => String(x.id) === String(revId));
    if (!r) return;
    const initials = (r.username || '?')[0].toUpperCase();
    const avatarHtml = r.avatar_url
      ? `<img src="${escapeHtml(r.avatar_url)}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid rgba(124,58,237,.3)">`
      : `<div style="width:44px;height:44px;border-radius:50%;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;border:2px solid rgba(124,58,237,.2)">${escapeHtml(initials)}</div>`;
    const stars = Array.from({length:5},(_,i)=>`<span style="color:${i<r.rating?'#f59e0b':'rgba(255,255,255,.12)'}">★</span>`).join('');
    modal(`
      <div style="animation:revProfileIn .25s cubic-bezier(.34,1.4,.64,1) both">
        <style>@keyframes revProfileIn{from{opacity:0;transform:scale(.92) translateY(10px)}to{opacity:1;transform:none}}</style>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;cursor:pointer" onclick="window._viewUserProfile(${r.user_id},'${escapeHtml(r.username)}')">
          ${avatarHtml}
          <div>
            <div style="font-weight:700;font-size:15px">${escapeHtml(r.username)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${_fmtDate(r.created_at)}</div>
            <div style="letter-spacing:1px;margin-top:2px;font-size:14px">${stars}</div>
          </div>
        </div>
        <div style="font-size:14px;color:var(--text-secondary);line-height:1.7;max-height:340px;overflow-y:auto;padding-right:4px">${escapeHtml(r.text || '')}</div>
      </div>
    `);
  };

  // "All reviews" full-page modal with pagination (10 per page)
  let _allRevPage = 0;
  const _ALL_REV_PER_PAGE = 10;

  window._openAllReviews = async function() {
    _allRevPage = 0;
    // Always re-fetch to get fresh is_premium status
    try {
      const reviews = await api('/api/reviews');
      state._allReviews = Array.isArray(reviews) ? reviews : [];
    } catch(_e) {
      if (!state._allReviews) state._allReviews = [];
    }
    _showAllReviewsModal();
  };

  function _showAllReviewsModal() {
    const sorted = _sortReviews(state._allReviews || []);
    const total = sorted.length;
    const totalPages = Math.ceil(total / _ALL_REV_PER_PAGE) || 1;
    const start = _allRevPage * _ALL_REV_PER_PAGE;
    const page = sorted.slice(start, start + _ALL_REV_PER_PAGE);

    const sortBtns = ['default','best','worst','premium'].map(s => {
      const labels = { default:'По умолчанию', best:'⭐ Лучшие', worst:'👎 Худшие', premium:'👑 Premium' };
      const isActive = _revSortMode === s;
      return `<button class="modal-rev-sort" data-sort="${s}" style="font-size:12px;padding:4px 12px;border-radius:8px;cursor:pointer;transition:all .2s;font-weight:${isActive?'600':'500'};background:${isActive?'rgba(var(--accent-rgb),.15)':'transparent'};border:1px solid ${isActive?'rgba(var(--accent-rgb),.3)':'rgba(255,255,255,.1)'};color:${isActive?'var(--accent-tertiary)':'var(--text-muted)'}">${labels[s]}</button>`;
    }).join('');

    const cardsHtml = page.length
      ? page.map((r, i) => _buildReviewCard(r, i, { animate: false })).join('')
      : `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);font-size:14px">Нет отзывов</div>`;

    const pagination = totalPages > 1 ? `
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:20px">
        <button class="btn btn-secondary btn-sm" id="allRevPrev" ${_allRevPage === 0 ? 'disabled' : ''}>← Назад</button>
        <span style="font-size:13px;color:var(--text-muted)">${_allRevPage+1} / ${totalPages} · всего ${total}</span>
        <button class="btn btn-secondary btn-sm" id="allRevNext" ${_allRevPage >= totalPages-1 ? 'disabled' : ''}>Вперёд →</button>
      </div>` : '';

    modal(`
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <h3 style="margin:0;font-size:18px;font-weight:800">📋 Все отзывы <span style="font-size:13px;font-weight:400;color:var(--text-muted)">${total} шт.</span></h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${sortBtns}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;align-items:start" id="allRevGrid">
        ${cardsHtml}
      </div>
      ${pagination}
    `, { size: 'wide' });

    // Sort buttons
    document.querySelectorAll('.modal-rev-sort').forEach(btn => {
      btn.addEventListener('click', () => {
        _revSortMode = btn.dataset.sort;
        _allRevPage = 0;
        _showAllReviewsModal();
      });
    });
    document.getElementById('allRevPrev')?.addEventListener('click', () => { _allRevPage--; _showAllReviewsModal(); });
    document.getElementById('allRevNext')?.addEventListener('click', () => { _allRevPage++; _showAllReviewsModal(); });
  }

  function _renderReviewsPage(container) {
    const sorted = _sortReviews(state._allReviews || []);
    const total = sorted.length;
    const totalPages = Math.ceil(total / _REVIEWS_PER_PAGE);
    const start = _reviewsPage * _REVIEWS_PER_PAGE;
    const page = sorted.slice(start, start + _REVIEWS_PER_PAGE);

    const cardsHtml = page.map((r, idx) => _buildReviewCard(r, idx)).join('');

    let paginationHtml = '';
    if (totalPages > 1) {
      paginationHtml = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:18px;grid-column:1/-1">
        <button class="btn btn-secondary btn-sm" id="revPrev" ${_reviewsPage <= 0 ? 'disabled' : ''} style="padding:6px 14px">← Назад</button>
        <span style="font-size:13px;color:var(--text-muted)">${_reviewsPage+1} / ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" id="revNext" ${_reviewsPage >= totalPages-1 ? 'disabled' : ''} style="padding:6px 14px">Вперёд →</button>
      </div>`;
    }

    container.style.opacity = '0';
    container.style.transition = 'opacity .18s';
    setTimeout(() => {
      container.innerHTML = cardsHtml + paginationHtml;
      container.style.opacity = '1';
      container.querySelectorAll('[data-rev-idx]').forEach((el, i) => {
        setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }, i * 55);
      });
      document.getElementById('revPrev')?.addEventListener('click', () => { _reviewsPage = Math.max(0, _reviewsPage-1); _renderReviewsPage(container); });
      document.getElementById('revNext')?.addEventListener('click', () => { _reviewsPage++; _renderReviewsPage(container); });
    }, 140);
  }

  async function _updateMyPurchaseCount() {
    // Update purchase_count in state._allReviews for the current user in real-time
    if (!state.user || !state._allReviews) return;
    try {
      const d = await api('/api/purchases?limit=200', { silent: true, timeout: 10000 });
      const count = (d.purchases || d.items || d.orders || []).length;
      state._myPurchaseCount = count;
      // Update review cards in DOM immediately
      const myReview = (state._allReviews || []).find(r => String(r.user_id) === String(state.user.id));
      if (myReview && myReview.purchase_count !== count) {
        myReview.purchase_count = count;
        // Re-render if reviews are visible
        const container = document.getElementById('reviewsGrid') || document.getElementById('reviewsContainer');
        if (container) { /* reviews will re-render next time */ }
        // Update badge in existing DOM
        document.querySelectorAll('.review-card').forEach(card => {
          if (card.dataset.revId && myReview.id && String(card.dataset.revId) === String(myReview.id)) {
            // Find purchase badge inside card and update it
            const badge = card.querySelector('[data-purchase-badge]');
            if (badge && count > 0) {
              badge.textContent = `${count} ${count === 1 ? 'покупка' : count < 5 ? 'покупки' : 'покупок'}`;
            }
          }
        });
      }
    } catch(e) { /* non-critical */ }
  }

  async function loadReviews() {
    const container = $('#reviewsList');
    if (!container) return;
    try {
      // Always re-fetch — ensures is_premium is fresh (user may have just bought premium)
      const [reviews, myRevData] = await Promise.allSettled([
        api('/api/reviews'),
        state.user ? api('/api/reviews/my') : Promise.resolve(null)
      ]);

      state._myReview = myRevData.status === 'fulfilled' && myRevData.value?.review
        ? myRevData.value.review : null;

      const revList = reviews.status === 'fulfilled' && Array.isArray(reviews.value) ? reviews.value : [];
      state._allReviews = revList;

      if (!revList.length) {
        container.innerHTML = '<div style="color:var(--text-muted);padding:30px;text-align:center;grid-column:1/-1">Пока нет отзывов. Будьте первым!</div>';
        _renderReviewPendingBanner();
        _wireSortBar();
        return;
      }
      _reviewsPage = 0;
      _renderReviewsPage(container);
      _renderReviewPendingBanner();
      _wireSortBar();
    } catch(e) {
      container.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;grid-column:1/-1">Не удалось загрузить</div>';
    }
  }

  function _wireSortBar() {
    document.querySelectorAll('#reviewsSortBar .rev-sort-btn').forEach(btn => {
      btn.replaceWith(btn.cloneNode(true)); // remove old listeners
    });
    document.querySelectorAll('#reviewsSortBar .rev-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _revSortMode = btn.dataset.sort;
        _reviewsPage = 0;
        // Update active style
        document.querySelectorAll('#reviewsSortBar .rev-sort-btn').forEach(b => {
          const isActive = b.dataset.sort === _revSortMode;
          b.style.background = isActive ? 'rgba(var(--accent-rgb),.15)' : 'transparent';
          b.style.borderColor = isActive ? 'rgba(var(--accent-rgb),.3)' : 'rgba(255,255,255,.1)';
          b.style.color = isActive ? 'var(--accent-tertiary)' : 'var(--text-muted)';
          b.style.fontWeight = isActive ? '600' : '500';
        });
        const container = document.getElementById('reviewsList');
        if (container) _renderReviewsPage(container);
      });
    });
  }


  function _renderReviewPendingBanner() {
    const myRev = state._myReview;
    const btn = $('#btnWriteReview');
    if (!btn) return;
    // Remove old banner
    document.getElementById('reviewPendingBanner')?.remove();

    // Update button label based on review state
    const hasApproved = state._allReviews?.some(r => state.user && String(r.user_id) === String(state.user.id));
    const isPending = myRev && myRev.status === 'pending';
    const hasAny = hasApproved || isPending;

    if (hasAny) {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;margin-right:4px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 1 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Мой отзыв`;
    } else {
      btn.innerHTML = '✍️ Оставить отзыв';
    }

    if (isPending) {
      const banner = document.createElement('div');
      banner.id = 'reviewPendingBanner';
      banner.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px;margin-top:10px;font-size:13px';
      banner.innerHTML = `<span>⏳ Ваш отзыв ожидает проверки</span>
        <button class="btn btn-secondary btn-sm" id="btnCancelMyReview" style="margin-left:auto;font-size:11px">❌ Отменить заявку</button>`;
      btn.parentElement?.insertAdjacentElement('afterend', banner);
      document.getElementById('btnCancelMyReview')?.addEventListener('click', window._cancelMyReview);
    }
  }


  // View a user's public profile card — with animated modal + live data
  window._viewUserProfile = function(userId, username) {
    const rev = (state._allReviews || []).find(r => String(r.user_id) === String(userId));
    const avUrl = rev?.avatar_url || '';
    const initials = (username || '?')[0].toUpperCase();
    // Use purchase_count directly from review data (same source as badge on the card)
    const pc = typeof rev?.purchase_count === 'number' ? rev.purchase_count : null;
    const isPremium = !!rev?.is_premium;

    const avatarHtmlFn = (url) =>
      url
        ? `<img src="${escapeHtml(url)}" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:2.5px solid rgba(124,58,237,.5);box-shadow:0 0 24px rgba(124,58,237,.35)">`
        : `<div style="width:80px;height:80px;border-radius:50%;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;border:2.5px solid rgba(124,58,237,.3);box-shadow:0 0 24px rgba(124,58,237,.2)">${escapeHtml(initials)}</div>`;

    const starsHtml = rev?.rating ? Array.from({length:5}, (_,i) =>
      `<span style="color:${i<rev.rating?'#f59e0b':'rgba(255,255,255,.14)'};font-size:16px">★</span>`
    ).join('') : '';

    const _statBlock = (value, label, color) =>
      `<div style="background:rgba(${color},.07);border:1px solid rgba(${color},.2);border-radius:10px;padding:8px 14px;text-align:center;min-width:74px">
        <div style="font-size:16px;font-weight:800;color:rgb(${color})">${value}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${label}</div>
      </div>`;

    modal(`
      <div style="text-align:center;padding:6px 0 2px;animation:revProfileIn .3s cubic-bezier(.34,1.4,.64,1) both" id="pubProfileModal">
        <style>@keyframes revProfileIn{from{opacity:0;transform:scale(.9) translateY(12px)}to{opacity:1;transform:none}}</style>
        <div style="margin:0 auto 12px;width:80px;height:80px" id="pubProfileAv">${avatarHtmlFn(avUrl)}</div>
        <div style="font-size:20px;font-weight:800;margin-bottom:2px">${escapeHtml(username || 'Пользователь')}</div>
        ${isPremium ? `<div style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:#a78bfa;background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.3);border-radius:20px;padding:2px 10px;margin-bottom:8px;font-weight:700">👑 Premium</div>` : `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Участник RBX ST</div>`}
        <div style="display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-bottom:14px">
          ${pc !== null ? _statBlock(pc, pc===1?'покупка':pc<5&&pc>0?'покупки':'покупок', '34,197,94') : ''}
          ${starsHtml ? `<div style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:8px 14px;text-align:center;min-width:74px"><div style="font-size:16px;letter-spacing:1px">${starsHtml}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">рейтинг</div></div>` : ''}
        </div>
        ${rev?.text ? `
          <div style="font-size:12.5px;color:var(--text-secondary);background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:12px 14px;text-align:left;line-height:1.65;font-style:italic">
            "${escapeHtml((rev.text).slice(0,240))}${rev.text.length>240?'…':''}"
          </div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:6px">${_fmtDate(rev.created_at)}</div>
        ` : ''}
      </div>
    `);
  };

  window._editMyReview = async function() {
    try {
      const d = await api('/api/reviews/my');
      if (!d?.review) return toast('Отзыв не найден', 'error');
      _showReviewEditForm(d.review);
    } catch(e) { toast(e.message, 'error'); }
  };

  window._cancelMyReview = async function() {
    if (!confirm('Отменить заявку на отзыв? Ваш текст будет удалён.')) return;
    try {
      loading(true);
      const r = await api('/api/reviews/cancel', { method: 'POST' });
      toast(r.message || '✅ Заявка отменена', 'success');
      state._myReview = null;
      document.getElementById('reviewPendingBanner')?.remove();
    } catch(e) { toast(e.message || 'Ошибка', 'error'); } finally { loading(false); }
  };

  window._reportReview = async function(id) {
    modal(`
      <h2 style="margin:0 0 12px">🐞 Пожаловаться на отзыв</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Укажите причину жалобы:</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px" id="reportReasons">
        ${['Спам или реклама','Оскорбления','Недостоверная информация','Нарушение правил сайта'].map(r =>
          `<label style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);cursor:pointer;font-size:13px">
            <input type="radio" name="reportReason" value="${r}" style="accent-color:var(--accent-primary)"> ${r}
          </label>`
        ).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="btnSendReport" style="flex:1">Отправить</button>
        <button class="btn btn-secondary" onclick="closeModal()" style="flex:1">Отмена</button>
      </div>
    `);
    document.getElementById('btnSendReport')?.addEventListener('click', async () => {
      const selected = document.querySelector('input[name="reportReason"]:checked');
      if (!selected) return toast('Выберите причину', 'warning');
      try {
        loading(true);
        const r = await api('/api/reviews/report', { method: 'POST', body: { id, reason: selected.value } });
        toast(r.message || '✅ Жалоба отправлена', 'success');
        closeModal();
      } catch(e) { toast(e.message || 'Ошибка', 'error'); } finally { loading(false); }
    });
  };

  function _showReviewEditForm(review) {
    let sel = review?.rating || 5;
    modal(`
      <h2 style="margin:0 0 6px">Редактировать отзыв</h2>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Изменённый отзыв пройдёт повторную проверку</div>
      <div style="text-align:center;margin-bottom:14px">
        <div id="starSelect" style="font-size:36px;cursor:pointer;display:inline-flex;gap:6px">
          ${[1,2,3,4,5].map(i => '<span class="star" data-v="'+i+'" style="color:'+(i<=sel?'#f59e0b':'rgba(255,255,255,0.15)')+';transition:transform .15s">★</span>').join('')}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px" id="ratingLabel">${{1:'Ужасно',2:'Плохо',3:'Нормально',4:'Хорошо',5:'Отлично!'}[sel]||''}</div>
      </div>
      <textarea id="reviewText" class="form-input" maxlength="1000" rows="4" style="resize:vertical;margin-bottom:12px">${_escapeHtml(review?.text||'')}</textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="btnSubmitReview" style="flex:1">Сохранить</button>
        <button class="btn btn-secondary" id="btnCancelReview" style="flex:1">Отмена</button>
      </div>
    `);
    _setupStarSelect(sel, v => { sel = v; });
    document.getElementById('btnSubmitReview')?.addEventListener('click', async () => {
      const text = (document.getElementById('reviewText')?.value || '').trim();
      if (!text || text.length < 5) return toast('Минимум 5 символов', 'warning');
      try {
        loading(true);
        const r = await api('/api/reviews/edit', { method:'POST', body:{ text, rating: sel }});
        toast(r.message || 'Обновлено!', r.status === 'approved' ? 'success' : 'warning');
        closeModal(); loadReviews();
      } catch(e) { toast(e.message, 'error'); } finally { loading(false); }
    });
    document.getElementById('btnCancelReview')?.addEventListener('click', () => closeModal());
  }

  function _setupStarSelect(initial, onChange) {
    const labels = {1:'Ужасно',2:'Плохо',3:'Нормально',4:'Хорошо',5:'Отлично!'};
    let val = initial;
    const update = (v) => {
      val = v;
      $$('#starSelect .star').forEach(s => {
        const sv = parseInt(s.dataset.v);
        s.style.color = sv <= v ? '#f59e0b' : 'rgba(255,255,255,0.15)';
        s.style.transform = sv <= v ? 'scale(1.15)' : 'scale(1)';
      });
      const lb = document.getElementById('ratingLabel');
      if (lb) lb.textContent = labels[v] || '';
      if (onChange) onChange(v);
    };
    $$('#starSelect .star').forEach(s => {
      s.addEventListener('click', () => update(parseInt(s.dataset.v)));
      s.addEventListener('mouseenter', () => {
        const sv = parseInt(s.dataset.v);
        $$('#starSelect .star').forEach(ss => { ss.style.transform = parseInt(ss.dataset.v) <= sv ? 'scale(1.2)' : 'scale(0.9)'; });
      });
    });
    document.getElementById('starSelect')?.addEventListener('mouseleave', () => update(val));
  }

  function showReviewForm() {
    if (!state.user) return toast('Войдите, чтобы оставить отзыв', 'warning');
    // If user already has a review — open editor instead
    const myInList = state._allReviews?.find(r => String(r.user_id) === String(state.user.id));
    if (myInList || (state._myReview && state._myReview.status === 'pending')) {
      window._editMyReview();
      return;
    }
    let selectedRating = 5;
    modal(`
      <h2 style="margin:0 0 6px">Оставить отзыв</h2>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">Отзыв проходит автоматическую проверку</div>
      <div style="text-align:center;margin-bottom:14px">
        <div id="starSelect" style="font-size:36px;cursor:pointer;display:inline-flex;gap:6px">
          ${[1,2,3,4,5].map(i => '<span class="star" data-v="'+i+'" style="color:#f59e0b;transition:transform .15s">★</span>').join('')}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px" id="ratingLabel">Отлично!</div>
      </div>
      <textarea id="reviewText" class="form-input" placeholder="Расскажите о вашем опыте..." maxlength="1000" rows="4" style="resize:vertical;margin-bottom:12px"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="btnSubmitReview" style="flex:1">Отправить</button>
        <button class="btn btn-secondary" id="btnCancelReview" style="flex:1">Отмена</button>
      </div>
    `);
    _setupStarSelect(5, v => { selectedRating = v; });
    $('#btnSubmitReview')?.addEventListener('click', async () => {
      const text = ($('#reviewText')?.value || '').trim();
      if (!text || text.length < 5) return toast('Минимум 5 символов', 'warning');
      try {
        loading(true);
        const r = await api('/api/reviews/create', { method:'POST', body:{ text, rating: selectedRating }});
        toast(r.message || 'Отзыв отправлен!', r.status === 'approved' ? 'success' : 'warning');
        closeModal(); loadReviews();
      } catch(e) { toast(e.message, 'error'); } finally { loading(false); }
    });
    $('#btnCancelReview')?.addEventListener('click', () => closeModal());
  }

  // ====== ADMIN REVIEWS ======
  async function adminLoadReviews() {
    try {
      const reviews = await api('/api/admin/reviews?status=pending');
      const el = $('#adminReviewsList');
      if (!el) return;
      if (!Array.isArray(reviews) && reviews?.ok === undefined) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center">Ошибка формата</div>';
        return;
      }
      const items = Array.isArray(reviews) ? reviews : (reviews.items || []);
      if (!items.length) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center">Нет отзывов на модерации</div>';
        return;
      }
      el.innerHTML = items.map(r => `
        <div style="background:var(--bg-card);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>${_escapeHtml(r.username||'')}</strong>
            <span style="color:#f59e0b">${'\u2605'.repeat(r.rating||0)}${'\u2606'.repeat(5-(r.rating||0))}</span>
          </div>
          <p style="font-size:14px;color:var(--text-secondary);margin-bottom:10px">${_escapeHtml(r.text||'')}</p>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="moderateReview(${r.id},'approve')">Одобрить</button>
            <button class="btn btn-secondary btn-sm" onclick="moderateReview(${r.id},'reject')">Отклонить</button>
          </div>
        </div>
      `).join('');
    } catch(e) {
      const el = $('#adminReviewsList');
      if(el) el.innerHTML = '<div style="color:var(--text-muted);padding:20px">Ошибка: '+_escapeHtml(e.message||'')+'</div>';
    }
  }

  window.moderateReview = async function(id, action) {
    try {
      loading(true);
      await api('/api/admin/reviews/moderate', { method:'POST', body:{ id, action }});
      toast(action === 'approve' ? 'Отзыв одобрен' : 'Отзыв отклонён', 'success');
      adminLoadReviews();
    } catch(e) { toast(e.message, 'error'); } finally { loading(false); }
  };

  // ====== ADMIN COMPLAINTS ======
  async function adminLoadComplaints(status = 'pending') {
    const el = document.getElementById('adminComplaintsList');
    if (!el) return;
    el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Загрузка...</div>';
    try {
      const d = await api('/api/admin/complaints?status=' + status);
      const items = d.complaints || [];
      if (!items.length) {
        el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted)">Нет жалоб</div>';
        return;
      }
      const stars = (n) => Array.from({length:5},(_,i)=>`<span style="color:${i<n?'#f59e0b':'rgba(255,255,255,.12)'}">★</span>`).join('');
      const statusColors = { pending:'#f59e0b', resolved:'#22c55e', dismissed:'#6b7280' };
      const statusLabels = { pending:'⏳ На рассмотрении', resolved:'✅ Решено', dismissed:'❌ Отклонено' };

      el.innerHTML = items.map(c => `
        <div style="background:var(--bg-card);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:16px;margin-bottom:10px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
            <div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">🚩 Жалоба #${c.id} · ${_fmtDatetime(c.created_at)}</div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:12px;background:rgba(255,255,255,.05);border-radius:6px;padding:2px 8px">
                  👤 Жалуется: <b>${_escapeHtml(c.reporter_username||'?')}</b>
                </span>
                <span style="font-size:12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.15);border-radius:6px;padding:2px 8px;color:#ef4444">
                  На: <b>${_escapeHtml(c.reported_username||'?')}</b>
                </span>
              </div>
            </div>
            <span style="font-size:11px;padding:3px 10px;border-radius:20px;background:${statusColors[c.status]||'#6b7280'}18;color:${statusColors[c.status]||'#6b7280'};border:1px solid ${statusColors[c.status]||'#6b7280'}30;white-space:nowrap">
              ${statusLabels[c.status]||c.status}
            </span>
          </div>

          <!-- Причина жалобы -->
          <div style="font-size:13px;padding:10px 12px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.12);border-radius:10px;margin-bottom:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">📋 Причина:</div>
            <div style="font-weight:600;color:#ef4444">${_escapeHtml(c.reason||'Spam/Abuse')}</div>
          </div>

          <!-- Текст отзыва -->
          <div style="font-size:13px;padding:10px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:12px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">⭐ Отзыв (${stars(c.review_rating||0)}):</div>
            <div style="line-height:1.55;color:var(--text-secondary)">${_escapeHtml(c.review_text||'—')}</div>
          </div>

          ${status === 'pending' ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-sm" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.25);color:#ef4444;gap:6px" onclick="window._resolveComplaint(${c.id},'approve')">
              🗑 Удалить отзыв
            </button>
            <button class="btn btn-secondary btn-sm" onclick="window._resolveComplaint(${c.id},'dismiss')">
              Отклонить жалобу
            </button>
          </div>` : ''}
        </div>`).join('');
    } catch(e) {
      el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Ошибка загрузки</div>';
    }
  }

  window._resolveComplaint = async function(id, action) {
    const label = action === 'approve' ? 'Удалить отзыв и закрыть жалобу?' : 'Отклонить жалобу?';
    if (!confirm(label)) return;
    try {
      loading(true);
      await api('/api/admin/complaints/resolve', { method: 'POST', body: { id, action } });
      toast(action === 'approve' ? '🗑 Отзыв удалён' : '✓ Жалоба отклонена', 'success');
      const activeFilter = document.querySelector('.admin-complaint-filter.active');
      adminLoadComplaints(activeFilter?.dataset.cstatus || 'pending');
    } catch(e) { toast(e.message, 'error'); } finally { loading(false); }
  };

  // ====== ADMIN SUPPORT TICKETS ======
  async function adminLoadAiChatUsers() {
    const el = document.getElementById('adminAiChats');
    if (!el) return;
    try {
      const d = await api('/api/admin/support/ai_chat_users', { silent: true });
      const users = d.users || [];
      if (!users.length) {
        el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Нет чатов</div>';
        return;
      }
      el.innerHTML = users.map(u => `
        <div class="ticket-item" style="cursor:pointer" onclick="window._openAiChat(${u.user_id})">
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;font-size:13px">${_escapeHtml(u.username||'Пользователь #'+u.user_id)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${u.msg_count||0} сообщений · ${(u.last_ts||'').replace('T',' ').slice(0,16)}</div>
          </div>
          ${u.has_escalated ? '<span class="ticket-status open">⚠️ Оператор</span>' : ''}
        </div>
      `).join('');
    } catch(e) {
      el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Нет данных</div>';
    }
  }

  window._openAiChat = async function(userId) {
    try {
      const d = await api(`/api/admin/support/ai_chats?user_id=${userId}`);
      const msgs = d.messages || d.chats || [];
      modal(`
        <h3 style="margin:0 0 12px">💬 Чат пользователя #${userId}</h3>
        <div class="support-chat">
          <div class="support-msgs" id="aiChatMsgs" style="max-height:400px">
            ${msgs.map(m => `<div class="support-msg ${m.role==='assistant'?'admin':'user'}">
              <div>${_escapeHtml(m.content||'')}</div>
              <div class="msg-time">${(m.ts||'').replace('T',' ').slice(0,16)}${m.escalated?'  ⚠️ просил оператора':''}</div>
            </div>`).join('') || '<div style="color:var(--text-muted);text-align:center;padding:20px">Нет сообщений</div>'}
          </div>
        </div>
      `, { size:'wide' });
      const el = document.getElementById('aiChatMsgs');
      if (el) el.scrollTop = el.scrollHeight;
    } catch(e) { toast(e.message, 'error'); }
  };

  async function adminLoadTickets(status) {
    status = status || 'open';
    const el = document.getElementById('adminTicketsList');
    if (!el) return;
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Загрузка...</div>';
    try {
      const d = await api('/api/admin/support/list?status=' + status);
      const tickets = d.tickets || [];
      if (!tickets.length) { el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Нет заявок</div>'; return; }
      el.innerHTML = tickets.map(t => `
        <div class="ticket-item" onclick="window._openAdminTicket(${t.id})">
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;font-size:13px">#${t.id} — ${_escapeHtml(t.subject||'')}</div>
            <div style="font-size:12px;color:var(--text-muted)">${_escapeHtml(t.username||'')} · ${(t.updated_at||'').replace('T',' ').slice(0,16)}</div>
          </div>
          <span class="ticket-status ${t.status}">${t.status === 'open' ? 'Открыт' : 'Закрыт'}</span>
        </div>
      `).join('');
    } catch(e) { el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Ошибка</div>'; }
  }

  window._openAdminTicket = async function(tid) {
    try {
      const d = await api('/api/support/messages?ticket_id=' + tid);
      const msgs = d.messages || [];
      const ticket = d.ticket || {};
      const isOpen = ticket.status === 'open';

      const renderAttachment = (url) => {
        if (!url) return '';
        const u = String(url);
        const ext = u.split('.').pop().split('?')[0].toLowerCase();
        const isImg = ['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext);
        const isVideo = ['mp4','webm','mov','avi'].includes(ext);
        const isPdf = ext === 'pdf';
        const isTxt = ['txt','log','csv'].includes(ext);
        if (isImg) return `<a href="${_escapeHtml(u)}" target="_blank"><img src="${_escapeHtml(u)}" style="max-width:200px;max-height:160px;border-radius:8px;margin-top:6px;display:block;cursor:zoom-in;border:1px solid rgba(255,255,255,.1)"></a>`;
        if (isVideo) return `<video src="${_escapeHtml(u)}" controls style="max-width:240px;border-radius:8px;margin-top:6px;display:block"></video>`;
        if (isPdf) return `<a href="${_escapeHtml(u)}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#ef4444;font-size:12px;margin-top:6px;text-decoration:none">📄 Открыть PDF</a>`;
        return `<a href="${_escapeHtml(u)}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:var(--text-muted);font-size:12px;margin-top:6px;text-decoration:none">📎 ${ext.toUpperCase()} файл</a>`;
      };

      const msgBubbles = msgs.length === 0
        ? '<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:13px">Нет сообщений</div>'
        : msgs.map(m => {
            const isAdm = m.is_admin;
            // Collect all attachment URLs (prefer parsed array, fallback to single URL)
            let attachUrls = [];
            if (m.attachment_urls && Array.isArray(m.attachment_urls) && m.attachment_urls.length) {
              attachUrls = m.attachment_urls;
            } else if (m.attachment_url) {
              // Legacy: single URL or JSON string
              try {
                const parsed = JSON.parse(m.attachment_url);
                attachUrls = Array.isArray(parsed) ? parsed : [m.attachment_url];
              } catch {
                attachUrls = [m.attachment_url];
              }
            }
            return `<div style="display:flex;flex-direction:column;align-items:${isAdm?'flex-end':'flex-start'};margin-bottom:12px">
              <div style="max-width:82%;background:${isAdm?'var(--accent-gradient)':'rgba(255,255,255,.06)'};border-radius:${isAdm?'16px 4px 16px 16px':'4px 16px 16px 16px'};padding:10px 14px">
                <div style="font-size:13px;line-height:1.55;white-space:pre-wrap">${_escapeHtml(m.text)}</div>
                ${attachUrls.map(u => renderAttachment(u)).join('')}
              </div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:3px;padding:0 4px">${isAdm?'👮 Поддержка':'👤 '+_escapeHtml(ticket.username||'Пользователь')} · ${_fmtDatetime(m.created_at)}</div>
            </div>`;
          }).join('');

      modal(`
        <!-- User info header -->
        <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;margin-bottom:14px">
          <div style="width:40px;height:40px;border-radius:50%;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;flex-shrink:0">
            ${(ticket.username||'?')[0].toUpperCase()}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${_escapeHtml(ticket.username||'Неизвестный')}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
              #${ticket.id} · ${_escapeHtml(ticket.category||'other')} · ${_fmtDatetime(ticket.created_at)}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span class="ticket-status ${ticket.status}" style="font-size:11px">${isOpen ? '🟢 Открыт' : '⚫ Закрыт'}</span>
            ${isOpen ? `<button class="btn btn-secondary btn-sm" id="ticketCloseBtn">✓ Закрыть</button>` : ''}
          </div>
        </div>
        <div style="font-weight:700;font-size:14px;margin-bottom:8px">${_escapeHtml(ticket.subject||'Без темы')}</div>

        <!-- Chat messages -->
        <div style="border:1px solid rgba(255,255,255,.07);border-radius:12px;overflow:hidden">
          <div id="ticketMsgs" style="overflow-y:auto;max-height:360px;padding:16px">
            ${msgBubbles}
          </div>
          ${isOpen ? `
          <div style="padding:10px;border-top:1px solid rgba(255,255,255,.07);display:flex;gap:8px;align-items:flex-end;background:rgba(255,255,255,.02)">
            <input type="file" id="ticketReplyFile" multiple accept="image/*,.pdf,.txt,.doc,.docx,.zip" style="display:none">
            <button id="ticketReplyAttach" title="Прикрепить файл" style="height:44px;width:40px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-muted);transition:all .15s;flex-shrink:0" onmouseover="this.style.background='rgba(124,58,237,.1)';this.style.borderColor='rgba(124,58,237,.3)'" onmouseout="this.style.background='transparent';this.style.borderColor='rgba(255,255,255,.08)'">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <div style="flex:1;display:flex;flex-direction:column;gap:4px">
              <div id="ticketReplyFilePreview" style="display:none;padding:4px 8px;background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.2);border-radius:6px;font-size:11px;color:var(--accent-tertiary)"></div>
              <textarea id="ticketReplyInput" class="form-input" placeholder="Написать ответ..." rows="2" style="resize:none;min-height:44px;font-size:13px"></textarea>
            </div>
            <button class="btn btn-primary" id="ticketReplyBtn" style="height:44px;padding:0 16px" title="Отправить (Ctrl+Enter)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>` : '<div style="padding:10px;text-align:center;font-size:12px;color:var(--text-muted);border-top:1px solid rgba(255,255,255,.07)">Заявка закрыта</div>'}
        </div>
      `, { size: 'wide' });

      const msgsEl = document.getElementById('ticketMsgs');
      if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

      let _replyAttachUrls = [];

      const doReply = async () => {
        const inp = document.getElementById('ticketReplyInput');
        const text = (inp?.value || '').trim();
        if (!text && !_replyAttachUrls?.length) return;
        const btn = document.getElementById('ticketReplyBtn');
        if (btn) btn.disabled = true;
        try {
          const body = { ticket_id: tid, text };
          if (typeof _replyAttachUrls !== 'undefined' && _replyAttachUrls.length) body.attachment_urls = _replyAttachUrls;
          await api('/api/support/reply', { method: 'POST', body });
          toast('✅ Ответ отправлен', 'success');
          window._openAdminTicket(tid);
        } catch(e) {
          toast(e.message || 'Ошибка', 'error');
          if (btn) btn.disabled = false;
        }
      };

      document.getElementById('ticketReplyBtn')?.addEventListener('click', doReply);
      document.getElementById('ticketReplyInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doReply(); }
      });

      // File attachment for replies
      document.getElementById('ticketReplyAttach')?.addEventListener('click', () => {
        document.getElementById('ticketReplyFile')?.click();
      });
      document.getElementById('ticketReplyFile')?.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files?.length) return;
        const preview = document.getElementById('ticketReplyFilePreview');
        for (const file of files) {
          if (file.size > 10*1024*1024) { toast('Файл слишком большой (макс 10 МБ)', 'warning'); continue; }
          try {
            const fd = new FormData(); fd.append('file', file);
            const r = await apiForm('/api/support/upload', fd);
            if (r?.url) _replyAttachUrls.push(r.url);
            if (preview) { preview.style.display='block'; preview.textContent = `📎 ${_replyAttachUrls.length} файл(ов) прикреплено`; }
          } catch(err) { toast(err.message || 'Ошибка загрузки', 'error'); }
        }
        e.target.value = '';
      });
      document.getElementById('ticketCloseBtn')?.addEventListener('click', async () => {
        if (!confirm('Закрыть заявку?')) return;
        try {
          await api('/api/admin/support/close', { method: 'POST', body: { ticket_id: tid } });
          toast('Заявка закрыта', 'success');
          closeModal();
          adminLoadTickets('open');
        } catch(e) { toast(e.message, 'error'); }
      });
    } catch(e) { toast(e.message, 'error'); }
  };

  // ====== ADMIN MAINTENANCE ======
  async function adminLoadMaintenance() {
    try {
      const d = await api('/api/site/status');
      const btn = document.getElementById('btnMaintenanceToggle');
      const msgInput = document.getElementById('maintenanceMsg');
      const statusEl = document.getElementById('maintenanceStatus');
      if (btn) {
        btn.textContent = d.maintenance ? '🔓 ВЫКЛЮЧИТЬ (открыть сайт)' : '🔒 ВКЛЮЧИТЬ (закрыть сайт)';
        btn.className = d.maintenance ? 'btn btn-primary' : 'btn btn-secondary';
        btn.style.minWidth = '200px';
        btn.dataset.maintState = d.maintenance ? '1' : '0';
      }
      if (msgInput && d.maintenance_msg) msgInput.value = d.maintenance_msg;
      if (statusEl) {
        statusEl.textContent = d.maintenance ? '⛔ Сайт ЗАКРЫТ для пользователей' : '✅ Сайт работает нормально';
        statusEl.style.color = d.maintenance ? '#ef4444' : '#22c55e';
        statusEl.style.fontWeight = '700';
      }
    } catch(e) {}
  }

  // Wire maintenance button once (in initAdmin, not repeated)
  function _wireMaintBtn() {
    const btn = document.getElementById('btnMaintenanceToggle');
    if (!btn || btn._maintWired) return;
    btn._maintWired = true;
    btn.addEventListener('click', async () => {
      const curState = btn.dataset.maintState === '1';
      const newState = !curState;
      const msg = document.getElementById('maintenanceMsg')?.value || 'Сайт на техническом обслуживании';
      try {
        loading(true);
        await api('/api/admin/maintenance', { method:'POST', body:{ enabled: newState, message: msg }});
        toast(newState ? '🔒 Тех. работы включены — страница покажется пользователям' : '✅ Сайт открыт — страница убрана!', newState ? 'warning' : 'success');
        await adminLoadMaintenance();
        // Real-time: show/hide overlay for the admin browser window too
        // (admin bypasses the block, so just toggle a preview indicator)
        const statusEl = document.getElementById('maintenanceStatus');
        if (statusEl) {
          statusEl.textContent = newState ? '⛔ Сайт ЗАКРЫТ для пользователей' : '✅ Сайт работает нормально';
          statusEl.style.color = newState ? '#ef4444' : '#22c55e';
        }
      } catch(e) { toast(e.message || 'Ошибка', 'error'); }
      finally { loading(false); }
    });
  }

  async function showSupportModal() {
    if (!state.user) return showLogin();
    modal(`
      <h2 style="margin:0 0 6px">Поддержка</h2>
      <div style="color:var(--text-muted);font-size:13px;margin-bottom:14px">Создайте заявку или посмотрите существующие</div>
      <div class="segmented" id="supportTabs" style="margin-bottom:14px">
        <button class="seg-btn active" data-stab="tickets">Мои заявки</button>
        <button class="seg-btn" data-stab="complaints">Мои жалобы</button>
        <button class="seg-btn" data-stab="new">Новая заявка</button>
      </div>
      <div id="supportContent" style="min-height:150px">Загрузка...</div>
    `, { size:'wide' });

    $$('#supportTabs .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#supportTabs .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (btn.dataset.stab === 'new') showNewTicketForm();
        else if (btn.dataset.stab === 'complaints') loadUserComplaints();
        else loadUserTickets();
      });
    });
    loadUserTickets();
  }

  async function loadUserComplaints() {
    const cont = document.getElementById('supportContent');
    if (!cont) return;
    cont.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Загрузка...</div>';
    try {
      // Fetch user's own reports via reviews API (filter by reporter)
      const d = await api('/api/my/complaints', { silent: true }).catch(() => ({ complaints: [] }));
      const items = d.complaints || [];
      if (!items.length) {
        cont.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)">
          <div style="font-size:32px;margin-bottom:8px">🚩</div>
          <div style="font-weight:600">Жалоб нет</div>
          <div style="font-size:12px;margin-top:4px">Пожаловаться можно через кнопку «⚑» на отзыве</div>
        </div>`;
        return;
      }
      const statusLabels = { pending:'⏳ На рассмотрении', resolved:'✅ Решено', dismissed:'❌ Отклонено' };
      const statusColors = { pending:'#f59e0b', resolved:'#22c55e', dismissed:'#6b7280' };
      cont.innerHTML = items.map(c => `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;margin-bottom:8px">
          <div style="font-size:24px;flex-shrink:0">🚩</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
              <span style="font-weight:700;font-size:13px">Жалоба на отзыв</span>
              <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${statusColors[c.status]||'#6b7280'}18;color:${statusColors[c.status]||'#6b7280'}">${statusLabels[c.status]||c.status}</span>
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">На пользователя: <b>${escapeHtml(c.reported_username||'?')}</b> · ${_fmtDatetime(c.created_at)}</div>
            <div style="font-size:12px;color:var(--text-muted)">Причина: ${escapeHtml(c.reason||'')}</div>
            ${c.review_text ? `<div style="font-size:12px;margin-top:4px;padding:6px 10px;background:rgba(255,255,255,.04);border-radius:6px;color:var(--text-secondary)">"${escapeHtml((c.review_text||'').slice(0,100))}${(c.review_text||'').length>100?'...':''}"</div>` : ''}
          </div>
        </div>`).join('');
    } catch(e) {
      cont.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Ошибка загрузки</div>';
    }
  }

  async function loadUserTickets() {
    const cont = document.getElementById('supportContent');
    if (!cont) return;
    cont.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Загрузка...</div>';
    try {
      const d = await api('/api/support/list');
      const tickets = d.tickets || [];
      if (!tickets.length) {
        cont.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted)">Нет заявок</div>';
        return;
      }
      cont.innerHTML = tickets.map(t => `
        <div class="ticket-item" style="margin-bottom:6px" onclick="window._openUserTicket(${t.id})">
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;font-size:13px">#${t.id} — ${escapeHtml(t.subject||'')}</div>
            <div style="font-size:11px;color:var(--text-muted)">${(t.updated_at||'').replace('T',' ').slice(0,16)}</div>
          </div>
          <span class="ticket-status ${t.status}">${t.status === 'open' ? 'Открыт' : 'Закрыт'}</span>
        </div>
      `).join('');
    } catch(e) { cont.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Ошибка загрузки</div>'; }
  }

  function showNewTicketForm() {
    modal(`
      <h3 style="margin:0 0 12px">Новая заявка</h3>
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label">Категория обращения</label>
        <select class="form-input" id="ntCategory" style="cursor:pointer">
          <option value="">— Выберите категорию —</option>
          <option value="robux">💎 Robux и доставка</option>
          <option value="payment">💳 Оплата и баланс</option>
          <option value="account">👤 Аккаунт и Premium</option>
          <option value="shop">🛒 Магазин и товары</option>
          <option value="bug">🐛 Ошибка / баг</option>
          <option value="other">📝 Другое</option>
        </select>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label">Тема</label>
        <input class="form-input" id="ntSubject" placeholder="Кратко опишите проблему" maxlength="200">
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label">Описание</label>
        <textarea class="form-input" id="ntText" placeholder="Подробно опишите проблему..." rows="4" maxlength="2000" style="resize:vertical"></textarea>
      </div>
      <div style="margin-bottom:12px">
        <label class="form-label" style="margin-bottom:6px;display:block">Прикрепить файлы <span style="font-size:11px;color:var(--text-muted)">(до 3 файлов, макс 50 МБ каждый)</span></label>
        <div id="ntFilesList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <label id="ntAddFileLabel" style="cursor:pointer;background:var(--bg-card);border:1px dashed rgba(255,255,255,0.15);border-radius:10px;padding:10px 14px;font-size:12px;display:inline-flex;align-items:center;gap:6px;transition:all .2s;color:var(--text-secondary)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          Добавить файл
          <input type="file" id="ntFileInput" accept="image/*,video/*,.pdf,.txt,.log,.zip" hidden multiple>
        </label>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="ntSend" style="flex:1">Отправить</button>
        <button class="btn btn-secondary" onclick="closeModal()" style="flex:1">Отмена</button>
      </div>
    `);
    let attachUrls = [];
    let attachFiles = [];
    const MAX_FILES = 3;
    const MAX_SIZE = 50 * 1024 * 1024;

    function renderFilesList() {
      const list = document.getElementById('ntFilesList');
      if (!list) return;
      list.innerHTML = attachFiles.map((f, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;font-size:12px">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)">${f.uploaded ? '✅' : '⏳'} ${escapeHtml(f.name)}</span>
          <span style="font-size:10px;color:var(--text-muted)">${(f.size / 1024 / 1024).toFixed(1)} МБ</span>
          <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:2px" onclick="window._ntRemoveFile(${i})">✕</button>
        </div>
      `).join('');
      const label = document.getElementById('ntAddFileLabel');
      if (label) label.style.display = attachFiles.length >= MAX_FILES ? 'none' : '';
    }

    window._ntRemoveFile = function(idx) {
      attachFiles.splice(idx, 1);
      attachUrls.splice(idx, 1);
      renderFilesList();
    };

    document.getElementById('ntFileInput')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        if (attachFiles.length >= MAX_FILES) { toast('Максимум ' + MAX_FILES + ' файла', 'warning'); break; }
        if (file.size > MAX_SIZE) { toast(file.name + ': макс. 50 МБ', 'error'); continue; }
        const entry = { name: file.name, size: file.size, uploaded: false };
        attachFiles.push(entry);
        renderFilesList();
        try {
          const fd = new FormData(); fd.append('file', file);
          const r = await apiForm('/api/support/upload', fd);
          entry.uploaded = true;
          attachUrls.push(r.url || '');
          renderFilesList();
        } catch(err) {
          toast(err.message || 'Ошибка загрузки ' + file.name, 'error');
          const idx = attachFiles.indexOf(entry);
          if (idx >= 0) { attachFiles.splice(idx, 1); }
          renderFilesList();
        }
      }
      e.target.value = '';
    });

    document.getElementById('ntSend')?.addEventListener('click', async () => {
      const category = (document.getElementById('ntCategory')?.value||'').trim();
      const subject = (document.getElementById('ntSubject')?.value||'').trim();
      const text = (document.getElementById('ntText')?.value||'').trim();
      if (!category) return toast('Выберите категорию','warning');
      if (!subject) return toast('Укажите тему','warning');
      if (!text) return toast('Опишите проблему','warning');
      try {
        loading(true);
        await api('/api/support/create', {method:'POST', body:{subject: '[' + category + '] ' + subject, text, attachment_urls: attachUrls.filter(Boolean)}});
        toast('Заявка создана!','success');
        closeModal();
        showSupportModal();
      } catch(e) { toast(e.message||'Ошибка','error'); }
      finally { loading(false); }
    });
  }

  window._openUserTicket = async function(tid) {
    try {
      const d = await api('/api/support/messages?ticket_id=' + tid);
      const msgs = d.messages || [];
      const ticket = d.ticket || {};

      const renderAtt = (url) => {
        if (!url) return '';
        const u = String(url);
        const ext = u.split('.').pop().split('?')[0].toLowerCase();
        if (['jpg','jpeg','png','gif','webp'].includes(ext))
          return `<a href="${escapeHtml(u)}" target="_blank"><img src="${escapeHtml(u)}" style="max-width:180px;max-height:130px;border-radius:8px;margin-top:6px;display:block;border:1px solid rgba(255,255,255,.1)"></a>`;
        if (['mp4','webm','mov'].includes(ext))
          return `<video src="${escapeHtml(u)}" controls style="max-width:220px;border-radius:8px;margin-top:6px;display:block"></video>`;
        if (ext === 'pdf')
          return `<a href="${escapeHtml(u)}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:7px;color:#ef4444;font-size:12px;margin-top:5px;text-decoration:none">📄 PDF</a>`;
        return `<a href="${escapeHtml(u)}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:var(--text-muted);font-size:12px;margin-top:5px;text-decoration:none">📎 ${ext.toUpperCase()}</a>`;
      };

      const getAttUrls = (m) => {
        if (m.attachment_urls && Array.isArray(m.attachment_urls) && m.attachment_urls.length) return m.attachment_urls;
        if (m.attachment_url) {
          try { const p = JSON.parse(m.attachment_url); return Array.isArray(p) ? p : [m.attachment_url]; }
          catch { return [m.attachment_url]; }
        }
        return [];
      };

      modal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0;font-size:15px;flex:1;min-width:0">#${ticket.id} ${escapeHtml(ticket.subject||'')}</h3>
          <span class="ticket-status ${ticket.status}">${ticket.status === 'open' ? '🟢 Открыт' : '⚫ Закрыт'}</span>
        </div>
        <div class="support-chat">
          <div class="support-msgs" id="userTicketMsgs">
            ${msgs.map(m => {
              const atts = getAttUrls(m);
              return `<div class="support-msg ${m.is_admin ? 'admin' : 'user'}">
                <div>${escapeHtml(m.text)}</div>
                ${atts.map(u => renderAtt(u)).join('')}
                <div class="msg-time">${_fmtDatetime(m.created_at)} ${m.is_admin ? '· поддержка' : ''}</div>
              </div>`;
            }).join('')}
          </div>
          ${ticket.status === 'open' ? `<div class="support-input-row" style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap">
            <input type="file" id="userReplyFile" multiple accept="image/*,.pdf,.txt,.doc,.docx,.zip" style="display:none">
            <button id="userReplyAttach" title="Прикрепить файл" style="height:40px;width:38px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-muted);flex-shrink:0" onmouseover="this.style.background='rgba(124,58,237,.12)'" onmouseout="this.style.background='transparent'">📎</button>
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">
              <div id="userReplyFilePrev" style="display:none;padding:3px 8px;background:rgba(124,58,237,.08);border-radius:6px;font-size:11px;color:#a78bfa"></div>
              <input class="form-input" id="userReplyInput" placeholder="Ваш ответ..." style="width:100%">
            </div>
            <button class="btn btn-primary" id="userReplyBtn">Отправить</button>
          </div>` : '<div style="text-align:center;padding:10px;color:var(--text-muted);font-size:13px">Заявка закрыта</div>'}
        </div>
      `, { size:'wide' });

      const msgsEl = document.getElementById('userTicketMsgs');
      if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

      let _userAttachUrls = [];
      document.getElementById('userReplyAttach')?.addEventListener('click', () => document.getElementById('userReplyFile')?.click());
      document.getElementById('userReplyFile')?.addEventListener('change', async (e) => {
        for (const file of (e.target.files || [])) {
          if (file.size > 10*1024*1024) { toast('Макс 10 МБ','warning'); continue; }
          try {
            const fd = new FormData(); fd.append('file', file);
            const r = await apiForm('/api/support/upload', fd);
            if (r?.url) _userAttachUrls.push(r.url);
            const prev = document.getElementById('userReplyFilePrev');
            if (prev) { prev.style.display='block'; prev.textContent = `📎 ${_userAttachUrls.length} файл(ов)`; }
          } catch(err) { toast(err.message || 'Ошибка','error'); }
        }
        e.target.value = '';
      });

      document.getElementById('userReplyBtn')?.addEventListener('click', async () => {
        const text = (document.getElementById('userReplyInput')?.value || '').trim();
        if (!text && !_userAttachUrls.length) return;
        try {
          const body = { ticket_id: tid, text };
          if (_userAttachUrls.length) body.attachment_urls = _userAttachUrls;
          await api('/api/support/reply', { method:'POST', body });
          window._openUserTicket(tid);
        } catch(e) { toast(e.message, 'error'); }
      });
    } catch(e) { toast(e.message, 'error'); }
  };


  // ══════════════════════════════════════════════════════
  // UTILITY: Safe init wrapper
  // ══════════════════════════════════════════════════════
  function _safeInit(fn, name) {
    try { fn(); } catch (e) { console.warn('[init]', name, e.message); }
  }

  // ══════════════════════════════════════════════════════
  // SCROLL REVEAL (Intersection Observer animations)
  // ══════════════════════════════════════════════════════
  let _revealObserver = null;
  let _lastScrollY = window.scrollY;
  function initScrollReveal() {
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.reveal, .reveal-scale, .reveal-up, .feature-card, .step-item, .trust-card, .review-card').forEach(el => {
        el.classList.add('revealed');
        el.classList.add('visible');
      });
      return;
    }
    // Track scroll direction
    window.addEventListener('scroll', () => { _lastScrollY = window.scrollY; }, { passive: true });
    if (!_revealObserver) {
      let _prevScrollY = window.scrollY;
      _revealObserver = new IntersectionObserver((entries) => {
        const scrollingDown = window.scrollY > _prevScrollY;
        _prevScrollY = window.scrollY;
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            // Entering viewport
            entry.target.classList.remove('reveal-exit-down', 'reveal-exit-up');
            entry.target.classList.add('revealed');
          } else {
            // Leaving viewport — set direction for re-entry animation
            entry.target.classList.remove('revealed');
            if (scrollingDown) {
              entry.target.classList.add('reveal-exit-up');
              entry.target.classList.remove('reveal-exit-down');
            } else {
              entry.target.classList.add('reveal-exit-down');
              entry.target.classList.remove('reveal-exit-up');
            }
          }
        });
      }, { threshold: 0.08 });
    }
    document.querySelectorAll('.reveal:not(.revealed), .reveal-scale:not(.revealed), .reveal-up:not(.revealed), .feature-card:not(.revealed), .step-item:not(.revealed), .trust-card:not(.revealed), .review-card:not(.revealed)').forEach(el => {
      _revealObserver.observe(el);
    });
  }

  // ══════════════════════════════════════════════════════
  // FAQ ACCORDION
  // ══════════════════════════════════════════════════════
  function initFaq() {
    document.querySelectorAll('.faq-question').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.faq-item');
        if (!item) return;
        const isOpen = item.classList.contains('active');
        // Close all
        document.querySelectorAll('.faq-item.active').forEach(i => i.classList.remove('active'));
        // Open clicked one if it wasn't open
        if (!isOpen) item.classList.add('active');
      });
    });
  }

  // Real-time balance + premium polling (every 15s when user is logged in)
  let _realtimeTimer = null;
  function startRealtimePolling() {
    if (_realtimeTimer) return;
    _realtimeTimer = setInterval(async () => {
      if (!state.user) return;
      try {
        const d = await api('/api/auth/me', { silent: true });
        if (!d || !d.user) return;
        const oldBal = state.user.balance;
        const oldPremium = state.user.premium_until;
        state.user = { ...state.user, ...d.user };
        // Update UI if changed
        if (d.user.balance !== oldBal) {
          _applyBalance(d.user.balance);
        }
        if (d.user.premium_until !== oldPremium) {
          updateAuthUI();
        }
      } catch (_) {}
    }, 15000);
  }
  function stopRealtimePolling() {
    if (_realtimeTimer) { clearInterval(_realtimeTimer); _realtimeTimer = null; }
  }

  // ====== NOTIFICATION SYSTEM ======
  let _notifCache = [];

  function initNotifications() {
    const bell = document.getElementById('notifBellBtn');
    const dropdown = document.getElementById('notifDropdown');
    const badge = document.getElementById('notifBadge');
    if (!bell || !dropdown) return;

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
      if (!dropdown.classList.contains('hidden')) loadNotifications();
    });

    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== bell) dropdown.classList.add('hidden');
    });

    document.getElementById('notifMarkAll')?.addEventListener('click', async () => {
      try {
        await api('/api/notifications/read_all', { method: 'POST', body: {} });
        badge?.classList.add('hidden');
        _notifCache.forEach(n => n.read = true);
        _renderNotifications();
      } catch(e) {}
    });
    document.getElementById('notifDeleteAll')?.addEventListener('click', window._deleteAllNotifs);
  }

  async function loadNotifications() {
    const list = document.getElementById('notifList');
    if (!list) return;
    try {
      const d = await api('/api/notifications', { silent: true });
      const items = d?.notifications || d?.items || [];
      // Normalize: API returns is_read (0/1), map to read (bool)
      _notifCache = items.map(n => ({ ...n, read: n.read || Boolean(n.is_read) }));
      _renderNotifications();
    } catch(e) {
      list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">Не удалось загрузить</div>';
    }
  }

  function _renderNotifications() {
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    if (!list) return;
    const items = _notifCache;
    const unread = items.filter(n => !n.read && !n.is_read).length;
    if (badge) {
      badge.classList.toggle('hidden', unread === 0);
      badge.textContent = unread > 99 ? '99+' : (unread > 0 ? String(unread) : '');
    }
    if (!items.length) {
      list.innerHTML = '<div style="text-align:center;padding:30px 16px;color:var(--text-muted);font-size:13px">Нет уведомлений</div>';
      return;
    }
    list.innerHTML = items.slice(0, 30).map(n => {
      const isUnread = !n.read && !n.is_read;
      const dt = n.created_at ? _fmtDatetime(n.created_at) : '';

      // API stores everything in "text" as "**Title**\nMessage" — parse it
      let title = n.title || '';
      let body = n.message || n.text || '';
      if (!title && n.text) {
        // Try to extract bold title: **Title**\nMessage
        const boldMatch = n.text.match(/^\*\*(.+?)\*\*\n?([\s\S]*)$/);
        if (boldMatch) {
          title = boldMatch[1].trim();
          body = boldMatch[2].trim();
        } else {
          // No title formatting — treat whole text as body
          title = '';
          body = n.text.trim();
        }
      }

      const displayText = body || title;
      return `<div data-notif-id="${n.id}" style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:12px;margin-bottom:4px;background:${isUnread ? 'rgba(124,58,237,.08)' : 'rgba(255,255,255,.02)'};border:1px solid ${isUnread ? 'rgba(124,58,237,.2)' : 'rgba(255,255,255,.05)'};transition:all .25s ease;cursor:default;overflow:hidden" onclick="window._readNotif(${n.id})">
        <div style="width:8px;height:8px;border-radius:50%;margin-top:5px;flex-shrink:0;background:${isUnread?'#7c3aed':'transparent'};border:${isUnread?'none':'1.5px solid rgba(255,255,255,.12)'};transition:all .3s"></div>
        <div style="flex:1;min-width:0">
          ${title ? `<div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:2px;line-height:1.3">${escapeHtml(title)}</div>` : ''}
          ${displayText ? `<div style="font-size:12px;color:${title?'var(--text-muted)':'var(--text-primary)'};line-height:1.5;${!title&&isUnread?'font-weight:600':''}">${escapeHtml(displayText)}</div>` : ''}
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px;opacity:.6">${dt}</div>
        </div>
        <button onclick="event.stopPropagation();window._deleteNotif(${n.id})" title="Удалить" style="flex-shrink:0;width:24px;height:24px;border-radius:6px;background:transparent;border:none;cursor:pointer;color:rgba(255,255,255,.3);font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .2s;margin-top:1px" onmouseover="this.style.background='rgba(239,68,68,.15)';this.style.color='#ef4444'" onmouseout="this.style.background='transparent';this.style.color='rgba(255,255,255,.3)'">×</button>
      </div>`;
    }).join('');
  }

  window._readNotif = async function(id) {
    try {
      await api('/api/notifications/read', { method: 'POST', body: { ids: [id] }, silent: true });
      const n = _notifCache.find(x => x.id === id);
      if (n) n.read = true;
      _renderNotifications();
    } catch(e) {}
  };

  window._deleteNotif = async function(id) {
    // Animate removal
    const el = document.querySelector(`[data-notif-id="${id}"]`);
    if (el) {
      el.style.transition = 'all .2s ease';
      el.style.maxHeight = el.offsetHeight + 'px';
      el.style.overflow = 'hidden';
      requestAnimationFrame(() => {
        el.style.opacity = '0';
        el.style.maxHeight = '0';
        el.style.marginBottom = '0';
        el.style.padding = '0';
      });
    }
    try {
      await api('/api/notifications/delete', { method: 'POST', body: { id }, silent: true });
    } catch(_e) {}
    _notifCache = _notifCache.filter(x => x.id !== id);
    setTimeout(() => _renderNotifications(), el ? 220 : 0);
  };

  window._deleteAllNotifs = async function() {
    if (!confirm('Удалить все уведомления?')) return;
    try {
      await api('/api/notifications/delete', { method: 'POST', body: { all: true }, silent: true });
      _notifCache = [];
      _renderNotifications();
    } catch(e) {}
  };

  async function checkNotifBadge() {
    const badge = document.getElementById('notifBadge');
    const bell = document.getElementById('notifBellBtn');
    if (!badge || !bell) return;
    try {
      const d = await api('/api/notifications/unread_count', { silent: true });
      const count = d?.count || 0;
      badge.classList.toggle('hidden', count === 0);
    } catch(e) {}
  }

  // Admin: send notification
  window._adminSendNotification = async function() {
    modal(`
      <h3 style="margin:0 0 12px">📢 Отправить уведомление</h3>
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label">Кому</label>
        <select class="form-input" id="notifTarget">
          <option value="all">Всем пользователям</option>
          <option value="user">Конкретному пользователю</option>
        </select>
      </div>
      <div class="form-group hidden" id="notifUserWrap" style="margin-bottom:10px">
        <label class="form-label">Username / ID пользователя</label>
        <input class="form-input" id="notifUserId" placeholder="username или ID">
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label class="form-label">Заголовок</label>
        <input class="form-input" id="notifTitle" placeholder="Заголовок уведомления" maxlength="100">
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Сообщение</label>
        <textarea class="form-input" id="notifMessage" placeholder="Текст уведомления..." rows="3" maxlength="500" style="resize:vertical"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="notifSendBtn" style="flex:1">Отправить</button>
        <button class="btn btn-secondary" onclick="closeModal()" style="flex:1">Отмена</button>
      </div>
    `);
    document.getElementById('notifTarget')?.addEventListener('change', (e) => {
      const wrap = document.getElementById('notifUserWrap');
      if (wrap) wrap.classList.toggle('hidden', e.target.value !== 'user');
    });
    document.getElementById('notifSendBtn')?.addEventListener('click', async () => {
      const target = document.getElementById('notifTarget')?.value;
      const userId = (document.getElementById('notifUserId')?.value||'').trim();
      const title = (document.getElementById('notifTitle')?.value||'').trim();
      const message = (document.getElementById('notifMessage')?.value||'').trim();
      if (!title) return toast('Укажите заголовок', 'warning');
      if (!message) return toast('Укажите сообщение', 'warning');
      if (target === 'user' && !userId) return toast('Укажите пользователя', 'warning');
      try {
        loading(true);
        await api('/api/admin/notifications/send', { method: 'POST', body: { target, user_id: userId, title, message } });
        toast('Уведомление отправлено!', 'success');
        closeModal();
      } catch(e) { toast(e.message || 'Ошибка', 'error'); }
      finally { loading(false); }
    });
  };

  function boot() {
    loadPersist();
    _safeInit(initTabs, 'tabs');
    // Load site customizations (CSS overrides + text overrides)
    _loadSiteCustom();
    // Restore last opened tab
    switchTab(state.ui.tab || 'home');
    // Wrap to avoid ReferenceError at argument evaluation time
    _safeInit(() => initAuth(), 'auth');
    _safeInit(initShop, 'shop');
    _safeInit(initRobux, 'robux');
    _safeInit(initProfileAnalytics, 'profile-analytics');
    _safeInit(initAvatarUpload, 'avatar-upload');
    _safeInit(startRobuxStock, 'robux-stock');
    // Maintenance mode check - runs after auth so admin can bypass
    document.documentElement.style.opacity = '0';
    (async () => {
      let isMaintenance = false;
      let maintMsg = '';
      try {
        await checkAuth();
        const st = await api('/api/site/status', { silent: true });
        if (st?.maintenance && !state.user?.is_admin) {
          isMaintenance = true;
          maintMsg = st.maintenance_msg;
          // Switch splash to fail mode
          if (window._splashSetMaintenance) window._splashSetMaintenance();
        }
      } catch(_e) {}
      document.documentElement.style.opacity = '1';
      document.documentElement.style.transition = 'none';
      // Dismiss splash screen
      const splash = document.getElementById('splashScreen');
      if (splash) {
        // Wait for user to start splash, then count 10s from that moment
        const _skipSplash = localStorage.getItem('rst_skip_splash')==='1' || localStorage.getItem('rst_seen_before')==='1';
        const _doBreachAndFade = () => {
          // ── Breach success animation ──
          splash.classList.add('breach-success');
          const scan = splash.querySelector('.sp-scan');
          if(scan) scan.style.background='linear-gradient(90deg,transparent 5%,rgba(34,197,94,.4) 30%,rgba(34,197,94,.6) 50%,rgba(34,197,94,.4) 70%,transparent 95%)';
          try{
            if(window._sfxTransition){window._sfxTransition.currentTime=0;window._sfxTransition.play().catch(function(){});}
          }catch(e){}
          setTimeout(() => {
            splash.classList.add('fade-out');
            setTimeout(() => {
              try{localStorage.setItem('rst_seen_before','1');}catch(e){}
              splash.remove();
              document.getElementById('splashCSS')?.remove();
              document.body.classList.remove('splash-active');
              // Stop ALL splash audio immediately
              try{
                if(window._sfxScan){try{window._sfxScan.pause();window._sfxScan.src='';}catch(e){}}
                if(window._sfxTransition){try{window._sfxTransition.pause();window._sfxTransition.src='';}catch(e){}}
                if(window._splashAudio){
                  var _fa=window._splashAudio;
                  var _fo=setInterval(function(){
                    if(_fa.volume>0.02){_fa.volume=Math.max(0,_fa.volume-0.02);}
                    else{_fa.pause();_fa.src='';clearInterval(_fo);}
                  },40);
                }
                if(window._splashAudioCtx){setTimeout(function(){try{window._splashAudioCtx.close();}catch(e){}},1200);}
              }catch(e){}
              if (isMaintenance) _showMaintenanceOverlay(maintMsg);
            }, 800);
          }, 1200);
        };

        if (_skipSplash) {
          // Instant remove - no animation
          try{localStorage.setItem('rst_seen_before','1');}catch(e){}
          splash.remove();
          document.getElementById('splashCSS')?.remove();
          document.body.classList.remove('splash-active');
          if (isMaintenance) _showMaintenanceOverlay(maintMsg);
        } else if (isMaintenance) {
          setTimeout(_doBreachAndFade, 9000);
        } else {
          // Poll: wait for _splashStarted, then wait for all devices scanned
          const _pollStart = setInterval(() => {
            if (window._splashStarted) {
              clearInterval(_pollStart);
              // Now poll for all devices done
              const _pollDone = setInterval(() => {
                if (window._splashAllDevicesDone) {
                  clearInterval(_pollDone);
                  setTimeout(_doBreachAndFade, 800); // short delay after 100%
                }
              }, 200);
              // Safety: if devices never finish, breach after 20s
              setTimeout(() => { clearInterval(_pollDone); _doBreachAndFade(); }, 12000);
            }
          }, 200);
          // Safety: if user never clicks, remove after 35s
          setTimeout(() => { clearInterval(_pollStart); _doBreachAndFade(); }, 25000);
        }
      } else {
        document.body.classList.remove('splash-active');
        if (isMaintenance) _showMaintenanceOverlay(maintMsg);
      }
    })();

    // ── Real-time maintenance status polling ──
    // Checks every 15s: shows overlay if maintenance turns ON, removes it if turned OFF
    setInterval(async () => {
      try {
        const st = await api('/api/site/status', { silent: true });
        const overlay = document.getElementById('maintenanceOverlay');
        if (st?.maintenance && !state.user?.is_admin) {
          if (!overlay) _showMaintenanceOverlay(st.maintenance_msg);
        } else {
          if (overlay) {
            overlay.style.animation = 'maintFadeOut .4s ease forwards';
            setTimeout(() => overlay.remove(), 400);
          }
        }
      } catch(_e) {}
    }, 15000);


    function _showMaintenanceOverlay(msg) {
      if (document.getElementById('maintenanceOverlay')) return;
      const overlay = document.createElement('div');
      overlay.id = 'maintenanceOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#07060e;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:24px;animation:maintFadeIn .4s ease forwards';
      _lockBodyScroll(true);

      // Inject keyframes once
      if (!document.getElementById('maintKeyframes')) {
        const style = document.createElement('style');
        style.id = 'maintKeyframes';
        style.textContent = `
          @keyframes maintFadeIn { from { opacity:0; transform:scale(0.97) } to { opacity:1; transform:scale(1) } }
          @keyframes maintFadeOut { from { opacity:1; transform:scale(1) } to { opacity:0; transform:scale(0.97) } }
          @keyframes maintGearBig { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
          @keyframes maintGearSmall { 0%{transform:rotate(0deg)} 100%{transform:rotate(-360deg)} }
          @keyframes maintPulse { 0%,100%{opacity:.4;transform:scale(1)} 50%{opacity:1;transform:scale(1.04)} }
          @keyframes maintDots { 0%,80%,100%{transform:scale(0);opacity:0} 40%{transform:scale(1);opacity:1} }
          .maint-gear-big { animation: maintGearBig 6s linear infinite; transform-origin:center; }
          .maint-gear-small { animation: maintGearSmall 4s linear infinite; transform-origin:center; }
          .maint-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--accent-tertiary,#c084fc); margin:0 3px; animation: maintDots 1.4s ease-in-out infinite; }
          .maint-dot:nth-child(2) { animation-delay:.2s }
          .maint-dot:nth-child(3) { animation-delay:.4s }
        `;
        document.head.appendChild(style);
      }

      overlay.innerHTML = `
        <div style="position:relative;width:120px;height:120px;margin-bottom:28px">
          <!-- Big gear -->
          <svg class="maint-gear-big" style="position:absolute;top:0;left:0;width:80px;height:80px;color:var(--accent-primary,#7c3aed);opacity:.85" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <!-- Small gear (counter-rotating) -->
          <svg class="maint-gear-small" style="position:absolute;bottom:0;right:0;width:54px;height:54px;color:var(--accent-tertiary,#c084fc);opacity:.7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </div>

        <h2 style="margin:0 0 10px;font-size:26px;font-weight:800;color:#fff;letter-spacing:-0.5px">Технические работы</h2>
        <p id="maintMsg" style="color:rgba(255,255,255,.55);font-size:15px;max-width:380px;line-height:1.7;margin:0 0 6px">${_escapeHtml(msg || 'Сайт временно недоступен. Скоро вернёмся!')}</p>
        <div style="margin:4px 0 28px;display:flex;align-items:center;justify-content:center;gap:4px;color:rgba(255,255,255,.35);font-size:13px">
          Ведём работы <span class="maint-dot"></span><span class="maint-dot"></span><span class="maint-dot"></span>
        </div>

        <!-- Divider -->
        <div style="width:100%;max-width:320px;height:1px;background:rgba(255,255,255,.07);margin-bottom:20px"></div>

        <!-- Admin login -->
        <div style="width:100%;max-width:320px">
          <div style="font-size:11px;color:rgba(255,255,255,.3);margin-bottom:12px;letter-spacing:1.2px;text-transform:uppercase;font-weight:600">Вход для администратора</div>
          <input id="mntLogin" type="text" placeholder="Логин" autocomplete="username"
            style="width:100%;box-sizing:border-box;padding:11px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#fff;font-size:14px;margin-bottom:8px;outline:none;transition:border-color .2s"
            onfocus="this.style.borderColor='rgba(124,58,237,.6)'" onblur="this.style.borderColor='rgba(255,255,255,.1)'">
          <input id="mntPass" type="password" placeholder="Пароль" autocomplete="current-password"
            style="width:100%;box-sizing:border-box;padding:11px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#fff;font-size:14px;margin-bottom:12px;outline:none;transition:border-color .2s"
            onfocus="this.style.borderColor='rgba(124,58,237,.6)'" onblur="this.style.borderColor='rgba(255,255,255,.1)'">
          <button id="mntLoginBtn"
            style="width:100%;padding:11px;border-radius:10px;border:none;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .2s;letter-spacing:.3px"
            onmouseover="this.style.opacity='.88'" onmouseout="this.style.opacity='1'">Войти</button>
          <div id="mntLoginErr" style="color:#f87171;font-size:12px;margin-top:8px;display:none;text-align:center"></div>
        </div>
      `;
      document.body.appendChild(overlay);

      const mntBtn = document.getElementById('mntLoginBtn');
      const mntErr = document.getElementById('mntLoginErr');
      const doLogin = async () => {
        const ident = document.getElementById('mntLogin')?.value?.trim();
        const pass = document.getElementById('mntPass')?.value;
        if (!ident || !pass) return;
        mntBtn.disabled = true; mntBtn.textContent = '…'; mntBtn.style.opacity = '.6';
        try {
          await api('/api/auth/login', { method: 'POST', body: { username: ident, password: pass } });
          overlay.style.animation = 'maintFadeOut .4s ease forwards';
          setTimeout(() => overlay.remove(), 400);
          await checkAuth();
          document.documentElement.style.opacity = '1';
        } catch(e) {
          if (mntErr) { mntErr.textContent = e.message || 'Неверный логин или пароль'; mntErr.style.display = 'block'; }
          mntBtn.disabled = false; mntBtn.textContent = 'Войти'; mntBtn.style.opacity = '1';
        }
      };
      mntBtn?.addEventListener('click', doLogin);
      document.getElementById('mntPass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
      document.getElementById('mntLogin')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('mntPass')?.focus(); });
    }

    // Timezone detection
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) document.cookie = 'user_tz=' + encodeURIComponent(tz) + ';path=/;max-age=31536000;SameSite=Lax';
    } catch(_e) {}

    // Admin
    $('#adminRobuxSettingsForm')?.addEventListener('submit', adminSaveSettings);
    $('#adminAddAccountForm')?.addEventListener('submit', adminAddAccount);
    $('#adminRefreshAll')?.addEventListener('click', adminRefreshAll);
    $('#adminRefreshStock')?.addEventListener('click', updateAdminStockHint);

    // Admin order filter buttons
    document.querySelectorAll('.admin-order-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.admin-order-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _adminOrderFilter = btn.dataset.filter || 'active';
        adminLoadOrders();
      });
    });
    $('#adminAccountsList')?.addEventListener('click', adminItemAction);
    // Admin ticket filter
    $$('#adminTicketFilter .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#adminTicketFilter .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        adminLoadTickets(btn.dataset.tfilter);
      });
    });

    // Auth buttons
    $('#btnLogin')?.addEventListener('click', showLogin);
    $('#btnRegister')?.addEventListener('click', showRegister);
    $('#btnLogout')?.addEventListener('click', logout);
    // Support
    $('#btnSupport')?.addEventListener('click', showSupportModal);
    // Avatar click is handled by initUserDropdown() — no switchTab here

    // Top-up (multiple buttons may exist depending on the layout)
    $$('#btnTopUp, #btnProfileTopUp, #balanceBtn').forEach((b) => b?.addEventListener('click', showTopUp));

    // Modal close
    $('#modalClose')?.addEventListener('click', closeModal);
    $('#modalOverlay')?.addEventListener('click', (e) => { 
      if (e.target.id !== 'modalOverlay') return;
      // Prevent close if user has enabled the setting
      if (localStorage.getItem('rst_prevent_close') === '1') {
        const box = document.getElementById('modal');
        if (box) { box.style.transform = 'scale(0.98)'; setTimeout(() => { box.style.transform = ''; }, 160); }
        return;
      }
      // Don't close if shop item editor is open (prevent accidental misclick)
      if (document.getElementById('sitSave') || document.getElementById('scatSave') || document.getElementById('invAddBtn')) {
        const box = document.getElementById('modal');
        if (box) {
          box.style.transform = 'scale(0.99)';
          setTimeout(() => { box.style.transform = ''; }, 150);
        }
        return;
      }
      closeModal();
    });

    // Shop buttons
    $('#btnBuyPremium')?.addEventListener('click', showPremium);
    // Cases (CS-style roulette)
    $('#btnCaseFree')?.addEventListener('click', () => showCaseRoulette('free'));
    $('#btnCasePaid')?.addEventListener('click', () => showCaseRoulette('paid'));
    $('#btnCaseMoney')?.addEventListener('click', () => showCaseRoulette('money'));


    // Init shop tabs
    initShopTabs();
    
    // Init 3D cards
    init3DProductCards();

    // Scroll reveal
    _safeInit(initScrollReveal, 'scroll-reveal');
    _safeInit(initFaq, 'faq-accordion');

    // User dropdown & support
    _safeInit(initUserDropdown, 'user-dropdown');
    _safeInit(initSupportFab, 'support-fab');
    _safeInit(initNotifications, 'notifications');
    _safeInit(initLegalModal, 'legal-modal');
    _safeInit(fixChartSize, 'chart-fix');

    // Reviews
    _safeInit(loadReviews, 'reviews');
    $('#btnWriteReview')?.addEventListener('click', showReviewForm);
    $('#btnAllReviews')?.addEventListener('click', window._openAllReviews);

    // Balance
    $('#btnBalanceHistory')?.addEventListener('click', showBalanceHistory);
    setInterval(updateBalance, 60000);
    // Real-time purchase count for reviews (every 90s)
    setInterval(() => _safeInit(_updateMyPurchaseCount, 'purchase-count'), 90000);


    // Shop editor toggle (wire in boot too in case DOMContentLoaded already fired)
    const _togBtn = document.getElementById('btnToggleShopEditor');
    if (_togBtn && !_togBtn._wired) {
      _togBtn._wired = true;
      _togBtn.addEventListener('click', adminToggleShopEditor);
    }

    // Apply localization after DOM is ready
    setTimeout(window._applyI18n, 200);
  }

  // Shop filters for tabbed catalog
  function applyShopFilters() {
    const q = ($('#shopSearch')?.value || '').trim().toLowerCase();
    const sort = ($('#shopSort')?.value || 'popular').trim();
    const active = document.querySelector('.shop-tab-content.active');
    if (!active) return;

    const grid = active.querySelector('.shop-grid') || active.querySelector('.product-grid') || active;
    const wrappers = Array.from(grid.querySelectorAll('.product-card-wrapper'));
    if (!wrappers.length) return;

    // Cache original order once
    wrappers.forEach((w, idx) => {
      if (!w.dataset.origIndex) w.dataset.origIndex = String(idx);
    });

    // Filter
    wrappers.forEach(w => {
      const card = w.querySelector('.product-card');
      const t = (card?.querySelector('h3')?.textContent || '').toLowerCase();
      const d = (card?.querySelector('.product-desc')?.textContent || '').toLowerCase();
      const match = !q || t.includes(q) || d.includes(q);
      w.style.display = match ? '' : 'none';
    });

    // Sort (only visible)
    const visible = wrappers.filter(w => w.style.display !== 'none');
    const byPrice = (w) => {
      const card = w.querySelector('.product-card');
      const p = card?.dataset.price;
      const n = Number(p);
      if (!isFinite(n)) return 0;
      return n;
    };

    let ordered = visible.slice();
    if (sort === 'price-asc') {
      ordered.sort((a,b) => byPrice(a) - byPrice(b));
    } else if (sort === 'price-desc') {
      ordered.sort((a,b) => byPrice(b) - byPrice(a));
    } else {
      // popular/default: restore original order
      ordered.sort((a,b) => Number(a.dataset.origIndex||0) - Number(b.dataset.origIndex||0));
    }

    // Append ordered visible nodes, keep hidden ones at the end
    ordered.forEach(w => grid.appendChild(w));
  }

  // Premium modal (CryptoBot / Crypto Pay)
  async function showPremium() {
    if (!state.user) return showLogin();
    try {
      loading(true);
      const [cfg, balData] = await Promise.all([
        api('/api/premium/plans', { silent: true }),
        api('/api/balance', { silent: true })
      ]);
      if (!cfg) return;
      if (balData && typeof balData.balance === 'number') {
        if (state.user) state.user.balance = balData.balance;
        _applyBalance(balData.balance);
      }
      const plans = cfg.plans || [];
      const bal = state.user?.balance || 0;
      const isPremium = isPremiumActive();
      const premiumUntil = state.user?.premium_until || null;
      const premiumStr = isPremium && premiumUntil
        ? new Date(premiumUntil).toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'}) : '';

      // Balance plan always first
      const balPlan = { id: '__balance', days: 50, price_rub: 109, label: '50 дней', hot: true, _balance: true };
      const allPlans = [balPlan, ...plans];

      const perks = [
        { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>`, label: 'Безлимитные генерации' },
        { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`, label: 'Приоритет обработки' },
        { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`, label: 'Эксклюзивные функции' },
        { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`, label: 'Скидки на товары' },
      ];

      // SVG for Telegram
      const tgSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-8.609 3.33c-2.068.8-4.133 1.598-5.724 2.21a405.15 405.15 0 0 1-2.849 1.09c-.42.147-.99.332-1.473.901-.728.968.193 1.798.919 2.286 1.61.516 3.275 1.009 4.654 1.472.846 2.524 1.738 5.048 2.585 7.602.267.794.71 1.8 1.479 2.024a1.954 1.954 0 0 0 1.96-.47l2.357-2.248 4.773 3.515a2.262 2.262 0 0 0 3.341-1.354l3.566-15.133a2.236 2.236 0 0 0-2.016-2.868 2.24 2.24 0 0 0-.941.078z" fill="currentColor"/></svg>`;
      const walletSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M16 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" stroke="none"/><path d="M2 10h20"/></svg>`;

      modal(`
        <div class="pm-wrap">

          <!-- Hero banner -->
          <div class="pm-hero">
            <div class="pm-hero-bg">
              <svg class="pm-hero-gem" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M40 8L56 24L40 72L24 24L40 8Z" fill="url(#g1)" opacity="0.9"/>
                <path d="M24 24L8 40L40 72L24 24Z" fill="url(#g2)" opacity="0.7"/>
                <path d="M56 24L72 40L40 72L56 24Z" fill="url(#g3)" opacity="0.7"/>
                <path d="M8 40L40 8L24 24L8 40Z" fill="url(#g4)" opacity="0.5"/>
                <path d="M40 8L72 40L56 24L40 8Z" fill="url(#g5)" opacity="0.5"/>
                <defs>
                  <linearGradient id="g1" x1="40" y1="8" x2="40" y2="72" gradientUnits="userSpaceOnUse"><stop stop-color="#c084fc"/><stop offset="1" stop-color="#7c3aed"/></linearGradient>
                  <linearGradient id="g2" x1="8" y1="24" x2="40" y2="72" gradientUnits="userSpaceOnUse"><stop stop-color="#a855f7"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
                  <linearGradient id="g3" x1="72" y1="24" x2="40" y2="72" gradientUnits="userSpaceOnUse"><stop stop-color="#d8b4fe"/><stop offset="1" stop-color="#9333ea"/></linearGradient>
                  <linearGradient id="g4" x1="8" y1="8" x2="24" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#e9d5ff"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
                  <linearGradient id="g5" x1="72" y1="8" x2="56" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#e9d5ff"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
                </defs>
              </svg>
            </div>
            <div class="pm-hero-text">
              <div class="pm-hero-label">PREMIUM</div>
              <div class="pm-hero-title">Полный доступ</div>
              ${isPremium
                ? `<div class="pm-hero-active">Активен до ${premiumStr}</div>`
                : `<div class="pm-hero-sub">Разблокируй все возможности платформы</div>`}
            </div>
          </div>

          <!-- Perks -->
          <div class="pm-perks">
            ${perks.map(p => `
              <div class="pm-perk">
                <span class="pm-perk-icon">${p.icon}</span>
                <span>${p.label}</span>
              </div>`).join('')}
          </div>

          <!-- Section label: balance -->
          <div class="pm-section-label">
            <span class="pm-section-icon">${walletSvg}</span>
            Оплата с баланса
          </div>

          <!-- Balance plan -->
          ${(() => {
            const p = balPlan;
            const canBuy = bal >= p.price_rub;
            return `<div class="pm-plan pm-plan--balance pm-plan--featured">
              <div class="pm-plan-tag">Популярно</div>
              <div class="pm-plan-info">
                <div class="pm-plan-period">${p.label}</div>
                <div class="pm-plan-price-row">
                  <span class="pm-plan-price">${_convertPrice(p.price_rub).val} ${_convertPrice(p.price_rub).sym}</span>
                </div>
                <div class="pm-plan-bal">Ваш баланс: <b class="${canBuy?'pm-bal-ok':'pm-bal-low'}">${fmtCurrency(bal)}</b></div>
              </div>
              <button class="btn btn-primary pm-plan-btn" id="btnPremiumBalance" ${!canBuy || isPremium?'disabled':''}>
                ${isPremium ? 'Уже активен' : canBuy ? 'Купить' : 'Пополнить баланс'}
              </button>
            </div>`;
          })()}

          ${plans.length ? `
          <!-- Section label: crypto -->
          <div class="pm-section-label" style="margin-top:18px">
            <span class="pm-section-icon">${tgSvg}</span>
            Оплата через CryptoBot
          </div>
          <div class="pm-crypto-grid">
            ${plans.map(p => `
              <div class="pm-plan pm-plan--crypto${p.hot?' pm-plan--hot':''}">
                ${p.hot?'<div class="pm-plan-tag pm-plan-tag--hot">Выгодно</div>':''}
                <div class="pm-plan-period">${p.label}</div>
                <div class="pm-plan-price-row">
                  <span class="pm-plan-price">${_convertPrice(p.price_rub).val} ${_convertPrice(p.price_rub).sym}</span>
                </div>
                <button class="btn btn-secondary pm-plan-btn" data-premium-buy="${p.id}" ${isPremium?'disabled':''}>${isPremium?'Уже активен':'Оплатить'}</button>
              </div>`).join('')}
          </div>` : ''}

          <button class="btn btn-ghost btn-sm pm-refresh" id="btnPremiumRefresh">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:5px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Проверить статус
          </button>
        </div>

        <style>
          .pm-wrap { padding:0 0 4px; }

          /* Hero */
          .pm-hero { position:relative; display:flex; align-items:center; gap:18px;
            background:linear-gradient(135deg, rgba(var(--accent-rgb),0.12) 0%, rgba(var(--accent-rgb),0.04) 100%);
            border:1px solid rgba(var(--accent-rgb),0.2); border-radius:16px;
            padding:20px 20px 20px 24px; margin-bottom:20px; overflow:hidden; }
          .pm-hero-bg { flex-shrink:0; }
          .pm-hero-gem { width:70px; height:70px; filter:drop-shadow(0 4px 16px rgba(var(--accent-rgb),0.5)); }
          .pm-hero-label { font-size:10px; font-weight:800; letter-spacing:2.5px; color:var(--accent-tertiary); margin-bottom:4px; }
          .pm-hero-title { font-size:22px; font-weight:800; color:var(--text-primary); line-height:1.1; }
          .pm-hero-sub { font-size:13px; color:var(--text-muted); margin-top:4px; }
          .pm-hero-active { display:inline-flex; align-items:center; gap:6px; margin-top:6px;
            background:rgba(34,197,94,0.12); border:1px solid rgba(34,197,94,0.25);
            border-radius:8px; padding:4px 10px; font-size:12px; color:#22c55e; font-weight:600; }

          /* Perks */
          .pm-perks { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:20px; }
          .pm-perk { display:flex; align-items:center; gap:8px;
            background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06);
            border-radius:10px; padding:9px 12px; font-size:12px; color:var(--text-secondary); }
          .pm-perk-icon { color:var(--accent-tertiary); flex-shrink:0; }

          /* Section label */
          .pm-section-label { display:flex; align-items:center; gap:7px;
            font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px;
            color:var(--text-muted); margin-bottom:10px; }
          .pm-section-icon { color:var(--accent-tertiary); }

          /* Balance plan (full-width) */
          .pm-plan--balance { display:flex; align-items:center; justify-content:space-between;
            flex-wrap:wrap; gap:12px; padding:16px 18px; }
          .pm-plan--balance .pm-plan-info { flex:1; min-width:120px; }

          /* Crypto grid */
          .pm-crypto-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:8px; }

          /* Plan base */
          .pm-plan { position:relative; background:rgba(255,255,255,0.03);
            border:1px solid rgba(255,255,255,0.08); border-radius:14px;
            padding:14px 12px 12px; text-align:center; transition:border-color .2s; }
          .pm-plan--crypto { display:flex; flex-direction:column; align-items:center; gap:8px; }
          .pm-plan:hover { border-color:rgba(var(--accent-rgb),0.2); }
          .pm-plan--featured { background:rgba(var(--accent-rgb),0.07); border-color:rgba(var(--accent-rgb),0.25); }
          .pm-plan--hot { background:rgba(var(--accent-rgb),0.05); border-color:rgba(var(--accent-rgb),0.2); }

          /* Tag */
          .pm-plan-tag { position:absolute; top:-9px; left:50%; transform:translateX(-50%);
            background:var(--accent-gradient); color:#fff; font-size:9px; font-weight:800;
            letter-spacing:0.5px; padding:2px 10px; border-radius:20px; white-space:nowrap; }
          .pm-plan-tag--hot { background:linear-gradient(135deg,#f59e0b,#f97316); }

          .pm-plan-period { font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px; }
          .pm-plan-price-row { display:flex; align-items:baseline; gap:2px; justify-content:center; }
          .pm-plan-price { font-size:24px; font-weight:900; color:var(--text-primary); line-height:1; }
          .pm-plan-currency { font-size:13px; color:var(--text-muted); font-weight:500; }
          .pm-plan-bal { font-size:11px; color:var(--text-muted); margin-top:4px; }
          .pm-bal-ok { color:#22c55e; font-weight:700; }
          .pm-bal-low { color:#ef4444; font-weight:700; }
          .pm-plan-btn { width:100%; padding:8px 0; font-size:13px; font-weight:600; margin-top:4px; }
          .pm-refresh { width:100%; margin-top:16px; display:flex; align-items:center; justify-content:center; }

          @media(max-width:480px) {
            .pm-perks { grid-template-columns:1fr; }
            .pm-plan--balance { flex-direction:column; align-items:stretch; }
            .pm-plan--balance .pm-plan-btn { width:100%; }
          }
        </style>
      `, { size: 'wide' });

      // Balance payment
      document.getElementById('btnPremiumBalance')?.addEventListener('click', async () => {
        if (isPremiumActive()) { toast('Premium уже активен. Продление недоступно.', 'warning'); return; }
        const btn = document.getElementById('btnPremiumBalance');
        if (btn?.disabled) return;
        btn.disabled = true; btn.textContent = 'Обработка...';
        try {
          const r = await api('/api/subscription/buy', { method: 'POST', body: {} });
          if (r?.premium_until && state.user) {
            state.user.premium_until = r.premium_until;
            if (state.user.limits) state.user.limits.premium_until = r.premium_until;
          }
          await refreshUserState();
          closeModal();
          toast('Premium активирован!', 'success');
        } catch(err) {
          toast(err.message || 'Ошибка покупки', 'error');
          if (btn) { btn.disabled = false; btn.textContent = 'Купить'; }
        }
      });

      // CryptoPay plan buttons
      document.getElementById('modalContent')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-premium-buy]');
        if (!btn) return;
        if (isPremiumActive()) { toast('Premium уже активен. Продление недоступно.', 'warning'); return; }
        btn.disabled = true; btn.textContent = 'Обработка...';
        try {
          loading(true);
          const d = await api('/api/premium/create', { method: 'POST', body: { plan_id: btn.dataset.premiumBuy } });
          if (d.pay_url) {
            const url = d.pay_url;
            const tgMatch = url.match(/t\.me\/\$([A-Za-z0-9_-]+)/);
            if (tgMatch) {
              const a = document.createElement('a');
              a.href = `tg://invoice?slug=${tgMatch[1]}`;
              a.click();
              setTimeout(() => window.open(url, '_blank'), 1500);
            } else {
              window.open(url, '_blank');
            }
          }
          toast('Перейди в Telegram для оплаты. После — нажми «Проверить статус».', 'info');
        } catch(err) {
          toast(err.message || 'Ошибка', 'error');
          btn.disabled = false; btn.textContent = 'Оплатить';
        } finally { loading(false); }
      });

      document.getElementById('btnPremiumRefresh')?.addEventListener('click', async () => {
        try { loading(true); await api('/api/premium/sync', { method: 'POST', body: {} }).catch(()=>{}); } catch(e) {}
        await checkAuth();
        toast(isPremiumActive() ? 'Premium активен!' : 'Premium не активирован', isPremiumActive() ? 'success' : 'info');
        loading(false);
      });
    } catch(e) { toast(e.message || 'Ошибка', 'error'); }
    finally { loading(false); }
  }

  // Shop Tabs
  function initShopTabs() {
    const tabs = $$('.shop-tab[data-shop-tab]');
    if (!tabs.length) return;

    // Filters
    $('#shopSearch')?.addEventListener('input', debounce(applyShopFilters, 80));
    $('#shopSort')?.addEventListener('change', applyShopFilters);

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.shopTab;
        
        // Update active tab
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Show corresponding content
        $$('.shop-tab-content').forEach(content => {
          content.classList.remove('active');
        });
        
        // Find matching content (convert kebab-case to camelCase for ID)
        const contentId = 'shopTab' + targetTab.split('-').map((w, i) => 
          i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)
        ).join('');
        
        const targetContent = document.getElementById(contentId);
        if (targetContent) {
          targetContent.classList.add('active');
        }
        applyShopFilters();
      });
    });
  }

  // 3D Product Cards
  function init3DProductCards() {
    const wrappers = $$('.product-card-wrapper');
    
    wrappers.forEach(wrapper => {
      const card = wrapper.querySelector('.product-card');
      if (!card) return;

      let bounds;
      let isHovering = false;
      let rafId = null;
      let currentRotateX = 0;
      let currentRotateY = 0;
      let targetRotateX = 0;
      let targetRotateY = 0;

      const lerp = (start, end, factor) => start + (end - start) * factor;

      const animate = () => {
        if (!isHovering && Math.abs(currentRotateX) < 0.1 && Math.abs(currentRotateY) < 0.1) {
          currentRotateX = 0;
          currentRotateY = 0;
          card.style.transform = '';
          rafId = null;
          return;
        }

        currentRotateX = lerp(currentRotateX, targetRotateX, 0.1);
        currentRotateY = lerp(currentRotateY, targetRotateY, 0.1);

        card.style.transform = `perspective(1000px) rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg) scale3d(1.02, 1.02, 1.02)`;
        
        rafId = requestAnimationFrame(animate);
      };

      wrapper.addEventListener('mouseenter', (e) => {
        bounds = wrapper.getBoundingClientRect();
        isHovering = true;
        if (!rafId) rafId = requestAnimationFrame(animate);
      });

      wrapper.addEventListener('mousemove', (e) => {
        if (!bounds || !isHovering) return;
        
        const x = e.clientX - bounds.left;
        const y = e.clientY - bounds.top;
        const centerX = bounds.width / 2;
        const centerY = bounds.height / 2;
        
        targetRotateY = ((x - centerX) / centerX) * 8;
        targetRotateX = ((centerY - y) / centerY) * 8;
      });

      wrapper.addEventListener('mouseleave', () => {
        isHovering = false;
        targetRotateX = 0;
        targetRotateY = 0;
        if (!rafId) rafId = requestAnimationFrame(animate);
      });
    });
  }

  // Run immediately if the script was loaded after DOMContentLoaded (e.g. cached/async)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Fix forEach for NodeList in some browsers
  if (!NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;


  function _showAvatarCropModal(dataUrl, mimeType) {
    let offsetX = 0, offsetY = 0, scale = 1, dragging = false, startX = 0, startY = 0;
    modal(`
      <h3 style="margin:0 0 12px;text-align:center">Обрезать аватар</h3>
      <div id="cropArea" style="position:relative;width:260px;height:260px;margin:0 auto;overflow:hidden;border-radius:12px;background:#111;cursor:move;touch-action:none">
        <img id="cropImg" src="${dataUrl}" style="position:absolute;max-width:none;transform-origin:0 0;pointer-events:none">
        <div style="position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 9999px rgba(0,0,0,0.55);pointer-events:none"></div>
        <div style="position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,255,255,0.3);pointer-events:none"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin:12px auto;max-width:260px">
        <span style="font-size:12px;color:var(--text-muted)">−</span>
        <input type="range" id="cropZoom" min="50" max="300" value="100" style="flex:1">
        <span style="font-size:12px;color:var(--text-muted)">+</span>
      </div>
      <div style="display:flex;gap:8px;max-width:260px;margin:0 auto">
        <button class="btn btn-primary" id="cropSave" style="flex:1">Сохранить</button>
        <button class="btn btn-secondary" id="cropReset" style="flex:1">Сбросить</button>
        <button class="btn btn-secondary" onclick="closeModal()" style="width:auto;padding:0 12px">✕</button>
      </div>
    `);
    const img = document.getElementById('cropImg');
    const area = document.getElementById('cropArea');
    const zoom = document.getElementById('cropZoom');
    if (!img || !area) return;

    const render = () => {
      img.style.transform = 'translate(' + offsetX + 'px,' + offsetY + 'px) scale(' + scale + ')';
    };

    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const fitScale = 260 / Math.min(w, h);
      scale = fitScale;
      zoom.value = Math.round(fitScale * 100);
      offsetX = (260 - w * scale) / 2;
      offsetY = (260 - h * scale) / 2;
      render();
    };
    if (img.complete) img.onload();

    zoom.addEventListener('input', () => {
      const prev = scale;
      scale = parseFloat(zoom.value) / 100;
      const cx = 130, cy = 130;
      offsetX = cx - (cx - offsetX) * (scale / prev);
      offsetY = cy - (cy - offsetY) * (scale / prev);
      render();
    });

    area.addEventListener('pointerdown', (e) => { dragging = true; startX = e.clientX - offsetX; startY = e.clientY - offsetY; area.setPointerCapture(e.pointerId); });
    area.addEventListener('pointermove', (e) => { if (!dragging) return; offsetX = e.clientX - startX; offsetY = e.clientY - startY; render(); });
    area.addEventListener('pointerup', () => { dragging = false; });

    document.getElementById('cropReset')?.addEventListener('click', () => {
      scale = 260 / Math.min(img.naturalWidth, img.naturalHeight);
      zoom.value = Math.round(scale * 100);
      offsetX = (260 - img.naturalWidth * scale) / 2;
      offsetY = (260 - img.naturalHeight * scale) / 2;
      render();
    });

    document.getElementById('cropSave')?.addEventListener('click', async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.beginPath(); ctx.arc(128,128,128,0,Math.PI*2); ctx.clip();
      const drawScale = 256 / 260;
      ctx.drawImage(img, offsetX * drawScale, offsetY * drawScale, img.naturalWidth * scale * drawScale, img.naturalHeight * scale * drawScale);
      canvas.toBlob(async (blob) => {
        if (!blob) { toast('Ошибка обрезки', 'error'); return; }
        try {
          loading(true);
          const fd = new FormData();
          fd.append('file', blob, 'avatar.png');
          const d = await apiForm('/api/user/avatar', fd);
          state.user.avatar_url = (d && (d.url || d.avatar_url)) || '';
          toast('Аватар обновлён!', 'success');
          closeModal(); updateAuthUI();
        } catch(e) { toast(e.message || 'Ошибка', 'error'); }
        finally { loading(false); }
      }, 'image/png', 0.92);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  VISUAL SITE EDITOR
  // ═══════════════════════════════════════════════════════════════
  let _siteCustom = { elements: {}, global_css: '', version: 1 };
  let _siteEditMode = false;
  let _siteEditSelected = null;
  let _siteEditFloater = null;
  let _siteEditPickerEl = null;

  // Generate a unique but stable selector for an element
  function _siteEditSelector(el) {
    if (el.id) return '#' + el.id;
    // Build path
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body) {
      let sel = cur.tagName.toLowerCase();
      const id = cur.id;
      if (id) { parts.unshift('#' + id); break; }
      const siblings = Array.from(cur.parentElement?.children || []).filter(c => c.tagName === cur.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        sel += `:nth-of-type(${idx})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // Load & apply customizations from API
  async function _loadSiteCustom() {
    try {
      const d = await api('/api/site_custom', { silent: true });
      if (d?.custom) {
        _siteCustom = d.custom;
        _applySiteCustom();
      }
    } catch(_e) {}
  }

  function _applySiteCustom() {
    // Apply global CSS
    const styleEl = document.getElementById('siteCustomStyle');
    if (styleEl) {
      let css = _siteCustom.global_css || '';
      // Apply per-element overrides as inline styles via CSS
      const elems = _siteCustom.elements || {};
      for (const [sel, props] of Object.entries(elems)) {
        if (!props || typeof props !== 'object') continue;
        const declarations = Object.entries(props)
          .filter(([k]) => k !== 'text')
          .map(([k, v]) => `${k}:${v}!important`)
          .join(';');
        if (declarations) css += `\n${sel}{${declarations}}`;
      }
      styleEl.textContent = css;
    }
    // Apply text overrides
    const elems = _siteCustom.elements || {};
    for (const [sel, props] of Object.entries(elems)) {
      if (!props?.text) continue;
      try {
        const el = document.querySelector(sel);
        if (el && el.children.length === 0) {
          el.textContent = props.text;
        }
      } catch(_e) {}
    }
  }

  // Init site editor admin page
  function initSiteEditor() {
    const startBtn = document.getElementById('btnStartSiteEdit');
    const saveBtn = document.getElementById('btnSaveSiteEdit');
    const stopBtn = document.getElementById('btnStopSiteEdit');
    const resetBtn = document.getElementById('btnResetSiteEdit');
    const applyCssBtn = document.getElementById('btnApplyGlobalCss');
    const cssArea = document.getElementById('siteGlobalCss');
    if (!startBtn) return;

    // Load current custom
    api('/api/admin/site_custom', { silent: true }).then(d => {
      if (d?.custom) {
        _siteCustom = d.custom;
        if (cssArea) cssArea.value = _siteCustom.global_css || '';
        _renderSiteEditList();
      }
    }).catch(() => {});

    startBtn.onclick = () => _startSiteEditMode();
    saveBtn.onclick = () => _saveSiteCustom();
    stopBtn.onclick = () => _stopSiteEditMode(false);
    resetBtn.onclick = async () => {
      if (!confirm('Сбросить все изменения оформления сайта?')) return;
      _siteCustom = { elements: {}, global_css: '', version: 1 };
      await _saveSiteCustom();
      if (cssArea) cssArea.value = '';
      _applySiteCustom();
      _renderSiteEditList();
    };
    applyCssBtn.onclick = () => {
      const css = cssArea?.value || '';
      _siteCustom.global_css = css;
      _applySiteCustom();
      toast('CSS применён (предпросмотр)', 'info');
    };
  }

  function _renderSiteEditList() {
    const list = document.getElementById('siteEditElementList');
    const count = document.getElementById('siteEditCount');
    if (!list) return;
    const elems = _siteCustom.elements || {};
    const keys = Object.keys(elems);
    if (count) count.textContent = keys.length;
    if (!keys.length) {
      list.innerHTML = '<div class="muted" style="font-size:13px;text-align:center;padding:16px">Нет изменённых элементов</div>';
      return;
    }
    list.innerHTML = keys.map(sel => {
      const props = elems[sel];
      const summary = Object.entries(props).map(([k,v]) => `${k}: ${v}`).join(', ');
      return `<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-family:monospace;color:var(--accent-tertiary);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(sel)}</div>
          <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(summary)}</div>
        </div>
        <button style="background:rgba(239,68,68,.15);border:none;border-radius:6px;padding:4px 8px;color:#ef4444;cursor:pointer;font-size:11px;flex-shrink:0" onclick="window._siteEditDeleteEl(${JSON.stringify(sel)})">✕</button>
      </div>`;
    }).join('');
  }

  window._siteEditDeleteEl = function(sel) {
    if (_siteCustom.elements) delete _siteCustom.elements[sel];
    _applySiteCustom();
    _renderSiteEditList();
  };

  function _startSiteEditMode() {
    if (_siteEditMode) return;
    _siteEditMode = true;
    document.getElementById('btnStartSiteEdit').style.display = 'none';
    document.getElementById('btnSaveSiteEdit').style.display = '';
    document.getElementById('btnStopSiteEdit').style.display = '';
    // Switch to home tab for editing
    switchTab('home');
    toast('Режим редактирования активен. Кликни на любой элемент!', 'info');

    // Add overlay banner
    const banner = document.createElement('div');
    banner.id = 'siteEditBanner';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99998;background:rgba(124,58,237,.95);backdrop-filter:blur(10px);color:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px;font-size:13px;font-weight:600;box-shadow:0 -4px 20px rgba(124,58,237,.3)';
    banner.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      <span>Режим редактирования активен — кликни на элемент</span>
      <button onclick="window._siteEditNavTo('home')" style="background:rgba(255,255,255,.2);border:none;border-radius:6px;padding:4px 8px;color:#fff;cursor:pointer;font-size:11px">Главная</button>
      <button onclick="window._siteEditNavTo('robux')" style="background:rgba(255,255,255,.2);border:none;border-radius:6px;padding:4px 8px;color:#fff;cursor:pointer;font-size:11px">Robux</button>
      <button onclick="window._siteEditNavTo('shop')" style="background:rgba(255,255,255,.2);border:none;border-radius:6px;padding:4px 8px;color:#fff;cursor:pointer;font-size:11px">Магазин</button>
      <button onclick="window._siteEditNavTo('profile')" style="background:rgba(255,255,255,.2);border:none;border-radius:6px;padding:4px 8px;color:#fff;cursor:pointer;font-size:11px">Профиль</button>
      <div style="flex:1"></div>
      <button onclick="window._stopSiteEditMode(false)" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:4px 10px;color:#fff;cursor:pointer;font-size:11px">✕ Выйти</button>
    `;
    document.body.appendChild(banner);
    document.body.style.paddingBottom = '52px';

    // Click handler
    document.addEventListener('click', _siteEditClickHandler, true);
    document.addEventListener('mouseover', _siteEditHoverHandler, true);
    document.addEventListener('mouseout', _siteEditMouseoutHandler, true);
  }

  window._siteEditNavTo = (tab) => switchTab(tab);
  window._stopSiteEditMode = _stopSiteEditMode;

  function _stopSiteEditMode(save) {
    if (!_siteEditMode) return;
    _siteEditMode = false;
    document.getElementById('btnStartSiteEdit').style.display = '';
    document.getElementById('btnSaveSiteEdit').style.display = 'none';
    document.getElementById('btnStopSiteEdit').style.display = 'none';
    document.removeEventListener('click', _siteEditClickHandler, true);
    document.removeEventListener('mouseover', _siteEditHoverHandler, true);
    document.removeEventListener('mouseout', _siteEditMouseoutHandler, true);
    document.getElementById('siteEditBanner')?.remove();
    document.body.style.paddingBottom = '';
    _siteEditFloater?.remove(); _siteEditFloater = null;
    _siteEditPickerEl = null;
    // Remove highlight
    document.querySelectorAll('.__site_edit_hover').forEach(e => e.classList.remove('__site_edit_hover'));
    // Switch back to admin
    switchTab('admin');
    const adminPage = document.querySelector('.admin-page[data-admin-page="siteeditor"]');
    if (adminPage) {
      document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
      adminPage.classList.add('active');
    }
  }

  // Inject hover style
  if (!document.getElementById('siteEditHoverStyle')) {
    const s = document.createElement('style');
    s.id = 'siteEditHoverStyle';
    s.textContent = `.__site_edit_hover{outline:2px solid rgba(124,58,237,.7)!important;outline-offset:2px!important;cursor:crosshair!important}`;
    document.head.appendChild(s);
  }

  function _siteEditHoverHandler(e) {
    if (!_siteEditMode) return;
    const el = e.target;
    if (!el || el.id === 'siteEditBanner' || el.closest('#siteEditBanner') || el.closest('#siteEditFloater')) return;
    document.querySelectorAll('.__site_edit_hover').forEach(x => x.classList.remove('__site_edit_hover'));
    el.classList.add('__site_edit_hover');
  }

  function _siteEditMouseoutHandler(e) {
    e.target?.classList?.remove('__site_edit_hover');
  }

  function _siteEditClickHandler(e) {
    if (!_siteEditMode) return;
    const el = e.target;
    if (!el || el.id === 'siteEditBanner' || el.closest('#siteEditBanner') || el.closest('#siteEditFloater')) return;
    e.preventDefault(); e.stopPropagation();
    _siteEditSelected = el;
    _showSiteEditFloater(el);
  }

  function _showSiteEditFloater(el) {
    _siteEditFloater?.remove();
    const sel = _siteEditSelector(el);
    const existing = _siteCustom.elements?.[sel] || {};
    const computed = window.getComputedStyle(el);

    const floater = document.createElement('div');
    floater.id = 'siteEditFloater';
    floater.style.cssText = `position:fixed;z-index:99999;top:60px;right:16px;width:min(340px,calc(100vw - 32px));background:#1a1625;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:16px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-size:13px;max-height:80vh;overflow-y:auto`;
    floater.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-weight:700;color:#fff;font-size:14px">✏️ Редактор элемента</div>
        <button id="seClose" style="background:none;border:none;color:rgba(255,255,255,.5);cursor:pointer;font-size:18px;line-height:1;padding:2px">×</button>
      </div>
      <div style="font-size:10px;font-family:monospace;color:rgba(255,255,255,.4);margin-bottom:14px;word-break:break-all;background:rgba(255,255,255,.04);padding:6px 8px;border-radius:6px">${escapeHtml(sel)}</div>

      <!-- Text -->
      ${el.children.length === 0 ? `
      <div style="margin-bottom:12px">
        <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Текст</label>
        <input id="seText" value="${escapeHtml(existing.text ?? el.textContent ?? '')}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;color:#fff;font-size:13px;outline:none">
      </div>` : ''}

      <!-- Color -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Цвет текста</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="color" id="seColor" value="${_cssColorToHex(existing.color || computed.color || '#ffffff')}" style="width:36px;height:34px;padding:2px;border:1px solid rgba(255,255,255,.1);border-radius:6px;background:rgba(255,255,255,.06);cursor:pointer">
            <button id="seColorClear" style="font-size:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:rgba(255,255,255,.5);cursor:pointer;padding:4px 8px">Сброс</button>
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Фон</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="color" id="seBg" value="${_cssColorToHex(existing.background || existing['background-color'] || computed.backgroundColor || '#07060e')}" style="width:36px;height:34px;padding:2px;border:1px solid rgba(255,255,255,.1);border-radius:6px;background:rgba(255,255,255,.06);cursor:pointer">
            <button id="seBgClear" style="font-size:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:rgba(255,255,255,.5);cursor:pointer;padding:4px 8px">Сброс</button>
          </div>
        </div>
      </div>

      <!-- Opacity & Font size -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Прозрачность</label>
          <input type="range" id="seOpacity" min="0" max="1" step="0.05" value="${existing.opacity ?? 1}" style="width:100%;accent-color:#7c3aed">
          <div id="seOpacityVal" style="font-size:11px;color:rgba(255,255,255,.4);text-align:center">${existing.opacity ?? 1}</div>
        </div>
        <div>
          <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Размер шрифта</label>
          <input id="seFontSize" placeholder="16px / 1.2rem" value="${existing['font-size'] || ''}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 8px;color:#fff;font-size:12px;outline:none">
        </div>
      </div>

      <!-- Padding & Border radius -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Отступы (padding)</label>
          <input id="sePadding" placeholder="12px 24px" value="${existing.padding || ''}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 8px;color:#fff;font-size:12px;outline:none">
        </div>
        <div>
          <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Скругление</label>
          <input id="seBorderRadius" placeholder="8px" value="${existing['border-radius'] || ''}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 8px;color:#fff;font-size:12px;outline:none">
        </div>
      </div>

      <!-- Custom CSS -->
      <div style="margin-bottom:14px">
        <label style="font-size:11px;color:rgba(255,255,255,.5);display:block;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Свой CSS (доп.)</label>
        <textarea id="seCustomCss" rows="2" placeholder="display:flex; gap:10px;" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 8px;color:#fff;font-size:12px;font-family:monospace;outline:none;resize:vertical">${existing._custom || ''}</textarea>
      </div>

      <div style="display:flex;gap:8px">
        <button id="seApply" style="flex:1;background:linear-gradient(135deg,#7c3aed,#a855f7);border:none;border-radius:10px;padding:10px;color:#fff;font-weight:700;cursor:pointer;font-size:13px">✓ Применить</button>
        <button id="seDelete" style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:10px 14px;color:#ef4444;cursor:pointer;font-size:13px">🗑</button>
      </div>
    `;
    document.body.appendChild(floater);
    _siteEditFloater = floater;

    // Opacity display
    const opEl = floater.querySelector('#seOpacity');
    const opVal = floater.querySelector('#seOpacityVal');
    opEl?.addEventListener('input', () => { if (opVal) opVal.textContent = opEl.value; });

    // Color clear buttons
    floater.querySelector('#seColorClear')?.addEventListener('click', () => { floater.querySelector('#seColor').value = '#ffffff'; });
    floater.querySelector('#seBgClear')?.addEventListener('click', () => { floater.querySelector('#seBg').value = '#07060e'; });

    // Close
    floater.querySelector('#seClose')?.addEventListener('click', () => { floater.remove(); _siteEditFloater = null; });

    // Delete
    floater.querySelector('#seDelete')?.addEventListener('click', () => {
      if (_siteCustom.elements) delete _siteCustom.elements[sel];
      _applySiteCustom(); _renderSiteEditList(); floater.remove(); _siteEditFloater = null;
      toast('Элемент удалён из изменений', 'info');
    });

    // Apply
    floater.querySelector('#seApply')?.addEventListener('click', () => {
      if (!_siteCustom.elements) _siteCustom.elements = {};
      const props = {};
      const textEl = floater.querySelector('#seText');
      if (textEl && textEl.value.trim() !== (el.textContent || '').trim()) {
        props.text = textEl.value;
      }
      const opacity = parseFloat(floater.querySelector('#seOpacity')?.value ?? 1);
      if (opacity !== 1) props.opacity = opacity;
      const color = floater.querySelector('#seColor')?.value;
      if (color && color !== '#ffffff') props.color = color;
      const bg = floater.querySelector('#seBg')?.value;
      if (bg && bg !== '#07060e') props['background-color'] = bg;
      const fs = floater.querySelector('#seFontSize')?.value?.trim();
      if (fs) props['font-size'] = fs;
      const pad = floater.querySelector('#sePadding')?.value?.trim();
      if (pad) props.padding = pad;
      const br = floater.querySelector('#seBorderRadius')?.value?.trim();
      if (br) props['border-radius'] = br;
      const custom = floater.querySelector('#seCustomCss')?.value?.trim();
      if (custom) {
        props._custom = custom;
        // Parse custom CSS inline into individual properties
        custom.split(';').forEach(part => {
          const [k, ...vParts] = part.split(':');
          if (k && vParts.length) props[k.trim()] = vParts.join(':').trim();
        });
      }
      if (Object.keys(props).length) {
        _siteCustom.elements[sel] = props;
        _applySiteCustom();
        _renderSiteEditList();
        // Apply text immediately
        if (props.text && el.children.length === 0) el.textContent = props.text;
        toast('Применено! Сохрани в Admin → Редактор', 'success');
      } else {
        toast('Нет изменений для сохранения', 'warning');
      }
    });

    // Draggable floater for mobile
    let _fdX = 0, _fdY = 0, _fdDragging = false;
    floater.querySelector('#seClose')?.parentElement && floater.addEventListener('mousedown', (e) => {
      if (e.target.closest('input, textarea, button, select')) return;
      _fdDragging = true; _fdX = e.clientX; _fdY = e.clientY;
    });
    document.addEventListener('mousemove', (e) => {
      if (!_fdDragging) return;
      const dx = e.clientX - _fdX; const dy = e.clientY - _fdY;
      const rect = floater.getBoundingClientRect();
      floater.style.right = 'auto';
      floater.style.left = Math.max(0, rect.left + dx) + 'px';
      floater.style.top = Math.max(0, rect.top + dy) + 'px';
      _fdX = e.clientX; _fdY = e.clientY;
    });
    document.addEventListener('mouseup', () => { _fdDragging = false; });
  }

  function _cssColorToHex(cssColor) {
    if (!cssColor || cssColor === 'transparent' || cssColor === 'rgba(0, 0, 0, 0)') return '#000000';
    if (cssColor.startsWith('#') && cssColor.length <= 7) return cssColor;
    const d = document.createElement('div');
    d.style.color = cssColor;
    document.body.appendChild(d);
    const computed = window.getComputedStyle(d).color;
    d.remove();
    const m = computed.match(/\d+/g);
    if (!m) return '#000000';
    return '#' + [m[0],m[1],m[2]].map(x => parseInt(x).toString(16).padStart(2,'0')).join('');
  }

  async function _saveSiteCustom() {
    const cssArea = document.getElementById('siteGlobalCss');
    if (cssArea) _siteCustom.global_css = cssArea.value || '';
    try {
      loading(true);
      await api('/api/admin/site_custom', { method: 'POST', body: { custom: _siteCustom } });
      _applySiteCustom();
      _renderSiteEditList();
      toast('Настройки сохранены и применены!', 'success');
      if (_siteEditMode) _stopSiteEditMode(true);
    } catch(e) {
      toast(e.message || 'Ошибка сохранения', 'error');
    } finally { loading(false); }
  }

  // Hook into admin page switching to init editor
  const _origInitAdmin = typeof initAdmin === 'function' ? initAdmin : null;
  function _initSiteEditorIfNeeded() {
    if (document.getElementById('btnStartSiteEdit')) initSiteEditor();
  }

})();
