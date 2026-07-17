from fastapi import APIRouter, Depends, HTTPException
from app.core.database import users_col, ride_groups_col
from app.core.auth import get_current_user_from_token
import datetime
from typing import Optional

router = APIRouter(prefix="/api/v1/analytics", tags=["Analytics"])

@router.get("/dashboard")
def get_dashboard_analytics(current_user: dict = Depends(get_current_user_from_token)):
    if current_user.get("role") not in ("admin", "supervisor"):
        raise HTTPException(status_code=403, detail="Not authorized")

    total_employees = users_col.count_documents({"role": "employee", "status": "approved"})
    total_drivers = users_col.count_documents({"role": "driver", "status": "approved"})
    active_rides = ride_groups_col.count_documents({"status": {"$ne": "completed"}})
    delayed_trips = ride_groups_col.count_documents({"status": {"$ne": "completed"}, "delay_minutes": {"$gt": 0}})
    
    # Monthly stats calculation
    from app.core.clock import get_today_ist
    today = get_today_ist()
    current_month_prefix = today.strftime("%Y-%m") # e.g. "2026-07"
    
    # Find all completed or active rides for the month
    month_query = {"ride_date": {"$regex": f"^{current_month_prefix}"}}
    month_rides = list(ride_groups_col.find(month_query))
    
    completed_month_rides = [r for r in month_rides if r.get("status") == "completed"]
    total_monthly_cost = sum(r.get("total_cost", 150.0) for r in completed_month_rides)
    total_completed_trips = len(completed_month_rides)
    
    # Driver-wise cost and trip breakdown
    driver_stats = {}
    for r in completed_month_rides:
        d_id = r.get("driver_id")
        if d_id:
            if d_id not in driver_stats:
                driver_stats[d_id] = {"trips": 0, "cost": 0.0}
            driver_stats[d_id]["trips"] += 1
            driver_stats[d_id]["cost"] += r.get("total_cost", 150.0)
            
    resolved_driver_costs = []
    for d_id, stats in driver_stats.items():
        driver = users_col.find_one({"id": d_id})
        d_name = driver.get("full_name", "Unknown Driver") if driver else "Unknown Driver"
        d_cab = driver.get("license_number", "N/A") if driver else "N/A"
        resolved_driver_costs.append({
            "driver_id": d_id,
            "driver_name": d_name,
            "cab_number": d_cab,
            "total_trips": stats["trips"],
            "total_cost": stats["cost"]
        })
        
    return {
        "total_employees": total_employees,
        "total_drivers": total_drivers,
        "active_rides": active_rides,
        "delayed_trips": delayed_trips,
        "total_monthly_cost": total_monthly_cost,
        "total_completed_trips": total_completed_trips,
        "driver_costs": resolved_driver_costs
    }


@router.get("/billing")
def get_billing_ledger(
    month: Optional[str] = None,
    driver_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user_from_token)
):
    if current_user.get("role") not in ("admin", "supervisor"):
        raise HTTPException(status_code=403, detail="Not authorized")

    from app.core.clock import get_today_ist
    if not month:
        today = get_today_ist()
        month = today.strftime("%Y-%m")

    # Find matching completed ride groups
    query = {
        "status": "completed",
        "ride_date": {"$regex": f"^{month}"}
    }
    if driver_id:
        query["driver_id"] = driver_id

    records = list(ride_groups_col.find(query).sort("ride_date", -1))
    
    # Resolve records detail
    resolved_records = []
    total_cost_sum = 0.0
    
    # Find all drivers for filter list population
    drivers_in_db = list(users_col.find({"role": "driver", "status": "approved"}))
    drivers_list = [{"id": d["id"], "full_name": d.get("full_name", "Unknown")} for d in drivers_in_db]
    
    for r in records:
        d_id = r.get("driver_id")
        driver = users_col.find_one({"id": d_id}) if d_id else None
        d_name = driver.get("full_name", "Unknown Driver") if driver else "Unknown Driver"
        d_cab = driver.get("license_number", "N/A") if driver else "N/A"
        
        # Build passengers list names
        passenger_names_list = []
        for pid in r.get("passenger_ids", []):
            passenger = users_col.find_one({"id": pid})
            if passenger:
                passenger_names_list.append(passenger.get("full_name", "Employee"))
        
        cost = r.get("total_cost", 150.0)
        total_cost_sum += cost
        
        resolved_records.append({
            "id": r.get("id"),
            "ride_date": r.get("ride_date", ""),
            "ride_reference": r.get("ride_reference", r.get("id")),
            "name": r.get("name", "Unnamed Route"),
            "driver_name": d_name,
            "cab_number": d_cab,
            "route_type": r.get("route_type", "pickup"),
            "passengers_names": ", ".join(passenger_names_list) if passenger_names_list else "None",
            "total_cost": cost
        })
        
    total_trips_count = len(resolved_records)
    avg_cost_per_trip = (total_cost_sum / total_trips_count) if total_trips_count > 0 else 0.0
    
    return {
        "records": resolved_records,
        "total_cost_sum": total_cost_sum,
        "total_trips_count": total_trips_count,
        "average_trip_cost": avg_cost_per_trip,
        "drivers": drivers_list
    }