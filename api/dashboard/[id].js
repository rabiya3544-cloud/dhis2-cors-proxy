// api/dashboard/[id].js
// Resilient version: checks server health, tries to fetch dashboard, falls back on failure.
// Includes Vercel Edge Caching to survive DHIS2 downtime.

const BASE_URLS = [
  "https://play.im.dhis2.org/dev",
  "https://play.im.dhis2.org/stable-2-43-1",
  "https://play.im.dhis2.org/stable-2-42-7",
  "https://play.im.dhis2.org/stable-2-42-1",
  "https://play.im.dhis2.org/stable-2-41-8-2",
  "https://play.im.dhis2.org/stable-2-43-0"
];

const DEFAULT_AUTH =
  process.env.DHIS2_AUTH ||
  "Basic " + Buffer.from("admin:district").toString("base64");

const RELATIVE_PERIOD_MAP = {
  thisDay: "TODAY", yesterday: "YESTERDAY",
  last3Days: "LAST_3_DAYS", last7Days: "LAST_7_DAYS",
  last14Days: "LAST_14_DAYS", last30Days: "LAST_30_DAYS",
  lastMonth: "LAST_MONTH", lastBimonth: "LAST_BIMONTH",
  lastQuarter: "LAST_QUARTER", lastSixMonth: "LAST_SIX_MONTH",
  weeksThisYear: "WEEKS_THIS_YEAR", monthsThisYear: "MONTHS_THIS_YEAR",
  biMonthsThisYear: "BIMONTHS_THIS_YEAR", quartersThisYear: "QUARTERS_THIS_YEAR",
  thisYear: "THIS_YEAR", monthsLastYear: "MONTHS_LAST_YEAR",
  quartersLastYear: "QUARTERS_LAST_YEAR", lastYear: "LAST_YEAR",
  last5Years: "LAST_5_YEARS", last12Months: "LAST_12_MONTHS",
  last6Months: "LAST_6_MONTHS", last3Months: "LAST_3_MONTHS",
  last6Bimonth: "LAST_6_BIMONTHS", last6Quarter: "LAST_6_QUARTERS",
  last4Quarters: "LAST_4_QUARTERS", last2SixMonths: "LAST_2_SIXMONTHS",
  thisFinancialYear: "THIS_FINANCIAL_YEAR", lastFinancialYear: "LAST_FINANCIAL_YEAR",
  last5FinancialYears: "LAST_5_FINANCIAL_YEARS",
  thisMonth: "THIS_MONTH", thisBimonth: "THIS_BIMONTH",
  thisQuarter: "THIS_QUARTER", thisSixMonth: "THIS_SIX_MONTH",
};

const CHARTABLE_TYPES = new Set([
  "LINE", "AREA", "STACKED_AREA", "YEAR_OVER_YEAR_LINE",
  "COLUMN", "BAR", "STACKED_COLUMN", "STACKED_BAR", "YEAR_OVER_YEAR_COLUMN",
  "PIE", "RADAR", "GAUGE", "SCATTER", "BUBBLE",
]);

const REPORTING_METRICS = [
  "REPORTING_RATE",
  "REPORTING_RATE_ON_TIME",
  "ACTUAL_REPORTS",
  "ACTUAL_REPORTS_ON_TIME",
  "EXPECTED_REPORTS",
];

function buildAuth(req) {
  return req.headers.authorization || DEFAULT_AUTH;
}

async function dhisFetch(path, auth, baseUrl) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const peek = await res.text();
    throw new Error(`Expected JSON but got "${ct}". First 120 chars: ` + peek.slice(0, 120).replace(/\s+/g, " "));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`HTTP ${res.status}: ${body.message || res.statusText}`);
    err.dhisErrorCode = body.errorCode;
    throw err;
  }
  return res.json();
}

function isInvalidDxError(err) {
  return (
    /E7124|E7102|dimension options/i.test(err.message) ||
    err.dhisErrorCode === "E7124" ||
    err.dhisErrorCode === "E7102"
  );
}

function isMissingTableError(err) {
  return (
    /42P01|referenced table does not exist/i.test(err.message) ||
    err.dhisErrorCode === "E7103"
  );
}

async function fetchVizAndDims(vizId, auth, baseUrl) {
  const fields = [
    "id", "displayName", "type",
    "columns[dimension,items[id]]",
    "rows[dimension,items[id]]",
    "filters[dimension,items[id]]",
    "relativePeriods",
    "userOrganisationUnit",
    "userOrganisationUnitChildren",
    "userOrganisationUnitGrandChildren",
  ].join(",");
  const viz = await dhisFetch(`/api/visualizations/${encodeURIComponent(vizId)}.json?fields=${fields}`, auth, baseUrl);
  
  const dims = { dx: [], pe: [], ou: [] };
  const axes = [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
  for (const axis of axes) {
    if (!dims[axis.dimension] || !Array.isArray(axis.items)) continue;
    for (const item of axis.items) {
      const id = item.id || item.dimension;
      if (id) dims[axis.dimension].push(id);
    }
  }
  const rel = viz.relativePeriods || {};
  for (const [flag, pid] of Object.entries(RELATIVE_PERIOD_MAP)) {
    if (rel[flag]) dims.pe.push(pid);
  }
  if (viz.userOrganisationUnit)              dims.ou.push("USER_ORGUNIT");
  if (viz.userOrganisationUnitChildren)      dims.ou.push("USER_ORGUNIT_CHILDREN");
  if (viz.userOrganisationUnitGrandChildren) dims.ou.push("USER_ORGUNIT_GRANDCHILDREN");

  dims.dx = [...new Set(dims.dx)];
  dims.pe = [...new Set(dims.pe)];
  dims.ou = [...new Set(dims.ou)];

  if (!dims.dx.length) throw new Error("No data items (dx) in visualization.");
  if (!dims.pe.length) dims.pe.push("LAST_12_MONTHS");
  if (!dims.ou.length) dims.ou.push("USER_ORGUNIT");

  return { viz, dims };
}

async function fetchAnalytics(dims, auth, baseUrl) {
  const buildUrl = dxItems => {
    const params = [
      `dimension=dx:${dxItems.join(";")}`,
      `dimension=pe:${dims.pe.join(";")}`,
      `dimension=ou:${dims.ou.join(";")}`,
    ];
    return `/api/analytics.json?${params.join("&")}`;
  };

  try {
    return await dhisFetch(buildUrl(dims.dx), auth, baseUrl);
  } catch (err) {
    if (!isInvalidDxError(err)) throw err;
  }

  let lastErr;
  for (const metric of REPORTING_METRICS) {
    const dxWithMetric = dims.dx.map(id => id.includes(".") ? id : `${id}.${metric}`);
    try {
      return await dhisFetch(buildUrl(dxWithMetric), auth, baseUrl);
    } catch (err) {
      lastErr = err;
      if (!isInvalidDxError(err)) throw err;
    }
  }
  throw lastErr;
}

async function pMap(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export default async function handler(req, res) {
  // --- CORS & CACHING HEADERS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  
  // Cache the successful response at Vercel's edge for 1 hour.
  // If DHIS2 goes down, Vercel will serve the cached version.
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing dashboard "id" path parameter' });

  const auth = buildAuth(req);

  let workingBaseUrl = null;
  let dash = null;
  let lastError = null;

  // --- 1. FIND A WORKING SERVER ---
  for (const baseUrl of BASE_URLS) {
    try {
      // Quick check: is the server alive?
      await dhisFetch("/api/system/info.json", auth, baseUrl);
      
      // If alive, try to fetch the dashboard (this is where analytics tables are tested)
      dash = await dhisFetch(
        `/api/dashboards/${encodeURIComponent(id)}.json?fields=:all,dashboardItems[:all]`,
        auth, baseUrl
      );
      
      // If we got here, both the server and its analytics tables are working
      workingBaseUrl = baseUrl;
      console.log(`[dashboard aggregator] Using working server: ${baseUrl}`);
      break;

    } catch (err) {
      console.warn(`[dashboard aggregator] Server ${baseUrl} failed: ${err.message}`);
      lastError = err;
      dash = null;
    }
  }

  if (!workingBaseUrl || !dash) {
    return res.status(500).json({
      error: "All DHIS2 servers are unreachable or their analytics tables are currently missing.",
      details: lastError?.message,
    });
  }

  // --- 2. FETCH DASHBOARD ITEMS ---
  try {
    const rawItems = dash.dashboardItems || [];
    rawItems.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const items = await pMap(
      rawItems,
      async (item, idx) => {
        const base = {
          index: idx,
          type: item.type,
          name: item.displayName || item.name || `${item.type} ${idx + 1}`,
          position: { x: item.x, y: item.y, w: item.w, h: item.h },
        };

        if (item.type === "TEXT") {
          return { ...base, text: item.text || "" };
        }

        if (item.type === "MAP") {
          const mapId = item.map?.id || (typeof item.map === "string" ? item.map : null) || item.visualization?.id || null;
          return {
            ...base,
            mapId,
            mapLink: mapId ? `${workingBaseUrl}/dhis-web-maps/#/${mapId}` : null,
            dashboardLink: `${workingBaseUrl}/dhis-web-dashboard/#/${id}`,
          };
        }

        if (item.type !== "VISUALIZATION") {
          return { ...base, skipped: true, reason: `${item.type} not supported` };
        }

        const vizId = typeof item.visualization === "string" ? item.visualization : item.visualization?.id;
        if (!vizId) return { ...base, error: "No visualization linked to this item." };

        try {
          const { viz, dims } = await fetchVizAndDims(vizId, auth, workingBaseUrl);
          const isPivotTable = viz.type === "PIVOT_TABLE";
          const isChartable  = CHARTABLE_TYPES.has(viz.type);

          if (!isPivotTable && !isChartable) {
            return { ...base, name: viz.displayName || base.name, skipped: true, reason: `${viz.type} not supported` };
          }

          const data = await fetchAnalytics(dims, auth, workingBaseUrl);

          if (isPivotTable) {
            return {
              ...base,
              name: viz.displayName || base.name,
              vizType: "PIVOT_TABLE",
              data,
              layout: { columns: viz.columns || [], rows: viz.rows || [], filters: viz.filters || [] },
            };
          }

          return { ...base, name: viz.displayName || base.name, vizType: viz.type, data };

        } catch (err) {
          if (isMissingTableError(err)) {
            return { ...base, error: "Data unavailable: The server's analytics tables are currently being rebuilt. Please try again later." };
          }
          return { ...base, error: err.message };
        }
      },
      5
    );

    res.status(200).json({
      dashboard: { id: dash.id, name: dash.displayName || dash.name || id, itemCount: items.length, loadedAt: new Date().toISOString() },
      items,
    });

  } catch (err) {
    console.error("[dashboard aggregator]", err);
    res.status(500).json({ error: err.message });
  }
}
