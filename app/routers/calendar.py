import calendar
import datetime
import uuid
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import get_current_user_from_token
from app.core.database import availability_col, ride_groups_col, users_col, notifications_col
from app.routers.tracking import manager
from app.routers.ride_groups import build_passenger_statuses, default_passenger_status

router = APIRouter(prefix="/api/v1/calendar", tags=["Calendar"])

DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
OFFICE_NAME = "Aditi Vadodara Office"


def _month_bounds(month: str) -> Tuple[datetime.date, datetime.date]:
    try:
        start = datetime.datetime.strptime(month, "%Y-%m").date().replace(day=1)
    except ValueError:
        raise HTTPException(status_code=400, detail="month must use YYYY-MM format")
    last_day = calendar.monthrange(start.year, start.month)[1]
    return start, start.replace(day=last_day)


def _daterange(start: datetime.date, end: datetime.date):
    day = start
    while day <= end:
        yield day
        day += datetime.timedelta(days=1)


def _parse_date(value: Optional[str]) -> Optional[datetime.date]:
    if not value:
        return None
    try:
        return datetime.datetime.strptime(value[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _clean_doc(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return None
    cleaned = dict(doc)
    cleaned.pop("_id", None)
    return cleaned


def _user_summary(user_id: Optional[str], cache: Dict[str, dict]) -> Optional[dict]:
    if not user_id:
        return None
    if user_id not in cache:
        cache[user_id] = _clean_doc(users_col.find_one({"id": user_id})) or {}
    user = cache[user_id]
    if not user:
        return None
    return {
        "id": user.get("id"),
        "full_name": user.get("full_name"),
        "email": user.get("email"),
        "role": user.get("role"),
        "employee_id": user.get("employee_id"),
        "license_number": user.get("license_number"),
    }


def _event(
    *,
    event_type: str,
    date_value: datetime.date,
    title: str,
    scope: str,
    ride_group: Optional[dict] = None,
    employee: Optional[dict] = None,
    driver: Optional[dict] = None,
    passengers: Optional[List[dict]] = None,
    boarding_status: Optional[dict] = None,
    can_board: bool = False,
    reason: Optional[str] = None,
    reroute_candidate: bool = False,
) -> dict:
    ride_group = ride_group or {}
    employee_id = employee.get("id") if employee else ""
    driver_id = driver.get("id") if driver else ""
    source_id = ride_group.get("id") or employee_id or driver_id
    return {
        "id": f"{event_type}:{date_value.isoformat()}:{source_id}:{employee_id}:{driver_id}",
        "type": event_type,
        "date": date_value.isoformat(),
        "title": title,
        "scope": scope,
        "ride_group_id": ride_group.get("id"),
        "ride_group_name": ride_group.get("name"),
        "departure_time": ride_group.get("departure_time") or "",
        "status": ride_group.get("status"),
        "employee": employee,
        "driver": driver,
        "passengers": passengers or [],
        "boarding_status": boarding_status,
        "can_board": can_board,
        "reason": reason,
        "reroute_candidate": reroute_candidate,
    }


def _passenger_summaries(group: dict, user_cache: Dict[str, dict]) -> List[dict]:
    statuses = build_passenger_statuses(group.get("passenger_ids", []), group.get("passenger_statuses"))
    passengers = []
    for passenger_id in group.get("passenger_ids", []):
        employee = _user_summary(passenger_id, user_cache)
        if employee:
            passengers.append({
                **employee,
                "trip_status": statuses.get(passenger_id, default_passenger_status()),
            })
    return passengers


def _ride_dates(group: dict, start: datetime.date, end: datetime.date) -> List[datetime.date]:
    explicit = _parse_date(group.get("ride_date"))
    if explicit:
        return [explicit] if start <= explicit <= end else []

    if group.get("is_recurring") and group.get("recurrence_days"):
        days = set(group.get("recurrence_days") or [])
        return [day for day in _daterange(start, end) if DAY_KEYS[day.weekday()] in days]

    fallback = _parse_date(group.get("created_at")) or datetime.datetime.utcnow().date()
    return [fallback] if start <= fallback <= end else []


def _ride_query_for_role(current_user: dict) -> dict:
    role = current_user.get("role")
    if role == "employee":
        return {"passenger_ids": current_user["id"], "status": {"$ne": "draft"}}
    if role == "driver":
        return {"driver_id": current_user["id"], "status": {"$ne": "draft"}}
    if role in ("supervisor", "admin"):
        return {"status": {"$ne": "draft"}}
    raise HTTPException(status_code=403, detail="Calendar is available to employees, drivers, supervisors, and admins")


def _availability_query_for_role(current_user: dict, start: datetime.date, end: datetime.date) -> dict:
    date_filter = {"$gte": start.isoformat(), "$lte": end.isoformat()}
    if current_user.get("role") in ("supervisor", "admin"):
        return {"date": date_filter}
    return {"employee_id": current_user["id"], "date": date_filter}


@router.get("")
def get_calendar(
    month: str = Query(..., description="Target month in YYYY-MM format"),
    current_user: dict = Depends(get_current_user_from_token),
):
    start, end = _month_bounds(month)
    user_cache: Dict[str, dict] = {current_user["id"]: _clean_doc(current_user) or {}}
    events: List[dict] = []
    leave_dates = set()

    groups = list(ride_groups_col.find(_ride_query_for_role(current_user)))
    for group in groups:
        driver = _user_summary(group.get("driver_id"), user_cache)
        passengers = _passenger_summaries(group, user_cache)
        passenger_statuses = build_passenger_statuses(group.get("passenger_ids", []), group.get("passenger_statuses"))
        ride_dates = _ride_dates(group, start, end)
        if not ride_dates:
            continue

        if current_user.get("role") == "driver":
            for ride_date in ride_dates:
                events.append(_event(
                    event_type="Ride",
                    date_value=ride_date,
                    title=group.get("name", "Assigned Ride"),
                    scope="driver",
                    ride_group=group,
                    driver=driver,
                    passengers=passengers,
                ))
            continue

        if current_user.get("role") == "employee":
            if current_user["id"] not in group.get("passenger_ids", []):
                continue
            employee = _user_summary(current_user["id"], user_cache)
            boarding_status = passenger_statuses.get(current_user["id"], default_passenger_status())
            for ride_date in ride_dates:
                events.append(_event(
                    event_type="Boarded" if boarding_status.get("boarded") else "Ride",
                    date_value=ride_date,
                    title=group.get("name", "Assigned Cab"),
                    scope="employee",
                    ride_group=group,
                    employee=employee,
                    driver=driver,
                    passengers=[p for p in passengers if p.get("id") == current_user["id"]],
                    boarding_status=boarding_status,
                    can_board=(
                        ride_date.isoformat() == datetime.date.today().isoformat()
                        and group.get("status") in ("started", "ongoing")
                        and not boarding_status.get("boarded")
                    ),
                ))
            continue

        if current_user.get("role") in ("supervisor", "admin"):
            for ride_date in ride_dates:
                events.append(_event(
                    event_type="Ride",
                    date_value=ride_date,
                    title=group.get("name", "Driver Ride"),
                    scope="driver",
                    ride_group=group,
                    driver=driver,
                    passengers=passengers,
                ))

    availability_docs = list(availability_col.find(_availability_query_for_role(current_user, start, end)))
    for availability in availability_docs:
        day = _parse_date(availability.get("date"))
        if not day:
            continue
        employee = _user_summary(availability.get("employee_id"), user_cache)
        if not employee:
            continue
        pickup_off = bool(availability.get("pickup_not_needed"))
        drop_off = bool(availability.get("drop_not_needed"))
        reason = availability.get("reason")

        if pickup_off or drop_off:
            leave_dates.add(day.isoformat())
            events.append(_event(
                event_type="Leave",
                date_value=day,
                title=f"Leave - {employee.get('full_name', 'Employee')}",
                scope="availability",
                employee=employee,
                reason=reason,
                reroute_candidate=current_user.get("role") in ("supervisor", "admin"),
            ))

    events.sort(key=lambda item: (item["date"], item["type"], item.get("title") or ""))
    return {
        "month": month,
        "role": current_user.get("role"),
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "events": events,
        "rerouting": {
            "ready": current_user.get("role") in ("supervisor", "admin"),
            "leave_dates": sorted(leave_dates),
            "candidate_event_ids": [event["id"] for event in events if event.get("reroute_candidate")],
        },
    }


@router.post("/rides/{ride_group_id}/board")
def board_current_ride(
    ride_group_id: str,
    current_user: dict = Depends(get_current_user_from_token),
):
    if current_user.get("role") != "employee":
        raise HTTPException(status_code=403, detail="Only employees can mark themselves as boarded")

    group = ride_groups_col.find_one({"id": ride_group_id, "passenger_ids": current_user["id"]})
    if not group:
        raise HTTPException(status_code=404, detail="Active ride assignment not found")
    if group.get("status") not in ("started", "ongoing"):
        raise HTTPException(status_code=400, detail="Boarding is only available for active rides")

    passenger_statuses = build_passenger_statuses(group.get("passenger_ids", []), group.get("passenger_statuses"))
    current_status = passenger_statuses.get(current_user["id"], default_passenger_status())
    if current_status.get("boarded"):
        return {
            "ride_group_id": ride_group_id,
            "passenger_id": current_user["id"],
            **current_status,
        }

    next_status = {
        **current_status,
        "boarded": True,
        "boarded_at": datetime.datetime.utcnow().isoformat(),
    }
    ride_groups_col.update_one(
        {"id": ride_group_id},
        {"$set": {f"passenger_statuses.{current_user['id']}": next_status}},
    )
    # Create notifications for driver and supervisors/admins
    now = datetime.datetime.utcnow().isoformat()
    message = f"{current_user.get('full_name', 'Employee')} has boarded the cab."
    docs = []
    # driver recipient
    driver_id = group.get('driver_id')
    if driver_id:
        docs.append({
            'id': str(uuid.uuid4()),
            'recipient_id': driver_id,
            'title': 'Passenger Boarded',
            'message': message,
            'is_read': False,
            'created_at': now
        })
    # supervisors and admins
    for u in users_col.find({"$or": [{"role": "supervisor"}, {"role": "admin"}], "status": "approved"}):
        docs.append({
            'id': str(uuid.uuid4()),
            'recipient_id': u['id'],
            'title': 'Passenger Boarded',
            'message': message,
            'is_read': False,
            'created_at': now
        })
    if docs:
        try:
            notifications_col.insert_many(docs)
        except Exception:
            pass

    # Broadcast a lightweight route change payload to websocket watchers
    try:
        payload = {
            'type': 'board_event',
            'ride_group_id': ride_group_id,
            'passenger_id': current_user['id'],
            'passenger_name': current_user.get('full_name'),
            'driver_id': driver_id,
            'timestamp': now,
        }
        # schedule background broadcast
        import asyncio
        asyncio.create_task(manager.broadcast_location(payload))
    except Exception:
        pass
    return {
        "ride_group_id": ride_group_id,
        "passenger_id": current_user["id"],
        **next_status,
    }
