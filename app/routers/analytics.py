from fastapi import APIRouter, Depends
from app.core.database import load_db
from app.core.auth import get_current_user_from_token

router = APIRouter(prefix="/api/v1/analytics", tags=["Analytics"])

@router.get("/dashboard")
def get_dashboard_analytics(current_user: dict = Depends(get_current_user_from_token)):
    db_data = load_db()
    total_employees = sum(1 for u in db_data["users"] if u["role"] == "employee" and u["status"] == "approved")
    total_drivers = sum(1 for u in db_data["users"] if u["role"] == "driver" and u["status"] == "approved")
    return {
        "total_employees": total_employees,
        "total_drivers": total_drivers,
        "active_rides": 1,
        "delayed_trips": 0
    }