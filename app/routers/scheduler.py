"""
APScheduler-based daily job that spawns new pending ride group instances
from recurring templates.
"""
import uuid
import datetime
import logging
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from app.core.database import ride_groups_col

logger = logging.getLogger(__name__)

DAY_MAP = {
    "mon": 0, "tue": 1, "wed": 2,
    "thu": 3, "fri": 4, "sat": 5, "sun": 6
}


def spawn_recurring_rides():
    """
    Called once per minute by APScheduler.
    Finds all recurring ride group templates and spawns a fresh pending
    instance for today if:
      - today is in their recurrence_days
      - departure_time matches current time (within the same minute)
      - no instance with today's ride_date already exists for this template
    """
    now = datetime.datetime.utcnow()
    # Convert UTC to IST (+5:30) for comparison with departure_time
    ist_offset = datetime.timedelta(hours=5, minutes=30)
    ist_now = now + ist_offset
    current_time_str = ist_now.strftime("%H:%M")
    today_abbr = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][ist_now.weekday()]
    today_date = ist_now.strftime("%Y-%m-%d")

    templates = list(ride_groups_col.find({
        "is_recurring": True,
        "recurrence_days": today_abbr,
        "departure_time": current_time_str
    }))

    for template in templates:
        template_id = template["id"]
        # Check if an instance already exists for today
        existing = ride_groups_col.find_one({
            "template_id": template_id,
            "ride_date": today_date
        })
        if existing:
            continue

        # Spawn a new pending instance
        new_id = str(uuid.uuid4())
        instance = {
            "id": new_id,
            "template_id": template_id,
            "ride_date": today_date,
            "name": f"{template['name']} — {today_date}",
            "driver_id": template["driver_id"],
            "passenger_ids": template["passenger_ids"],
            "pickup_order": template.get("pickup_order", []),
            "drop_order": template.get("drop_order", []),
            "status": "pending",
            "delay_minutes": 0,
            "total_cost": template.get("total_cost", 150.0),
            "is_recurring": False,       # instances are not templates
            "recurrence_days": [],
            "departure_time": template.get("departure_time", ""),
            "created_at": datetime.datetime.utcnow().isoformat()
        }
        ride_groups_col.insert_one(instance)
        logger.info(f"[Scheduler] Spawned recurring ride instance {new_id} from template {template_id} for {today_date}")


def start_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="UTC")
    # Run every minute to check departure times
    scheduler.add_job(
        spawn_recurring_rides,
        CronTrigger(minute="*"),
        id="recurring_rides",
        replace_existing=True
    )
    scheduler.start()
    logger.info("[Scheduler] APScheduler started — recurring rides job active.")
    return scheduler
