import uvicorn
import uuid
from typing import Optional
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Core internal utility dependencies
from app.core.database import init_db, load_db, save_db
from app.core.auth import get_current_user_from_token, generate_token, validate_employee_email
from app.routers import analytics, rides, tracking, notification

app = FastAPI(
    title="E.R.T.H | Employee Route Tracking Hub",
    description="Backend API for Employee Route Tracking Hub",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

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

# --- Auth API Routes ---

@app.post("/api/v1/auth/signup")
def signup(payload: SignupRequest):
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

# --- Router Inclusions ---
app.include_router(analytics.router)
app.include_router(rides.router)
app.include_router(tracking.router)
app.include_router(notification.router)

# --- Static Frontend Serving ---
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)