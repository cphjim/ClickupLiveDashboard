import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ENV
const TOKEN = process.env.CLICKUP_TOKEN || '';
const TEAM_ID = process.env.CLICKUP_TEAM_ID || '';
const PORT = process.env.PORT || 5173;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const MANUAL_REFRESH_MAX_PER_HOUR = parseInt(process.env.MANUAL_REFRESH_MAX_PER_HOUR || '20', 10);

// ClickUp client
const CU = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: TOKEN }
});

// Cache
let cache = {
  lastUpdated: 0,
  members: [],
  workingUserIds: new Set(),
  workingByUserId: {}
};

// Manual refresh rate-limit
let manualCalls = [];
function pruneManualCalls() {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  manualCalls = manualCalls.filter(t => t >= hourAgo);
}
function manualRemaining() {
  pruneManualCalls();
  return Math.max(0, MANUAL_REFRESH_MAX_PER_HOUR - manualCalls.length);
}
function manualResetInMs() {
  pruneManualCalls();
  if (manualCalls.length === 0) return 0;
  const oldest = manualCalls[0];
  return Math.max(0, (oldest + 60 * 60 * 1000) - Date.now());
}

// ---- FETCHERS ----

// Haal team/workspace members op.
// Ondersteunt beide vormen:
//  A) GET /team/{id} -> { id, members: [...] }
//  B) GET /team -> { teams: [ { members: [...] } ] }
async function fetchMembers() {
  const { data } = await CU.get(`/team/${TEAM_ID}`);
  const membersArray =
    (Array.isArray(data?.members) && data.members) ||
    (Array.isArray(data?.teams) && data.teams[0]?.members) ||
    [];

  return membersArray.map(m => {
    const u = m.user || m;
    return {
      id: String(u?.id),
      name: u?.username || u?.email || String(u?.id || 'Unknown'),
      email: u?.email || null,
      avatar: u?.profilePicture || null
    };
  });
}

// Check één gebruiker: heeft die een lopende timer (duration < 0)?
async function fetchActiveForUser(userId) {
  const now = Date.now();
  const windowStart = now - 48 * 60 * 60 * 1000; // laatste 48u (ruim zat)
  const url = `/team/${TEAM_ID}/time_entries?assignee=${userId}&start_date=${windowStart}&end_date=${now}`;
  const { data } = await CU.get(url);
  const entries = data?.data || data?.time_entries || [];

  // Actief = entry met negatieve duration
  const active = entries.find(e => typeof e?.duration === 'number' && e.duration < 0);
  if (!active) return null;

  // Probeer taaknaam te pakken; val anders terug op omschrijving
  const taskName =
    active?.task?.name ||
    active?.task_name ||
    active?.description ||
    'Working…';

  // Starttijd uit entry; als ontbreekt, gebruik nu
  const start =
    Number(active?.start ?? active?.start_time ?? Date.now());

  const taskId = active?.task?.id || active?.task_id || null;

  return { userId: String(userId), taskId, taskName, start };
}

// Haal voor ALLE members de status op (parallel, maar vriendelijk).
async function fetchRunningTimersForAll(members) {
  // kleine concurrency-limit (5 tegelijk) zodat we niet spammen
  const results = [];
  const limit = 5;
  let i = 0;

  async function worker() {
    while (i < members.length) {
      const idx = i++;
      const userId = members[idx].id;
      try {
        const active = await fetchActiveForUser(userId);
        if (active) results.push(active);
      } catch (err) {
        // stil falen per user; log op server
        console.error('time_entries error for', userId, err?.response?.status || err?.message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, members.length) }, () => worker());
  await Promise.all(workers);

  return results; // array met actieve users
}

// Refresh cache (één “tick”)
async function refreshCache() {
  // MOCK mode zonder env
  if (!TOKEN || !TEAM_ID) {
    cache.members = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
      { id: '3', name: 'Charlie' }
    ];
    cache.workingUserIds = new Set(['2']);
    cache.workingByUserId = {
      '2': { taskId: 'TASK-123', taskName: 'Design homepage', start: Date.now() - 10 * 60 * 1000 }
    };
    cache.lastUpdated = Date.now();
    return;
  }

  const members = await fetchMembers();
  const running = await fetchRunningTimersForAll(members);

  const workingUserIds = new Set(running.map(r => r.userId));
  const workingByUserId = {};
  for (const r of running) workingByUserId[r.userId] = r;

  cache = { lastUpdated: Date.now(), members, workingUserIds, workingByUserId };
}

// Backoff scheduler
let pollDelay = POLL_INTERVAL_MS;
async function scheduledRefresh() {
  try {
    await refreshCache();
    pollDelay = POLL_INTERVAL_MS;
  } catch (err) {
    const retryAfter =
      Number(err?.response?.headers?.['retry-after']) * 1000 || 2 * pollDelay;
    pollDelay = Math.min(Math.max(retryAfter, POLL_INTERVAL_MS), 5 * 60_000);
    console.error('refresh error', err?.response?.status || err?.message, 'next in', pollDelay, 'ms');
  } finally {
    setTimeout(scheduledRefresh, pollDelay);
  }
}

await refreshCache().catch(() => {});
scheduledRefresh();

// API
app.get('/api/status', (_req, res) => {
  res.json({
    lastUpdated: cache.lastUpdated,
    members: cache.members,
    workingUserIds: [...cache.workingUserIds],
    workingByUserId: cache.workingByUserId,
    manual: {
      remaining: manualRemaining(),
      resetInMs: manualResetInMs(),
      maxPerHour: MANUAL_REFRESH_MAX_PER_HOUR
    }
  });
});

app.post('/api/refresh', async (_req, res) => {
  if (manualRemaining() <= 0) {
    return res.status(429).json({
      error: 'rate_limited',
      remaining: 0,
      resetInMs: manualResetInMs(),
      maxPerHour: MANUAL_REFRESH_MAX_PER_HOUR
    });
  }
  try {
    await refreshCache();
    manualCalls.push(Date.now());
    res.json({
      ok: true,
      lastUpdated: cache.lastUpdated,
      manual: {
        remaining: manualRemaining(),
        resetInMs: manualResetInMs(),
        maxPerHour: MANUAL_REFRESH_MAX_PER_HOUR
      }
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'refresh_failed' });
  }
});

// Frontend fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`⚡ ClickUp Live Dashboard on http://localhost:${PORT}`);
  if (!TOKEN || !TEAM_ID) console.log('ℹ️ Running in MOCK mode (no CLICKUP_TOKEN/TEAM_ID).');
});
