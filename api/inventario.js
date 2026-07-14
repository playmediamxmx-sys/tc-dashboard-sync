// api/inventario.js
// Backend del catálogo QR (page.catalogo-qr.liquid). Ajusta el inventario
// REAL de Shopify (entrada/salida) y guarda un historial centralizado en el
// metafield shop.metafields.custom.qr_movements. El token de Shopify vive
// SOLO aquí — el Liquid nunca lo ve.
//
// Reutiliza las mismas env vars que api/sync-dashboard.js:
//   SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
// Y agrega dos nuevas, propias de este endpoint:
//   OPERATOR_PINS   -> JSON: {"1234":"Juan Pérez","5678":"María López"}
//   ALLOWED_ORIGIN  -> dominio(s) permitidos para CORS, separados por coma
//                      ej: "https://mitiendatecnocasa.myshopify.com,https://catalogo.tecnocasa.mx"
//
// Requiere en la app: scopes read_inventory, write_inventory, read_locations
// (ya confirmados). Requiere maxDuration:300 en vercel.json (ya lo tienes).

const SHOP = process.env.SHOP_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2026-04';

const MAX_MOVEMENTS_STORED = 500; // tope del metafield para no acercarse al límite de tamaño de Shopify

function toNumber(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function toGid(kind, rawId) {
  const id = String(rawId).replace(/\D/g, '');
  return `gid://shopify/${kind}/${id}`;
}

function parseOperatorPins() {
  try { return JSON.parse(process.env.OPERATOR_PINS || '{}'); }
  catch { return {}; }
}

function resolveOperator(req) {
  const pin = req.headers['x-operator-pin'];
  if (!pin) return null;
  const pins = parseOperatorPins();
  const name = pins[String(pin).trim()];
  return name || null; // null si el PIN no existe en el mapa
}

function setCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Operator-Pin');
  res.setHeader('Vary', 'Origin');
}

async function adminFetch(query, variables, token, attempt = 1) {
  const MAX_ATTEMPTS = 5;
  const BACKOFF_MS = 4000;

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    if (attempt >= MAX_ATTEMPTS) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Rate limited (HTTP 429) tras ${attempt} intentos. Body: ${bodyText}`);
    }
    const retryAfter = res.headers.get('Retry-After');
    const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : BACKOFF_MS * attempt;
    await sleep(delayMs);
    return adminFetch(query, variables, token, attempt + 1);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} en Admin API: ${bodyText}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    const messages = json.errors.map((e) => e.message || JSON.stringify(e)).join(', ');
    const isRate = /rate limit|throttl/i.test(messages);
    if (isRate && attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_MS * attempt);
      return adminFetch(query, variables, token, attempt + 1);
    }
    throw new Error(messages);
  }

  return json.data;
}

async function getAccessToken() {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`No se pudo obtener el token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// ── Ubicación: se cachea en memoria del proceso (warm invocations).
// Con una sola ubicación, esta llamada solo ocurre 1 vez por cold start.
let cachedLocationId = null;
async function getLocationId(token) {
  if (cachedLocationId) return cachedLocationId;
  const data = await adminFetch(
    `query { locations(first: 5) { edges { node { id name } } } }`,
    {},
    token,
  );
  const edges = data.locations?.edges || [];
  if (!edges.length) throw new Error('La tienda no tiene ninguna ubicación configurada.');
  cachedLocationId = edges[0].node.id; // una sola ubicación confirmada -> tomamos la primera
  return cachedLocationId;
}

async function getShopId(token) {
  const data = await adminFetch(`query { shop { id } }`, {}, token);
  return data.shop?.id;
}

// ── Resuelve producto + variante objetivo a partir de productId/variantId
// (numéricos, como vienen del dataset del Liquid) y regresa el inventoryItem
// a ajustar junto con los títulos para el historial/respuesta.
async function resolveTarget(token, productId, variantId) {
  const productGid = toGid('Product', productId);

  const data = await adminFetch(
    `query($id: ID!) {
      product(id: $id) {
        title
        variants(first: 100) {
          edges {
            node {
              id
              title
              inventoryItem { id tracked }
            }
          }
        }
      }
    }`,
    { id: productGid },
    token,
  );

  const product = data.product;
  if (!product) throw new Error('Producto no encontrado en Shopify.');

  const variantEdges = product.variants?.edges || [];
  let targetVariant;
  if (variantId) {
    const variantGid = toGid('ProductVariant', variantId);
    targetVariant = variantEdges.find((e) => e.node.id === variantGid)?.node;
  } else {
    targetVariant = variantEdges[0]?.node;
  }

  if (!targetVariant) throw new Error('Variante no encontrada en Shopify.');
  if (!targetVariant.inventoryItem?.tracked) {
    throw new Error('Esta variante no tiene rastreo de inventario activado en Shopify.');
  }

  return {
    productTitle: product.title,
    variantTitle: targetVariant.title === 'Default Title' ? null : targetVariant.title,
    inventoryItemId: targetVariant.inventoryItem.id,
  };
}

async function getAvailableQuantity(token, inventoryItemId, locationId) {
  const data = await adminFetch(
    `query($id: ID!, $locId: ID!) {
      inventoryItem(id: $id) {
        inventoryLevel(locationId: $locId) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }`,
    { id: inventoryItemId, locId: locationId },
    token,
  );
  const quantities = data.inventoryItem?.inventoryLevel?.quantities || [];
  const available = quantities.find((q) => q.name === 'available');
  return available ? toNumber(available.quantity) : 0;
}

async function adjustInventory(token, inventoryItemId, locationId, delta, reason) {
  const data = await adminFetch(
    `mutation($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup {
          changes { name delta quantityAfterChange }
        }
        userErrors { field message }
      }
    }`,
    {
      input: {
        reason,
        name: 'available',
        changes: [{ delta, inventoryItemId, locationId }],
      },
    },
    token,
  );

  const errors = data.inventoryAdjustQuantities?.userErrors;
  if (errors?.length) throw new Error(errors.map((e) => e.message).join(', '));

  const changes = data.inventoryAdjustQuantities?.inventoryAdjustmentGroup?.changes || [];
  const change = changes.find((c) => c.name === 'available') || changes[0];
  return change ? toNumber(change.quantityAfterChange) : null;
}

// ── Historial centralizado: leer/escribir shop.metafields.custom.qr_movements
async function readMovements(token) {
  const data = await adminFetch(
    `query { shop { metafield(namespace: "custom", key: "qr_movements") { value } } }`,
    {},
    token,
  );
  const raw = data?.shop?.metafield?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendMovement(token, shopId, movement) {
  const current = await readMovements(token);
  const updated = [movement, ...current].slice(0, MAX_MOVEMENTS_STORED);

  const data = await adminFetch(
    `mutation($mf: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $mf) {
        metafields { id key }
        userErrors { field message }
      }
    }`,
    {
      mf: [
        {
          ownerId: shopId,
          namespace: 'custom',
          key: 'qr_movements',
          type: 'json',
          value: JSON.stringify(updated),
        },
      ],
    },
    token,
  );

  if (data.metafieldsSet.userErrors?.length) {
    throw new Error(JSON.stringify(data.metafieldsSet.userErrors));
  }
  return updated;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const operator = resolveOperator(req);
  if (!operator) {
    return res.status(401).json({ ok: false, error: 'PIN de operador inválido o faltante.' });
  }

  try {
    const token = await getAccessToken();

    // ===== GET: historial de movimientos (para "Ver historial completo") =====
    if (req.method === 'GET') {
      const movements = await readMovements(token);
      return res.status(200).json({ ok: true, movements });
    }

    // ===== POST: registrar entrada o salida =====
    if (req.method === 'POST') {
      const { productId, variantId, mode, qty } = req.body || {};

      if (!productId || !mode || !qty) {
        return res.status(400).json({ ok: false, error: 'Faltan datos: productId, mode y qty son obligatorios.' });
      }
      if (!['entrada', 'salida'].includes(mode)) {
        return res.status(400).json({ ok: false, error: 'mode debe ser "entrada" o "salida".' });
      }
      const qtyNum = parseInt(qty, 10);
      if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
        return res.status(400).json({ ok: false, error: 'qty debe ser un entero positivo.' });
      }

      const [shopId, locationId, target] = await Promise.all([
        getShopId(token),
        getLocationId(token),
        resolveTarget(token, productId, variantId),
      ]);

      // Salida: validar stock suficiente ANTES de tocar nada.
      if (mode === 'salida') {
        const currentAvailable = await getAvailableQuantity(token, target.inventoryItemId, locationId);
        if (currentAvailable < qtyNum) {
          return res.status(409).json({
            ok: false,
            error: `Stock insuficiente: solo hay ${currentAvailable} pieza(s) disponibles de "${target.productTitle}".`,
          });
        }
      }

      const delta = mode === 'entrada' ? qtyNum : -qtyNum;
      const reason = mode === 'entrada' ? 'restock' : 'correction';
      const availableAfter = await adjustInventory(token, target.inventoryItemId, locationId, delta, reason);

      const movement = {
        ts: new Date().toISOString(),
        mode,
        qty: qtyNum,
        product: target.productTitle,
        variant: target.variantTitle,
        operator,
        after: availableAfter,
      };
      await appendMovement(token, shopId, movement);

      return res.status(200).json({
        ok: true,
        product: target.productTitle,
        variant: target.variantTitle,
        available_after: availableAfter,
      });
    }

    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

