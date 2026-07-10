const AUTH_ROLE_ROUTES = {
  admin: "./pages/admin.html",
  employee: "./pages/employee.html",
  driver: "./pages/driver.html",
  escort: "./pages/escort.html",
  supervisor: "./pages/supervisor.html",
};

const PAGE_ROLE_ROUTES = {
  admin: "./admin.html",
  employee: "./employee.html",
  driver: "./driver.html",
  escort: "./escort.html",
  supervisor: "./supervisor.html",
};

const state = {
  token: sessionStorage.getItem("cms-token"),
  role: sessionStorage.getItem("cms-role"),
  currentUser: null,
  map: null,
  mapReady: false,
  mapCentered: false,
  markers: [],
  notificationCount: Number(sessionStorage.getItem("cms-notification-count") || 0),
  notificationPoll: null,
  trackingPoll: null,
  trackingWs: null,
  wsReconnectDelay: 1000,
  currentRide: null,
  driverLatLng: null,
  routeLayers: [],
  driverWs: null,
  allEmployeesMap: null,
  allEmployeeMarkers: [],
  geolocationWatchId: null,
};

const byId = (id) => document.getElementById(id);
const currentPage = document.body.dataset.page;
const roleLabel = (role) => (role === "employee" ? "user" : role);

const api = (path, options = {}) => fetch(path, {
  headers: {
    "Content-Type": "application/json",
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...(options.headers || {}),
  },
  ...options,
}).then(async (response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }
  return response.status === 204 ? null : response.json();
});

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("cms-theme", theme);
}

function initTheme() {
  const stored = localStorage.getItem("cms-theme");
  const preferred = stored || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  setTheme(preferred);
}

function persistSession(accessToken, role) {
  state.token = accessToken;
  state.role = role;
  sessionStorage.setItem("cms-token", accessToken);
  sessionStorage.setItem("cms-role", role);
}

function clearSession() {
  state.token = null;
  state.role = null;
  state.currentUser = null;
  sessionStorage.removeItem("cms-token");
  sessionStorage.removeItem("cms-role");
}

function redirectForRole(role) {
  const route = currentPage === "auth" ? AUTH_ROLE_ROUTES[role] : PAGE_ROLE_ROUTES[role];
  window.location.href = route || (currentPage === "auth" ? "./index.html" : "../index.html");
}

function isAdminPage() {
  return currentPage === "admin" || currentPage === "admin-approval" || currentPage === "admin-ride" || currentPage === "admin-people" || currentPage === "admin-map" || currentPage === "admin-ai";
}

function updateSessionBadge() {
  const badge = byId("sessionBadge");
  if (badge) {
    badge.textContent = state.currentUser ? `${state.currentUser.full_name} - ${roleLabel(state.currentUser.role)}` : "Signed out";
  }
}

function initDashboardDate() {
  const dateDisplay = byId("dashboardDate");
  const routeDateDisplay = byId("routeDateDisplay");
  
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  
  if (dateDisplay) {
    dateDisplay.textContent = dateStr;
  }
  
  if (routeDateDisplay) {
    routeDateDisplay.textContent = dateStr;
  }
}

function ensureMap() {
  if (state.mapReady || !window.L || !byId("liveMap")) return;
  state.map = L.map("liveMap").setView([22.32414, 73.16594], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
  state.mapReady = true;
}

function updateMap(markers) {
  ensureMap();
  if (!state.mapReady || !state.map) return;

  // Clear previous driver/cab markers
  state.markers.forEach((marker) => marker.remove());
  state.markers = [];

  // Clear any existing route layers (polylines, passenger/office markers)
  if (state.routeLayers) {
    state.routeLayers.forEach(layer => layer.remove());
  }
  state.routeLayers = [];

  const role = state.currentUser?.role;

  // --- Role 1: Admin or Supervisor ---
  if (role === "admin" || role === "supervisor") {
    // Live location of all active cabs
    state.markers = markers.map((marker) => (
      L.marker([marker.latitude, marker.longitude])
        .addTo(state.map)
        .bindPopup(`<strong>${marker.driver_name}</strong><br>${marker.cab_number || "Cab"}<br>${marker.recorded_at}`)
    ));

    // Center on first marker if not centered yet
    if (state.markers[0] && !state.mapCentered) {
      state.map.setView(state.markers[0].getLatLng(), 12);
      state.mapCentered = true;
    }
  }

  // --- Role 2: Driver ---
  else if (role === "driver") {
    // "Pickup plan, 1,2,3....n. Only when ride is on."
    const ride = state.currentRide;
    const isRideOn = ride && (ride.status === "started" || ride.status === "ongoing");
    
    // Draw driver self position marker
    if (state.driverLatLng) {
      const driverMarker = L.marker(state.driverLatLng, {
        icon: L.divIcon({
          className: 'driver-marker-icon',
          html: `<div style="background-color: #00ff66; color: #000; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid #000; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 0.85rem;">🚕</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        })
      })
      .addTo(state.map)
      .bindPopup(`<strong>Your Location</strong>`);
      state.markers.push(driverMarker);
    }

    if (isRideOn) {
      const pathCoords = [];
      if (state.driverLatLng) {
        pathCoords.push(state.driverLatLng);
      }

      // Add passenger pickup coordinates and plot numbered markers
      if (ride.pickup_order && ride.pickup_order.length > 0) {
        ride.pickup_order.forEach(p => {
          if (p.latitude && p.longitude) {
            const coord = [p.latitude, p.longitude];
            pathCoords.push(coord);

            const passengerMarker = L.marker(coord, {
              icon: L.divIcon({
                className: 'passenger-marker-icon',
                html: `<div style="background-color: var(--accent); color: #000; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid #000; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 0.85rem;">${p.order}</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
              })
            })
            .addTo(state.map)
            .bindPopup(`<strong>Pickup #${p.order}</strong><br>${p.full_name}<br>${p.pickup_label}`);

            state.routeLayers.push(passengerMarker);
          }
        });
      }

      // Add Office destination marker
      const officeCoord = [22.32414, 73.16594];
      pathCoords.push(officeCoord);

      const officeMarker = L.marker(officeCoord, {
        icon: L.divIcon({
          className: 'office-marker-icon',
          html: `<div style="background-color: #ff3366; color: white; width: 28px; height: 28px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 1.1rem;">🏢</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        })
      })
      .addTo(state.map)
      .bindPopup(`<strong>Aditi Vadodara Office</strong><br>Destination`);

      state.routeLayers.push(officeMarker);

      // Draw snapped path
      if (pathCoords.length >= 2) {
        drawRoadRoute(pathCoords);
      }
    }
  }

  // --- Role 3: Employee (User) ---
  else if (role === "employee") {
    // "Live Location of only their current driver (no further route)... Only when Ride is on."
    const ride = state.currentRide;
    const isRideOn = ride && (ride.status === "started" || ride.status === "ongoing");

    // Draw employee's own pickup marker if they have one configured
    const saved = state.currentUser?.pickup_point;
    if (saved && saved.latitude && saved.longitude) {
      const homeMarker = L.marker([saved.latitude, saved.longitude], {
        icon: L.divIcon({
          className: 'home-marker-icon',
          html: `<div style="background-color: #ffcc00; color: #000; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid #000; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 0.85rem;">🏠</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        })
      })
      .addTo(state.map)
      .bindPopup(`<strong>Your Pickup Location</strong><br>${saved.label || "Home"}`);
      state.routeLayers.push(homeMarker);
    }

    if (isRideOn && ride.assigned_driver_id) {
      // Find current driver's position in active markers using simple math
      const activeDriver = markers.find(m => m.driver_id === ride.assigned_driver_id);
      if (activeDriver) {
        const driverMarker = L.marker([activeDriver.latitude, activeDriver.longitude], {
          icon: L.divIcon({
            className: 'driver-marker-icon',
            html: `<div style="background-color: #00ff66; color: #000; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid #000; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 0.85rem;">🚕</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          })
        })
        .addTo(state.map)
        .bindPopup(`<strong>Your Driver: ${activeDriver.driver_name}</strong><br>${activeDriver.cab_number || "Cab"}<br>Last updated: ${activeDriver.recorded_at}`);
        state.markers.push(driverMarker);

        // Center map to show both employee and driver
        if (!state.mapCentered) {
          const bounds = [];
          bounds.push([activeDriver.latitude, activeDriver.longitude]);
          if (saved && saved.latitude && saved.longitude) {
            bounds.push([saved.latitude, saved.longitude]);
          }
          if (bounds.length > 1) {
            state.map.fitBounds(bounds, { padding: [50, 50] });
          } else {
            state.map.setView([activeDriver.latitude, activeDriver.longitude], 14);
          }
          state.mapCentered = true;
        }
      }
    }
  }
}

async function drawRoadRoute(coordsLatLng) {
  // OSRM expects lon,lat order
  const waypoints = coordsLatLng.map(c => `${c[1]},${c[0]}`).join(";");
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${waypoints}?overview=full&geometries=geojson`;

  let routeDrawn = false;

  try {
    const response = await fetch(osrmUrl);
    const data = await response.json();

    if (data.code === "Ok" && data.routes && data.routes[0]) {
      const geojson = data.routes[0].geometry;

      const routeLayer = L.geoJSON(geojson, {
        style: {
          color: "#FFDE00",
          weight: 6,
          opacity: 0.9,
          lineJoin: "round",
          lineCap: "round"
        }
      }).addTo(state.map);

      state.routeLayers.push(routeLayer);

      // Auto-zoom to fit the full route
      if (!state.mapCentered) {
        state.map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });
        state.mapCentered = true;
      }

      routeDrawn = true;
    }
  } catch (err) {
    console.warn("OSRM road routing failed, falling back to straight line:", err);
  }

  // Fallback: straight dashed polyline if OSRM is unavailable
  if (!routeDrawn) {
    const fallbackLine = L.polyline(coordsLatLng, {
      color: "#FFDE00",
      weight: 5,
      opacity: 0.8,
      dashArray: "8, 12"
    }).addTo(state.map);

    state.routeLayers.push(fallbackLine);

    if (!state.mapCentered) {
      state.map.fitBounds(fallbackLine.getBounds(), { padding: [50, 50] });
      state.mapCentered = true;
    }
  }
}

function normalizeErrorMessage(message) {
  if (!message) return "Something went wrong";
  try {
    const parsed = JSON.parse(message);
    if (parsed?.detail) return parsed.detail;
  } catch (error) {}
  if (message.includes("User already exists with this email")) {
    return "An account already exists for that email address.";
  }
  return message.replace(/^Error:\s*/i, "");
}

function parseApiError(error) {
  try {
    const parsed = JSON.parse(error.message);
    if (parsed && parsed.detail) return parsed.detail;
    return error.message;
  } catch (e) {
    return error.message || String(error);
  }
}

function getUnreadCount(notifications) {
  return notifications.filter((item) => !item.is_read).length;
}

function playBellTone() {
  try {
    const prefix = window.location.pathname.includes("/pages/") ? "../" : "./";
    const audio = new Audio(prefix + "assets/notify-bell.mp3");
    audio.play()
      .then(() => {
        console.log("[Audio] notification chime played successfully");
      })
      .catch((err) => {
        console.warn("[Audio] notify-bell.mp3 play blocked or failed. Playing fallback synthesized tone. Reason:", err);
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        
        if (ctx.state === "suspended") {
          ctx.resume();
        }
        
        oscillator.start();
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
        setTimeout(() => {
          oscillator.stop();
          ctx.close();
        }, 700);
      });
  } catch (error) {
    console.error("[Audio] playBellTone general error:", error);
  }
}

function ensureNotificationDrawer() {
  let drawer = byId("notificationDrawer");
  if (drawer) return drawer;
  drawer = document.createElement("section");
  drawer.id = "notificationDrawer";
  drawer.className = "notification-drawer";
  drawer.innerHTML = `\r\n    <div class="notification-drawer-panel">\r\n      <div class="notification-drawer-head">\r\n        <strong>Notifications</strong>\r\n        <button type="button" class="ghost-button" data-close-notifications>Close</button>\r\n      </div>\r\n      <div id="notificationList" class="notification-list"></div>\r\n    </div>\r\n  `;
  document.body.appendChild(drawer);
  drawer.querySelector("[data-close-notifications]")?.addEventListener("click", closeNotificationDrawer);
  return drawer;
}

function openNotificationDrawer() {
  ensureNotificationDrawer().classList.add("open");
  playBellTone();
}

function closeNotificationDrawer() {
  const drawer = byId("notificationDrawer");
  if (drawer) drawer.classList.remove("open");
}

function renderNotifications(notifications) {
  const container = byId("notificationList");
  if (!container) return;
  container.innerHTML = notifications.length
    ? notifications.map((item) => `<article class="notification-item ${item.is_read ? "" : "unread"}"><strong>${item.title || "Update"}</strong><small>${item.message || ""}</small></article>`).join("")
    : '<p class="code-block">No notifications right now.</p>';
}

function updateNotificationState(notifications) {
  const unreadCount = getUnreadCount(notifications);
  const bell = byId("notificationBell");
  if (bell) {
    bell.dataset.count = String(unreadCount);
    bell.classList.toggle("has-new", unreadCount > 0);
  }
  renderNotifications(notifications);
  if (unreadCount > state.notificationCount) {
    playBellTone();
  }
  state.notificationCount = unreadCount;
  sessionStorage.setItem("cms-notification-count", String(unreadCount));
}

async function loadNotifications() {
  const notifications = await api("/api/v1/notifications").catch(() => []);
  updateNotificationState(notifications || []);
  return notifications || [];
}

function startNotificationPolling() {
  if (state.notificationPoll) clearInterval(state.notificationPoll);
  state.notificationPoll = window.setInterval(() => {
    if (state.token) loadNotifications().catch(() => {});
  }, 30000);
}

// ─── WebSocket: Map viewers receive live driver location pushes ───
function startTrackingWebSocket() {
  if (!window.WebSocket) {
    // Fallback to HTTP polling if browser doesn't support WS
    startTrackingPolling();
    return;
  }
  if (state.trackingWs && state.trackingWs.readyState < 2) return; // already open or connecting

  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${location.host}/api/v1/ws/tracking/watch`;
  const ws = new WebSocket(wsUrl);
  state.trackingWs = ws;

  ws.onopen = () => {
    state.wsReconnectDelay = 1000; // reset backoff on successful connect
    console.log("[WS] Tracking watch connected");
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === "snapshot") {
        updateMap(msg.data || []);
      } else if (msg.type === "ping") {
        // keepalive — no action needed
      } else if (msg.type === "route_change") {
        // Route change notification - refresh the relevant role's dashboard
        console.log("[WS] Route change received:", msg);
        const role = state.currentUser && state.currentUser.role;
        if (role === "driver") {
          // Only refresh if this route change affects the current driver
          if (msg.driver_id && msg.driver_id === state.currentUser.id) {
            console.log("[WS] Refreshing driver route due to passenger availability change");
            loadRoleRidePage(filterDriverRides).catch(err => {
              console.error("[WS] Error refreshing driver route:", err);
            });
          }
        } else if (role === "supervisor") {
          console.log("[WS] Refreshing supervisor page due to route change");
          loadSupervisorPage().catch(err => {
            console.error("[WS] Error refreshing supervisor page:", err);
          });
        } else if (role === "admin") {
          console.log("[WS] Refreshing admin page due to route change");
          loadAllAvailabilityLogs().catch(() => {});
        }
      } else if (msg.driver_id) {
        // Single driver location push — merge into current markers
        const currentMarkers = state.markers.map(m => ({
          driver_id: m.options?.driver_id,
          driver_name: m.options?.driver_name,
          cab_number: m.options?.cab_number,
          latitude: m.getLatLng()?.lat,
          longitude: m.getLatLng()?.lng,
          recorded_at: "Just now"
        })).filter(m => m.driver_id);
        const idx = currentMarkers.findIndex(m => m.driver_id === msg.driver_id);
        if (idx >= 0) currentMarkers[idx] = msg;
        else currentMarkers.push(msg);
        updateMap(currentMarkers);
      }
    } catch (e) { /* ignore malformed frames */ }
  };

  ws.onclose = () => {
    console.warn(`[WS] Tracking watch closed. Reconnecting in ${state.wsReconnectDelay}ms...`);
    setTimeout(() => {
      if (state.token) startTrackingWebSocket();
    }, state.wsReconnectDelay);
    state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 2, 30000); // exponential backoff, max 30s
  };

  ws.onerror = () => ws.close();
}

// HTTP polling fallback (used if WebSocket is unavailable)
function startTrackingPolling() {
  if (state.trackingPoll) clearInterval(state.trackingPoll);
  state.trackingPoll = window.setInterval(async () => {
    if (state.token) {
      const active = await api("/api/v1/tracking/active").catch(() => []);
      updateMap(active || []);
    }
  }, 10000);
}

function stopDriverLocationTracking() {
  if (state.geolocationWatchId !== null && state.geolocationWatchId !== undefined) {
    navigator.geolocation.clearWatch(state.geolocationWatchId);
    state.geolocationWatchId = null;
  }
  if (state.driverWs) {
    state.driverWs.onclose = null;
    state.driverWs.close();
    state.driverWs = null;
  }
  state.driverLatLng = null;
  console.log("Stopped driver location tracking.");
}

function startDriverLocationTracking() {
  // Always stop existing tracking first to avoid leaks
  stopDriverLocationTracking();

  if (!navigator.geolocation) {
    console.warn("Geolocation is not supported by this browser.");
    return;
  }
  const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

  // Open WS connection to send driver location
  function openDriverWs() {
    if (!window.WebSocket) return null;
    const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${wsProtocol}://${location.host}/api/v1/ws/tracking`);
    state.driverWs = ws;
    ws.onopen = () => console.log("[WS] Driver tracking connected");
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      state.driverWs = null;
      // Reconnect after 3s if still tracking
      if (state.geolocationWatchId !== null) {
        setTimeout(openDriverWs, 3000);
      }
    };
    return ws;
  }

  openDriverWs();

  state.geolocationWatchId = navigator.geolocation.watchPosition(
    async (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      console.log(`Driver location captured: ${lat}, ${lng}`);
      state.driverLatLng = [lat, lng];

      const payload = { token: state.token, latitude: lat, longitude: lng };

      // Prefer WebSocket, fall back to HTTP
      if (state.driverWs && state.driverWs.readyState === WebSocket.OPEN) {
        state.driverWs.send(JSON.stringify(payload));
      } else {
        try {
          await api("/api/v1/tracking/update", {
            method: "POST",
            body: JSON.stringify({ latitude: lat, longitude: lng }),
          });
        } catch (err) {
          console.error("Failed to update location on backend:", err);
        }
      }
    },
    (error) => { console.error("Error capturing geolocation:", error); },
    options
  );
}

function renderRidesTable(containerId, rides) {
  const container = byId(containerId);
  if (!container) return;
  if (!rides.length) {
    container.innerHTML = "<p class=\"code-block\">No rides available.</p>";
    return;
  }
  const rows = rides.map((ride) => {
    const groupName = ride.group_name ? `<strong>${ride.group_name}</strong><br><small>${ride.ride_reference}</small>` : ride.ride_reference;
    const driverInfo = ride.driver_name ? `${ride.driver_name}<br><small>${ride.cab_number}</small>` : "Unassigned";
    return `
      <tr>
        <td>${groupName}</td>
        <td>${driverInfo}</td>
        <td>${ride.pickup_point}</td>
        <td><span class="tag ${ride.status === "ongoing" || ride.status === "started" ? "success" : ""}">${ride.status}</span></td>
        <td>${ride.delay_minutes ?? 0} mins</td>
        <td>₹${Number(ride.total_cost || 0).toFixed(2)}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Group / Ref</th>
          <th>Driver & Cab</th>
          <th>Pickup Route</th>
          <th>Status</th>
          <th>Delay</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function renderApprovalsTable(containerId, approvals) {
  const container = byId(containerId);
  if (!container) return;
  if (!approvals.length) {
    container.innerHTML = '<p class="code-block">No pending approvals.</p>';
    return;
  }
  const rows = approvals.map((item) => `
    <tr>
      <td>${item.full_name}</td>
      <td>${item.email}</td>
      <td>${item.role}</td>
      <td>${item.status}</td>
      <td>
        <button class="ghost-button" data-approve="${item.id}">Approve</button>
        <button class="danger-button" data-reject="${item.id}">Reject</button>
      </td>
    </tr>
  `).join("");
  container.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ─── Shared Pagination Utility ───
function renderPagination(containerId, currentPage, totalPages, onPageChange) {
  const container = byId(containerId);
  if (!container) return;
  if (totalPages <= 1) { container.innerHTML = ""; return; }

  const pages = [];
  for (let i = 1; i <= totalPages; i++) pages.push(i);

  container.innerHTML = `
    <div class="pagination">
      <button class="pg-btn" ${currentPage === 1 ? "disabled" : ""} data-page="${currentPage - 1}">&#8592; Prev</button>
      ${pages.map(p => `<button class="pg-btn ${p === currentPage ? 'pg-active' : ''}" data-page="${p}">${p}</button>`).join("")}
      <button class="pg-btn" ${currentPage === totalPages ? "disabled" : ""} data-page="${currentPage + 1}">Next &#8594;</button>
    </div>
  `;

  container.querySelectorAll(".pg-btn:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => onPageChange(Number(btn.dataset.page)));
  });
}

function renderPeopleTable(containerId, people) {
  const container = byId(containerId);
  if (!container) return;
  if (!people.length) {
    container.innerHTML = '<p class="code-block">No people found.</p>';
    return;
  }
  const rows = people.map((item) => `
    <tr>
      <td>${item.full_name}</td>
      <td>${item.email}</td>
      <td>${item.role}</td>
    </tr>
  `).join("");
  container.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderChatShell() {
  const container = byId("aiChat");
  if (!container) return;
  container.innerHTML = `
    <div class="chat-shell-simple">
      <div class="chat-message-simple assistant">
        <strong>AI</strong>
        <p>Welcome to AI Query. Ask about trip data, approvals, rides, or people.</p>
      </div>
      <div id="chatWindow" class="chat-window-simple">Waiting for a query...</div>
    </div>
  `;
  const form = byId("chatForm");
  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", handleChat);
  }
}

async function loadCurrentUser() {
  if (!state.token) {
    state.currentUser = null;
    updateSessionBadge();
    return null;
  }
  state.currentUser = await api("/api/v1/auth/me");
  updateSessionBadge();
  return state.currentUser;
}

function initLogout() {
  const button = byId("logoutButton");
  if (!button) return;
  button.addEventListener("click", () => {
    clearSession();
    window.location.href = currentPage === "auth" ? "./index.html" : "../index.html";
  });
}

async function handleLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const response = await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    persistSession(response.access_token, response.role);
    byId("loginResult").textContent = `Authenticated as ${response.role}. Redirecting to workspace.`;
    redirectForRole(response.role);
  } catch (error) {
    byId("loginResult").textContent = `Login failed: ${normalizeErrorMessage(parseApiError(error))}`;
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    full_name: form.get("full_name"),
    email: (form.get("email") || "").toLowerCase(),
    password: form.get("password"),
    role: form.get("role"),
    mobile_number: form.get("mobile_number"),
    employee_id: form.get("employee_id") || null,
    department: form.get("department") || null,
    license_number: form.get("license_number") || null,
  };
  try {
    const response = await api("/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    byId("signupResult").textContent = `Approval request created for ${response.full_name}.`;
    event.currentTarget.reset();
  } catch (error) {
    byId("signupResult").textContent = `Signup failed: ${normalizeErrorMessage(parseApiError(error))}`;
  }
}

async function handleChat(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const response = await api("/api/v1/ai-chat", {
      method: "POST",
      body: JSON.stringify({ question: form.get("question") }),
    });
    const chatWindow = byId("chatWindow");
    if (chatWindow) chatWindow.textContent = response.answer;
  } catch (error) {
    const chatWindow = byId("chatWindow");
    if (chatWindow) chatWindow.textContent = `Query failed: ${error.message}`;
  }
}

function pickCurrentRide(rides) {
  return rides.find((ride) => ride.status === "ongoing" || ride.status === "started") || rides[0] || null;
}

function renderCurrentRide(containerId, ride, label) {
  const container = byId(containerId);
  if (!container) return;
  if (!ride) {
    container.innerHTML = `<article><strong>No ${label.toLowerCase()} available</strong><small>There is no assigned active ride right now.</small></article>`;
    return;
  }

  let sequenceHtml = "";
  const hasPickup = ride.pickup_order && ride.pickup_order.length > 0;
  const hasDrop = ride.drop_order && ride.drop_order.length > 0;

  if (hasPickup) {
    const listItems = ride.pickup_order.map(p => {
      const isMe = state.currentUser && state.currentUser.id === p.user_id;
      const display = `${p.full_name} (${p.pickup_label || "No Location set"})`;
      return `<li>${isMe ? `<strong>${display} (You)</strong>` : display}</li>`;
    }).join("");
    sequenceHtml += `
      <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px;">
        <strong style="font-size: 0.85rem; color: var(--muted);">Pickup Sequence:</strong>
        <ol style="margin: 4px 0 0 16px; font-size: 0.85rem; line-height: 1.4;">
          ${listItems}
        </ol>
      </div>
    `;
  } else {
    sequenceHtml += `
      <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px;">
        <p style="font-size: 0.85rem; color: var(--muted); margin: 0;">No pickup stops are required for this trip.</p>
      </div>
    `;
  }

  if (!hasDrop) {
    sequenceHtml += `
      <div style="margin-top: 8px;">
        <p style="font-size: 0.85rem; color: var(--muted); margin: 0;">No drop stops are required for this trip.</p>
      </div>
    `;
  }

  let driverControlsHtml = "";
  if (state.currentUser && state.currentUser.role === "driver") {
    if (ride.status === "pending") {
      driverControlsHtml = `
        <div style="margin-top: 12px; display: flex; gap: 8px;">
          <button type="button" class="primary-button" data-start-ride="${ride.id}" style="padding: 6px 12px; font-size: 0.85rem;">▶ Start Trip</button>
        </div>
      `;
    } else if (ride.status === "ongoing" || ride.status === "started") {
      driverControlsHtml = `
        <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
          <button type="button" class="ghost-button" data-complete-ride="${ride.id}" style="padding: 6px 12px; font-size: 0.85rem; border-color: #4cff7c; color: #4cff7c;">✓ Complete Trip</button>
          <button type="button" class="ghost-button" data-delay-ride="${ride.id}" data-delay-val="${ride.delay_minutes ?? 0}" style="padding: 6px 12px; font-size: 0.85rem; border-color: #ff7d4d; color: #ff7d4d;">⏳ Report +5m Delay</button>
        </div>
      `;
    }
  }

  container.innerHTML = `
    <article style="padding: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
        <span class="tag ${ride.status === "ongoing" || ride.status === "started" ? "success" : ""}">${ride.status}</span>
        <span style="font-size: 0.8rem; color: var(--muted); font-family: monospace;">${ride.ride_reference}</span>
      </div>
      <strong class="article-title" style="font-size: 1.1rem; display: block; margin-bottom: 4px;">${ride.group_name || "Ride Group"}</strong>
      <small class="article-meta" style="font-size: 0.85rem; display: block; line-height: 1.4;">
        <strong>Driver:</strong> ${ride.driver_name || "Unassigned"} (${ride.cab_number})<br>
        <strong>Route:</strong> ${ride.pickup_point} to ${ride.drop_point}<br>
        <strong>Delay:</strong> ${ride.delay_minutes ?? 0} mins<br>
        <strong>Est. Cost:</strong> ₹${Number(ride.total_cost || 0).toFixed(2)}
      </small>
      ${sequenceHtml}
      ${driverControlsHtml}
    </article>
  `;
}

function filterEmployeeRides(rides) {
  if (!state.currentUser) return [];
  return rides.filter((ride) => (ride.passengers || []).some((passenger) => passenger.passenger_user_id === state.currentUser.id));
}

function filterDriverRides(rides) {
  return state.currentUser ? rides.filter((ride) => ride.assigned_driver_id === state.currentUser.id) : [];
}

function filterEscortRides(rides) {
  return state.currentUser ? rides.filter((ride) => ride.escort_user_id === state.currentUser.id) : [];
}

async function loadAllAvailabilityLogs() {
  const container = byId("unavailabilityTable");
  if (!container) return;

  try {
    container.innerHTML = '<p class="code-block">Loading...</p>';
    const data = await api("/api/v1/availability");
    const logs = (data && data.items) ? data.items : (Array.isArray(data) ? data : []);

    if (!logs.length) {
      container.innerHTML = '<p class="code-block">No unavailability logs found.</p>';
      return;
    }

    const rows = logs.map(item => {
      const dateStr = item.date.split('T')[0];
      const [year, month, day] = dateStr.split('-');
      const dateObj = new Date(year, parseInt(month) - 1, parseInt(day));
      const date = dateObj.toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
      let statusBadge = '';
      if (item.no_cab_required) {
        statusBadge = '<span class="tag" style="background:#ff7d4d;">No Cab Required</span>';
      } else if (item.pickup_not_needed && item.drop_not_needed) {
        statusBadge = '<span class="tag" style="background:#ff7d4d;">No Cab Required</span>';
      } else if (item.pickup_not_needed) {
        statusBadge = '<span class="tag" style="background:#ffcc00;color:#000;">Pickup Not Needed</span>';
      } else if (item.drop_not_needed) {
        statusBadge = '<span class="tag" style="background:#ffcc00;color:#000;">Drop Not Needed</span>';
      } else {
        statusBadge = '<span class="tag">Normal Service</span>';
      }
      const updatedAt = item.updated_at ? new Date(item.updated_at).toLocaleString() : '—';
      return `
        <tr>
          <td><strong>${item.employee_name || '—'}</strong></td>
          <td>${date}</td>
          <td>${statusBadge}</td>
          <td style="font-size:0.82rem;color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${item.reason || ''}">${item.reason || '—'}</td>
          <td style="font-size:0.75rem;color:var(--muted);">${updatedAt}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Date</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = '<p class="code-block">Error loading unavailability logs.</p>';
    console.error('[loadAllAvailabilityLogs]', err);
  }
}

async function loadAdminPage() {
  await loadCurrentUser();
  initDashboardDate();
  const [stats, rides, notifications, active, users, approvals] = await Promise.all([
    api("/api/v1/analytics/dashboard").catch(() => ({})),
    api("/api/v1/rides").catch(() => []),
    api("/api/v1/notifications").catch(() => []),
    api("/api/v1/tracking/active").catch(() => []),
    api("/api/v1/users").catch(() => []),
    api("/api/v1/auth/pending").catch(() => []),
  ]);

  byId("metricEmployees").textContent = stats.total_employees ?? 0;
  byId("metricDrivers").textContent = stats.total_drivers ?? 0;
  byId("metricActiveRides").textContent = stats.active_rides ?? 0;
  byId("metricDelay").textContent = stats.delayed_trips ?? 0;

  ensureNotificationDrawer();
  updateNotificationState(notifications || []);
  updateMap(active || []);
  startNotificationPolling();
  startTrackingPolling();
  loadAllAvailabilityLogs().catch(() => {});

  const bell = byId("notificationBell");
  if (bell && !bell.dataset.bound) {
    bell.dataset.bound = "true";
    bell.addEventListener("click", () => openNotificationDrawer());
  }
}

// ─── Availability Form Handler ───
function initAvailabilityForm() {
  const form = byId("availabilityForm");
  const dateInput = byId("availabilityDate");
  const pickupCheckbox = byId("pickupNotNeeded");
  const dropCheckbox = byId("dropNotNeeded");
  const reasonInput = byId("availabilityReason");
  const statusDiv = byId("availabilityStatus");
  const deadlineDiv = byId("availabilityDeadline");
  const resultDiv = byId("availabilityResult");
  const validationHint = byId("availabilityValidationHint");
  const informBtn = byId("availabilityInformBtn");
  const cancelBtn = byId("availabilityCancelBtn");
  
  if (!form || !dateInput) return;
  
  // Set minimum date to today
  const today = new Date().toISOString().split('T')[0];
  dateInput.setAttribute('min', today);
  
  // Track current availability state
  let currentAvailability = null;
  
  // Function to update status display
  async function loadAvailabilityForDate(date) {
    if (!date) {
      statusDiv.textContent = "Choose a date to view your current pickup/drop requirement.";
      deadlineDiv.style.display = "none";
      cancelBtn.style.display = "none";
      informBtn.textContent = "Inform";
      return;
    }
    
    try {
      statusDiv.textContent = "Loading...";
      const data = await api(`/api/v1/availability/me?date=${date}`);
      currentAvailability = data;
      
      // Update form state
      pickupCheckbox.checked = data.pickup_not_needed || false;
      dropCheckbox.checked = data.drop_not_needed || false;
      reasonInput.value = data.reason || "";
      
      // Build status message
      let statusMessage = "";
      if (data.pickup_not_needed && data.drop_not_needed) {
        statusMessage = "🚫 No Cab Required / On Leave";
        statusDiv.style.borderColor = "#ff7d4d";
      } else if (data.pickup_not_needed) {
        statusMessage = "🚐 Pickup Not Needed (Drop Required)";
        statusDiv.style.borderColor = "#ffcc00";
      } else if (data.drop_not_needed) {
        statusMessage = "🚐 Drop Not Needed (Pickup Required)";
        statusDiv.style.borderColor = "#ffcc00";
      } else {
        statusMessage = "✅ Pickup and Drop Required (Normal Service)";
        statusDiv.style.borderColor = "#4cff7c";
      }
      statusDiv.textContent = statusMessage;
      
      // Show/hide cancel button based on existing exception
      if (data.pickup_not_needed || data.drop_not_needed) {
        cancelBtn.style.display = "inline-block";
        informBtn.textContent = "Update";
      } else {
        cancelBtn.style.display = "none";
        informBtn.textContent = "Inform";
      }
      
      // Show deadline info
      if (data.can_change === false) {
        deadlineDiv.innerHTML = "⚠️ <strong>Deadline passed:</strong> You cannot modify this exception. Please contact your supervisor.";
        deadlineDiv.style.color = "#ff7d4d";
        deadlineDiv.style.display = "block";
        informBtn.disabled = true;
        cancelBtn.disabled = true;
      } else if (data.assigned_driver_id && data.ride_group_id) {
        deadlineDiv.innerHTML = "ℹ️ You can modify this until 4 hours before the scheduled departure.";
        deadlineDiv.style.color = "var(--muted)";
        deadlineDiv.style.display = "block";
        informBtn.disabled = false;
        cancelBtn.disabled = false;
      } else {
        deadlineDiv.innerHTML = "⚠️ You are not currently assigned to a ride group for this date.";
        deadlineDiv.style.color = "#ff7d4d";
        deadlineDiv.style.display = "block";
        informBtn.disabled = true;
        cancelBtn.disabled = true;
      }
      
    } catch (err) {
      statusDiv.textContent = "Error loading availability. Please try again.";
      statusDiv.style.borderColor = "#ff7d4d";
      console.error("Error loading availability:", err);
    }
  }
  
  // Load availability history
  async function loadAvailabilityHistory() {
    const container = byId("myUnavailabilityHistoryTable");
    if (!container) return;
    
    try {
      const history = await api("/api/v1/availability/me/history");
      
      if (!history || history.length === 0) {
        container.innerHTML = '<p class="code-block" style="padding: 8px;">No unavailability history found.</p>';
        return;
      }
      
      const rows = history.map(item => {
        const dateStr = item.date.split('T')[0];
        const [year, month, day] = dateStr.split('-');
        const dateObj = new Date(year, parseInt(month) - 1, parseInt(day));
        const date = dateObj.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        let statusBadge = "";
        if (item.no_cab_required) {
          statusBadge = '<span class="tag" style="background: #ff7d4d;">No Cab Required</span>';
        } else if (item.pickup_not_needed) {
          statusBadge = '<span class="tag" style="background: #ffcc00; color: #000;">Pickup Not Needed</span>';
        } else if (item.drop_not_needed) {
          statusBadge = '<span class="tag" style="background: #ffcc00; color: #000;">Drop Not Needed</span>';
        }
        
        return `
          <tr>
            <td>${date}</td>
            <td>${statusBadge || '<span class="tag">Normal Service</span>'}</td>
            <td>${item.reason || "—"}</td>
            <td style="font-size: 0.75rem; color: var(--muted);">${item.updated_at ? new Date(item.updated_at).toLocaleString() : "—"}</td>
          </tr>
        `;
      }).join("");
      
      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `;
    } catch (err) {
      container.innerHTML = '<p class="code-block" style="padding: 8px;">Error loading history.</p>';
      console.error("Error loading availability history:", err);
    }
  }
  
  // Date change handler
  dateInput.addEventListener("change", () => {
    loadAvailabilityForDate(dateInput.value);
  });
  
  // Form submit handler
  if (!form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      
      const date = dateInput.value;
      if (!date) {
        resultDiv.style.color = "#ff7d4d";
        resultDiv.textContent = "Please select a date.";
        return;
      }
      
      const pickupNotNeeded = pickupCheckbox.checked;
      const dropNotNeeded = dropCheckbox.checked;
      
      // Validate at least one option is selected
      if (!pickupNotNeeded && !dropNotNeeded) {
        resultDiv.style.color = "#ff7d4d";
        resultDiv.textContent = "Please select at least one option: 'Pickup Not Needed' or 'Drop Not Needed'.";
        return;
      }
      
      // Determine the status for confirmation
      let statusText = "";
      if (pickupNotNeeded && dropNotNeeded) {
        statusText = "No Cab Required / On Leave";
      } else if (pickupNotNeeded) {
        statusText = "Pickup Not Needed (Drop service will continue)";
      } else {
        statusText = "Drop Not Needed (Pickup service will continue)";
      }
      
      resultDiv.style.color = "var(--text)";
      resultDiv.textContent = "Submitting...";
      
      try {
        await api("/api/v1/availability/me", {
          method: "PUT",
          body: JSON.stringify({
            date: date,
            pickup_not_needed: pickupNotNeeded,
            drop_not_needed: dropNotNeeded,
            reason: reasonInput.value || null
          })
        });
        
        resultDiv.style.color = "#4cff7c";
        resultDiv.textContent = `✓ Successfully informed: ${statusText}`;
        
        // Reload the availability and history
        await loadAvailabilityForDate(date);
        await loadAvailabilityHistory();
        
      } catch (err) {
        const errorMsg = parseApiError(err);
        resultDiv.style.color = "#ff7d4d";
        resultDiv.textContent = normalizeErrorMessage(errorMsg);
      }
    });
  }
  
  // Cancel button handler
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = "true";
    cancelBtn.addEventListener("click", async () => {
      const date = dateInput.value;
      if (!date) return;
      
      if (!confirm("Are you sure you want to cancel this cab unavailability exception? Your normal pickup and drop service will be restored.")) {
        return;
      }
      
      resultDiv.style.color = "var(--text)";
      resultDiv.textContent = "Cancelling...";
      
      try {
        await api(`/api/v1/availability/me/${date}`, {
          method: "DELETE"
        });
        
        resultDiv.style.color = "#4cff7c";
        resultDiv.textContent = "✓ Exception cancelled. Normal service restored.";
        
        // Reset form and reload
        pickupCheckbox.checked = false;
        dropCheckbox.checked = false;
        reasonInput.value = "";
        await loadAvailabilityForDate(date);
        await loadAvailabilityHistory();
        
      } catch (err) {
        const errorMsg = parseApiError(err);
        resultDiv.style.color = "#ff7d4d";
        resultDiv.textContent = normalizeErrorMessage(errorMsg);
      }
    });
  }
  
  // Load history on init
  loadAvailabilityHistory();
}

function initPickupPointSettings() {
  const form = byId("pickupForm");
  const mapDiv = byId("pickupMap");
  const gpsBtn = byId("pickupGpsBtn");
  const coordsSpan = byId("pickupCoords");
  const latInput = byId("pickupLat");
  const lngInput = byId("pickupLng");
  const labelInput = byId("pickupLabel");
  const saveBtn = byId("pickupSaveBtn");
  const result = byId("pickupResult");
  if (!form || !mapDiv || !window.L) return;

  // Initialize pickup map
  const pickupMap = L.map("pickupMap").setView([22.3072, 73.1812], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(pickupMap);

  let pickupMarker = null;

  function setPickupLocation(lat, lng) {
    latInput.value = lat.toFixed(6);
    lngInput.value = lng.toFixed(6);
    coordsSpan.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    saveBtn.disabled = false;

    if (pickupMarker) {
      pickupMarker.setLatLng([lat, lng]);
    } else {
      pickupMarker = L.marker([lat, lng], { draggable: true }).addTo(pickupMap);
      pickupMarker.on("dragend", () => {
        const pos = pickupMarker.getLatLng();
        setPickupLocation(pos.lat, pos.lng);
      });
    }
    pickupMap.setView([lat, lng], Math.max(pickupMap.getZoom(), 15));
  }

  // Pre-fill from saved data
  const saved = state.currentUser?.pickup_point;
  if (saved && saved.latitude && saved.longitude) {
    setPickupLocation(saved.latitude, saved.longitude);
    if (saved.label) labelInput.value = saved.label;
  }

  // Click-to-place on map
  pickupMap.on("click", (e) => {
    setPickupLocation(e.latlng.lat, e.latlng.lng);
  });

  // GPS one-shot locate
  if (gpsBtn) {
    gpsBtn.addEventListener("click", () => {
      if (!navigator.geolocation) {
        coordsSpan.textContent = "GPS not supported on this device.";
        return;
      }
      gpsBtn.disabled = true;
      gpsBtn.textContent = "⏳ Locating...";
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setPickupLocation(position.coords.latitude, position.coords.longitude);
          gpsBtn.disabled = false;
          gpsBtn.textContent = "📍 Use my GPS location";
        },
        (error) => {
          coordsSpan.textContent = "GPS failed: " + error.message;
          gpsBtn.disabled = false;
          gpsBtn.textContent = "📍 Use my GPS location";
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  // Save handler
  if (!form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const lat = parseFloat(latInput.value);
      const lng = parseFloat(lngInput.value);
      if (isNaN(lat) || isNaN(lng)) {
        result.style.color = "#ff7d4d";
        result.textContent = "Please select a location on the map first.";
        return;
      }
      result.textContent = "";
      try {
        const response = await api("/api/v1/users/me/pickup-point", {
          method: "PUT",
          body: JSON.stringify({ latitude: lat, longitude: lng, label: labelInput.value || "" }),
        });
        if (state.currentUser) {
          state.currentUser.pickup_point = response.pickup_point;
        }
        result.style.color = "#4cff7c";
        result.textContent = "Pickup location saved successfully.";
        setTimeout(() => {
          if (result.textContent === "Pickup location saved successfully.") {
            result.textContent = "";
          }
        }, 3000);
      } catch (error) {
        result.style.color = "#ff7d4d";
        result.textContent = `Failed to save: ${normalizeErrorMessage(parseApiError(error))}`;
      }
    });
  }

  // Fix Leaflet rendering in hidden/dynamic containers
  setTimeout(() => pickupMap.invalidateSize(), 200);
}

async function updateRideGroupStatus(groupId, newStatus, delayMinutes = null) {
  const payload = {};
  if (newStatus !== null) payload.status = newStatus;
  if (delayMinutes !== null) payload.delay_minutes = delayMinutes;
  
  try {
    await api(`/api/v1/ride-groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    if (state.currentUser.role === "driver") {
      await loadRoleRidePage(filterDriverRides);
    } else if (state.currentUser.role === "employee") {
      await loadRoleRidePage(filterEmployeeRides);
    }
  } catch (err) {
    alert(`Failed to update ride: ${normalizeErrorMessage(parseApiError(err))}`);
  }
}

async function loadRoleRidePage(filterFn) {
  await loadCurrentUser();
  initDashboardDate();
  initPickupPointSettings();
  initAvailabilityForm();
  
  const [rides, notifications, active] = await Promise.all([
    api("/api/v1/rides?limit=100").catch(() => []),
    api("/api/v1/notifications").catch(() => []),
    api("/api/v1/tracking/active").catch(() => []),
  ]);

  const ridesList = Array.isArray(rides) ? rides : (rides?.items || []);
  const scopedRides = filterFn(ridesList || []);
  const currentRide = pickCurrentRide(scopedRides);
  state.currentRide = currentRide;
  state.mapCentered = false;

  // Manage Driver location tracking lifecycle dynamically
  if (state.currentUser && state.currentUser.role === "driver") {
    if (currentRide && (currentRide.status === "started" || currentRide.status === "ongoing")) {
      startDriverLocationTracking();
    } else {
      stopDriverLocationTracking();
    }
  }

  byId("metricAssigned").textContent = scopedRides.length;
  byId("metricCurrentStatus").textContent = currentRide ? currentRide.status : "None";
  byId("metricUnread").textContent = getUnreadCount(notifications || []);

  renderCurrentRide("currentRideCard", currentRide, "ride");
  renderRidesTable("ridesTable", scopedRides);

  const card = byId("currentRideCard");
  if (card && !card.dataset.bound) {
    card.dataset.bound = "true";
    card.addEventListener("click", async (e) => {
      const startId = e.target.dataset.startRide;
      const completeId = e.target.dataset.completeRide;
      const delayId = e.target.dataset.delayRide;
      const delayVal = e.target.dataset.delayVal;
      
      if (startId) {
        await api(`/api/v1/ride-groups/${startId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "started" }),
        });
        await loadRoleRidePage(filterFn);
      } else if (completeId) {
        await api(`/api/v1/ride-groups/${completeId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "completed" }),
        });
        await loadRoleRidePage(filterFn);
      } else if (delayId && delayVal) {
        await api(`/api/v1/ride-groups/${delayId}`, {
          method: "PUT",
          body: JSON.stringify({ delay_minutes: parseInt(delayVal, 10) + 5 }),
        });
        await loadRoleRidePage(filterFn);
      }
    });
  }

  ensureNotificationDrawer();
  updateNotificationState(notifications || []);
  updateMap(active || []);
  startNotificationPolling();
  startTrackingPolling();

  const bell = byId("notificationBell");
  if (bell && !bell.dataset.bound) {
    bell.dataset.bound = "true";
    bell.addEventListener("click", () => openNotificationDrawer());
  }
}

async function loadAdminOverviewPage() {
  await loadAdminPage();
}

async function loadAdminApprovalPage() {
  await loadCurrentUser();
  initDashboardDate();
  const approvals = await api("/api/v1/auth/pending").catch(() => []);
  renderApprovalsTable("approvalsTable", approvals || []);
  const table = byId("approvalsTable");
  if (table && !table.dataset.bound) {
    table.dataset.bound = "true";
    table.addEventListener("click", async (event) => {
      const approveId = event.target.dataset.approve;
      const rejectId = event.target.dataset.reject;
      if (!approveId && !rejectId) return;
      const userId = approveId || rejectId;
      const status = approveId ? "approved" : "rejected";
      await api(`/api/v1/auth/${userId}/decision`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await loadAdminApprovalPage();
    });
  }
}

async function loadAdminRidePage(page = 1) {
  await loadCurrentUser();
  initDashboardDate();
  const res = await api(`/api/v1/rides?page=${page}&limit=10`).catch(() => null);
  const items = res?.items || [];
  const totalPages = res?.pages || 1;
  renderRidesTable("ridesTable", items);
  renderPagination("ridesPagination", page, totalPages, (p) => loadAdminRidePage(p));
}

async function loadAdminPeoplePage(page = 1) {
  await loadCurrentUser();
  initDashboardDate();
  const res = await api(`/api/v1/users?page=${page}&limit=15`).catch(() => null);
  const items = res?.items || [];
  const totalPages = res?.pages || 1;
  renderPeopleTable("peopleTable", items);
  renderPagination("peoplePagination", page, totalPages, (p) => loadAdminPeoplePage(p));
}

async function loadAdminAiPage() {
  await loadCurrentUser();
  initDashboardDate();
  renderChatShell();
}

async function loadAdminMapPage() {
  await loadCurrentUser();
  initDashboardDate();
  const [employees, notifications] = await Promise.all([
    api("/api/v1/ride-groups/employees").catch(() => []),
    api("/api/v1/notifications").catch(() => []),
  ]);
  supervisorEmployees = employees;
  ensureNotificationDrawer();
  updateNotificationState(notifications || []);
  startNotificationPolling();

  const bell = byId("notificationBell");
  if (bell && !bell.dataset.bound) {
    bell.dataset.bound = "true";
    bell.addEventListener("click", () => openNotificationDrawer());
  }

  initAllEmployeesMap();
}

const supervisorState = {
  pickupOrder: [],
  dropOrder: [],
};
let supervisorEmployees = [];
let supervisorDrivers = [];
let supervisorGroups = [];

function renderOrderLists() {
  const pickupList = byId("pickupOrderList");
  const dropList = byId("dropOrderList");
  if (!pickupList || !dropList) return;

  if (supervisorState.pickupOrder.length === 0) {
    pickupList.innerHTML = `<p style="font-size: 0.85rem; color: var(--muted); margin: 0;">Select passengers first.</p>`;
    dropList.innerHTML = `<p style="font-size: 0.85rem; color: var(--muted); margin: 0;">Select passengers first.</p>`;
    return;
  }

  const renderSingleList = (container, orderArray, key) => {
    container.innerHTML = orderArray.map((id, idx) => {
      const p = supervisorEmployees.find(emp => emp.id === id);
      const name = p ? p.full_name : "Unknown";
      return `
        <div class="order-item">
          <span>${idx + 1}. ${name}</span>
          <div class="order-controls">
            <button type="button" class="order-btn" data-move-id="${id}" data-move-list="${key}" data-move-dir="-1">↑</button>
            <button type="button" class="order-btn" data-move-id="${id}" data-move-list="${key}" data-move-dir="1">↓</button>
          </div>
        </div>
      `;
    }).join("");
  };

  renderSingleList(pickupList, supervisorState.pickupOrder, "pickup");
  renderSingleList(dropList, supervisorState.dropOrder, "drop");
}

function moveOrderItem(id, listKey, dir) {
  const arr = listKey === "pickup" ? supervisorState.pickupOrder : supervisorState.dropOrder;
  const idx = arr.indexOf(id);
  if (idx === -1) return;
  const targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= arr.length) return;
  
  const temp = arr[idx];
  arr[idx] = arr[targetIdx];
  arr[targetIdx] = temp;
  
  renderOrderLists();
}

function initOrderListDelegation() {
  const handler = (event) => {
    const btn = event.target.closest("[data-move-id]");
    if (!btn) return;
    const id = btn.dataset.moveId;
    const listKey = btn.dataset.moveList;
    const dir = parseInt(btn.dataset.moveDir, 10);
    moveOrderItem(id, listKey, dir);
  };
  
  byId("pickupOrderList")?.addEventListener("click", handler);
  byId("dropOrderList")?.addEventListener("click", handler);
}

function renderGroupsTable(groups) {
  const container = byId("groupsTable");
  if (!container) return;
  
  const list = groups || supervisorGroups;

  if (list.length === 0) {
    container.innerHTML = '<p class="code-block">No ride groups exist.</p>';
    return;
  }
  
  const rows = list.map(group => {
    const passengersNames = group.passengers.map(p => p.full_name).join(", ") || "None";
    const status = group.status || "draft";
    const recurringBadge = group.is_recurring
      ? `<span class="tag" style="background:#7c3aed22;color:#7c3aed;border:1px solid #7c3aed55;margin-left:6px;">🔁 ${(group.recurrence_days || []).join(",").toUpperCase() || "recurring"}</span>`
      : "";
    const postBtn = status === "draft" ? 
      `<button class="primary-button" data-post-group="${group.id}" style="padding: 6px 12px; font-size: 0.85rem; margin-right: 6px; background: #007bff; border-color: #007bff;">Post Ride</button>` : "";
    return `
      <tr>
        <td><strong>${group.name}</strong>${recurringBadge}</td>
        <td>${group.driver_name} (${group.cab_number})</td>
        <td>${passengersNames}</td>
        <td><span class="tag ${status === "ongoing" || status === "started" ? "success" : ""}">${status}</span></td>
        <td>
          ${postBtn}
          <button class="ghost-button" data-edit-group="${group.id}" style="padding: 6px 12px; font-size: 0.85rem; margin-right: 6px;">Edit</button>
          <button class="danger-button" data-delete-group="${group.id}" style="padding: 6px 12px; font-size: 0.85rem;">Delete</button>
        </td>
      </tr>
    `;
  }).join("");
  
  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Group Name</th>
          <th>Driver & Cab</th>
          <th>Passengers</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function startEditGroup(groupId) {
  const group = supervisorGroups.find(g => g.id === groupId);
  if (!group) return;
  
  if (byId("cancelEditBtn")) byId("cancelEditBtn").style.display = "inline-block";
  if (byId("formTitle")) byId("formTitle").textContent = "Edit Ride Group";
  if (byId("submitGroupBtn")) byId("submitGroupBtn").textContent = "Update Ride Group";
  
  byId("groupId").value = group.id;
  byId("groupName").value = group.name;
  byId("groupDriver").value = group.driver_id;
  
  const checkboxes = document.querySelectorAll("#employeeChecklist input[type='checkbox']");
  checkboxes.forEach(cb => {
    cb.checked = group.passenger_ids.includes(cb.value);
  });
  
  // Populate recurring fields
  if (byId("isRecurring")) {
    byId("isRecurring").checked = group.is_recurring || false;
  }
  const recurringFields = byId("recurringFields");
  if (recurringFields) {
    recurringFields.style.display = group.is_recurring ? "block" : "none";
  }
  const dayCheckboxes = document.querySelectorAll("input[name='recurrence_days']");
  dayCheckboxes.forEach(cb => {
    cb.checked = (group.recurrence_days || []).includes(cb.value);
  });
  if (byId("departureTime")) {
    byId("departureTime").value = group.departure_time || "";
  }
  
  supervisorState.pickupOrder = group.pickup_order ? group.pickup_order.sort((a,b) => a.order - b.order).map(o => o.user_id) : [...group.passenger_ids];
  supervisorState.dropOrder = group.drop_order ? group.drop_order.sort((a,b) => a.order - b.order).map(o => o.user_id) : [...group.passenger_ids];
  
  renderOrderLists();
}

function resetSupervisorForm() {
  if (byId("cancelEditBtn")) byId("cancelEditBtn").style.display = "none";
  if (byId("formTitle")) byId("formTitle").textContent = "Create Ride Group";
  if (byId("submitGroupBtn")) byId("submitGroupBtn").textContent = "Create Ride Group";
  
  byId("groupId").value = "";
  byId("groupForm")?.reset();
  
  const recurringFields = byId("recurringFields");
  if (recurringFields) {
    recurringFields.style.display = "none";
  }
  
  supervisorState.pickupOrder = [];
  supervisorState.dropOrder = [];
  renderOrderLists();
}

function setupSupervisorForms() {
  const form = byId("groupForm");
  if (!form) return;
  
  if (form.dataset.bound) return;
  form.dataset.bound = "true";
  
  form.addEventListener("change", (e) => {
    if (e.target.name === "passengers") {
      const id = e.target.value;
      if (e.target.checked) {
        if (!supervisorState.pickupOrder.includes(id)) supervisorState.pickupOrder.push(id);
        if (!supervisorState.dropOrder.includes(id)) supervisorState.dropOrder.push(id);
      } else {
        supervisorState.pickupOrder = supervisorState.pickupOrder.filter(item => item !== id);
        supervisorState.dropOrder = supervisorState.dropOrder.filter(item => item !== id);
      }
      renderOrderLists();
    }
    if (e.target.id === "isRecurring") {
      const recurringFields = byId("recurringFields");
      if (recurringFields) recurringFields.style.display = e.target.checked ? "block" : "none";
    }
  });
  
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = byId("groupResult");
    if (!result) return;
    
    const gid = byId("groupId").value;
    const name = byId("groupName").value;
    const driverId = byId("groupDriver").value;
    
    const isRecurring = byId("isRecurring")?.checked || false;
    const recurrenceDays = isRecurring
      ? [...document.querySelectorAll("input[name='recurrence_days']:checked")].map(cb => cb.value)
      : [];
    const departureTime = isRecurring ? (byId("departureTime")?.value || "") : "";

    const payload = {
      name,
      driver_id: driverId,
      passenger_ids: supervisorState.pickupOrder,
      pickup_order: supervisorState.pickupOrder.map((id, idx) => ({ user_id: id, order: idx + 1 })),
      drop_order: supervisorState.dropOrder.map((id, idx) => ({ user_id: id, order: idx + 1 })),
      is_recurring: isRecurring,
      recurrence_days: recurrenceDays,
      departure_time: departureTime,
    };
    
    try {
      if (gid) {
        await api(`/api/v1/ride-groups/${gid}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        result.style.color = "#4cff7c";
        result.textContent = "Ride group updated successfully.";
      } else {
        await api("/api/v1/ride-groups", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        result.style.color = "#4cff7c";
        result.textContent = "Ride group created successfully.";
      }
      
      resetSupervisorForm();
      await loadSupervisorPage();
      
      setTimeout(() => {
        result.textContent = "";
      }, 3000);
    } catch (err) {
      result.style.color = "#ff7d4d";
      result.textContent = `Error: ${normalizeErrorMessage(parseApiError(err))}`;
    }
  });
  
  initOrderListDelegation();
  
  byId("cancelEditBtn")?.addEventListener("click", () => {
    resetSupervisorForm();
  });
  
  byId("groupsTable")?.addEventListener("click", async (e) => {
    const editId = e.target.dataset.editGroup;
    const deleteId = e.target.dataset.deleteGroup;
    const postId = e.target.dataset.postGroup;
    
    if (editId) {
      startEditGroup(editId);
    } else if (postId) {
      try {
        await api(`/api/v1/ride-groups/${postId}`, {
          method: "PUT",
          body: JSON.stringify({ status: "pending" })
        });
        await loadSupervisorPage();
      } catch (err) {
        alert(`Failed to post ride: ${normalizeErrorMessage(parseApiError(err))}`);
      }
    } else if (deleteId) {
      if (confirm("Are you sure you want to delete this ride group?")) {
        try {
          await api(`/api/v1/ride-groups/${deleteId}`, {
            method: "DELETE"
          });
          await loadSupervisorPage();
        } catch (err) {
          alert(`Failed to delete group: ${normalizeErrorMessage(parseApiError(err))}`);
        }
      }
    }
  });
}

async function loadSupervisorPage(groupPage = 1) {
  await loadCurrentUser();
  initDashboardDate();
  
  const [employees, drivers, groupsRes, active, notifications] = await Promise.all([
    api("/api/v1/ride-groups/employees").catch(() => []),
    api("/api/v1/ride-groups/drivers").catch(() => []),
    api(`/api/v1/ride-groups?page=${groupPage}&limit=10`).catch(() => ({ items: [], total: 0, page: 1, pages: 1 })),
    api("/api/v1/tracking/active").catch(() => []),
    api("/api/v1/notifications").catch(() => []),
  ]);

  const groups = groupsRes.items || [];
  const groupTotalPages = groupsRes.pages || 1;
  
  supervisorEmployees = employees;
  supervisorDrivers = drivers;
  supervisorGroups = groups;
  
  if (byId("metricGroups")) byId("metricGroups").textContent = groupsRes.total ?? groups.length;
  if (byId("metricEmployees")) byId("metricEmployees").textContent = employees.length;
  if (byId("metricDrivers")) byId("metricDrivers").textContent = drivers.length;
  
  const driverSelect = byId("groupDriver");
  if (driverSelect) {
    driverSelect.innerHTML = '<option value="" disabled selected>Select an approved driver</option>' +
      drivers.map(d => `<option value="${d.id}">${d.full_name} (${d.license_number || "No License"})</option>`).join("");
  }
  
  const checklist = byId("employeeChecklist");
  if (checklist) {
    if (employees.length === 0) {
      checklist.innerHTML = '<p class="code-block" style="margin: 0; padding: 8px;">No approved employees found.</p>';
    } else {
      checklist.innerHTML = employees.map(e => {
        const pk = e.pickup_point;
        const pkLabel = pk ? (pk.label || `${pk.latitude.toFixed(4)}, ${pk.longitude.toFixed(4)}`) : "No pickup point set";
        return `
          <label class="checklist-item">
            <input type="checkbox" name="passengers" value="${e.id}" />
            <span>${e.full_name} (${pkLabel})</span>
          </label>
        `;
      }).join("");
    }
  }
  
  renderGroupsTable(groups);
  renderPagination("groupsPagination", groupPage, groupTotalPages,
    (p) => loadSupervisorPage(p));
  setupSupervisorForms();
  setupSupervisorTabs();

  ensureNotificationDrawer();
  updateNotificationState(notifications || []);
  startNotificationPolling();
  loadAllAvailabilityLogs().catch(() => {});

  const bell = byId("notificationBell");
  if (bell && !bell.dataset.bound) {
    bell.dataset.bound = "true";
    bell.addEventListener("click", () => openNotificationDrawer());
  }

  // Setup unavailability toggle in main dashboard
  const navUnavailability = byId("navUnavailability");
  const unavailabilityCard = byId("unavailabilityCard");
  
  if (navUnavailability && unavailabilityCard && !navUnavailability.dataset.bound) {
    navUnavailability.dataset.bound = "true";
    navUnavailability.addEventListener("click", () => {
      const isVisible = unavailabilityCard.style.display !== "none";
      unavailabilityCard.style.display = isVisible ? "none" : "block";
      navUnavailability.classList.toggle("active");
    });
  }

  updateMap(active || []);
  startTrackingWebSocket();
}

function setupSupervisorTabs() {
  const navRideGroups = byId("navRideGroups");
  const navEmployeeMap = byId("navEmployeeMap");
  const rideGroupsSection = byId("rideGroupsSection");
  const employeeMapSection = byId("employeeMapSection");
  const supervisorTitle = byId("supervisorTitle");

  if (!navRideGroups || !navEmployeeMap || !rideGroupsSection || !employeeMapSection) return;

  if (navRideGroups.dataset.bound) return;
  navRideGroups.dataset.bound = "true";

  navRideGroups.addEventListener("click", (e) => {
    e.preventDefault();
    navRideGroups.classList.add("active");
    navEmployeeMap.classList.remove("active");
    rideGroupsSection.style.display = "block";
    employeeMapSection.style.display = "none";
    if (supervisorTitle) {
      supervisorTitle.textContent = "Create ride groups, assign drivers, and manage pickup order";
    }
  });

  navEmployeeMap.addEventListener("click", (e) => {
    e.preventDefault();
    navEmployeeMap.classList.add("active");
    navRideGroups.classList.remove("active");
    rideGroupsSection.style.display = "none";
    employeeMapSection.style.display = "block";
    if (supervisorTitle) {
      supervisorTitle.textContent = "Bird's eye view of all employee pickup locations";
    }
    
    // Initialize & populate employee pickup map
    setTimeout(() => {
      initAllEmployeesMap();
    }, 100);
  });
}

function getInitials(fullName) {
  if (!fullName) return "??";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function initAllEmployeesMap() {
  if (!window.L || !byId("allEmployeesMap")) return;

  if (!state.allEmployeesMap) {
    state.allEmployeesMap = L.map("allEmployeesMap").setView([22.32414, 73.16594], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.allEmployeesMap);
  } else {
    // Clear previous markers
    state.allEmployeesMap.eachLayer((layer) => {
      if (layer instanceof L.Marker) {
        state.allEmployeesMap.removeLayer(layer);
      }
    });
  }

  // Clear tracked markers array
  state.allEmployeeMarkers = [];

  // Draw office marker
  const officeCoord = [22.32414, 73.16594];
  L.marker(officeCoord, {
    icon: L.divIcon({
      className: 'office-marker-icon',
      html: `<div style="background-color: #ff3366; color: white; width: 28px; height: 28px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 1.1rem;">🏢</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    })
  })
  .addTo(state.allEmployeesMap)
  .bindPopup(`<strong>Aditi Vadodara Office</strong><br>Destination`);

  const markerBounds = [officeCoord];

  // Draw employee markers
  supervisorEmployees.forEach(e => {
    const pk = e.pickup_point;
    if (pk && pk.latitude && pk.longitude) {
      const coord = [pk.latitude, pk.longitude];
      markerBounds.push(coord);

      const initials = getInitials(e.full_name);

      const marker = L.marker(coord, {
        icon: L.divIcon({
          className: 'passenger-marker-icon',
          html: `<div class="passenger-initials-badge" style="background-color: var(--accent); color: #000; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; border: 2px solid #000; box-shadow: 0 2px 6px rgba(0,0,0,0.4); font-size: 0.85rem; font-family: 'Inter', sans-serif;">${initials}</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15]
        })
      })
      .addTo(state.allEmployeesMap)
      .bindPopup(`
        <strong style="color: #000;">${e.full_name}</strong><br>
        <span style="color: #444;">Email: ${e.email}</span><br>
        <span style="color: #444;">EMP ID: ${e.employee_id || "N/A"}</span><br>
        <span style="color: #444;">Dept: ${e.department || "N/A"}</span><br>
        <span style="color: #444;">Location: ${pk.label || "Home"}</span>
      `)
      .bindTooltip(e.full_name, {
        permanent: false,
        direction: 'top',
        className: 'marker-hover-tooltip'
      });

      state.allEmployeeMarkers.push({
        employeeId: e.employee_id,
        fullName: e.full_name,
        email: e.email,
        marker: marker
      });
    }
  });

  // Fit bounds to fit the office and all employees
  if (markerBounds.length > 1) {
    state.allEmployeesMap.fitBounds(markerBounds, { padding: [50, 50] });
  } else {
    state.allEmployeesMap.setView(officeCoord, 12);
  }

  // Bind Search events
  const searchInput = byId("employeeSearchInput");
  const searchBtn = byId("employeeSearchBtn");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "true";

    const performSearch = () => {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) return;

      const found = state.allEmployeeMarkers.find(item => 
        item.fullName.toLowerCase().includes(query) || 
        (item.employeeId && item.employeeId.toLowerCase().includes(query)) ||
        (item.email && item.email.toLowerCase().includes(query))
      );

      if (found) {
        state.allEmployeesMap.setView(found.marker.getLatLng(), 16);
        found.marker.openPopup();
        const el = found.marker.getElement();
        if (el) {
          el.classList.remove("marker-highlight-pulse");
          void el.offsetWidth; // trigger reflow
          el.classList.add("marker-highlight-pulse");
          setTimeout(() => {
            el.classList.remove("marker-highlight-pulse");
          }, 2500);
        }
      } else {
        searchInput.style.borderColor = "#ff4d4d";
        setTimeout(() => {
          searchInput.style.borderColor = "var(--border)";
        }, 1500);
      }
    };

    searchBtn?.addEventListener("click", performSearch);
    searchInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") performSearch();
    });
  }
}

async function initProtectedPage(loader, expectedRole) {
  if (state.role && expectedRole && state.role !== expectedRole) {
    redirectForRole(state.role);
    return;
  }

  try {
    initLogout();
    const refreshButton = byId("refreshButton");
    if (refreshButton) refreshButton.addEventListener("click", () => loader());
    const chatForm = byId("chatForm");
    if (chatForm) chatForm.addEventListener("submit", handleChat);
    await loader();
  } catch (error) {
    if (state.token) {
      clearSession();
      window.location.href = currentPage === "auth" ? "./index.html" : "../index.html";
    }
  }
}

function initAuthPage() {
  if (state.token && state.role) {
    redirectForRole(state.role);
    return;
  }
  byId("loginForm")?.addEventListener("submit", handleLogin);
  byId("signupForm")?.addEventListener("submit", handleSignup);
}

window.addEventListener("DOMContentLoaded", () => {
  initTheme();

  if (currentPage === "auth") {
    initAuthPage();
    return;
  }

  if (currentPage === "admin") {
    initProtectedPage(loadAdminOverviewPage, "admin");
    return;
  }

  if (currentPage === "admin-approval") {
    initProtectedPage(loadAdminApprovalPage, "admin");
    return;
  }

  if (currentPage === "admin-ride") {
    initProtectedPage(loadAdminRidePage, "admin");
    return;
  }

  if (currentPage === "admin-people") {
    initProtectedPage(loadAdminPeoplePage, "admin");
    return;
  }

  if (currentPage === "admin-ai") {
    initProtectedPage(loadAdminAiPage, "admin");
    return;
  }

  if (currentPage === "admin-map") {
    initProtectedPage(loadAdminMapPage, "admin");
    return;
  }

  if (currentPage === "supervisor") {
    initProtectedPage(loadSupervisorPage, "supervisor");
    return;
  }

  if (currentPage === "employee") {
    initProtectedPage(() => loadRoleRidePage(filterEmployeeRides), "employee");
    return;
  }

  if (currentPage === "driver") {
    initProtectedPage(async () => {
      await loadRoleRidePage(filterDriverRides);
    }, "driver");
    return;
  }

  if (currentPage === "escort") {
    initProtectedPage(() => loadRoleRidePage(filterEscortRides), "escort");
  }
});

