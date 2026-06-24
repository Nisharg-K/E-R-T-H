import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

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

# Example API Route (can be expanded later)
@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "E.R.T.H API is healthy"}

# Mount static files to serve the frontend
# Note: html=True maps the root URL "/" to index.html automatically.
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
