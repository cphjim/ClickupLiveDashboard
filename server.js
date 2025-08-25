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

const TOKEN = process.env.CLICKUP_TOKEN || '';
const TEAM_ID = process.env.CLICKUP_TEAM_ID || '';
const PORT = process.env.PORT || 5173;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const MANUAL_REFRESH_MAX_PER_HOUR = parseInt(process.env.MANUAL_REFRESH_MAX_PER_HOUR || '20', 10);

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

// Handmatige refresh-rate limiting
let manualCalls = []; // timestamps (ms)
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

async function fetchMembers() {
  const { data } = await CU.get(`/team/${TEAM_ID}`);
  const team = data?.teams?.[0];
  return (team?.members || []).map(m => ({
    id: String(m.user?.id ?? m.id),
    name: m.user?.username || m.user?.email || m.user?.id || 'Unknown',
    email: m.user?.email || null,
    avatar: m.user?.profilePicture || null
  }));
}

async function fetchRunningTimers() {
  const now = Date.now();
  const windowStart = now - 24 * 60 * 60 * 1000; // laatste 24u
  const url = `/team/${TEAM_ID}/time_entries?start_date=${windowStart}&end_date=${now}`;
  const { data } = await CU.get(url);
  const entries = data?.data || data?.time_entries || [];
  const running = entries.filter(e => e?.duration == null);

  return running.map(e => ({
    userId: String(e?.user?.id ?? e?.user_id ?? ''),
    taskId: e?.task?.id || e?.task_id || null,
    taskName: e?.task?.name || e?.description || 'Working…',
    start: Number(e?.start ?? e?.start_time ?? Date.now())
  }));
}

async function refreshCache() {
  // MOCK mode als geen env is gezet (handig voor snelle demo)
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

  const [members, running] = await Promise.all([
    fetchMembers(),
    fetchRunningTimers()
  ]);

  const workingUserIds = new Set(running.map(r => r.userId));
  const workingByUserId = {};
  for (const r of running) workingByUserId[r.userId] = r;

  cache = { lastUpdated: Date.now(), members, workingUserIds, workingByUserId };
}

// Backoff-vriendelijke scheduler i.p.v. vaste setInterval
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

// API endpoints
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

// Frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚡ ClickUp Live Dashboard on http://localhost:${PORT}`);
  if (!TOKEN || !TEAM_ID) console.log('ℹ️ Running in MOCK mode (no CLICKUP_TOKEN/TEAM_ID).');
});
