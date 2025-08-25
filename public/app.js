const intervalSeconds = (Number(new URLSearchParams(location.search).get('interval')) || 15);
const intervalEl = document.getElementById('interval');
intervalEl.textContent = String(intervalSeconds);

const board = document.getElementById('board');
const meta = document.getElementById('meta');
const refreshBtn = document.getElementById('refreshBtn');
const quotaEl = document.getElementById('quota');

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

function fmtMs(ms) {
  if (!ms) return '0s';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

async function fetchStatus() {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('Failed to fetch status');
  return res.json();
}

function render({ members, workingUserIds, workingByUserId, lastUpdated, manual }) {
  meta.textContent = `Last updated ${msToAgo(lastUpdated)} • Users: ${members.length}`;
  if (manual) {
    quotaEl.textContent = `Manual refresh left: ${manual.remaining}/${manual.maxPerHour} • reset in ${fmtMs(manual.resetInMs)}`;
    refreshBtn.disabled = manual.remaining <= 0;
  }

  const working = new Set(workingUserIds);
  board.innerHTML = '';

  const sorted = [...members].sort((a, b) => {
    const aw = working.has(a.id) ? 0 : 1;
    const bw = working.has(b.id) ? 0 : 1;
    return aw - bw || a.name.localeCompare(b.name);
  });
