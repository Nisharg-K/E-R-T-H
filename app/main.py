import uvicorn
import uuid
import math
from contextlib import asynccontextmanager
from typing import Optional
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Core internal utility dependencies
from app.core.database import users_col, clean_user
from app.core.auth import get_current_user_from_token, generate_token, validate_employee_email
from app.routers import analytics, rides, tracking, notification, ride_groups, availability, developer, calendar
from app.routers.scheduler import start_scheduler

_scheduler = None

@asynccontextmanager
async def lifespan(app):
    global _scheduler
    _scheduler = start_scheduler()
    yield
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)

app = FastAPI(
    title="E.R.T.H | Employee Route Tracking Hub",
    description="Backend API for Employee Route Tracking Hub",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Schemas ---
class LoginRequest(BaseModel):
    email: str
    password: str

class SignupRequest(BaseModel):
    full_name: str
    email: str
    password: str
    role: str
    mobile_number: str
    employee_id: Optional[str] = None
    department: Optional[str] = None
    license_number: Optional[str] = None

class DecisionRequest(BaseModel):
    status: str

class PickupPointRequest(BaseModel):
    latitude: float
    longitude: float
    label: str = ""

# --- Auth API Routes ---

@app.post("/api/v1/auth/signup")
def signup(payload: SignupRequest):
    if payload.role == "employee":
        if not validate_employee_email(payload.email):
            raise HTTPException(
                status_code=400, 
                detail="Employee email must be under the .aditiconsulting.com domain"
            )
            
    existing_user = users_col.find_one({"email": payload.email.lower()})
    if existing_user:
        raise HTTPException(status_code=400, detail="User already exists with this email")
            
    new_user = {
        "id": str(uuid.uuid4()),
        "full_name": payload.full_name,
        "email": payload.email.lower(),
        "password": payload.password,
        "role": payload.role,
        "status": "pending",
        "mobile_number": payload.mobile_number,
        "employee_id": payload.employee_id,
        "department": payload.department,
        "license_number": payload.license_number
    }
    users_col.insert_one(new_user)
    return clean_user(new_user)

@app.post("/api/v1/auth/login")
def login(payload: LoginRequest):
    user = users_col.find_one({"email": payload.email.lower()})
    if not user or user["password"] != payload.password:
        raise HTTPException(status_code=401, detail="Invalid email or password")
        
    if user["role"] == "employee":
        if not validate_employee_email(user["email"]):
            raise HTTPException(
                status_code=400, 
                detail="Employee login is restricted to the .aditiconsulting.com domain"
            )
            
    if user["status"] != "approved" and user["role"] not in ("admin", "supervisor"):
        raise HTTPException(status_code=403, detail="Account awaiting approval")
        
    token = generate_token(user["email"], user["role"])
    return {
        "access_token": token,
        "role": user["role"]
    }

@app.get("/api/v1/auth/me")
def me(current_user: dict = Depends(get_current_user_from_token)):
    return {
        "id": current_user["id"],
        "full_name": current_user["full_name"],
        "email": current_user["email"],
        "role": current_user["role"],
        "status": current_user["status"],
        "pickup_point": current_user.get("pickup_point")
    }

@app.get("/api/v1/clock")
def get_system_clock(current_user: dict = Depends(get_current_user_from_token)):
    from app.core.clock import get_now, get_today_ist
    from app.core.database import db
    settings = db["system_settings"].find_one({"key": "clock"})
    use_custom = False
    multiplier = 1.0
    custom_time = ""
    set_at_real_time = ""
    if settings:
        use_custom = settings.get("use_custom_time", False)
        multiplier = settings.get("multiplier", 1.0)
        custom_time = settings.get("custom_time")
        set_at_real_time = settings.get("set_at_real_time")
        
    return {
        "use_custom_time": use_custom,
        "custom_time": custom_time,
        "set_at_real_time": set_at_real_time,
        "multiplier": multiplier,
        "virtual_now": get_now().isoformat(),
        "virtual_today_ist": get_today_ist().isoformat()
    }

@app.put("/api/v1/users/me/pickup-point")
def update_pickup_point(payload: PickupPointRequest, current_user: dict = Depends(get_current_user_from_token)):
    pickup_data = {
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "label": payload.label,
    }
    users_col.update_one(
        {"id": current_user["id"]},
        {"$set": {"pickup_point": pickup_data}}
    )
    return {"pickup_point": pickup_data}

@app.get("/api/v1/auth/pending")
def pending_users(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admin can view pending users")
    pending = users_col.find({"status": "pending"})
    return [clean_user(u) for u in pending]

@app.post("/api/v1/auth/{user_id}/decision")
def decide_request(user_id: str, payload: DecisionRequest, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admin can approve/reject users")
    user_to_update = users_col.find_one({"id": user_id})
    if not user_to_update:
        raise HTTPException(status_code=404, detail="User not found")
    
    if payload.status == "rejected":
        users_col.delete_one({"id": user_id})
        return {"message": f"User {user_to_update['full_name']} has been rejected and deleted"}
    else:
        users_col.update_one({"id": user_id}, {"$set": {"status": payload.status}})
        return {"message": f"User {user_to_update['full_name']} marked as {payload.status}"}

@app.get("/api/v1/users")
def get_users(
    current_user: dict = Depends(get_current_user_from_token),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100)
):
    if current_user["role"] not in ("admin", "supervisor"):
        raise HTTPException(status_code=403, detail="Only admin or supervisor can list users")
    total = users_col.count_documents({})
    skip = (page - 1) * limit
    all_users = users_col.find({}).skip(skip).limit(limit)
    import math
    return {
        "items": [clean_user(u) for u in all_users],
        "total": total,
        "page": page,
        "pages": math.ceil(total / limit) if total > 0 else 1
    }

# --- Router Inclusions ---
app.include_router(analytics.router)
app.include_router(rides.router)
app.include_router(tracking.router)
app.include_router(notification.router)
app.include_router(ride_groups.router)
app.include_router(availability.router)
app.include_router(developer.router)
app.include_router(calendar.router)

# --- Static Frontend Serving ---
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
