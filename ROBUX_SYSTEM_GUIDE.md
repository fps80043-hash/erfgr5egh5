# Robux Shop System - Руководство

## Обзор

Новая система покупки Robux с поддержкой двух режимов:
- **Обычный режим** - для всех пользователей
- **Автоматический режим** ⭐ - только для Premium пользователей

## Функции

### Для администратора

#### 1. Настройка продавца
- Перейдите в Админ панель → Robux
- Вставьте cookie аккаунта Roblox с Robux (Robux-Seller)
- Система автоматически определит баланс
- Настройте:
  - **Курс** (₽ за 1 Robux) - по умолчанию 0.5
  - **Минимальная сумма** - по умолчанию 50 R$
  - **Максимальная сумма** - по умолчанию 100000 R$
  - **Комиссия** - по умолчанию 43% (коэффициент 1.43)

#### 2. Расчет наличия
При балансе продавца 1430 R$:
```
Доступно для продажи = 1430 / 1.43 = 1000 R$
```

#### 3. API Endpoints для админа
- `GET /api/admin/robux/full_settings` - получить настройки
- `POST /api/admin/robux/full_settings` - сохранить настройки
- `POST /api/admin/robux/refresh_stock` - обновить баланс

### Для пользователей

#### Обычные пользователи
1. Кнопка **"Проверить"** - проверка наличия геймпасса
2. Если геймпасс найден - покупка
3. Если не найден - инструкция по созданию

#### Premium пользователи ⭐
1. **Переключатель режима** (Обычный / Автоматический)
2. В автоматическом режиме:
   - Ввод cookie для автосоздания геймпасса
   - Система создает и выкупает геймпасс автоматически

### API Endpoints для пользователей
- `GET /api/robux/shop_config` - публичная конфигурация (курс, наличие)
- `POST /api/robux/check_gamepass_advanced` - продвинутая проверка
- `POST /api/robux/create_gamepass` - создание геймпасса (Premium)
- `POST /api/robux/buy_with_mode` - покупка с выбором режима

## Безопасность

### Анти-фрод система
- Rate limiting: максимум 5 заказов в минуту
- Логирование подозрительных действий
- Защита от массовых покупок

### Хранение данных
- Cookie продавца шифруется перед сохранением
- Cookie пользователя (для авто-режима) не сохраняется

## Структура базы данных

### Новые таблицы

```sql
-- Настройки и stock Robux
robux_stock (
    id PRIMARY KEY,
    total_robux INTEGER,
    available_robux INTEGER,
    reserved_robux INTEGER,
    sold_robux INTEGER,
    min_amount INTEGER,
    max_amount INTEGER,
    rub_per_robux REAL,
    gp_factor REAL,
    seller_cookie_enc TEXT,
    seller_user_id BIGINT,
    seller_username TEXT,
    last_updated TEXT,
    updated_at TEXT
)

-- Лог фрод попыток
robux_fraud_log (
    id PRIMARY KEY,
    user_id INTEGER,
    action TEXT,
    ip_address TEXT,
    user_agent TEXT,
    details TEXT,
    created_at TEXT
)

-- Rate limiting
robux_rate_limits (
    id PRIMARY KEY,
    user_id INTEGER,
    action TEXT,
    count INTEGER,
    window_start TEXT
)
```

## Файлы системы

### Backend
- `app.py` - основные API endpoints
- `robux_system.py` - дополнительные функции и helpers

### Frontend
- `templates/index.html` - обновленная страница Robux
- `static/app.js` - JavaScript логика
- `styles.css` - CSS стили для новых компонентов

## Запуск

```bash
# Установка зависимостей
pip install -r requirements.txt

# Запуск приложения
python app.py
```

## Первоначальная настройка

1. Зайдите в админ панель
2. Перейдите в раздел Robux
3. Вставьте cookie аккаунта продавца
4. Настройте курс и лимиты
5. Сохраните настройки
6. Проверьте отображение на странице Robux

## Поддержка

При возникновении проблем:
1. Проверьте логи приложения
2. Убедитесь что cookie продавца валиден
3. Проверьте настройки в админ панели
