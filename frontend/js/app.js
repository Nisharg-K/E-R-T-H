const AUTH_ROLE_ROUTES = {
  admin: "./pages/admin.html",
  employee: "./pages/employee.html",
  driver: "./pages/driver.html",
  escort: "./pages/escort.html",
};

const PAGE_ROLE_ROUTES = {
  admin: "./admin.html",
  employee: "./employee.html",
  driver: "./driver.html",
  escort: "./escort.html",
};

const state = {
  token: localStorage.getItem("cms-token"),
  role: localStorage.getItem("cms-role"),
  currentUser: null,
  map: null,
  mapReady: false,
  markers: [],
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
  const toggle = byId("themeToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }
}

function persistSession(accessToken, role) {
  state.token = accessToken;
  state.role = role;
  localStorage.setItem("cms-token", accessToken);
  localStorage.setItem("cms-role", role);
}

function clearSession() {
  state.token = null;
  state.role = null;
  state.currentUser = null;
  localStorage.removeItem("cms-token");
  localStorage.removeItem("cms-role");
}

function redirectForRole(role) {
  const route = currentPage === "auth" ? AUTH_ROLE_ROUTES[role] : PAGE_ROLE_ROUTES[role];
  if (!route) {
    window.location.href = currentPage === "auth" ? "./index.html" : "../index.html";
    return;
  }
  window.location.href = route;
}

function updateSessionBadge() {
  const badge = byId("sessionBadge");
  if (badge) {
    badge.textContent = state.currentUser ? `${state.currentUser.full_name} - ${roleLabel(state.currentUser.role)}` : "Signed out";
  }
}

function ensureMap() {
  if (state.mapReady || !window.L || !byId("liveMap")) {
    return;
  }

  state.map = L.map("liveMap").setView([22.3072, 73.1812], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
  state.mapReady = true;
}

function updateMap(markers) {
  ensureMap();
  if (!state.mapReady || !state.map) {
    return;
  }

  state.markers.forEach((marker) => marker.remove());
  state.markers = markers.map((marker) => (
    L.marker([marker.latitude, marker.longitude])
      .addTo(state.map)
      .bindPopup(`<strong>${marker.driver_name}</strong><br>${marker.cab_number || "Cab"}<br>${marker.recorded_at}`)
  ));

  if (state.markers[0]) {
    state.map.setView(state.markers[0].getLatLng(), 12);
  }
}

function renderList(containerId, items, emptyTitle, mapper) {
  const container = byId(containerId);
  if (!container) {
    return;
  }

  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = `<article><strong>${emptyTitle}</strong><small>No records available right now.</small></article>`;
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.innerHTML = mapper(item);
    container.appendChild(article);
  });
}

function renderRidesTable(containerId, rides) {
  const container = byId(containerId);
  if (!container) {
    return;
  }

  if (!rides.length) {
    container.innerHTML = "<p class=\"code-block\">No rides available.</p>";
    return;
  }

  const rows = rides.map((ride) => `
    <tr>
      <td>${ride.ride_reference}</td>
      <td>${ride.pickup_point}</td>
      <td>${ride.drop_point}</td>
      <td>${ride.status}</td>
      <td>${ride.delay_minutes ?? 0}</td>
      <td>${Number(ride.total_cost || 0).toFixed(2)}</td>
    </tr>
  `).join("");

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Reference</th>
          <th>Pickup</th>
          <th>Drop</th>
          <th>Status</th>
          <th>Delay</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function getUnreadCount(notifications) {
  return notifications.filter((item) => !item.is_read).length;
}

function pickCurrentRide(rides) {
  return rides.find((ride) => ride.status === "ongoing" || ride.status === "started") || rides[0] || null;
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
  if (!button) {
    return;
  }

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
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });

    persistSession(response.access_token, response.role);
    byId("loginResult").textContent = `Authenticated as ${response.role}. Redirecting to workspace.`;
    redirectForRole(response.role);
  } catch (error) {
    byId("loginResult").textContent = `Login failed: ${error.message}`;
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    full_name: form.get("full_name"),
    email: form.get("email"),
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
    byId("signupResult").textContent = `Signup failed: ${error.message}`;
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
    byId("chatResult").textContent = response.answer;
  } catch (error) {
    byId("chatResult").textContent = `Query failed: ${error.message}`;
  }
}

function filterEmployeeRides(rides) {
  if (!state.currentUser) {
    return [];
  }
  return rides.filter((ride) => (ride.passengers || []).some((passenger) => passenger.passenger_user_id === state.currentUser.id));
}

function filterDriverRides(rides) {
  return state.currentUser ? rides.filter((ride) => ride.assigned_driver_id === state.currentUser.id) : [];
}

function filterEscortRides(rides) {
  return state.currentUser ? rides.filter((ride) => ride.escort_user_id === state.currentUser.id) : [];
}

function renderCurrentRide(containerId, ride, label) {
  const container = byId(containerId);
  if (!container) {
    return;
  }

  if (!ride) {
    container.innerHTML = `<article><strong>No ${label.toLowerCase()} available</strong><small>There is no assigned active ride right now.</small></article>`;
    return;
  }

  container.innerHTML = `
    <article>
      <span class="tag ${ride.status === "ongoing" || ride.status === "started" ? "success" : ""}">${ride.status}</span>
      <strong class="article-title">${ride.pickup_point} to ${ride.drop_point}</strong>
      <small class="article-meta">Reference: ${ride.ride_reference}<br>Delay minutes: ${ride.delay_minutes ?? 0}<br>Notes: ${ride.notes || "None"}</small>
    </article>
  `;
}

async function loadAdminPage() {
  await loadCurrentUser();
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

  renderRidesTable("ridesTable", rides || []);
  renderList("notificationsList", (notifications || []).slice(0, 6), "No notifications", (item) => `
    <strong>${item.title}</strong>
    <small>${item.message}</small>
  `);
  renderList("usersList", (users || []).slice(0, 6), "No users", (item) => `
    <strong>${item.full_name}</strong>
    <small>${item.role} - ${item.email}</small>
  `);
  renderList("approvalsList", approvals || [], "No pending requests", (item) => `
    <strong>${item.full_name}</strong>
    <small>${item.role} - ${item.email}</small>
    <div class="action-row">
      <button class="ghost-button" type="button" data-approve="${item.id}">Approve</button>
      <button class="danger-button" type="button" data-reject="${item.id}">Reject</button>
    </div>
  `);
  updateMap(active || []);

  const approvalsList = byId("approvalsList");
  if (approvalsList) {
    approvalsList.addEventListener("click", async (event) => {
      const approveId = event.target.dataset.approve;
      const rejectId = event.target.dataset.reject;
      if (!approveId && !rejectId) {
        return;
      }
      const userId = approveId || rejectId;
      const status = approveId ? "approved" : "rejected";
      await api(`/api/v1/auth/${userId}/decision`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await loadAdminPage();
    }, { once: true });
  }
}

async function loadRoleRidePage(filterFn) {
  await loadCurrentUser();
  const [rides, notifications, active] = await Promise.all([
    api("/api/v1/rides").catch(() => []),
    api("/api/v1/notifications").catch(() => []),
    api("/api/v1/tracking/active").catch(() => []),
  ]);

  const scopedRides = filterFn(rides || []);
  const currentRide = pickCurrentRide(scopedRides);

  byId("metricAssigned").textContent = scopedRides.length;
  byId("metricCurrentStatus").textContent = currentRide ? currentRide.status : "None";
  byId("metricUnread").textContent = getUnreadCount(notifications || []);

  renderCurrentRide("currentRideCard", currentRide, "ride");
  renderRidesTable("ridesTable", scopedRides);
  renderList("notificationsList", notifications || [], "No notifications", (item) => `
    <strong>${item.title}</strong>
    <small>${item.message}</small>
  `);
  updateMap(active || []);
}

async function initProtectedPage(loader, expectedRole) {
  if (state.role && expectedRole && state.role !== expectedRole) {
    redirectForRole(state.role);
    return;
  }

  try {
    initLogout();
    const refreshButton = byId("refreshButton");
    if (refreshButton) {
      refreshButton.addEventListener("click", () => loader());
    }
    const chatForm = byId("chatForm");
    if (chatForm) {
      chatForm.addEventListener("submit", handleChat);
    }
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

  byId("loginForm").addEventListener("submit", handleLogin);
  byId("signupForm").addEventListener("submit", handleSignup);
}

window.addEventListener("DOMContentLoaded", () => {
  initTheme();

  if (currentPage === "auth") {
    initAuthPage();
    return;
  }

  if (currentPage === "admin") {
    initProtectedPage(loadAdminPage, "admin");
    return;
  }

  if (currentPage === "employee") {
    initProtectedPage(() => loadRoleRidePage(filterEmployeeRides), "employee");
    return;
  }

  if (currentPage === "driver") {
    initProtectedPage(() => loadRoleRidePage(filterDriverRides), "driver");
    return;
  }

  if (currentPage === "escort") {
    initProtectedPage(() => loadRoleRidePage(filterEscortRides), "escort");
  }
});
