from fastapi import APIRouter, Depends
from app.core.auth import get_current_user_from_token


router = APIRouter(prefix="/api/v1/rides", tags=["Rides"])

@router.get("")
def get_rides(current_user: dict = Depends(get_current_user_from_token)):
    return [
        {
            "id": "ride-1",
            "ride_reference": "RIDE-1001",
            "pickup_point": "Aditi Vadodara Office",
            "drop_point": "Gotri Road",
            "status": "ongoing",
            "delay_minutes": 2,
            "total_cost": 150.00,
            "passengers": [
                {"passenger_user_id": "employee-id-123"}
            ],
            "assigned_driver_id": "driver-id-123",
            "driver_name": "Aditi Driver",
            "cab_number": "GJ-06-XX-1234"
        },
        {
            "id": "ride-2",
            "ride_reference": "RIDE-1002",
            "pickup_point": "Alkapuri",
            "drop_point": "Aditi Vadodara Office",
            "status": "completed",
            "delay_minutes": 0,
            "total_cost": 180.00,
            "passengers": [
                {"passenger_user_id": "employee-id-123"}
            ],
            "assigned_driver_id": "driver-id-123",
            "driver_name": "Aditi Driver",
            "cab_number": "GJ-06-XX-1234"
        }
    ]