"""
RAG-based AI Chat assistant for ERTH Admin portal.

Flow:
  1. Receive question + conversation history
  2. Detect intent and retrieve relevant MongoDB context
  3. Build an augmented system prompt with that context
  4. Call GLM-5 (via OpenAI-compatible API) and stream tokens back
  5. Return the full answer (SSE streaming handled by frontend polling)
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional
from app.core.database import users_col, ride_groups_col
from app.core.auth import get_current_user_from_token
import os, re, json
from openai import OpenAI

router = APIRouter(prefix="/api/v1/ai", tags=["AI Chat"])

# ── GLM-5 client ────────────────────────────────────────────────────────────

def _get_client() -> OpenAI:
    api_key  = os.getenv("OPENAI_API_KEY", "")
    base_url = os.getenv("OPENAI_BASE_URL", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not configured in .env")
    kwargs = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    return OpenAI(**kwargs)

MODEL = os.getenv("OPENAI_MODEL", "glm-5")

# ── Schemas ──────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str       # "user" | "assistant"
    content: str

class ChatRequest(BaseModel):
    question: str
    history: List[ChatMessage] = []

# ── Month helpers ────────────────────────────────────────────────────────────

MONTH_MAP = {
    "january": "01", "february": "02", "march": "03", "april": "04",
    "may": "05", "june": "06", "july": "07", "august": "08",
    "september": "09", "october": "10", "november": "11", "december": "12",
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "jun": "06", "jul": "07", "aug": "08",
    "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}

def _detect_month(q: str):
    for name, num in MONTH_MAP.items():
        if re.search(rf"\b{name}\b", q):
            return name, num
    return None, None

def _detect_year(q: str) -> str:
    m = re.search(r"\b(202\d)\b", q)
    return m.group(1) if m else "2026"

# ── Name matching helper ─────────────────────────────────────────────────────

def _find_user_by_name(q: str, role: Optional[str] = None):
    filt = {}
    if role:
        filt["role"] = role
    candidates = list(users_col.find(filt, {"id": 1, "full_name": 1, "role": 1}))
    q_lower = q.lower()
    for user in candidates:
        name_parts = user.get("full_name", "").lower().split()
        for part in name_parts:
            if len(part) > 2 and part in q_lower:
                return user
    return None

# ── Context retrieval ────────────────────────────────────────────────────────

def retrieve_context(question: str) -> str:
    q     = question.lower()
    parts = []

    month_name, month_num = _detect_month(q)
    year = _detect_year(q)

    # ── 1. Monthly billing / trip count ──────────────────────────────────────
    billing_kws  = ["total", "billing", "cost", "amount", "spend", "spent", "revenue", "how much"]
    ride_kws     = ["trip", "ride", "route", "how many rides", "how many trips", "count"]
    is_billing   = any(kw in q for kw in billing_kws)
    is_ride_q    = any(kw in q for kw in ride_kws)

    if month_name and (is_billing or is_ride_q):
        prefix = f"{year}-{month_num}"
        rides  = list(ride_groups_col.find({
            "status": "completed",
            "ride_date": {"$regex": f"^{prefix}"}
        }))

        total_cost = sum(r.get("total_cost", 0) for r in rides)
        parts.append(f"=== Billing data for {month_name.capitalize()} {year} ===")
        parts.append(f"Total completed rides: {len(rides)}")
        parts.append(f"Total billing amount: INR {total_cost:,.2f}")
        if rides:
            avg = total_cost / len(rides)
            parts.append(f"Average cost per trip: INR {avg:,.2f}")

            # Driver breakdown (top 8)
            d_stats: dict = {}
            for r in rides:
                did = r.get("driver_id")
                if did:
                    if did not in d_stats:
                        drv = users_col.find_one({"id": did})
                        d_stats[did] = {
                            "name": drv.get("full_name", "Unknown") if drv else "Unknown",
                            "trips": 0, "cost": 0.0
                        }
                    d_stats[did]["trips"] += 1
                    d_stats[did]["cost"]  += r.get("total_cost", 0)

            parts.append("Driver breakdown (top 8 by cost):")
            for d in sorted(d_stats.values(), key=lambda x: x["cost"], reverse=True)[:8]:
                parts.append(f"  {d['name']}: {d['trips']} trips, INR {d['cost']:,.2f}")

    # ── 2. Co-passenger / travel companion query ──────────────────────────────
    copass_kws = ["co-passenger", "copassenger", "rode with", "traveled with",
                  "with whom", "who was with", "travel companion", "fellow passenger"]
    if any(kw in q for kw in copass_kws) or ("with" in q and "passenger" in q):
        emp = _find_user_by_name(q, role="employee")

        if emp:
            emp_id   = emp["id"]
            emp_name = emp["full_name"]
            query    = {"passenger_ids": emp_id, "status": "completed"}

            # Filter by month if mentioned
            if month_name:
                prefix = f"{year}-{month_num}"
                query["ride_date"] = {"$regex": f"^{prefix}"}

            # Filter by specific date (YYYY-MM-DD)
            date_m = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", q)
            if date_m:
                query["ride_date"] = date_m.group(1)

            # Also handle "15 july" style
            day_m = re.search(r"\b(\d{1,2})\s+" + "|".join(MONTH_MAP.keys()), q)
            if day_m and month_name:
                day = day_m.group(1).zfill(2)
                query["ride_date"] = f"{year}-{month_num}-{day}"

            rides = list(ride_groups_col.find(query).sort("ride_date", -1).limit(15))
            parts.append(f"\n=== Rides involving {emp_name} ===")
            if rides:
                for r in rides:
                    co_ids   = [pid for pid in r.get("passenger_ids", []) if pid != emp_id]
                    co_names = []
                    for pid in co_ids:
                        p = users_col.find_one({"id": pid}, {"full_name": 1})
                        if p:
                            co_names.append(p["full_name"])
                    parts.append(
                        f"  Date: {r.get('ride_date','N/A')} | Route: {r.get('name','N/A')} | "
                        f"Co-passengers: {', '.join(co_names) if co_names else 'None'}"
                    )
            else:
                parts.append(f"  No completed rides found for {emp_name} with the given filters.")
        else:
            parts.append("\n(Could not identify a specific employee name in the question.)")

    # ── 3. Driver trips query ─────────────────────────────────────────────────
    if any(kw in q for kw in ["driver", "how many trips", "trips done", "trips completed"]):
        drv = _find_user_by_name(q, role="driver")
        if drv:
            query = {"driver_id": drv["id"], "status": "completed"}
            if month_name:
                prefix = f"{year}-{month_num}"
                query["ride_date"] = {"$regex": f"^{prefix}"}
            rides      = list(ride_groups_col.find(query))
            total_cost = sum(r.get("total_cost", 0) for r in rides)
            parts.append(f"\n=== Driver profile: {drv['full_name']} ===")
            scope = f"in {month_name.capitalize()} {year}" if month_name else "overall"
            parts.append(f"Completed trips {scope}: {len(rides)}")
            parts.append(f"Total billing {scope}: INR {total_cost:,.2f}")

    # ── 4. Pending approvals ──────────────────────────────────────────────────
    if any(kw in q for kw in ["pending", "approval", "waiting", "approve", "not yet approved"]):
        pending = list(users_col.find({"status": "pending"}, {"full_name": 1, "role": 1, "email": 1}))
        parts.append(f"\n=== Pending approval requests: {len(pending)} ===")
        for p in pending[:15]:
            parts.append(f"  {p.get('full_name','?')} ({p.get('role','?')}): {p.get('email','')}")

    # ── 5. Staff headcount ────────────────────────────────────────────────────
    if any(kw in q for kw in ["how many employees", "total employees", "staff count", "how many drivers", "total drivers", "headcount"]):
        emp_count = users_col.count_documents({"role": "employee", "status": "approved"})
        drv_count = users_col.count_documents({"role": "driver", "status": "approved"})
        parts.append(f"\n=== Staff headcount ===")
        parts.append(f"Approved employees: {emp_count}")
        parts.append(f"Approved drivers: {drv_count}")

    # ── 6. Specific employee ride lookup ──────────────────────────────────────
    if any(kw in q for kw in ["rides of", "trips of", "history of", "rides for", "trips for"]):
        person = _find_user_by_name(q)
        if person:
            pid   = person["id"]
            query = {
                "$or": [{"passenger_ids": pid}, {"driver_id": pid}],
                "status": "completed"
            }
            if month_name:
                query["ride_date"] = {"$regex": f"^{year}-{month_num}"}
            rides = list(ride_groups_col.find(query).sort("ride_date", -1).limit(10))
            parts.append(f"\n=== Ride history for {person['full_name']} ===")
            for r in rides:
                parts.append(
                    f"  {r.get('ride_date','?')} | {r.get('name','?')} | "
                    f"{r.get('route_type','?')} | INR {r.get('total_cost',0):,.2f}"
                )

    # ── 7. Fallback: general system stats ─────────────────────────────────────
    if not parts:
        emp   = users_col.count_documents({"role": "employee", "status": "approved"})
        drvs  = users_col.count_documents({"role": "driver",   "status": "approved"})
        actv  = ride_groups_col.count_documents({"status": {"$in": ["ongoing", "pending", "draft"]}})
        done  = ride_groups_col.count_documents({"status": "completed"})
        pend  = users_col.count_documents({"status": "pending"})
        parts.append("=== ERTH System Snapshot ===")
        parts.append(f"Approved employees: {emp}")
        parts.append(f"Approved drivers: {drvs}")
        parts.append(f"Active/pending rides: {actv}")
        parts.append(f"Total completed rides: {done}")
        parts.append(f"Pending user approvals: {pend}")

    return "\n".join(parts)

# ── System prompt ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are ERTH Assistant, an intelligent AI embedded in the ERTH (Employee Route Tracking Hub) admin portal.
ERTH manages employee cab pickups and drops for a consulting company.

You have been given live data retrieved from the ERTH database as context below.
Answer the admin's question using ONLY the provided data — do not make up numbers or names.
Be concise, factual, and friendly. Use bullet points or short tables when listing multiple items.
Always express costs in INR (Indian Rupees) using the ₹ symbol.
If you cannot find enough context to answer, say so honestly and suggest what the admin can look for.
"""

# ── Streaming endpoint ────────────────────────────────────────────────────────

@router.post("/chat")
async def ai_chat(
    payload: ChatRequest,
    current_user: dict = Depends(get_current_user_from_token)
):
    if current_user.get("role") not in ("admin", "supervisor"):
        raise HTTPException(status_code=403, detail="Not authorized")

    # Retrieve context
    try:
        context = retrieve_context(payload.question)
    except Exception as e:
        context = f"(Context retrieval failed: {e})"

    # Build messages for LLM
    system_content = SYSTEM_PROMPT + "\n\n--- LIVE DATA CONTEXT ---\n" + context + "\n--- END CONTEXT ---"
    messages = [{"role": "system", "content": system_content}]

    # Include conversation history (last 10 turns for context window)
    for msg in payload.history[-10:]:
        messages.append({"role": msg.role, "content": msg.content})

    messages.append({"role": "user", "content": payload.question})

    # Stream from GLM-5
    try:
        client = _get_client()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    def event_stream():
        try:
            stream = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                max_tokens=1500,
                temperature=0.3,
                stream=True,
            )
            for chunk in stream:
                choices = getattr(chunk, "choices", None)
                if not choices:
                    continue
                delta = getattr(choices[0], "delta", None)
                if not delta:
                    continue
                token = getattr(delta, "content", None)
                if token:
                    # SSE format
                    yield f"data: {json.dumps({'token': token})}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )
