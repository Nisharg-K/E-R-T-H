import os
import json

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