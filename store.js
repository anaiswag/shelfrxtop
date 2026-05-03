/**
 * Local SQLite buffer store for ShelfRx Agent.
 *
 * Persists PN13 stock events locally so no data is lost if the cloud is unreachable.
 * The sender reads pending events from this store and marks them sent on success.
 *
 * Schema:
 *   events(id, status, event_json, created_at, sent_at, error)
 *     status: 'pending' | 'sent' | 'error'
 *
 * The store also keeps a small metadata table for housekeeping counters.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(
  process.env.APPDATA || process.env.HOME || '.',
  'ShelfRx',
  'agent.db'
);

let db = null;

function getDb() {
  if (db) return db;

  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);

  // WAL mode for better concurrent read/write performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'pending',
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  console.log(`[store] SQLite database at: ${DB_PATH}`);
  return db;
}

/**
 * Insert one or more events into the local buffer.
 * @param {Array|Object} events
 */
function insertEvents(events) {
  const db = getDb();
  const arr = Array.isArray(events) ? events : [events];
  const insert = db.prepare(
    `INSERT INTO events (status, event_json, created_at) VALUES ('pending', ?, datetime('now'))`
  );
  const insertMany = db.transaction((rows) => {
    for (const ev of rows) {
      insert.run(JSON.stringify(ev));
    }
  });
  insertMany(arr);
  console.log(`[store] Buffered ${arr.length} event(s). Pending: ${countPending()}`);
}

/**
 * Fetch up to `limit` pending events for cloud upload.
 * Returns array of { id, event }.
 */
function getPendingEvents(limit = 100) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, event_json FROM events WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
  ).all(limit);
  return rows.map(r => ({ id: r.id, event: JSON.parse(r.event_json) }));
}

/**
 * Mark a list of event IDs as successfully sent.
 * @param {number[]} ids
 */
function markSent(ids) {
  if (!ids || ids.length === 0) return;
  const db = getDb();
  const update = db.prepare(
    `UPDATE events SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
  );
  const updateMany = db.transaction((arr) => {
    for (const id of arr) update.run(id);
  });
  updateMany(ids);
}

/**
 * Mark a list of event IDs as failed with an error message.
 * @param {number[]} ids
 * @param {string} error
 */
function markError(ids, error) {
  if (!ids || ids.length === 0) return;
  const db = getDb();
  const update = db.prepare(
    `UPDATE events SET status = 'error', error = ? WHERE id = ?`
  );
  const updateMany = db.transaction((arr) => {
    for (const id of arr) update.run(error, id);
  });
  updateMany(ids);
}

/**
 * Reset error events back to pending so they are retried.
 */
function resetErrors() {
  const db = getDb();
  const result = db.prepare(
    `UPDATE events SET status = 'pending', error = NULL WHERE status = 'error'`
  ).run();
  if (result.changes > 0) {
    console.log(`[store] Reset ${result.changes} error event(s) to pending`);
  }
}

/**
 * Count pending events in the buffer.
 */
function countPending() {
  const db = getDb();
  return db.prepare(`SELECT COUNT(*) as c FROM events WHERE status = 'pending'`).get().c;
}

/**
 * Count total events sent successfully.
 */
function countSent() {
  const db = getDb();
  return db.prepare(`SELECT COUNT(*) as c FROM events WHERE status = 'sent'`).get().c;
}

/**
 * Purge old sent events to keep the database small.
 * Keeps sent events for the last `days` days.
 * @param {number} days — default 30
 */
function pruneOldEvents(days = 30) {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM events WHERE status = 'sent' AND sent_at < datetime('now', '-${days} days')`
  ).run();
  if (result.changes > 0) {
    console.log(`[store] Pruned ${result.changes} old sent events (>${days}d)`);
  }
}

/**
 * Get/set simple metadata key-value pairs.
 */
function getMeta(key) {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  getDb().prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

/**
 * Get a summary of the store state for status reporting.
 */
function getStats() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
      COUNT(*) as total
    FROM events
  `).get();
  return {
    pending: row.pending || 0,
    sent: row.sent || 0,
    errors: row.errors || 0,
    total: row.total || 0,
    db_path: DB_PATH
  };
}

module.exports = {
  insertEvents,
  getPendingEvents,
  markSent,
  markError,
  resetErrors,
  countPending,
  countSent,
  pruneOldEvents,
  getMeta,
  setMeta,
  getStats
};
