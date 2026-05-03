/**
 * PN13-IS Protocol Parser
 *
 * Parses XML messages from LGO systems (Winpharma, LGPI/Pharmagest) that implement
 * the PN13-IS (Protocole National 13 — Interface Système) standard for pharmacy
 * stock movement communication.
 *
 * The PN13 protocol transmits XML-formatted stock movement events over TCP.
 * This parser handles the XML envelope and extracts structured event data.
 *
 * Supported message types:
 *  - VENTE          : sale (quantity negative)
 *  - RECEPTION      : stock receipt (quantity positive)
 *  - RETOUR         : return (can be positive or negative)
 *  - INVENTAIRE     : inventory adjustment
 *  - AJUSTEMENT     : manual stock adjustment
 */

const xml2js = require('xml2js');

const PARSER = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  trim: true
});

/**
 * Normalise a PN13 message type string to our internal event type.
 */
function normaliseEventType(raw) {
  if (!raw) return null;
  const v = String(raw).toUpperCase().trim();
  if (v.includes('VENTE') || v === 'S' || v === 'SALE') return 'vente';
  if (v.includes('RECEP') || v === 'R' || v === 'IN') return 'reception';
  if (v.includes('RETOUR') || v === 'RET') return 'retour';
  if (v.includes('INVENT')) return 'inventaire';
  if (v.includes('AJUST') || v.includes('ADJUST') || v === 'A') return 'ajustement';
  return null;
}

/**
 * Safely extract a string value from a parsed XML node.
 * Handles both string and array-wrapped values from xml2js.
 */
function str(node) {
  if (!node) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (Array.isArray(node)) return node[0] ? String(node[0]).trim() : null;
  if (typeof node === 'object' && node._) return String(node._).trim() || null;
  return String(node).trim() || null;
}

/**
 * Parse a complete PN13 XML message string into a structured event object.
 *
 * Returns an array of events (a single PN13 message can carry multiple movements).
 * Returns an empty array if the message cannot be parsed or contains no valid events.
 *
 * @param {string} xmlString — raw XML string from the TCP connection
 * @param {string} rawXml    — original untouched XML (stored for audit)
 * @returns {Promise<Array>}
 */
async function parsePN13Message(xmlString, rawXml) {
  const events = [];

  let root;
  try {
    root = await PARSER.parseStringPromise(xmlString);
  } catch (err) {
    console.warn('[pn13] XML parse error:', err.message);
    return events;
  }

  // ── Strategy 1: Standard PN13-IS envelope
  // <PN13><Header>…</Header><Body><Movement>…</Movement></Body></PN13>
  const pn13 = root.PN13 || root.Pn13 || root.pn13 || root.Message || root.ROOT;
  if (pn13) {
    const body = pn13.Body || pn13.body || pn13.Movements || pn13.Mouvement;
    if (body) {
      const movements = extractMovements(body);
      const header = pn13.Header || pn13.header || {};
      const headerTs = str(header.Timestamp || header.timestamp || header.Date || header.date);

      for (const mov of movements) {
        const event = parseMovement(mov, headerTs, rawXml);
        if (event) events.push(event);
      }
      if (events.length > 0) return events;
    }
  }

  // ── Strategy 2: Winpharma variant — <MouvementStock>…</MouvementStock>
  const wpmov = root.MouvementStock || root.MouvementsDeSortie || root.MouvementsStock;
  if (wpmov) {
    const movements = extractMovements(wpmov);
    for (const mov of movements) {
      const event = parseMovement(mov, null, rawXml);
      if (event) events.push(event);
    }
    if (events.length > 0) return events;
  }

  // ── Strategy 3: LGPI/Pharmagest variant — <PharmaMouvement>…</PharmaMouvement>
  const lmov = root.PharmaMouvement || root.Mouvement || root.Mouvements;
  if (lmov) {
    const movements = extractMovements(lmov);
    for (const mov of movements) {
      const event = parseMovement(mov, null, rawXml);
      if (event) events.push(event);
    }
    if (events.length > 0) return events;
  }

  // ── Fallback: Try to find any CIP13-like node in the document
  const flat = flattenObject(root);
  const cipKey = Object.keys(flat).find(k =>
    k.toLowerCase().includes('cip') || k.toLowerCase().includes('ean')
  );
  if (cipKey) {
    const event = {
      event_type: 'ajustement',
      cip_code: str(flat[cipKey]),
      quantity: parseInt(str(flat['Quantite'] || flat['Quantity'] || flat['Qte'] || '0'), 10) || null,
      label: str(flat['Libelle'] || flat['Label'] || flat['Designation'] || null),
      unit_price_ht: parseFloat(str(flat['PrixHT'] || flat['Prix'] || flat['PrixUnitaire'] || '0')) || null,
      occurred_at: parseTimestamp(str(flat['Timestamp'] || flat['Date'] || null)),
      raw_xml: rawXml,
      metadata: { parse_strategy: 'fallback', flat_keys: Object.keys(flat) }
    };
    if (event.cip_code) {
      events.push(event);
    }
  }

  return events;
}

function extractMovements(node) {
  if (!node) return [];
  const movement = node.Movement || node.Mouvement || node.MouvementArticle ||
                   node.Ligne || node.Line || node.Article || node;
  if (Array.isArray(movement)) return movement;
  if (typeof movement === 'object' && !Array.isArray(movement)) return [movement];
  return [node];
}

function parseMovement(mov, headerTs, rawXml) {
  if (!mov || typeof mov !== 'object') return null;

  // CIP code — try several field names used by different LGOs
  const cipRaw = str(
    mov.CIP || mov.CIP13 || mov.CodeCIP || mov.CodeCIP13 ||
    mov.EAN13 || mov.EAN || mov.CodeProduit || mov.Cip || mov.Code
  );
  if (!cipRaw) return null;

  // Clean CIP: remove spaces, dashes, keep only digits
  const cip = cipRaw.replace(/[^0-9]/g, '');
  if (cip.length < 7) return null; // Too short to be a valid CIP

  // Quantity
  const qtyRaw = str(
    mov.Quantite || mov.Quantity || mov.Qte || mov.Qt || mov.NbUnite
  );
  const quantity = qtyRaw ? (parseInt(qtyRaw, 10) || null) : null;

  // Type
  const typeRaw = str(
    mov.TypeMouvement || mov.Type || mov.Mouvement || mov.MouvementType ||
    mov.TypeOperation || mov.Operation
  );
  const event_type = normaliseEventType(typeRaw) || inferTypeFromQuantity(quantity);

  // Label
  const label = str(
    mov.Libelle || mov.Label || mov.Designation || mov.Produit || mov.NomProduit
  );

  // Price
  const priceRaw = str(
    mov.PrixHT || mov.PrixUnitaire || mov.Prix || mov.PU || mov.PrixAchat
  );
  const unit_price_ht = priceRaw ? (parseFloat(priceRaw.replace(',', '.')) || null) : null;

  // Timestamp
  const tsRaw = str(
    mov.Timestamp || mov.DateHeure || mov.Date || mov.DateMouvement ||
    mov.DateOperation
  ) || headerTs;
  const occurred_at = parseTimestamp(tsRaw);

  return {
    event_type,
    cip_code: cip,
    quantity,
    label: label ? label.substring(0, 500) : null,
    unit_price_ht,
    occurred_at,
    raw_xml: rawXml,
    metadata: {
      raw_type: typeRaw,
      raw_cip: cipRaw
    }
  };
}

function inferTypeFromQuantity(quantity) {
  if (quantity === null || quantity === undefined) return 'ajustement';
  if (quantity < 0) return 'vente';
  if (quantity > 0) return 'reception';
  return 'ajustement';
}

/**
 * Parse a PN13 timestamp string into an ISO 8601 string.
 * Common formats: YYYYMMDDHHmmss, YYYY-MM-DD HH:mm:ss, DD/MM/YYYY HH:mm
 */
function parseTimestamp(raw) {
  if (!raw) return new Date().toISOString();

  // YYYYMMDDHHmmss (14 digits)
  if (/^\d{14}$/.test(raw)) {
    const y = raw.slice(0, 4), mo = raw.slice(4, 6), d = raw.slice(6, 8);
    const h = raw.slice(8, 10), mi = raw.slice(10, 12), s = raw.slice(12, 14);
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    if (!isNaN(dt)) return dt.toISOString();
  }

  // YYYYMMDDHHmm (12 digits)
  if (/^\d{12}$/.test(raw)) {
    const y = raw.slice(0, 4), mo = raw.slice(4, 6), d = raw.slice(6, 8);
    const h = raw.slice(8, 10), mi = raw.slice(10, 12);
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
    if (!isNaN(dt)) return dt.toISOString();
  }

  // DD/MM/YYYY HH:mm[:ss]
  const frMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (frMatch) {
    const [, d, mo, y, h, mi, s] = frMatch;
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s || '00'}Z`);
    if (!isNaN(dt)) return dt.toISOString();
  }

  // ISO-like: YYYY-MM-DD HH:mm[:ss]
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  if (isoMatch) {
    const dt = new Date(raw.replace(' ', 'T') + (raw.includes('Z') ? '' : 'Z'));
    if (!isNaN(dt)) return dt.toISOString();
  }

  return new Date().toISOString();
}

function flattenObject(obj, prefix = '', result = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenObject(v, key, result);
    } else {
      result[k] = v;
    }
  }
  return result;
}

module.exports = { parsePN13Message };
