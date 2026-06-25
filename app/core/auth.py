import base64
from typing import Optional
from fastapi import HTTPException, Depends, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.database import load_db

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