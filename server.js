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

// ── ENV ────────────────────────────────────────────────────────────────────────
const TOKEN = process.env.CLICKUP_TOKEN || '';
const TEAM_ID = process.env.CLICKUP_TEAM_ID || '';
const PORT = process.env.PORT || 5173;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const MANUAL_REFRESH_MAX_PER_HOUR = parseInt(process.env.MANUAL_REFRESH_MAX_PER_HOUR || '20', 10);

// ── ClickUp client ────────────────────────────────────────────────────────────
const CU = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: TOKEN }
});

// ── Cache ─────────────────────────────────────────────────────────────────────
let cache = {
  lastUpdated: 0,
  members: [],
  workingUserIds: new Set(),
  workingByUserId: {} // { userId: { userId, taskId, taskName, start } }
};

// ── Wie ben ik? (user id van het token) ───────────────────────────────────────
let MY_USER_ID = null;
async function fetchMe() {
  try {
    const { data } = await CU.get('/user');
    MY_USER_ID = String(data?.user?.id ?? data?.id ?? '');
  } catch (e) {
    console.error('Failed to fetch /user', e?.response?.status || e?.message);
  }
}

// ── Handmatige refresh limiter ────────────────────────────────────────────────
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

// ── Members ophalen (ondersteun alle bekende vormen) ──────────────────────────
async function fetchMembers() {
  const { data } = await CU.get(`/team/${TEAM_ID}`);
  const membersArray =
    (Array.isArray(data?.team?.members) && data.team.members) ||
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

// ── Actief? ───────────────────────────────────────────────────────────────────
function isActiveEntry(e) {
  const dur = e?.duration;
  const endA = e?.end;
  const endB = e?.end_time;
  return dur == null || (typeof dur === 'number' && dur < 0) || endA == null || endB == null;
}
const entryStart = e => Number(e?.start ?? e?.start_time ?? 0);

// Extra details voor juiste start + task
async function fetchEntryDetails(timerId) {
  if (!timerId) return null;
  try {
    const { data } = await CU.get(`/team/${TEAM_ID}/time_entries/${timerId}?include_task=true`);
    return data;
  } catch (e) {
    console.warn('fetchEntryDetails failed', timerId, e?.response?.status || e?.message);
    return null;
  }
}

// Check één gebruiker
async function fetchActiveForUser(userId) {
  const now = Date.now();
  const windowStart = now - 7 * 24 * 60 * 60 * 1000; // 7 dagen, ruime marge

  // a) algemene lijst (werkt voor alle users)
  const listUrl =
    `/team/${TEAM_ID}/time_entries?assignee=${userId}&start_date=${windowStart}&end_date=${now}&include_task=true`;
  const listResp = await CU.get(listUrl);
  const entries = listResp?.data?.data || listResp?.data?.time_entries || [];

  // Kies de meest recente actieve entry
  const actives = entries.filter(isActiveEntry);
  let active = actives.sort((a, b) => entryStart(a) - entryStart(b)).pop() || null;

  // b) fallback: voor MIJN user ook /current proberen; daarna details ophalen
  if (!active && MY_USER_ID && String(userId) === String(MY_USER_ID)) {
    try {
      const cur = (await CU.get(`/team/${TEAM_ID}/time_entries/current`))?.data;
      const curEntry = Array.isArray(cur) ? cur.find(isActiveEntry) : cur;
      if (curEntry && isActiveEntry(curEntry)) {
        const detailed = await fetchEntryDetails(curEntry?.id || curEntry?.timer_id);
        active = detailed || curEntry;
      }
    } catch (e) {
      console.warn('current endpoint failed', e?.response?.status || e?.message);
    }
  }

  if (!active) return null;

  const taskName =
    active?.task?.name ||
    active?.task_name ||
    active?.description ||
    'Working…';

  const taskId = active?.task?.id || active?.task_id || null;

  // Geen “nu” fallback (anders zie je 0s-reset). Liever leeg; vullen we zo met oude cache indien aanwezig.
  let start = entryStart(active) || null;

  return { userId: String(userId), taskId, taskName, start };
}

// Voor alle leden (beperkte paralleliteit)
async function fetchRunningTimersForAll(members) {
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
        console.error('time_entries error for', userId, err?.response?.status || err?.message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, members.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Refresh cache ─────────────────────────────────────────────────────────────
async function refreshCache() {
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

  if (!MY_USER_ID) await fetchMe();

  const members = await fetchMembers();
  const running = await fetchRunningTimersForAll(members);

  const workingUserIds = new Set(running.map(r => r.userId));

  // Merge met vorige starts: als nieuwe start ontbreekt, behoud de oude
  const workingByUserId = { ...cache.workingByUserId };
  for (const r of running) {
    const prev = workingByUserId[r.userId];
    if (!r.start && prev?.start) r.start = prev.start;
    workingByUserId[r.userId] = r;
  }

  cache = { lastUpdated: Date.now(), members, workingUserIds, workingByUserId };
}

// ── Scheduler met backoff ─────────────────────────────────────────────────────
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

// ── API ───────────────────────────────────────────────────────────────────────
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

// Debug (optioneel): ruwe data voor user
app.get('/api/debug-user', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId query param required' });
  try {
    const now = Date.now();
    const windowStart = now - 7 * 24 * 60 * 60 * 1000;
    const url = `/team/${TEAM_ID}/time_entries?assignee=${userId}&start_date=${windowStart}&end_date=${now}&include_task=true`;
    const r = await CU.get(url);
    let cur = null;
    try {
      const rc = await CU.get(`/team/${TEAM_ID}/time_entries/current`);
      cur = rc.data;
    } catch (e) {
      cur = { error: e?.response?.status || e?.message };
    }
    res.json({ listStatus: r.status, list: r.data, me: MY_USER_ID, current: cur });
  } catch (err) {
    res.status(err?.response?.status || 500).json({
      error: err?.message,
      data: err?.response?.data
    });
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
