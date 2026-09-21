/** Single-page Admin UI: plain HTML + vanilla JS, no build step, no framework — matches the
 * project's zero-extra-dependency stack. Served at `GET /`. Docs content comes from
 * `docs-content.ts` via `/api/docs`. */
export const ADMIN_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>figma-mcp-server admin</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #17171a;
    --bg-sidebar: #101012;
    --bg-card: #1e1e22;
    --bg-input: #2a2a30;
    --border: #303036;
    --text: #e4e4e7;
    --text-dim: #9a9aa4;
    --accent: #18a0fb;
    --accent-hover: #0d8de0;
    --danger: #f2555a;
    --success: #3ecf8e;
    --mono: 'Cascadia Code', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex;
    background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  a { color: var(--accent); }

  /* Sidebar */
  .sidebar { width: 220px; flex-shrink: 0; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .sidebar-logo { padding: 18px 16px 14px; font-weight: 700; font-size: 14px; letter-spacing: 0.2px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
  .sidebar-logo svg { flex-shrink: 0; }
  .sidebar-nav { flex: 1; padding: 10px 0; overflow-y: auto; }
  .nav-section { padding: 14px 16px 6px; font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1.2px; }
  .nav-item { display: flex; align-items: center; gap: 8px; padding: 7px 16px; font-size: 13px; color: var(--text-dim); cursor: pointer; text-decoration: none; border-left: 2px solid transparent; }
  .nav-item:hover { background: #ffffff08; color: var(--text); }
  .nav-item.active { background: #ffffff0d; color: var(--text); border-left-color: var(--accent); }
  .nav-icon { width: 16px; text-align: center; font-size: 13px; opacity: 0.85; }
  .sidebar-foot { padding: 12px 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-dim); }
  .sidebar-foot a { color: var(--text-dim); }

  /* Main / pages */
  .main { flex: 1; overflow-y: auto; }
  .page { display: none; }
  .page.active { display: block; }
  .shell { max-width: 620px; margin: 0 auto; padding: 48px 24px; }

  section { display: none; }
  section.active { display: block; }

  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 14px; }
  .lede { color: var(--text-dim); margin: 0 0 24px; }

  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 22px; margin-bottom: 18px; }
  label { display: block; margin: 12px 0 5px; font-weight: 600; font-size: 13px; }
  label:first-of-type { margin-top: 0; }
  input { width: 100%; padding: 9px 10px; font: inherit; background: var(--bg-input); border: 1px solid var(--border); border-radius: 6px; color: var(--text); }
  input:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: #6b6b74; }
  button { margin-top: 14px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; background: var(--accent); border: none; border-radius: 6px; color: #06202f; }
  button:hover { background: var(--accent-hover); }
  button.secondary { background: var(--bg-input); color: var(--text); border: 1px solid var(--border); }
  button.secondary:hover { background: #34343c; }
  button.danger { background: var(--danger); color: #2b0505; }
  .error { color: var(--danger); margin-top: 10px; font-size: 13px; }
  .hint { color: var(--text-dim); font-size: 0.85em; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  td, th { text-align: left; padding: 8px 4px; border-bottom: 1px solid var(--border); font-size: 13px; }
  td:last-child { text-align: right; }
  code.key { display: block; word-break: break-all; padding: 12px; background: #0d1117; border: 1px solid var(--border); border-radius: 6px; margin-top: 8px; font-family: var(--mono); color: var(--success); font-size: 13px; }
  .warn { border: 1px solid #7a5a00; background: #2a1f00; color: #e2c08d; border-radius: 8px; padding: 12px; margin-top: 12px; font-size: 13px; }
  .status-line { display: flex; align-items: center; gap: 8px; margin: 0 0 20px; font-size: 13px; color: var(--text-dim); }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); flex-shrink: 0; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .card-head h2 { margin: 0; }
  .tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(185px, 1fr)); gap: 12px; margin: 14px 0 10px; }
  .tier { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; background: var(--bg); }
  .tier.blocked { border-color: var(--danger); }
  .tier-name { display: flex; align-items: center; gap: 7px; font-weight: 600; margin-bottom: 2px; }
  .tier-what { color: var(--text-dim); font-size: 0.78em; margin-bottom: 10px; }
  .tier-row { display: flex; justify-content: space-between; font-size: 0.84em; padding: 2px 0; }
  .tier-row span:last-child { font-family: var(--mono); }
  .meter { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; margin: 8px 0 2px; }
  .meter > i { display: block; height: 100%; background: var(--success); }
  .meter.low > i { background: var(--danger); }
  .banner { border-radius: 8px; padding: 12px 14px; margin: 14px 0 4px; font-size: 0.9em; border: 1px solid var(--danger); background: rgba(242, 85, 90, 0.09); }
  .banner b { display: block; margin-bottom: 4px; }
  .banner .hint { margin-top: 6px; }

  /* Docs */
  .docs-shell { max-width: 760px; margin: 0 auto; padding: 44px 32px; }
  .docs-shell h1 { font-size: 26px; border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 4px; }
  .docs-shell h2 { text-transform: none; letter-spacing: normal; font-size: 19px; color: var(--text); margin-top: 30px; }
  .docs-shell h3 { font-size: 15px; color: var(--text); margin-top: 22px; margin-bottom: 6px; }
  .docs-shell p, .docs-shell li { font-size: 14px; line-height: 1.7; color: #c7c7cd; }
  .docs-shell ul, .docs-shell ol { margin: 6px 0 12px 22px; }
  .docs-shell code { background: #0d1117; border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-family: var(--mono); font-size: 12.5px; color: #ce9178; }
  .docs-shell pre { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow-x: auto; margin: 12px 0; }
  .docs-shell pre code { background: none; border: none; padding: 0; color: #d4d4d4; }
  .docs-shell table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
  .docs-shell th { text-align: left; padding: 8px 10px; background: #ffffff08; border: 1px solid var(--border); }
  .docs-shell td { padding: 8px 10px; border: 1px solid var(--border); color: #c7c7cd; }
  .docs-loading { padding: 40px 0; color: var(--text-dim); }

  @media (max-width: 720px) {
    body { flex-direction: column; }
    .sidebar { width: 100%; flex-direction: row; overflow-x: auto; }
    .sidebar-nav { display: flex; padding: 0; }
    .nav-section { display: none; }
    .sidebar-foot { display: none; }
    .shell, .docs-shell { padding: 28px 18px; }
  }
</style>
</head>
<body>
<div class="sidebar">
  <div class="sidebar-logo">
    <svg width="22" height="22" viewBox="0 0 24 24" role="img" aria-label="FMCP">
      <rect width="24" height="24" rx="6" fill="#18a0fb"/>
      <path d="M12 5.5v6" stroke="#0b1520" stroke-width="2" stroke-linecap="round"/>
      <path d="M7.5 8.7a6 6 0 1 0 9 0" stroke="#0b1520" stroke-width="2" stroke-linecap="round" fill="none"/>
    </svg>
    figma-mcp-server
  </div>
  <nav class="sidebar-nav">
    <div class="nav-section">General</div>
    <a class="nav-item active" data-page="home" onclick="navigate('home')">
      <span class="nav-icon">&#8962;</span> Home
    </a>
    <div class="nav-section">Documentation</div>
    <div id="docsNav"></div>
  </nav>
  <div class="sidebar-foot"><a href="https://github.com/hanoilab/figma-mcp-server" target="_blank" rel="noopener">Source on GitHub</a></div>
</div>

<div class="main">
  <div class="page active" id="page-home">
    <div class="shell">

      <section id="setup">
        <h1>Welcome</h1>
        <p class="lede">No admin account yet. Create one to continue.</p>
        <div class="card">
          <label>Username <input id="setup-username" autocomplete="username"></label>
          <label>Password <input id="setup-password" type="password" autocomplete="new-password"></label>
          <button onclick="doSetup()">Create admin account</button>
          <p id="setup-error" class="error"></p>
        </div>
      </section>

      <section id="login">
        <h1>Sign in</h1>
        <p class="lede">Sign in to manage this server.</p>
        <div class="card">
          <label>Username <input id="login-username" autocomplete="username"></label>
          <label>Password <input id="login-password" type="password" autocomplete="current-password"></label>
          <button onclick="doLogin()">Sign in</button>
          <p id="login-error" class="error"></p>
        </div>
      </section>

      <section id="dashboard">
        <div class="status-line"><span class="status-dot"></span> Signed in as <b id="dash-username"></b> &middot; <a href="#" onclick="doLogout();return false;">Sign out</a></div>

        <div class="card">
          <div class="card-head">
            <h2>Figma quota</h2>
            <span class="hint" id="quota-updated"></span>
          </div>
          <p class="hint">One Figma token, one budget, shared by everyone on this server. Reading this page costs nothing.</p>
          <div id="quota-alert"></div>
          <div class="tiers" id="quota-tiers"></div>
          <p class="hint" id="quota-cache"></p>
          <p id="quota-error" class="error"></p>
        </div>

        <div class="card">
          <h2>Figma token</h2>
          <p class="hint" id="token-status"></p>
          <input id="figma-token" type="password" placeholder="figd_...">
          <button onclick="saveToken()">Save token</button>
          <p id="token-error" class="error"></p>
        </div>

        <div class="card">
          <h2>Users</h2>
          <table id="users-table"><tbody></tbody></table>
          <label>New user name <input id="new-user-name" placeholder="alice"></label>
          <button onclick="addUser()">Add user</button>
          <p id="users-error" class="error"></p>
          <div id="new-key" style="display:none">
            <p><strong>Copy this key now &mdash; it cannot be shown again:</strong></p>
            <code class="key" id="new-key-value"></code>
            <p class="hint" style="margin-top:8px">See <a href="#" onclick="navigate('docs','getting-started');return false;">Getting started</a> for how to use it.</p>
          </div>
        </div>
      </section>

    </div>
  </div>

  <div class="page" id="page-docs">
    <div class="docs-shell" id="docsBody">
      <div class="docs-loading">Select a doc from the sidebar.</div>
    </div>
  </div>
</div>

<script>
function show(id) {
  for (const el of document.querySelectorAll('section')) el.classList.remove('active');
  document.getElementById(id).classList.add('active');
}

function navigate(page, slug) {
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
  const target = slug
    ? document.querySelector('.nav-item[data-slug="' + slug + '"]')
    : document.querySelector('.nav-item[data-page="' + page + '"]');
  if (target) target.classList.add('active');

  document.querySelectorAll('.page').forEach((el) => el.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');

  if (page === 'docs' && slug) loadDoc(slug);
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
  await Promise.all([loadConfig(), loadUsers(), loadQuota()]);
  startQuotaPolling();
}

const TIER_PURPOSE = {
  1: 'File structure, node trees, image export',
  2: 'Comments',
  3: 'Styles and components',
};

let quotaTimer = null;

function startQuotaPolling() {
  if (quotaTimer) return;
  // The status is computed in-process and never calls Figma, so a slow poll is free.
  quotaTimer = setInterval(() => { loadQuota().catch(() => {}); }, 15000);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit];
}

function formatWait(seconds) {
  if (seconds < 120) return seconds + 's';
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return minutes + ' minutes';
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + ' hours' : Math.round(hours / 24) + ' days';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tierCard(tier) {
  const card = el('div', 'tier' + (tier.blockedUntil ? ' blocked' : ''));

  const name = el('div', 'tier-name');
  const dot = el('span', 'status-dot');
  if (tier.blockedUntil) dot.style.background = 'var(--danger)';
  name.append(dot, el('span', null, 'Tier ' + tier.tier));
  card.append(name, el('div', 'tier-what', TIER_PURPOSE[tier.tier] || ''));

  const ratio = tier.burst ? Math.max(0, Math.min(1, tier.availableSlots / tier.burst)) : 0;
  const meter = el('div', 'meter' + (ratio < 0.25 ? ' low' : ''));
  const fill = el('i');
  fill.style.width = Math.round(ratio * 100) + '%';
  meter.appendChild(fill);
  card.appendChild(meter);

  const rows = [
    ['Free slots now', tier.availableSlots + ' / ' + tier.burst],
    ['Requests, last hour', String(tier.requestsLastHour)],
    ['Downloaded, last hour', formatBytes(tier.bytesLastHour)],
  ];
  // Size is the cost dimension request counts cannot show, so only mention it when it bit.
  if (tier.costUnitsLastHour > 0) rows.push(['Extra cost from size', '+' + tier.costUnitsLastHour + ' slots']);
  if (tier.rateLimitedLast24h > 0) rows.push(['429s, last 24h', String(tier.rateLimitedLast24h)]);

  for (const [label, value] of rows) {
    const row = el('div', 'tier-row');
    row.append(el('span', null, label), el('span', null, value));
    card.appendChild(row);
  }
  return card;
}

async function loadQuota() {
  const error = document.getElementById('quota-error');
  try {
    const status = await api('/api/admin/quota');
    error.textContent = '';

    const tiers = document.getElementById('quota-tiers');
    tiers.innerHTML = '';
    for (const tier of status.tiers) tiers.appendChild(tierCard(tier));

    const alert = document.getElementById('quota-alert');
    alert.innerHTML = '';
    for (const tier of status.tiers.filter((t) => t.blockedUntil)) {
      const banner = el('div', 'banner');
      banner.appendChild(el('b', null, 'Tier ' + tier.tier + ' is blocked by Figma'));
      banner.appendChild(el('div', null,
        'Refusing requests for about ' + formatWait(tier.retryAfterSeconds) +
        ', until ' + new Date(tier.blockedUntil).toLocaleString() + '.'));
      banner.appendChild(el('div', 'hint',
        'Retrying sooner does not help — it can extend the penalty. Cached reads still work.'));
      const last = tier.lastRateLimited;
      if (last && last.upgradeLink) {
        const link = document.createElement('a');
        link.href = last.upgradeLink;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Figma plan limits';
        const line = el('div', 'hint');
        line.append('Reported plan: ' + (last.planTier || 'unknown') + ' · ', link);
        banner.appendChild(line);
      }
      alert.appendChild(banner);
    }

    const cache = status.cache || {};
    const total = (cache.hits || 0) + (cache.misses || 0);
    const rate = total ? Math.round(((cache.hits || 0) / total) * 100) : 0;
    document.getElementById('quota-cache').textContent =
      'Cache: ' + (cache.hits || 0) + ' hits, ' + (cache.misses || 0) + ' misses (' + rate + '% served without Figma)' +
      ', ' + (cache.inFlightJoins || 0) + ' requests shared between callers.' +
      (status.fileRestrictions ? '' : ' File allow-list: off — every file the token can open is reachable.');
    document.getElementById('quota-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    error.textContent = err.message;
  }
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
    revoke.className = 'secondary';
    revoke.style.marginTop = '0';
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

// ===== Docs =====
let docsCache = {};

async function loadDocsNav() {
  try {
    const res = await fetch('/api/docs');
    const docs = await res.json();
    const nav = document.getElementById('docsNav');
    nav.innerHTML = docs.map((d) =>
      '<a class="nav-item" data-page="docs" data-slug="' + d.slug + '" onclick="navigate(\\'docs\\',\\'' + d.slug + '\\')">' +
      '<span class="nav-icon">' + d.icon + '</span> ' + d.title + '</a>'
    ).join('');
  } catch {
    // Docs are cosmetic; a fetch failure shouldn't block the rest of the UI.
  }
}

async function loadDoc(slug) {
  const body = document.getElementById('docsBody');
  if (docsCache[slug]) { body.innerHTML = docsCache[slug]; return; }
  body.innerHTML = '<div class="docs-loading">Loading...</div>';
  try {
    const res = await fetch('/api/docs/' + slug);
    if (!res.ok) throw new Error('Not found');
    const md = (await res.text()).split('{{ORIGIN}}').join(window.location.origin);
    const html = renderMarkdown(md);
    docsCache[slug] = html;
    body.innerHTML = html;
  } catch {
    body.innerHTML = '<div class="docs-loading">Failed to load documentation.</div>';
  }
}

// Small, dependency-free Markdown -> HTML renderer covering exactly what the doc content uses:
// headings, paragraphs, fenced code, tables, lists and basic inline formatting.
function renderMarkdown(md) {
  let html = '';
  const lines = md.split('\\n');
  let i = 0;
  let inCode = false, code = '';
  let inTable = false, tableRows = [];
  let inList = false, listItems = [], listOrdered = false;

  function flushList() {
    if (!inList) return;
    const tag = listOrdered ? 'ol' : 'ul';
    html += '<' + tag + '>' + listItems.map((l) => '<li>' + inlineFormat(l) + '</li>').join('') + '</' + tag + '>';
    listItems = []; inList = false;
  }
  function flushTable() {
    if (!inTable) return;
    let t = '<table>';
    tableRows.forEach((row, idx) => {
      if (row.includes('---')) return;
      const cells = row.split('|').map((c) => c.trim()).filter((c) => c !== '');
      const tag = idx === 0 ? 'th' : 'td';
      t += '<tr>' + cells.map((c) => '<' + tag + '>' + inlineFormat(c) + '</' + tag + '>').join('') + '</tr>';
    });
    html += t + '</table>';
    tableRows = []; inTable = false;
  }
  function inlineFormat(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('\`\`\`')) {
      if (inCode) {
        html += '<pre><code>' + code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code></pre>';
        code = ''; inCode = false;
      } else { flushList(); flushTable(); inCode = true; }
      i++; continue;
    }
    if (inCode) { code += (code ? '\\n' : '') + line; i++; continue; }

    if (line.trim().startsWith('|')) { flushList(); inTable = true; tableRows.push(line); i++; continue; }
    flushTable();

    const ul = line.match(/^-\\s(.+)/);
    const ol = line.match(/^\\d+\\.\\s(.+)/);
    if (ul || ol) {
      const isOl = !!ol;
      if (inList && listOrdered !== isOl) flushList();
      inList = true; listOrdered = isOl;
      listItems.push(ul ? ul[1] : ol[1]);
      i++; continue;
    }
    flushList();

    if (!line.trim()) { i++; continue; }
    if (line.startsWith('### ')) { html += '<h3>' + inlineFormat(line.slice(4)) + '</h3>'; i++; continue; }
    if (line.startsWith('## ')) { html += '<h2>' + inlineFormat(line.slice(3)) + '</h2>'; i++; continue; }
    if (line.startsWith('# ')) { html += '<h1>' + inlineFormat(line.slice(2)) + '</h1>'; i++; continue; }

    html += '<p>' + inlineFormat(line) + '</p>';
    i++;
  }
  flushList(); flushTable();
  return html;
}

refresh();
loadDocsNav();
</script>
</body>
</html>
`;
