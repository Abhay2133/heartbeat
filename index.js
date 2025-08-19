const express = require('express');
const cron = require('node-cron');
const { handlePing } = require('./handler');
const app = express();

const PORT = process.env.PORT || 3000;

// Basic health endpoint
app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Heartbeat server running on http://localhost:${PORT}`);
});

// --- Heartbeat scheduler ---
// Configure the URL to ping via env, default to the root of this server
const HEARTBEAT_URL = process.env.HEARTBEAT_URL || `http://localhost:${PORT}/health`;

// Ensure fetch exists (Node 18+ has global fetch; otherwise, advise to install node-fetch)
const hasFetch = typeof fetch === 'function';
if (!hasFetch) {
  console.warn('[heartbeat] Global fetch not found. Using node 18+ is recommended.');
}

// Run immediately on startup, then every minute
async function pingOnce() {
  const startedAt = Date.now();
  try {
    const res = await fetch(HEARTBEAT_URL);
    const endedAt = Date.now();
    await handlePing({ url: HEARTBEAT_URL, startedAt, endedAt }, res, null);
  } catch (err) {
    const endedAt = Date.now();
    await handlePing({ url: HEARTBEAT_URL, startedAt, endedAt }, null, err);
  }
}

// Immediately ping after server starts
pingOnce();

// Schedule: every 1 minute
cron.schedule('* * * * *', () => {
  pingOnce();
});
