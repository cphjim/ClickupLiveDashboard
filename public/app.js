const intervalSeconds = (Number(new URLSearchParams(location.search).get('interval')) || 15);
const intervalEl = document.getElementById('interval');
if (intervalEl) intervalEl.textContent = String(intervalSeconds);

const meta = document.getElementById('meta');
const refreshBtn = document.getElementById('refreshBtn');
const quotaEl = document.getElementById('quota');

const boardWorking = document.getElementById('board-working');
const boardIdle = document.getElementById('board-idle');
const countWorking = document.getElementById('count-working');
const countIdle = document.getElementById('count-idle');

function initials(name = '') {
  const parts = name.split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || '?') + (parts[1]?.[0] || '');
}
function msToAgo(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
function fmtMs(ms) {
  if (!ms) return '0s';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

async function fetchStatus() {
  const res = await fetch('/api/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch status (${res.status})`);
  return res.json();
}

function makeCard(member, isWorking, info) {
  const card = document.createElement('div');
  card.className = 'card';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = member.avatar ? '' : initials(member.name || '');
  if (member.avatar) {
    const img = document.createElement('img');
    img.src = member.avatar;
    img.alt = member.name || '';
    img.width = 40;
    img.height = 40;
    img.style.borderRadius = '50%';
    avatar.appendChild(img);
  }

  const body = document.createElement('div');

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = member.name || '(unknown)';

  const st = document.createElement('div');
  st.className = 'status';
  const badge = document.createElement('span');
  badge.className = `badge ${isWorking ? 'working' : 'idle'}`;
  badge.textContent = isWorking ? 'Working' : 'Not working';
  st.appendChild(badge);

  body.appendChild(name);
  body.appendChild(st);

  if (isWorking && info) {
    const task = document.createElement('div');
    task.className = 'task';

    if (info.taskId) {
      const a = document.createElement('a');
      a.href = `https://app.clickup.com/t/${info.taskId}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = info.taskName || 'Working…';
      task.appendChild(document.createTextNode('• '));
      task.appendChild(a);
    } else {
      task.textContent = `• ${info.taskName || 'Working…'}`;
    }

    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = info.start ? `Started ${msToAgo(Number(info.start))}` : 'Started …';

    body.appendChild(task);
    body.appendChild(time);
  }

  card.appendChild(avatar);
  card.appendChild(body);
  return card;
}

function render({ members = [], workingUserIds = [], workingByUserId = {}, lastUpdated = Date.now(), manual }) {
  if (meta) {
    meta.textContent = `Last updated ${msToAgo(lastUpdated)} • Users: ${members.length}`;
  }
  if (quotaEl && manual) {
    quotaEl.textContent = `Manual refresh left: ${manual.remaining}/${manual.maxPerHour} • reset in ${fmtMs(manual.resetInMs)}`;
    if (refreshBtn) refreshBtn.disabled = manual.remaining <= 0;
  }

  const workingSet = new Set(workingUserIds);

  // Clear containers
  boardWorking.innerHTML = '';
  boardIdle.innerHTML = '';

  // Split members into groups
  const working = [];
  const idle = [];

  for (const m of members) {
    if (workingSet.has(m.id)) working.push(m);
    else idle.push(m);
  }

  // sort by name within each group
  working.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  idle.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // counts
  countWorking.textContent = working.length ? `(${working.length})` : '(0)';
  countIdle.textContent = idle.length ? `(${idle.length})` : '(0)';

  // render
  for (const m of working) {
    const info = workingByUserId[m.id];
    boardWorking.appendChild(makeCard(m, true, info));
  }
  for (const m of idle) {
    boardIdle.appendChild(makeCard(m, false, null));
  }
}

async function tick() {
  try {
    const data = await fetchStatus();
    render(data);
  } catch (e) {
    if (meta) meta.textContent = `Error: ${e.message}`;
    console.error(e);
  }
}

async function manualRefresh() {
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (res.status === 429) {
      const data = await res.json();
      if (quotaEl) quotaEl.textContent = `Rate limited. Try again in ${fmtMs(data.resetInMs)} (${data.remaining}/${data.maxPerHour} left)`;
      return;
    }
    if (!res.ok) throw new Error('Refresh failed');
    await tick();
  } catch (e) {
    if (quotaEl) quotaEl.textContent = `Refresh error: ${e.message}`;
    console.error(e);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

if (refreshBtn) refreshBtn.addEventListener('click', manualRefresh);

// Start
(function init() {
  tick();
  setInterval(tick, intervalSeconds * 1000);
})();
