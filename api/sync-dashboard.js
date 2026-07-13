// api/sync-dashboard.js
// Corre automático vía Vercel Cron (ver vercel.json) y/o GitHub Actions.
// También puedes llamarlo a mano visitando la URL una vez desplegado.

const MONTH_ABBR_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const PERIOD_COUNT = 12;
const INVENTORY_PAGE_CAP = 10;
const QL_GAP_MS = 4000;   // pausa entre queries ShopifyQL (Analytics: límite estricto)
const QL_BACKOFF_MS = 5000; // base de reintento cuando ShopifyQL regresa THROTTLED

const SHOP = process.env.SHOP_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2026-04';

const COHORT_QUERY = `FROM customer_cohorts_monthly SHOW customer_cohorts_monthly_customers, customer_cohorts_monthly_customers_customer_cohort_period_totals, customer_cohorts_monthly_customers_periods_since_first_purchase_totals, customer_cohorts_monthly_customers_totals, customer_cohorts_monthly_total_sales, customer_cohorts_monthly_total_sales_customer_cohort_period_totals, customer_cohorts_monthly_total_sales_periods_since_first_purchase_totals, customer_cohorts_monthly_total_sales_totals WHERE customer_cohorts_monthly_periods_since_first_purchase BETWEEN -1 AND 11 GROUP BY month, customer_cohorts_monthly_periods_since_first_purchase HAVING customer_cohorts_monthly_periods_since_first_purchase >= 0 SINCE startOfMonth(-12m) UNTIL endOfMonth(-1m) ORDER BY month ASC, customer_cohorts_monthly_periods_since_first_purchase ASC`;
const TOTAL_SALES_QUERY = `FROM sales SHOW gross_sales, gross_profit`;
const MONTHLY_QUERY = `FROM sales SHOW gross_sales AS ventas, gross_profit AS utilidad GROUP BY month SINCE startOfMonth(-12m) UNTIL endOfMonth(-1m) ORDER BY month ASC`;
const TOP_PRODUCTS_QUERY = `FROM sales SHOW gross_sales, net_items_sold GROUP BY product_title ORDER BY gross_sales DESC LIMIT 5`;
const TOP_CUSTOMERS_QUERY = `FROM sales SHOW gross_sales, orders GROUP BY customer_name ORDER BY gross_sales DESC LIMIT 5`;

function toNumber(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

function formatMonthLabel(monthValue) {
  const d = new Date(monthValue);
  if (isNaN(d.getTime())) return monthValue;
  return `${MONTH_ABBR_ES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Genera las últimas N claves de mes en formato "YYYY-MM", terminando en el mes actual (UTC).
// Se usa para forzar 12 meses completos en el payload, aunque ShopifyQL solo
// haya regresado filas para los meses con ventas reales.
function lastNMonthsKeys(n) {
  const keys = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7)); // "YYYY-MM"
  }
  return keys;
}

function cellReader(columns) {
  const idx = new Map(columns.map((c, i) => [c, i]));
  return (row, name) => (Array.isArray(row) ? row[idx.get(name)] : row?.[name]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function adminFetch(query, variables, token, attempt = 1) {
  const MAX_ATTEMPTS = 5;

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });

  // Manejo explícito de rate limit por HTTP 429
  if (res.status === 429) {
    if (attempt >= MAX_ATTEMPTS) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Rate limited (HTTP 429) tras ${attempt} intentos. Body: ${bodyText}`);
    }

    const retryAfterHeader = res.headers.get('Retry-After');
    const delayMs = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * 1000
      : QL_BACKOFF_MS * attempt;

    console.warn(
      `Rate limited (HTTP 429) en adminFetch (intento ${attempt}). ` +
      `Reintentando en ${delayMs}ms...`
    );
    await sleep(delayMs);
    return adminFetch(query, variables, token, attempt + 1);
  }

  // Si la respuesta no es OK y no es 429, devolvemos error detallado
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} en Admin API: ${bodyText}`);
  }

  const json = await res.json();

  // Manejo de errores GraphQL (incluyendo posibles "THROTTLED")
  if (json.errors?.length) {
    const messages = json.errors.map((e) => e.message || JSON.stringify(e)).join(', ');
    const isRate = /rate limit|throttl/i.test(messages);

    if (isRate && attempt < MAX_ATTEMPTS) {
      const delayMs = QL_BACKOFF_MS * attempt;
      console.warn(
        `Rate limited (GraphQL errors THROTTLED) en adminFetch (intento ${attempt}). ` +
        `Reintentando en ${delayMs}ms...`
      );
      await sleep(delayMs);
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

// Ejecuta una query ShopifyQL y devuelve { columns, rows }
// Ahora el manejo de rate limit lo hace adminFetch con reintentos.
async function runShopifyQL(ql, token) {
  const data = await adminFetch(
    `query($q: String!) {
      shopifyqlQuery(query: $q) {
        parseErrors
        tableData {
          columns { name }
          rows
        }
      }
    }`,
    { q: ql },
    token,
  );

  const result = data.shopifyqlQuery;
  if (!result) {
    throw new Error('Respuesta inválida de shopifyqlQuery (sin payload).');
  }

  if (result.parseErrors?.length) {
    // parseErrors suele ser una lista de objetos o strings; los unimos en texto
    const msg = result.parseErrors
      .map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e)))
      .join(', ');
    throw new Error(`Error de parseo ShopifyQL: ${msg}`);
  }

  const columns = (result.tableData?.columns || []).map((c) => c.name);
  const rows = result.tableData?.rows || [];

  return { columns, rows };
}

async function getCounts(token) {
  // Antes: Promise.all (3 llamadas simultáneas). Ahora: secuencial con pausa breve
  // entre cada una, para no golpear el rate limit con ráfagas concurrentes.
  const orders = await adminFetch(`query { ordersCount(limit: null) { count } }`, {}, token);
  await sleep(300);
  const products = await adminFetch(`query { productsCount(limit: null) { count } }`, {}, token);
  await sleep(300);
  const customers = await adminFetch(`query { customersCount(limit: null) { count } }`, {}, token);
  return {
    orders: toNumber(orders.ordersCount?.count),
    products: toNumber(products.productsCount?.count),
    customers: toNumber(customers.customersCount?.count),
  };
}

async function getInventory(token) {
  const query = `query Inventory($after: String) {
    products(first: 250, after: $after) {
      edges {
        node {
          title
          totalInventory
          featuredMedia {
            preview {
              image { url }
            }
          }
          variants(first: 100) {
            edges {
              node {
                price
                inventoryQuantity
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  let after = null, pages = 0, variantsWithStock = 0, totalValue = 0;
  const stockList = [];
  while (pages < INVENTORY_PAGE_CAP) {
    const data = await adminFetch(query, { after }, token);
    const edges = data.products?.edges || [];
    for (const { node } of edges) {
      if (!node) continue;
      stockList.push({
        title: node.title || '—',
        stock: toNumber(node.totalInventory),
        image: node.featuredMedia?.preview?.image?.url ?? null,
      });
      for (const { node: v } of node.variants?.edges || []) {
        const qty = toNumber(v.inventoryQuantity);
        const price = toNumber(v.price);
        if (qty > 0) variantsWithStock += 1;
        totalValue += qty * price;
      }
    }
    pages += 1;
    const pageInfo = data.products?.pageInfo;
    if (pageInfo?.hasNextPage) {
      after = pageInfo.endCursor;
      await sleep(300); // pausa entre páginas para no ráfaguear
    } else break;
  }
  const topStock = stockList.sort((a, b) => b.stock - a.stock).slice(0, 5);
  return { variantsWithStock, totalValue, topStock };
}

async function getCohorts(token) {
  const { columns, rows } = await runShopifyQL(COHORT_QUERY, token);
  const read = cellReader(columns);
  const monthCol = columns.find((c) => c === 'month' || c.endsWith('month'));
  const periodCol = columns.find((c) => c === 'customer_cohorts_monthly_periods_since_first_purchase');
  const salesCol = columns.find((c) => c === 'customer_cohorts_monthly_total_sales');
  if (!monthCol || !periodCol || !salesCol) return { cohorts: [], maxSales: 0 };

  const map = new Map();
  let maxSales = 0;
  for (const row of rows) {
    const monthValue = String(read(row, monthCol) ?? '');
    const period = Math.round(toNumber(read(row, periodCol)));
    const sales = toNumber(read(row, salesCol));
    if (period < 0 || period >= PERIOD_COUNT) continue;
    if (sales > maxSales) maxSales = sales;
    if (!map.has(monthValue)) map.set(monthValue, { label: formatMonthLabel(monthValue), cells: new Map() });
    map.get(monthValue).cells.set(period, sales);
  }
  const cohorts = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  return { cohorts, maxSales };
}

async function buildPayload(token) {
  const shopData = await adminFetch(`query { shop { id currencyCode } }`, {}, token);
  const currency = shopData.shop?.currencyCode || 'MXN';
  const shopId = shopData.shop?.id;
  await sleep(300);

  const counts = await getCounts(token);
  await sleep(300);
  const inventory = await getInventory(token);
  await sleep(300);

  const { columns: sc, rows: sr } = await runShopifyQL(TOTAL_SALES_QUERY, token);
  const readSales = cellReader(sc);
  const totalSales = sr.length ? toNumber(readSales(sr[0], 'gross_sales')) : 0;
  const totalProfit = sr.length ? toNumber(readSales(sr[0], 'gross_profit')) : 0;
  const avgMargin = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0;
  await sleep(QL_GAP_MS);

  // ===== MONTHLY: fix aplicado =====
  // Antes: `monthly` solo incluía los meses que ShopifyQL regresaba con ventas,
  // así que con 1 mes de ventas reales el payload traía 1 solo punto.
  // Ahora: se generan siempre los últimos 12 meses reales (lastNMonthsKeys),
  // y se rellenan con {ventas:0, utilidad:0} los meses sin filas en ShopifyQL.
  // Así el payload siempre trae 12 meses, con ceros donde aún no hay ventas.
  const { columns: mc, rows: mr } = await runShopifyQL(MONTHLY_QUERY, token);
  const readM = cellReader(mc);
  const monthlyMap = new Map();
  for (const row of mr) {
    const monthKey = String(readM(row, 'month') ?? '').slice(0, 7);
    monthlyMap.set(monthKey, {
      ventas: toNumber(readM(row, 'ventas')),
      utilidad: toNumber(readM(row, 'utilidad')),
    });
  }
  const monthly = lastNMonthsKeys(12).map((key) => {
    const entry = monthlyMap.get(key) || { ventas: 0, utilidad: 0 };
    const margen = entry.ventas > 0 ? (entry.utilidad / entry.ventas) * 100 : 0;
    return {
      label: formatMonthLabel(key + '-01'),
      ventas: Math.round(entry.ventas * 100) / 100,
      utilidad: Math.round(entry.utilidad * 100) / 100,
      margen: Math.round(margen * 10) / 10,
    };
  });
  await sleep(QL_GAP_MS);
  // ===== fin fix MONTHLY =====

  const { columns: pc, rows: pr } = await runShopifyQL(TOP_PRODUCTS_QUERY, token);
  const readP = cellReader(pc);
  const topProducts = pr.map((row) => ({
    title: String(readP(row, 'product_title') ?? '—'),
    pieces: toNumber(readP(row, 'net_items_sold')),
    sales: Math.round(toNumber(readP(row, 'gross_sales')) * 100) / 100,
  }));
  await sleep(QL_GAP_MS);

  const { columns: cc, rows: cr } = await runShopifyQL(TOP_CUSTOMERS_QUERY, token);
  const readC = cellReader(cc);
  const topCustomers = cr.map((row) => ({
    name: String(readC(row, 'customer_name') ?? '—'),
    orders: toNumber(readC(row, 'orders')),
    total: Math.round(toNumber(readC(row, 'gross_sales')) * 100) / 100,
  }));
  await sleep(QL_GAP_MS);

  const { cohorts, maxSales } = await getCohorts(token);
  const cohortRows = cohorts.map((c) => {
    const values = [];
    for (let p = 0; p < PERIOD_COUNT; p++) {
      const v = c.cells.get(p);
      values.push(v === undefined ? null : Math.round(v * 100) / 100);
    }
    while (values.length > 0 && values[values.length - 1] === null) values.pop();
    return { label: c.label, values };
  });

  return {
    shopId,
    payload: {
      updated_at: new Date().toISOString(),
      currency,
      kpis: {
        total_sales: totalSales,
        total_profit: totalProfit,
        avg_margin: avgMargin,
        orders: counts.orders,
        products: counts.products,
        customers: counts.customers,
      },
      monthly,
      top_products: topProducts,
      top_customers: topCustomers,
      inventory: {
        variants_with_stock: inventory.variantsWithStock,
        total_value: Math.round(inventory.totalValue * 100) / 100,
        top_stock: inventory.topStock,
      },
      cohorts: {
        periods: Array.from({ length: PERIOD_COUNT }, (_, i) => 'Mes ' + i),
        max_sales: maxSales,
        rows: cohortRows,
      },
    },
  };
}

async function writeMetafield(token, shopId, payload) {
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
          key: 'dashboard_json',
          type: 'json',
          value: JSON.stringify(payload),
        },
      ],
    },
    token,
  );
  if (data.metafieldsSet.userErrors?.length) {
    throw new Error(JSON.stringify(data.metafieldsSet.userErrors));
  }
  return data.metafieldsSet.metafields;
}

const MIN_INTERVAL_MS = 3 * 60 * 1000; // no re-sincronizar si hace <3 min

async function recentlySynced(token) {
  try {
    const data = await adminFetch(
      `query { shop { metafield(namespace: "custom", key: "dashboard_json") { updatedAt } } }`,
      {},
      token,
    );
    const updatedAt = data?.shop?.metafield?.updatedAt;
    if (!updatedAt) return false;
    return Date.now() - new Date(updatedAt).getTime() < MIN_INTERVAL_MS;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  // Protege el endpoint: solo Vercel Cron, GitHub Actions, o tú mismo con el secret pueden llamarlo
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const token = await getAccessToken();

    // ¿Publicado hace menos de 3 min? No quemar el rate limit de ShopifyQL.
    if (req.query?.force !== '1' && (await recentlySynced(token))) {
      return res
        .status(200)
        .json({ ok: true, skipped: true, reason: 'Sincronizado hace <3 min' });
    }
    const { shopId, payload } = await buildPayload(token);
    await writeMetafield(token, shopId, payload);
    return res.status(200).json({ ok: true, updated_at: payload.updated_at });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
