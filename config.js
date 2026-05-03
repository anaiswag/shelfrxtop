/**
 * Configuration management for ShelfRx Agent.
 *
 * Configuration is stored in a JSON file at:
 *   %APPDATA%\ShelfRx\config.json
 *
 * Default config:
 *   {
 *     "pn13_port": 5013,
 *     "cloud_url": "https://shelfrx.polsia.app",
 *     "pharmacy_key": "",
 *     "lgo": "winpharma",
 *     "debug": false
 *   }
 *
 * The pharmacy_key is obtained from the ShelfRx web app (Connexion Stock → Agent PN13 tab).
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(
  process.env.APPDATA || process.env.HOME || '.',
  'ShelfRx'
);
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  pn13_port: 5013,
  cloud_url: 'https://shelfrx.polsia.app',
  pharmacy_key: '',
  lgo: 'winpharma',
  debug: false
};

/**
 * Load configuration from disk. Returns defaults merged with stored config.
 */
function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const stored = JSON.parse(raw);
      return { ...DEFAULTS, ...stored };
    }
  } catch (err) {
    console.warn('[config] Failed to load config, using defaults:', err.message);
  }
  return { ...DEFAULTS };
}

/**
 * Save configuration to disk.
 * @param {Object} cfg — partial config to merge with current
 */
function save(cfg) {
  const current = load();
  const updated = { ...current, ...cfg };

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8');
  console.log(`[config] Saved to: ${CONFIG_PATH}`);
  return updated;
}

/**
 * Validate that the config has the minimum fields needed to operate.
 * Returns { valid: boolean, errors: string[] }
 */
function validate(cfg) {
  const c = cfg || load();
  const errors = [];

  if (!c.pharmacy_key || c.pharmacy_key.length < 10) {
    errors.push('pharmacy_key is missing — copy it from the ShelfRx web app');
  }
  if (!c.cloud_url || !c.cloud_url.startsWith('http')) {
    errors.push('cloud_url is invalid');
  }
  if (!c.pn13_port || c.pn13_port < 1 || c.pn13_port > 65535) {
    errors.push('pn13_port must be between 1 and 65535');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Print the current config to stdout (used for setup verification).
 */
function print() {
  const cfg = load();
  console.log('\n── ShelfRx Agent Configuration ──────────────────');
  console.log(`  Config file  : ${CONFIG_PATH}`);
  console.log(`  PN13 port    : ${cfg.pn13_port}`);
  console.log(`  Cloud URL    : ${cfg.cloud_url}`);
  console.log(`  Pharmacy key : ${cfg.pharmacy_key ? cfg.pharmacy_key.substring(0, 8) + '…' : '(NOT SET)'}`);
  console.log(`  LGO          : ${cfg.lgo}`);
  console.log(`  Debug        : ${cfg.debug}`);
  console.log('─────────────────────────────────────────────────\n');
}

module.exports = { load, save, validate, print, CONFIG_PATH, DEFAULTS };
