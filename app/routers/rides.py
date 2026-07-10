from fastapi import APIRouter, Depends, Query
import math
import datetime
from app.core.auth import get_current_user_from_token
from app.core.database import availability_col, db, ride_groups_col, users_col
from app.routers.ride_groups import build_passenger_statuses, default_passenger_status

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
        trip_date = g.get("ride_date") or date or datetime.date.today().isoformat()
        passenger_ids = g.get("passenger_ids", [])
        availability_docs = list(availability_col.find({
            "employee_id": {"$in": passenger_ids},
            "date": trip_date,
        })) if passenger_ids else []
        availability_by_employee = {item["employee_id"]: item for item in availability_docs}

        # Resolve driver
        driver = users_col.find_one({"id": g["driver_id"]})
        driver_name = driver.get("full_name", "Unknown Driver") if driver else "Unassigned"
        cab_number = driver.get("license_number") or "Cab" if driver else "N/A"
        
        passenger_statuses = build_passenger_statuses(g.get("passenger_ids", []), g.get("passenger_statuses"))

        # Build passenger list matching frontend structure
        passengers = [
            {
                "passenger_user_id": pid,
                "trip_status": passenger_statuses.get(pid, default_passenger_status())
            }
            for pid in g.get("passenger_ids", [])
        ]
        
        # Resolve sorted pickup_order and drop_order for detailed sequence rendering
        resolved_pickup_order = []
        pickup_stop = 1
        for item in sorted(g.get("pickup_order", []), key=lambda x: x.get("order", 0)):
            availability = availability_by_employee.get(item["user_id"], {})
            if availability.get("pickup_not_needed"):
                continue
            p_user = users_col.find_one({"id": item["user_id"]})
            if p_user:
                pk = p_user.get("pickup_point")
                resolved_pickup_order.append({
                    "user_id": item["user_id"],
                    "full_name": p_user.get("full_name"),
                    "order": pickup_stop,
                    "original_order": item["order"],
                    "pickup_label": pk.get("label") if (pk and isinstance(pk, dict)) else "Preferred Pickup Location",
                    "latitude": pk.get("latitude") if (pk and isinstance(pk, dict)) else None,
                    "availability_status": availability.get("status_label"),
                    "trip_status": passenger_statuses.get(item["user_id"], default_passenger_status())
                })
                pickup_stop += 1

        resolved_drop_order = []
        drop_stop = 1
        for item in sorted(g.get("drop_order", []), key=lambda x: x.get("order", 0)):
            availability = availability_by_employee.get(item["user_id"], {})
            if availability.get("drop_not_needed"):
                continue
            p_user = users_col.find_one({"id": item["user_id"]})
            if p_user:
                pk = p_user.get("pickup_point")
                resolved_drop_order.append({
                    "user_id": item["user_id"],
                    "full_name": p_user.get("full_name"),
                    "order": drop_stop,
                    "original_order": item["order"],
                    "drop_label": pk.get("label") if (pk and isinstance(pk, dict)) else "Preferred Drop Location",
                    "latitude": pk.get("latitude") if (pk and isinstance(pk, dict)) else None,
                    "longitude": pk.get("longitude") if (pk and isinstance(pk, dict)) else None,
                    "availability_status": availability.get("status_label"),
                    "trip_status": passenger_statuses.get(item["user_id"], default_passenger_status())
                })
                drop_stop += 1
        
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
            "passenger_statuses": passenger_statuses,
            "pickup_order": resolved_pickup_order,
            "drop_order": resolved_drop_order,
            "trip_date": trip_date,
            "availability_exceptions": [
                {
                    "employee_id": item["employee_id"],
                    "pickup_not_needed": item.get("pickup_not_needed", False),
                    "drop_not_needed": item.get("drop_not_needed", False),
                    "no_cab_required": item.get("no_cab_required", False),
                    "status_label": item.get("status_label"),
                }
                for item in availability_docs
            ],
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
