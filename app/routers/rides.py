from fastapi import APIRouter, Depends, Query
import math
from app.core.auth import get_current_user_from_token
from app.core.database import db, ride_groups_col, users_col

router = APIRouter(prefix="/api/v1/rides", tags=["Rides"])

@router.get("")
def get_rides(
    current_user: dict = Depends(get_current_user_from_token),
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100)
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
        # Resolve driver
        driver = users_col.find_one({"id": g["driver_id"]})
        driver_name = driver.get("full_name", "Unknown Driver") if driver else "Unassigned"
        cab_number = driver.get("license_number") or "Cab" if driver else "N/A"
        
        # Build passenger list matching frontend structure
        passengers = [{"passenger_user_id": pid} for pid in g.get("passenger_ids", [])]
        
        # Resolve sorted pickup_order and drop_order for detailed sequence rendering
        resolved_pickup_order = []
        for item in sorted(g.get("pickup_order", []), key=lambda x: x.get("order", 0)):
            p_user = users_col.find_one({"id": item["user_id"]})
            if p_user:
                pk = p_user.get("pickup_point")
                resolved_pickup_order.append({
                    "user_id": item["user_id"],
                    "full_name": p_user.get("full_name"),
                    "order": item["order"],
                    "pickup_label": pk.get("label") if (pk and isinstance(pk, dict)) else "Preferred Pickup Location",
                    "latitude": pk.get("latitude") if (pk and isinstance(pk, dict)) else None,
                    "longitude": pk.get("longitude") if (pk and isinstance(pk, dict)) else None
                })

        resolved_drop_order = []
        for item in sorted(g.get("drop_order", []), key=lambda x: x.get("order", 0)):
            p_user = users_col.find_one({"id": item["user_id"]})
            if p_user:
                resolved_drop_order.append({
                    "user_id": item["user_id"],
                    "full_name": p_user.get("full_name"),
                    "order": item["order"]
                })
        
        # Determine pickup/drop display based on sorted lists
        p_names = [po["full_name"] for po in resolved_pickup_order]
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
            "passengers": passengers,
            "pickup_order": resolved_pickup_order,
            "drop_order": resolved_drop_order,
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