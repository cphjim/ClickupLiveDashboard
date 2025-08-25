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
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);

const CU = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: TOKEN }
});

// Cache voor snelheid + rate-limits
let cache = {
  lastUpdated: 0,
  members: [],
  workingUserIds: new Set(),
  workingByUserId: {}
};

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
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const url = `/team/${TEAM_ID}/time_entries?start_date=${dayAgo}&end_date=${now}`;
  const { data } = await CU.get(url);
  const entries = data?.data || data?.time_entries || [];
  const running = entries.filter(e => e?.duration == null);

  return running.map(e => ({
    userId: String(e?.user?.id ?? e?.user_id ?? ''),
    taskId: e?.task?.id || e?.task_id || null,
    taskName: e?.task?.name || e?.description || 'Working…',
    start: e?.start || e?.start_time || null
  }));
}

async function refreshCache() {
  if (!TOKEN || !TEAM_ID) {
    cache.members = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
      { id: '3', name: 'Charlie' }
    ];
    cache.workingUserIds = new Set(['2']);
    cache.workingByUserId = {
      '2': { taskId: 'TASK-123', taskName: 'Design homepage', start: Date.now() - 600000 }
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

await refreshCache().catch(() => {});
setInterval(() => {
  refreshCache().catch(err => console.error('refresh error', err?.message));
}, POLL_INTERVAL_MS);

// API endpoint voor frontend
app.get('/api/status', (_req, res) => {
  res.json({
    lastUpdated: cache.lastUpdated,
    members: cache.members,
    workingUserIds: [...cache.workingUserIds],
    workingByUserId: cache.workingByUserId
  });
});

// Catch-all voor frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚡ Dashboard running on http://localhost:${PORT}`);
  if (!TOKEN || !TEAM_ID) {
    console.log('ℹ️  Running in MOCK mode (geen CLICKUP_TOKEN/TEAM_ID gevonden)');
  }
});
