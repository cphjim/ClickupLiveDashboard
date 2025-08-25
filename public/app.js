const intervalSeconds = (Number(new URLSearchParams(location.search).get('interval')) || 15);
const intervalEl = document.getElementById('interval');
intervalEl.textContent = String(intervalSeconds);

const board = document.getElementById('board');
const meta = document.getElementById('meta');

function initials(name = '') {
  const parts = name.split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] || '?') + (parts[1]?.[0] || '');
}

function msToAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

async function fetchStatus() {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('Failed to fetch status');
  return res.json();
}

function render({ members, workingUserIds, workingByUserId, lastUpdated }) {
  meta.textContent = `Last updated ${msToAgo(lastUpdated)} • Users: ${members.length}`;

  const working = new Set(workingUserIds);
  board.innerHTML = '';

  const sorted = [...members].sort((a, b) => {
    const aw = working.has(a.id) ? 0 : 1;
    const bw = working.has(b.id) ? 0 : 1;
    return aw - bw || a.name.localeCompare(b.name);
  });

  for (const m of sorted) {
    const isWorking = working.has(m.id);
    const info = workingByUserId[m.id];

    const card = document.createElement('div');
    card.className = 'card';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = m.avatar ? '' : initials(m.name);
    if (m.avatar) {
      const img = document.createElement('img');
      img.src = m.avatar; img.alt = m.name; img.width = 40; img.height = 40; img.style.borderRadius = '50%';
      avatar.appendChild(img);
    }

    const body = document.createElement('div');

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.name;

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
      task.textContent = `• ${info.taskName}`;

      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = `Started ${msToAgo(Number(info.start))}`;

      body.appendChild(task);
      body.appendChild(time);
    }

    card.appendChild(avatar);
    card.appendChild(body);
    board.appendChild(card);
  }
}

async function tick() {
  try {
    const data = await fetchStatus();
    render(data);
  } catch (e) {
    meta.textContent = `Error: ${e.message}`;
  }
}

await tick();
setInterval(tick, intervalSeconds * 1000);
