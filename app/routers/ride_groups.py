import uuid
import math
import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from app.core.database import users_col, ride_groups_col, clean_user
from app.core.auth import get_current_user_from_token

router = APIRouter(prefix="/api/v1/ride-groups", tags=["Ride Groups"])

# --- Schemas ---
class OrderItem(BaseModel):
    user_id: str
    order: int

class RideGroupCreate(BaseModel):
    name: str
    driver_id: str
    passenger_ids: List[str]
    pickup_order: List[OrderItem]
    drop_order: List[OrderItem]
    status: Optional[str] = "draft"
    delay_minutes: Optional[int] = 0
    total_cost: Optional[float] = 150.0
    is_recurring: Optional[bool] = False
    recurrence_days: Optional[List[str]] = []   # e.g. ["mon","tue","wed","thu","fri"]
    departure_time: Optional[str] = ""           # e.g. "08:30"

class RideGroupUpdate(BaseModel):
    name: Optional[str] = None
    driver_id: Optional[str] = None
    passenger_ids: Optional[List[str]] = None
    pickup_order: Optional[List[OrderItem]] = None
    drop_order: Optional[List[OrderItem]] = None
    status: Optional[str] = None
    delay_minutes: Optional[int] = None
    total_cost: Optional[float] = None
    is_recurring: Optional[bool] = None
    recurrence_days: Optional[List[str]] = None
    departure_time: Optional[str] = None

# --- Helper functions to resolve driver and passenger details ---
def resolve_group_details(group: dict) -> dict:
    resolved = dict(group)
    resolved.pop("_id", None)
    
    # Resolve driver
    driver = users_col.find_one({"id": group["driver_id"]})
    if driver:
        resolved["driver_name"] = driver.get("full_name", "Unknown Driver")
        resolved["cab_number"] = driver.get("license_number") or "Cab"
    else:
        resolved["driver_name"] = "Unassigned"
        resolved["cab_number"] = "N/A"
        
    # Resolve passengers list
    resolved_passengers = []
    for pid in group.get("passenger_ids", []):
        passenger = users_col.find_one({"id": pid})
        if passenger:
            resolved_passengers.append({
                "id": passenger["id"],
                "full_name": passenger["full_name"],
                "email": passenger["email"],
                "mobile_number": passenger.get("mobile_number"),
                "pickup_point": passenger.get("pickup_point")
            })
    resolved["passengers"] = resolved_passengers
    return resolved

# --- Endpoints ---

@router.get("/employees")
def get_approved_employees(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] not in ("supervisor", "admin"):
        raise HTTPException(status_code=403, detail="Not authorized")
    employees = list(users_col.find({"role": "employee", "status": "approved"}))
    return [clean_user(e) for e in employees]

@router.get("/drivers")
def get_approved_drivers(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] not in ("supervisor", "admin"):
        raise HTTPException(status_code=403, detail="Not authorized")
    drivers = list(users_col.find({"role": "driver", "status": "approved"}))
    return [clean_user(d) for d in drivers]

@router.get("")
def list_ride_groups(
    current_user: dict = Depends(get_current_user_from_token),
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100)
):
    if current_user["role"] not in ("supervisor", "admin"):
        raise HTTPException(status_code=403, detail="Not authorized")
    total = ride_groups_col.count_documents({})
    skip = (page - 1) * limit
    groups = list(ride_groups_col.find({}).sort("created_at", -1).skip(skip).limit(limit))
    return {
        "items": [resolve_group_details(g) for g in groups],
        "total": total,
        "page": page,
        "pages": math.ceil(total / limit) if total > 0 else 1
    }

@router.get("/my")
def get_my_ride_group(current_user: dict = Depends(get_current_user_from_token)):
    # Find group where current user is driver or passenger
    uid = current_user["id"]
    if current_user["role"] == "driver":
        group = ride_groups_col.find_one({"driver_id": uid})
    else:
        group = ride_groups_col.find_one({"passenger_ids": uid})
        
    if not group:
        return None
    return resolve_group_details(group)

@router.post("")
def create_ride_group(payload: RideGroupCreate, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] not in ("supervisor", "admin"):
        raise HTTPException(status_code=403, detail="Only supervisor or admin can create ride groups")
        
    # Check driver exists
    driver = users_col.find_one({"id": payload.driver_id, "role": "driver"})
    if not driver:
        raise HTTPException(status_code=400, detail="Driver does not exist")
        
    group_id = str(uuid.uuid4())
    group_doc = {
        "id": group_id,
        "name": payload.name,
        "driver_id": payload.driver_id,
        "passenger_ids": payload.passenger_ids,
        "pickup_order": [item.dict() for item in payload.pickup_order],
        "drop_order": [item.dict() for item in payload.drop_order],
        "status": payload.status or "draft",
        "delay_minutes": payload.delay_minutes if payload.delay_minutes is not None else 0,
        "total_cost": payload.total_cost if payload.total_cost is not None else 150.0,
        "is_recurring": payload.is_recurring or False,
        "recurrence_days": payload.recurrence_days or [],
        "departure_time": payload.departure_time or "",
        "created_at": datetime.datetime.utcnow().isoformat()
    }
    
    ride_groups_col.insert_one(group_doc)
    return resolve_group_details(group_doc)

@router.put("/{group_id}")
def update_ride_group(group_id: str, payload: RideGroupUpdate, current_user: dict = Depends(get_current_user_from_token)):
    existing = ride_groups_col.find_one({"id": group_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Ride group not found")
        
    # Permission check: driver can only update status/delay of their assigned group
    if current_user["role"] == "driver":
        if existing.get("driver_id") != current_user["id"]:
            raise HTTPException(status_code=403, detail="Drivers can only update their own assigned ride group")
        # Drivers cannot update other fields
        if (payload.name is not None or payload.driver_id is not None or 
            payload.passenger_ids is not None or payload.pickup_order is not None or 
            payload.drop_order is not None or payload.total_cost is not None):
            raise HTTPException(status_code=403, detail="Drivers can only update status and delay_minutes")
    elif current_user["role"] not in ("supervisor", "admin"):
        raise HTTPException(status_code=403, detail="Not authorized")
        
    update_data = {}
    if payload.name is not None:
        update_data["name"] = payload.name
    if payload.driver_id is not None:
        # Check driver exists
        driver = users_col.find_one({"id": payload.driver_id, "role": "driver"})
        if not driver:
            raise HTTPException(status_code=400, detail="Driver does not exist")
        update_data["driver_id"] = payload.driver_id
    if payload.passenger_ids is not None:
        update_data["passenger_ids"] = payload.passenger_ids
    if payload.pickup_order is not None:
        update_data["pickup_order"] = [item.dict() for item in payload.pickup_order]
    if payload.drop_order is not None:
        update_data["drop_order"] = [item.dict() for item in payload.drop_order]
    if payload.status is not None:
        update_data["status"] = payload.status
    if payload.delay_minutes is not None:
        update_data["delay_minutes"] = payload.delay_minutes
    if payload.total_cost is not None:
        update_data["total_cost"] = payload.total_cost
    if payload.is_recurring is not None:
        update_data["is_recurring"] = payload.is_recurring
    if payload.recurrence_days is not None:
        update_data["recurrence_days"] = payload.recurrence_days
    if payload.departure_time is not None:
        update_data["departure_time"] = payload.departure_time
        
    if update_data:
        ride_groups_col.update_one({"id": group_id}, {"$set": update_data})
        
    updated = ride_groups_col.find_one({"id": group_id})
    return resolve_group_details(updated)

@router.delete("/{group_id}")
def delete_ride_group(group_id: str, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] not in ("supervisor", "admin"):
        raise HTTPException(status_code=403, detail="Only supervisor or admin can delete ride groups")
        
    res = ride_groups_col.delete_one({"id": group_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Ride group not found")
    return {"status": "success", "message": "Ride group deleted"}
