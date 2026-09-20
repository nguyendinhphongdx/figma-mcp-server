/** Single-page Admin UI: plain HTML + vanilla JS, no build step, no framework — matches the
 * project's zero-extra-dependency stack. Served at `GET /`. */
export const ADMIN_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>figma-mcp-server admin</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  section { display: none; }
  section.active { display: block; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font: inherit; }
  button { margin-top: 1rem; padding: 0.5rem 1rem; font: inherit; cursor: pointer; }
  .error { color: #b00020; margin-top: 0.75rem; }
  .hint { opacity: 0.7; font-size: 0.85em; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  td, th { text-align: left; padding: 0.4rem 0.2rem; border-bottom: 1px solid #8884; }
  code.key { display: block; word-break: break-all; padding: 0.75rem; background: #8882; margin-top: 0.5rem; }
  .warn { border: 1px solid #b00020; padding: 0.75rem; margin-top: 0.5rem; }
</style>
</head>
<body>
<h1>figma-mcp-server</h1>

<section id="setup">
  <p>No admin account yet. Create one to continue.</p>
  <label>Username <input id="setup-username" autocomplete="username"></label>
  <label>Password <input id="setup-password" type="password" autocomplete="new-password"></label>
  <button onclick="doSetup()">Create admin account</button>
  <p id="setup-error" class="error"></p>
</section>

<section id="login">
  <p>Sign in to manage this server.</p>
  <label>Username <input id="login-username" autocomplete="username"></label>
  <label>Password <input id="login-password" type="password" autocomplete="current-password"></label>
  <button onclick="doLogin()">Sign in</button>
  <p id="login-error" class="error"></p>
</section>

<section id="dashboard">
  <p>Signed in as <b id="dash-username"></b> &middot; <a href="#" onclick="doLogout();return false;">Sign out</a></p>

  <h2>Figma token</h2>
  <p class="hint" id="token-status"></p>
  <input id="figma-token" type="password" placeholder="figd_...">
  <button onclick="saveToken()">Save token</button>
  <p id="token-error" class="error"></p>

  <h2>Users</h2>
  <table id="users-table"><tbody></tbody></table>
  <label>New user name <input id="new-user-name" placeholder="alice"></label>
  <button onclick="addUser()">Add user</button>
  <p id="users-error" class="error"></p>
  <div id="new-key" style="display:none">
    <p><strong>Copy this key now &mdash; it cannot be shown again:</strong></p>
    <code class="key" id="new-key-value"></code>
  </div>
</section>

<script>
function show(id) {
  for (const el of document.querySelectorAll('section')) el.classList.remove('active');
  document.getElementById(id).classList.add('active');
}

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function refresh() {
  const session = await api('/api/admin/session');
  if (session.needsSetup) { show('setup'); return; }
  if (!session.loggedIn) { show('login'); return; }
  document.getElementById('dash-username').textContent = session.username;
  show('dashboard');
  await Promise.all([loadConfig(), loadUsers()]);
}

async function loadConfig() {
  const config = await api('/api/admin/config');
  document.getElementById('token-status').textContent = config.figmaTokenConfigured
    ? 'Currently set, ending in ' + config.figmaTokenPreview
    : 'Not configured yet.';
}

async function loadUsers() {
  const { users } = await api('/api/admin/users');
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  for (const user of users) {
    const row = document.createElement('tr');
    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke';
    revoke.onclick = () => removeUser(user.name);
    const nameCell = document.createElement('td');
    nameCell.textContent = user.name;
    const actionCell = document.createElement('td');
    actionCell.appendChild(revoke);
    row.append(nameCell, actionCell);
    tbody.appendChild(row);
  }
}

async function doSetup() {
  const username = document.getElementById('setup-username').value;
  const password = document.getElementById('setup-password').value;
  try {
    await api('/api/admin/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
    await refresh();
  } catch (err) { document.getElementById('setup-error').textContent = err.message; }
}

async function doLogin() {
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    await refresh();
  } catch (err) { document.getElementById('login-error').textContent = err.message; }
}

async function doLogout() {
  await api('/api/admin/logout', { method: 'POST' });
  await refresh();
}

async function saveToken() {
  const figmaToken = document.getElementById('figma-token').value;
  document.getElementById('token-error').textContent = '';
  try {
    await api('/api/admin/config', { method: 'PUT', body: JSON.stringify({ figmaToken }) });
    document.getElementById('figma-token').value = '';
    await loadConfig();
  } catch (err) { document.getElementById('token-error').textContent = err.message; }
}

async function addUser() {
  const name = document.getElementById('new-user-name').value;
  document.getElementById('users-error').textContent = '';
  try {
    const added = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ name }) });
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-key').style.display = 'block';
    document.getElementById('new-key-value').textContent = added.key;
    await loadUsers();
  } catch (err) { document.getElementById('users-error').textContent = err.message; }
}

async function removeUser(name) {
  if (!confirm('Revoke the key for "' + name + '"? This cannot be undone.')) return;
  await api('/api/admin/users/' + encodeURIComponent(name), { method: 'DELETE' });
  await loadUsers();
}

refresh();
</script>
</body>
</html>
`;
