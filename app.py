import uvicorn
import os
import json
import uuid
import base64
from typing import Optional, Dict, List
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException, Depends, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

app = FastAPI(
    title="E.R.T.H | Employee Route Tracking Hub",
    description="Backend API for Employee Route Tracking Hub",
    version="1.0.0"
)

# Enable CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Database & Auth Scaffolding ---
DB_FILE = "db.json"

def init_db():
    if not os.path.exists(DB_FILE):
        initial_data = {
            "users": [
                {
                    "id": "admin-id-123",
                    "full_name": "System Administrator",
                    "email": "admin@aditiconsulting.com",
                    "password": "admin123",
                    "role": "admin",
                    "status": "approved",
                    "mobile_number": "+1234567890",
                    "employee_id": "ADMIN-01",
                    "department": "IT"
                },
                {
                    "id": "employee-id-123",
                    "full_name": "Aditi Employee",
                    "email": "employee@aditiconsulting.com",
                    "password": "employee123",
                    "role": "employee",
                    "status": "approved",
                    "mobile_number": "+1987654321",
                    "employee_id": "EMP-001",
                    "department": "Engineering"
                },
                {
                    "id": "driver-id-123",
                    "full_name": "Aditi Driver",
                    "email": "driver@aditiconsulting.com",
                    "password": "driver123",
                    "role": "driver",
                    "status": "approved",
                    "mobile_number": "+1555666777",
                    "license_number": "DL-99999999"
                }
            ]
        }
        with open(DB_FILE, "w") as f:
            json.dump(initial_data, f, indent=2)

def load_db():
    init_db()
    with open(DB_FILE, "r") as f:
        return json.load(f)

def save_db(data):
    with open(DB_FILE, "w") as f:
        json.dump(data, f, indent=2)

# Run database initializer
init_db()

# --- Auth Token Utilities ---
def generate_token(email: str, role: str) -> str:
    token_str = f"{email}:{role}"
    return base64.b64encode(token_str.encode()).decode()

def decode_token(token: str) -> Optional[dict]:
    try:
        decoded = base64.b64decode(token.encode()).decode()
        email, role = decoded.split(":", 1)
        return {"email": email, "role": role}
    except Exception:
        return None

security = HTTPBearer()

def get_current_user_from_token(credentials: HTTPAuthorizationCredentials = Security(security)) -> dict:
    token = credentials.credentials
    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    db_data = load_db()
    for user in db_data["users"]:
        if user["email"].lower() == payload["email"].lower():
            return user
            
    raise HTTPException(status_code=401, detail="User not found")

# --- Validation Helper ---
def validate_employee_email(email: str) -> bool:
    parts = email.split("@")
    if len(parts) != 2:
        return False
    domain = parts[1].lower()
    return domain == "aditiconsulting.com" or domain.endswith(".aditiconsulting.com")

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

# --- API Routes ---

@app.post("/api/v1/auth/signup")
def signup(payload: SignupRequest):
    # Validate employee domain
    if payload.role == "employee":
        if not validate_employee_email(payload.email):
            raise HTTPException(
                status_code=400, 
                detail="Employee email must be under the .aditiconsulting.com domain"
            )
            
    db_data = load_db()
    for u in db_data["users"]:
        if u["email"].lower() == payload.email.lower():
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
    db_data["users"].append(new_user)
    save_db(db_data)
    return {
        "id": new_user["id"],
        "full_name": new_user["full_name"],
        "email": new_user["email"],
        "role": new_user["role"],
        "status": new_user["status"]
    }

@app.post("/api/v1/auth/login")
def login(payload: LoginRequest):
    db_data = load_db()
    user = None
    for u in db_data["users"]:
        if u["email"].lower() == payload.email.lower():
            user = u
            break
            
    if not user or user["password"] != payload.password:
        raise HTTPException(status_code=401, detail="Invalid email or password")
        
    if user["role"] == "employee":
        if not validate_employee_email(user["email"]):
            raise HTTPException(
                status_code=400, 
                detail="Employee login is restricted to the .aditiconsulting.com domain"
            )
            
    # Admin bypasses approval check. Drivers and Employees must be approved.
    if user["status"] != "approved" and user["role"] != "admin":
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
        "status": current_user["status"]
    }

@app.get("/api/v1/auth/pending")
def pending_users(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admin can view pending users")
    db_data = load_db()
    pending = [
        {
            "id": u["id"],
            "full_name": u["full_name"],
            "email": u["email"],
            "role": u["role"],
            "status": u["status"]
        }
        for u in db_data["users"] if u["status"] == "pending"
    ]
    return pending

@app.post("/api/v1/auth/{user_id}/decision")
def decide_request(user_id: str, payload: DecisionRequest, current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admin can approve/reject users")
    db_data = load_db()
    user_to_update = None
    for u in db_data["users"]:
        if u["id"] == user_id:
            user_to_update = u
            break
    if not user_to_update:
        raise HTTPException(status_code=404, detail="User not found")
    user_to_update["status"] = payload.status
    save_db(db_data)
    return {"message": f"User {user_to_update['full_name']} marked as {payload.status}"}

@app.get("/api/v1/users")
def get_users(current_user: dict = Depends(get_current_user_from_token)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Only admin can list users")
    db_data = load_db()
    return [
        {
            "id": u["id"],
            "full_name": u["full_name"],
            "email": u["email"],
            "role": u["role"],
            "status": u["status"]
        }
        for u in db_data["users"]
    ]

# --- Dashboard & Tracking Mock Endpoints ---

@app.get("/api/v1/analytics/dashboard")
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

@app.get("/api/v1/rides")
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

@app.get("/api/v1/notifications")
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

@app.get("/api/v1/tracking/active")
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

@app.post("/api/v1/ai-chat")
def ai_chat(payload: dict, current_user: dict = Depends(get_current_user_from_token)):
    return {"answer": "AI Chat integration will be set up in a future module. Stay tuned!"}

# --- Static Frontend Serving ---
# Mount static files to serve the frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
