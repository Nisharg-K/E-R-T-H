const AUTH_ROLE_ROUTES = {
  admin: "./pages/admin.html",
  employee: "./pages/employee.html",
  driver: "./pages/driver.html",
  escort: "./pages/escort.html",
  supervisor: "./pages/supervisor.html",
  developer: "./pages/developer.html",
};

const PAGE_ROLE_ROUTES = {
  admin: "./admin.html",
  employee: "./employee.html",
  driver: "./driver.html",
  escort: "./escort.html",
  supervisor: "./supervisor.html",
  developer: "./developer.html",
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
  pickupMap: null,
  pickupMarker: null,
  developerClockInterval: null,
  geolocationWatchId: null,
  routeRequestId: 0,
  activeTrackingMarkers: [],
  rideProgressByDriver: {},
  supervisorRideProgressPoll: null,
  calendarMonth: new Date().toISOString().slice(0, 7),
  calendarEvents: [],
  calendarData: null,
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
  return currentPage === "admin" || currentPage === "admin-approval" || currentPage === "admin-ride" || currentPage === "admin-people" || currentPage === "admin-billing" || currentPage === "admin-map" || currentPage === "admin-ai";
}

function updateSessionBadge() {
  const badge = byId("sessionBadge");
  if (badge) {
    badge.textContent = state.currentUser ? `${state.currentUser.full_name} - ${roleLabel(state.currentUser.role)}` : "Signed out";
  }
}

let headerClockInterval = null;

async function initDashboardDate() {
  const dateDisplay = byId("dashboardDate");
  const routeDateDisplay = byId("routeDateDisplay");
  if (!dateDisplay && !routeDateDisplay) return;

  // Fallback to local time initially
  const localToday = new Date();
  const dateStr = localToday.toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  if (dateDisplay) dateDisplay.textContent = dateStr;
  if (routeDateDisplay) routeDateDisplay.textContent = dateStr;

  if (!state.token) return;

  try {
    let clockData = await api("/api/v1/clock");
    
    if (headerClockInterval) clearInterval(headerClockInterval);

    let tickCount = 0;

    async function updateHeaderDisplay() {
      tickCount++;
      // Poll virtual clock settings from backend every 2 seconds to keep tabs synchronized in real-time
      if (tickCount % 2 === 0) {
        try {
          clockData = await api("/api/v1/clock");
        } catch (e) {
          console.warn("Failed to poll virtual clock settings", e);
        }
      }

      if (!clockData.use_custom_time) {
        const activeDate = new Date();
        const dStr = activeDate.toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        if (dateDisplay) dateDisplay.textContent = dStr;
        if (routeDateDisplay) routeDateDisplay.textContent = dStr;
      } else {
        const realNow = new Date();
        const baseReal = new Date(clockData.set_at_real_time);
        const baseMock = new Date(clockData.custom_time);
        const elapsedReal = (realNow - baseReal) / 1000.0;
        const elapsedMock = elapsedReal * clockData.multiplier;
        
        // Add 5.30 hours offset to display local IST virtual time on dashboards (since backend base is UTC)
        const mockNowUtc = new Date(baseMock.getTime() + elapsedMock * 1000.0);
        const mockNowIst = new Date(mockNowUtc.getTime() + (5.5 * 60 * 60 * 1000));
        
        const dStr = mockNowIst.toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        const tStr = mockNowIst.toISOString().substring(11, 19);
        const htmlContent = `🕰️ <span style="color: var(--accent); font-weight: bold;">${dStr} ${tStr}</span> <span style="font-size: 0.75rem; opacity: 0.8;">(${clockData.multiplier.toFixed(1)}x)</span>`;
        
        if (dateDisplay) dateDisplay.innerHTML = htmlContent;
        if (routeDateDisplay) routeDateDisplay.innerHTML = htmlContent;
      }
    }

    updateHeaderDisplay();
    headerClockInterval = setInterval(updateHeaderDisplay, 1000);
  } catch (err) {
    console.warn("Failed to sync header virtual clock", err);
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

function getDriverMarkerGroupKey(marker) {
  const lat = Math.round(Number(marker.latitude) * 10000);
  const lng = Math.round(Number(marker.longitude) * 10000);
  return `${lat}:${lng}`;
}

function getSeparatedDriverMarkerLatLng(marker, index, markers) {
  if (state.currentUser?.role !== "supervisor") {
    return [marker.latitude, marker.longitude];
  }

  const groupKey = getDriverMarkerGroupKey(marker);
  const group = markers.filter(item => getDriverMarkerGroupKey(item) === groupKey);
  if (group.length <= 1) {
    return [marker.latitude, marker.longitude];
  }

  const groupIndex = group.findIndex(item => item.driver_id === marker.driver_id);
  const offsetIndex = groupIndex >= 0 ? groupIndex : index;
  const angle = (Math.PI * 2 * offsetIndex) / group.length;
  const radius = 0.00008;
  const latOffset = Math.sin(angle) * radius;
  const lngScale = Math.max(Math.cos(Number(marker.latitude) * Math.PI / 180), 0.3);
  const lngOffset = (Math.cos(angle) * radius) / lngScale;

  return [Number(marker.latitude) + latOffset, Number(marker.longitude) + lngOffset];
}

function updateMap(markers) {
  ensureMap();
  if (!state.mapReady || !state.map) return;
  state.activeTrackingMarkers = markers || [];

  // Clear previous driver/cab markers
  state.markers.forEach((marker) => marker.remove());
  state.markers = [];

  // Clear any existing route layers (polylines, passenger/office markers)
  if (state.routeLayers) {
    state.routeLayers.forEach(layer => layer.remove());
  }
  state.routeLayers = [];
  state.routeRequestId += 1;
  const routeRequestId = state.routeRequestId;

  const role = state.currentUser?.role;

  // --- Role 1: Admin or Supervisor ---
  if (role === "admin" || role === "supervisor") {
    // Live location of all active cabs
    state.markers = markers.map((marker, index) => (
      L.marker(getSeparatedDriverMarkerLatLng(marker, index, markers), {
        zIndexOffset: 1000,
        driver_id: marker.driver_id,
        driver_name: marker.driver_name,
        cab_number: marker.cab_number,
      })
        .addTo(state.map)
        .bindPopup(renderActiveDriverPopup(marker))
    ));

    // Center on first marker if not centered yet
    if (state.markers[0] && !state.mapCentered) {
      state.map.setView(state.markers[0].getLatLng(), 12);
      state.mapCentered = true;
    }
  }

  // --- Role 2: Driver ---
  else if (role === "driver") {
    // If driver is spoofed, set driverLatLng to the mock location from watchers
    const activeMock = (markers || []).find(m => m.driver_id === state.currentUser?.id);
    if (activeMock) {
      state.driverLatLng = [activeMock.latitude, activeMock.longitude];
    }

    // "Pickup plan, 1,2,3....n. Only when ride is on."
    const ride = state.currentRide;
    const isRideOn = ride && (ride.status === "started" || ride.status === "ongoing" || ride.status === "pending");
    
    // Draw driver self position marker
    if (state.driverLatLng) {
      const driverMarker = L.marker(state.driverLatLng, {
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: 'driver-marker-icon',
          html: `<div style="background-color: #00ff66; color: #000; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid #000; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 0.85rem;">🚕</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        })
      })
      .addTo(state.map)
    }

    if (isRideOn) {
      const isDrop = ride.route_type === "drop";
      const pathCoords = [];
      const officeCoord = [22.32414, 73.16594];

      if (state.driverLatLng) {
        pathCoords.push(state.driverLatLng);
      }

      // Build ordered waypoint list from stops
      const stops = (isDrop ? (ride.drop_order || []) : (ride.pickup_order || []))
        .filter(p => p.latitude && p.longitude)
        .map(p => ({ user_id: p.user_id, latlng: [p.latitude, p.longitude], full_name: p.full_name }));

      if (isDrop) {
        pathCoords.push(officeCoord);
      }
      stops.forEach(p => pathCoords.push(p.latlng));
      if (!isDrop) {
        pathCoords.push(officeCoord);
      }

      // Determine completed state per passenger based on route direction
      const isStopCompleted = (userId) => {
        const statuses = ride.passengers || [];
        const found = statuses.find(s => (s.id === userId || s.passenger_user_id === userId || s.user_id === userId));
        if (!found || !found.trip_status) return false;
        return isDrop 
          ? (found.trip_status.status === "dropped" || !!found.trip_status.dropped_at) 
          : (found.trip_status.boarded || found.trip_status.status === "picked_up" || !!found.trip_status.picked_up_at);
      };

      // Find index of first not-completed passenger
      let activeIndex = stops.findIndex(p => !isStopCompleted(p.user_id));
      if (activeIndex === -1) activeIndex = stops.length; // no active stops, next is office or end

      // Leg sequence starting from current active index
      const legs = [];
      const origin = state.driverLatLng || (isDrop ? officeCoord : (stops.length ? stops[0].latlng : null));
      if (origin) {
        let prev = origin;
        for (let i = activeIndex; i < stops.length; i++) {
          legs.push({ from: prev, to: stops[i].latlng, passenger: stops[i], index: i });
          prev = stops[i].latlng;
        }
        if (!isDrop) {
          legs.push({ from: prev, to: officeCoord, passenger: null, index: stops.length });
        }
      }

      // Draw active leg in blue and upcoming legs as lighter blue; skip completed legs
      legs.forEach((leg) => {
        if (leg.index < activeIndex) return; // completed -> do not render
        if (leg.index === activeIndex) {
          // active leg -> bright blue
          drawRoadRouteSegment(leg.from, leg.to, { color: '#0078FF', weight: 6, opacity: 0.95 }, routeRequestId).catch(() => {});
        } else {
          // upcoming legs -> faint blue
          drawRoadRouteSegment(leg.from, leg.to, { color: '#0078FF', weight: 4, opacity: 0.38 }, routeRequestId).catch(() => {});
        }
      });

      // If all stops completed, draw fallback full path
      if (activeIndex >= stops.length && ride.status === 'completed') {
        if (state.driverLatLng && pathCoords.length >= 2) {
          drawRoadRoute(pathCoords, routeRequestId).catch(() => {});
        }
      }
      
      // Place passenger markers only for not-completed passengers
      stops.forEach((p, idx) => {
        const completed = isStopCompleted(p.user_id);
        if (completed) return;
        const pinHtml = `<div style="background-color:#ffcc00;color:#000;width:18px;height:18px;border-radius:9px;border:2px solid #000;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:bold;">${idx + 1}</div>`;
        const marker = L.marker(p.latlng, {
          icon: L.divIcon({ className: 'pickup-marker', html: pinHtml, iconSize: [22,22], iconAnchor: [11,11] }),
        }).addTo(state.map).bindPopup(`<strong>${escapeHtml(p.full_name || 'Passenger')}</strong><br>${isDrop ? 'Not Dropped' : 'Not Boarded'}`);
        state.routeLayers.push(marker);
      });

      // Add Office destination marker
      const officeMarker = L.marker(officeCoord, {
        icon: L.divIcon({
          className: 'office-marker-icon',
          html: `<div style="background-color: #ff3366; color: white; width: 28px; height: 28px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 1.1rem;">🏢</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        })
      })
      .addTo(state.map)
      .bindPopup(`<strong>Aditi Vadodara Office</strong><br>${isDrop ? 'Origin' : 'Destination'}`);

      state.routeLayers.push(officeMarker);
    }
  }

  // --- Role 3: Employee (User) ---
  else if (role === "employee") {
    // "Live Location of only their current driver (no further route)... Only when Ride is on."
    const ride = state.currentRide;
    const isRideOn = ride && (ride.status === "started" || ride.status === "ongoing" || ride.status === "pending");

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
        const driverMarker = L.marker([Number(activeDriver.latitude), Number(activeDriver.longitude)], {
          zIndexOffset: 1000,
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
        // Draw route and passenger markers for employee to visualize progress
        try {
          const isDrop = ride.route_type === "drop";
          const officeCoord = [22.32414, 73.16594];
          const stops = (isDrop ? (ride.drop_order || []) : (ride.pickup_order || []))
            .filter(p => p.latitude && p.longitude)
            .map(p => ({ user_id: p.user_id, latlng: [p.latitude, p.longitude], full_name: p.full_name }));
          const origin = activeDriver ? [activeDriver.latitude, activeDriver.longitude] : (state.driverLatLng || (isDrop ? officeCoord : (stops.length ? stops[0].latlng : null)));

          const isStopCompleted = (userId) => {
            const statuses = ride.passengers || [];
            const found = statuses.find(s => (s.id === userId || s.passenger_user_id === userId || s.user_id === userId));
            if (!found || !found.trip_status) return false;
            return isDrop 
              ? (found.trip_status.status === "dropped" || !!found.trip_status.dropped_at) 
              : (found.trip_status.boarded || found.trip_status.status === "picked_up" || !!found.trip_status.picked_up_at);
          };

          let activeIndex = stops.findIndex(p => !isStopCompleted(p.user_id));
          if (activeIndex === -1) activeIndex = stops.length;

          // construct legs starting from current active index
          const legs = [];
          if (origin) {
            let prev = origin;
            for (let i = activeIndex; i < stops.length; i++) {
              legs.push({ from: prev, to: stops[i].latlng, index: i });
              prev = stops[i].latlng;
            }
            if (!isDrop) {
              legs.push({ from: prev, to: officeCoord, index: stops.length });
            }
          }
          // Draw active leg in blue and upcoming legs as lighter blue; skip completed legs
          legs.forEach((leg) => {
            if (leg.index < activeIndex) return;
            if (leg.index === activeIndex) {
              drawRoadRouteSegment(leg.from, leg.to, { color: '#0078FF', weight: 6, opacity: 0.95 }, routeRequestId).catch(() => {});
            } else {
              drawRoadRouteSegment(leg.from, leg.to, { color: '#0078FF', weight: 4, opacity: 0.38 }, routeRequestId).catch(() => {});
            }
          });
          // If employee's ride reached completion, draw the full route
          if (activeIndex >= stops.length && ride.status === 'completed') {
            if (origin && pathCoords && pathCoords.length >= 2) {
              drawRoadRoute(pathCoords, routeRequestId).catch(() => {});
            }
          }
          // Render markers only for not-completed passengers
          stops.forEach((p, idx) => {
            const completed = isStopCompleted(p.user_id);
            if (completed) return;
            const pinHtml = `<div style="background-color:#ffcc00;color:#000;width:18px;height:18px;border-radius:9px;border:2px solid #000;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:bold;">${idx + 1}</div>`;
            const marker = L.marker(p.latlng, { icon: L.divIcon({ className: 'pickup-marker', html: pinHtml, iconSize: [22,22], iconAnchor: [11,11] }) }).addTo(state.map).bindPopup(`<strong>${escapeHtml(p.full_name || 'Passenger')}</strong><br>${isDrop ? 'Not Dropped' : 'Not Boarded'}`);
            state.routeLayers.push(marker);
          });
          const officeMarker = L.marker(officeCoord, { icon: L.divIcon({ className: 'office-marker-icon', html: `<div style="background-color: #ff3366; color: white; width: 28px; height: 28px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.5); font-size: 1.1rem;">🏢</div>`, iconSize: [28,28], iconAnchor: [14,14] }) }).addTo(state.map).bindPopup(`<strong>Aditi Vadodara Office</strong><br>${isDrop ? 'Origin' : 'Destination'}`);
          state.routeLayers.push(officeMarker);
        } catch (e) {}
      }
    }
  }
}

async function drawRoadRoute(coordsLatLng, routeRequestId = state.routeRequestId) {
  // OSRM expects lon,lat order
  const waypoints = coordsLatLng.map(c => `${c[1]},${c[0]}`).join(";");
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${waypoints}?overview=full&geometries=geojson`;

  let routeDrawn = false;

  try {
    const response = await fetch(osrmUrl);
    const data = await response.json();
    if (routeRequestId !== state.routeRequestId) return;

    if (data.code === "Ok" && data.routes && data.routes[0]) {
      const geojson = data.routes[0].geometry;

      const routeLayer = L.geoJSON(geojson, {
        style: {
          color: "#0078FF",
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
    if (routeRequestId !== state.routeRequestId) return;
    const fallbackLine = L.polyline(coordsLatLng, {
      color: "#0078FF",
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

async function drawRoadRouteSegment(fromLatLng, toLatLng, style = {}, routeRequestId = state.routeRequestId) {
  // Build OSRM request for a single leg (lon,lat order)
  const a = `${fromLatLng[1]},${fromLatLng[0]}`;
  const b = `${toLatLng[1]},${toLatLng[0]}`;
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${a};${b}?overview=full&geometries=geojson`;

  try {
    const response = await fetch(osrmUrl);
    const data = await response.json();
    if (routeRequestId !== state.routeRequestId) return;
    if (data.code === "Ok" && data.routes && data.routes[0]) {
      const geojson = data.routes[0].geometry;
      const routeLayer = L.geoJSON(geojson, {
        style: {
          color: style.color || '#0078FF',
          weight: style.weight || 6,
          opacity: style.opacity ?? 0.95,
          lineJoin: 'round',
          lineCap: 'round'
        }
      }).addTo(state.map);
      state.routeLayers.push(routeLayer);

      if (!state.mapCentered) {
        state.map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });
        state.mapCentered = true;
      }
      return true;
    }
  } catch (err) {
    console.warn("OSRM segment routing failed, falling back to straight line:", err);
  }

  if (routeRequestId !== state.routeRequestId) return;
  const fallback = L.polyline([fromLatLng, toLatLng], {
    color: style.color || '#0078FF',
    weight: style.weight || 5,
    opacity: style.opacity ?? 0.9,
    dashArray: style.dashArray || null
  }).addTo(state.map);
  state.routeLayers.push(fallback);
  if (!state.mapCentered) {
    state.map.fitBounds(fallback.getBounds(), { padding: [50, 50] });
    state.mapCentered = true;
  }
  return false;
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
        const currentMarkers = [...(state.activeTrackingMarkers || [])];
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getMonthLabel(month) {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(year, monthIndex - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function shiftMonth(month, offset) {
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(year, monthIndex - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getCalendarBadgeClass(type) {
  return `calendar-event ${String(type || "").toLowerCase().replace(/\s+/g, "-")}`;
}

function getCalendarEventPriority(type) {
  if (type === "Leave") return 1;
  if (type === "Boarded") return 2;
  return 3;
}

function getCalendarEventTypes(events) {
  return [...new Set((events || []).map(event => event.type))]
    .sort((a, b) => getCalendarEventPriority(a) - getCalendarEventPriority(b));
}

function summarizeCalendarEvent(event) {
  const person = event.employee?.full_name || event.driver?.full_name || "";
  const time = event.departure_time ? ` at ${event.departure_time}` : "";
  const group = event.ride_group_name ? ` - ${event.ride_group_name}` : "";
  return `${event.type}${person ? `: ${person}` : ""}${group}${time}`;
}

function renderCalendarLegend() {
  const container = byId("calendarLegend");
  if (!container) return;
  const types = ["Ride", "Leave", "Boarded"];
  container.innerHTML = types.map((type) => `<span class="${getCalendarBadgeClass(type)}">${type}</span>`).join("");
}

function renderCalendarDetails(dateKey, events) {
  const container = byId("calendarDetails");
  if (!container) return;
  if (!dateKey) {
    container.innerHTML = '<p class="code-block">Select a date to inspect schedules and leave signals.</p>';
    return;
  }
  const date = new Date(`${dateKey}T00:00:00`);
  const title = date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  if (!events.length) {
    container.innerHTML = `<article><strong>${title}</strong><small>No calendar events for this date.</small></article>`;
    return;
  }
  container.innerHTML = `
    <article>
      <strong>${title}</strong>
      <div class="calendar-detail-list">
        ${events.map((event) => `
          <div class="calendar-detail-item">
            <span class="${getCalendarBadgeClass(event.type)}">${escapeHtml(event.type)}</span>
            <strong>${escapeHtml(event.title || summarizeCalendarEvent(event))}</strong>
            <small>
              ${event.ride_group_name ? `Ride: ${escapeHtml(event.ride_group_name)}<br>` : ""}
              ${event.driver?.full_name ? `Driver: ${escapeHtml(event.driver.full_name)}<br>` : ""}
              ${event.employee?.full_name ? `Employee: ${escapeHtml(event.employee.full_name)}<br>` : ""}
              ${event.passengers?.length ? `Passengers: ${event.passengers.map((p) => `${escapeHtml(p.full_name || "Passenger")}${p.trip_status?.boarded ? " (Boarded)" : ""}`).join(", ")}<br>` : ""}
              ${event.boarding_status?.boarded ? `Boarded at: ${escapeHtml(event.boarding_status.boarded_at || "Recorded")}<br>` : ""}
              ${event.reason ? `Reason: ${escapeHtml(event.reason)}<br>` : ""}
              ${event.reroute_candidate ? "Marked for future rerouting review" : ""}
            </small>
            ${event.can_board ? `<button type="button" class="primary-button" data-board-ride="${escapeHtml(event.ride_group_id)}" style="width: fit-content; padding: 7px 12px; font-size: 0.82rem;">I've Boarded the Cab</button>` : ""}
          </div>
        `).join("")}
      </div>
    </article>
  `;
  bindBoardButtons();
}

function renderCalendar(data) {
  const grid = byId("calendarGrid");
  if (!grid || !data) return;

  const month = data.month || state.calendarMonth;
  const [year, monthIndex] = month.split("-").map(Number);
  const firstDay = new Date(year, monthIndex - 1, 1);
  const calendarStart = new Date(firstDay);
  calendarStart.setDate(firstDay.getDate() - ((firstDay.getDay() + 6) % 7));
  const todayKey = new Date().toISOString().slice(0, 10);
  const selected = state.selectedCalendarDate || todayKey;

  const eventsByDate = (data.events || []).reduce((acc, event) => {
    if (!acc[event.date]) acc[event.date] = [];
    acc[event.date].push(event);
    return acc;
  }, {});

  const label = byId("calendarMonthLabel");
  if (label) label.textContent = getMonthLabel(month);

  const tabs = byId("calendarMonthTabs");
  if (tabs) {
    const months = [-2, -1, 0, 1, 2, 3].map((offset) => shiftMonth(month, offset));
    tabs.innerHTML = months.map((item) => `
      <button type="button" class="calendar-month-tab ${item === month ? "active" : ""}" data-calendar-month="${item}">
        ${new Date(`${item}-01T00:00:00`).toLocaleString("en-US", { month: "short" })}
      </button>
    `).join("");
  }

  const weekDays = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(calendarStart);
    day.setDate(calendarStart.getDate() + index);
    const key = day.toISOString().slice(0, 10);
    const dayEvents = eventsByDate[key] || [];
    const eventTypes = getCalendarEventTypes(dayEvents);
    const outside = day.getMonth() !== monthIndex - 1;
    const hasLeave = dayEvents.some((event) => event.type === "Leave");
    cells.push(`
      <button type="button" class="calendar-day ${outside ? "outside" : ""} ${key === todayKey ? "today" : ""} ${key === selected ? "selected" : ""} ${hasLeave ? "has-leave" : ""}" data-calendar-date="${key}">
        <span class="calendar-date-num">${day.getDate()}</span>
        <span class="calendar-events-stack">
          ${eventTypes.map((type) => `<span class="${getCalendarBadgeClass(type)}">${escapeHtml(type)}</span>`).join("")}
          ${dayEvents.length > 1 ? `<span class="calendar-more">${dayEvents.length} item${dayEvents.length === 1 ? "" : "s"}</span>` : ""}
        </span>
      </button>
    `);
  }

  grid.innerHTML = `
    ${weekDays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}
    ${cells.join("")}
  `;

  const reroute = byId("calendarRerouteSummary");
  if (reroute) {
    const leaveDates = data.rerouting?.leave_dates || [];
    reroute.innerHTML = data.rerouting?.ready
      ? `<strong>${leaveDates.length}</strong><span>leave date${leaveDates.length === 1 ? "" : "s"} flagged for future rerouting</span>`
      : "";
  }

  renderCalendarLegend();
  renderCalendarDetails(selected, eventsByDate[selected] || []);
  bindBoardButtons();
}

async function loadCalendarModule(month = state.calendarMonth) {
  if (!byId("calendarGrid")) return null;
  state.calendarMonth = month;
  const data = await api(`/api/v1/calendar?month=${encodeURIComponent(month)}`).catch(() => ({
    month,
    events: [],
    rerouting: { ready: false, leave_dates: [] },
  }));
  state.calendarData = data;
  state.calendarEvents = data.events || [];
  renderCalendar(data);
  return data;
}

function setupCalendarInteractions() {
  const shell = byId("calendarModule");
  if (!shell || shell.dataset.bound) return;
  shell.dataset.bound = "true";
  shell.addEventListener("click", async (event) => {
    const monthButton = event.target.closest("[data-calendar-month]");
    if (monthButton) {
      state.selectedCalendarDate = null;
      await loadCalendarModule(monthButton.dataset.calendarMonth);
      return;
    }

    const dateButton = event.target.closest("[data-calendar-date]");
    if (dateButton && state.calendarData) {
      state.selectedCalendarDate = dateButton.dataset.calendarDate;
      renderCalendar(state.calendarData);
      return;
    }

    const boardButton = event.target.closest("[data-board-ride]");
    if (boardButton) {
      boardButton.disabled = true;
      boardButton.textContent = "Boarding...";
      try {
        await api(`/api/v1/calendar/rides/${boardButton.dataset.boardRide}/board`, { method: "POST" });
        await loadCalendarModule();
      } catch (error) {
        boardButton.disabled = false;
        boardButton.textContent = "I've Boarded the Cab";
        alert(`Failed to mark boarded: ${normalizeErrorMessage(parseApiError(error))}`);
      }
    }
  });
}

// Bind click handlers to any boarding buttons rendered into the page
function bindBoardButtons() {
  document.querySelectorAll("[data-board-ride]").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const rideId = btn.dataset.boardRide;
      if (!rideId) return;
      btn.disabled = true;
      const prevText = btn.textContent;
      btn.textContent = "Boarding...";
      try {
        await api(`/api/v1/calendar/rides/${rideId}/board`, { method: "POST" });
        // show confirmation
        btn.textContent = "Boarded";
        // update nearby passenger status text if present
        const parent = btn.closest("li") || btn.closest(".calendar-detail-item");
        if (parent) {
          const small = parent.querySelector("small");
          if (small) small.textContent = "Boarded";
        }
        // refresh supervisor/driver views and markers quickly
        try {
          await refreshSupervisorRideProgress();
          const active = await api("/api/v1/tracking/active").catch(() => []);
          updateMap(active || []);
        } catch (_) {}
      } catch (err) {
        btn.disabled = false;
        btn.textContent = prevText || "I've Boarded the Cab";
        alert(`Failed to mark boarded: ${normalizeErrorMessage(parseApiError(err))}`);
      }
    });
  });
}

function setupRoleTabs(defaultTitle) {
  const navRide = byId("navCurrentRide");
  const navCalendar = byId("navCalendar");
  const rideSection = byId("rideDashboardSection");
  const calendarSection = byId("calendarSection");
  const title = byId("rolePageTitle");
  if (!navRide || !navCalendar || !rideSection || !calendarSection) return;
  if (navRide.dataset.bound) return;
  navRide.dataset.bound = "true";

  navRide.addEventListener("click", (event) => {
    event.preventDefault();
    document.querySelectorAll(".nav-list .nav-item").forEach((item) => item.classList.remove("active"));
    navRide.classList.add("active");
    rideSection.style.display = "block";
    calendarSection.style.display = "none";
    ["sectionCurrentRide", "sectionRideHistory", "sectionCabUnavailability", "sectionDailyPickup"].forEach((sectionId) => {
      const section = byId(sectionId);
      if (section) section.style.display = sectionId === "sectionCurrentRide" ? "block" : "none";
    });
    if (title) title.textContent = defaultTitle;
  });

  navCalendar.addEventListener("click", async (event) => {
    event.preventDefault();
    document.querySelectorAll(".nav-list .nav-item").forEach((item) => item.classList.remove("active"));
    navCalendar.classList.add("active");
    rideSection.style.display = "none";
    calendarSection.style.display = "block";
    if (title) title.textContent = "Calendar schedule and availability";
    setupCalendarInteractions();
    await loadCalendarModule();
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

function isActiveRide(ride) {
  return ride && (ride.status === "ongoing" || ride.status === "started");
}

function getPassengerTripStatus(passenger) {
  return passenger.trip_status || { status: "pending", picked_up_at: null, dropped_at: null };
}

function formatPassengerStatus(status) {
  const labels = {
    pending: "Pending",
    picked_up: "Picked Up",
    dropped: "Dropped",
  };
  return labels[status] || "Pending";
}

function getPassengerProgressIcon(status) {
  if (status === "dropped") return "✅";
  if (status === "picked_up") return "🚕";
  return "⏳";
}

function getPassengerProgressLabel(status) {
  if (status === "dropped") return "Dropped";
  if (status === "picked_up") return "In Transit";
  return "Pending";
}

function setRideProgressCache(rides) {
  const cache = {};
  (rides || []).forEach((ride) => {
    if (isActiveRide(ride) && ride.assigned_driver_id) {
      cache[ride.assigned_driver_id] = ride;
    }
  });
  state.rideProgressByDriver = cache;
}

async function refreshSupervisorRideProgress() {
  if (state.currentUser?.role !== "supervisor") return;
  const rides = await api("/api/v1/rides?limit=100").catch(() => null);
  const ridesList = Array.isArray(rides) ? rides : (rides?.items || []);
  setRideProgressCache(ridesList);
}

function startSupervisorRideProgressPolling() {
  if (state.supervisorRideProgressPoll) clearInterval(state.supervisorRideProgressPoll);
  if (state.currentUser?.role !== "supervisor") return;
  state.supervisorRideProgressPoll = window.setInterval(async () => {
    await refreshSupervisorRideProgress();
    if (state.activeTrackingMarkers.length) {
      updateMap(state.activeTrackingMarkers);
    }
  }, 10000);
}

function renderActiveDriverPopup(marker) {
  const baseHtml = `<strong>${marker.driver_name}</strong><br>Driver ID: ${marker.driver_id || "N/A"}<br>${marker.cab_number || "Cab"}<br>${marker.recorded_at}`;
  if (state.currentUser?.role !== "supervisor") return baseHtml;

  const ride = state.rideProgressByDriver[marker.driver_id];
  if (!ride) return baseHtml;

  const passengers = ride.passengers || [];
  const counts = passengers.reduce((acc, passenger) => {
    const boarded = !!(passenger.trip_status && passenger.trip_status.boarded);
    if (boarded) acc.boarded += 1;
    else acc.notBoarded += 1;
    return acc;
  }, { boarded: 0, notBoarded: 0 });

  const passengerList = passengers.length
    ? passengers.map((passenger) => {
      const boarded = !!(passenger.trip_status && passenger.trip_status.boarded);
      const boardedAt = passenger.trip_status && passenger.trip_status.boarded_at ? new Date(passenger.trip_status.boarded_at).toLocaleTimeString() : null;
      return `<div>${boarded ? '🟢' : '⚪'} ${escapeHtml(passenger.full_name || "Passenger")} ${boarded ? `(Boarded${boardedAt ? ` at ${boardedAt}` : ''})` : '(Not Boarded)'}</div>`;
    }).join("")
    : "<div>No passengers assigned</div>";

  return `
    ${baseHtml}
    <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid #ddd;">
      <strong>Ride Details:</strong><br>
      Total Passengers: ${passengers.length}<br>
      Boarded: ${counts.boarded}<br>
      Not Boarded: ${counts.notBoarded}
    </div>
    <div style="margin-top: 8px;">
      <strong>Passenger List:</strong>
      <div style="margin-top: 4px; line-height: 1.35;">${passengerList}</div>
    </div>
  `;
}

function renderPassengerStatusAction(ride, passenger) {
  // Pickup/Drop workflow removed: drivers have no per-passenger action buttons.
  return "";
}

function renderCurrentRide(containerId, ride, label) {
  const container = byId(containerId);
  if (!container) return;
  if (!ride) {
    container.innerHTML = `<article><strong>No ${label.toLowerCase()} available</strong><small>There is no assigned active ride right now.</small></article>`;
    return;
  }

  // Render a compact passenger list showing boarded state. Pickup/drop sequence removed.
  let sequenceHtml = "";
  // Normalize passenger entries: rides API may provide `passenger_user_id` and no names,
  // while pickup_order contains resolved `full_name`. Merge them so we always have id + full_name + trip_status.
  const pickupNameMap = (ride.pickup_order || []).reduce((acc, p) => {
    if (p.user_id) acc[p.user_id] = p.full_name || acc[p.user_id] || "Passenger";
    return acc;
  }, {});
  const passengers = (ride.passengers || []).map(p => {
    const id = p.id || p.user_id || p.passenger_user_id;
    const full_name = p.full_name || pickupNameMap[id] || "Passenger";
    return { id, full_name, trip_status: p.trip_status || {} };
  });
  if (!passengers.length) {
    const isDrop = ride.route_type === "drop";
    const orderList = isDrop ? (ride.drop_order || []) : (ride.pickup_order || []);
    orderList.forEach(p => passengers.push({ id: p.user_id, full_name: p.full_name || "Passenger", trip_status: p.trip_status || {} }));
  }

  if (state.currentUser?.role === "driver") {
    const renderLeg = (title, stops, start, end) => {
      const items = (stops || []).map(stop => `<li>${escapeHtml(stop.full_name || "Passenger")}</li>`).join("");
      return `
        <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px;">
          <strong style="font-size: 0.85rem; color: var(--muted);">${title}</strong>
          <ol style="margin: 4px 0 0 16px; font-size: 0.85rem; line-height: 1.4;">
            ${start ? `<li><strong>${start}</strong></li>` : ""}
            ${items || "<li><em>No employee stops for this leg</em></li>"}
            ${end ? `<li><strong>${end}</strong></li>` : ""}
          </ol>
        </div>
      `;
    };
    if (ride.route_type === "drop") {
      sequenceHtml = renderLeg("Drop route", ride.drop_order, "Aditi Vadodara Office", "");
    } else {
      sequenceHtml = renderLeg("Pickup route", ride.pickup_order, "", "Aditi Vadodara Office");
    }
  } else if (passengers.length) {
      const listItems = passengers.map((p) => {
      const isMe = state.currentUser && state.currentUser.id === p.id;
      const isDrop = ride.route_type === "drop";
      const completed = isDrop 
        ? (p.trip_status?.status === "dropped" || !!p.trip_status?.dropped_at)
        : (p.trip_status?.boarded);
      const timeText = isDrop 
        ? (p.trip_status?.dropped_at ? ` at ${new Date(p.trip_status.dropped_at).toLocaleTimeString()}` : "")
        : (p.trip_status?.boarded_at ? ` at ${new Date(p.trip_status.boarded_at).toLocaleTimeString()}` : "");
      const statusText = completed
        ? (isDrop ? `Reached Home${timeText}` : `Boarded${timeText}`)
        : (isDrop ? "In Transit" : "Not Boarded");

      const actionButton = (isMe && !completed && (ride.status === "started" || ride.status === "ongoing"))
        ? (isDrop 
          ? `<button type="button" class="primary-button" data-reach-home-ride="${ride.id}" style="width: fit-content; padding: 7px 12px; font-size: 0.82rem; background: #059669; border-color: #059669;">I've Reached Home</button>`
          : `<button type="button" class="primary-button" data-board-ride="${ride.id}" data-board-passenger="${escapeHtml(p.id)}" style="width: fit-content; padding: 7px 12px; font-size: 0.82rem;">I've Boarded the Cab</button>`)
        : "";
      return `
        <li style="margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center; gap:12px;">
          <span>${isMe ? `<strong>${escapeHtml(p.full_name)} (You)</strong>` : escapeHtml(p.full_name)}<br><small style="color:var(--muted);">${statusText}</small></span>
          ${actionButton}
        </li>
      `;
    }).join("");

    sequenceHtml += `
      <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px;">
        <strong style="font-size: 0.85rem; color: var(--muted);">Passengers</strong>
        <ol style="margin: 4px 0 0 16px; font-size: 0.85rem; line-height: 1.4;">
          ${listItems}
        </ol>
      </div>
    `;
  } else {
    sequenceHtml += `
      <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px;">
        <p style="font-size: 0.85rem; color: var(--muted); margin: 0;">No passengers assigned.</p>
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
  bindBoardButtons();
}

function filterEmployeeRides(rides) {
  if (!state.currentUser) return [];
  return rides.filter((ride) => (ride.passengers || []).some((passenger) => {
    const id = passenger.id || passenger.user_id || passenger.passenger_user_id;
    return id === state.currentUser.id;
  }));
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

  if (byId("metricMonthlyCost")) {
    byId("metricMonthlyCost").textContent = `₹${Number(stats.total_monthly_cost || 0).toFixed(2)}`;
  }
  if (byId("metricMonthlyTrips")) {
    byId("metricMonthlyTrips").textContent = stats.total_completed_trips ?? 0;
  }

  ensureNotificationDrawer();
  updateNotificationState(notifications || []);
  updateMap(active || []);
  startNotificationPolling();
  startTrackingWebSocket();
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
        deadlineDiv.innerHTML = "You can record your availability even when no ride is assigned. Admin and supervisors will be notified.";
        deadlineDiv.style.color = "var(--muted)";
        deadlineDiv.style.display = "block";
        informBtn.disabled = false;
        cancelBtn.disabled = false;
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
        const savedAvailability = await api("/api/v1/availability/me", {
          method: "PUT",
          body: JSON.stringify({
            date: date,
            pickup_not_needed: pickupNotNeeded,
            drop_not_needed: dropNotNeeded,
            reason: reasonInput.value || null
          })
        });
        
        resultDiv.style.color = savedAvailability.already_informed ? "var(--muted)" : "#4cff7c";
        resultDiv.textContent = savedAvailability.already_informed
          ? savedAvailability.message
          : `✓ Successfully informed: ${statusText}`;
        
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

  // Initialize pickup map in global state
  if (!state.pickupMap) {
    state.pickupMap = L.map("pickupMap").setView([22.3072, 73.1812], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.pickupMap);

    // Click-to-place on map
    state.pickupMap.on("click", (e) => {
      setPickupLocation(e.latlng.lat, e.latlng.lng);
    });
  }

  function setPickupLocation(lat, lng) {
    latInput.value = lat.toFixed(6);
    lngInput.value = lng.toFixed(6);
    coordsSpan.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    saveBtn.disabled = false;

    if (state.pickupMarker) {
      state.pickupMarker.setLatLng([lat, lng]);
    } else {
      state.pickupMarker = L.marker([lat, lng], { draggable: true }).addTo(state.pickupMap);
      state.pickupMarker.on("dragend", () => {
        const pos = state.pickupMarker.getLatLng();
        setPickupLocation(pos.lat, pos.lng);
      });
    }
    state.pickupMap.setView([lat, lng], Math.max(state.pickupMap.getZoom(), 15));
  }

  // Pre-fill from saved data
  const saved = state.currentUser?.pickup_point;
  if (saved && saved.latitude && saved.longitude) {
    setPickupLocation(saved.latitude, saved.longitude);
    if (saved.label) labelInput.value = saved.label;
  }

  // GPS one-shot locate
  if (gpsBtn && !gpsBtn.dataset.bound) {
    gpsBtn.dataset.bound = "true";
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
  setTimeout(() => state.pickupMap.invalidateSize(), 200);
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

async function updatePassengerTripStatus(groupId, passengerId, status, filterFn) {
  try {
    await api(`/api/v1/ride-groups/${groupId}/passengers/${passengerId}/status`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
    await loadRoleRidePage(filterFn);
  } catch (err) {
    alert(`Failed to update passenger status: ${normalizeErrorMessage(parseApiError(err))}`);
  }
}

function renderRidesCardsList(containerId, rides) {
  const container = byId(containerId);
  if (!container) return;
  if (!rides || rides.length === 0) {
    container.innerHTML = `<p class="code-block" style="grid-column: span 3; text-align: center;">No ride history available.</p>`;
    return;
  }

  const cardsHtml = rides.map(ride => {
    // Show compact passenger list with boarding state. Pickup/Drop sequence removed.
    let sequenceHtml = "";
    // Normalize passenger entries similar to renderCurrentRide: prefer resolved passenger ids and names
    const isDrop = ride.route_type === "drop";
    const orderList = isDrop ? (ride.drop_order || []) : (ride.pickup_order || []);
    const nameMap = orderList.reduce((acc, p) => { if (p.user_id) acc[p.user_id] = p.full_name || acc[p.user_id] || "Passenger"; return acc; }, {});
    const passengers = (ride.passengers || []).map(p => ({ id: p.id || p.user_id || p.passenger_user_id, full_name: p.full_name || nameMap[p.user_id || p.passenger_user_id] || "Passenger", trip_status: p.trip_status || {} }));
    if (!passengers.length) {
      orderList.forEach(p => passengers.push({ id: p.user_id, full_name: p.full_name || "Passenger", trip_status: p.trip_status || {} }));
    }
    if (passengers.length) {
      const listItems = passengers.map(p => {
        const completed = isDrop 
          ? (p.trip_status?.status === "dropped" || !!p.trip_status?.dropped_at)
          : (p.trip_status?.boarded);
        const timeText = isDrop 
          ? (p.trip_status?.dropped_at ? ` at ${new Date(p.trip_status.dropped_at).toLocaleTimeString()}` : "")
          : (p.trip_status?.boarded_at ? ` at ${new Date(p.trip_status.boarded_at).toLocaleTimeString()}` : "");
        const statusLabelText = completed
          ? (isDrop ? `Reached Home${timeText}` : `Boarded${timeText}`)
          : (isDrop ? "In Transit" : "Not Boarded");
        return `
          <li style="margin-bottom: 4px;">
            ${state.currentUser && state.currentUser.id === (p.id || p.user_id) ? `<strong>${escapeHtml(p.full_name)} (You)</strong>` : escapeHtml(p.full_name)}<br>
            <small style="color: var(--muted);">${statusLabelText}</small>
          </li>
        `;
      }).join("");
      sequenceHtml += `
        <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 8px;">
          <strong style="font-size: 0.85rem; color: var(--muted);">Passengers</strong>
          <ol style="margin: 4px 0 0 16px; font-size: 0.85rem; line-height: 1.4; color: var(--text);">
            ${listItems}
          </ol>
        </div>
      `;
    }

    let boardingStatusLabel = "Pending";
    if (state.currentUser && Array.isArray(ride.passengers)) {
      const me = ride.passengers.find(p => (p.id === state.currentUser.id || p.passenger_user_id === state.currentUser.id));
      if (me) {
        const completed = isDrop
          ? (me.trip_status?.status === "dropped" || !!me.trip_status?.dropped_at)
          : (me.trip_status?.boarded);
        const timeText = isDrop
          ? (me.trip_status?.dropped_at ? ` at ${new Date(me.trip_status.dropped_at).toLocaleTimeString()}` : "")
          : (me.trip_status?.boarded_at ? ` at ${new Date(me.trip_status.boarded_at).toLocaleTimeString()}` : "");
        boardingStatusLabel = completed
          ? (isDrop ? `Reached Home${timeText}` : `Boarded${timeText}`)
          : (isDrop ? "In Transit" : "Not Boarded");
      }
    }

    return `
      <div class="card" style="border: 1px solid var(--border); border-radius: 8px; padding: 16px; background: rgba(255,255,255,0.02); display: flex; flex-direction: column; gap: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
          <span class="tag ${ride.status === "completed" ? "muted" : (ride.status === "started" || ride.status === "ongoing" ? "success" : "")}" style="text-transform: uppercase; font-weight: 700; font-size: 0.75rem;">${ride.status}</span>
          <span style="font-size: 0.8rem; color: var(--muted); font-family: monospace;">${ride.ride_reference}</span>
        </div>
        <div>
          <strong style="font-size: 1.1rem; color: var(--accent); display: block; margin-bottom: 6px;">Trip summary</strong>
          <div style="font-size: 0.85rem; line-height: 1.5; color: var(--text);">
            <strong>Driver:</strong> ${ride.driver_name || "Unassigned"} (${ride.cab_number})<br>
            <strong>Route:</strong> ${ride.pickup_point} to ${ride.drop_point}<br>
            <strong>Delay:</strong> ${ride.delay_minutes ?? 0} mins<br>
            <strong>Est. Cost:</strong> ₹${Number(ride.total_cost || 0).toFixed(2)}
          </div>
        </div>
        ${sequenceHtml}
        <div style="margin-top: 8px; font-size: 0.85rem; font-weight: 600; color: var(--accent); text-align: right;">
          Status: ${boardingStatusLabel}
        </div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; width: 100%;">
      ${cardsHtml}
    </div>
  `;
  bindBoardButtons();
}

function setupEmployeeTabs() {
  const tabs = [
    { navId: "navCurrentRide", sectionId: "sectionCurrentRide" },
    { navId: "navRideHistory", sectionId: "sectionRideHistory" },
    { navId: "navCabUnavailability", sectionId: "sectionCabUnavailability" },
    { navId: "navDailyPickup", sectionId: "sectionDailyPickup" }
  ];

  tabs.forEach(tab => {
    const navEl = byId(tab.navId);
    if (navEl && !navEl.dataset.bound) {
      navEl.dataset.bound = "true";
      navEl.addEventListener("click", (e) => {
        e.preventDefault();
        
        // Remove active class from all nav items
        tabs.forEach(t => {
          const el = byId(t.navId);
          if (el) el.classList.remove("active");
          const sec = byId(t.sectionId);
          if (sec) sec.style.display = "none";
        });
        byId("navCalendar")?.classList.remove("active");
        const rideDashboard = byId("rideDashboardSection");
        const calendarSection = byId("calendarSection");
        if (rideDashboard) rideDashboard.style.display = "block";
        if (calendarSection) calendarSection.style.display = "none";

        // Add active class and show section
        navEl.classList.add("active");
        const targetSec = byId(tab.sectionId);
        if (targetSec) targetSec.style.display = "block";

        // Invalidate map sizes
        if (tab.sectionId === "sectionCurrentRide" && state.map) {
          setTimeout(() => state.map.invalidateSize(), 100);
        } else if (tab.sectionId === "sectionDailyPickup" && state.pickupMap) {
          setTimeout(() => state.pickupMap.invalidateSize(), 100);
        }
      });
    }
  });
}

async function loadRoleRidePage(filterFn) {
  await loadCurrentUser();
  initDashboardDate();
  initPickupPointSettings();
  initAvailabilityForm();
  
  setupRoleTabs(
    state.currentUser?.role === "driver"
      ? "Today's routes, status, and tracking"
      : "Your cab schedule, live updates, and trip history"
  );
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

  if (state.currentUser && state.currentUser.role === "employee") {
    setupEmployeeTabs();
    renderRidesCardsList("ridesCardsList", scopedRides);
  }

  const card = byId("currentRideCard");
  if (card && !card.dataset.bound) {
    card.dataset.bound = "true";
    card.addEventListener("click", async (e) => {
      const startId = e.target.dataset.startRide;
      const completeId = e.target.dataset.completeRide;
      const delayId = e.target.dataset.delayRide;
      const delayVal = e.target.dataset.delayVal;
      const boardRideId = e.target.dataset.boardRide;
      const reachHomeRideId = e.target.dataset.reachHomeRide;

      if (boardRideId) {
        const boardBtn = e.target;
        boardBtn.disabled = true;
        const prevText = boardBtn.textContent;
        boardBtn.textContent = "Boarding...";
        try {
          await api(`/api/v1/calendar/rides/${boardRideId}/board`, { method: "POST" });
          await loadRoleRidePage(filterFn);
        } catch (err) {
          boardBtn.disabled = false;
          boardBtn.textContent = prevText || "I've Boarded the Cab";
          alert(`Failed to mark boarded: ${normalizeErrorMessage(parseApiError(err))}`);
        }
      } else if (reachHomeRideId) {
        const reachBtn = e.target;
        reachBtn.disabled = true;
        const prevText = reachBtn.textContent;
        reachBtn.textContent = "Updating...";
        try {
          await api(`/api/v1/calendar/rides/${reachHomeRideId}/reach-home`, { method: "POST" });
          await loadRoleRidePage(filterFn);
        } catch (err) {
          reachBtn.disabled = false;
          reachBtn.textContent = prevText || "I've Reached Home";
          alert(`Failed to mark reached home: ${normalizeErrorMessage(parseApiError(err))}`);
        }
      } else if (startId) {
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
  setupCalendarInteractions();
  await loadCalendarModule();
  startNotificationPolling();
  startTrackingWebSocket();

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

// ═══════════════════════════════════════════════════════════════════════════
// RAG AI Chat
// ═══════════════════════════════════════════════════════════════════════════
let aiChatHistory = [];

const QUICK_QUESTIONS = [
  "What is the total billing for June 2026?",
  "How many trips were completed in May 2026?",
  "How many approved employees are there?",
  "Show me pending approval requests",
  "Who rode with me on 2026-06-15?",
  "How many trips did each driver complete in July?",
];

function renderAiMessage(role, content, isStreaming = false) {
  const thread = byId("aiChat");
  if (!thread) return null;

  const div = document.createElement("div");
  div.className = `ai-msg ai-msg-${role}`;
  div.innerHTML = `
    <div class="ai-msg-avatar">${role === "user" ? "👤" : "🤖"}</div>
    <div class="ai-msg-bubble">
      <div class="ai-msg-text">${isStreaming ? '<span class="ai-typing-cursor">▍</span>' : formatAiText(content)}</div>
    </div>
  `;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
  return div;
}

function formatAiText(text) {
  if (!text) return "";
  return text
    // Bold: **text**
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    // INR symbol passthrough
    .replace(/INR\s*([\d,]+\.?\d*)/g, "₹$1")
    // Bullet points
    .replace(/^[ \t]*[-•]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/((<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
    // Headers (===text===)
    .replace(/===(.+?)===/g, "<strong style='color:var(--accent);'>$1</strong>")
    // Line breaks
    .replace(/\n/g, "<br>");
}

async function loadAdminAiPage() {
  await loadCurrentUser();
  initDashboardDate();

  const thread   = byId("aiChat");
  const chatForm = byId("chatForm");
  if (!thread || !chatForm) return;

  // Already initialized guard
  if (chatForm.dataset.aiBound) return;
  chatForm.dataset.aiBound = "true";

  // ── Welcome message ───────────────────────────────────────────────────────
  thread.innerHTML = "";
  aiChatHistory = [];

  const welcomeDiv = document.createElement("div");
  welcomeDiv.className = "ai-welcome";
  welcomeDiv.innerHTML = `
    <div style="text-align:center; padding: 32px 16px;">
      <div style="font-size: 3rem; margin-bottom: 12px;">🤖</div>
      <h3 style="margin:0 0 8px; font-size: 1.3rem;">ERTH AI Assistant</h3>
      <p style="color: var(--muted); margin: 0 0 24px; font-size: 0.9rem; max-width: 440px; margin: 0 auto 24px;">
        Ask me anything about trips, billing, employees, or routes — I query your live database to answer.
      </p>
      <div class="ai-quick-questions">
        ${QUICK_QUESTIONS.map(q => `<button class="ai-quick-btn" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("")}
      </div>
    </div>
  `;
  thread.appendChild(welcomeDiv);

  // ── Quick question buttons ────────────────────────────────────────────────
  thread.addEventListener("click", (e) => {
    const btn = e.target.closest(".ai-quick-btn");
    if (!btn) return;
    const q = btn.dataset.q;
    // Remove welcome card
    welcomeDiv.remove();
    sendAiMessage(q);
  });

  // ── Form submit ───────────────────────────────────────────────────────────
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ta = chatForm.querySelector("textarea");
    const question = ta.value.trim();
    if (!question) return;
    ta.value = "";
    ta.style.height = "auto";
    welcomeDiv.remove();
    await sendAiMessage(question);
  });

  // Auto-grow textarea
  const ta = chatForm.querySelector("textarea");
  if (ta) {
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatForm.dispatchEvent(new Event("submit"));
      }
    });
  }
}

async function sendAiMessage(question) {
  const thread   = byId("aiChat");
  const sendBtn  = document.querySelector("#chatForm button[type=submit]");

  // Render user bubble
  renderAiMessage("user", question);
  aiChatHistory.push({ role: "user", content: question });

  // Disable send while streaming
  if (sendBtn) sendBtn.disabled = true;

  // Create assistant bubble (streaming placeholder)
  const assistantDiv = renderAiMessage("assistant", "", true);
  const textEl = assistantDiv ? assistantDiv.querySelector(".ai-msg-text") : null;
  let fullText = "";

  try {
    const token = localStorage.getItem("auth_token");
    const resp = await fetch("/api/v1/ai/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        question,
        history: aiChatHistory.slice(-20).filter(m => m.role !== "user" || m.content !== question)
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }

    // Read SSE stream
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") break;

        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.token) {
            fullText += parsed.token;
            if (textEl) {
              textEl.innerHTML = formatAiText(fullText) + '<span class="ai-typing-cursor">▍</span>';
              thread.scrollTop = thread.scrollHeight;
            }
          }
        } catch (_) { /* ignore parse errors */ }
      }
    }

    // Final render without cursor
    if (textEl) textEl.innerHTML = formatAiText(fullText) || "(no response)";
    aiChatHistory.push({ role: "assistant", content: fullText });

  } catch (err) {
    if (textEl) {
      textEl.innerHTML = `<span style="color:var(--danger);">⚠️ ${escapeHtml(err.message)}</span>`;
    }
    console.error("AI chat error:", err);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    thread.scrollTop = thread.scrollHeight;
  }
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

let billingRecords = [];

async function loadAdminBillingPage() {
  await loadCurrentUser();
  initDashboardDate();

  const filterMonth = byId("filterMonth");
  const filterDriver = byId("filterDriver");
  const exportBtn = byId("exportCsvBtn");

  if (filterMonth && !filterMonth.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    filterMonth.value = `${yyyy}-${mm}`;
  }

  const selectedMonth = filterMonth ? filterMonth.value : "";
  const selectedDriver = filterDriver ? filterDriver.value : "";

  try {
    const data = await api(`/api/v1/analytics/billing?month=${selectedMonth}&driver_id=${selectedDriver}`);
    billingRecords = data.records || [];

    // Populate driver options if empty (except the default "All Drivers")
    if (filterDriver && filterDriver.options.length <= 1) {
      (data.drivers || []).forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.full_name;
        filterDriver.appendChild(opt);
      });
    }

    // Populate Overview Cards
    if (byId("billingTotalCost")) {
      byId("billingTotalCost").textContent = `₹${Number(data.total_cost_sum || 0).toFixed(2)}`;
    }
    if (byId("billingTotalTrips")) {
      byId("billingTotalTrips").textContent = data.total_trips_count || 0;
    }
    if (byId("billingAvgCost")) {
      byId("billingAvgCost").textContent = `₹${Number(data.average_trip_cost || 0).toFixed(2)}`;
    }

    // Render Spreadsheet Table
    const tableContainer = byId("billingSpreadsheetContainer");
    if (tableContainer) {
      if (billingRecords.length === 0) {
        tableContainer.innerHTML = '<p class="code-block">No billing records found for this criteria.</p>';
      } else {
        const rows = billingRecords.map(r => `
          <tr>
            <td>${escapeHtml(r.ride_date)}</td>
            <td><code style="font-size: 0.8rem; background: rgba(255,255,255,0.05); padding: 2px 4px; border-radius: 4px;">${escapeHtml(r.ride_reference)}</code></td>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td>${escapeHtml(r.driver_name)}</td>
            <td>${escapeHtml(r.cab_number)}</td>
            <td><span class="tag">${escapeHtml(r.route_type.toUpperCase())}</span></td>
            <td style="max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(r.passengers_names)}">${escapeHtml(r.passengers_names)}</td>
            <td>₹${Number(r.total_cost).toFixed(2)}</td>
          </tr>
        `).join("");

        tableContainer.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th>Group Name</th>
                <th>Driver Name</th>
                <th>Cab Number</th>
                <th>Type</th>
                <th>Passengers</th>
                <th>Trip Cost</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr style="background: rgba(255, 222, 0, 0.08); font-weight: 700; border-top: 2px solid var(--border);">
                <td colspan="7" style="text-align: right; text-transform: uppercase; font-size: 0.85rem; color: var(--muted); letter-spacing: 0.05em;">Total Billing Sum:</td>
                <td style="color: var(--accent); font-size: 1.05rem;">₹${Number(data.total_cost_sum || 0).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        `;
      }
    }

  } catch (err) {
    console.error("Failed to load billing ledger data", err);
    const tableContainer = byId("billingSpreadsheetContainer");
    if (tableContainer) {
      tableContainer.innerHTML = '<p class="code-block" style="color: var(--danger);">Error loading financials ledger.</p>';
    }
  }

  // Bind change listeners if not already done
  if (filterMonth && !filterMonth.dataset.bound) {
    filterMonth.dataset.bound = "true";
    filterMonth.addEventListener("change", () => loadAdminBillingPage());
  }
  if (filterDriver && !filterDriver.dataset.bound) {
    filterDriver.dataset.bound = "true";
    filterDriver.addEventListener("change", () => loadAdminBillingPage());
  }

  // Bind export button listener
  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = "true";
    exportBtn.addEventListener("click", () => {
      if (billingRecords.length === 0) {
        alert("No records available to export.");
        return;
      }
      
      const monthLabel = filterMonth ? filterMonth.value : "all_time";
      const headers = ["Date", "Ride Reference", "Group Name", "Driver", "Cab Number", "Route Type", "Passengers", "Cost (INR)"];
      const csvRows = [headers.join(",")];
      
      for (const r of billingRecords) {
        const values = [
          r.ride_date,
          r.ride_reference,
          `"${r.name.replace(/"/g, '""')}"`,
          `"${r.driver_name.replace(/"/g, '""')}"`,
          r.cab_number,
          r.route_type,
          `"${r.passengers_names.replace(/"/g, '""')}"`,
          r.total_cost
        ];
        csvRows.push(values.join(","));
      }
      
      const totalSum = billingRecords.reduce((acc, r) => acc + r.total_cost, 0);
      csvRows.push(`,,,,,,,Total Sum:,${totalSum.toFixed(2)}`);
      
      const csvContent = "data:text/csv;charset=utf-8," + csvRows.join("\n");
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `billing_report_${monthLabel}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }
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
    const isDropRoute = group.route_type === "drop";
    const btnLabel = isDropRoute ? "List Pickup Route" : "List Drop Route";
    const postBtn = status === "draft" ? 
      `<button class="primary-button" data-post-group="${group.id}" style="padding: 6px 12px; font-size: 0.85rem; margin-right: 6px; background: #007bff; border-color: #007bff;">Post Ride</button>` : "";
    const relistBtn = status === "completed" ? 
      `<button class="primary-button" data-relist-group="${group.id}" style="padding: 6px 12px; font-size: 0.85rem; margin-right: 6px; background: #28a745; border-color: #28a745;">${btnLabel}</button>` : "";
    return `
      <tr>
        <td><strong>${group.name}</strong>${recurringBadge}</td>
        <td>${group.driver_name} (${group.cab_number})</td>
        <td>${passengersNames}</td>
        <td>₹${(group.total_cost !== undefined ? group.total_cost : 150.00).toFixed(2)}</td>
        <td><span class="tag ${status === "ongoing" || status === "started" ? "success" : ""}">${status}</span></td>
        <td>
          ${postBtn}
          ${relistBtn}
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
          <th>Cost</th>
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
  if (byId("groupCost")) {
    byId("groupCost").value = group.total_cost !== undefined ? group.total_cost : 150.00;
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
  if (byId("groupCost")) {
    byId("groupCost").value = "150.00";
  }
  
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
    const totalCost = parseFloat(byId("groupCost")?.value) || 150.00;

    const payload = {
      name,
      driver_id: driverId,
      passenger_ids: supervisorState.pickupOrder,
      pickup_order: supervisorState.pickupOrder.map((id, idx) => ({ user_id: id, order: idx + 1 })),
      drop_order: supervisorState.dropOrder.map((id, idx) => ({ user_id: id, order: idx + 1 })),
      is_recurring: isRecurring,
      recurrence_days: recurrenceDays,
      departure_time: departureTime,
      total_cost: totalCost
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
    const relistId = e.target.dataset.relistGroup;
    
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
    } else if (relistId) {
      try {
        await api(`/api/v1/ride-groups/${relistId}/relist`, {
          method: "POST"
        });
        await loadSupervisorPage();
      } catch (err) {
        alert(`Failed to relist ride: ${normalizeErrorMessage(parseApiError(err))}`);
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
  
  const [employees, drivers, groupsRes, ridesRes, active, notifications] = await Promise.all([
    api("/api/v1/ride-groups/employees").catch(() => []),
    api("/api/v1/ride-groups/drivers").catch(() => []),
    api(`/api/v1/ride-groups?page=${groupPage}&limit=10`).catch(() => ({ items: [], total: 0, page: 1, pages: 1 })),
    api("/api/v1/rides?limit=100").catch(() => ({ items: [] })),
    api("/api/v1/tracking/active").catch(() => []),
    api("/api/v1/notifications").catch(() => []),
  ]);

  const groups = groupsRes.items || [];
  const groupTotalPages = groupsRes.pages || 1;
  
  supervisorEmployees = employees;
  supervisorDrivers = drivers;
  supervisorGroups = groups;
  setRideProgressCache(Array.isArray(ridesRes) ? ridesRes : (ridesRes.items || []));
  
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
  setupCalendarInteractions();
  await loadCalendarModule();

  ensureNotificationDrawer();
  updateNotificationState(notifications || []);
  startNotificationPolling();
  loadAllAvailabilityLogs().catch(() => {});

  const bell = byId("notificationBell");
  if (bell && !bell.dataset.bound) {
    bell.dataset.bound = "true";
    bell.addEventListener("click", () => openNotificationDrawer());
  }

  updateMap(active || []);
  startSupervisorRideProgressPolling();
  startTrackingWebSocket();
}

function setupSupervisorTabs() {
  const navRideGroups = byId("navRideGroups");
  const navEmployeeMap = byId("navEmployeeMap");
  const navUnavailability = byId("navUnavailability");
  const navCalendar = byId("navCalendar");
  const rideGroupsSection = byId("rideGroupsSection");
  const employeeMapSection = byId("employeeMapSection");
  const calendarSection = byId("calendarSection");
  const supervisorTitle = byId("supervisorTitle");

  if (!navRideGroups || !navEmployeeMap || !rideGroupsSection || !employeeMapSection) return;

  if (navRideGroups.dataset.bound) return;
  navRideGroups.dataset.bound = "true";

  navRideGroups.addEventListener("click", (e) => {
    e.preventDefault();
    navRideGroups.classList.add("active");
    navEmployeeMap.classList.remove("active");
    navCalendar?.classList.remove("active");
    navUnavailability?.classList.remove("active");
    rideGroupsSection.style.display = "block";
    employeeMapSection.style.display = "none";
    if (calendarSection) calendarSection.style.display = "none";

    const sections = rideGroupsSection.querySelectorAll(".dashboard-grid > section");
    sections.forEach((section) => {
      section.style.display = "block";
    });
    const metricsRow = rideGroupsSection.querySelector(".metrics-row");
    if (metricsRow) metricsRow.style.display = "grid";

    if (supervisorTitle) {
      supervisorTitle.textContent = "Create ride groups, assign drivers, and manage assignments";
    }
  });

  navEmployeeMap.addEventListener("click", (e) => {
    e.preventDefault();
    navEmployeeMap.classList.add("active");
    navRideGroups.classList.remove("active");
    navCalendar?.classList.remove("active");
    navUnavailability?.classList.remove("active");
    rideGroupsSection.style.display = "none";
    employeeMapSection.style.display = "block";
    if (calendarSection) calendarSection.style.display = "none";
    if (supervisorTitle) {
      supervisorTitle.textContent = "Bird's eye view of all employee locations";
    }
    
    // Initialize & populate employee pickup map
    setTimeout(() => {
      initAllEmployeesMap();
    }, 100);
  });

  navUnavailability.addEventListener("click", (e) => {
    e.preventDefault();
    navUnavailability.classList.add("active");
    navRideGroups.classList.remove("active");
    navEmployeeMap.classList.remove("active");
    navCalendar?.classList.remove("active");
    if (rideGroupsSection) rideGroupsSection.style.display = "block";
    if (employeeMapSection) employeeMapSection.style.display = "none";
    if (calendarSection) calendarSection.style.display = "none";

    const sections = rideGroupsSection.querySelectorAll(".dashboard-grid > section");
    sections.forEach((section) => {
      if (section.id === "unavailabilityCard") {
        section.style.display = "block";
      } else {
        section.style.display = "none";
      }
    });

    const metricsRow = rideGroupsSection.querySelector(".metrics-row");
    if (metricsRow) metricsRow.style.display = "none";
    if (supervisorTitle) {
      supervisorTitle.textContent = "Leave and unavailability management";
    }
  });

  navCalendar?.addEventListener("click", async (e) => {
    e.preventDefault();
    navCalendar.classList.add("active");
    navRideGroups.classList.remove("active");
    navEmployeeMap.classList.remove("active");
    navUnavailability.classList.remove("active");
    rideGroupsSection.style.display = "none";
    employeeMapSection.style.display = "none";
    if (calendarSection) calendarSection.style.display = "block";
    if (supervisorTitle) {
      supervisorTitle.textContent = "Calendar schedules, leave dates, and rerouting signals";
    }
    setupCalendarInteractions();
    await loadCalendarModule();
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

      // Determine boarded state by consulting ride progress cache when available
      let boarded = false;
      try {
        Object.values(state.rideProgressByDriver || {}).forEach((r) => {
          (r.passengers || []).forEach((p) => {
            if (p.full_name === e.full_name && p.trip_status && p.trip_status.boarded) boarded = true;
          });
        });
      } catch (err) {
        boarded = false;
      }

      const bgColor = boarded ? '#4cff7c' : 'var(--accent)';

      const marker = L.marker(coord, {
        icon: L.divIcon({
          className: 'passenger-marker-icon',
          html: `<div class="passenger-initials-badge" style="background-color: ${bgColor}; color: #000; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; border: 2px solid #000; box-shadow: 0 2px 6px rgba(0,0,0,0.4); font-size: 0.85rem; font-family: 'Inter', sans-serif;">${initials}</div>`,
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

  if (currentPage === "admin-billing") {
    initProtectedPage(loadAdminBillingPage, "admin");
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
    return;
  }

  if (currentPage === "developer") {
    initProtectedPage(loadDeveloperPage, "developer");
  }
});

async function loadDeveloperPage() {
  await loadCurrentUser();
  initLogout();
  updateSessionBadge();
  
  const form = byId("clockConfigForm");
  const useCustomCheckbox = byId("useCustomTime");
  const customTimeInput = byId("customTimeInput");
  const multiplierInput = byId("multiplierInput");
  const presetSelect = byId("presetMultiplier");
  const resultDiv = byId("clockFormResult");
  
  const metricMode = byId("metricClockMode");
  const metricSpeed = byId("metricClockSpeed");
  const metricDisplay = byId("metricClockDisplay");
  
  const triggerBtn = byId("triggerSchedulerBtn");
  const triggerResult = byId("triggerResult");
  
  if (!form) return;

  // Local state for ticking clock
  let clockConfig = {
    useCustomTime: false,
    customTime: "",
    setAtRealTime: "",
    multiplier: 1.0
  };

  async function fetchClockSettings() {
    try {
      const data = await api("/api/v1/developer/clock");
      clockConfig.useCustomTime = data.use_custom_time;
      clockConfig.customTime = data.custom_time;
      clockConfig.setAtRealTime = data.set_at_real_time;
      clockConfig.multiplier = data.multiplier;
      
      // Update form fields
      useCustomCheckbox.checked = data.use_custom_time;
      
      // Format ISO string to datetime-local format: YYYY-MM-DDTHH:MM:SS
      if (data.custom_time) {
        customTimeInput.value = data.custom_time.substring(0, 19);
      }
      
      multiplierInput.value = data.multiplier;
      presetSelect.value = ["1.0", "10.0", "60.0", "3600.0", "0.0"].includes(String(data.multiplier)) 
        ? String(data.multiplier) 
        : "";
      
      // Update static metrics
      metricMode.textContent = data.use_custom_time ? "Custom Clock" : "Real Time";
      metricSpeed.textContent = data.multiplier.toFixed(1) + "x";
    } catch (err) {
      console.error("Failed to load clock settings", err);
    }
  }

  await fetchClockSettings();

  // Preset multiplier handler
  presetSelect.addEventListener("change", () => {
    if (presetSelect.value !== "") {
      multiplierInput.value = presetSelect.value;
    }
  });

  // Clock Config Form Submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    resultDiv.textContent = "";
    try {
      await api("/api/v1/developer/clock", {
        method: "PUT",
        body: JSON.stringify({
          use_custom_time: useCustomCheckbox.checked,
          custom_time: customTimeInput.value,
          multiplier: parseFloat(multiplierInput.value)
        })
      });
      resultDiv.style.color = "#4cff7c";
      resultDiv.textContent = "Settings applied successfully.";
      await fetchClockSettings();
      setTimeout(() => resultDiv.textContent = "", 3000);
    } catch (err) {
      resultDiv.style.color = "#ff7d4d";
      resultDiv.textContent = "Save failed: " + normalizeErrorMessage(parseApiError(err));
    }
  });

  // Manual Scheduler Trigger
  triggerBtn.addEventListener("click", async () => {
    triggerResult.textContent = "";
    triggerBtn.disabled = true;
    triggerBtn.textContent = "⏳ Triggering scheduler...";
    try {
      const res = await api("/api/v1/developer/trigger-scheduler", { method: "POST" });
      triggerResult.style.color = "#4cff7c";
      triggerResult.textContent = res.message || "Scheduler trigger completed.";
      setTimeout(() => triggerResult.textContent = "", 4000);
    } catch (err) {
      triggerResult.style.color = "#ff7d4d";
      triggerResult.textContent = "Trigger failed: " + normalizeErrorMessage(parseApiError(err));
    } finally {
      triggerBtn.disabled = false;
      triggerBtn.textContent = "⚡ Trigger Scheduler Evaluation";
    }
  });

  // Ticking display clock
  if (state.developerClockInterval) clearInterval(state.developerClockInterval);
  state.developerClockInterval = setInterval(() => {
    if (!clockConfig.useCustomTime) {
      const now = new Date();
      metricDisplay.textContent = now.toISOString().replace("T", " ").substring(0, 19) + " UTC";
    } else {
      const realNow = new Date();
      const baseReal = new Date(clockConfig.setAtRealTime);
      const baseMock = new Date(clockConfig.customTime);
      
      const realElapsedSeconds = (realNow - baseReal) / 1000.0;
      const mockElapsedSeconds = realElapsedSeconds * clockConfig.multiplier;
      
      const mockNow = new Date(baseMock.getTime() + mockElapsedSeconds * 1000.0);
      metricDisplay.textContent = mockNow.toISOString().replace("T", " ").substring(0, 19) + " UTC";
    }
  }, 1000);

  // --- Driver Spoofer Logic ---
  const spDriverSelect = byId("spooferDriverSelect");
  const spEnableCheckbox = byId("spooferEnableCheckbox");
  const spJoyPanel = byId("joystickPanel");
  const spLatDisplay = byId("spooferLatDisplay");
  const spLngDisplay = byId("spooferLngDisplay");
  
  if (!spDriverSelect) return;

  let spooferMap = null;
  let spooferMarker = null;
  let currentDriverCoords = [22.32414, 73.16594];
  let mockedDriversList = [];

  // Setup Leaflet map for spoofer
  if (window.L && byId("spooferMap")) {
    spooferMap = L.map("spooferMap").setView(currentDriverCoords, 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(spooferMap);
  }

  // Load active drivers list
  async function loadDrivers() {
    try {
      const drivers = await api("/api/v1/developer/drivers");
      spDriverSelect.innerHTML = '<option value="">-- Choose a Driver --</option>' +
        drivers.map(d => `<option value="${d.id}">${d.full_name} (${d.license_number || "No Cab"})</option>`).join("");
      
      const spStatus = await api("/api/v1/developer/spoofer/status");
      mockedDriversList = spStatus.mocked_drivers || [];
    } catch (err) {
      console.error("Failed to load spoofer configuration", err);
    }
  }

  await loadDrivers();

  // Helper to publish spoofer coordinates to backend
  async function publishMockLocation(lat, lng) {
    const driverId = spDriverSelect.value;
    if (!driverId) return;
    try {
      await api("/api/v1/developer/mock-location", {
        method: "POST",
        body: JSON.stringify({
          driver_id: driverId,
          latitude: lat,
          longitude: lng
        })
      });
      spLatDisplay.textContent = lat.toFixed(6);
      spLngDisplay.textContent = lng.toFixed(6);
    } catch (err) {
      console.warn("Failed to publish mock location", err);
    }
  }

  // Move marker helper
  function moveMockDriver(dy, dx) {
    if (!spooferMarker) return;
    const step = 0.00015; // smooth step size (approx 15 meters)
    const pos = spooferMarker.getLatLng();
    const newLat = pos.lat + (dy * step);
    const newLng = pos.lng + (dx * step);
    
    spooferMarker.setLatLng([newLat, newLng]);
    spooferMap.panTo([newLat, newLng]);
    publishMockLocation(newLat, newLng);
  }

  // Checkbox state toggle
  spEnableCheckbox.addEventListener("change", async () => {
    const driverId = spDriverSelect.value;
    if (!driverId) return;
    const isEnabled = spEnableCheckbox.checked;
    
    try {
      await api("/api/v1/developer/spoofer/toggle", {
        method: "PUT",
        body: JSON.stringify({
          driver_id: driverId,
          enabled: isEnabled
        })
      });
      
      if (isEnabled) {
        if (!mockedDriversList.includes(driverId)) mockedDriversList.push(driverId);
        spJoyPanel.style.opacity = "1";
        spJoyPanel.style.pointerEvents = "auto";
        if (spooferMarker) {
          spooferMarker.dragging.enable();
        }
        publishMockLocation(currentDriverCoords[0], currentDriverCoords[1]);
      } else {
        mockedDriversList = mockedDriversList.filter(id => id !== driverId);
        spJoyPanel.style.opacity = "0.5";
        spJoyPanel.style.pointerEvents = "none";
        if (spooferMarker) {
          spooferMarker.dragging.disable();
        }
      }
    } catch (err) {
      console.error("Failed to toggle spoofer status", err);
    }
  });

  // Dropdown change handler
  spDriverSelect.addEventListener("change", async () => {
    const driverId = spDriverSelect.value;
    if (!driverId) {
      spEnableCheckbox.disabled = true;
      spEnableCheckbox.checked = false;
      spJoyPanel.style.opacity = "0.5";
      spJoyPanel.style.pointerEvents = "none";
      if (spooferMarker) {
        spooferMap.removeLayer(spooferMarker);
        spooferMarker = null;
      }
      return;
    }
    
    spEnableCheckbox.disabled = false;
    const isMocked = mockedDriversList.includes(driverId);
    spEnableCheckbox.checked = isMocked;
    spJoyPanel.style.opacity = isMocked ? "1" : "0.5";
    spJoyPanel.style.pointerEvents = isMocked ? "auto" : "none";

    // Locate driver's current position (default to office if not found)
    currentDriverCoords = [22.32414, 73.16594];
    try {
      const activeTracking = await api("/api/v1/tracking/active");
      const record = activeTracking.find(t => t.driver_id === driverId);
      if (record && record.latitude && record.longitude) {
        currentDriverCoords = [record.latitude, record.longitude];
      }
    } catch (err) {
      console.warn("Failed to retrieve driver location snapshot", err);
    }

    spLatDisplay.textContent = currentDriverCoords[0].toFixed(6);
    spLngDisplay.textContent = currentDriverCoords[1].toFixed(6);

    spooferMap.setView(currentDriverCoords, 14);

    if (spooferMarker) {
      spooferMap.removeLayer(spooferMarker);
    }

    spooferMarker = L.marker(currentDriverCoords, {
      draggable: isMocked,
      icon: L.divIcon({
        className: 'spoofer-driver-icon',
        html: `<div style="background-color: var(--accent); color: #000; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; border: 3px solid #000; box-shadow: 0 4px 8px rgba(0,0,0,0.5);">🚕</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      })
    }).addTo(spooferMap);

    spooferMarker.on("dragend", () => {
      const pos = spooferMarker.getLatLng();
      publishMockLocation(pos.lat, pos.lng);
    });
  });

  // Joystick buttons click handlers
  byId("joyUp").addEventListener("click", () => moveMockDriver(1, 0));
  byId("joyDown").addEventListener("click", () => moveMockDriver(-1, 0));
  byId("joyLeft").addEventListener("click", () => moveMockDriver(0, -1));
  byId("joyRight").addEventListener("click", () => moveMockDriver(0, 1));

  // Global Keyboard WASD controls
  window.addEventListener("keydown", (e) => {
    if (currentPage !== "developer") return;
    if (!spEnableCheckbox.checked || !spDriverSelect.value) return;
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    
    const key = e.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
      e.preventDefault();
      let dy = 0, dx = 0;
      if (key === "w" || key === "arrowup") dy = 1;
      if (key === "s" || key === "arrowdown") dy = -1;
      if (key === "a" || key === "arrowleft") dx = -1;
      if (key === "d" || key === "arrowright") dx = 1;
      moveMockDriver(dy, dx);
    }
  });
}

