import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.core.auth import get_current_user_from_token
from app.core.database import db
from app.core.clock import get_now, get_today_ist
from app.routers.scheduler import spawn_recurring_rides

router = APIRouter(prefix="/api/v1/developer", tags=["Developer clock Control"])

class ClockSettingsUpdate(BaseModel):
    use_custom_time: bool
    custom_time: str # Format: YYYY-MM-DDTHH:MM:SS or YYYY-MM-DDTHH:MM
    multiplier: float

@router.get("/clock")
def get_clock_status(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "developer":
        raise HTTPException(status_code=403, detail="Developer access required")
        
    settings = db["system_settings"].find_one({"key": "clock"})
    if not settings:
        settings = {
            "key": "clock",
            "use_custom_time": False,
            "custom_time": datetime.datetime.utcnow().isoformat(),
            "set_at_real_time": datetime.datetime.utcnow().isoformat(),
            "multiplier": 1.0
        }
        db["system_settings"].insert_one(settings)
        
    # Calculate current virtual time
    virtual_now = get_now()
    virtual_today_ist = get_today_ist()
    
    return {
        "use_custom_time": settings.get("use_custom_time", False),
        "custom_time": settings.get("custom_time"),
        "set_at_real_time": settings.get("set_at_real_time"),
        "multiplier": settings.get("multiplier", 1.0),
        "virtual_now": virtual_now.isoformat(),
        "virtual_today_ist": virtual_today_ist.isoformat(),
        "real_now": datetime.datetime.utcnow().isoformat()
    }

@router.put("/clock")
def update_clock_settings(payload: ClockSettingsUpdate, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "developer":
        raise HTTPException(status_code=403, detail="Developer access required")
        
    # Parse format to validate
    try:
        # Support both HH:MM and HH:MM:SS formats
        val = payload.custom_time
        if len(val) == 16: # YYYY-MM-DDTHH:MM
            val += ":00"
        datetime.datetime.fromisoformat(val)
    except ValueError:
        raise HTTPException(status_code=400, detail="custom_time must be in ISO YYYY-MM-DDTHH:MM:SS format")
        
    settings = {
        "key": "clock",
        "use_custom_time": payload.use_custom_time,
        "custom_time": val,
        "set_at_real_time": datetime.datetime.utcnow().isoformat(),
        "multiplier": payload.multiplier
    }
    
    db["system_settings"].update_one(
        {"key": "clock"},
        {"$set": settings},
        upsert=True
    )
    
    return {
        "status": "success",
        "virtual_now": get_now().isoformat()
    }

@router.post("/trigger-scheduler")
def trigger_scheduler_manually(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "developer":
        raise HTTPException(status_code=403, detail="Developer access required")
        
    # Force run the background scheduler spawning logic for current virtual time
    spawn_recurring_rides()
    return {"status": "success", "message": "Scheduler trigger completed for virtual time: " + get_now().isoformat()}

class MockLocationPayload(BaseModel):
    driver_id: str
    latitude: float
    longitude: float

@router.post("/mock-location")
async def update_mock_location(payload: MockLocationPayload, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "developer":
        raise HTTPException(status_code=403, detail="Developer access required")
    
    from app.core.database import users_col
    driver = users_col.find_one({"id": payload.driver_id, "role": "driver"})
    if not driver:
        raise HTTPException(status_code=400, detail="Driver not found")
    
    cab_number = driver.get("license_number") or "Cab"
    
    tracking_doc = {
        "driver_id": payload.driver_id,
        "driver_name": driver.get("full_name", "Driver"),
        "cab_number": cab_number,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "updated_at": get_now()
    }
    
    db["tracking"].update_one(
        {"driver_id": payload.driver_id},
        {"$set": tracking_doc},
        upsert=True
    )
    
    # Broadcast via WebSocket manager so all viewers see the cab move in real-time!
    from app.routers.tracking import manager
    push = {
        "driver_id": payload.driver_id,
        "driver_name": driver.get("full_name", "Driver"),
        "cab_number": cab_number,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "recorded_at": "Just now"
    }
    await manager.broadcast_location(push)
    return {"status": "success", "lat": payload.latitude, "lng": payload.longitude}

@router.get("/drivers")
def get_all_drivers(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "developer":
        raise HTTPException(status_code=403, detail="Developer access required")
    from app.core.database import users_col
    drivers = list(users_col.find({"role": "driver", "status": "approved"}))
    return [{"id": d["id"], "full_name": d["full_name"], "license_number": d.get("license_number")} for d in drivers]

class SpooferTogglePayload(BaseModel):
    driver_id: str
    enabled: bool

@router.put("/spoofer/toggle")
def toggle_driver_spoof(payload: SpooferTogglePayload, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "developer":
        raise HTTPException(status_code=403, detail="Developer access required")
        
    settings = db["system_settings"].find_one({"key": "spoofer"})
    if not settings:
        settings = {"key": "spoofer", "mocked_drivers": []}
        db["system_settings"].insert_one(settings)
        
    mocked = list(settings.get("mocked_drivers", []))
    if payload.enabled:
        if payload.driver_id not in mocked:
            mocked.append(payload.driver_id)
    else:
        if payload.driver_id in mocked:
            mocked.remove(payload.driver_id)
            
    db["system_settings"].update_one(
        {"key": "spoofer"},
        {"$set": {"mocked_drivers": mocked}},
        upsert=True
    )
    return {"status": "success", "mocked_drivers": mocked}

@router.get("/spoofer/status")
def get_spoofer_status(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "developer":
        raise HTTPException(status_code=403, detail="Developer access required")
        
    settings = db["system_settings"].find_one({"key": "spoofer"})
    mocked = settings.get("mocked_drivers", []) if settings else []
    return {"mocked_drivers": mocked}
