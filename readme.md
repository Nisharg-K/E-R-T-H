# ERTH - Employee Ride & Trip Hub

ERTH is a comprehensive web application designed to manage employee transportation, ride scheduling, driver tracking, and administrative tasks. It provides distinct dashboards and functionalities tailored for various user roles, including Admin, Supervisor, Employee, Driver, and Developer.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [User Roles & Dashboards](#user-roles--dashboards)
- [Real-time Capabilities](#real-time-capabilities)
- [Map Integration](#map-integration)
- [Key Backend Services](#key-backend-services)
- [Developer Tools](#developer-tools)
- [Recent Enhancements](#recent-enhancements)
- [Technology Stack](#technology-stack)

## Features

- **Role-Based Access Control:** Tailored interfaces and functionalities for each user role.
- **Dynamic Ride Scheduling:** Creation and management of ride groups, including recurring rides.
- **Live Driver Tracking:** Real-time location updates for drivers and visibility for relevant stakeholders.
- **Employee Availability Management:** Employees can mark themselves unavailable for pickup/drop services.
- **Automated Notifications:** Alerts for ride status changes, availability updates, and system events.
- **Interactive Maps:** Visualization of driver locations, pickup/drop routes, and employee home locations.
- **Billing & Analytics:** Detailed financial ledgers and summary statistics for administrators.
- **AI Chatbot Integration:** (Planned) for querying trip data and system information.
- **Developer Tools:** Utilities for testing and debugging, such as virtual clock and driver spoofing.

## Architecture

ERTH follows a client-server architecture:

-   **Frontend:** Built with HTML, CSS, and JavaScript, providing a dynamic and responsive user interface. It handles user interactions, data presentation, and real-time updates.
-   **Backend:** Powered by FastAPI (Python), offering a robust and scalable API layer. It manages business logic, data persistence, authentication, and real-time communication.
-   **Database:** MongoDB (NoSQL) is used for data storage, providing flexibility and performance.
-   **Authentication:** JWT (JSON Web Tokens) are used for secure user authentication and authorization across API endpoints.
-   **Real-time Communication:** WebSockets are extensively used for live tracking and instant notifications, with HTTP polling as a fallback mechanism.

## User Roles & Dashboards

ERTH supports the following user roles, each with a dedicated dashboard:

-   **Admin:**
    -   **Overview Dashboard:** Key metrics, system health.
    -   **Approvals:** Manage pending user registrations.
    -   **Rides:** View and manage all ride groups.
    -   **People:** User management.
    -   **AI Chat:** Interact with the AI assistant for data queries.
    -   **Map:** Global view of all active drivers and employees.
    -   **Billing:** Financial ledger and export.
-   **Supervisor:**
    -   **Ride Groups:** Create, edit, and manage ride groups, assign drivers, and define pickup/drop orders.
    -   **Employee Map:** Visualize all employee pickup points.
    -   **Unavailability:** View employee leave and unavailability logs.
    -   **Calendar:** Overview of schedules, leave dates, and rerouting signals.
-   **Employee:**
    -   **Current Ride:** View live status and driver location for their assigned ride.
    -   **Ride History:** Access past trip details.
    -   **Cab Unavailability:** Inform the system about days they don't need cab services.
    -   **Daily Pickup Settings:** Configure personal pickup points.
    -   **Calendar:** View personal ride schedules and mark themselves "boarded".
-   **Driver:**
    -   **Current Ride:** View their assigned route, passenger list, and update trip status (start, complete, delay).
    -   **Ride History:** Access past trip details.
    -   **Cab Unavailability:** Manage their own availability.
    -   **Calendar:** View their assigned ride schedules.
    -   **Live Location Tracking:** Automatically sends GPS data to the backend.
-   **Developer:**
    -   **Clock Control:** Manipulate the system's virtual time and speed for testing.
    -   **Driver Spoofer:** Simulate driver movements on a map.
    -   **Scheduler Trigger:** Manually trigger background tasks.

## Real-time Capabilities

The application leverages WebSockets for a highly responsive user experience:

-   **Live Driver Tracking:** Drivers continuously send their GPS coordinates via WebSocket. These updates are broadcast to all relevant viewers (Admin, Supervisor, Employee) in real-time, updating their respective maps.
-   **Route Change Notifications:** Any changes to ride groups or employee availability trigger WebSocket broadcasts, ensuring dashboards are always up-to-date.
-   **Fallback Mechanism:** If WebSockets are unavailable, the system gracefully falls back to HTTP polling for tracking and notifications.

## Map Integration

Leaflet.js is used for interactive map visualizations across various dashboards:

-   **Dynamic Route Rendering:**
    -   **Pickup Routes:** Displayed from employee homes (sequenced) to the office.
    -   **Drop Routes:** Displayed from the office to employee homes (sequenced).
    -   Routes are dynamically adjusted based on daily employee availability.
-   **OSRM Integration:** Utilizes the Open Source Routing Machine (OSRM) for accurate road-based routing, with a fallback to straight-line polylines if OSRM is unavailable.
-   **Marker Management:**
    -   **Driver Markers:** Show current driver locations, with popups for details.
    -   **Employee Pickup Points:** Displayed on supervisor and employee maps.
    -   **Office Location:** A fixed marker for the central office.
    -   **Clustering/Separation:** Logic to prevent marker overlap when multiple drivers are at the same location.
-   **Map Controls:** Zoom in/out buttons, with careful `z-index` management to prevent UI overlaps.

## Key Backend Services

-   **Employee Availability (`/api/v1/availability`):**
    -   Allows employees to declare `pickup_not_needed` or `drop_not_needed` for specific dates.
    -   Enforces a 4-hour deadline before ride departure for changes.
    -   Notifies admins, supervisors, and assigned drivers of availability changes.
    -   `_find_relevant_group` intelligently identifies active ride groups (one-time or recurring) for an employee on a given date.
-   **Ride Groups (`/api/v1/ride-groups`):**
    -   Manages the creation, updating, and deletion of ride groups.
    -   Supports recurring ride groups with specific days of the week and departure times.
    -   Includes a "relist" workflow to toggle `route_type` (pickup/drop) and reset passenger statuses for completed rides.
-   **Route Service (`app/core/route_service.py`):**
    -   A core utility that dynamically builds "effective" daily routes for ride groups.
    -   It applies employee availability exceptions to the base ride group configuration without altering the persistent data.
    -   Ensures that only passengers requiring service on a given day are included in the active route.
-   **Notifications (`/api/v1/notifications`):**
    -   Manages system notifications for users.
    -   Provides endpoints to fetch and mark notifications as read.
    -   Integrates with availability and ride group changes to generate relevant alerts.

## Developer Tools

The Developer dashboard provides powerful tools for testing and simulation:

-   **Virtual Clock Control:**
    -   Set a custom system time.
    -   Adjust the time progression speed (e.g., 10x, 60x, 3600x).
    -   Allows testing time-sensitive features (e.g., deadlines, recurring schedules) rapidly.
-   **Driver Spoofer:**
    -   Select any registered driver.
    -   Enable/disable spoofing for that driver.
    -   Manually move the driver's location on a map using a draggable marker or WASD controls.
    -   Mocked locations are broadcast in real-time via WebSockets, simulating live driver movement.
-   **Manual Scheduler Trigger:**
    -   Force-runs the background scheduler logic, which is responsible for spawning recurring rides and other time-based tasks.

## Recent Enhancements

The project has recently undergone significant improvements, including:

-   **Dynamic Pickup/Drop Route Toggling:** Ride groups now have a `route_type` field. The `/relist` endpoint intelligently toggles this type (pickup ↔ drop) for completed rides, streamlining the workflow for recurring routes.
-   **Direction-Aware Map Rendering:** Driver and Employee maps now dynamically adapt to display routes correctly for both pickup (to office) and drop (from office) directions, including sequenced stops and completion checks.
-   **Passenger "I've Reached Home" Button:** For employees on drop routes, a dedicated button allows them to mark their arrival at home, triggering status updates and notifications.
-   **Supervisor Trip Cost Management:** Supervisors can now configure a `total_cost` for each ride group, which is displayed in tables and used in billing.
-   **Dedicated Admin Billing Spreadsheet & Excel Export:** A new Admin page provides a detailed, filterable spreadsheet view of all completed ride billing records, complete with summary cards and a CSV export feature for easy data analysis.

## Technology Stack

-   **Frontend:** HTML, CSS (with custom variables and responsive design), JavaScript (ES6+), Leaflet.js (for maps).
-   **Backend:** Python 3.x, FastAPI, MongoDB (via PyMongo).
-   **Real-time:** WebSockets.
-   **Routing:** Open Source Routing Machine (OSRM).
-   **Deployment:** (Implicitly) designed for web deployment.

---

This `README.md` provides a high-level overview of the ERTH project. For detailed implementation specifics, please refer to the individual source code files and their respective comments.
```

<!--
[PROMPT_SUGGESTION]Can you explain how the `_find_relevant_group` function in `app/routers/availability.py` handles both one-time and recurring ride groups?[/PROMPT_SUGGESTION]
[PROMPT_SUGGESTION]Show me how the `app.js` frontend code interacts with the virtual clock and driver spoofer features in the developer dashboard.[/PROMPT_SUGGESTION]
