"""Robux shop + admin routes.

This module isolates the Robux flow from the main monolithic app.py so the codebase
is easier to maintain and evolve. It uses simple dependency injection via `deps`
so it can be imported without creating circular imports.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple, Optional

# FastAPI resolves postponed (string) annotations against module globals.
# Because this module uses `from __future__ import annotations`, relying on
# *locally injected* types (like `Request`, `HTTPException`, Dict aliases, etc.)
# would make FastAPI treat them as ordinary query/body params and raise 422.
from fastapi import Body, HTTPException, Request


def register_robux_routes(app, *, deps: Dict[str, Any]) -> None:
    # ---- injected dependencies (from app.py) ----
    USE_PG = deps["USE_PG"]
    db_conn = deps["db_conn"]
    require_user = deps["require_user"]
    require_admin = deps["require_admin"]
    _now_utc = deps["_now_utc"]
    _now_utc_iso = deps["_now_utc_iso"]
    _rget = deps["_rget"]
    robux_calc = deps["robux_calc"]
    roblox_inspect_gamepass = deps["roblox_inspect_gamepass"]
    roblox_seller_status = deps["roblox_seller_status"]
    roblox_buy_product = deps["roblox_buy_product"]
    _robux_cfg_effective = deps["_robux_cfg_effective"]
    _seller_cookie_effective = deps["_seller_cookie_effective"]
    _setting_get = deps["_setting_get"]
    _setting_set = deps["_setting_set"]
    threading = deps["threading"]
    datetime = deps["datetime"]

    def _iso_utc_ms(dt_iso: str) -> Optional[int]:
        """Convert a *naive UTC* ISO string (legacy format) to epoch milliseconds.

        The legacy app stores timestamps like "2026-01-21T22:00:00.123456" without
        timezone info. Browsers parse such strings as *local time*, which makes
        reservation timers instantly expire for non-UTC users.
        """
        if not dt_iso:
            return None
        try:
            dt = datetime.datetime.fromisoformat(str(dt_iso))
            # treat as UTC
            dt = dt.replace(tzinfo=datetime.timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            return None

    # ----------------------------
    # Robux shop flow (wizard)
    # ----------------------------

    def _robux_rate_limit_or_raise(con, user_id: int):
        """Basic anti-spam: 1 order per 10s and max 5 per 60s."""
        now = _now_utc()
        ts10 = (now - datetime.timedelta(seconds=10)).isoformat()
        ts60 = (now - datetime.timedelta(seconds=60)).isoformat()
        r1 = con.execute(
            "SELECT COUNT(1) AS c FROM robux_orders WHERE user_id=? AND created_at>=?",
            (int(user_id), ts10),
        ).fetchone()
        c10 = int(_rget(r1, "c") or 0) if r1 else 0
        if c10 >= 1:
            raise HTTPException(status_code=429, detail="Слишком часто. Подожди пару секунд.")
        r2 = con.execute(
            "SELECT COUNT(1) AS c FROM robux_orders WHERE user_id=? AND created_at>=?",
            (int(user_id), ts60),
        ).fetchone()
        c60 = int(_rget(r2, "c") or 0) if r2 else 0
        if c60 >= 5:
            raise HTTPException(status_code=429, detail="Лимит заказов в минуту достигнут.")

    @app.get("/api/robux/quote")
    def api_robux_quote(request: Request, amount: str = "50"):
        """Return pricing quote.

        Be tolerant to client-side intermediate states (empty input, undefined, etc.)
        to avoid FastAPI 422 "Field required" errors that leak to the UI.
        """
        # Quote is safe for anonymous users (calculator UX)
        # Auth is required on reserve/pay steps.
        raw = "" if amount is None else str(amount).strip()
        try:
            a = int(raw) if raw else 50
        except Exception:
            a = 50
        # server-side clamp (UI may allow clearing while typing)
        if a < 1:
            a = 1
        return {"ok": True, **robux_calc(a)}

    @app.post("/api/robux/inspect")
    def api_robux_inspect(request: Request, payload: dict = Body(default_factory=dict)):
        # Allow inspect without auth (better UX). Reserve/pay still require auth.
        url = str(
            payload.get("url")
            or payload.get("gamepass_url")
            or payload.get("gamepass")
            or payload.get("link")
            or payload.get("id")
            or ""
        ).strip()
        info = roblox_inspect_gamepass(url)
        return {"ok": True, "gamepass": info}

    @app.post("/api/robux/order_create")
    def api_robux_order_create(request: Request, payload: dict = Body(default_factory=dict)):
        u = require_user(request)
        uid = int(u["id"])
        try:
            amount = int(payload.get("amount") or 0)
        except Exception:
            amount = 0
        gp_url = str(payload.get("gamepass_url") or "").strip()
        q = robux_calc(amount)
        gp = roblox_inspect_gamepass(gp_url)

        # Anti-fraud: price must match expected
        if int(gp.get("price") or 0) != int(q["gamepass_price"]):
            raise HTTPException(status_code=400, detail=f"Цена геймпасса должна быть {q['gamepass_price']} Robux")
        if int(gp.get("product_id") or 0) <= 0:
            raise HTTPException(status_code=400, detail="Не удалось получить ProductId геймпасса")

        ts = _now_utc_iso()
        con = db_conn()
        _robux_rate_limit_or_raise(con, uid)

        if USE_PG:
            row = con.execute(
                "INSERT INTO robux_orders(user_id,robux_amount,rub_price,gamepass_price,gamepass_url,gamepass_id,product_id,gamepass_name,gamepass_owner,gamepass_owner_id,status,error_message,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                (
                    uid,
                    int(q["robux"]),
                    int(q["rub_price"]),
                    int(q["gamepass_price"]),
                    gp_url,
                    int(gp.get("gamepass_id") or 0),
                    int(gp.get("product_id") or 0),
                    str(gp.get("name") or ""),
                    str(gp.get("owner") or ""),
                    int(gp.get("owner_id") or 0),
                    "new",
                    None,
                    ts,
                    ts,
                ),
            ).fetchone()
            oid = int(_rget(row, "id") or 0) if row else 0
        else:
            cur = con.execute(
                "INSERT INTO robux_orders(user_id,robux_amount,rub_price,gamepass_price,gamepass_url,gamepass_id,product_id,gamepass_name,gamepass_owner,gamepass_owner_id,status,error_message,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    uid,
                    int(q["robux"]),
                    int(q["rub_price"]),
                    int(q["gamepass_price"]),
                    gp_url,
                    int(gp.get("gamepass_id") or 0),
                    int(gp.get("product_id") or 0),
                    str(gp.get("name") or ""),
                    str(gp.get("owner") or ""),
                    int(gp.get("owner_id") or 0),
                    "new",
                    None,
                    ts,
                    ts,
                ),
            )
            oid = int(cur.lastrowid)

        con.commit()
        con.close()
        return {"ok": True, "order_id": oid, "quote": q, "gamepass": gp}

    def _robux_refund_order(con, row, *, reason: str):
        """Refund reserved funds back to user (idempotent)."""
        try:
            refunded = int(_rget(row, "refunded") or 0)
            if refunded:
                return
            reserved_rub = int(_rget(row, "reserved_rub") or 0)
            if reserved_rub <= 0:
                # still mark refunded to avoid repeat attempts
                con.execute(
                    "UPDATE robux_orders SET refunded=1, refunded_at=?, updated_at=?, error_message=? WHERE id=?",
                    (_now_utc_iso(), _now_utc_iso(), reason, int(_rget(row, "id") or 0)),
                )
                return
            uid = int(_rget(row, "user_id") or 0)
            ts = _now_utc_iso()
            con.execute("UPDATE users SET balance=balance+? WHERE id=?", (reserved_rub, uid))
            con.execute(
                "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                (uid, None, int(reserved_rub), reason, ts),
            )
            con.execute(
                "UPDATE robux_orders SET refunded=1, refunded_at=?, updated_at=?, error_message=? WHERE id=?",
                (ts, ts, reason, int(_rget(row, "id") or 0)),
            )
        except Exception:
            # never raise from refund
            pass

    def _robux_expire_reservations(con):
        """Cancel and refund expired reservations."""
        now = _now_utc()
        now_iso = now.isoformat()
        now_ts = int(now.timestamp())

        # Prefer numeric timestamp if present (robust across locales/formatting).
        try:
            rows = con.execute(
                "SELECT * FROM robux_orders WHERE status='reserved' AND reserve_expires_ts IS NOT NULL AND reserve_expires_ts<?",
                (now_ts,),
            ).fetchall()
        except Exception:
            rows = []

        # Back-compat: old rows only have reserve_expires_at TEXT
        try:
            rows2 = con.execute(
                "SELECT * FROM robux_orders WHERE status='reserved' AND (reserve_expires_ts IS NULL OR reserve_expires_ts=0) AND reserve_expires_at IS NOT NULL AND reserve_expires_at<?",
                (now_iso,),
            ).fetchall()
        except Exception:
            rows2 = []

        for r in (rows or []) + (rows2 or []):
            try:
                oid = int(_rget(r, "id") or 0)
                con.execute(
                    "UPDATE robux_orders SET status=?, cancelled_at=?, updated_at=? WHERE id=? AND status='reserved'",
                    ("cancelled", now_iso, now_iso, oid),
                )
                _robux_refund_order(con, r, reason=f"robux reservation expired #{oid}")
            except Exception:
                pass

    def _robux_reserved_capacity_ok(con, *, need_robux: int) -> Tuple[bool, int]:
        """Returns (ok, available_robux). Available is seller_robux - reserved_pending."""
        st = roblox_seller_status()
        if not st.get("configured"):
            return (False, 0)
        seller_robux = int(st.get("robux") or 0)
        cfg = _robux_cfg_effective()
        # Manual cap for sale (0 = auto)
        sale_cap = int(cfg.get("stock_sale") or 0)
        cap = seller_robux
        if sale_cap > 0:
            cap = min(cap, sale_cap)
        rr = con.execute(
            "SELECT COALESCE(SUM(gamepass_price),0) AS s FROM robux_orders WHERE status IN ('reserved','processing')",
            (),
        ).fetchone()
        reserved_total = int(_rget(rr, "s") or 0) if rr else 0
        available = max(0, cap - reserved_total)
        return (available >= int(need_robux), available)

    def _robux_worker_purchase(order_id: int):
        con = db_conn()
        try:
            _robux_expire_reservations(con)
            row = con.execute("SELECT * FROM robux_orders WHERE id=?", (int(order_id),)).fetchone()
            if not row:
                return
            status = str(_rget(row, "status") or "")
            if status != "processing":
                return

            need_price = int(_rget(row, "gamepass_price") or 0)
            ok, available = _robux_reserved_capacity_ok(con, need_robux=need_price)
            if not ok:
                raise RuntimeError(f"Недостаточно Robux на аккаунте продавца. Доступно: {available} R$")

            gp_url = str(_rget(row, "gamepass_url") or "")
            gp = roblox_inspect_gamepass(gp_url)
            if int(gp.get("price") or 0) != need_price:
                raise RuntimeError("Цена геймпасса изменилась")
            pid = int(gp.get("product_id") or 0)
            owner_id = int(gp.get("owner_id") or 0)
            gp_id = int(gp.get("gamepass_id") or 0)

            roblox_buy_product(product_id=pid, expected_price=need_price, expected_seller_id=owner_id, gamepass_id=gp_id)

            ts = _now_utc_iso()
            con.execute(
                "UPDATE robux_orders SET status=?, updated_at=?, error_message=? WHERE id=?",
                ("done", ts, None, int(order_id)),
            )
            con.commit()
        except Exception as e:
            ts = _now_utc_iso()
            try:
                row = con.execute("SELECT * FROM robux_orders WHERE id=?", (int(order_id),)).fetchone()
                if row:
                    con.execute(
                        "UPDATE robux_orders SET status=?, updated_at=?, error_message=? WHERE id=?",
                        ("failed", ts, str(e), int(order_id)),
                    )
                    _robux_refund_order(con, row, reason=f"robux order failed #{order_id}: {str(e)}")
                con.commit()
            except Exception:
                pass
        finally:
            con.close()

    @app.post("/api/robux/order_reserve")
    def api_robux_order_reserve(request: Request, payload: dict = Body(default_factory=dict)):
        u = require_user(request)
        uid = int(u["id"])
        oid = int(payload.get("order_id") or 0)
        if not oid:
            raise HTTPException(status_code=400, detail="order_id required")

        con = db_conn()
        try:
            _robux_expire_reservations(con)

            row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (oid, uid)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Order not found")
            status = str(_rget(row, "status") or "")
            if status != "new":
                raise HTTPException(status_code=400, detail="Заказ уже в работе")

            # Anti-fraud: re-check the gamepass at reservation time too.
            # User can change the price between "Step 3" and reserve.
            need_price = int(_rget(row, "gamepass_price") or 0)
            gp_url = str(_rget(row, "gamepass_url") or "")
            gp_now = roblox_inspect_gamepass(gp_url)
            if int(gp_now.get("price") or 0) != need_price:
                raise HTTPException(status_code=409, detail="Цена геймпасса изменилась. Проверь ещё раз.")
            # lock on expected product + owner
            if int(gp_now.get("product_id") or 0) != int(_rget(row, "product_id") or 0):
                raise HTTPException(status_code=409, detail="Изменился ProductId геймпасса. Проверь ссылку.")
            if int(gp_now.get("owner_id") or 0) != int(_rget(row, "gamepass_owner_id") or 0):
                raise HTTPException(status_code=409, detail="Сменился владелец геймпасса. Проверь ссылку.")

            rub_price = int(_rget(row, "rub_price") or 0)

            urow = con.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()
            bal = int(_rget(urow, "balance") or 0) if urow else 0
            if bal < rub_price:
                raise HTTPException(
                    status_code=402,
                    detail="Недостаточно средств на балансе. Пополни баланс и попробуй снова.",
                )

            ok, available = _robux_reserved_capacity_ok(con, need_robux=need_price)
            if not ok:
                raise HTTPException(status_code=409, detail=f"Сейчас нет в наличии. Доступно: {available} R$")

            ts = _now_utc_iso()
            expires_dt = (_now_utc() + datetime.timedelta(minutes=7))
            expires = expires_dt.isoformat()
            expires_ts = int(expires_dt.replace(tzinfo=datetime.timezone.utc).timestamp())
            expires_ms = int(expires_ts * 1000)
            con.execute("UPDATE users SET balance=balance-? WHERE id=?", (rub_price, uid))
            con.execute(
                "INSERT INTO balance_tx(user_id, admin_id, delta, reason, ts) VALUES(?,?,?,?,?)",
                (uid, None, -rub_price, f"robux reserve {oid}", ts),
            )
            con.execute(
                "UPDATE robux_orders SET status=?, reserved_at=?, reserve_expires_at=?, reserve_expires_ts=?, reserved_rub=?, updated_at=? WHERE id=? AND status='new'",
                ("reserved", ts, expires, int(expires_ts), rub_price, ts, oid),
            )
            con.commit()
            return {
                "ok": True,
                "order_id": oid,
                "status": "reserved",
                "reserve_expires_at": expires,
                "reserve_expires_ms": expires_ms,
                "reserve_expires_ts": int(expires_ts),
            }
        finally:
            con.close()

    @app.post("/api/robux/order_cancel")
    def api_robux_order_cancel(request: Request, payload: dict = Body(default_factory=dict)):
        u = require_user(request)
        uid = int(u["id"])
        oid = int(payload.get("order_id") or 0)
        if not oid:
            raise HTTPException(status_code=400, detail="order_id required")

        con = db_conn()
        try:
            row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (oid, uid)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Order not found")
            status = str(_rget(row, "status") or "")
            if status != "reserved":
                raise HTTPException(status_code=400, detail="Нельзя отменить на этом этапе")

            ts = _now_utc_iso()
            con.execute(
                "UPDATE robux_orders SET status=?, cancelled_at=?, updated_at=? WHERE id=? AND status='reserved'",
                ("cancelled", ts, ts, oid),
            )
            _robux_refund_order(con, row, reason=f"robux reservation cancelled #{oid}")
            con.commit()
            return {"ok": True, "order_id": oid, "status": "cancelled"}
        finally:
            con.close()

    @app.post("/api/robux/order_pay")
    def api_robux_order_pay(request: Request, payload: dict = Body(default_factory=dict)):
        u = require_user(request)
        uid = int(u["id"])
        oid = int(payload.get("order_id") or 0)
        if not oid:
            raise HTTPException(status_code=400, detail="order_id required")

        con = db_conn()
        try:
            _robux_expire_reservations(con)

            row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (oid, uid)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Order not found")

            status = str(_rget(row, "status") or "")
            if status != "reserved":
                raise HTTPException(status_code=400, detail="Сначала нужно забронировать заказ")

            # Expiry (compare as datetimes, not strings)
            exp_ts = int(_rget(row, "reserve_expires_ts") or 0)
            if exp_ts and exp_ts < int(_now_utc().timestamp()):
                # Ensure status is cancelled + refund (idempotent)
                con.execute(
                    "UPDATE robux_orders SET status=?, cancelled_at=?, updated_at=? WHERE id=? AND status='reserved'",
                    ("cancelled", _now_utc_iso(), _now_utc_iso(), oid),
                )
                _robux_refund_order(con, row, reason=f"robux reservation expired #{oid}")
                con.commit()
                raise HTTPException(status_code=410, detail="Бронирование истекло. Деньги возвращены.")

            # Back-compat expiry check (old rows)
            if not exp_ts:
                exp = str(_rget(row, "reserve_expires_at") or "")
                try:
                    exp_dt = datetime.datetime.fromisoformat(exp) if exp else None
                except Exception:
                    exp_dt = None
                if exp_dt and exp_dt < _now_utc():
                    con.execute(
                        "UPDATE robux_orders SET status=?, cancelled_at=?, updated_at=? WHERE id=? AND status='reserved'",
                        ("cancelled", _now_utc_iso(), _now_utc_iso(), oid),
                    )
                    _robux_refund_order(con, row, reason=f"robux reservation expired #{oid}")
                    con.commit()
                    raise HTTPException(status_code=410, detail="Бронирование истекло. Деньги возвращены.")

            # Anti-fraud: re-check gamepass right before processing.
            need_price = int(_rget(row, "gamepass_price") or 0)
            gp_url = str(_rget(row, "gamepass_url") or "")
            gp_now = roblox_inspect_gamepass(gp_url)
            if int(gp_now.get("price") or 0) != need_price:
                con.execute(
                    "UPDATE robux_orders SET status=?, updated_at=?, error_message=? WHERE id=? AND status='reserved'",
                    ("failed", _now_utc_iso(), "Цена геймпасса изменилась", oid),
                )
                _robux_refund_order(con, row, reason=f"robux price changed #{oid}")
                con.commit()
                raise HTTPException(status_code=409, detail="Цена геймпасса изменилась. Заказ отменён, деньги возвращены.")
            if int(gp_now.get("product_id") or 0) != int(_rget(row, "product_id") or 0):
                con.execute(
                    "UPDATE robux_orders SET status=?, updated_at=?, error_message=? WHERE id=? AND status='reserved'",
                    ("failed", _now_utc_iso(), "ProductId изменился", oid),
                )
                _robux_refund_order(con, row, reason=f"robux product changed #{oid}")
                con.commit()
                raise HTTPException(status_code=409, detail="Геймпасс изменился. Заказ отменён, деньги возвращены.")
            if int(gp_now.get("owner_id") or 0) != int(_rget(row, "gamepass_owner_id") or 0):
                con.execute(
                    "UPDATE robux_orders SET status=?, updated_at=?, error_message=? WHERE id=? AND status='reserved'",
                    ("failed", _now_utc_iso(), "Владелец изменился", oid),
                )
                _robux_refund_order(con, row, reason=f"robux owner changed #{oid}")
                con.commit()
                raise HTTPException(status_code=409, detail="Владелец геймпасса изменился. Заказ отменён, деньги возвращены.")

            ts = _now_utc_iso()
            con.execute(
                "UPDATE robux_orders SET status=?, paid_at=?, updated_at=? WHERE id=? AND status='reserved'",
                ("processing", ts, ts, oid),
            )
            con.commit()
        finally:
            con.close()

        th = threading.Thread(target=_robux_worker_purchase, args=(oid,), daemon=True)
        th.start()
        return {"ok": True, "order_id": oid, "status": "processing"}

    @app.get("/api/robux/order")
    def api_robux_order(request: Request, id: int):
        u = require_user(request)
        uid = int(u["id"])
        con = db_conn()
        row = con.execute("SELECT * FROM robux_orders WHERE id=? AND user_id=?", (int(id), uid)).fetchone()
        con.close()
        if not row:
            raise HTTPException(status_code=404, detail="Order not found")
        exp = str(_rget(row, "reserve_expires_at") or "")
        exp_ts = int(_rget(row, "reserve_expires_ts") or 0)
        exp_ms = int(exp_ts * 1000) if exp_ts else (_iso_utc_ms(exp) if exp else None)
        return {
            "ok": True,
            "order": {
                "id": int(_rget(row, "id") or 0),
                "status": str(_rget(row, "status") or ""),
                "reserve_expires_at": exp,
                "reserve_expires_ms": exp_ms,
                "reserve_expires_ts": exp_ts or None,
                "refunded": int(_rget(row, "refunded") or 0),
                "robux_amount": int(_rget(row, "robux_amount") or 0),
                "rub_price": int(_rget(row, "rub_price") or 0),
                "gamepass_price": int(_rget(row, "gamepass_price") or 0),
                "gamepass_name": str(_rget(row, "gamepass_name") or ""),
                "gamepass_owner": str(_rget(row, "gamepass_owner") or ""),
                "error": str(_rget(row, "error_message") or ""),
            },
        }

    # ----------------------------
    # Robux admin (seller settings + order log)
    # ----------------------------

    @app.get("/api/admin/robux/settings")
    def api_admin_robux_settings(request: Request):
        require_admin(request)
        cfg = _robux_cfg_effective()
        db_cookie = (_setting_get("roblox_seller_cookie", "") or "").strip()
        has_db_cookie = bool(db_cookie)
        effective_has = bool(_seller_cookie_effective())
        return {
            "ok": True,
            "settings": {
                "cookie_in_db": has_db_cookie,
                "cookie_mask": ("••••" + db_cookie[-6:]) if has_db_cookie and len(db_cookie) >= 6 else ("••••" if has_db_cookie else ""),
                "min_amount": int(cfg.get("min_amount") or 0),
                "rub_per_robux": float(cfg.get("rub_per_robux") or 0),
                "gp_factor": float(cfg.get("gp_factor") or 0),
                # 0 = auto (from seller account)
                "stock_display": int(cfg.get("stock_display") or 0),
                "stock_sale": int(cfg.get("stock_sale") or 0),
            },
            "effective": {
                "seller_configured": effective_has,
                "env_override": bool((__import__("os").environ.get("ROBLOX_SELLER_COOKIE") or "").strip()),
            },
        }

    @app.post("/api/admin/robux/settings")
    def api_admin_robux_settings_set(request: Request, payload: dict):
        require_admin(request)
        ck = str(payload.get("cookie") or "").strip()
        if ck:
            _setting_set("roblox_seller_cookie", ck)
        if payload.get("cookie") == "":
            _setting_set("roblox_seller_cookie", "")

        def _store_num(key, val, cast):
            if val is None:
                return
            s = str(val).strip()
            if s == "":
                return
            try:
                cast(s)
            except Exception:
                raise HTTPException(status_code=400, detail=f"Некорректное значение: {key}")
            _setting_set(key, s)

        _store_num("robux_min_amount", payload.get("min_amount"), int)
        _store_num("robux_rub_per_robux", payload.get("rub_per_robux"), float)
        _store_num("robux_gp_factor", payload.get("gp_factor"), float)
        _store_num("robux_stock_display", payload.get("stock_display"), int)
        _store_num("robux_stock_sale", payload.get("stock_sale"), int)

        return {"ok": True}

    @app.get("/api/admin/robux/seller_status")
    def api_admin_robux_seller_status(request: Request):
        require_admin(request)
        cfg = _robux_cfg_effective()
        st = roblox_seller_status()
        # Compute effective available stock (taking reservations + manual sale cap into account)
        reserved_total = 0
        available_for_sale = 0
        effective_cap = int(st.get("robux") or 0) if st.get("configured") else 0
        try:
            con = db_conn()
            rr = con.execute(
                "SELECT COALESCE(SUM(gamepass_price),0) AS s FROM robux_orders WHERE status IN ('reserved','processing')",
                (),
            ).fetchone()
            con.close()
            reserved_total = int(_rget(rr, "s") or 0) if rr else 0
            sale_cap = int(cfg.get("stock_sale") or 0)
            if sale_cap > 0:
                effective_cap = min(effective_cap, sale_cap)
            available_for_sale = max(0, effective_cap - reserved_total)
        except Exception:
            pass
        display_stock = int(cfg.get("stock_display") or 0)
        if display_stock <= 0:
            display_stock = effective_cap
        return {
            "ok": True,
            "seller": st,
            "config": cfg,
            "stock": {
                "reserved": reserved_total,
                "cap": effective_cap,
                "available": available_for_sale,
                "display": display_stock,
            },
            "env_override": bool((__import__("os").environ.get("ROBLOX_SELLER_COOKIE") or "").strip()),
        }

    @app.get("/api/admin/robux/orders")
    def api_admin_robux_orders(request: Request, status: str = "active", limit: int = 50, offset: int = 0):
        require_admin(request)
        limit = max(1, min(int(limit or 50), 200))
        offset = max(0, int(offset or 0))
        st = (status or "active").lower()

        where = ""
        params = []
        if st == "active":
            where = "WHERE o.status IN ('new','paid','processing','reserved')"
        elif st == "all":
            where = ""
        else:
            where = "WHERE o.status=?"
            params.append(st)

        q = f"""
          SELECT o.*, u.username
          FROM robux_orders o
          LEFT JOIN users u ON u.id=o.user_id
          {where}
          ORDER BY o.id DESC
          LIMIT ? OFFSET ?
        """
        params.extend([limit, offset])

        con = db_conn()
        rows = con.execute(q, tuple(params)).fetchall()
        con.close()

        items = []
        for r in rows or []:
            items.append(
                {
                    "id": int(_rget(r, "id") or 0),
                    "user_id": int(_rget(r, "user_id") or 0),
                    "username": str(_rget(r, "username") or ""),
                    "robux_amount": int(_rget(r, "robux_amount") or 0),
                    "rub_price": int(_rget(r, "rub_price") or 0),
                    "gamepass_price": int(_rget(r, "gamepass_price") or 0),
                    "gamepass_owner": str(_rget(r, "gamepass_owner") or ""),
                    "gamepass_name": str(_rget(r, "gamepass_name") or ""),
                    "status": str(_rget(r, "status") or ""),
                    "error": str(_rget(r, "error_message") or ""),
                    "created_at": str(_rget(r, "created_at") or ""),
                    "updated_at": str(_rget(r, "updated_at") or ""),
                }
            )

        return {"ok": True, "items": items, "limit": limit, "offset": offset}
