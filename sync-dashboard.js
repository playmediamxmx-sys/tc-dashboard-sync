// api/sync-dashboard.js
// Corre automático vía Vercel Cron (ver vercel.json).
// También puedes llamarlo a mano visitando la URL una vez desplegado.

const MONTH_ABBR_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const PERIOD_COUNT = 12;
const INVENTORY_PAGE_CAP = 10;

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

function cellReader(columns) {
  const idx = new Map(columns.map((c, i) => [c, i]));
  return (row, name) => (Array.isArray(row) ? row[idx.get(name)] : row?.[name]);
}

async function adminFetch(query, variables, token) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(', '));
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

async function runShopifyQL(ql, token) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1300 * attempt));
    try {
      const data = await adminFetch(
        `query($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { columns { name } rows } } }`,
        { q: ql },
        token,
      );
      const result = data.shopifyqlQuery;
      if (result.parseErrors?.length) throw new Error(result.parseErrors.join(', '));
      return { columns: result.tableData.columns.map((c) => c.name), rows: result.tableData.rows };
    } catch (err) {
      lastErr = err;
      const isRate = /rate limit|throttl/i.test(err.message);
      if (!isRate) throw err;
    }
  }
  throw lastErr || new Error('Rate limited.');
}

async function getCounts(token) {
  const [o, p, c] = await Promise.all([
    adminFetch(`query { ordersCount(limit: null) { count } }`, {}, token),
    adminFetch(`query { productsCount(limit: null) { count } }`, {}, token),
    adminFetch(`query { customersCount(limit: null) { count } }`, {}, token),
  ]);
  return {
    orders: toNumber(o.ordersCount?.count),
    products: toNumber(p.productsCount?.count),
    customers: toNumber(c.customersCount?.count),
  };
}

async function getInventory(token) {
  const query = `query Inventory($after: String) {
    products(first: 250, after: $after) {
      edges { node { title totalInventory featuredMedia { preview { image { url } } } variants(first: 100) { edges { node { price inventoryQuantity } } } } }
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
    if (pageInfo?.hasNextPage) after = pageInfo.endCursor;
    else break;
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

  const counts = await getCounts(token);
  const inventory = await getInventory(token);

  const { columns: sc, rows: sr } = await runShopifyQL(TOTAL_SALES_QUERY, token);
  const readSales = cellReader(sc);
  const totalSales = sr.length ? toNumber(readSales(sr[0], 'gross_sales')) : 0;
  const totalProfit = sr.length ? toNumber(readSales(sr[0], 'gross_profit')) : 0;
  const avgMargin = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0;

  const { columns: mc, rows: mr } = await runShopifyQL(MONTHLY_QUERY, token);
  const readM = cellReader(mc);
  const monthly = mr.map((row) => {
    const monthKey = String(readM(row, 'month') ?? '');
    const ventas = toNumber(readM(row, 'ventas'));
    const utilidad = toNumber(readM(row, 'utilidad'));
    const margen = ventas > 0 ? (utilidad / ventas) * 100 : 0;
    return { label: formatMonthLabel(monthKey), ventas: Math.round(ventas * 100) / 100, utilidad: Math.round(utilidad * 100) / 100, margen: Math.round(margen * 10) / 10 };
  });

  const { columns: pc, rows: pr } = await runShopifyQL(TOP_PRODUCTS_QUERY, token);
  const readP = cellReader(pc);
  const topProducts = pr.map((row) => ({
    title: String(readP(row, 'product_title') ?? '—'),
    pieces: toNumber(readP(row, 'net_items_sold')),
    sales: Math.round(toNumber(readP(row, 'gross_sales')) * 100) / 100,
  }));

  const { columns: cc, rows: cr } = await runShopifyQL(TOP_CUSTOMERS_QUERY, token);
  const readC = cellReader(cc);
  const topCustomers = cr.map((row) => ({
    name: String(readC(row, 'customer_name') ?? '—'),
    orders: toNumber(readC(row, 'orders')),
    total: Math.round(toNumber(readC(row, 'gross_sales')) * 100) / 100,
  }));

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
    `mutation($mf: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $mf) { metafields { id key } userErrors { field message } } }`,
    { mf: [{ ownerId: shopId, namespace: 'custom', key: 'dashboard_json', type: 'json', value: JSON.stringify(payload) }] },
    token,
  );
  if (data.metafieldsSet.userErrors?.length) throw new Error(JSON.stringify(data.metafieldsSet.userErrors));
  return data.metafieldsSet.metafields;
}

export default async function handler(req, res) {
  // Protege el endpoint: solo Vercel Cron o tú mismo con el secret pueden llamarlo
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const token = await getAccessToken();
    const { shopId, payload } = await buildPayload(token);
    await writeMetafield(token, shopId, payload);
    return res.status(200).json({ ok: true, updated_at: payload.updated_at });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
