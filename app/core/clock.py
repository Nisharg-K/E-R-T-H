import datetime

def get_db():
    from app.core.database import db
    return db

def get_now() -> datetime.datetime:
    try:
        db = get_db()
        settings = db["system_settings"].find_one({"key": "clock"})
        if not settings or not settings.get("use_custom_time"):
            return datetime.datetime.utcnow()
        
        custom_time_base = datetime.datetime.fromisoformat(settings["custom_time"])
        set_at_real_base = datetime.datetime.fromisoformat(settings["set_at_real_time"])
        multiplier = settings.get("multiplier", 1.0)
        
        real_elapsed = (datetime.datetime.utcnow() - set_at_real_base).total_seconds()
        mock_elapsed = real_elapsed * multiplier
        
        return custom_time_base + datetime.timedelta(seconds=mock_elapsed)
    except Exception:
        return datetime.datetime.utcnow()

def get_today_ist() -> datetime.date:
    now_utc = get_now()
    now_ist = now_utc + datetime.timedelta(hours=5, minutes=30)
    return now_ist.date()
