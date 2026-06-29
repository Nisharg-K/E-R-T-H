from fastapi import APIRouter, Depends
from app.core.auth import get_current_user_from_token
from app.core.database import ride_groups_col, users_col

router = APIRouter(prefix="/api/v1/notifications", tags=["Notifications"])

@router.get("")
def get_notifications(current_user: dict = Depends(get_current_user_from_token)):
    uid = current_user["id"]
    role = current_user["role"]
    
    notifications = [
        {
            "id": "n1",
            "title": "Welcome to E.R.T.H",
            "message": "Your Employee Route Tracking Hub is initialized and ready.",
            "is_read": False
        }
    ]
    
    if role == "driver":
        group = ride_groups_col.find_one({"driver_id": uid, "status": {"$ne": "draft"}})
        if group:
            passengers_count = len(group.get("passenger_ids", []))
            notifications.append({
                "id": f"group-notify-{group['id']}",
                "title": f"Assigned Route: {group['name']}",
                "message": f"You have been assigned to route '{group['name']}' with {passengers_count} passengers.",
                "is_read": False
            })
            if group.get("delay_minutes", 0) > 0:
                notifications.append({
                    "id": f"group-delay-{group['id']}",
                    "title": "Trip Delayed",
                    "message": f"Your trip '{group['name']}' has a reported delay of {group['delay_minutes']} minutes.",
                    "is_read": False
                })
    elif role == "employee":
        group = ride_groups_col.find_one({"passenger_ids": uid, "status": {"$ne": "draft"}})
        if group:
            driver = users_col.find_one({"id": group["driver_id"]})
            driver_name = driver.get("full_name", "Driver") if driver else "Unassigned"
            cab_number = driver.get("license_number") or "Cab" if driver else "N/A"
            notifications.append({
                "id": f"group-notify-{group['id']}",
                "title": "Cab Assigned",
                "message": f"You are assigned to route '{group['name']}'. Driver: {driver_name} ({cab_number}).",
                "is_read": False
            })
            if group.get("delay_minutes", 0) > 0:
                notifications.append({
                    "id": f"group-delay-{group['id']}",
                    "title": "Cab Delayed",
                    "message": f"Your cab '{cab_number}' is delayed by {group['delay_minutes']} minutes.",
                    "is_read": False
                })
    elif role in ("admin", "supervisor"):
        pending_count = users_col.count_documents({"status": "pending"})
        if pending_count > 0:
            notifications.append({
                "id": "pending-approvals-notify",
                "title": "Pending User Approvals",
                "message": f"There are {pending_count} pending registration requests requiring action.",
                "is_read": False
            })
            
    return notifications