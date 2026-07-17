from fastapi import APIRouter, Depends, Query
import math
import datetime
from app.core.auth import get_current_user_from_token
from app.core.database import ride_groups_col, users_col
from app.core.route_service import build_effective_route
from app.core.clock import get_today_ist

router = APIRouter(prefix="/api/v1/rides", tags=["Rides"])

@router.get("")
def get_rides(
    current_user: dict = Depends(get_current_user_from_token),
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    date: str | None = Query(None)
):
    uid = current_user["id"]
    role = current_user["role"]
    
    # Query database for groups matching current user
    query = {}
    if role == "driver":
        query = {"driver_id": uid, "status": {"$ne": "draft"}}
    elif role == "employee":
        query = {"passenger_ids": uid, "status": {"$ne": "draft"}}
    
    total = ride_groups_col.count_documents(query)
    skip = (page - 1) * limit
    groups = list(ride_groups_col.find(query).sort("created_at", -1).skip(skip).limit(limit))

    # Map groups to rides format
    resolved_rides = []
    for g in groups:
        trip_date = g.get("ride_date") or date or get_today_ist().isoformat()
        effective_route = build_effective_route(g, trip_date)

        # Resolve driver
        driver = users_col.find_one({"id": g["driver_id"]})
        driver_name = driver.get("full_name", "Unknown Driver") if driver else "Unassigned"
        cab_number = driver.get("license_number") or "Cab" if driver else "N/A"
        
        # Determine pickup/drop display based on sorted lists
        p_names = [po["full_name"] for po in effective_route["pickup_order"]]
        if role == "employee":
            pk = current_user.get("pickup_point")
            pickup = pk.get("label") if (pk and isinstance(pk, dict)) else "Preferred Pickup Location"
            drop = "Aditi Vadodara Office"
        else:
            pickup = f"Route: " + " → ".join(p_names) if p_names else "Morning Route"
            drop = "Aditi Vadodara Office"

        resolved_rides.append({
            "id": g["id"],
            "ride_reference": f"RIDE-{g['id'][:6].upper()}",
            "group_name": g.get("name", "Ride Group"),
            "pickup_point": pickup,
            "drop_point": drop,
            "status": g.get("status", "pending"),
            "delay_minutes": g.get("delay_minutes", 0),
            "total_cost": g.get("total_cost", 150.00),
            **effective_route,
            "trip_date": trip_date,
            "assigned_driver_id": g["driver_id"],
            "driver_name": driver_name,
            "cab_number": cab_number
        })

    return {
        "items": resolved_rides,
        "total": total,
        "page": page,
        "pages": math.ceil(total / limit) if total > 0 else 1
    }
