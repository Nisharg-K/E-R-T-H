# ── Build stage ──────────────────────────────────────────────────────────────
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install dependencies first (cached layer if requirements don't change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/
COPY frontend/ ./frontend/
COPY run.py .

# Expose the port Render will route traffic to
EXPOSE 8000

# Start uvicorn bound to all interfaces (required for Render)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
