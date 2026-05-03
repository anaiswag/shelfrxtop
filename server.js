const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { randomUUID, scryptSync, randomBytes, timingSafeEqual } = require('crypto');
const OpenAI = require('openai');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '5mb' }));

// ========== WEBSOCKET CLIENT REGISTRY ==========

// Map<agentId, Set<WebSocket>> — tracks active frontend subscribers per pharmacy agent
const wsClients = new Map();

function broadcastStockUpdate(agentId, payload) {
  const clients = wsClients.get(agentId);
  if (!clients || clients.size === 0) return;
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) {}
    }
  });
}

// ========== AUTO IMAGE SEARCH (BDPM) ==========

/**
 * Tries to find a packshot image for a medication from the BDPM (Base de données
 * publique des médicaments). Runs asynchronously after product creation — never
 * blocks the wizard.
 *
 * Strategy:
 * 1. Search the government open-data API for a CIS code by product name
 * 2. Construct image URL from CIS code pattern (base-medicaments.fr)
 * 3. Verify the image actually exists (HEAD request)
 * 4. Store result in product_images table
 * 5. Fail silently at every step
 */
async function autoFetchProductImage(productId, productName) {
  try {
    // Generate a styled placeholder packshot from the product name.
    // The BDPM API doesn't provide packshot images, so we create attractive
    // colored product cards with the product initial and name.
    // Users can override with manual upload at any time.
    const colors = ['#0D9488','#3B82F6','#8B5CF6','#EC4899','#F59E0B','#10B981','#EF4444','#6366F1','#06B6D4','#84CC16'];
    const hash = productName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const bg = colors[hash % colors.length];
    const initial = productName.charAt(0).toUpperCase();

    // Split name into max 2 lines for display
    let line1 = productName, line2 = '';
    if (productName.length > 14) {
      const words = productName.split(/\s+/);
      line1 = ''; line2 = '';
      for (const w of words) {
        if (!line1 || (line1 + ' ' + w).length <= 14) line1 = (line1 + ' ' + w).trim();
        else line2 = (line2 + ' ' + w).trim();
      }
      if (line2.length > 14) line2 = line2.substring(0, 13) + '\u2026';
    }

    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="${bg}" stop-opacity="0.75"/></linearGradient></defs>
<rect width="120" height="160" fill="url(#g)" rx="10"/>
<rect x="8" y="8" width="104" height="100" fill="#fff" fill-opacity="0.15" rx="6"/>
<circle cx="60" cy="52" r="24" fill="#fff" fill-opacity="0.2"/>
<text x="60" y="62" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="700" fill="#fff">${esc(initial)}</text>
<rect x="0" y="115" width="120" height="45" fill="#000" fill-opacity="0.2"/>
<rect x="0" y="150" width="120" height="10" fill="#000" fill-opacity="0.15" rx="0 0 10 10"/>
<text x="60" y="${line2 ? '132' : '138'}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="10" font-weight="700" fill="#fff">${esc(line1)}</text>
${line2 ? `<text x="60" y="146" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" fill="#fff" opacity="0.9">${esc(line2)}</text>` : ''}
</svg>`;

    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

    await pool.query(
      `INSERT INTO product_images (product_id, image_url, source) VALUES ($1, $2, 'auto')
       ON CONFLICT DO NOTHING`,
      [productId, dataUrl]
    );
    console.log(`[images] Generated packshot for product ${productId}`);
  } catch (err) {
    console.warn(`[images] Packshot generation failed for ${productId}: ${err.message}`);
  }
}

/**
 * Returns a map of product_id → { image_url, source } for a list of product IDs.
 * Uses the most recent image per product.
 */
async function getProductImages(productIds) {
  if (!productIds || productIds.length === 0) return {};
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (product_id) product_id, image_url, source
       FROM product_images
       WHERE product_id = ANY($1::uuid[])
       ORDER BY product_id, created_at DESC`,
      [productIds]
    );
    const map = {};
    result.rows.forEach(row => { map[row.product_id] = { image_url: row.image_url, source: row.source }; });
    return map;
  } catch {
    return {};
  }
}

// File upload config — store photos in /tmp for Render (ephemeral but fine for MVP)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// PDF upload config — for catalogue PDF imports
const uploadPDF = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  }
});

/**
 * Parse a pharmacy catalogue PDF and extract (Désignation, Code CIP) pairs.
 * Handles both same-line format: "DOLIPRANE 1000MG   3400935736929"
 * and next-line format:
 *   "TOLERIANE VERNIS SILIC FRAMBOIS16"
 *   "3337872413705"
 * Also handles reversed format: "3400935736929  DOLIPRANE 1000MG"
 */
function parseCataloguePDFText(text) {
  const CIP_RE = /\b(\d{12,13})\b/; // 12 digits (CIP) or 13 digits (EAN)
  const SKIP_RE = /^(désignation|designation|code\s*produit|code\s*ean|code\s*cip|pharmacie|catalogue|listing|répertoire|repertoire|page\s+\d+|\d{1,4}|date\s*:|adresse\s*:|tel\s*:|\s*)$/i;

  const lines = text.split('\n').map(l => l.trim());
  const products = [];
  let accumulatedName = '';

  for (const line of lines) {
    if (!line || SKIP_RE.test(line)) {
      // Reset accumulator only if empty line or skip token (not mid-product)
      if (!line) accumulatedName = '';
      continue;
    }

    const m = CIP_RE.exec(line);
    if (m) {
      const cip = m[1];
      const before = line.slice(0, m.index).trim();
      const after = line.slice(m.index + cip.length).trim();
      // Text on same line as CIP (before or after it)
      const textOnLine = before || after;
      const fullName = [accumulatedName, textOnLine].filter(Boolean).join(' ').trim();
      const cleanName = fullName
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanName && cleanName.length >= 2 && !SKIP_RE.test(cleanName)) {
        products.push({ name: cleanName.substring(0, 500), barcode: cip });
      }
      accumulatedName = '';
    } else {
      // Not a CIP line — accumulate as product name
      if (!SKIP_RE.test(line)) {
        accumulatedName = accumulatedName ? accumulatedName + ' ' + line : line;
      }
    }
  }

  return products;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ========== API ROUTES ==========

// List projects by device_id
app.get('/api/projects', async (req, res) => {
  try {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'device_id is required' });

    const result = await pool.query(
      `SELECT id, name, category, shelf_width, shelf_height, num_shelves,
              planogram IS NOT NULL as has_planogram, created_at, updated_at
       FROM projects WHERE device_id = $1 ORDER BY updated_at DESC`,
      [device_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List projects error:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Create a new project
app.post('/api/projects', async (req, res) => {
  try {
    const { name, device_id } = req.body;
    const result = await pool.query(
      `INSERT INTO projects (name, device_id) VALUES ($1, $2) RETURNING *`,
      [name || 'Untitled Project', device_id || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create project error:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Get project with products (includes latest image per product)
app.get('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const project = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (project.rows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const products = await pool.query(
      'SELECT * FROM products WHERE project_id = $1 ORDER BY created_at',
      [id]
    );
    const imageMap = await getProductImages(products.rows.map(p => p.id));
    const productsWithImages = products.rows.map(p => ({
      ...p,
      image_url: imageMap[p.id]?.image_url || null,
      image_source: imageMap[p.id]?.source || null
    }));
    res.json({ ...project.rows[0], products: productsWithImages });
  } catch (err) {
    console.error('Get project error:', err);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

// Update project shelf dimensions & settings
app.patch('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, shelf_width, shelf_height, shelf_depth, num_shelves, num_sections, category } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (shelf_width !== undefined) { fields.push(`shelf_width = $${idx++}`); values.push(shelf_width); }
    if (shelf_height !== undefined) { fields.push(`shelf_height = $${idx++}`); values.push(shelf_height); }
    if (shelf_depth !== undefined) { fields.push(`shelf_depth = $${idx++}`); values.push(shelf_depth); }
    if (num_shelves !== undefined) { fields.push(`num_shelves = $${idx++}`); values.push(num_shelves); }
    if (num_sections !== undefined) { fields.push(`num_sections = $${idx++}`); values.push(num_sections); }
    if (category !== undefined) { fields.push(`category = $${idx++}`); values.push(category); }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update project error:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// Delete a project and its products
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete project error:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// Upload photo for project (stores as base64 in DB for MVP simplicity)
app.post('/api/projects/:id/photo', upload.single('photo'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await pool.query(
      `UPDATE projects SET photo_url = $1, updated_at = NOW() WHERE id = $2 RETURNING id, photo_url`,
      [base64, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ success: true, photo_url: result.rows[0].photo_url });
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// Add product to project
app.post('/api/projects/:id/products', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, quantity, width, height, depth, priority, sub_category } = req.body;

    if (!name || !width || !height || !depth) {
      return res.status(400).json({ error: 'Name, width, height, and depth are required' });
    }

    const result = await pool.query(
      `INSERT INTO products (project_id, name, quantity, width, height, depth, priority, sub_category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, name, quantity || 1, width, height, depth, priority || 'medium', sub_category || null]
    );
    const product = result.rows[0];
    res.json(product);
    // Async — never block the response
    autoFetchProductImage(product.id, name).catch(() => {});
  } catch (err) {
    console.error('Add product error:', err);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// Bulk add products
app.post('/api/projects/:id/products/bulk', async (req, res) => {
  try {
    const { id } = req.params;
    const { products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Products array is required' });
    }

    const results = [];
    for (const p of products) {
      if (!p.name || !p.width || !p.height || !p.depth) continue;
      const result = await pool.query(
        `INSERT INTO products (project_id, name, quantity, width, height, depth, priority, sub_category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, p.name, p.quantity || 1, p.width, p.height, p.depth, p.priority || 'medium', p.sub_category || null]
      );
      results.push(result.rows[0]);
    }
    res.json(results);
  } catch (err) {
    console.error('Bulk add products error:', err);
    res.status(500).json({ error: 'Failed to add products' });
  }
});

// Delete a product
app.delete('/api/products/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Get product image (latest)
app.get('/api/products/:id/image', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT image_url, source FROM product_images
       WHERE product_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.json({ image_url: null, source: null });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get image' });
  }
});

// Upload product image manually (multipart)
app.post('/api/products/:id/image', upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    // Check product exists
    const check = await pool.query('SELECT id FROM products WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    // Convert to base64 data URL (compress: limit is already enforced by multer 10MB)
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    // Delete any previous manual image and insert new one
    await pool.query(`DELETE FROM product_images WHERE product_id = $1 AND source = 'manual'`, [id]);
    const result = await pool.query(
      `INSERT INTO product_images (product_id, image_url, source) VALUES ($1, $2, 'manual') RETURNING *`,
      [id, base64]
    );
    res.json({ success: true, image_url: result.rows[0].image_url, source: 'manual' });
  } catch (err) {
    console.error('Upload image error:', err);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// ========== BARCODE LOOKUP ==========

// Look up a product by barcode (EAN-13 or CIP-13)
// Checks local collaborative catalog first, then Open Food Facts, then BDPM
app.get('/api/barcode/:code', async (req, res) => {
  const cleanCode = (req.params.code || '').replace(/\D/g, '');
  if (!cleanCode || cleanCode.length < 7) {
    return res.status(400).json({ error: 'Code-barres invalide' });
  }

  try {
    // 1. Check local collaborative catalog
    const localResult = await pool.query(
      'SELECT * FROM product_catalog WHERE barcode = $1',
      [cleanCode]
    );
    if (localResult.rows.length > 0) {
      const p = localResult.rows[0];
      return res.json({
        found: true,
        source: 'catalog',
        product: { barcode: cleanCode, name: p.name, brand: p.brand, width: p.width, height: p.height, depth: p.depth, image_url: p.image_url }
      });
    }

    // 2. Try Open Food Facts (consumer EAN-13 products)
    try {
      const controller1 = new AbortController();
      const t1 = setTimeout(() => controller1.abort(), 5000);
      const offRes = await fetch(`https://world.openfoodfacts.org/api/v0/product/${cleanCode}.json`, { signal: controller1.signal });
      clearTimeout(t1);
      if (offRes.ok) {
        const data = await offRes.json();
        if (data.status === 1 && data.product) {
          const p = data.product;
          const name = p.product_name_fr || p.product_name || p.generic_name_fr || p.generic_name || '';
          if (name && name.trim()) {
            return res.json({
              found: true,
              source: 'openfoodfacts',
              product: {
                barcode: cleanCode,
                name: name.trim(),
                brand: p.brands ? p.brands.split(',')[0].trim() : '',
                width: null, height: null, depth: null,
                image_url: p.image_front_small_url || p.image_url || null
              }
            });
          }
        }
      }
    } catch { /* silent */ }

    // 3. Try BDPM open API for CIP-13 codes (French pharmacy)
    try {
      const controller2 = new AbortController();
      const t2 = setTimeout(() => controller2.abort(), 5000);
      const bdpmRes = await fetch(`https://open.medicaments.fr/api/v1/medicaments/${cleanCode}`, { signal: controller2.signal });
      clearTimeout(t2);
      if (bdpmRes.ok) {
        const data = await bdpmRes.json();
        const name = data.denomination || data.denominationMedicament || '';
        if (name && name.trim()) {
          return res.json({
            found: true,
            source: 'bdpm',
            product: {
              barcode: cleanCode,
              name: name.trim(),
              brand: Array.isArray(data.titulaires) ? data.titulaires[0] || '' : '',
              width: null, height: null, depth: null,
              image_url: null
            }
          });
        }
      }
    } catch { /* silent */ }

    return res.json({ found: false, barcode: cleanCode });
  } catch (err) {
    console.error('Barcode lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Save a product to the collaborative catalog (contributes data for future scans)
app.post('/api/barcode', async (req, res) => {
  const { barcode, name, brand, width, height, depth, image_url } = req.body;
  if (!barcode || !name) return res.status(400).json({ error: 'barcode and name required' });
  const cleanCode = String(barcode).replace(/\D/g, '');
  if (!cleanCode) return res.status(400).json({ error: 'Invalid barcode' });

  try {
    const result = await pool.query(
      `INSERT INTO product_catalog (barcode, name, brand, width, height, depth, image_url, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'community')
       ON CONFLICT (barcode) DO UPDATE SET
         name   = COALESCE(EXCLUDED.name, product_catalog.name),
         brand  = COALESCE(EXCLUDED.brand, product_catalog.brand),
         width  = COALESCE(EXCLUDED.width, product_catalog.width),
         height = COALESCE(EXCLUDED.height, product_catalog.height),
         depth  = COALESCE(EXCLUDED.depth, product_catalog.depth),
         image_url = COALESCE(EXCLUDED.image_url, product_catalog.image_url)
       RETURNING *`,
      [cleanCode, name, brand || null, width || null, height || null, depth || null, image_url || null]
    );

    // Also add to global catalog (collective enrichment — all pharmacies benefit)
    try {
      await pool.query(
        `INSERT INTO global_catalog (cip13, designation, source, width, height, depth, image_url, updated_at)
         VALUES ($1, $2, 'barcode_scanned', $3, $4, $5, $6, NOW())
         ON CONFLICT (cip13) DO UPDATE SET
           designation = COALESCE(EXCLUDED.designation, global_catalog.designation),
           width      = COALESCE(EXCLUDED.width, global_catalog.width),
           height     = COALESCE(EXCLUDED.height, global_catalog.height),
           depth      = COALESCE(EXCLUDED.depth, global_catalog.depth),
           image_url  = COALESCE(EXCLUDED.image_url, global_catalog.image_url),
           updated_at = NOW()`,
        [cleanCode, name, width || null, height || null, depth || null, image_url || null]
      );
    } catch (gcErr) {
      console.error('[global-catalog] barcode save error:', gcErr.message);
      // Non-blocking: product_catalog save succeeded, global_catalog is a bonus
    }

    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('Save barcode error:', err);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// ========== GLOBAL CATALOG SEARCH ==========

// GET /api/catalog/search — search global shared catalog for wizard autocomplete
// Returns products available to all pharmacies on signup
// Query params: q (search term), limit (default 50), offset (default 0)
app.get('/api/catalog/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    if (!q || q.length < 1) {
      return res.json({ products: [], total: 0 });
    }

    // Search by CIP code exact match OR designation fuzzy match
    const cleanQ = q.replace(/\"/g, '');
    const searchPattern = `%${cleanQ}%`;

    const result = await pool.query(
      `SELECT cip13, designation, source, width, height, depth, category, image_url, updated_at
       FROM global_catalog
       WHERE cip13 = $1
          OR designation ILIKE $2
       ORDER BY
         CASE WHEN cip13 = $1 THEN 0 ELSE 1 END,
         designation ILIKE $3 DESC,
         updated_at DESC
       LIMIT $4 OFFSET $5`,
      [cleanQ, searchPattern, `%${cleanQ}%`, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM global_catalog
       WHERE cip13 = $1 OR designation ILIKE $2`,
      [cleanQ, searchPattern]
    );

    res.json({
      products: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    });
  } catch (err) {
    console.error('[global-catalog] search error:', err);
    res.status(500).json({ error: 'Catalog search failed' });
  }
});

// ========== SHARING ==========

// Generate or get share ID for a project (requires device_id ownership)
app.post('/api/projects/:id/share', async (req, res) => {
  try {
    const { id } = req.params;
    const { device_id } = req.body;

    // Verify ownership
    if (!device_id) return res.status(400).json({ error: 'device_id is required' });

    const owner = await pool.query('SELECT device_id, share_id, name, planogram FROM projects WHERE id = $1', [id]);
    if (owner.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    if (owner.rows[0].device_id !== device_id) return res.status(403).json({ error: 'Not your project' });
    if (!owner.rows[0].planogram) return res.status(400).json({ error: 'Generate a planogram first before sharing' });

    // Return existing share_id or create new one
    if (owner.rows[0].share_id) {
      return res.json({ share_id: owner.rows[0].share_id });
    }

    const shareId = randomUUID();
    await pool.query('UPDATE projects SET share_id = $1 WHERE id = $2', [shareId, id]);
    res.json({ share_id: shareId });
  } catch (err) {
    console.error('Share project error:', err);
    res.status(500).json({ error: 'Failed to share project' });
  }
});

// Get a shared planogram by share_id (public, read-only)
app.get('/api/shared/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;

    const project = await pool.query(
      `SELECT id, name, category, shelf_width, shelf_height, shelf_depth, num_shelves,
              planogram, photo_url, created_at, updated_at
       FROM projects WHERE share_id = $1`,
      [shareId]
    );

    if (project.rows.length === 0) return res.status(404).json({ error: 'Planogram not found or link expired' });

    const proj = project.rows[0];
    if (!proj.planogram) return res.status(404).json({ error: 'Planogram not generated yet' });

    const products = await pool.query(
      'SELECT name, quantity, width, height, depth, priority, sub_category FROM products WHERE project_id = $1 ORDER BY created_at',
      [proj.id]
    );

    res.json({ ...proj, products: products.rows });
  } catch (err) {
    console.error('Get shared planogram error:', err);
    res.status(500).json({ error: 'Failed to get planogram' });
  }
});

// ========== PLANOGRAM GENERATION ==========

app.post('/api/projects/:id/generate', async (req, res) => {
  try {
    const { id } = req.params;
    // Optional stock context from client (array of { cip_code, quantity_on_hand, weekly_sales, is_rupture, is_surstock })
    const stockContext = req.body && Array.isArray(req.body.stock_context) ? req.body.stock_context : null;

    // Fetch project and products
    const project = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (project.rows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const proj = project.rows[0];
    if (!proj.shelf_width || !proj.shelf_height || !proj.num_shelves) {
      return res.status(400).json({ error: 'Set shelf dimensions before generating' });
    }

    const products = await pool.query(
      'SELECT * FROM products WHERE project_id = $1 ORDER BY created_at',
      [id]
    );
    if (products.rows.length === 0) {
      return res.status(400).json({ error: 'Add at least one product before generating' });
    }

    // Enrich products with stock context if available
    let enrichedProducts = products.rows;
    if (stockContext && stockContext.length > 0) {
      const stockMap = {};
      stockContext.forEach(s => { if (s.cip_code) stockMap[s.cip_code] = s; });
      enrichedProducts = products.rows.map(p => {
        // Match by CIP code stored in product name prefix or sub_category (best-effort)
        // Or match by exact name against label
        const match = stockContext.find(s =>
          (s.cip_code && p.name && p.name.includes(s.cip_code)) ||
          (s.label && p.name && p.name.toLowerCase().trim() === s.label.toLowerCase().trim())
        ) || (p.cip_code ? stockMap[p.cip_code] : null);

        if (!match) return p;

        // Override quantity with real stock
        const realQty = parseInt(match.quantity_on_hand) || parseInt(p.quantity) || 1;
        // Boost priority based on weekly sales (high rotation = eye level)
        let priority = p.priority;
        if (match.is_rupture) {
          // Ruptures: keep in list but flag — don't remove, pharmacist decides
          priority = 'low';
        } else if (match.weekly_sales >= 20) {
          priority = 'high';
        } else if (match.weekly_sales >= 5) {
          priority = priority === 'low' ? 'medium' : priority;
        }
        // Surstock: boost facings by overriding quantity upward for display
        const adjustedQty = match.is_surstock ? Math.min(realQty, realQty * 1.5) : realQty;

        return {
          ...p,
          quantity: adjustedQty,
          priority,
          _stock_enriched: true,
          _weekly_sales: match.weekly_sales || 0,
          _is_rupture: match.is_rupture || false,
          _is_surstock: match.is_surstock || false,
          _real_quantity: realQty
        };
      });
    }

    const planogram = generatePlanogram(proj, enrichedProducts);

    // Enrich planogram items with product image URLs
    const imageMap = await getProductImages(products.rows.map(p => p.id));
    planogram.shelves.forEach(shelf => {
      shelf.items.forEach(item => {
        const img = imageMap[item.product_id || item.id];
        if (img) {
          item.image_url = img.image_url;
          item.image_source = img.source;
        }
      });
    });

    // Save planogram to project
    await pool.query(
      'UPDATE projects SET planogram = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(planogram), id]
    );

    res.json(planogram);
  } catch (err) {
    console.error('Generate planogram error:', err);
    res.status(500).json({ error: 'Failed to generate planogram' });
  }
});

// Save manually-modified planogram (drag & drop)
app.patch('/api/projects/:id/planogram', async (req, res) => {
  try {
    const { id } = req.params;
    const { planogram } = req.body;

    if (!planogram || !planogram.shelves) {
      return res.status(400).json({ error: 'Invalid planogram data' });
    }

    const result = await pool.query(
      'UPDATE projects SET planogram = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [JSON.stringify(planogram), id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Save planogram error:', err);
    res.status(500).json({ error: 'Failed to save planogram' });
  }
});

/**
 * Planogram placement algorithm (v1 — rule-based)
 *
 * Rules:
 * 1. High-priority products get eye-level shelves and more facings
 * 2. Products with higher stock get proportionally more space
 * 3. Group by sub-category when possible
 * 4. Respect physical constraints (product dimensions must fit)
 * 5. Fill shelves efficiently
 */
function generatePlanogram(project, products) {
  const shelfWidthCm = parseFloat(project.shelf_width);
  const shelfHeightCm = parseFloat(project.shelf_height);
  const numShelves = parseInt(project.num_shelves);
  const shelfDepthCm = parseFloat(project.shelf_depth) || 30;
  const shelfUnitHeight = shelfHeightCm / numShelves;

  // Score and calculate 3D placement for each product:
  //   facing (L) = products side-by-side on shelf front
  //   depth  (P) = products behind each facing (stock rows)
  //   stack  (H) = products stacked vertically
  const scored = products.map(p => {
    const pw = parseFloat(p.width);
    const ph = parseFloat(p.height);
    const pd = parseFloat(p.depth);
    const qty = parseInt(p.quantity) || 1;
    const priorityWeight = { high: 3, medium: 2, low: 1 }[p.priority] || 2;
    const stockWeight = Math.min(qty, 100) / 20;
    const score = priorityWeight * 2 + stockWeight;

    // Max depth units from shelf depth
    const maxDepth = Math.max(1, Math.floor(shelfDepthCm / pd));
    // Max stacking from shelf unit height (only stack if ≥2 fit)
    const maxStack = Math.max(1, Math.floor(shelfUnitHeight / ph));
    const stackUnits = maxStack >= 2 ? Math.min(maxStack, 2) : 1;

    // Base facing from priority
    const baseFacing = { high: 3, medium: 2, low: 1 }[p.priority] || 2;
    // Units one facing column can hold
    const unitsPerColumn = maxDepth * stackUnits;
    // Min facings to hold all stock
    const facingsNeeded = Math.ceil(qty / unitsPerColumn);
    // Cap: no product takes more than 40% of shelf width
    const maxFacingsByWidth = Math.max(1, Math.floor(shelfWidthCm * 0.4 / pw));
    const facings = Math.min(maxFacingsByWidth, Math.max(baseFacing, facingsNeeded));

    // Actual depth used per column
    const actualDepth = Math.min(maxDepth, Math.ceil(qty / (facings * stackUnits)));

    return {
      ...p, score, priorityWeight, pw, ph, pd,
      facings,
      depthUnits: Math.max(1, actualDepth),
      stackUnits,
      totalWidth: pw * facings,
      unitsPlaced: Math.min(qty, facings * actualDepth * stackUnits)
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // Eye-level shelves (middle band)
  const eyeLevelStart = Math.max(0, Math.floor(numShelves * 0.25));
  const eyeLevelEnd = Math.min(numShelves - 1, Math.ceil(numShelves * 0.65));

  const shelves = [];
  for (let i = 0; i < numShelves; i++) {
    shelves.push({
      index: i,
      isEyeLevel: i >= eyeLevelStart && i <= eyeLevelEnd,
      remainingWidth: shelfWidthCm,
      maxHeight: shelfUnitHeight,
      items: []
    });
  }

  const placed = [];
  const notPlaced = [];

  function placeProduct(product, preferredShelves, fallbackShelves) {
    if (product.pd > shelfDepthCm) {
      notPlaced.push({ ...product, reason: 'Produit trop profond pour le rayon' });
      return false;
    }
    const allShelves = [...preferredShelves, ...fallbackShelves];
    for (const shelf of allShelves) {
      if (product.ph * product.stackUnits > shelf.maxHeight) continue;
      const possibleFacings = Math.min(product.facings, Math.floor(shelf.remainingWidth / product.pw));
      if (possibleFacings <= 0) continue;

      const widthUsed = product.pw * possibleFacings;
      const itemUnits = Math.min(product.unitsPlaced, possibleFacings * product.depthUnits * product.stackUnits);

      shelf.items.push({
        id: product.id,
        product_id: product.id,
        name: product.name,
        facings: possibleFacings,
        depth: product.depthUnits,
        stack: product.stackUnits,
        width: product.pw,
        height: product.ph,
        totalWidth: widthUsed,
        priority: product.priority,
        quantity: parseInt(product.quantity),
        units_placed: itemUnits,
        sub_category: product.sub_category,
        // Stock enrichment flags (present when generated with stock context)
        _is_rupture: product._is_rupture || false,
        _is_surstock: product._is_surstock || false,
        _weekly_sales: product._weekly_sales || null,
        _stock_enriched: product._stock_enriched || false
      });

      shelf.remainingWidth -= widthUsed;
      placed.push({
        product_id: product.id,
        name: product.name,
        facings: possibleFacings,
        shelf_index: shelf.index,
        priority: product.priority
      });

      if (possibleFacings < product.facings) {
        const remaining = { ...product, facings: product.facings - possibleFacings };
        placeProduct(remaining, preferredShelves, fallbackShelves);
      }
      return true;
    }
    notPlaced.push({ ...product, reason: 'Pas d\'espace disponible sur le rayon' });
    return false;
  }

  // ── Phase 1: Distribute products across ALL shelves ─────────────────────
  // Instead of greedy fill, we ensure every shelf gets products.
  // Strategy: assign each product to a target shelf, spreading across all.

  const eyeLevel = shelves.filter(s => s.isEyeLevel);
  const nonEyeLevel = shelves.filter(s => !s.isEyeLevel);
  const highPriority = scored.filter(p => p.priority === 'high');
  const medPriority = scored.filter(p => p.priority === 'medium');
  const lowPriority = scored.filter(p => p.priority === 'low');

  // When we have fewer products than shelves, distribute each product across
  // multiple shelves so every shelf is filled (multiply facings to cover all shelves).
  const totalProducts = scored.length;
  const useDistribution = totalProducts <= numShelves;

  if (useDistribution && totalProducts > 0) {
    // Assign shelves to products round-robin, ensuring full coverage
    // Each product gets assigned to ceil(numShelves/numProducts) shelves
    const shelvesPerProduct = Math.ceil(numShelves / totalProducts);

    let shelfIdx = 0;
    scored.forEach(product => {
      const assignedCount = Math.min(shelvesPerProduct, numShelves - shelfIdx);
      for (let s = 0; s < assignedCount && shelfIdx < numShelves; s++) {
        const shelf = shelves[shelfIdx];
        // Calculate how many facings fit on this shelf
        const maxFacingsByWidth = Math.max(1, Math.floor(shelf.remainingWidth / product.pw));
        const possibleFacings = Math.max(1, maxFacingsByWidth);

        if (product.ph * product.stackUnits <= shelf.maxHeight && possibleFacings > 0) {
          const widthUsed = product.pw * possibleFacings;
          shelf.items.push({
            id: product.id,
            product_id: product.id,
            name: product.name,
            facings: possibleFacings,
            depth: product.depthUnits,
            stack: product.stackUnits,
            width: product.pw,
            height: product.ph,
            totalWidth: widthUsed,
            priority: product.priority,
            quantity: parseInt(product.quantity),
            units_placed: Math.min(parseInt(product.quantity) || 1, possibleFacings * product.depthUnits * product.stackUnits),
            sub_category: product.sub_category,
            _is_rupture: product._is_rupture || false,
            _is_surstock: product._is_surstock || false,
            _weekly_sales: product._weekly_sales || null,
            _stock_enriched: product._stock_enriched || false
          });
          shelf.remainingWidth -= widthUsed;
          placed.push({
            product_id: product.id,
            name: product.name,
            facings: possibleFacings,
            shelf_index: shelf.index,
            priority: product.priority
          });
        }
        shelfIdx++;
      }
    });

    // Fill any remaining empty shelves by repeating products round-robin
    for (let i = 0; i < numShelves; i++) {
      if (shelves[i].items.length === 0 && scored.length > 0) {
        const product = scored[i % scored.length];
        const maxFacings = Math.max(1, Math.floor(shelves[i].remainingWidth / product.pw));
        if (product.ph * product.stackUnits <= shelves[i].maxHeight && maxFacings > 0) {
          const widthUsed = product.pw * maxFacings;
          shelves[i].items.push({
            id: product.id,
            product_id: product.id,
            name: product.name,
            facings: maxFacings,
            depth: product.depthUnits,
            stack: product.stackUnits,
            width: product.pw,
            height: product.ph,
            totalWidth: widthUsed,
            priority: product.priority,
            quantity: parseInt(product.quantity),
            units_placed: maxFacings * product.depthUnits * product.stackUnits,
            sub_category: product.sub_category,
            _is_rupture: product._is_rupture || false,
            _is_surstock: product._is_surstock || false,
            _weekly_sales: product._weekly_sales || null,
            _stock_enriched: product._stock_enriched || false
          });
          shelves[i].remainingWidth -= widthUsed;
          placed.push({
            product_id: product.id,
            name: product.name,
            facings: maxFacings,
            shelf_index: i,
            priority: product.priority
          });
        }
      }
    }
  } else {
    // Original priority-based placement for many products
    highPriority.forEach(p => placeProduct(p, eyeLevel, nonEyeLevel));
    medPriority.forEach(p => placeProduct(p, shelves, []));
    lowPriority.forEach(p => placeProduct(p, nonEyeLevel, eyeLevel));

    // After standard placement, fill any empty shelves by cloning neighbors
    for (let i = 0; i < numShelves; i++) {
      if (shelves[i].items.length === 0) {
        // Find nearest non-empty shelf to clone from
        let donor = null;
        for (let d = 1; d < numShelves; d++) {
          if (i - d >= 0 && shelves[i - d].items.length > 0) { donor = shelves[i - d]; break; }
          if (i + d < numShelves && shelves[i + d].items.length > 0) { donor = shelves[i + d]; break; }
        }
        if (donor) {
          // Clone each product from donor to this empty shelf
          for (const src of donor.items) {
            const maxFacings = Math.max(1, Math.floor(shelves[i].remainingWidth / src.width));
            if (maxFacings > 0 && src.height * (src.stack || 1) <= shelves[i].maxHeight) {
              const widthUsed = src.width * maxFacings;
              shelves[i].items.push({
                ...src,
                facings: maxFacings,
                totalWidth: widthUsed
              });
              shelves[i].remainingWidth -= widthUsed;
              placed.push({
                product_id: src.product_id || src.id,
                name: src.name,
                facings: maxFacings,
                shelf_index: i,
                priority: src.priority
              });
            }
          }
        }
      }
    }
  }

  // ── Fill Pass: expand product facings to use all available shelf width ──────
  // Run even when shelves appear full — floating-point rounding can leave 0.5–2cm gaps.
  // No per-product cap — fill the entire shelf to maximize visual utilization.
  for (const shelf of shelves) {
    if (shelf.remainingWidth <= 0.5 || shelf.items.length === 0) continue;

    let remaining = shelf.remainingWidth;
    let iterations = 0;
    const maxIterations = 100; // Higher limit for aggressive fill

    while (remaining >= 0.5 && iterations < maxIterations) {
      iterations++;
      // Give one extra facing to the narrowest product (fills space fastest per iteration)
      let best = null;
      let bestWidth = Infinity;

      for (const item of shelf.items) {
        if (remaining >= item.width && item.width < bestWidth) {
          bestWidth = item.width;
          best = item;
        }
      }

      if (!best) break;

      best.facings++;
      best.totalWidth += best.width;
      shelf.remainingWidth -= best.width;
      remaining -= best.width;
    }
  }

  const totalUsedWidth = shelves.reduce((sum, s) => sum + (shelfWidthCm - s.remainingWidth), 0);
  const totalAvailableWidth = shelfWidthCm * numShelves;
  const utilization = Math.round((totalUsedWidth / totalAvailableWidth) * 100);
  const totalFacings = placed.reduce((sum, p) => sum + p.facings, 0);

  return {
    shelves: shelves.map(s => ({
      index: s.index,
      isEyeLevel: s.isEyeLevel,
      usedWidth: Math.round((shelfWidthCm - s.remainingWidth) * 100) / 100,
      totalWidth: shelfWidthCm,
      items: s.items
    })),
    summary: {
      total_products: products.length,
      products_placed: new Set(placed.map(p => p.product_id)).size,
      products_not_placed: notPlaced.length,
      total_facings: totalFacings,
      utilization_percent: utilization,
      not_placed: notPlaced.map(p => ({ name: p.name, reason: p.reason }))
    },
    dimensions: {
      shelf_width: shelfWidthCm,
      shelf_height: shelfHeightCm,
      shelf_depth: shelfDepthCm,
      num_shelves: numShelves,
      shelf_unit_height: Math.round(shelfUnitHeight * 100) / 100
    }
  };
}

// ========== AI SHELF ANALYSIS ==========

// Larger JSON limit for this route only (base64 images can be 300-500KB)
app.post('/api/analyze-shelf', express.json({ limit: '6mb' }), async (req, res) => {
  const { photo } = req.body;
  if (!photo || typeof photo !== 'string') {
    return res.status(400).json({ error: 'photo is required' });
  }

  // Strip data URL prefix if present, keep raw base64
  const base64Match = photo.match(/^data:image\/[^;]+;base64,(.+)$/);
  const imageBase64 = base64Match ? base64Match[1] : photo;
  const mimeType = base64Match
    ? photo.match(/^data:(image\/[^;]+);/)[1]
    : 'image/jpeg';

  // Hard timeout: abort after 15s
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    console.log('[AI shelf] Starting analysis, image size:', Math.round(imageBase64.length / 1024), 'KB');
    const openai = new OpenAI({ defaultHeaders: { 'x-polsia-task': 'shelf-dimension-analysis' } });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a shelf measurement assistant for pharmacy planogram software. Analyze this shelf photo and estimate dimensions in centimeters.

Return ONLY valid JSON with this exact structure, no other text:
{
  "width": <number, estimated shelf width in cm>,
  "height": <number, estimated total shelf unit height in cm>,
  "depth": <number, estimated shelf depth in cm, typically 30-50>,
  "num_shelves": <integer, count of shelf levels visible>,
  "shelf_type": "<string: gondola|wall|counter|other>",
  "confidence": "<string: high|medium|low>"
}

Typical pharmacy shelves: width 60-180cm, height 150-220cm, depth 30-50cm, 3-6 levels.
If you cannot determine a value reliably, use a typical pharmacy default.`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: 'low'
              }
            }
          ]
        }
      ]
    });

    clearTimeout(timeout);

    const raw = response.choices[0]?.message?.content || '';
    console.log('[AI shelf] Raw response:', raw.substring(0, 200));

    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('[AI shelf] JSON parse failed. Raw:', raw);
      return res.json({ ai_estimated: false });
    }

    // Validate and clamp values to sane ranges
    const width = Math.min(Math.max(parseFloat(parsed.width) || 0, 10), 1000);
    const height = Math.min(Math.max(parseFloat(parsed.height) || 0, 10), 500);
    const depth = Math.min(Math.max(parseFloat(parsed.depth) || 35, 5), 200);
    const num_shelves = Math.min(Math.max(parseInt(parsed.num_shelves) || 4, 2), 8);

    if (!width || !height) {
      console.warn('[AI shelf] Invalid dimensions after parsing:', parsed);
      return res.json({ ai_estimated: false });
    }

    console.log(`[AI shelf] Success: ${width}x${height}x${depth}cm, ${num_shelves} shelves`);
    res.json({
      ai_estimated: true,
      width,
      height,
      depth,
      num_shelves,
      shelf_type: parsed.shelf_type || 'gondola',
      confidence: parsed.confidence || 'medium'
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('[AI shelf] TIMEOUT after 15s — consider increasing timeout');
    } else {
      console.error('[AI shelf] ERROR:', err.message || err, err.status || '', err.code || '');
    }
    // Silent fallback — never block the wizard
    res.json({ ai_estimated: false });
  }
});

// ========== AI PRODUCT DETECTION ==========

app.post('/api/ai/detect-products', express.json({ limit: '6mb' }), async (req, res) => {
  const { photo, shelf_width, shelf_height, num_shelves, category } = req.body;
  if (!photo || typeof photo !== 'string') {
    return res.status(400).json({ error: 'photo is required' });
  }

  const base64Match = photo.match(/^data:image\/[^;]+;base64,(.+)$/);
  const imageBase64 = base64Match ? base64Match[1] : photo;
  const mimeType = base64Match
    ? photo.match(/^data:(image\/[^;]+);/)[1]
    : 'image/jpeg';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    console.log('[AI detect-products] Starting, image size:', Math.round(imageBase64.length / 1024), 'KB');
    const openai = new OpenAI({ defaultHeaders: { 'x-polsia-task': 'product-detection' } });

    const shelfWidthNum  = shelf_width  ? parseFloat(shelf_width)  : null;
    const shelfHeightNum = shelf_height ? parseFloat(shelf_height) : null;
    const numShelvesNum  = num_shelves  ? parseInt(num_shelves)    : null;
    const hasShelfDims   = shelfWidthNum && shelfHeightNum && numShelvesNum;
    const levelHeightCm  = hasShelfDims ? shelfHeightNum / numShelvesNum : null;

    const shelfCtx = hasShelfDims
      ? `The shelf is ${shelfWidthNum}cm wide, ${shelfHeightNum}cm tall total, with ${numShelvesNum} shelf levels (each level ≈${Math.round(levelHeightCm)}cm high).`
      : (shelf_width && num_shelves)
        ? `The shelf is approximately ${shelf_width}cm wide with ${num_shelves} levels.`
        : 'Estimate shelf dimensions from the photo.';
    const catCtx = category
      ? `This is a pharmacy shelf section for: ${category}.`
      : 'This is a pharmacy shelf.';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a pharmacy planogram assistant. Analyze this shelf photo and identify the individual products visible.

${shelfCtx} ${catCtx}

Return ONLY valid JSON with this exact structure, no other text:
{
  "products": [
    {
      "name": "<product name in French, generic, e.g. 'Paracétamol 500mg' or 'Sirop toux adulte'>",
      "estimated_count": <integer, number of this product visible>,
      "fraction_width": <decimal 0.01–1.0, what fraction of the TOTAL shelf width does this product box occupy? e.g. 0.08 means 8% of shelf width>,
      "fraction_height": <decimal 0.01–1.0, what fraction of ONE shelf level height does this product box occupy? e.g. 0.75 means 75% of the level height>,
      "depth_cm": <number, estimated box depth in cm front-to-back, typically 3-8 for pharmacy>,
      "shelf_level": <integer, shelf level from top starting at 1>
    }
  ]
}

Rules:
- fraction_width: visually estimate what % of the total shelf width this product takes (single facing)
- fraction_height: visually estimate what % of the shelf level height this product occupies
- Be conservative: 3-12 distinct product types max
- Use generic French pharmacy names
- If no products visible, return { "products": [] }`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: 'high'
              }
            }
          ]
        }
      ]
    });

    clearTimeout(timeout);

    const raw = response.choices[0]?.message?.content || '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('AI product detection: JSON parse failed:', raw.substring(0, 200));
      return res.json({ detected: false });
    }

    if (!Array.isArray(parsed.products)) {
      return res.json({ detected: false });
    }

    // Calibrate dimensions from fractions × known shelf dims, or fall back to typical defaults
    const rawProducts = parsed.products
      .filter(p => p.name && p.name.trim())
      .slice(0, 15)
      .map(p => {
        const fw = Math.min(Math.max(parseFloat(p.fraction_width)  || 0.07, 0.01), 1.0);
        const fh = Math.min(Math.max(parseFloat(p.fraction_height) || 0.65, 0.01), 1.0);
        const dc = Math.min(Math.max(parseFloat(p.depth_cm) || 4, 0.5), 30);

        let width, height, dimensions_source;
        if (hasShelfDims) {
          // Proportional calibration: fraction × actual shelf measurement
          width  = Math.round(fw * shelfWidthNum * 10) / 10;
          height = Math.round(fh * levelHeightCm  * 10) / 10;
          dimensions_source = 'ai_calibrated';
        } else {
          // No shelf dims: assume ~100cm wide shelf, ~22cm per level as defaults
          width  = Math.round(fw * 100 * 10) / 10;
          height = Math.round(fh * 22  * 10) / 10;
          dimensions_source = 'ai_estimate';
        }
        // Clamp to realistic pharmacy product range
        width  = Math.min(Math.max(width,  1), 50);
        height = Math.min(Math.max(height, 1), 50);

        return {
          name: String(p.name).trim().substring(0, 80),
          estimated_count: Math.min(Math.max(parseInt(p.estimated_count) || 1, 1), 200),
          width,
          height,
          depth: dc,
          shelf_level: Math.min(Math.max(parseInt(p.shelf_level) || 1, 1), 10),
          dimensions_source
        };
      });

    if (rawProducts.length === 0) {
      return res.json({ detected: false });
    }

    // Cross-reference with collaborative product catalog for verified dimensions
    const products = await Promise.all(rawProducts.map(async (p) => {
      try {
        // Search by significant words from the product name
        const words = p.name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        if (words.length === 0) return p;
        const searchTerm = words.slice(0, 2).join(' ');
        const catResult = await pool.query(
          `SELECT width, height, depth FROM product_catalog
           WHERE LOWER(name) LIKE $1 AND width IS NOT NULL AND height IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [`%${searchTerm}%`]
        );
        if (catResult.rows.length > 0) {
          const cat = catResult.rows[0];
          return {
            ...p,
            width:  Math.round(parseFloat(cat.width)  * 10) / 10,
            height: Math.round(parseFloat(cat.height) * 10) / 10,
            depth:  cat.depth ? Math.round(parseFloat(cat.depth) * 10) / 10 : p.depth,
            dimensions_source: 'community_verified'
          };
        }
      } catch (e) { /* silent — catalog lookup is best-effort */ }
      return p;
    }));

    const calibrated = products.filter(p => p.dimensions_source === 'ai_calibrated').length;
    const verified   = products.filter(p => p.dimensions_source === 'community_verified').length;
    console.log(`[AI detect-products] Found ${products.length} products (${calibrated} calibrated, ${verified} community-verified)`);
    res.json({ detected: true, products });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('[AI detect-products] TIMEOUT after 25s');
    } else {
      console.error('[AI detect-products] ERROR:', err.message || err, err.status || '', err.code || '');
    }
    res.json({ detected: false });
  }
});

// ========== EMAIL HELPER ==========

const TRIAL_DAYS = 7;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'shelfrx-admin-2026';

// Stripe checkout URLs for each plan (Polsia-managed subscriptions)
const STRIPE_CLASSIQUE_URL = 'https://buy.stripe.com/dRm3cvd2edKwgMM5KWdlA1M';
const STRIPE_PREMIUM_URL   = 'https://buy.stripe.com/dRm14n3rEcGs7ccgpAdlA1N';

async function sendEmail({ to, subject, html, text }) {
  const emailUrl = process.env.POLSIA_EMAIL_URL;
  const apiToken = process.env.POLSIA_API_TOKEN || process.env.POLSIA_API_KEY;
  if (!emailUrl && !apiToken) {
    console.log(`[email] SKIP (no endpoint configured) → ${to} — ${subject}`);
    return false;
  }
  try {
    const payload = JSON.stringify({
      to,
      subject,
      html,
      text: text || subject,
      from: 'ShelfRx <shelfrx@polsia.app>'
    });
    const baseUrl = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
    const endpoint = emailUrl || `${baseUrl}/api/company-email/send`;
    const url = new URL(endpoint);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    return new Promise((resolve) => {
      const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[email] Sent → ${to} — ${subject}`);
            resolve(true);
          } else {
            console.warn(`[email] Failed (${res.statusCode}) → ${to} — ${subject}: ${body.substring(0, 100)}`);
            resolve(false);
          }
        });
      });
      req.on('error', (err) => {
        console.warn(`[email] Error → ${to} — ${subject}: ${err.message}`);
        resolve(false);
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.warn(`[email] Exception → ${to}: ${err.message}`);
    return false;
  }
}

// ========== AUTH HELPERS ==========

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const candidate = scryptSync(password, salt, 64);
    return timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
  } catch {
    return false;
  }
}

function generateSessionToken() {
  return randomBytes(32).toString('hex');
}

async function createSession(userId) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
  await pool.query(
    `INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  return token;
}

function getSubscriptionStatus(user) {
  // Polsia may sync subscription_status from Stripe; also check trial
  if (!user) return 'expired';
  const now = new Date();

  // If active subscription
  if (user.subscription_status === 'active') return 'active';

  // Cancelled but still within paid period (access until period end)
  if ((user.subscription_status === 'cancelled' || user.subscription_status === 'canceled') &&
      user.subscription_expires_at && new Date(user.subscription_expires_at) > now) {
    return 'active'; // still has access until end of period
  }

  // Trial check (custom trial without credit card)
  if (user.trial_ends_at && new Date(user.trial_ends_at) > now) return 'trial';

  // Cancelled with expired period
  if (user.subscription_status === 'cancelled' || user.subscription_status === 'canceled') return 'cancelled';
  if (user.subscription_status === 'past_due') return 'past_due';

  return 'expired';
}

function getDaysLeft(user) {
  if (!user || !user.trial_ends_at) return 0;
  const diff = new Date(user.trial_ends_at) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ========== AUTH MIDDLEWARE ==========

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const result = await pool.query(
      `SELECT s.user_id, u.id, u.email, u.name, u.pharmacy_name, u.phone,
              u.trial_started_at, u.trial_ends_at,
              u.subscription_status, u.stripe_subscription_id,
              u.subscription_plan, u.subscription_expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = result.rows[0];
    req.subscriptionStatus = getSubscriptionStatus(req.user);
    req.daysLeft = getDaysLeft(req.user);
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Auth error' });
  }
}

function requireAdminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Admin access required' });
  next();
}

// ========== AUTH ROUTES ==========

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, pharmacy_name, phone, password } = req.body;
    if (!email || !password || !name || !pharmacy_name) {
      return res.status(400).json({ error: 'Email, mot de passe, nom et pharmacie requis' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
    }

    // Check existing
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    const password_hash = hashPassword(password);
    const trial_started_at = new Date();
    const trial_ends_at = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO users (email, name, pharmacy_name, phone, password_hash, trial_started_at, trial_ends_at, subscription_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'trial', NOW(), NOW()) RETURNING *`,
      [email.toLowerCase(), name, pharmacy_name, phone || null, password_hash, trial_started_at, trial_ends_at]
    );
    const user = result.rows[0];

    // Record event
    await pool.query(
      `INSERT INTO subscription_events (user_id, event_type, metadata) VALUES ($1, 'trial_started', $2)`,
      [user.id, JSON.stringify({ trial_ends_at, source: 'registration' })]
    );

    // Welcome email
    sendEmail({
      to: email,
      subject: `Bienvenue sur ShelfRx !`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #334155;">
          <div style="background: #0D9488; padding: 24px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">ShelfRx 🏥</h1>
          </div>
          <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
            <h2 style="color: #0f172a; margin-top: 0;">Bienvenue, ${name} !</h2>
            <p>Votre compte ShelfRx est maintenant actif pour <strong>${pharmacy_name}</strong>.</p>
            <p>Vous avez accès à toutes les fonctionnalités :</p>
            <ul style="line-height: 1.8;">
              <li>✅ Création de planogrammes illimitée</li>
              <li>✅ Import CSV / détection IA de produits</li>
              <li>✅ Export PDF/PNG</li>
              <li>✅ Partage par lien</li>
            </ul>
            <a href="https://shelfrx.polsia.app/app" style="display: inline-block; background: #0D9488; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 8px;">
              Créer mon premier planogramme →
            </a>
          </div>
        </div>
      `
    }).catch(() => {});

    const token = await createSession(user.id);
    res.json({
      token,
      user: {
        id: user.id, email: user.email, name: user.name,
        pharmacy_name: user.pharmacy_name, subscription_status: 'trial',
        trial_ends_at: user.trial_ends_at, days_left: TRIAL_DAYS
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const user = result.rows[0];
    if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const status = getSubscriptionStatus(user);
    const daysLeft = getDaysLeft(user);
    const token = await createSession(user.id);

    res.json({
      token,
      user: {
        id: user.id, email: user.email, name: user.name,
        pharmacy_name: user.pharmacy_name,
        subscription_status: status,
        trial_ends_at: user.trial_ends_at,
        days_left: daysLeft
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
  }
  res.json({ success: true });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    pharmacy_name: req.user.pharmacy_name,
    subscription_status: req.subscriptionStatus,
    subscription_plan: req.user.subscription_plan || null,
    trial_ends_at: req.user.trial_ends_at,
    days_left: req.daysLeft
  });
});

// ========== BILLING ROUTES ==========

// GET /api/billing/status — subscription status with paywall enforcement
app.get('/api/billing/status', requireAuth, (req, res) => {
  const status = req.subscriptionStatus;
  const canCreate = status === 'active' || status === 'trial';

  let banner = null;
  if (status === 'trial' && req.daysLeft <= 5) {
    banner = req.daysLeft <= 1
      ? `⚠️ Votre essai expire demain — activez votre abonnement pour conserver l'accès.`
      : `⚠️ Plus que ${req.daysLeft} jours d'essai — choisissez votre formule dès maintenant.`;
  }

  res.json({
    subscription_status: status,
    subscription_plan: req.user.subscription_plan || null,
    trial_ends_at: req.user.trial_ends_at,
    days_left: req.daysLeft,
    can_create: canCreate,
    banner,
    checkout_classique: STRIPE_CLASSIQUE_URL,
    checkout_premium: STRIPE_PREMIUM_URL
  });
});

// POST /api/webhooks/stripe — called by Stripe (or Polsia) when subscription changes
// Polsia auto-syncs subscription_status in users table; this is for explicit webhook handling
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    let event;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (webhookSecret) {
      // Verify Stripe signature if secret is configured
      const sig = req.headers['stripe-signature'];
      try {
        const stripe = require('stripe');
        const stripeClient = stripe(process.env.STRIPE_SECRET_KEY || '');
        event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.warn('[webhook] Stripe signature verification failed:', err.message);
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } else {
      // No secret configured — parse body directly (for Polsia-managed webhooks)
      const body = req.body instanceof Buffer ? req.body.toString() : JSON.stringify(req.body);
      try { event = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }

    const type = event.type || event.event_type;
    console.log(`[webhook] Stripe event: ${type}`);

    const customerId = event.data?.object?.customer || event.customer_id;
    const subscriptionId = event.data?.object?.id || event.subscription_id;

    if (type === 'customer.subscription.created' || type === 'invoice.payment_succeeded') {
      if (customerId) {
        // Detect plan from Stripe metadata or amount
        const obj = event.data?.object || {};
        const planName = obj.metadata?.plan || event.plan || null;
        const amount = obj.amount_paid || obj.amount || (obj.items?.data?.[0]?.price?.unit_amount);
        let detectedPlan = planName;
        if (!detectedPlan && amount) {
          // 7900 = 79.00, 9900 = 99.00 (Stripe uses cents)
          if (amount >= 9000) detectedPlan = 'premium';
          else detectedPlan = 'classique';
        }

        // Period end from subscription
        const periodEnd = obj.current_period_end
          ? new Date(obj.current_period_end * 1000)
          : null;

        await pool.query(
          `UPDATE users SET subscription_status = 'active',
           stripe_customer_id = COALESCE(stripe_customer_id, $1),
           stripe_subscription_id = COALESCE($2, stripe_subscription_id),
           subscription_plan = COALESCE($3, subscription_plan),
           subscription_expires_at = COALESCE($4, subscription_expires_at),
           updated_at = NOW()
           WHERE stripe_customer_id = $1 OR stripe_subscription_id = $2`,
          [customerId, subscriptionId, detectedPlan, periodEnd]
        );
        // Record event
        const user = await pool.query(`SELECT id FROM users WHERE stripe_customer_id = $1`, [customerId]);
        if (user.rows.length > 0) {
          await pool.query(
            `INSERT INTO subscription_events (user_id, event_type, metadata) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [user.rows[0].id, type, JSON.stringify({ ...obj, detected_plan: detectedPlan })]
          );
        }
      }
    }

    if (type === 'customer.subscription.deleted' || type === 'subscription_cancelled') {
      if (customerId || subscriptionId) {
        // Store period_end so user retains access until end of paid period
        const obj = event.data?.object || {};
        const periodEnd = obj.current_period_end
          ? new Date(obj.current_period_end * 1000)
          : null;
        await pool.query(
          `UPDATE users SET subscription_status = 'cancelled',
           subscription_expires_at = COALESCE($3, subscription_expires_at),
           updated_at = NOW()
           WHERE stripe_customer_id = $1 OR stripe_subscription_id = $2`,
          [customerId || '', subscriptionId || '', periodEnd]
        );
      }
    }

    if (type === 'invoice.payment_failed') {
      if (customerId) {
        await pool.query(
          `UPDATE users SET subscription_status = 'past_due', updated_at = NOW()
           WHERE stripe_customer_id = $1`,
          [customerId]
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] Error:', err);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// ========== ADMIN ROUTES ==========

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdminAuth, async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      newThisMonth,
      newThisWeek,
      recentUsers
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@polsia.internal'`),
      pool.query(`SELECT COUNT(*) FROM users WHERE created_at > $1 AND email NOT LIKE '%@polsia.internal'`, [thirtyDaysAgo]),
      pool.query(`SELECT COUNT(*) FROM users WHERE created_at > $1 AND email NOT LIKE '%@polsia.internal'`, [sevenDaysAgo]),
      pool.query(`
        SELECT id, email, name, pharmacy_name, subscription_status, trial_ends_at, created_at
        FROM users WHERE email NOT LIKE '%@polsia.internal'
        ORDER BY created_at DESC LIMIT 20
      `)
    ]);

    const total = parseInt(totalUsers.rows[0].count);

    res.json({
      total_registrations: total,
      new_this_month: parseInt(newThisMonth.rows[0].count),
      new_this_week: parseInt(newThisWeek.rows[0].count),
      recent_users: recentUsers.rows
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Stats error' });
  }
});

// ========== ANALYTICS ==========

// Track an analytics event (fire-and-forget POST)
app.post('/api/analytics/track', async (req, res) => {
  try {
    const { event_type, device_id, metadata } = req.body;
    const validTypes = [
      'page_view', 'wizard_started', 'wizard_completed',
      'planogram_saved', 'planogram_shared', 'planogram_exported',
      'ai_detection_used', 'shared_link_viewed'
    ];
    if (!event_type || !validTypes.includes(event_type)) {
      return res.status(400).json({ error: 'Invalid event_type' });
    }

    await pool.query(
      `INSERT INTO analytics_events (event_type, device_id, metadata) VALUES ($1, $2, $3)`,
      [event_type, device_id || null, JSON.stringify(metadata || {})]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Analytics track error:', err);
    // Never block the client — analytics must be non-blocking
    res.status(200).json({ success: true });
  }
});

// Get analytics summary (admin auth required)
app.get('/api/analytics/summary', requireAdminAuth, async (req, res) => {
  try {
    const { days = '7' } = req.query;
    const daysInt = Math.min(Math.max(parseInt(days) || 7, 1), 90);
    const since = new Date(Date.now() - daysInt * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `SELECT event_type, COUNT(*) as count,
              DATE(created_at) as date
       FROM analytics_events
       WHERE created_at >= $1
       GROUP BY event_type, DATE(created_at)
       ORDER BY date DESC, event_type ASC`,
      [since]
    );

    // Group by event_type for summary
    const summaryMap = {};
    result.rows.forEach(row => {
      if (!summaryMap[row.event_type]) {
        summaryMap[row.event_type] = 0;
      }
      summaryMap[row.event_type] += parseInt(row.count);
    });

    // Daily breakdown
    const dailyMap = {};
    result.rows.forEach(row => {
      const dateKey = row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10);
      if (!dailyMap[dateKey]) dailyMap[dateKey] = {};
      if (!dailyMap[dateKey][row.event_type]) dailyMap[dateKey][row.event_type] = 0;
      dailyMap[dateKey][row.event_type] += parseInt(row.count);
    });

    const daily = Object.keys(dailyMap)
      .sort()
      .slice(-daysInt)
      .map(date => ({ date, events: dailyMap[date] }));

    res.json({
      period_days: daysInt,
      total_events: Object.values(summaryMap).reduce((a, b) => a + b, 0),
      by_type: summaryMap,
      daily
    });
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Summary error' });
  }
});

// ========== STOCK ONBOARDING API ==========

// GET /api/stock/config — retrieve user's stock config + checklist state
app.get('/api/stock/config', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM stock_config WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('Stock config get error:', err);
    res.status(500).json({ error: 'Failed to get config' });
  }
});

// PUT /api/stock/config — save user's LGO selection + checklist state
app.put('/api/stock/config', requireAuth, async (req, res) => {
  try {
    const {
      software, connection_type,
      checklist_export_activated, checklist_agent_installed, checklist_test_success,
      notes
    } = req.body;

    const validSoftware = ['winpharma', 'lgpi', 'leo', 'autre'];
    const sw = validSoftware.includes(software) ? software : 'autre';
    const ct = connection_type || (sw === 'leo' ? 'csv' : 'pn13');

    const result = await pool.query(
      `INSERT INTO stock_config (user_id, software, connection_type,
         checklist_export_activated, checklist_agent_installed, checklist_test_success, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         software = EXCLUDED.software,
         connection_type = EXCLUDED.connection_type,
         checklist_export_activated = EXCLUDED.checklist_export_activated,
         checklist_agent_installed = EXCLUDED.checklist_agent_installed,
         checklist_test_success = EXCLUDED.checklist_test_success,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [req.user.id, sw, ct,
       checklist_export_activated || false,
       checklist_agent_installed || false,
       checklist_test_success || false,
       notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Stock config save error:', err);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// POST /api/stock/import — record a stock import (rows parsed client-side)
app.post('/api/stock/import', requireAuth, async (req, res) => {
  try {
    const { file_name, software, product_count, error_count, errors_json } = req.body;
    if (!file_name) return res.status(400).json({ error: 'file_name requis' });

    const validSoftware = ['winpharma', 'lgpi', 'leo', 'autre'];
    const sw = validSoftware.includes(software) ? software : 'autre';
    const pc = parseInt(product_count) || 0;
    const ec = parseInt(error_count) || 0;
    const status = ec === 0 ? 'success' : (pc === 0 ? 'error' : 'partial');

    const result = await pool.query(
      `INSERT INTO stock_imports (user_id, file_name, software, status, product_count, error_count, errors_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, file_name, software, status, product_count, error_count, imported_at`,
      [req.user.id, file_name, sw, status, pc, ec, JSON.stringify(errors_json || [])]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Stock import error:', err);
    res.status(500).json({ error: 'Failed to record import' });
  }
});

// GET /api/stock/imports — list import history for current user
app.get('/api/stock/imports', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, file_name, software, status, product_count, error_count, imported_at
       FROM stock_imports
       WHERE user_id = $1
       ORDER BY imported_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Stock imports list error:', err);
    res.status(500).json({ error: 'Failed to list imports' });
  }
});

// ========== PDF CATALOGUE IMPORT API ==========

// POST /api/stock/parse-pdf — parse PDF and return extracted products (no DB write)
app.post('/api/stock/parse-pdf', requireAuth, uploadPDF.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier PDF reçu' });

    let data;
    try {
      data = await pdfParse(req.file.buffer);
    } catch (parseErr) {
      console.error('PDF parse error:', parseErr);
      return res.status(422).json({ error: 'Impossible de lire ce PDF. Vérifiez qu\'il n\'est pas protégé par mot de passe.' });
    }

    const products = parseCataloguePDFText(data.text);

    if (products.length === 0) {
      return res.status(422).json({
        error: 'Aucun produit détecté dans ce PDF. Vérifiez que le fichier contient bien des colonnes Désignation et Code CIP (13 chiffres).',
        pages: data.numpages,
        text_preview: data.text.substring(0, 500)
      });
    }

    res.json({
      total: products.length,
      pages: data.numpages,
      preview: products.slice(0, 20),
      products  // full list — client will send back on confirm
    });
  } catch (err) {
    console.error('Parse PDF error:', err);
    res.status(500).json({ error: 'Erreur lors du parsing du PDF' });
  }
});

// POST /api/stock/import-pdf-data — upsert products into product_catalog + log import
app.post('/api/stock/import-pdf-data', requireAuth, async (req, res) => {
  try {
    const { products, file_name } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Liste de produits vide' });
    }
    if (!file_name) return res.status(400).json({ error: 'file_name requis' });

    let added = 0;
    let updated = 0;
    let errors = 0;
    const errorDetails = [];

    // Validate and deduplicate first
    const validProducts = [];
    const seenBarcodes = new Set();
    for (const p of products) {
      const barcode = String(p.barcode || '').replace(/\D/g, '');
      const name = String(p.name || '').trim().substring(0, 500); // Truncate to fit DB column
      if (!barcode || barcode.length < 10 || barcode.length > 13 || !name) {
        errors++;
        if (errorDetails.length < 50) errorDetails.push({ barcode, name, reason: 'Invalid data' });
        continue;
      }
      if (seenBarcodes.has(barcode)) continue; // deduplicate within upload
      seenBarcodes.add(barcode);
      validProducts.push({ barcode, name });
    }

    // Batch upsert — 100 rows per query to avoid parameter limits
    const BATCH_SIZE = 100;
    for (let i = 0; i < validProducts.length; i += BATCH_SIZE) {
      const batch = validProducts.slice(i, i + BATCH_SIZE);
      const params = [];
      const rows = batch.map((p, idx) => {
        const base = idx * 2;
        params.push(p.barcode, p.name);
        return `($${base + 1}, $${base + 2}, 'catalogue_pdf')`;
      });

      try {
        const result = await pool.query(
          `INSERT INTO product_catalog (barcode, name, source)
           VALUES ${rows.join(', ')}
           ON CONFLICT (barcode) DO UPDATE SET
             name = EXCLUDED.name,
             source = CASE WHEN product_catalog.source = 'community' THEN 'catalogue_pdf' ELSE product_catalog.source END
           RETURNING (xmax = 0) AS inserted`,
          params
        );
        for (const row of result.rows) {
          if (row.inserted) added++;
          else updated++;
        }

        // Also upsert to global catalog (collective enrichment — all pharmacies benefit)
        // Same batch, same params (barcode, name) — add 3rd param for source
        const gcParams = [];
        const gcRows = batch.map((p, idx) => {
          const base = idx * 3;
          gcParams.push(p.barcode, p.name, 'pdf_import');
          return `($${base + 1}, $${base + 2}, $${base + 3})`;
        });
        await pool.query(
          `INSERT INTO global_catalog (cip13, designation, source, updated_at)
           VALUES ${gcRows.join(', ')}
           ON CONFLICT (cip13) DO UPDATE SET
             designation = EXCLUDED.designation,
             source = CASE WHEN global_catalog.source IN ('community', 'barcode_scanned') THEN 'pdf_import' ELSE global_catalog.source END,
             updated_at = NOW()`,
          gcParams
        ).catch(gcErr => {
          console.error('[global-catalog] PDF batch upsert error (non-fatal):', gcErr.message);
        });
      } catch (batchErr) {
        console.error('Batch upsert error:', batchErr);
        errors += batch.length;
        if (errorDetails.length < 10) errorDetails.push({ reason: batchErr.message, batch_size: batch.length });
      }
    }

    // Log in stock_imports
    const status = errors === 0 ? 'success' : (added + updated === 0 ? 'error' : 'partial');
    await pool.query(
      `INSERT INTO stock_imports (user_id, file_name, software, status, product_count, error_count, errors_json)
       VALUES ($1, $2, 'catalogue_pdf', $3, $4, $5, $6)`,
      [req.user.id, file_name, status, added + updated, errors, JSON.stringify(errorDetails)]
    );

    res.json({ added, updated, errors, total: products.length });
  } catch (err) {
    console.error('Import PDF data error:', err);
    res.status(500).json({ error: 'Erreur lors de l\'import des produits' });
  }
});

// ========== AGENT PN13 API ==========

// GET /api/agent/key — get or create pharmacy agent record and return key
app.get('/api/agent/key', requireAuth, async (req, res) => {
  try {
    // Upsert: create agent record if it doesn't exist yet
    const result = await pool.query(
      `INSERT INTO pharmacy_agents (user_id, name, software)
       VALUES ($1, 'Agent principal', 'winpharma')
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, pharmacy_key, name, software, status, last_seen_at, last_event_at, events_total, created_at`,
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Agent key error:', err);
    res.status(500).json({ error: 'Failed to get agent key' });
  }
});

// GET /api/agent/status — get agent connection status for dashboard
app.get('/api/agent/status', requireAuth, async (req, res) => {
  try {
    const agentResult = await pool.query(
      `SELECT id, pharmacy_key, name, software, status, agent_version,
              last_seen_at, last_event_at, events_total, created_at
       FROM pharmacy_agents WHERE user_id = $1`,
      [req.user.id]
    );

    const agent = agentResult.rows[0] || null;
    if (!agent) {
      return res.json({ connected: false, agent: null, recent_events: [] });
    }

    // Determine live connection status: connected if last_seen_at < 2 minutes ago
    const isConnected = agent.last_seen_at &&
      (Date.now() - new Date(agent.last_seen_at).getTime()) < 2 * 60 * 1000;

    // Recent events (last 10)
    const eventsResult = await pool.query(
      `SELECT event_type, cip_code, quantity, label, occurred_at
       FROM stock_events WHERE user_id = $1
       ORDER BY occurred_at DESC LIMIT 10`,
      [req.user.id]
    );

    res.json({
      connected: isConnected,
      agent: {
        id: agent.id,
        name: agent.name,
        software: agent.software,
        status: isConnected ? 'connected' : (agent.last_seen_at ? 'disconnected' : 'pending'),
        agent_version: agent.agent_version,
        last_seen_at: agent.last_seen_at,
        last_event_at: agent.last_event_at,
        events_total: agent.events_total,
        created_at: agent.created_at
      },
      recent_events: eventsResult.rows
    });
  } catch (err) {
    console.error('Agent status error:', err);
    res.status(500).json({ error: 'Failed to get agent status' });
  }
});

// POST /api/agent/events — receive batch of PN13 events from local Windows agent
// Authentication: X-Pharmacy-Key header (UUID)
app.post('/api/agent/events', async (req, res) => {
  try {
    const pharmacyKey = req.headers['x-pharmacy-key'];
    if (!pharmacyKey) {
      return res.status(401).json({ error: 'X-Pharmacy-Key header required' });
    }

    // Look up agent by pharmacy key
    const agentResult = await pool.query(
      `SELECT id, user_id, software FROM pharmacy_agents WHERE pharmacy_key = $1`,
      [pharmacyKey]
    );
    if (agentResult.rows.length === 0) {
      return res.status(403).json({ error: 'Invalid pharmacy key' });
    }
    const agent = agentResult.rows[0];

    const { events, agent_version } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }

    const maxBatch = 200;
    const batch = events.slice(0, maxBatch);
    const validEventTypes = ['vente', 'reception', 'retour', 'inventaire', 'ajustement'];

    let accepted = 0;
    let rejected = 0;
    const updatedCips = new Set(); // CIP codes updated in this batch

    // Insert events in a transaction, updating stock_current in the same tx
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const ev of batch) {
        const eventType = validEventTypes.includes(ev.event_type) ? ev.event_type : null;
        if (!eventType) { rejected++; continue; }

        const cip = ev.cip_code ? String(ev.cip_code).replace(/[^0-9]/g, '').substring(0, 30) : null;
        if (!cip || cip.length < 7) { rejected++; continue; }

        const qty = (ev.quantity !== undefined && ev.quantity !== null) ? parseInt(ev.quantity, 10) : null;
        const occurredAt = ev.occurred_at ? new Date(ev.occurred_at) : new Date();
        if (isNaN(occurredAt.getTime())) { rejected++; continue; }

        const unitPrice = ev.unit_price_ht ? parseFloat(ev.unit_price_ht) : null;
        const label = ev.label ? String(ev.label).substring(0, 500) : null;
        const metadata = ev.metadata ? JSON.stringify(ev.metadata) : null;

        await client.query(
          `INSERT INTO stock_events
             (agent_id, user_id, event_type, cip_code, quantity, unit_price_ht, label,
              occurred_at, raw_xml, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [agent.id, agent.user_id, eventType, cip, qty,
           isNaN(unitPrice) ? null : unitPrice, label,
           occurredAt.toISOString(), ev.raw_xml || null, metadata]
        );
        accepted++;
        updatedCips.add(cip);

        // --- Update stock_current ---
        if (qty !== null && !isNaN(qty)) {
          if (eventType === 'inventaire') {
            // Absolute reset — inventaire is an authoritative count
            await client.query(
              `INSERT INTO stock_current (agent_id, cip_code, quantity_on_hand, label, last_updated, last_event_type)
               VALUES ($1, $2, $3, $4, NOW(), $5)
               ON CONFLICT (agent_id, cip_code) DO UPDATE
               SET quantity_on_hand = $3,
                   label = COALESCE($4, stock_current.label),
                   last_updated = NOW(),
                   last_event_type = $5`,
              [agent.id, cip, qty, label, eventType]
            );
          } else {
            // Delta update: vente/retour/reception/ajustement
            const delta = (eventType === 'vente') ? -qty : qty;
            const upsertResult = await client.query(
              `INSERT INTO stock_current (agent_id, cip_code, quantity_on_hand, label, last_updated, last_event_type)
               VALUES ($1, $2, $3, $4, NOW(), $5)
               ON CONFLICT (agent_id, cip_code) DO UPDATE
               SET quantity_on_hand = stock_current.quantity_on_hand + $3,
                   label = COALESCE($4, stock_current.label),
                   last_updated = NOW(),
                   last_event_type = $5
               RETURNING quantity_on_hand`,
              [agent.id, cip, delta, label, eventType]
            );

            const newQty = upsertResult.rows[0]?.quantity_on_hand;

            // --- Anomaly detection ---
            // Negative stock after vente
            if (typeof newQty === 'number' && newQty < 0) {
              await client.query(
                `INSERT INTO stock_anomalies (agent_id, cip_code, anomaly_type, quantity, description)
                 VALUES ($1, $2, 'stock_negatif', $3, $4)`,
                [agent.id, cip, newQty,
                 `Stock négatif (${newQty}) après ${eventType} de ${qty} unités`]
              );
            }
            // Suspiciously large single movement (> 500 units)
            if (eventType === 'vente' && qty > 500) {
              await client.query(
                `INSERT INTO stock_anomalies (agent_id, cip_code, anomaly_type, quantity, description)
                 VALUES ($1, $2, 'mouvement_suspect', $3, $4)`,
                [agent.id, cip, qty,
                 `Vente de ${qty} unités en une seule transaction — mouvement inhabituel`]
              );
            }
          }
        }
      }

      // Update agent heartbeat and counters
      await client.query(
        `UPDATE pharmacy_agents
         SET last_seen_at = NOW(),
             last_event_at = CASE WHEN $2 > 0 THEN NOW() ELSE last_event_at END,
             events_total = events_total + $2,
             agent_version = COALESCE($3, agent_version),
             status = 'active',
             updated_at = NOW()
         WHERE id = $1`,
        [agent.id, accepted, agent_version || null]
      );

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // --- Real-time broadcast to WebSocket subscribers ---
    if (accepted > 0 && wsClients.has(agent.id)) {
      try {
        const snapshot = await pool.query(
          `SELECT cip_code, quantity_on_hand, label, last_updated, last_event_type
           FROM stock_current WHERE agent_id = $1 AND cip_code = ANY($2)`,
          [agent.id, Array.from(updatedCips)]
        );
        broadcastStockUpdate(agent.id, {
          type: 'stock_update',
          agent_id: agent.id,
          timestamp: new Date().toISOString(),
          updated: snapshot.rows
        });
      } catch (wsErr) {
        console.warn('[ws] Broadcast failed:', wsErr.message);
      }
    }

    // --- Alert evaluation (fire-and-forget — doesn't block response) ---
    if (accepted > 0 && updatedCips.size > 0) {
      evaluateStockAlerts(agent.id, agent.user_id, updatedCips).catch(() => {});
    }

    console.log(`[agent] Received batch: ${accepted} accepted, ${rejected} rejected (agent ${agent.id})`);
    res.json({ accepted, rejected, total: batch.length });
  } catch (err) {
    console.error('Agent events error:', err);
    res.status(500).json({ error: 'Failed to process events' });
  }
});

// POST /api/agent/heartbeat — lightweight ping from agent (no events)
// Updates last_seen_at without requiring an event batch
app.post('/api/agent/heartbeat', async (req, res) => {
  try {
    const pharmacyKey = req.headers['x-pharmacy-key'];
    if (!pharmacyKey) return res.status(401).json({ error: 'X-Pharmacy-Key required' });

    const result = await pool.query(
      `UPDATE pharmacy_agents
       SET last_seen_at = NOW(), status = 'active', updated_at = NOW(),
           agent_version = COALESCE($2, agent_version)
       WHERE pharmacy_key = $1
       RETURNING id`,
      [pharmacyKey, req.body?.agent_version || null]
    );

    if (result.rows.length === 0) return res.status(403).json({ error: 'Invalid pharmacy key' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Agent heartbeat error:', err);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// ========== PAGE ROUTES ==========

// Register page
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Billing page — plan selection & subscription activation
app.get('/billing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'billing.html'));
});

// Billing success — Stripe redirect after subscription
app.get('/billing/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'billing.html'));
});

// Pricing page
app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// Admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Landing page
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'ShelfRx' });
  }
});

// App page (the builder)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// My Planograms dashboard
app.get('/app/planograms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'planograms.html'));
});

// Analytics dashboard
app.get('/app/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});

// Shared planogram view
app.get('/app/planogram/:shareId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'shared.html'));
});

// Stock onboarding page
app.get('/app/stock', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stock.html'));
});

// ========== STOCK QUERY API ==========

// Helper: verify caller owns the given agent
async function resolveAgent(userId, agentId) {
  const result = await pool.query(
    `SELECT id FROM pharmacy_agents WHERE id = $1 AND user_id = $2`,
    [agentId, userId]
  );
  return result.rows[0] || null;
}

// ========== STOCK WIZARD INTEGRATION API ==========

// GET /api/stock/wizard-context — returns agent status + stock snapshot with weekly sales rates
// Used by the planogram wizard Step 4 to pre-fill products and enrich with real-time stock data
app.get('/api/stock/wizard-context', requireAuth, async (req, res) => {
  try {
    // Find agent for this user
    const agentResult = await pool.query(
      `SELECT id, last_seen_at, created_at FROM pharmacy_agents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    if (agentResult.rows.length === 0) {
      return res.json({ connected: false, agent: null, products: [], last_sync: null });
    }

    const agent = agentResult.rows[0];
    const lastSeen = agent.last_seen_at ? new Date(agent.last_seen_at) : null;
    const isOnline = lastSeen && (Date.now() - lastSeen.getTime()) < 2 * 60 * 1000; // online if seen < 2min ago
    const isConnected = lastSeen !== null; // has ever synced

    if (!isConnected) {
      return res.json({ connected: false, agent: { id: agent.id }, products: [], last_sync: null });
    }

    // Get current stock snapshot
    const stockResult = await pool.query(
      `SELECT cip_code, quantity_on_hand, label, last_updated, last_event_type
       FROM stock_current
       WHERE agent_id = $1
       ORDER BY quantity_on_hand DESC`,
      [agent.id]
    );

    // Get weekly sales rate per product (last 4 weeks)
    const salesResult = await pool.query(
      `SELECT cip_code,
              ROUND(SUM(ABS(quantity))::numeric / 4, 1) AS weekly_sales
       FROM stock_events
       WHERE agent_id = $1
         AND event_type = 'vente'
         AND occurred_at >= NOW() - INTERVAL '28 days'
       GROUP BY cip_code`,
      [agent.id]
    );

    // Get anomalies (unresolved)
    const anomaliesResult = await pool.query(
      `SELECT cip_code, anomaly_type, quantity, detected_at
       FROM stock_anomalies
       WHERE agent_id = $1 AND resolved = FALSE
       ORDER BY detected_at DESC`,
      [agent.id]
    );

    // Build sales rate map
    const salesMap = {};
    salesResult.rows.forEach(r => { salesMap[r.cip_code] = parseFloat(r.weekly_sales); });

    // Build anomaly map
    const anomalyMap = {};
    anomaliesResult.rows.forEach(r => {
      if (!anomalyMap[r.cip_code]) anomalyMap[r.cip_code] = [];
      anomalyMap[r.cip_code].push(r.anomaly_type);
    });

    // Enrich products with sales + anomaly data
    const products = stockResult.rows.map(p => ({
      cip_code: p.cip_code,
      label: p.label,
      quantity_on_hand: parseInt(p.quantity_on_hand) || 0,
      weekly_sales: salesMap[p.cip_code] || 0,
      last_updated: p.last_updated,
      last_event_type: p.last_event_type,
      anomalies: anomalyMap[p.cip_code] || [],
      // Derived flags
      is_rupture: (parseInt(p.quantity_on_hand) || 0) <= 0,
      is_surstock: salesMap[p.cip_code] > 0 && (parseInt(p.quantity_on_hand) || 0) > salesMap[p.cip_code] * 8, // >8 weeks stock
      rotation_score: salesMap[p.cip_code] || 0 // higher = faster moving
    }));

    res.json({
      connected: true,
      is_online: isOnline,
      agent: { id: agent.id },
      last_sync: agent.last_seen_at,
      products,
      total: products.length,
      ruptures: products.filter(p => p.is_rupture).length,
      surstocks: products.filter(p => p.is_surstock).length
    });

  } catch (err) {
    console.error('Stock wizard context error:', err);
    res.status(500).json({ error: 'Failed to fetch stock context' });
  }
});

// GET /api/stock/current/:agent_id — current stock per product
app.get('/api/stock/current/:agent_id', requireAuth, async (req, res) => {
  try {
    const agent = await resolveAgent(req.user.id, req.params.agent_id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const result = await pool.query(
      `SELECT cip_code, quantity_on_hand, label, last_updated, last_event_type
       FROM stock_current
       WHERE agent_id = $1
       ORDER BY last_updated DESC`,
      [agent.id]
    );
    res.json({ agent_id: agent.id, products: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Stock current error:', err);
    res.status(500).json({ error: 'Failed to fetch current stock' });
  }
});

// GET /api/stock/movements/:agent_id — movement history with optional filters
// Query params: ?from=ISO&to=ISO&cip=CIP13&type=vente|reception|...&limit=100&offset=0
app.get('/api/stock/movements/:agent_id', requireAuth, async (req, res) => {
  try {
    const agent = await resolveAgent(req.user.id, req.params.agent_id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { from, to, cip, type, limit = 100, offset = 0 } = req.query;
    const validTypes = ['vente', 'reception', 'retour', 'inventaire', 'ajustement'];
    const lim = Math.min(Math.max(1, parseInt(limit, 10) || 100), 500);
    const off = Math.max(0, parseInt(offset, 10) || 0);

    const conditions = ['se.agent_id = $1'];
    const params = [agent.id];

    if (from) { params.push(new Date(from).toISOString()); conditions.push(`se.occurred_at >= $${params.length}`); }
    if (to)   { params.push(new Date(to).toISOString());   conditions.push(`se.occurred_at <= $${params.length}`); }
    if (cip)  { params.push(String(cip).replace(/[^0-9]/g, '').substring(0, 30)); conditions.push(`se.cip_code = $${params.length}`); }
    if (type && validTypes.includes(type)) { params.push(type); conditions.push(`se.event_type = $${params.length}`); }

    const where = conditions.join(' AND ');

    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT se.id, se.event_type, se.cip_code, se.quantity, se.unit_price_ht,
                se.label, se.occurred_at, se.received_at
         FROM stock_events se
         WHERE ${where}
         ORDER BY se.occurred_at DESC
         LIMIT ${lim} OFFSET ${off}`,
        params
      ),
      pool.query(`SELECT COUNT(*) FROM stock_events se WHERE ${where}`, params)
    ]);

    res.json({
      agent_id: agent.id,
      movements: rowsResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      limit: lim,
      offset: off
    });
  } catch (err) {
    console.error('Stock movements error:', err);
    res.status(500).json({ error: 'Failed to fetch movements' });
  }
});

// GET /api/stock/analytics/:agent_id — aggregated sales/day and top products
// Query params: ?period=7|30|90 (days, default 30)
app.get('/api/stock/analytics/:agent_id', requireAuth, async (req, res) => {
  try {
    const agent = await resolveAgent(req.user.id, req.params.agent_id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const period = Math.min(Math.max(1, parseInt(req.query.period, 10) || 30), 365);

    const [dailyResult, topResult, weeklyResult] = await Promise.all([
      // Sales per day
      pool.query(
        `SELECT DATE(occurred_at) AS day,
                SUM(CASE WHEN event_type = 'vente' THEN ABS(quantity) ELSE 0 END) AS units_sold,
                COUNT(CASE WHEN event_type = 'vente' THEN 1 END) AS transactions,
                SUM(CASE WHEN event_type = 'reception' THEN quantity ELSE 0 END) AS units_received
         FROM stock_events
         WHERE agent_id = $1
           AND occurred_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY DATE(occurred_at)
         ORDER BY day DESC`,
        [agent.id, period]
      ),
      // Top 20 products by units sold
      pool.query(
        `SELECT cip_code,
                MAX(label) AS label,
                SUM(ABS(quantity)) AS units_sold,
                COUNT(*) AS transactions
         FROM stock_events
         WHERE agent_id = $1
           AND event_type = 'vente'
           AND occurred_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY cip_code
         ORDER BY units_sold DESC
         LIMIT 20`,
        [agent.id, period]
      ),
      // Sales per week
      pool.query(
        `SELECT DATE_TRUNC('week', occurred_at) AS week_start,
                SUM(ABS(quantity)) AS units_sold
         FROM stock_events
         WHERE agent_id = $1
           AND event_type = 'vente'
           AND occurred_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY DATE_TRUNC('week', occurred_at)
         ORDER BY week_start DESC`,
        [agent.id, period]
      )
    ]);

    res.json({
      agent_id: agent.id,
      period_days: period,
      daily: dailyResult.rows,
      weekly: weeklyResult.rows,
      top_products: topResult.rows
    });
  } catch (err) {
    console.error('Stock analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// GET /api/stock/anomalies/:agent_id — detected anomalies
// Query params: ?resolved=true|false (default: false)
app.get('/api/stock/anomalies/:agent_id', requireAuth, async (req, res) => {
  try {
    const agent = await resolveAgent(req.user.id, req.params.agent_id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const showResolved = req.query.resolved === 'true';
    const result = await pool.query(
      `SELECT id, cip_code, anomaly_type, quantity, description, detected_at, resolved, resolved_at
       FROM stock_anomalies
       WHERE agent_id = $1 AND resolved = $2
       ORDER BY detected_at DESC
       LIMIT 200`,
      [agent.id, showResolved]
    );
    res.json({ agent_id: agent.id, anomalies: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Stock anomalies error:', err);
    res.status(500).json({ error: 'Failed to fetch anomalies' });
  }
});

// PATCH /api/stock/anomalies/:agent_id/:anomaly_id/resolve — mark anomaly resolved
app.patch('/api/stock/anomalies/:agent_id/:anomaly_id/resolve', requireAuth, async (req, res) => {
  try {
    const agent = await resolveAgent(req.user.id, req.params.agent_id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const result = await pool.query(
      `UPDATE stock_anomalies
       SET resolved = TRUE, resolved_at = NOW()
       WHERE id = $1 AND agent_id = $2
       RETURNING id, resolved, resolved_at`,
      [req.params.anomaly_id, agent.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Anomaly not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Resolve anomaly error:', err);
    res.status(500).json({ error: 'Failed to resolve anomaly' });
  }
});

// ========== STOCK ALERT ENGINE ==========

/**
 * Evaluate stock thresholds for updated CIP codes and fire alerts.
 * Called asynchronously after each stock batch — never blocks the response.
 *
 * Dedup logic: an alert fires only once per crossing. It resets after the
 * quantity crosses back above the threshold (+20% hysteresis buffer).
 */
async function evaluateStockAlerts(agentId, userId, updatedCips) {
  if (!updatedCips || updatedCips.size === 0) return;
  try {
    // Fetch current stock for updated CIPs
    const stockRows = await pool.query(
      `SELECT cip_code, quantity_on_hand, label FROM stock_current
       WHERE agent_id = $1 AND cip_code = ANY($2)`,
      [agentId, Array.from(updatedCips)]
    );
    if (stockRows.rows.length === 0) return;

    // Load thresholds for this user — product-specific overrides first, then global
    const thresholdRows = await pool.query(
      `SELECT cip_code, rupture_qty, surstock_qty FROM stock_alert_thresholds
       WHERE user_id = $1 AND enabled = TRUE`,
      [userId]
    );
    const thresholdMap = {}; // cip_code -> { rupture_qty, surstock_qty }
    let globalThreshold = { rupture_qty: 5, surstock_qty: 200 };
    for (const t of thresholdRows.rows) {
      if (t.cip_code === null) {
        globalThreshold = { rupture_qty: t.rupture_qty, surstock_qty: t.surstock_qty };
      } else {
        thresholdMap[t.cip_code] = { rupture_qty: t.rupture_qty, surstock_qty: t.surstock_qty };
      }
    }

    // Load existing dedup state for these CIPs
    const dedupRows = await pool.query(
      `SELECT cip_code, alert_type, last_qty FROM alert_dedup_state
       WHERE user_id = $1 AND cip_code = ANY($2)`,
      [userId, Array.from(updatedCips)]
    );
    const dedupMap = {}; // `${cip}_${type}` -> last_qty
    for (const d of dedupRows.rows) {
      dedupMap[`${d.cip_code}_${d.alert_type}`] = d.last_qty;
    }

    const alertsToCreate = [];
    const dedupUpdates = [];

    for (const row of stockRows.rows) {
      const { cip_code, quantity_on_hand: qty, label } = row;
      const thresh = thresholdMap[cip_code] || globalThreshold;

      // ---- RUPTURE check ----
      const ruptureKey = `${cip_code}_rupture`;
      if (qty <= thresh.rupture_qty) {
        const prevQty = dedupMap[ruptureKey];
        const alreadyAlerting = prevQty !== undefined && prevQty <= thresh.rupture_qty;
        if (!alreadyAlerting) {
          // New crossing — fire alert
          const priority = qty <= 0 ? 'critical' : (qty <= Math.ceil(thresh.rupture_qty / 2) ? 'critical' : 'warning');
          const alertType = qty <= 0 ? 'rupture' : 'rupture_imminente';
          alertsToCreate.push({ cip_code, label, alert_type: alertType, priority, quantity: qty, threshold_qty: thresh.rupture_qty });
          dedupUpdates.push({ cip_code, alert_type: 'rupture', qty });
        } else {
          // Still in alert zone, just update last_qty
          dedupUpdates.push({ cip_code, alert_type: 'rupture', qty });
        }
      } else {
        // Above threshold (or back above with hysteresis) — clear dedup if was alerting
        if (dedupMap[ruptureKey] !== undefined && dedupMap[ruptureKey] <= thresh.rupture_qty) {
          // Reset: quantity crossed back above threshold
          dedupUpdates.push({ cip_code, alert_type: 'rupture', qty });
        }
      }

      // ---- SURSTOCK check ----
      const surstockKey = `${cip_code}_surstock`;
      if (qty >= thresh.surstock_qty) {
        const prevQty = dedupMap[surstockKey];
        const alreadyAlerting = prevQty !== undefined && prevQty >= thresh.surstock_qty;
        if (!alreadyAlerting) {
          alertsToCreate.push({ cip_code, label, alert_type: 'surstock', priority: 'info', quantity: qty, threshold_qty: thresh.surstock_qty });
          dedupUpdates.push({ cip_code, alert_type: 'surstock', qty });
        } else {
          dedupUpdates.push({ cip_code, alert_type: 'surstock', qty });
        }
      } else {
        if (dedupMap[surstockKey] !== undefined && dedupMap[surstockKey] >= thresh.surstock_qty) {
          dedupUpdates.push({ cip_code, alert_type: 'surstock', qty });
        }
      }
    }

    // Persist new alerts
    const createdAlerts = [];
    for (const a of alertsToCreate) {
      const inserted = await pool.query(
        `INSERT INTO stock_alerts
           (user_id, agent_id, cip_code, label, alert_type, priority, quantity, threshold_qty)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, alert_type, priority, quantity, label, cip_code, triggered_at`,
        [userId, agentId, a.cip_code, a.label, a.alert_type, a.priority, a.quantity, a.threshold_qty]
      );
      createdAlerts.push(inserted.rows[0]);
    }

    // Upsert dedup state
    for (const d of dedupUpdates) {
      await pool.query(
        `INSERT INTO alert_dedup_state (user_id, cip_code, alert_type, last_qty, last_triggered_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, cip_code, alert_type) DO UPDATE
         SET last_qty = $4, last_triggered_at = NOW()`,
        [userId, d.cip_code, d.alert_type, d.qty]
      );
    }

    // Send immediate email/SMS for critical alerts
    if (createdAlerts.length > 0) {
      const criticals = createdAlerts.filter(a => a.priority === 'critical');
      if (criticals.length > 0) {
        // Fire-and-forget — don't await
        sendCriticalAlertNotifications(userId, criticals).catch(() => {});
      }
    }

    if (createdAlerts.length > 0) {
      console.log(`[alerts] Created ${createdAlerts.length} alert(s) for user ${userId}`);
    }
  } catch (err) {
    console.warn('[alerts] Evaluation error:', err.message);
  }
}

/**
 * Send immediate email + optional SMS for critical stock alerts.
 */
async function sendCriticalAlertNotifications(userId, criticalAlerts) {
  // Load user email settings and contact info
  const userResult = await pool.query(
    `SELECT u.email, u.name, u.pharmacy_name,
            COALESCE(s.email_critical, TRUE) AS email_critical,
            COALESCE(s.sms_enabled, FALSE) AS sms_enabled,
            s.phone_number
     FROM users u
     LEFT JOIN user_alert_settings s ON s.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return;

  // Email for criticals
  if (user.email_critical) {
    const rows = criticalAlerts.map(a => {
      const icon = a.alert_type === 'rupture' ? '🔴' : '🟠';
      const msg = a.alert_type === 'rupture'
        ? `Rupture de stock (${a.quantity} unités)`
        : `Rupture imminente (${a.quantity} unités restantes)`;
      return `<tr>
        <td style="padding:0.6rem 0.75rem; border-bottom:1px solid #e2e8f0;">${icon} <strong>${a.label || a.cip_code}</strong></td>
        <td style="padding:0.6rem 0.75rem; border-bottom:1px solid #e2e8f0; color:#64748b; font-size:0.82rem;">${a.cip_code}</td>
        <td style="padding:0.6rem 0.75rem; border-bottom:1px solid #e2e8f0; color:#ef4444; font-weight:600;">${msg}</td>
      </tr>`;
    }).join('');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #334155;">
        <div style="background: #ef4444; padding: 24px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 20px;">⚠️ Alerte stock critique — ShelfRx</h1>
        </div>
        <div style="background: #f8fafc; padding: 28px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
          <p style="margin-top:0;">Bonjour ${user.name || 'Pharmacien(ne)'},</p>
          <p>Des alertes critiques ont été détectées sur votre stock :</p>
          <table style="width:100%; border-collapse:collapse; margin-top:1rem; background:white; border-radius:8px; overflow:hidden; border:1px solid #e2e8f0;">
            <thead>
              <tr style="background:#fef2f2;">
                <th style="padding:0.6rem 0.75rem; text-align:left; font-size:0.8rem; color:#64748b;">Produit</th>
                <th style="padding:0.6rem 0.75rem; text-align:left; font-size:0.8rem; color:#64748b;">CIP</th>
                <th style="padding:0.6rem 0.75rem; text-align:left; font-size:0.8rem; color:#64748b;">Statut</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:1.5rem; text-align:center;">
            <a href="https://shelfrx.polsia.app/app/alerts" style="display:inline-block; background:#0D9488; color:white; padding:10px 24px; border-radius:8px; text-decoration:none; font-weight:600; font-size:0.9rem;">Voir toutes mes alertes →</a>
          </div>
          <p style="font-size:0.75rem; color:#94a3b8; margin-top:1.5rem;">Vous recevez cet email car vous avez activé les alertes critiques dans ShelfRx. <a href="https://shelfrx.polsia.app/app/alerts" style="color:#0D9488;">Gérer mes alertes</a></p>
        </div>
      </div>
    `;

    const sent = await sendEmail({
      to: user.email,
      subject: `🔴 Alerte stock critique — ${criticalAlerts.length} produit(s) en rupture`,
      html
    });

    if (sent) {
      // Mark alerts as email_sent
      const ids = criticalAlerts.map(a => a.id);
      await pool.query(
        `UPDATE stock_alerts SET email_sent = TRUE WHERE id = ANY($1)`,
        [ids]
      );
    }
  }

  // SMS for criticals if user opted in
  if (user.sms_enabled && user.phone_number) {
    await sendSmsAlert(user.phone_number, criticalAlerts).catch(() => {});
  }
}

/**
 * Send SMS via Twilio for critical alerts.
 */
async function sendSmsAlert(phoneNumber, alerts) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;
  if (!twilioSid || !twilioToken || !twilioFrom) {
    console.warn('[sms] Twilio not configured — skip SMS');
    return false;
  }

  const productList = alerts.slice(0, 3).map(a => a.label || a.cip_code).join(', ');
  const more = alerts.length > 3 ? ` (+${alerts.length - 3} autres)` : '';
  const body = `ShelfRx ALERTE: Rupture imminente sur ${productList}${more}. Vérifiez votre stock sur shelfrx.polsia.app/app/alerts`;

  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
  const payload = new URLSearchParams({ To: phoneNumber, From: twilioFrom, Body: body }).toString();

  return new Promise((resolve) => {
    const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      port: 443,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[sms] Sent to ${phoneNumber}`);
          resolve(true);
        } else {
          console.warn(`[sms] Failed (${res.statusCode}): ${body.substring(0, 100)}`);
          resolve(false);
        }
      });
    });
    req.on('error', (err) => { console.warn('[sms] Error:', err.message); resolve(false); });
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

// ========== STOCK ALERT API ==========

// GET /api/alerts — list user's alerts (paginated)
app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const unreadOnly = req.query.unread === 'true';

    const whereClause = unreadOnly ? 'AND read = FALSE' : '';
    const result = await pool.query(
      `SELECT id, cip_code, label, alert_type, priority, quantity, threshold_qty,
              read, email_sent, sms_sent, triggered_at
       FROM stock_alerts
       WHERE user_id = $1 ${whereClause}
       ORDER BY triggered_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE read = FALSE) AS unread
       FROM stock_alerts WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({
      alerts: result.rows,
      total: parseInt(countResult.rows[0].total),
      unread: parseInt(countResult.rows[0].unread),
      limit,
      offset
    });
  } catch (err) {
    console.error('List alerts error:', err);
    res.status(500).json({ error: 'Failed to list alerts' });
  }
});

// GET /api/alerts/count — badge count (unread only)
app.get('/api/alerts/count', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS unread FROM stock_alerts WHERE user_id = $1 AND read = FALSE`,
      [req.user.id]
    );
    res.json({ unread: parseInt(result.rows[0].unread) });
  } catch (err) {
    console.error('Alert count error:', err);
    res.status(500).json({ error: 'Failed to count alerts' });
  }
});

// PATCH /api/alerts/read-all — mark all as read (must come BEFORE /:id/read to avoid route conflict)
app.patch('/api/alerts/read-all', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE stock_alerts SET read = TRUE WHERE user_id = $1 AND read = FALSE`,
      [req.user.id]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

// PATCH /api/alerts/:id/read — mark single alert as read
app.patch('/api/alerts/:id/read', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE stock_alerts SET read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id, read`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alert not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// GET /api/alerts/thresholds — list thresholds for current user
app.get('/api/alerts/thresholds', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, cip_code, label, rupture_qty, surstock_qty, enabled, updated_at
       FROM stock_alert_thresholds
       WHERE user_id = $1
       ORDER BY cip_code NULLS FIRST`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List thresholds error:', err);
    res.status(500).json({ error: 'Failed to list thresholds' });
  }
});

// PUT /api/alerts/thresholds — upsert a threshold (cip_code null = global)
app.put('/api/alerts/thresholds', requireAuth, async (req, res) => {
  try {
    const { cip_code, label, rupture_qty, surstock_qty, enabled } = req.body;
    const ruptureInt = parseInt(rupture_qty);
    const surstockInt = parseInt(surstock_qty);
    if (isNaN(ruptureInt) || isNaN(surstockInt) || ruptureInt < 0 || surstockInt < 0) {
      return res.status(400).json({ error: 'rupture_qty and surstock_qty must be non-negative integers' });
    }
    if (ruptureInt >= surstockInt) {
      return res.status(400).json({ error: 'rupture_qty must be less than surstock_qty' });
    }

    const cip = cip_code ? String(cip_code).replace(/[^0-9]/g, '').substring(0, 30) || null : null;

    const result = await pool.query(
      `INSERT INTO stock_alert_thresholds (user_id, cip_code, label, rupture_qty, surstock_qty, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, cip_code) DO UPDATE
       SET label = COALESCE($3, stock_alert_thresholds.label),
           rupture_qty = $4,
           surstock_qty = $5,
           enabled = $6,
           updated_at = NOW()
       RETURNING *`,
      [req.user.id, cip, label || null, ruptureInt, surstockInt, enabled !== false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Upsert threshold error:', err);
    res.status(500).json({ error: 'Failed to save threshold' });
  }
});

// DELETE /api/alerts/thresholds/:id — delete a product-specific threshold
app.delete('/api/alerts/thresholds/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM stock_alert_thresholds WHERE id = $1 AND user_id = $2 AND cip_code IS NOT NULL RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Threshold not found (or it is the global threshold)' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete threshold error:', err);
    res.status(500).json({ error: 'Failed to delete threshold' });
  }
});

// GET /api/alerts/settings — get user notification preferences
app.get('/api/alerts/settings', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.sms_enabled, s.phone_number, s.email_daily_briefing, s.email_critical, s.briefing_hour,
              u.phone AS profile_phone
       FROM users u
       LEFT JOIN user_alert_settings s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const row = result.rows[0] || {};
    res.json({
      sms_enabled: row.sms_enabled || false,
      phone_number: row.phone_number || row.profile_phone || null,
      email_daily_briefing: row.email_daily_briefing !== false,
      email_critical: row.email_critical !== false,
      briefing_hour: row.briefing_hour !== undefined ? row.briefing_hour : 7,
      twilio_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    });
  } catch (err) {
    console.error('Get alert settings error:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT /api/alerts/settings — update notification preferences
app.put('/api/alerts/settings', requireAuth, async (req, res) => {
  try {
    const { sms_enabled, phone_number, email_daily_briefing, email_critical, briefing_hour } = req.body;
    const hourInt = parseInt(briefing_hour);
    const validHour = (!isNaN(hourInt) && hourInt >= 0 && hourInt <= 23) ? hourInt : 7;

    // Normalize phone to E.164 (basic)
    let phone = phone_number ? String(phone_number).replace(/[\s\-().]/g, '') : null;
    if (phone && !phone.startsWith('+')) phone = '+33' + phone.replace(/^0/, '');

    await pool.query(
      `INSERT INTO user_alert_settings (user_id, sms_enabled, phone_number, email_daily_briefing, email_critical, briefing_hour, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET sms_enabled = $2,
           phone_number = COALESCE($3, user_alert_settings.phone_number),
           email_daily_briefing = $4,
           email_critical = $5,
           briefing_hour = $6,
           updated_at = NOW()`,
      [req.user.id, sms_enabled || false, phone,
       email_daily_briefing !== false,
       email_critical !== false,
       validHour]
    );

    res.json({ saved: true });
  } catch (err) {
    console.error('Update alert settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Catch-all: serve app for /app/* routes (client-side routing)
app.get('/app/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ========== HTTP + WEBSOCKET SERVER ==========

const server = http.createServer(app);

// WebSocket server (noServer mode — we handle upgrade manually for path routing)
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req, agentId) => {
  if (!wsClients.has(agentId)) wsClients.set(agentId, new Set());
  wsClients.get(agentId).add(ws);

  ws.send(JSON.stringify({ type: 'connected', agent_id: agentId }));

  ws.on('close', () => {
    const set = wsClients.get(agentId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) wsClients.delete(agentId);
    }
  });
  ws.on('error', () => {});
});

// Route WebSocket upgrades: only /ws/stock/:agent_id is accepted
server.on('upgrade', (request, socket, head) => {
  const urlPath = request.url ? request.url.split('?')[0] : '';
  const match = urlPath.match(/^\/ws\/stock\/([0-9a-f-]{36})$/i);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const agentId = match[1];
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, agentId);
  });
});

server.listen(port, () => {
  console.log(`ShelfRx running on port ${port}`);
  // Trial reminder cron — runs on startup and every hour
  runTrialReminders().catch(() => {});
  setInterval(() => runTrialReminders().catch(() => {}), 60 * 60 * 1000);
  // Stock alert briefing cron — runs every 15 minutes, sends at user's configured hour
  setInterval(() => runStockAlertBriefings().catch(() => {}), 15 * 60 * 1000);
});

// ========== STOCK ALERT DAILY BRIEFING ==========

/**
 * Runs every 15 minutes. Sends a daily morning briefing email to users
 * who have unread alerts and haven't received a briefing today.
 * Respects each user's configured briefing_hour.
 */
async function runStockAlertBriefings() {
  try {
    const now = new Date();
    const currentHour = now.getUTCHours() + 2; // approximate CET (France, adjust if needed)
    const todayStr = now.toISOString().slice(0, 10);

    // Find users eligible for a briefing:
    // - have email_daily_briefing enabled (default TRUE)
    // - configured briefing_hour matches current hour
    // - haven't received a briefing today
    // - have at least 1 unread alert
    const eligibleUsers = await pool.query(
      `SELECT u.id, u.email, u.name, u.pharmacy_name,
              COALESCE(s.briefing_hour, 7) AS briefing_hour
       FROM users u
       LEFT JOIN user_alert_settings s ON s.user_id = u.id
       LEFT JOIN alert_briefings_sent b ON b.user_id = u.id AND b.sent_date = $1
       WHERE COALESCE(s.email_daily_briefing, TRUE) = TRUE
         AND COALESCE(s.briefing_hour, 7) = $2
         AND b.id IS NULL
         AND EXISTS (
           SELECT 1 FROM stock_alerts sa
           WHERE sa.user_id = u.id AND sa.read = FALSE
         )`,
      [todayStr, currentHour]
    );

    for (const user of eligibleUsers.rows) {
      await sendDailyBriefingEmail(user, todayStr).catch(() => {});
    }

    if (eligibleUsers.rows.length > 0) {
      console.log(`[briefing] Sent daily briefings to ${eligibleUsers.rows.length} user(s)`);
    }
  } catch (err) {
    console.warn('[briefing] Error:', err.message);
  }
}

async function sendDailyBriefingEmail(user, todayStr) {
  // Fetch unread alerts grouped by priority
  const alertsResult = await pool.query(
    `SELECT cip_code, label, alert_type, priority, quantity, threshold_qty, triggered_at
     FROM stock_alerts
     WHERE user_id = $1 AND read = FALSE
     ORDER BY
       CASE priority WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       triggered_at DESC
     LIMIT 20`,
    [user.id]
  );

  if (alertsResult.rows.length === 0) return; // nothing to report

  const alerts = alertsResult.rows;
  const criticals = alerts.filter(a => a.priority === 'critical');
  const warnings = alerts.filter(a => a.priority === 'warning');
  const infos = alerts.filter(a => a.priority === 'info');

  // Top 5 sales from yesterday
  let salesRows = [];
  try {
    const yesterday = new Date(Date.now() - 86400000);
    const salesResult = await pool.query(
      `SELECT cip_code, label, ABS(SUM(quantity)) AS qty_vendu
       FROM stock_events se
       JOIN pharmacy_agents pa ON pa.id = se.agent_id
       WHERE pa.user_id = $1
         AND se.event_type = 'vente'
         AND se.occurred_at >= $2
       GROUP BY cip_code, label
       ORDER BY qty_vendu DESC
       LIMIT 5`,
      [user.id, yesterday.toISOString()]
    );
    salesRows = salesResult.rows;
  } catch (_) {}

  const alertRows = alerts.slice(0, 10).map(a => {
    const icon = a.priority === 'critical' ? '🔴' : a.priority === 'warning' ? '🟠' : '🔵';
    const statusText = a.alert_type === 'rupture' ? `Rupture (${a.quantity} unités)`
      : a.alert_type === 'rupture_imminente' ? `Stock bas (${a.quantity} unités)`
      : `Surstock (${a.quantity} unités)`;
    return `<tr>
      <td style="padding:0.5rem 0.75rem; border-bottom:1px solid #e2e8f0;">${icon} ${a.label || a.cip_code}</td>
      <td style="padding:0.5rem 0.75rem; border-bottom:1px solid #e2e8f0; color:#64748b; font-size:0.8rem;">${statusText}</td>
    </tr>`;
  }).join('');

  const salesSection = salesRows.length > 0 ? `
    <h3 style="font-size:1rem; margin:1.5rem 0 0.75rem; color:#0f172a;">📈 Top ventes d'hier</h3>
    <table style="width:100%; border-collapse:collapse; background:white; border-radius:8px; border:1px solid #e2e8f0;">
      <tbody>
        ${salesRows.map(s => `<tr>
          <td style="padding:0.5rem 0.75rem; border-bottom:1px solid #e2e8f0;">${s.label || s.cip_code}</td>
          <td style="padding:0.5rem 0.75rem; border-bottom:1px solid #e2e8f0; color:#0D9488; font-weight:600; text-align:right;">${s.qty_vendu} unités</td>
        </tr>`).join('')}
      </tbody>
    </table>
  ` : '';

  const summaryLine = [
    criticals.length > 0 ? `${criticals.length} rupture(s) critique(s)` : '',
    warnings.length > 0 ? `${warnings.length} stock(s) bas` : '',
    infos.length > 0 ? `${infos.length} surstock(s)` : ''
  ].filter(Boolean).join(' · ');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #334155;">
      <div style="background: #0D9488; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">☀️ Briefing stock — ShelfRx</h1>
        <p style="color: rgba(255,255,255,0.85); margin: 0.4rem 0 0; font-size: 0.9rem;">${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </div>
      <div style="background: #f8fafc; padding: 28px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
        <p style="margin-top:0;">Bonjour ${user.name || 'Pharmacien(ne)'},</p>
        <p>Voici votre résumé stock du matin : <strong>${summaryLine}</strong></p>

        <h3 style="font-size:1rem; margin:1.5rem 0 0.75rem; color:#0f172a;">⚠️ Alertes en cours (${alerts.length})</h3>
        <table style="width:100%; border-collapse:collapse; background:white; border-radius:8px; border:1px solid #e2e8f0;">
          <tbody>${alertRows}</tbody>
        </table>
        ${alerts.length > 10 ? `<p style="font-size:0.8rem; color:#64748b; margin-top:0.5rem;">+ ${alerts.length - 10} autres alertes dans votre espace.</p>` : ''}

        ${salesSection}

        <div style="margin-top:1.5rem; text-align:center;">
          <a href="https://shelfrx.polsia.app/app/alerts" style="display:inline-block; background:#0D9488; color:white; padding:10px 24px; border-radius:8px; text-decoration:none; font-weight:600; font-size:0.9rem;">Voir toutes mes alertes →</a>
        </div>
        <p style="font-size:0.75rem; color:#94a3b8; margin-top:1.5rem;">Vous recevez ce briefing quotidien de ShelfRx. <a href="https://shelfrx.polsia.app/app/alerts" style="color:#0D9488;">Gérer mes préférences</a></p>
      </div>
    </div>
  `;

  const sent = await sendEmail({
    to: user.email,
    subject: `☀️ Briefing stock — ${summaryLine}`,
    html
  });

  if (sent) {
    await pool.query(
      `INSERT INTO alert_briefings_sent (user_id, sent_date) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, todayStr]
    );
  }
}

// ========== TRIAL REMINDER EMAILS ==========

async function runTrialReminders() {
  try {
    const now = new Date();

    // J-5: trial ends in 4–6 days (reminder type: 'trial_j5')
    const j5Min = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
    const j5Max = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);

    // J-1: trial ends in 0–2 days (reminder type: 'trial_j1')
    const j1Min = new Date(now.getTime() + 0);
    const j1Max = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    // J-5 candidates
    const j5Users = await pool.query(
      `SELECT u.id, u.email, u.name, u.pharmacy_name, u.trial_ends_at
       FROM users u
       LEFT JOIN email_reminders_sent r ON r.user_id = u.id AND r.reminder_type = 'trial_j5'
       WHERE u.subscription_status = 'trial'
         AND u.trial_ends_at BETWEEN $1 AND $2
         AND r.id IS NULL`,
      [j5Min, j5Max]
    );

    for (const user of j5Users.rows) {
      const daysLeft = Math.ceil((new Date(user.trial_ends_at) - now) / (1000 * 60 * 60 * 24));
      const sent = await sendEmail({
        to: user.email,
        subject: `ShelfRx — Plus que ${daysLeft} jours d'essai`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #334155;">
            <div style="background: #0D9488; padding: 24px; border-radius: 12px 12px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 22px;">ShelfRx</h1>
            </div>
            <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
              <h2 style="color: #0f172a; margin-top: 0;">Bonjour ${user.name} 👋</h2>
              <p>Votre essai gratuit ShelfRx se termine dans <strong>${daysLeft} jours</strong>.</p>
              <p style="margin-top: 1rem;">Choisissez votre formule pour conserver l'accès à tous vos planogrammes :</p>
              <div style="margin: 1.5rem 0; display: flex; gap: 1rem; flex-wrap: wrap;">
                <div style="flex: 1; min-width: 200px; border: 2px solid #e2e8f0; border-radius: 12px; padding: 1.25rem;">
                  <div style="font-weight: 700; font-size: 1.1rem; margin-bottom: 0.5rem;">Classique</div>
                  <div style="font-size: 1.6rem; font-weight: 700; color: #0D9488;">79€<span style="font-size: 0.9rem; font-weight: 400;">/mois</span></div>
                  <div style="font-size: 0.82rem; color: #64748B; margin-top: 0.5rem;">Toutes les fonctionnalités planogrammes</div>
                  <a href="${STRIPE_CLASSIQUE_URL}" style="display: block; text-align: center; margin-top: 1rem; background: #0D9488; color: white; padding: 0.6rem 1rem; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem;">Choisir Classique →</a>
                </div>
                <div style="flex: 1; min-width: 200px; border: 2px solid #0D9488; border-radius: 12px; padding: 1.25rem; background: #F0FDFA;">
                  <div style="font-weight: 700; font-size: 1.1rem; margin-bottom: 0.5rem;">Premium</div>
                  <div style="font-size: 1.6rem; font-weight: 700; color: #0D9488;">99€<span style="font-size: 0.9rem; font-weight: 400;">/mois</span></div>
                  <div style="font-size: 0.82rem; color: #64748B; margin-top: 0.5rem;">+ Analytics ventes & recommandations IA</div>
                  <a href="${STRIPE_PREMIUM_URL}" style="display: block; text-align: center; margin-top: 1rem; background: #0D9488; color: white; padding: 0.6rem 1rem; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem;">Choisir Premium →</a>
                </div>
              </div>
              <p style="font-size: 0.82rem; color: #94A3B8; margin-top: 1rem;">Sans engagement · Annulez à tout moment</p>
            </div>
          </div>
        `
      });
      if (sent) {
        await pool.query(
          `INSERT INTO email_reminders_sent (user_id, reminder_type) VALUES ($1, 'trial_j5') ON CONFLICT DO NOTHING`,
          [user.id]
        );
      }
    }

    // J-1 candidates
    const j1Users = await pool.query(
      `SELECT u.id, u.email, u.name, u.pharmacy_name, u.trial_ends_at
       FROM users u
       LEFT JOIN email_reminders_sent r ON r.user_id = u.id AND r.reminder_type = 'trial_j1'
       WHERE u.subscription_status = 'trial'
         AND u.trial_ends_at BETWEEN $1 AND $2
         AND r.id IS NULL`,
      [j1Min, j1Max]
    );

    for (const user of j1Users.rows) {
      const sent = await sendEmail({
        to: user.email,
        subject: `ShelfRx — Dernier jour pour activer votre abonnement`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #334155;">
            <div style="background: #0D9488; padding: 24px; border-radius: 12px 12px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 22px;">ShelfRx</h1>
            </div>
            <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
              <h2 style="color: #0f172a; margin-top: 0;">Bonjour ${user.name},</h2>
              <p>Votre essai gratuit <strong>se termine aujourd'hui</strong>. Activez votre abonnement maintenant pour garder l'accès à ShelfRx et à tous vos planogrammes.</p>
              <div style="text-align: center; margin: 2rem 0;">
                <a href="${STRIPE_CLASSIQUE_URL}" style="display: inline-block; background: #0D9488; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 1rem; margin: 0.4rem;">Classique — 79€/mois →</a>
                <a href="${STRIPE_PREMIUM_URL}" style="display: inline-block; background: #0F766E; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 1rem; margin: 0.4rem;">Premium — 99€/mois →</a>
              </div>
              <p style="font-size: 0.82rem; color: #94A3B8;">Sans engagement · Annulez à tout moment</p>
            </div>
          </div>
        `
      });
      if (sent) {
        await pool.query(
          `INSERT INTO email_reminders_sent (user_id, reminder_type) VALUES ($1, 'trial_j1') ON CONFLICT DO NOTHING`,
          [user.id]
        );
      }
    }

    if (j5Users.rows.length + j1Users.rows.length > 0) {
      console.log(`[reminders] Sent J-5: ${j5Users.rows.length}, J-1: ${j1Users.rows.length}`);
    }
  } catch (err) {
    console.warn('[reminders] Error:', err.message);
  }
}
