/**
 * RBX Store - Application JavaScript v2.0
 * Clean, modular code
 */
(function() {
  'use strict';

  // State
  const state = { user: null, ui: { tab: 'home' }, robux: { amount: 50, mode: 'username', quote: null, gamepass: null, usernameRaw: '', urlRaw: '' } };

  // Helpers
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const escapeHtml = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

  const paymentMethods = [
    { name: 'ЮKassa', type: 'Агрегатор', note: 'Подходит самозанятым, поддержка СБП и банковских карт.' },
    { name: 'T-Банк Эквайринг', type: 'Банк', note: 'Быстрое подключение, понятная модерация для digital-услуг.' },
    { name: 'CloudPayments', type: 'Агрегатор', note: 'Карты + рекуррентные платежи, подходит для подписок.' },
    { name: 'ЮMoney', type: 'Кошелёк/эквайринг', note: 'Удобно для РФ-аудитории и микроплатежей.' },
    { name: 'CryptoBot', type: 'Крипто', note: 'Оставляем как доп.метод, но не единственный для модерации.' }
  ];

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
          usernameRaw: $('#robuxUsername')?.value || state.robux.usernameRaw || '',
          urlRaw: $('#robuxUrl')?.value || state.robux.urlRaw || ''
        }
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  // API
  async function api(endpoint, opts = {}) {
    const cfg = { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts };
    if (opts.body && typeof opts.body === 'object') cfg.body = JSON.stringify(opts.body);
    const res = await fetch(endpoint, cfg);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
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
  function modal(content) {
    const o = $('#modalOverlay'), m = $('#modalContent');
    if (o && m) { m.innerHTML = content; o.classList.remove('hidden'); }
  }
  function closeModal() { const o = $('#modalOverlay'); if (o) o.classList.add('hidden'); }

  // Tabs
  function initTabs() {
    $$('.nav-btn[data-tab], .nav-mobile-btn[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $$('[data-goto]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.goto)));
  }

  function switchTab(id) {
    state.ui.tab = id;
    savePersist();
    $$('.nav-btn, .nav-mobile-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${id}`));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Auth
  async function checkAuth() {
    try {
      const data = await api('/api/auth/me');
      if (data.user) { state.user = data.user; updateAuthUI(); }
    } catch (e) { state.user = null; updateAuthUI(); }
  }

  function updateAuthUI() {
    const auth = $('#authCard'), profile = $('#profileContent'), bal = $('#balanceBtn'), avatar = $('#avatarBtn');
    if (state.user) {
      auth?.classList.add('hidden');
      profile?.classList.remove('hidden');
      bal?.classList.remove('hidden');
      const letter = (state.user.username || '?')[0].toUpperCase();
      if (avatar) avatar.querySelector('span').textContent = letter;
      $('#profileAvatar') && ($('#profileAvatar').textContent = letter);
      $('#profileName') && ($('#profileName').textContent = state.user.username || 'User');
      $('#profileId') && ($('#profileId').textContent = state.user.id || '—');
      updateBalance();
      updateStats();
    } else {
      auth?.classList.remove('hidden');
      profile?.classList.add('hidden');
      bal?.classList.add('hidden');
    }
  }

  async function updateBalance() {
    try {
      const d = await api('/api/balance');
      const b = d.balance || 0;
      $('#balanceValue') && ($('#balanceValue').textContent = `${b.toLocaleString('ru-RU')} ₽`);
      $('#statBalance') && ($('#statBalance').textContent = `${b.toLocaleString('ru-RU')} ₽`);
    } catch (e) {}
  }

  function updateStats() {
    if (!state.user) return;
    const pu = state.user.premium_until;
    $('#statPremium') && ($('#statPremium').textContent = pu && new Date(pu) > new Date() ? new Date(pu).toLocaleDateString('ru-RU') : 'Нет');
    $('#statGenerations') && ($('#statGenerations').textContent = state.user.credits_analyze ?? '—');
    $('#statAI') && ($('#statAI').textContent = state.user.credits_ai ?? '—');
  }

  // Login
  function showLogin() {
    modal(`
      <h2 style="margin-bottom:24px;text-align:center">Вход</h2>
      <form id="loginForm">
        <div class="form-group"><label class="form-label">Логин/Email</label><input type="text" class="form-input" id="loginUser" required></div>
        <div class="form-group"><label class="form-label">Пароль</label><input type="password" class="form-input" id="loginPass" required></div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px">Войти</button>
      </form>
      <p style="text-align:center;margin-top:16px;font-size:14px;color:var(--text-muted)">Нет аккаунта? <a href="#" id="toReg" style="color:var(--accent-primary)">Регистрация</a></p>
    `);
    $('#loginForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const u = $('#loginUser')?.value?.trim(), p = $('#loginPass')?.value;
      if (!u || !p) return toast('Заполни поля', 'warning');
      try {
        loading(true);
        const d = await api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
        if (d.need_2fa) { show2FA(d.login_token); } 
        else { closeModal(); toast('Успешно!', 'success'); checkAuth(); }
      } catch (e) { toast(e.message, 'error'); } finally { loading(false); }
    });
    $('#toReg')?.addEventListener('click', e => { e.preventDefault(); showRegister(); });
  }

  function show2FA(token) {
    modal(`
      <h2 style="margin-bottom:24px;text-align:center">2FA</h2>
      <p style="text-align:center;color:var(--text-secondary);margin-bottom:24px">Код отправлен на почту</p>
      <form id="tfaForm">
        <div class="form-group"><label class="form-label">Код</label><input type="text" class="form-input" id="tfaCode" required style="text-align:center;font-size:20px;letter-spacing:6px"></div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px">Подтвердить</button>
      </form>
    `);
    $('#tfaForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const c = $('#tfaCode')?.value?.trim();
      if (!c) return toast('Введи код', 'warning');
      try {
        loading(true);
        await api('/api/auth/login_confirm', { method: 'POST', body: { login_token: token, code: c } });
        closeModal(); toast('Успешно!', 'success'); checkAuth();
      } catch (e) { toast(e.message, 'error'); } finally { loading(false); }
    });
  }

  function showRegister() {
    modal(`
      <h2 style="margin-bottom:24px;text-align:center">Регистрация</h2>
      <form id="regForm">
        <div class="form-group"><label class="form-label">Логин</label><input type="text" class="form-input" id="regUser" required minlength="3" maxlength="20"><span class="form-hint">3-20 символов</span></div>
        <div class="form-group"><label class="form-label">Email</label><input type="email" class="form-input" id="regEmail" required></div>
        <div class="form-group"><label class="form-label">Пароль</label><input type="password" class="form-input" id="regPass" required minlength="6"><span class="form-hint">Минимум 6 символов</span></div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px">Зарегистрироваться</button>
      </form>
      <p style="text-align:center;margin-top:16px;font-size:14px;color:var(--text-muted)">Есть аккаунт? <a href="#" id="toLogin" style="color:var(--accent-primary)">Войти</a></p>
    `);
    $('#regForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const u = $('#regUser')?.value?.trim(), em = $('#regEmail')?.value?.trim(), p = $('#regPass')?.value;
      if (!u || !em || !p) return toast('Заполни все поля', 'warning');
      try {
        loading(true);
        await api('/api/auth/register_start', { method: 'POST', body: { username: u, email: em, password: p } });
        showRegConfirm(u, em, p);
      } catch (e) { toast(e.message, 'error'); } finally { loading(false); }
    });
    $('#toLogin')?.addEventListener('click', e => { e.preventDefault(); showLogin(); });
  }

  function showRegConfirm(u, em, p) {
    modal(`
      <h2 style="margin-bottom:24px;text-align:center">Подтверждение</h2>
      <p style="text-align:center;color:var(--text-secondary);margin-bottom:24px">Код отправлен на ${escapeHtml(em)}</p>
      <form id="regConfirm">
        <div class="form-group"><label class="form-label">Код</label><input type="text" class="form-input" id="regCode" required style="text-align:center;font-size:20px;letter-spacing:6px"></div>
        <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px">Подтвердить</button>
      </form>
    `);
    $('#regConfirm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const c = $('#regCode')?.value?.trim();
      if (!c) return toast('Введи код', 'warning');
      try {
        loading(true);
        await api('/api/auth/register_confirm', { method: 'POST', body: { username: u, email: em, password: p, code: c } });
        closeModal(); toast('Аккаунт создан! Войди.', 'success'); showLogin();
      } catch (e) { toast(e.message, 'error'); } finally { loading(false); }
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
    try {
      // Backend expects ?amount=. (We also support legacy ?robux_amount= on server side)
      const d = await api(`/api/robux/quote?amount=${encodeURIComponent(state.robux.amount)}`);
      state.robux.quote = d;
      $('#robuxPrice') && ($('#robuxPrice').textContent = `${d.rub_price || 0} ₽`);
      $('#gamepassPrice') && ($('#gamepassPrice').textContent = `${d.gamepass_price || 0} R$`);
      $('#robuxRate') && ($('#robuxRate').textContent = `Курс: ${d.rub_per_robux || '—'} ₽/R$`);
    } catch (e) { toast(e.message, 'error'); }
  }

  const debouncedQuote = debounce(loadRobuxQuote, 300);
  function debounce(fn, d) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; }

  function initRobux() {
    const amtInput = $('#robuxAmount');
    const uInput = $('#robuxUsername');
    const urlInput = $('#robuxUrl');

    // Apply persisted values to fields
    if (amtInput) amtInput.value = String(state.robux.amount);
    if (uInput && state.robux.usernameRaw) uInput.value = state.robux.usernameRaw;
    if (urlInput && state.robux.urlRaw) urlInput.value = state.robux.urlRaw;

    const applyModeUI = () => {
      $$('.mode-tab[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === state.robux.mode));
      const cap = state.robux.mode.charAt(0).toUpperCase() + state.robux.mode.slice(1);
      $$('.mode-content').forEach(x => x.classList.toggle('active', x.id === `mode${cap}`));
    };
    applyModeUI();

    // Amount input
    if (amtInput) {
      amtInput.addEventListener('input', () => {
        state.robux.amount = Math.max(10, Math.min(100000, parseInt(amtInput.value) || 50));
        savePersist();
        debouncedQuote();
      });
    }

    // Quick amounts
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

    // Mode tabs
    $$('.mode-tab[data-mode]').forEach(b => {
      b.addEventListener('click', () => {
        state.robux.mode = b.dataset.mode;
        applyModeUI();
        savePersist();
      });
    });

    // Persist raw fields
    uInput?.addEventListener('input', () => { state.robux.usernameRaw = uInput.value; savePersist(); });
    urlInput?.addEventListener('input', () => { state.robux.urlRaw = urlInput.value; savePersist(); });

    // Buttons
    $('#btnRobuxCheck')?.addEventListener('click', robuxCheck);
    $('#btnRobuxBuy')?.addEventListener('click', robuxBuy);

    // Initial quote
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
    let username = '', url = '';

    if (mode === 'username') {
      const raw = $('#robuxUsername')?.value || '';
      username = normalizeUsername(raw);
      if (!username) return toast('Введи ник Roblox', 'warning');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return toast('Ник должен быть латиницей (A-Z, 0-9, _). Кириллица Б, И, Г, Д, Ж и др. не конвертируется!', 'warning');
      }
    } else {
      url = $('#robuxUrl')?.value?.trim() || '';
      if (!url) return toast('Вставь ссылку на геймпасс', 'warning');
    }

    state.robux.usernameRaw = $('#robuxUsername')?.value || state.robux.usernameRaw;
    state.robux.urlRaw = $('#robuxUrl')?.value || state.robux.urlRaw;
    savePersist();

    const status = $('#robuxStatus'), result = $('#robuxResult'), buyBtn = $('#btnRobuxBuy');
    status?.classList.remove('hidden');
    result?.classList.add('hidden');
    if (buyBtn) buyBtn.disabled = true;

    try {
      const payload = { amount: state.robux.amount, mode };
      if (mode === 'username') payload.username = username;
      else payload.gamepass_url = url;

      const d = await api('/api/robux/inspect', { method: 'POST', body: payload });
      state.robux.gamepass = d.gamepass;

      // Show result
      $('#resultName') && ($('#resultName').textContent = d.gamepass?.name || '—');
      $('#resultOwner') && ($('#resultOwner').textContent = d.gamepass?.owner || '—');
      $('#resultPrice') && ($('#resultPrice').textContent = `${d.gamepass?.price || 0} R$`);
      result?.classList.remove('hidden');
      if (buyBtn) buyBtn.disabled = false;
      toast('Геймпасс найден!', 'success');
    } catch (e) {
      toast(e.message, 'error');
      state.robux.gamepass = null;
    } finally {
      status?.classList.add('hidden');
    }
  }

  async function robuxBuy() {
    if (!state.user) return toast('Сначала войди в аккаунт', 'warning');
    if (!state.robux.gamepass) return toast('Сначала проверь геймпасс', 'warning');

    const mode = state.robux.mode;
    const username = mode === 'username' ? normalizeUsername($('#robuxUsername')?.value || '') : '';
    const gpId = state.robux.gamepass.gamepass_id;

    try {
      loading(true);
      const d = await api('/api/robux/order_reserve', { method: 'POST', body: {
        amount: state.robux.amount,
        gamepass_url: String(gpId),
        username
      }});

      // Pay
      await api('/api/robux/order_pay', { method: 'POST', body: { order_id: d.order_id } });
      toast('Заказ оплачен! Ожидайте выполнения.', 'success');
      updateBalance();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      loading(false);
    }
  }

  // Top-up
  function showTopUp() {
    if (!state.user) return toast('Сначала войди', 'warning');
    modal(`
      <h2 style="margin-bottom:24px;text-align:center">Пополнение баланса</h2>
      <div class="form-group">
        <label class="form-label">Сумма (₽)</label>
        <input type="number" class="form-input" id="topupAmount" value="100" min="10">
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px">
        <button class="btn btn-primary" id="btnSBP">СБП</button>
        <button class="btn btn-primary" id="btnCard">Банковская карта</button>
        <button class="btn btn-secondary" id="btnYooMoney">ЮMoney</button>
        <button class="btn btn-secondary" id="btnCrypto">CryptoBot</button>
      </div>
      <button class="btn btn-secondary" style="width:100%;margin-top:12px" id="btnPromo">Промокод</button>
    `);
    const bindTopupMethod = (selector, method, message = 'Перейди по ссылке для оплаты') => {
      $(selector)?.addEventListener('click', async () => {
        const amt = parseInt($('#topupAmount')?.value) || 100;
        try {
          loading(true);
          const d = await api('/api/topup/create', { method: 'POST', body: { amount: amt, method } });
          if (d.pay_url) window.open(d.pay_url, '_blank');
          closeModal();
          toast(message, 'info');
        } catch (e) { toast(e.message, 'error'); } finally { loading(false); }
      });
    };

    $('#btnSBP')?.addEventListener('click', () => toast('СБП подключается после модерации эквайринга', 'info'));
    $('#btnCard')?.addEventListener('click', () => toast('Оплата картой будет включена после одобрения провайдера', 'info'));
    $('#btnYooMoney')?.addEventListener('click', () => toast('ЮMoney находится в процессе подключения', 'info'));
    bindTopupMethod('#btnCrypto', 'cryptobot');
    $('#btnPromo')?.addEventListener('click', () => showPromoInput());
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
        await api('/api/topup/redeem', { method: 'POST', body: { code } });
        closeModal();
        toast('Промокод активирован!', 'success');
        updateBalance();
      } catch (e) { toast(e.message, 'error'); } finally { loading(false); }
    });
  }


  function renderPaymentMethods() {
    const grid = $('#paymentMethodsGrid');
    if (!grid) return;
    grid.innerHTML = paymentMethods.map(pm => `
      <article class="payment-method-card">
        <span class="chip">${escapeHtml(pm.type)}</span>
        <h3>${escapeHtml(pm.name)}</h3>
        <p>${escapeHtml(pm.note)}</p>
      </article>
    `).join('');
  }

  function initScrollReveal() {
    const nodes = $$('.reveal-on-scroll');
    if (!nodes.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) entry.target.classList.add('is-visible');
      });
    }, { threshold: 0.12 });
    nodes.forEach(n => io.observe(n));
  }

  function showAdminPanelPreview() {
    modal(`
      <h2 style="margin-bottom:12px">Админ-панель (обновлено)</h2>
      <p style="color:var(--text-secondary);margin-bottom:16px">Раздел подготовлен под модерацию платёжек: проверка заказов, возвраты, статусы автодоставки и лог платежей.</p>
      <ul class="steps-list" style="margin-bottom:12px">
        <li>Дашборд: выручка, конверсия, спорные платежи.</li>
        <li>Заказы: фильтры по статусу и способу оплаты.</li>
        <li>Возвраты: шаблоны ответов и SLA поддержки.</li>
        <li>Логи: подтверждение выдачи и id транзакций.</li>
      </ul>
    `);
  }

  // Init
  document.addEventListener('DOMContentLoaded', () => {
    loadPersist();
    initTabs();
    // Restore last opened tab
    switchTab(state.ui.tab || 'home');
    initRobux();
    renderPaymentMethods();
    initScrollReveal();
    checkAuth();

    // Auth buttons
    $('#btnLogin')?.addEventListener('click', showLogin);
    $('#btnRegister')?.addEventListener('click', showRegister);
    $('#btnLogout')?.addEventListener('click', logout);
    $('#avatarBtn')?.addEventListener('click', () => state.user ? switchTab('profile') : showLogin());
    $('#btnAdminPanel')?.addEventListener('click', showAdminPanelPreview);

    // Top-up
    $('#btnTopUp, #btnProfileTopUp, #balanceBtn').forEach?.(b => b?.addEventListener('click', showTopUp));

    // Modal close
    $('#modalClose')?.addEventListener('click', closeModal);
    $('#modalOverlay')?.addEventListener('click', e => { if (e.target.id === 'modalOverlay') closeModal(); });

    // Shop buttons
    $('#btnBuyPremium')?.addEventListener('click', () => toast('В разработке', 'info'));
    $('#btnCaseFree, #btnCasePaid')?.forEach?.(b => b?.addEventListener('click', () => toast('В разработке', 'info')));
  });

  // Fix forEach for NodeList in some browsers
  if (!NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;
})();
