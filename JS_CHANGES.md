# Изменения в app.js

## Проблема
Фронтенд использует Puter AI (window.puter.ai.chat) вместо нашего бэкенд API. Нужно переделать:
1. AI Чат - использовать `/api/tools/ai_chat`
2. Генератор описаний - переделать под куки, использовать `/api/tools/desc_generate`

---

## 1. AI Чат (строки ~2934-2960)

**НАЙТИ** функцию `send` внутри `toolShowChat()` (строка ~2934):
```javascript
const send = async () => {
  const inp = document.getElementById('toolChatInput');
  const text = (inp?.value || '').trim();
  if (!text) return;
  if (!state.user) return showLogin();
  inp.value = '';
  state.tools.chatHistory.push({ role: 'user', content: text });
  render();
  try {
    loading(true);
    await api('/api/ai/consume', { method: 'POST', body: { kind: 'chat', amount: 1 } });
    const model = document.getElementById('toolChatModelSel')?.value || 'x-ai/grok-4';
    if (!window.puter?.ai?.chat) throw new Error('Puter AI не загрузился...');
```

**ЗАМЕНИТЬ НА:**
```javascript
const send = async () => {
  const inp = document.getElementById('toolChatInput');
  const text = (inp?.value || '').trim();
  if (!text) return;
  if (!state.user) return showLogin();
  inp.value = '';
  state.tools.chatHistory.push({ role: 'user', content: text });
  render();
  try {
    loading(true);
    
    // Используем наш бэкенд вместо Puter
    const resp = await api('/api/tools/ai_chat', { 
      method: 'POST', 
      body: { 
        message: text,
        provider: 'pollinations',  // или 'groq' если есть ключ
        model: 'openai'
      } 
    });
    
    const reply = resp.response || 'Нет ответа';
    state.tools.chatHistory.push({ role: 'assistant', content: reply });
    render();
    toast('Ответ получен', 'success');
```

---

## 2. Генератор описаний - ПОЛНАЯ ПЕРЕДЕЛКА

**ЗАМЕНИТЬ** всю функцию `toolShowGenerator()` (строка ~2629) на новую версию:

```javascript
async function toolShowGenerator() {
  modal(`
    <h2 style="text-align:center;margin-bottom:16px">✍️ Генератор описания через Cookie</h2>
    
    <div class="form-group">
      <label class="form-label">Roblox Cookie (.ROBLOSECURITY)</label>
      <textarea class="form-input" id="genCookie" rows="2" placeholder="Вставь .ROBLOSECURITY cookie..."></textarea>
      <div class="muted" style="margin-top:6px">Cookie используется только для получения данных аккаунта и не сохраняется.</div>
    </div>
    
    <button class="btn btn-secondary" style="width:100%" id="genCheckBtn">Проверить аккаунт</button>
    
    <div class="card hidden" id="genAccountCard" style="margin-top:12px">
      <div class="row between gap-10">
        <div style="font-weight:700" id="genUsername">—</div>
        <div class="pill" id="genRobux">—</div>
      </div>
      <div class="muted" id="genInfo" style="margin-top:6px">—</div>
    </div>
    
    <div id="genOptionsSection" class="hidden">
      <hr style="opacity:.12;margin:16px 0">
      
      <h3 style="margin:0 0 10px 0">⚙️ Настройки генерации</h3>
      
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Режим</label>
          <select class="form-input" id="genMode">
            <option>Рерайт</option>
            <option>Креатив</option>
            <option>С нуля</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Тон</label>
          <select class="form-input" id="genTone">
            <option>Классика</option>
            <option>Нейтрально</option>
            <option>Агрессивно</option>
            <option>Минимализм</option>
          </select>
        </div>
      </div>
      
      <div class="form-group">
        <label class="form-label">Пожелания (опционально)</label>
        <input class="form-input" id="genExtra" placeholder="Напр: добавить эмодзи, упомянуть редкие лимитки...">
      </div>
      
      <button class="btn btn-primary" style="width:100%" id="genGenerateBtn">🤖 Сгенерировать описание</button>
      
      <div class="card hidden" id="genResultCard" style="margin-top:12px">
        <div style="font-weight:800;margin-bottom:8px" id="genTitle">—</div>
        <div class="muted" style="white-space:pre-wrap" id="genDesc">—</div>
      </div>
    </div>
  `, { size: 'xl' });
  
  let accountData = null;
  
  // Проверка аккаунта по cookie
  document.getElementById('genCheckBtn')?.addEventListener('click', async () => {
    try {
      loading(true);
      const cookie = (document.getElementById('genCookie')?.value || '').trim();
      if (!cookie) throw new Error('Вставь cookie');
      
      const data = await api('/api/roblox/check_cookie', { method: 'POST', body: { cookie } });
      
      if (data.status !== 'valid') throw new Error(data.error || 'Cookie недействителен');
      
      accountData = {
        username: data.user?.username || '',
        user_id: data.user?.id || '',
        robux: data.robux?.balance || 0,
        rap: data.inventory?.collectibles_rap || 0,
        is_premium: data.robux?.is_premium || false,
        limiteds: data.inventory?.limiteds_count || 0,
        groups: data.groups?.count || 0
      };
      
      document.getElementById('genUsername').textContent = accountData.username;
      document.getElementById('genRobux').textContent = `${accountData.robux} R$`;
      document.getElementById('genInfo').textContent = 
        `ID: ${accountData.user_id} | RAP: ${accountData.rap} | Premium: ${accountData.is_premium ? 'Да' : 'Нет'}`;
      
      document.getElementById('genAccountCard')?.classList.remove('hidden');
      document.getElementById('genOptionsSection')?.classList.remove('hidden');
      toast('Аккаунт проверен', 'success');
    } catch (e) {
      toast(e.message || 'Ошибка проверки', 'error');
    } finally {
      loading(false);
    }
  });
  
  // Генерация описания
  document.getElementById('genGenerateBtn')?.addEventListener('click', async () => {
    if (!accountData) {
      toast('Сначала проверь аккаунт', 'warning');
      return;
    }
    
    try {
      loading(true);
      
      const mode = document.getElementById('genMode')?.value || 'Рерайт';
      const tone = document.getElementById('genTone')?.value || 'Классика';
      const extra = document.getElementById('genExtra')?.value || '';
      
      const resp = await api('/api/tools/desc_generate', {
        method: 'POST',
        body: {
          data: accountData,
          mode: mode,
          tone: tone,
          extra: extra,
          provider: 'pollinations',
          model: 'openai'
        }
      });
      
      if (!resp.ok) throw new Error(resp.error || 'Ошибка генерации');
      
      document.getElementById('genTitle').textContent = resp.title || '';
      document.getElementById('genDesc').textContent = resp.desc || '';
      document.getElementById('genResultCard')?.classList.remove('hidden');
      
      toast('Описание сгенерировано!', 'success');
    } catch (e) {
      toast(e.message || 'Ошибка генерации', 'error');
    } finally {
      loading(false);
    }
  });
}
```

---

## 3. Дополнительно - удалить старые функции

В файле есть старые функции для работы с шаблонами (toolLoadTemplates, toolSaveTemplate и т.д.). Они больше не нужны при работе через куки. Можно оставить или удалить.

---

## Итого

После этих изменений:
- ✅ AI Чат будет работать через ваш бэкенд Pollinations/Groq
- ✅ Генератор описаний будет работать через куки, получая полные данные аккаунта
- ✅ Баланс и премиум система будут работать корректно
- ✅ Не нужен Puter AI
