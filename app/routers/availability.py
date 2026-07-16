import datetime
import uuid
import math
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import get_current_user_from_token
from app.core.database import availability_col, notifications_col, ride_groups_col, users_col
from app.routers.tracking import manager
from app.core.clock import get_now, get_today_ist

router = APIRouter(prefix="/api/v1/availability", tags=["Employee Availability"])

# Configure logging
logger = logging.getLogger(__name__)

# Day name to ISO weekday mapping for recurring validation
DAY_NAME_TO_WEEKDAY = {
    "mon": 0, "monday": 0,
    "tue": 1, "tuesday": 1,
    "wed": 2, "wednesday": 2,
    "thu": 3, "thursday": 3,
    "fri": 4, "friday": 4,
    "sat": 5, "saturday": 5,
    "sun": 6, "sunday": 6,
}


class AvailabilityRequest(BaseModel):
    date: str
    pickup_not_needed: bool = False
    drop_not_needed: bool = False
    reason: Optional[str] = None


def _today_iso() -> str:
    return get_today_ist().isoformat()


def _parse_trip_date(value: str) -> datetime.date:
    try:
        parsed = datetime.date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be in YYYY-MM-DD format")
    if parsed < get_today_ist():
        raise HTTPException(status_code=400, detail="Past dates are not allowed")
    return parsed


def _clean(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return None
    result = dict(doc)
    result.pop("_id", None)
    return result


def _is_recurring_date(group: dict, trip_date: str) -> bool:
    """Check if the trip_date falls on a recurring day for the group."""
    if not group:
        return False
    
    recurrence_days = group.get("recurrence_days", [])
    if not recurrence_days:
        # If no recurrence days specified, allow any date (non-recurring group or one-time ride)
        return True
    
    try:
        parsed_date = datetime.date.fromisoformat(trip_date)
        weekday = parsed_date.weekday()  # 0=Monday, 6=Sunday
        
        # Check if the weekday matches any of the recurrence days
        for day_name in recurrence_days:
            day_name_lower = day_name.lower()
            if day_name_lower in DAY_NAME_TO_WEEKDAY:
                if DAY_NAME_TO_WEEKDAY[day_name_lower] == weekday:
                    return True
        return False
    except Exception as e:
        logger.warning(f"Error checking recurring date: {e}")
        return True  # Allow on error to avoid blocking valid requests


def _find_relevant_group(employee_id: str, trip_date: str) -> Optional[dict]:
    """Find the ride group for an employee on a specific date.
    
    Priority:
    1. Exact match: Group with specific ride_date matching trip_date
    2. Recurring match: Group without ride_date where trip_date falls on a valid recurrence day
    """
    # First, look for an exact date match (one-time rides)
    exact = ride_groups_col.find_one({
        "passenger_ids": employee_id,
        "ride_date": trip_date,
        "status": {"$ne": "draft"},
    })
    if exact:
        return exact

    # Then, look for recurring groups where the employee is a passenger
    recurring_groups = list(ride_groups_col.find({
        "passenger_ids": employee_id,
        "ride_date": {"$exists": False},
        "status": {"$ne": "draft"},
    }))
    
    # If multiple recurring groups, prefer the one where the date is a valid recurrence day
    for group in recurring_groups:
        if _is_recurring_date(group, trip_date):
            return group
    
    # Availability can be recorded without a matching service ride. In that
    # case, no route or driver-specific deadline needs to be applied.
    return None


def _trip_started(group: Optional[dict], trip_date: str) -> bool:
    if not group:
        return False
    if group.get("status") not in ("started", "ongoing", "completed"):
        return False
    if group.get("ride_date"):
        return group.get("ride_date") == trip_date
    return trip_date == _today_iso()


def _validate_deadline(group: Optional[dict], trip_date: str):
    if not group:
        return
    departure_time = group.get("departure_time")
    if not departure_time:
        return
    try:
        dep_hour, dep_minute = map(int, departure_time.split(":"))
        dep_date = datetime.date.fromisoformat(trip_date)
        departure_dt = datetime.datetime.combine(dep_date, datetime.time(dep_hour, dep_minute))
        
        # Calculate deadline: 4 hours before departure
        ist_now = get_now() + datetime.timedelta(hours=5, minutes=30)
        
        time_diff = departure_dt - ist_now
        if time_diff.total_seconds() < 4 * 3600:
            raise HTTPException(
                status_code=400,
                detail="Availability exceptions cannot be modified or cancelled within 4 hours of the scheduled departure time."
            )
    except HTTPException:
        raise
    except Exception:
        pass


def _status_label(pickup_not_needed: bool, drop_not_needed: bool) -> str:
    if pickup_not_needed and drop_not_needed:
        return "On Leave / No Cab Required"
    if pickup_not_needed:
        return "Pickup Not Needed"
    if drop_not_needed:
        return "Drop Not Needed"
    return "Pickup and Drop Required"


def _availability_message(employee_name: str, trip_date: str, pickup_not_needed: bool, drop_not_needed: bool, cancelled: bool = False) -> str:
    formatted_date = datetime.date.fromisoformat(trip_date).strftime("%B %d, %Y")
    if cancelled:
        return f"{employee_name} cancelled the pickup/drop exception for {formatted_date}. Pickup and drop service are required."
    if pickup_not_needed and drop_not_needed:
        return f"{employee_name} does not require pickup or drop service on {formatted_date} and is marked as On Leave / No Cab Required."
    if pickup_not_needed:
        return f"{employee_name} does not require pickup on {formatted_date}. Drop service is still required."
    if drop_not_needed:
        return f"{employee_name} does not require drop service on {formatted_date}. Pickup service is still required."
    return f"{employee_name} updated cab availability for {formatted_date}. Pickup and drop service are required."


def _notification_recipients(group: Optional[dict]) -> list[str]:
    recipients = []
    for user in users_col.find({"$or": [{"role": "admin"}, {"role": "supervisor", "status": "approved"}]}):
        recipients.append(user["id"])

    if group and group.get("driver_id"):
        driver = users_col.find_one({"id": group["driver_id"], "role": "driver"})
        if driver:
            recipients.append(driver["id"])

    return list(dict.fromkeys(recipients))


def _save_notifications(employee_id: str, employee_name: str, trip_date: str, pickup_not_needed: bool, drop_not_needed: bool, group: Optional[dict], cancelled: bool = False):
    """Create one availability notification per recipient/date, then update it."""
    message = _availability_message(employee_name, trip_date, pickup_not_needed, drop_not_needed, cancelled=cancelled)
    now = get_now().isoformat()
    for recipient_id in _notification_recipients(group):
        notifications_col.update_one(
            {
                "recipient_id": recipient_id,
                "notification_type": "availability",
                "availability_employee_id": employee_id,
                "availability_date": trip_date,
            },
            {
                "$set": {
                    "title": "Pickup/Drop Availability Updated",
                    "message": message,
                    "is_read": False,
                    "updated_at": now,
                },
                "$setOnInsert": {
                    "id": str(uuid.uuid4()),
                    "recipient_id": recipient_id,
                    "notification_type": "availability",
                    "availability_employee_id": employee_id,
                    "availability_date": trip_date,
                    "created_at": now,
                },
            },
            upsert=True,
        )


async def _broadcast_route_change(employee_id: str, trip_date: str, group: Optional[dict], message: str):
    payload = {
        "type": "route_change",
        "employee_id": employee_id,
        "date": trip_date,
        "message": message,
    }
    if group:
        payload["group_id"] = group.get("id")
        payload["driver_id"] = group.get("driver_id")
    await manager.broadcast_location(payload)


@router.get("")
def get_all_availability(
    current_user: dict = Depends(get_current_user_from_token),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100)
):
    if current_user["role"] not in ("admin", "supervisor"):
        raise HTTPException(status_code=403, detail="Only admins or supervisors can view all availability logs")
    
    total = availability_col.count_documents({})
    skip = (page - 1) * limit
    docs = list(availability_col.find({}).sort("date", -1).skip(skip).limit(limit))
    return {
        "items": [_clean(doc) for doc in docs],
        "total": total,
        "page": page,
        "pages": math.ceil(total / limit) if total > 0 else 1
    }


@router.get("/me/history")
def get_my_availability_history(
    current_user: dict = Depends(get_current_user_from_token)
):
    if current_user["role"] != "employee":
        raise HTTPException(status_code=403, detail="Only employees can view their unavailability history")
    
    docs = list(availability_col.find({"employee_id": current_user["id"]}).sort("date", -1))
    return [_clean(doc) for doc in docs]


@router.get("/me")
def get_my_availability(
    date: str = Query(...),
    current_user: dict = Depends(get_current_user_from_token),
):
    if current_user["role"] != "employee":
        raise HTTPException(status_code=403, detail="Only employees can view pickup/drop availability")
    trip_date = _parse_trip_date(date).isoformat()
    doc = availability_col.find_one({"employee_id": current_user["id"], "date": trip_date})
    group = _find_relevant_group(current_user["id"], trip_date)
    response = _clean(doc) or {
        "employee_id": current_user["id"],
        "date": trip_date,
        "pickup_not_needed": False,
        "drop_not_needed": False,
        "pickup_required": True,
        "drop_required": True,
        "no_cab_required": False,
        "status_label": "Pickup and Drop Required",
        "reason": None,
    }
    
    can_change = not _trip_started(group, trip_date)
    if can_change and group and group.get("departure_time"):
        try:
            dep_hour, dep_minute = map(int, group["departure_time"].split(":"))
            dep_date = datetime.date.fromisoformat(trip_date)
            departure_dt = datetime.datetime.combine(dep_date, datetime.time(dep_hour, dep_minute))
            ist_now = get_now() + datetime.timedelta(hours=5, minutes=30)
            if (departure_dt - ist_now).total_seconds() < 4 * 3600:
                can_change = False
        except Exception:
            pass
            
    response["can_change"] = can_change
    response["ride_group_id"] = group.get("id") if group else None
    response["assigned_driver_id"] = group.get("driver_id") if group else None
    return response


@router.put("/me")
async def upsert_my_availability(
    payload: AvailabilityRequest,
    current_user: dict = Depends(get_current_user_from_token),
):
    if current_user["role"] != "employee":
        raise HTTPException(status_code=403, detail="Only employees can update pickup/drop availability")

    # Validate at least one toggle is selected
    if not payload.pickup_not_needed and not payload.drop_not_needed:
        raise HTTPException(
            status_code=400, 
            detail="Please select at least one option: 'Pickup Not Needed' or 'Drop Not Needed'. If both pickup and drop are required, you don't need to submit this form."
        )

    trip_date = _parse_trip_date(payload.date).isoformat()
    group = _find_relevant_group(current_user["id"], trip_date)
    
    # Employees may record an exception without an assignment. If a matching
    # ride exists, its driver receives the normal notification and refresh.
    if _trip_started(group, trip_date):
        raise HTTPException(status_code=400, detail="Availability cannot be changed after the affected trip has started")

    _validate_deadline(group, trip_date)

    existing = availability_col.find_one({"employee_id": current_user["id"], "date": trip_date})
    reason = payload.reason.strip() if payload.reason else None
    expected_group_id = group.get("id") if group else None
    expected_driver_id = group.get("driver_id") if group else None
    if existing and (
        bool(existing.get("pickup_not_needed")) == payload.pickup_not_needed
        and bool(existing.get("drop_not_needed")) == payload.drop_not_needed
        and (existing.get("reason") or None) == reason
        and existing.get("ride_group_id") == expected_group_id
        and existing.get("assigned_driver_id") == expected_driver_id
    ):
        response = _clean(existing)
        response.update({
            "already_informed": True,
            "notification_sent": False,
            "message": "You have already informed this availability for the selected date. Change an option or reason to update it.",
        })
        return response

    now = get_now().isoformat()
    availability_id = existing.get("id") if existing else str(uuid.uuid4())
    created_at = existing.get("created_at") if existing else now
    doc = {
        "id": availability_id,
        "employee_id": current_user["id"],
        "employee_name": current_user["full_name"],
        "date": trip_date,
        "pickup_not_needed": payload.pickup_not_needed,
        "drop_not_needed": payload.drop_not_needed,
        "pickup_required": not payload.pickup_not_needed,
        "drop_required": not payload.drop_not_needed,
        "no_cab_required": payload.pickup_not_needed and payload.drop_not_needed,
        "status_label": _status_label(payload.pickup_not_needed, payload.drop_not_needed),
        "reason": reason,
        "ride_group_id": expected_group_id,
        "assigned_driver_id": expected_driver_id,
        "updated_at": now,
    }

    availability_col.update_one(
        {"employee_id": current_user["id"], "date": trip_date},
        {"$set": doc, "$setOnInsert": {"created_at": created_at}},
        upsert=True,
    )

    saved = availability_col.find_one({"employee_id": current_user["id"], "date": trip_date})
    _save_notifications(
        current_user["id"],
        current_user["full_name"],
        trip_date,
        payload.pickup_not_needed,
        payload.drop_not_needed,
        group,
    )
    message = _availability_message(current_user["full_name"], trip_date, payload.pickup_not_needed, payload.drop_not_needed)
    await _broadcast_route_change(current_user["id"], trip_date, group, message)
    response = _clean(saved)
    response.update({"already_informed": False, "notification_sent": True})
    return response


@router.delete("/me/{date}")
async def cancel_my_availability(
    date: str,
    current_user: dict = Depends(get_current_user_from_token),
):
    if current_user["role"] != "employee":
        raise HTTPException(status_code=403, detail="Only employees can cancel pickup/drop availability")

    trip_date = _parse_trip_date(date).isoformat()
    
    # Check if there's an existing availability record to cancel
    existing = availability_col.find_one({"employee_id": current_user["id"], "date": trip_date})
    if not existing:
        raise HTTPException(status_code=404, detail="No availability exception found for this date to cancel")
    
    group = _find_relevant_group(current_user["id"], trip_date)
    if _trip_started(group, trip_date):
        raise HTTPException(status_code=400, detail="Availability cannot be cancelled after the affected trip has started")

    _validate_deadline(group, trip_date)

    availability_col.delete_one({"employee_id": current_user["id"], "date": trip_date})
    _save_notifications(current_user["id"], current_user["full_name"], trip_date, False, False, group, cancelled=True)
    message = _availability_message(current_user["full_name"], trip_date, False, False, cancelled=True)
    await _broadcast_route_change(current_user["id"], trip_date, group, message)
    return {"status": "success", "message": "Pickup/drop exception cancelled"}


@router.get("/ride-group/{group_id}")
def get_availability_by_ride_group(
    group_id: str,
    date: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user_from_token),
):
    """Get all availability exceptions for a specific ride group.
    
    Admin: Can view all ride groups
    Supervisor: Can only view ride groups they manage (assigned as driver or creator)
    Driver: Can only view their assigned ride group
    """
    if current_user["role"] not in ("admin", "supervisor", "driver"):
        raise HTTPException(status_code=403, detail="Only admins, supervisors, or drivers can view ride group availability")
    
    # Find the ride group
    group = ride_groups_col.find_one({"id": group_id})
    if not group:
        raise HTTPException(status_code=404, detail="Ride group not found")
    
    # Authorization check
    if current_user["role"] == "supervisor":
        # Supervisors can view any ride group (they manage routes)
        pass
    elif current_user["role"] == "driver":
        # Drivers can only view their assigned ride group
        if group.get("driver_id") != current_user["id"]:
            raise HTTPException(status_code=403, detail="Drivers can only view availability for their assigned ride group")
    
    # Build query
    query = {"ride_group_id": group_id}
    if date:
        query["date"] = date
    
    docs = list(availability_col.find(query).sort("date", -1))
    
    # Enrich with employee and driver details
    result = []
    for doc in docs:
        cleaned = _clean(doc)
        # Get employee details
        employee = users_col.find_one({"id": doc["employee_id"]})
        if employee:
            cleaned["employee_email"] = employee.get("email")
            cleaned["employee_mobile"] = employee.get("mobile_number")
        result.append(cleaned)
    
    return result


@router.get("/date/{date}")
def get_availability_by_date(
    date: str,
    current_user: dict = Depends(get_current_user_from_token),
):
    """Get all availability exceptions for a specific date.
    
    Admin: Can view all
    Supervisor: Can view all (they manage routes)
    """
    if current_user["role"] not in ("admin", "supervisor"):
        raise HTTPException(status_code=403, detail="Only admins or supervisors can view availability by date")
    
    trip_date = _parse_trip_date(date).isoformat()
    docs = list(availability_col.find({"date": trip_date}).sort("created_at", -1))
    
    # Enrich with employee and group details
    result = []
    for doc in docs:
        cleaned = _clean(doc)
        # Get employee details
        employee = users_col.find_one({"id": doc["employee_id"]})
        if employee:
            cleaned["employee_email"] = employee.get("email")
            cleaned["employee_mobile"] = employee.get("mobile_number")
        # Get group details
        if doc.get("ride_group_id"):
            group = ride_groups_col.find_one({"id": doc["ride_group_id"]})
            if group:
                cleaned["group_name"] = group.get("name")
                if group.get("driver_id"):
                    driver = users_col.find_one({"id": group["driver_id"]})
                    if driver:
                        cleaned["driver_name"] = driver.get("full_name")
                        cleaned["driver_mobile"] = driver.get("mobile_number")
        result.append(cleaned)
    
    return result

