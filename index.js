/**
 * ShelfRx Agent — Service principal
 *
 * Service Windows léger qui capture les mouvements de stock en temps réel
 * via le protocole PN13-IS depuis votre LGO (Winpharma, LGPI/Pharmagest, LEO).
 *
 * Ce service :
 *   1. Écoute les messages PN13 (XML sur TCP) envoyés par votre LGO
 *   2. Parse les mouvements de stock (ventes, réceptions, retours)
 *   3. Stocke les événements localement (SQLite) en cas de perte internet
 *   4. Envoie les événements vers ShelfRx cloud par batch HTTPS (toutes les 5 sec)
 *
 * Démarrage : node index.js
 * Version    : 1.0.0
 */

'use strict';

const net = require('net');
const config = require('./config');
const { parsePN13Message } = require('./pn13');
const store = require('./store');
const { startSender, flushNow } = require('./sender');

const VERSION = require('./package.json').version;

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   ShelfRx Agent v${VERSION.padEnd(24)}║`);
  console.log(`║   Service de capture stock PN13-IS       ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  const cfg = config.load();
  config.print();

  // Validate config
  const { valid, errors } = config.validate(cfg);
  if (!valid) {
    console.error('⚠️  Configuration incomplète :');
    errors.forEach(e => console.error(`   • ${e}`));
    console.error('\nCopier votre clé pharmacie depuis ShelfRx → Connexion Stock → Agent PN13');
    console.error(`Modifier le fichier : ${config.CONFIG_PATH}`);
    console.error('\nLe service démarre malgré tout — les événements seront bufférisés localement.');
  }

  // Start cloud sender (runs in background, 5s tick)
  startSender();

  // Start PN13 TCP listener
  startPN13Listener(cfg.pn13_port);

  // Start LEO/CSV file watcher if configured
  if (cfg.lgo === 'leo' && cfg.leo_watch_path) {
    startFileWatcher(cfg.leo_watch_path);
  }

  // Status ticker (every 60s)
  setInterval(() => {
    const stats = store.getStats();
    console.log(`[status] Buffer: ${stats.pending} pending / ${stats.sent} sent / ${stats.errors} errors`);
  }, 60_000);

  console.log(`\n✅ ShelfRx Agent démarré — en attente de connexions PN13 sur le port ${cfg.pn13_port}\n`);
}

// ── PN13 TCP Listener ──────────────────────────────────────────────────────

/**
 * Create a TCP server that listens for PN13 XML messages.
 *
 * PN13-IS messages are sent as raw TCP streams. Each connection typically
 * sends one XML document. We accumulate bytes until:
 *   - The connection closes (most common)
 *   - We detect a complete XML document (root element closed)
 *
 * Clients: Winpharma, LGPI/Pharmagest LGO software
 */
function startPN13Listener(port) {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[pn13] Connection from ${remote}`);

    let buffer = '';
    let messageCount = 0;

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buffer += chunk;

      // Try to parse complete XML documents from the buffer
      // Many LGOs send the full document at once; some stream it
      const messages = extractCompleteMessages(buffer);
      buffer = messages.remaining;

      for (const xml of messages.complete) {
        handlePN13Message(xml, remote);
        messageCount++;
      }
    });

    socket.on('end', () => {
      // Process any remaining data when connection closes
      const trimmed = buffer.trim();
      if (trimmed.length > 0) {
        handlePN13Message(trimmed, remote);
        messageCount++;
      }
      console.log(`[pn13] Connection closed: ${remote} (${messageCount} message(s))`);
    });

    socket.on('error', (err) => {
      console.warn(`[pn13] Socket error from ${remote}: ${err.message}`);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[pn13] ❌ Port ${port} déjà utilisé. Changez pn13_port dans la configuration.`);
    } else {
      console.error(`[pn13] Server error:`, err.message);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[pn13] Listening on TCP port ${port} (0.0.0.0)`);
  });

  return server;
}

/**
 * Extract complete XML documents from a buffer string.
 * Returns { complete: string[], remaining: string }
 */
function extractCompleteMessages(buffer) {
  const complete = [];
  let remaining = buffer;

  // Split on XML declaration boundaries — each new <?xml ... ?> starts a new message
  const parts = remaining.split(/(?=<\?xml\s)/i);

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i].trim();
    if (part.length > 0 && looksLikeCompleteXml(part)) {
      complete.push(part);
    }
  }

  // Keep the last part as the remaining buffer
  remaining = parts[parts.length - 1] || '';

  // If there's no XML declaration but the buffer looks like a complete document, process it
  if (complete.length === 0 && looksLikeCompleteXml(remaining.trim())) {
    complete.push(remaining.trim());
    remaining = '';
  }

  return { complete, remaining };
}

/**
 * Heuristic check: does this string look like a complete XML document?
 * We check that there's a root element that opens and closes.
 */
function looksLikeCompleteXml(str) {
  if (!str || str.length < 10) return false;

  // Must start with XML-like content
  const trimmed = str.trim();
  if (!trimmed.startsWith('<')) return false;

  // Find the root element name
  const rootMatch = trimmed.match(/<([A-Za-z][A-Za-z0-9_:-]*)/);
  if (!rootMatch) return false;

  const rootTag = rootMatch[1];

  // Check if the root closing tag exists
  return trimmed.includes(`</${rootTag}`);
}

/**
 * Process a single PN13 XML message: parse, store, and flush to cloud.
 */
async function handlePN13Message(xml, source) {
  const cfg = config.load();
  if (cfg.debug) {
    console.log(`[pn13] Message from ${source} (${xml.length} bytes):`);
    console.log(xml.substring(0, 500));
  }

  try {
    const events = await parsePN13Message(xml, xml);

    if (events.length === 0) {
      console.warn(`[pn13] No parseable events in message from ${source}`);
      return;
    }

    // Tag each event with its source
    const tagged = events.map(ev => ({
      ...ev,
      metadata: { ...ev.metadata, source_ip: source }
    }));

    store.insertEvents(tagged);
    console.log(`[pn13] Received ${events.length} event(s) from ${source} — CIPs: ${events.map(e => e.cip_code).join(', ')}`);

    // Trigger immediate flush for low latency
    flushNow();
  } catch (err) {
    console.error(`[pn13] Error handling message from ${source}:`, err.message);
  }
}

// ── LEO File Watcher (fallback for LGOs without PN13 support) ─────────────

/**
 * File-based fallback for LEO/Isipharm and other LGOs that export CSV files
 * instead of sending PN13 messages.
 *
 * Watches a directory for new CSV files matching the LGO export pattern.
 * When a new file appears, parses it and inserts the events into the buffer.
 */
function startFileWatcher(watchPath) {
  const fs = require('fs');
  const csvParser = require('./csv-parser');

  if (!fs.existsSync(watchPath)) {
    console.warn(`[filewatcher] Watch path does not exist: ${watchPath}`);
    return;
  }

  console.log(`[filewatcher] Watching for CSV exports at: ${watchPath}`);

  const processed = new Set();

  function scan() {
    try {
      const files = fs.readdirSync(watchPath);
      for (const file of files) {
        if (!file.endsWith('.csv') && !file.endsWith('.txt')) continue;
        if (processed.has(file)) continue;

        const fullPath = require('path').join(watchPath, file);
        const stat = fs.statSync(fullPath);

        // Only process files modified in the last 24h (avoid reprocessing old exports)
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) {
          processed.add(file); // Mark old files as already-processed
          continue;
        }

        console.log(`[filewatcher] New file detected: ${file}`);
        processed.add(file);

        // Parse CSV asynchronously
        setImmediate(async () => {
          try {
            const events = await csvParser.parseCSVFile(fullPath);
            if (events.length > 0) {
              store.insertEvents(events);
              console.log(`[filewatcher] Imported ${events.length} event(s) from ${file}`);
              flushNow();
            }
          } catch (err) {
            console.error(`[filewatcher] Failed to parse ${file}:`, err.message);
          }
        });
      }
    } catch (err) {
      console.warn('[filewatcher] Scan error:', err.message);
    }
  }

  // Scan every 30 seconds
  scan();
  setInterval(scan, 30_000);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down gracefully…');
  const stats = store.getStats();
  console.log(`[agent] Final buffer stats: ${stats.pending} pending, ${stats.sent} sent`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[agent] Received SIGTERM, shutting down…');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[agent] Uncaught exception:', err);
  // Don't crash the service — log and continue
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent] Unhandled rejection:', reason);
});

// ── Run ───────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('[agent] Fatal startup error:', err);
  process.exit(1);
});
