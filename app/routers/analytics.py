from fastapi import APIRouter, Depends
from app.core.database import users_col, ride_groups_col
from app.core.auth import get_current_user_from_token

router = APIRouter(prefix="/api/v1/analytics", tags=["Analytics"])

@router.get("/dashboard")
def get_dashboard_analytics(current_user: dict = Depends(get_current_user_from_token)):
    total_employees = users_col.count_documents({"role": "employee", "status": "approved"})
    total_drivers = users_col.count_documents({"role": "driver", "status": "approved"})
    active_rides = ride_groups_col.count_documents({"status": {"$ne": "completed"}})
    delayed_trips = ride_groups_col.count_documents({"status": {"$ne": "completed"}, "delay_minutes": {"$gt": 0}})
    
    return {
        "total_employees": total_employees,
        "total_drivers": total_drivers,
        "active_rides": active_rides,
        "delayed_trips": delayed_trips
    }