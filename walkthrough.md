# Walkthrough: Dynamic Pickup/Drop Routing, Relisting Workflow & Dedicated Admin Billing Ledger Spreadsheet

We have successfully implemented direction-aware routing templates, updated the ride completion relisting workflow, and added a dedicated Excel-like Billing Spreadsheet tab to the Admin Portal.

---

## 1. Dynamic Pickup/Drop Route Toggling
- Added a `route_type` field (defaulting to `"pickup"`) to the ride group schemas in `app/routers/ride_groups.py`.
- **Relisting Workflow:** Modified the `/relist` endpoint on completed ride groups to automatically toggle the `route_type` (from `"pickup"` to `"drop"`, and vice-versa) while resetting passenger statuses back to `"pending"` and setting the group status back to `"draft"`.
- **Supervisor Labeling:** The button on completed rides in the Supervisor Dashboard is now dynamically labeled **"List Drop Route"** (if the completed ride was a pickup) or **"List Pickup Route"** (if it was a drop).

---

## 2. Direction-Aware Map Rendering & Sequences
- Modified the Driver and Employee maps in `frontend/js/app.js` to dynamically handle both `"pickup"` and `"drop"` route types:
  - **Pickup Direction:** Starts at passenger homes (sequenced `1, 2, 3...` in `pickup_order`) and draws the final leg ending at the **Office**. Stop completion checks are mapped to passenger boarding (`boarded`).
  - **Drop Direction:** Starts at the **Office** and ends at the passenger homes (sequenced `1, 2, 3...` in `drop_order`). Stop completion checks are mapped to passenger arrival (`dropped`).
- Modified `app/routers/rides.py` to return the correct cards metadata (including `pickup_point` and `drop_point` swapped based on direction).

---

## 3. Passenger "I've Reached Home" Button for Drop Routes
- **Backend Endpoint (`app/routers/calendar.py`):** Added `@router.post("/rides/{ride_group_id}/reach-home")` to allow employee passengers to mark themselves as `"dropped"` (Reached Home) for drop routes, triggering notifications and WebSocket map broadcasts.
- **Frontend Card Rendering (`frontend/js/app.js`):**
  - Displays **"I've Reached Home"** (in green) instead of "I've Boarded the Cab" on the Employee Dashboard card list when the ride is active in `"drop"` direction.
  - Updates the passenger list item status text to `"Reached Home at [Time]"` or `"In Transit"` based on the state.
  - Toggles the dashboard header badge status dynamically to `"Reached Home"` when completed.

---

## 4. Supervisor Trip Cost Management
- **Frontend Form Input (`frontend/pages/supervisor.html`):** Added a new form group field **"Trip Cost (INR)"** to configure/edit the cost (defaulting to `150.00`) of the ride group.
- **Form Synchronization (`frontend/js/app.js`):**
  - Added logic to load the existing `total_cost` value when editing a ride group.
  - Resets the cost value back to `150.00` upon clearing/resetting the form.
  - Appends the custom cost value as `total_cost` inside the creation/update JSON submission payload.
- **Existing Groups Table:** Added a **"Cost"** column displaying the configured trip cost (e.g. `₹150.00`) for all active ride groups.

---

## 5. Dedicated Admin Billing Spreadsheet & Excel Export
- **Dedicated Billing Page (`frontend/pages/admin-billing.html`):** Created a new page containing summary cards for Monthly Cost, Total Trips, and Average Cost/Trip, dropdown filters for Month and Driver, a detailed spreadsheet-like tabular log of monthly completed rides, and a download export button.
- **Excel-Style Cost Footer Sums:** Computes and renders a highlighted sum total row (`<tfoot>` equivalent) summing up the `total_cost` values of all displayed trips.
- **CSV Excel Export:** Clicking **"Export Excel (CSV)"** generates and triggers a download of a complete CSV spreadsheet document containing all listed ride columns and the final bottom sum row.
- **Sidebar Integration:** Integrated the new active/inactive nav links to `"admin-billing.html"` across all Admin pages.
