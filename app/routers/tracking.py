from fastapi import APIRouter, Depends
from app.core.auth import get_current_user_from_token


router = APIRouter(prefix="/api/v1", tags=["Tracking & AI"])

@router.get("/tracking/active")
def get_active_tracking(current_user: dict = Depends(get_current_user_from_token)):
    return [
        {
            "driver_name": "Aditi Driver",
            "cab_number": "GJ-06-XX-1234",
            "latitude": 22.3072,
            "longitude": 73.1812,
            "recorded_at": "Just now"
        }
    ]

@router.post("/ai-chat")
def ai_chat(payload: dict, current_user: dict = Depends(get_current_user_from_token)):
    return {"answer": "AI Chat integration will be set up in a future module. Stay tuned!"}