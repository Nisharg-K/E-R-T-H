from fastapi import APIRouter, Depends
from app.core.auth import get_current_user_from_token


router = APIRouter(prefix="/api/v1/notifications", tags=["Notifications"])

@router.get("")
def get_notifications(current_user: dict = Depends(get_current_user_from_token)):
    return [
        {
            "id": "n1",
            "title": "Welcome to E.R.T.H",
            "message": "Your Employee Route Tracking Hub is initialized and ready.",
            "is_read": False
        },
        {
            "id": "n2",
            "title": "Cab GJ-06-XX-1234 En Route",
            "message": "Cab GJ-06-XX-1234 has started. Expected delay: 2 minutes.",
            "is_read": False
        }
    ]