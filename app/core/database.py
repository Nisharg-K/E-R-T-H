import os
from typing import Optional
# pyrefly: ignore [missing-import]
from pymongo import MongoClient

def get_mongo_uri():
    uri = os.environ.get("MGDB_CONNECTION_STRING")
    if uri:
        return uri
    if os.path.exists(".env"):
        with open(".env", "r") as f:
            for line in f:
                if line.strip().startswith("MGDB_CONNECTION_STRING"):
                    parts = line.split("=", 1)
                    if len(parts) == 2:
                        return parts[1].strip()
    return None

MONGO_URI = get_mongo_uri()
if not MONGO_URI:
    raise RuntimeError("MGDB_CONNECTION_STRING not found in environment or .env file")

client = MongoClient(MONGO_URI)
db = client["erth"]
users_col = db["users"]
ride_groups_col = db["ride_groups"]

# Seed supervisor account if not present
if not users_col.find_one({"email": "supervisor@aditiconsulting.com"}):
    users_col.insert_one({
        "id": "supervisor-id-001",
        "full_name": "ERTH Supervisor",
        "email": "supervisor@aditiconsulting.com",
        "password": "sup3rv!s0r",
        "role": "supervisor",
        "status": "approved",
        "mobile_number": "+91 00000 00000",
    })

def clean_user(doc: dict) -> Optional[dict]:
    if not doc:
        return None
    doc = dict(doc)
    doc.pop("_id", None)
    return doc