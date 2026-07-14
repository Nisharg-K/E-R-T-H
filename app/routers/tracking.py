import datetime
import asyncio
from typing import List
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from app.core.database import db
from app.core.auth import get_current_user_from_token, decode_token
from app.core.clock import get_now

router = APIRouter(prefix="/api/v1", tags=["Tracking & AI"])
tracking_col = db["tracking"]

def get_active_driver_ids() -> List[str]:
    # A driver is active if they are assigned to a ride group whose status is started or ongoing
    ride_groups_col = db["ride_groups"]
    active_groups = list(ride_groups_col.find({"status": {"$in": ["started", "ongoing"]}}))
    return [g["driver_id"] for g in active_groups if g.get("driver_id")]



# ─────────────────────────────────────────────
# WebSocket Connection Manager
# ─────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        # Viewers watching the map (admin, supervisor, employee, driver)
        self.watchers: List[WebSocket] = []

    async def connect_watcher(self, ws: WebSocket):
        await ws.accept()
        self.watchers.append(ws)

    def disconnect_watcher(self, ws: WebSocket):
        if ws in self.watchers:
            self.watchers.remove(ws)

    async def broadcast_location(self, payload: dict):
        """Push a location update to every connected watcher."""
        dead = []
        for ws in self.watchers:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect_watcher(ws)


manager = ConnectionManager()


def format_relative_time(dt: datetime.datetime) -> str:
    now = get_now()
    diff = now - dt
    seconds = diff.total_seconds()
    if seconds < 60:
        return "Just now"
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} min{'s' if minutes > 1 else ''} ago"
    hours = int(minutes // 60)
    if hours < 24:
        return f"{hours} hour{'s' if hours > 1 else ''} ago"
    return dt.strftime("%Y-%m-%d %H:%M")


# ─────────────────────────────────────────────
# WebSocket: Driver sends location frames
# ─────────────────────────────────────────────
@router.websocket("/ws/tracking")
async def ws_driver_tracking(websocket: WebSocket):
    """
    Driver connects here and sends JSON frames:
      { "token": "<jwt>", "latitude": 22.3, "longitude": 73.1 }
    Server saves to DB and broadcasts to all watchers.
    """
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()

            # Authenticate via token in the frame
            token = data.get("token")
            if not token:
                await websocket.send_json({"error": "No token"})
                continue
            user = decode_token(token)
            if not user or user.get("role") != "driver":
                await websocket.send_json({"error": "Unauthorized"})
                continue

            lat = data.get("latitude")
            lng = data.get("longitude")
            if lat is None or lng is None:
                continue

            # Fetch full driver record for name/cab
            from app.core.database import users_col
            driver_doc = users_col.find_one({"email": user["email"].lower()})
            driver_id = driver_doc["id"] if driver_doc else user["email"]
            
            # Check if developer spoofer is active for this driver
            settings = db["system_settings"].find_one({"key": "spoofer"})
            mocked_drivers = settings.get("mocked_drivers", []) if settings else []
            if driver_id in mocked_drivers:
                await websocket.send_json({"status": "ignored_due_to_spoofer"})
                continue

            # Restrict to active drivers only
            active_drivers = get_active_driver_ids()
            if driver_id not in active_drivers:
                await websocket.send_json({"error": "inactive_ride"})
                continue

            driver_name = driver_doc.get("full_name", "Driver") if driver_doc else "Driver"
            cab_number = (driver_doc.get("license_number") or "Cab") if driver_doc else "Cab"

            now = get_now()
            tracking_doc = {
                "driver_id": driver_id,
                "driver_name": driver_name,
                "cab_number": cab_number,
                "latitude": lat,
                "longitude": lng,
                "updated_at": now
            }
            tracking_col.update_one(
                {"driver_id": driver_id},
                {"$set": tracking_doc},
                upsert=True
            )

            # Build the broadcast payload matching the HTTP format
            push = {
                "driver_id": driver_id,
                "driver_name": driver_name,
                "cab_number": cab_number,
                "latitude": lat,
                "longitude": lng,
                "recorded_at": "Just now"
            }
            await manager.broadcast_location(push)
            await websocket.send_json({"status": "ok"})

    except WebSocketDisconnect:
        pass


# ─────────────────────────────────────────────
# WebSocket: Viewers receive live location pushes
# ─────────────────────────────────────────────
@router.websocket("/ws/tracking/watch")
async def ws_tracking_watch(websocket: WebSocket):
    """
    Map viewers connect here. On connect, they receive the full current
    active snapshot, then receive pushed updates as drivers move.
    """
    await manager.connect_watcher(websocket)
    try:
        # Send the current snapshot immediately on connect (only active cabs)
        cutoff = get_now() - datetime.timedelta(minutes=15)
        active_drivers = get_active_driver_ids()
        active = list(tracking_col.find({
            "driver_id": {"$in": active_drivers},
            "updated_at": {"$gte": cutoff}
        }))
        snapshot = [
            {
                "driver_id": loc["driver_id"],
                "driver_name": loc["driver_name"],
                "cab_number": loc["cab_number"],
                "latitude": loc["latitude"],
                "longitude": loc["longitude"],
                "recorded_at": format_relative_time(loc["updated_at"])
            }
            for loc in active
        ]
        await websocket.send_json({"type": "snapshot", "data": snapshot})

        # Keep connection alive, waiting for close
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                # Send a keepalive ping
                await websocket.send_json({"type": "ping"})

    except WebSocketDisconnect:
        manager.disconnect_watcher(websocket)
    except Exception:
        manager.disconnect_watcher(websocket)


# ─────────────────────────────────────────────
# HTTP fallback endpoints (kept for compatibility)
# ─────────────────────────────────────────────
class LocationUpdate(BaseModel):
    latitude: float
    longitude: float


@router.post("/tracking/update")
def update_location(payload: LocationUpdate, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "driver":
        raise HTTPException(status_code=403, detail="Only drivers can update location")
    
    # Check if developer spoofer is active for this driver
    settings = db["system_settings"].find_one({"key": "spoofer"})
    mocked_drivers = settings.get("mocked_drivers", []) if settings else []
    if current_user["id"] in mocked_drivers:
        return {"status": "ignored_due_to_spoofer"}

    active_drivers = get_active_driver_ids()
    if current_user["id"] not in active_drivers:
        raise HTTPException(status_code=403, detail="Location updates are only allowed during active rides")

    cab_number = current_user.get("license_number") or "Cab"
    tracking_doc = {
        "driver_id": current_user["id"],
        "driver_name": current_user["full_name"],
        "cab_number": cab_number,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "updated_at": get_now()
    }
    tracking_col.update_one(
        {"driver_id": current_user["id"]},
        {"$set": tracking_doc},
        upsert=True
    )
    return {"status": "success"}


@router.get("/tracking/active")
def get_active_tracking(current_user: dict = Depends(get_current_user_from_token)):
    cutoff = get_now() - datetime.timedelta(minutes=15)
    active_drivers = get_active_driver_ids()
    active_locations = list(tracking_col.find({
        "driver_id": {"$in": active_drivers},
        "updated_at": {"$gte": cutoff}
    }))
    if not active_locations:
        return []
    return [
        {
            "driver_id": loc["driver_id"],
            "driver_name": loc["driver_name"],
            "cab_number": loc["cab_number"],
            "latitude": loc["latitude"],
            "longitude": loc["longitude"],
            "recorded_at": format_relative_time(loc["updated_at"])
        }
        for loc in active_locations
    ]


@router.post("/ai-chat")
def ai_chat(payload: dict, current_user: dict = Depends(get_current_user_from_token)):
    return {"answer": "AI Chat integration will be set up in a future module. Stay tuned!"}