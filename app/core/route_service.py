"""Date-specific, read-only route projections for driver-facing rides."""

from typing import Dict, Iterable

from app.core.database import availability_col, users_col
from app.routers.ride_groups import build_passenger_statuses, default_passenger_status


def _clean(document: dict) -> dict:
    cleaned = dict(document)
    cleaned.pop("_id", None)
    return cleaned


def _ordered_stops(
    order: Iterable[dict],
    users_by_id: Dict[str, dict],
    availability_by_employee: Dict[str, dict],
    unavailable_field: str,
    passenger_statuses: Dict[str, dict],
    label_field: str,
) -> list[dict]:
    """Resolve one leg without changing its stored assignment or stop order."""
    stops = []
    # Normalise: items may be plain string user-IDs (from seeded/legacy data)
    # or the canonical {"user_id": ..., "order": N} dicts.
    def _normalise(item, idx):
        if isinstance(item, str):
            return {"user_id": item, "order": idx}
        return item

    normalised = [_normalise(item, i) for i, item in enumerate(order)]
    for source in sorted(normalised, key=lambda item: item.get("order", 0)):
        employee_id = source.get("user_id")
        if not employee_id or availability_by_employee.get(employee_id, {}).get(unavailable_field):
            continue

        employee = users_by_id.get(employee_id)
        if not employee:
            continue
        point = employee.get("pickup_point")
        point = point if isinstance(point, dict) else {}
        stops.append({
            "user_id": employee_id,
            "full_name": employee.get("full_name", "Employee"),
            "order": len(stops) + 1,
            "original_order": source.get("order"),
            label_field: point.get("label") or (
                "Preferred Pickup Location" if label_field == "pickup_label" else "Preferred Drop Location"
            ),
            "latitude": point.get("latitude"),
            "longitude": point.get("longitude"),
            "availability_status": availability_by_employee.get(employee_id, {}).get("status_label"),
            "trip_status": passenger_statuses.get(employee_id, default_passenger_status()),
        })
    return stops


def build_effective_route(group: dict, trip_date: str) -> dict:
    """Return temporary pickup/drop routes after applying one day's exceptions.

    This function never writes to ``ride_groups``.  The recurring assignment and
    its original stop ordering remain the source of truth for future dates.
    """
    passenger_ids = group.get("passenger_ids", [])
    availability_docs = list(availability_col.find({
        "employee_id": {"$in": passenger_ids},
        "date": trip_date,
    })) if passenger_ids else []
    availability_by_employee = {
        item["employee_id"]: _clean(item)
        for item in availability_docs
        if item.get("employee_id")
    }
    users_by_id = {
        user["id"]: user
        for user in users_col.find({"id": {"$in": passenger_ids}})
    } if passenger_ids else {}
    passenger_statuses = build_passenger_statuses(
        passenger_ids, group.get("passenger_statuses")
    )

    pickup_order = _ordered_stops(
        group.get("pickup_order", []), users_by_id, availability_by_employee,
        "pickup_not_needed", passenger_statuses, "pickup_label",
    )
    drop_order = _ordered_stops(
        group.get("drop_order", []), users_by_id, availability_by_employee,
        "drop_not_needed", passenger_statuses, "drop_label",
    )

    def passenger_from_stop(stop: dict) -> dict:
        return {
            "passenger_user_id": stop["user_id"],
            "full_name": stop["full_name"],
            "trip_status": stop["trip_status"],
        }

    return {
        "passenger_statuses": passenger_statuses,
        # These are leg-specific so a pickup-only or drop-only exception cannot
        # leak into the driver's active route display.
        "pickup_passengers": [passenger_from_stop(stop) for stop in pickup_order],
        "drop_passengers": [passenger_from_stop(stop) for stop in drop_order],
        # Keep the legacy field for existing cards. It excludes all-day leave
        # records but retains people who still need either leg.
        "passengers": [
            {
                "passenger_user_id": employee_id,
                "full_name": users_by_id.get(employee_id, {}).get("full_name", "Employee"),
                "trip_status": passenger_statuses.get(employee_id, default_passenger_status()),
            }
            for employee_id in passenger_ids
            if not availability_by_employee.get(employee_id, {}).get("no_cab_required")
        ],
        "pickup_order": pickup_order,
        "drop_order": drop_order,
        "availability_exceptions": list(availability_by_employee.values()),
    }
