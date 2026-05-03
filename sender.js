/**
 * Cloud sender for ShelfRx Agent.
 *
 * Periodically sends buffered PN13 events to the ShelfRx cloud API.
 * Uses exponential backoff when the cloud is unreachable.
 *
 * Endpoint: POST {CLOUD_URL}/api/agent/events
 * Auth: X-Pharmacy-Key: {PHARMACY_KEY}
 * Payload: { events: [...], agent_version: "1.0.0" }
 *
 * The sender runs on a 5-second tick. On failure it backs off up to 5 minutes.
 * Events remain in the local SQLite buffer until the cloud confirms receipt.
 */

const fetch = require('node-fetch');
const store = require('./store');
const config = require('./config');

const BATCH_SIZE = 50;
const TICK_MS = 5_000;          // Normal tick: 5 seconds
const BACKOFF_MAX_MS = 300_000; // Max backoff: 5 minutes

let senderTimer = null;
let consecutiveFails = 0;

/**
 * Start the background sender loop.
 */
function startSender() {
  console.log('[sender] Cloud sender started (tick: 5s, batch: 50 events)');
  scheduleTick(TICK_MS);

  // Weekly cleanup of old sent events
  setInterval(() => store.pruneOldEvents(30), 7 * 24 * 60 * 60 * 1000);
}

function scheduleTick(delay) {
  if (senderTimer) clearTimeout(senderTimer);
  senderTimer = setTimeout(tick, delay);
}

async function tick() {
  try {
    await sendBatch();
    consecutiveFails = 0;
    scheduleTick(TICK_MS);
  } catch (err) {
    consecutiveFails++;
    const backoff = Math.min(TICK_MS * Math.pow(2, consecutiveFails - 1), BACKOFF_MAX_MS);
    console.warn(`[sender] Send failed (attempt #${consecutiveFails}), retry in ${Math.round(backoff / 1000)}s: ${err.message}`);
    scheduleTick(backoff);
  }
}

/**
 * Send one batch of pending events to the cloud.
 * Returns the number of events successfully sent.
 */
async function sendBatch() {
  const pending = store.getPendingEvents(BATCH_SIZE);
  if (pending.length === 0) return 0;

  const cfg = config.load();
  if (!cfg.pharmacy_key || !cfg.cloud_url) {
    throw new Error('Agent not configured (missing pharmacy_key or cloud_url)');
  }

  const ids = pending.map(p => p.id);
  const events = pending.map(p => p.event);

  const payload = {
    events,
    agent_version: require('./package.json').version
  };

  const url = `${cfg.cloud_url.replace(/\/$/, '')}/api/agent/events`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pharmacy-Key': cfg.pharmacy_key
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${body.substring(0, 200)}`);
  }

  const result = await response.json();
  store.markSent(ids);
  console.log(`[sender] ✓ Sent ${events.length} event(s) to cloud (accepted: ${result.accepted || events.length})`);
  return events.length;
}

/**
 * Force an immediate send attempt (used at startup and after each PN13 message).
 */
async function flushNow() {
  try {
    const sent = await sendBatch();
    if (sent > 0) {
      consecutiveFails = 0;
      scheduleTick(TICK_MS);
    }
  } catch (err) {
    // Non-fatal — background loop will retry
    console.warn('[sender] Flush failed:', err.message);
  }
}

module.exports = { startSender, flushNow };
