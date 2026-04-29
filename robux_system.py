"""
Robux Shop System - Additional API endpoints and functions
Этот файл содержит дополнительные функции для системы покупки Robux
"""

import os
import re
import time
import json
import math
import random
import hashlib
import datetime
import threading
from typing import Any, Dict, List, Tuple, Optional
from fastapi import HTTPException, Request, Body

# Global cache for gamepass creation
_GAMEPASS_CREATION_CACHE: Dict[str, Any] = {}
_ROBUX_STOCK_LOCK = threading.Lock()


def init_robux_stock_table(db_conn, USE_PG: bool):
    """Initialize robux_stock table for tracking available Robux"""
    con = db_conn()
    try:
        if USE_PG:
            con.execute("""
                CREATE TABLE IF NOT EXISTS robux_stock (
                    id SERIAL PRIMARY KEY,
                    total_robux INTEGER NOT NULL DEFAULT 0,
                    available_robux INTEGER NOT NULL DEFAULT 0,
                    reserved_robux INTEGER NOT NULL DEFAULT 0,
                    sold_robux INTEGER NOT NULL DEFAULT 0,
                    min_amount INTEGER NOT NULL DEFAULT 50,
                    max_amount INTEGER NOT NULL DEFAULT 100000,
                    rub_per_robux REAL NOT NULL DEFAULT 0.5,
                    gp_factor REAL NOT NULL DEFAULT 1.43,
                    seller_cookie_enc TEXT,
                    seller_user_id BIGINT,
                    seller_username TEXT,
                    last_updated TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            # Insert default row if not exists
            con.execute("""
                INSERT INTO robux_stock (id, total_robux, available_robux, last_updated, updated_at)
                VALUES (1, 0, 0, NOW(), NOW())
                ON CONFLICT (id) DO NOTHING
            """)
        else:
            con.execute("""
                CREATE TABLE IF NOT EXISTS robux_stock (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    total_robux INTEGER NOT NULL DEFAULT 0,
                    available_robux INTEGER NOT NULL DEFAULT 0,
                    reserved_robux INTEGER NOT NULL DEFAULT 0,
                    sold_robux INTEGER NOT NULL DEFAULT 0,
                    min_amount INTEGER NOT NULL DEFAULT 50,
                    max_amount INTEGER NOT NULL DEFAULT 100000,
                    rub_per_robux REAL NOT NULL DEFAULT 0.5,
                    gp_factor REAL NOT NULL DEFAULT 1.43,
                    seller_cookie_enc TEXT,
                    seller_user_id BIGINT,
                    seller_username TEXT,
                    last_updated TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            # Insert default row if not exists
            con.execute("""
                INSERT OR IGNORE INTO robux_stock 
                (id, total_robux, available_robux, last_updated, updated_at)
                VALUES (1, 0, 0, datetime('now'), datetime('now'))
            """)
        con.commit()
    finally:
        con.close()


def init_robux_fraud_protection(db_conn, USE_PG: bool):
    """Initialize tables for fraud protection"""
    con = db_conn()
    try:
        if USE_PG:
            con.execute("""
                CREATE TABLE IF NOT EXISTS robux_fraud_log (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    ip_address TEXT,
                    user_agent TEXT,
                    details TEXT,
                    created_at TEXT NOT NULL
                )
            """)
            con.execute("""
                CREATE TABLE IF NOT EXISTS robux_rate_limits (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    window_start TEXT NOT NULL,
                    UNIQUE(user_id, action, window_start)
                )
            """)
        else:
            con.execute("""
                CREATE TABLE IF NOT EXISTS robux_fraud_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    ip_address TEXT,
                    user_agent TEXT,
                    details TEXT,
                    created_at TEXT NOT NULL
                )
            """)
            con.execute("""
                CREATE TABLE IF NOT EXISTS robux_rate_limits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    window_start TEXT NOT NULL,
                    UNIQUE(user_id, action, window_start)
                )
            """)
        con.commit()
    finally:
        con.close()


def get_robux_stock(db_conn, _rget) -> Dict[str, Any]:
    """Get current Robux stock status"""
    con = db_conn()
    try:
        row = con.execute("SELECT * FROM robux_stock WHERE id=1").fetchone()
        if not row:
            return {
                "total_robux": 0,
                "available_robux": 0,
                "reserved_robux": 0,
                "sold_robux": 0,
                "min_amount": 50,
                "max_amount": 100000,
                "rub_per_robux": 0.5,
                "gp_factor": 1.43,
                "seller_configured": False
            }
        return {
            "total_robux": int(_rget(row, "total_robux") or 0),
            "available_robux": int(_rget(row, "available_robux") or 0),
            "reserved_robux": int(_rget(row, "reserved_robux") or 0),
            "sold_robux": int(_rget(row, "sold_robux") or 0),
            "min_amount": int(_rget(row, "min_amount") or 50),
            "max_amount": int(_rget(row, "max_amount") or 100000),
            "rub_per_robux": float(_rget(row, "rub_per_robux") or 0.5),
            "gp_factor": float(_rget(row, "gp_factor") or 1.43),
            "seller_configured": bool(_rget(row, "seller_cookie_enc")),
            "seller_username": str(_rget(row, "seller_username") or ""),
        }
    finally:
        con.close()


def update_robux_stock(db_conn, _rget, _now_utc_iso, 
                       total_robux: int = None,
                       reserved_delta: int = 0,
                       sold_delta: int = 0,
                       settings: Dict = None) -> Dict[str, Any]:
    """Update Robux stock with thread safety"""
    with _ROBUX_STOCK_LOCK:
        con = db_conn()
        try:
            row = con.execute("SELECT * FROM robux_stock WHERE id=1").fetchone()
            if not row:
                # Create default row
                if settings:
                    con.execute("""
                        INSERT INTO robux_stock 
                        (id, total_robux, available_robux, reserved_robux, sold_robux,
                         min_amount, max_amount, rub_per_robux, gp_factor, last_updated, updated_at)
                        VALUES (1, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)
                    """, (
                        settings.get("min_amount", 50),
                        settings.get("max_amount", 100000),
                        settings.get("rub_per_robux", 0.5),
                        settings.get("gp_factor", 1.43),
                        _now_utc_iso(), _now_utc_iso()
                    ))
                else:
                    con.execute("""
                        INSERT INTO robux_stock 
                        (id, total_robux, available_robux, reserved_robux, sold_robux, last_updated, updated_at)
                        VALUES (1, 0, 0, 0, 0, ?, ?)
                    """, (_now_utc_iso(), _now_utc_iso()))
                con.commit()
                row = con.execute("SELECT * FROM robux_stock WHERE id=1").fetchone()
            
            current_total = int(_rget(row, "total_robux") or 0)
            current_reserved = int(_rget(row, "reserved_robux") or 0)
            current_sold = int(_rget(row, "sold_robux") or 0)
            gp_factor = float(_rget(row, "gp_factor") or 1.43)
            
            # Calculate available based on total with commission
            if total_robux is not None:
                current_total = total_robux
            
            # Available = total / gp_factor - reserved
            available = max(0, int(current_total / gp_factor) - current_reserved - reserved_delta)
            
            new_reserved = current_reserved + reserved_delta
            new_sold = current_sold + sold_delta
            
            con.execute("""
                UPDATE robux_stock SET
                    total_robux = ?,
                    available_robux = ?,
                    reserved_robux = ?,
                    sold_robux = ?,
                    last_updated = ?,
                    updated_at = ?
                WHERE id = 1
            """, (current_total, available, new_reserved, new_sold, 
                  _now_utc_iso(), _now_utc_iso()))
            con.commit()
            
            return {
                "total_robux": current_total,
                "available_robux": available,
                "reserved_robux": new_reserved,
                "sold_robux": new_sold
            }
        finally:
            con.close()


def check_fraud_protection(db_conn, _rget, _now_utc_iso, 
                          user_id: int, action: str, 
                          ip_address: str = None,
                          user_agent: str = None,
                          limits: Dict = None) -> Tuple[bool, str]:
    """
    Check if user action is allowed based on fraud protection rules
    Returns (allowed: bool, message: str)
    """
    if limits is None:
        limits = {
            "max_orders_per_minute": 5,
            "max_orders_per_hour": 20,
            "max_amount_per_day": 50000,
        }
    
    con = db_conn()
    try:
        now = datetime.datetime.utcnow()
        minute_start = now.replace(second=0, microsecond=0).isoformat()
        hour_start = now.replace(minute=0, second=0, microsecond=0).isoformat()
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        
        # Check per-minute limit
        row = con.execute("""
            SELECT count FROM robux_rate_limits 
            WHERE user_id=? AND action=? AND window_start=?
        """, (user_id, f"{action}_min", minute_start)).fetchone()
        
        minute_count = int(_rget(row, "count") or 0) if row else 0
        if minute_count >= limits.get("max_orders_per_minute", 5):
            return False, "Превышен лимит операций в минуту. Попробуйте позже."
        
        # Check per-hour limit
        row = con.execute("""
            SELECT count FROM robux_rate_limits 
            WHERE user_id=? AND action=? AND window_start=?
        """, (user_id, f"{action}_hour", hour_start)).fetchone()
        
        hour_count = int(_rget(row, "count") or 0) if row else 0
        if hour_count >= limits.get("max_orders_per_hour", 20):
            return False, "Превышен лимит операций в час. Попробуйте позже."
        
        return True, "OK"
    finally:
        con.close()


def log_fraud_attempt(db_conn, _now_utc_iso, user_id: int, action: str,
                     ip_address: str = None, user_agent: str = None,
                     details: str = None):
    """Log potential fraud attempt"""
    con = db_conn()
    try:
        con.execute("""
            INSERT INTO robux_fraud_log (user_id, action, ip_address, user_agent, details, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (user_id, action, ip_address, user_agent, details, _now_utc_iso()))
        con.commit()
    finally:
        con.close()


def increment_rate_limit(db_conn, _rget, _now_utc_iso, user_id: int, action: str):
    """Increment rate limit counter"""
    con = db_conn()
    try:
        now = datetime.datetime.utcnow()
        minute_start = now.replace(second=0, microsecond=0).isoformat()
        hour_start = now.replace(minute=0, second=0, microsecond=0).isoformat()
        
        for window, window_start in [(f"{action}_min", minute_start), (f"{action}_hour", hour_start)]:
            con.execute("""
                INSERT INTO robux_rate_limits (user_id, action, count, window_start)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(user_id, action, window_start) DO UPDATE SET count = count + 1
            """ if USE_PG else """
                INSERT OR REPLACE INTO robux_rate_limits (user_id, action, count, window_start)
                VALUES (?, ?, 
                    COALESCE((SELECT count + 1 FROM robux_rate_limits 
                              WHERE user_id=? AND action=? AND window_start=?), 1),
                    ?)
            """, (user_id, window, window_start) if USE_PG else 
                 (user_id, window, user_id, window, window_start, window_start))
        con.commit()
    finally:
        con.close()


# Import these from app.py when actually using
USE_PG = None
db_conn = None
_rget = None
_now_utc_iso = None
_cookie_encrypt = None
_cookie_decrypt = None
_setting_get = None
_setting_set = None


def init_robux_system(imported_use_pg, imported_db_conn, imported_rget, 
                     imported_now_utc_iso, imported_cookie_encrypt, 
                     imported_cookie_decrypt, imported_setting_get, 
                     imported_setting_set):
    """Initialize the robux system with imported functions"""
    global USE_PG, db_conn, _rget, _now_utc_iso, _cookie_encrypt, _cookie_decrypt, _setting_get, _setting_set
    USE_PG = imported_use_pg
    db_conn = imported_db_conn
    _rget = imported_rget
    _now_utc_iso = imported_now_utc_iso
    _cookie_encrypt = imported_cookie_encrypt
    _cookie_decrypt = imported_cookie_decrypt
    _setting_get = imported_setting_get
    _setting_set = imported_setting_set
    
    # Initialize tables
    init_robux_stock_table(db_conn, USE_PG)
    init_robux_fraud_protection(db_conn, USE_PG)


# API Endpoints that will be registered
def register_robux_api_endpoints(app):
    """Register all Robux API endpoints"""
    
    @app.get("/api/robux/public_config")
    def api_robux_public_config():
        """Get public Robux configuration for the shop page"""
        stock = get_robux_stock(db_conn, _rget)
        return {
            "ok": True,
            "available": stock["available_robux"] > 0,
            "available_robux": stock["available_robux"],
            "min_amount": stock["min_amount"],
            "max_amount": stock["max_amount"],
            "rub_per_robux": stock["rub_per_robux"],
            "gp_factor": stock["gp_factor"],
            "rate": f"{stock['rub_per_robux']:.2f}"
        }
    
    @app.get("/api/admin/robux/full_settings")
    def api_admin_robux_full_settings(request: Request):
        """Get full Robux settings for admin panel"""
        # Import here to avoid circular import
        from app import require_admin, roblox_seller_status, roblox_cookie_status
        
        require_admin(request)
        stock = get_robux_stock(db_conn, _rget)
        
        # Get seller status if cookie exists
        seller_status = {"configured": False}
        if stock.get("seller_configured"):
            # Try to get from main seller cookie
            cookie = _cookie_decrypt(stock.get("seller_cookie_enc", ""))
            if cookie:
                seller_status = roblox_cookie_status(cookie)
        
        return {
            "ok": True,
            "settings": {
                "min_amount": stock["min_amount"],
                "max_amount": stock["max_amount"],
                "rub_per_robux": stock["rub_per_robux"],
                "gp_factor": stock["gp_factor"],
                "seller_configured": stock["seller_configured"],
                "seller_username": stock["seller_username"],
            },
            "stock": {
                "total_robux": stock["total_robux"],
                "available_robux": stock["available_robux"],
                "reserved_robux": stock["reserved_robux"],
                "sold_robux": stock["sold_robux"],
            },
            "seller": seller_status
        }
    
    @app.post("/api/admin/robux/full_settings")
    def api_admin_robux_full_settings_set(request: Request, payload: Dict[str, Any] = Body(...)):
        """Save full Robux settings from admin panel"""
        from app import require_admin, roblox_cookie_status
        
        require_admin(request)
        
        # Validate and update seller cookie if provided
        seller_cookie = payload.get("seller_cookie", "").strip()
        seller_info = None
        
        if seller_cookie:
            # Validate cookie
            status = roblox_cookie_status(seller_cookie)
            if not status.get("ok"):
                raise HTTPException(status_code=400, detail=f"Invalid seller cookie: {status.get('error')}")
            seller_info = status
        
        # Update settings
        settings = {
            "min_amount": int(payload.get("min_amount", 50)),
            "max_amount": int(payload.get("max_amount", 100000)),
            "rub_per_robux": float(payload.get("rub_per_robux", 0.5)),
            "gp_factor": float(payload.get("gp_factor", 1.43)),
        }
        
        con = db_conn()
        try:
            if seller_info:
                con.execute("""
                    UPDATE robux_stock SET
                        seller_cookie_enc = ?,
                        seller_user_id = ?,
                        seller_username = ?,
                        min_amount = ?,
                        max_amount = ?,
                        rub_per_robux = ?,
                        gp_factor = ?,
                        total_robux = ?,
                        available_robux = ?,
                        updated_at = ?
                    WHERE id = 1
                """ if not USE_PG else """
                    UPDATE robux_stock SET
                        seller_cookie_enc = %s,
                        seller_user_id = %s,
                        seller_username = %s,
                        min_amount = %s,
                        max_amount = %s,
                        rub_per_robux = %s,
                        gp_factor = %s,
                        total_robux = %s,
                        available_robux = %s,
                        updated_at = %s
                    WHERE id = 1
                """, (
                    _cookie_encrypt(seller_cookie),
                    seller_info.get("user_id"),
                    seller_info.get("username"),
                    settings["min_amount"],
                    settings["max_amount"],
                    settings["rub_per_robux"],
                    settings["gp_factor"],
                    seller_info.get("robux", 0),
                    int(seller_info.get("robux", 0) / settings["gp_factor"]),
                    _now_utc_iso()
                ))
            else:
                con.execute("""
                    UPDATE robux_stock SET
                        min_amount = ?,
                        max_amount = ?,
                        rub_per_robux = ?,
                        gp_factor = ?,
                        updated_at = ?
                    WHERE id = 1
                """ if not USE_PG else """
                    UPDATE robux_stock SET
                        min_amount = %s,
                        max_amount = %s,
                        rub_per_robux = %s,
                        gp_factor = %s,
                        updated_at = %s
                    WHERE id = 1
                """, (
                    settings["min_amount"],
                    settings["max_amount"],
                    settings["rub_per_robux"],
                    settings["gp_factor"],
                    _now_utc_iso()
                ))
            con.commit()
        finally:
            con.close()
        
        return {"ok": True, "message": "Settings saved"}
    
    @app.post("/api/admin/robux/refresh_stock")
    def api_admin_robux_refresh_stock(request: Request):
        """Refresh Robux stock from seller account"""
        from app import require_admin, roblox_cookie_status
        
        require_admin(request)
        
        stock = get_robux_stock(db_conn, _rget)
        if not stock.get("seller_configured"):
            raise HTTPException(status_code=400, detail="Seller cookie not configured")
        
        # Get cookie and check status
        con = db_conn()
        try:
            row = con.execute("SELECT seller_cookie_enc FROM robux_stock WHERE id=1").fetchone()
            cookie = _cookie_decrypt(_rget(row, "seller_cookie_enc") or "") if row else ""
        finally:
            con.close()
        
        if not cookie:
            raise HTTPException(status_code=400, detail="Seller cookie not found")
        
        status = roblox_cookie_status(cookie)
        if not status.get("ok"):
            raise HTTPException(status_code=400, detail=f"Failed to check seller: {status.get('error')}")
        
        # Update stock
        total_robux = status.get("robux", 0)
        available = int(total_robux / stock["gp_factor"])
        
        con = db_conn()
        try:
            con.execute("""
                UPDATE robux_stock SET
                    total_robux = ?,
                    available_robux = ?,
                    seller_user_id = ?,
                    seller_username = ?,
                    updated_at = ?
                WHERE id = 1
            """ if not USE_PG else """
                UPDATE robux_stock SET
                    total_robux = %s,
                    available_robux = %s,
                    seller_user_id = %s,
                    seller_username = %s,
                    updated_at = %s
                WHERE id = 1
            """, (total_robux, available, status.get("user_id"), 
                  status.get("username"), _now_utc_iso()))
            con.commit()
        finally:
            con.close()
        
        return {
            "ok": True,
            "total_robux": total_robux,
            "available_robux": available,
            "seller_username": status.get("username")
        }


# Function to auto-create gamepass (requires user cookie)
def create_gamepass_for_user(cookie: str, name: str, description: str, price: int) -> Dict[str, Any]:
    """
    Automatically create a gamepass for a user
    This is a complex operation that requires the user's cookie
    Returns: {ok: bool, gamepass_id: int, gamepass_url: str, error: str}
    """
    import requests
    
    try:
        # Step 1: Get user info
        auth_resp = requests.get(
            "https://users.roblox.com/v1/users/authenticated",
            cookies={".ROBLOSECURITY": cookie},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=30
        )
        
        if not auth_resp.ok:
            return {"ok": False, "error": "Invalid cookie or authentication failed"}
        
        user_data = auth_resp.json()
        user_id = user_data.get("id")
        
        # Step 2: Find or create a universe (game)
        # First, try to get existing universes
        uni_resp = requests.get(
            f"https://develop.roblox.com/v1/universes?filter=public",
            cookies={".ROBLOSECURITY": cookie},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=30
        )
        
        universe_id = None
        if uni_resp.ok:
            uni_data = uni_resp.json()
            universes = uni_data.get("data", [])
            if universes:
                universe_id = universes[0].get("id")
        
        # If no universe, we can't create gamepass (would need to create game first)
        if not universe_id:
            return {
                "ok": False, 
                "error": "No games found. Please create a game first at https://create.roblox.com"
            }
        
        # Step 3: Create gamepass
        # This requires multiple steps with Roblox API
        # Note: This is a simplified version - actual implementation would need
        # to handle CSRF tokens and more complex flow
        
        return {
            "ok": False,
            "error": "Gamepass auto-creation requires manual steps. Please create at https://create.roblox.com/dashboard/creations/experiences/{}/monetization/game-passes".format(universe_id),
            "manual_url": "https://create.roblox.com/dashboard/creations"
        }
        
    except Exception as e:
        return {"ok": False, "error": str(e)}


# Purchase flow helper
def process_robux_purchase(
    db_conn, _rget, _now_utc_iso,
    user_id: int, 
    amount: int, 
    gamepass_url: str,
    mode: str = "normal",  # "normal" or "auto"
    user_cookie: str = None
) -> Dict[str, Any]:
    """
    Process a Robux purchase with anti-fraud checks
    Returns: {ok: bool, order_id: int, status: str, message: str}
    """
    # Check stock availability
    stock = get_robux_stock(db_conn, _rget)
    
    if stock["available_robux"] < amount:
        return {
            "ok": False,
            "error": f"Недостаточно Robux в наличии. Доступно: {stock['available_robux']} R$"
        }
    
    # Check min/max limits
    if amount < stock["min_amount"]:
        return {"ok": False, "error": f"Минимальная сумма покупки: {stock['min_amount']} R$"}
    
    if amount > stock["max_amount"]:
        return {"ok": False, "error": f"Максимальная сумма покупки: {stock['max_amount']} R$"}
    
    # Fraud check
    allowed, message = check_fraud_protection(
        db_conn, _rget, _now_utc_iso,
        user_id, "purchase"
    )
    
    if not allowed:
        log_fraud_attempt(db_conn, _now_utc_iso, user_id, "purchase_blocked", 
                         details=message)
        return {"ok": False, "error": message}
    
    # Reserve stock
    update_robux_stock(db_conn, _rget, _now_utc_iso, reserved_delta=amount)
    
    # Increment rate limit
    increment_rate_limit(db_conn, _rget, _now_utc_iso, user_id, "purchase")
    
    return {
        "ok": True,
        "message": "Purchase can proceed",
        "reserved": True,
        "amount": amount
    }


def release_robux_reservation(db_conn, _rget, _now_utc_iso, amount: int):
    """Release reserved Robux when order is cancelled/failed"""
    update_robux_stock(db_conn, _rget, _now_utc_iso, reserved_delta=-amount)


def confirm_robux_sale(db_conn, _rget, _now_utc_iso, amount: int):
    """Confirm Robux sale - move from reserved to sold"""
    update_robux_stock(
        db_conn, _rget, _now_utc_iso, 
        reserved_delta=-amount, 
        sold_delta=amount
    )
