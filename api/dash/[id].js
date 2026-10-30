// api/dashboard/[id].js
const DHIS2_BASE = process.env.DHIS2_BASE || "https://play.im.dhis2.org/stable-2-43-2-1";
const DEFAULT_AUTH = process.env.DHIS2_AUTH || "Basic " + Buffer.from("admin:district").toString("base64");

const RELATIVE_PERIOD_MAP = {
  thisDay: "TODAY", yesterday: "YESTERDAY", last3Days: "LAST_3_DAYS", last7Days: "LAST_7_DAYS",
  last14Days: "LAST_14_DAYS", last30Days: "LAST_30_DAYS", lastMonth: "LAST_MONTH", lastBimonth: "LAST_BIMONTH",
  lastQuarter: "LAST_QUARTER", lastSixMonth: "LAST_SIX_MONTH", weeksThisYear: "WEEKS_THIS_YEAR", monthsThisYear: "MONTHS_THIS_YEAR",
  biMonthsThisYear: "BIMONTHS_THIS_YEAR", quartersThisYear: "QUARTERS_THIS_YEAR", thisYear: "THIS_YEAR", monthsLastYear: "MONTHS_LAST_YEAR",
  quartersLastYear: "QUARTERS_LAST_YEAR", lastYear: "LAST_YEAR", last5Years: "LAST_5_YEARS", last12Months: "LAST_12_MONTHS",
  last6Months: "LAST_6_MONTHS", last3Months: "LAST_3_MONTHS", last6Bimonth: "LAST_6_BIMONTHS", last6Quarter: "LAST_6_QUARTERS",
  last4Quarters: "LAST_4_QUARTERS", last2SixMonths: "LAST_2_SIXMONTHS", thisFinancialYear: "THIS_FINANCIAL_YEAR", lastFinancialYear: "LAST_FINANCIAL_YEAR",
  last5FinancialYears: "LAST_5_FINANCIAL_YEARS", thisMonth: "THIS_MONTH", thisBimonth: "THIS_BIMONTH", thisQuarter: "THIS_QUARTER", thisSixMonth: "THIS_SIX_MONTH",
};

const CHARTABLE_TYPES = new Set([
  "LINE", "AREA", "STACKED_AREA", "YEAR_OVER_YEAR_LINE", "COLUMN", "BAR", "STACKED_COLUMN", "STACKED_BAR", "YEAR_OVER_YEAR_COLUMN",
  "PIE", "RADAR", "GAUGE", "SCATTER", "BUBBLE"
]);

function buildAuth(req) { return req.headers.authorization || DEFAULT_AUTH; }

async function dhisFetch(path, auth) {
  const res = await fetch(`${DHIS2_BASE}${path}`, { headers: { Authorization: auth, Accept: "application/json" } });
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

// Builds query params for Event Charts and Group Set Pivots
function buildQueryParams(viz) {
  const params = [];
  const axes = [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];

  const dataDims = [];
  for (const axis of axes) {
    const dimId = axis.id || axis.dimension;
    if (!dimId || dimId === "pe" || dimId === "ou") continue;
    if (axis.items && axis.items.length) {
      for (const item of axis.items) {
        if (item.id) dataDims.push(item.id);
      }
    } else {
      dataDims.push(dimId);
    }
  }
  for (const d of [...new Set(dataDims)]) params.push(`dimension=${d}`);

  const peItems = [];
  const rel = viz.relativePeriods || {};
  for (const [flag, pid] of Object.entries(RELATIVE_PERIOD_MAP)) {
    if (rel[flag]) peItems.push(pid);
  }
  params.push(`dimension=pe:${peItems.length ? [...new Set(peItems)].join(";") : "LAST_12_MONTHS"}`);

  const ouItems = [];
  if (viz.userOrganisationUnit) ouItems.push("USER_ORGUNIT");
  if (viz.userOrganisationUnitChildren) ouItems.push("USER_ORGUNIT_CHILDREN");
  if (viz.userOrganisationUnitGrandChildren) ouItems.push("USER_ORGUNIT_GRANDCHILDREN");
  if (viz.organisationUnits && Array.isArray(viz.organisationUnits)) {
    for (const ou of viz.organisationUnits) {
      if (ou.id) ouItems.push(ou.id);
    }
  }
  params.push(`dimension=ou:${ouItems.length ? [...new Set(ouItems)].join(";") : "USER_ORGUNIT"}`);

  return params;
}

// Standard Aggregate Chart logic (dx + pe + ou)
async function fetchStandardAnalytics(dims, auth) {
  const buildUrl = dxItems => {
    const params = [`dimension=dx:${dxItems.join(";")}`, `dimension=pe:${dims.pe.join(";")}`, `dimension=ou:${dims.ou.join(";")}`];
    return `/api/analytics.json?${params.join("&")}`;
  };
  try { return await dhisFetch(buildUrl(dims.dx), auth); } catch (err) { if (!err.message.includes("E7124") && !err.message.includes("E7102")) throw err; }
  let lastErr;
  for (const metric of ["REPORTING_RATE", "REPORTING_RATE_ON_TIME", "ACTUAL_REPORTS", "ACTUAL_REPORTS_ON_TIME", "EXPECTED_REPORTS"]) {
    const dxWithMetric = dims.dx.map(id => id.includes(".") ? id : `${id}.${metric}`);
    try { return await dhisFetch(buildUrl(dxWithMetric), auth); } catch (err) {
      lastErr = err;
      if (!err.message.includes("E7124") && !err.message.includes("E7102")) throw err;
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing dashboard "id" path parameter' });

  const auth = buildAuth(req);

  try {
    const dash = await dhisFetch(`/api/dashboards/${encodeURIComponent(id)}.json?fields=:all,dashboardItems[:all]`, auth);
    
    // Filter out MESSAGES completely
    let rawItems = (dash.dashboardItems || []).filter(i => i.type !== "MESSAGES");
    rawItems.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const items = [];

    for (let idx = 0; idx < rawItems.length; idx++) {
      const item = rawItems[idx];
      const base = {
        index: idx,
        type: item.type,
        name: item.displayName || item.name || `${item.type} ${idx + 1}`,
        position: { x: item.x, y: item.y, w: item.width, h: item.height },
      };

      // --- 1. SPECIAL WIDGETS ---
      if (item.type === "TEXT") {
        items.push({ ...base, text: item.text || "" });
        continue;
      }
      if (item.type === "USERS") {
        items.push({ ...base, users: item.users || [] });
        continue;
      }
      if (item.type === "REPORTS") {
        try {
          const reportIds = item.reports.map(r => r.id).join(",");
          const reportData = await dhisFetch(`/api/reports.json?filter=id:in:[${reportIds}]&fields=id,displayName`, auth);
          items.push({ ...base, reports: reportData.reports || [] });
        } catch (e) { console.warn("Failed to fetch reports", e.message); }
        continue;
      }
      if (item.type === "APP") {
        items.push({ ...base, appUrl: `${DHIS2_BASE}/dhis-web-apps/apps/${item.appKey}/index.html` });
        continue;
      }
      if (item.type === "RESOURCES") {
        try {
          const resIds = item.resources.map(r => r.id).join(",");
          const resData = await dhisFetch(`/api/documents.json?filter=id:in:[${resIds}]&fields=id,displayName`, auth);
          items.push({ ...base, resources: resData.documents || [] });
        } catch (e) { console.warn("Failed to fetch resources", e.message); }
        continue;
      }
      if (item.type === "MAP") {
        const mapId = item.map?.id || (typeof item.map === "string" ? item.map : null) || item.visualization?.id || null;
        items.push({ ...base, mapId, mapLink: mapId ? `${DHIS2_BASE}/dhis-web-maps/#/${mapId}` : null });
        continue;
      }

      // --- 2. VISUALIZATIONS (Standard, Event, Group Set) ---
      let vizId = null;
      if (item.type === "EVENT_CHART") vizId = item.eventChart?.id || item.eventVisualization?.id;
      else if (item.type === "EVENT_REPORT") vizId = item.eventReport?.id || item.eventVisualization?.id;
      else if (item.type === "EVENT_VISUALIZATION") vizId = item.eventVisualization?.id || item.visualization?.id;
      else if (item.type === "VISUALIZATION") vizId = item.visualization?.id;

      if (!vizId) continue;

      try {
        let viz = null;
        try {
          viz = await dhisFetch(`/api/eventVisualizations/${encodeURIComponent(vizId)}.json`, auth);
        } catch (e) {
          viz = await dhisFetch(`/api/visualizations/${encodeURIComponent(vizId)}.json`, auth);
        }

        if (!viz) continue;

        const axes = [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
        const dxItems = axes.filter(a => (a.id || a.dimension) === "dx").flatMap(a => a.items || []);

        let data = null;
        let isPivotTable = viz.type === "PIVOT_TABLE";

        // A. Event Charts / Reports
        if (viz.program || viz.programStage) {
          const programId = viz.program?.id || viz.program;
          const stageId = viz.programStage?.id || viz.programStage;
          if (programId) {
            const params = buildQueryParams(viz);
            if (stageId) params.push(`stage=${stageId}`);
            data = await dhisFetch(`/api/analytics/events/aggregate/${programId}.json?${params.join("&")}`, auth);
          }
        }
        // B. Group Set Pivot Tables (Disease)
        else if (isPivotTable && dxItems.length === 0) {
          const params = buildQueryParams(viz);
          data = await dhisFetch(`/api/analytics.json?${params.join("&")}`, auth);
        }
        // C. Standard Charts (Delivery)
        else {
          if (dxItems.length > 0) {
            const dims = { dx: dxItems, pe: [], ou: [] };
            const rel = viz.relativePeriods || {};
            for (const [flag, pid] of Object.entries(RELATIVE_PERIOD_MAP)) {
              if (rel[flag]) dims.pe.push(pid);
            }
            if (viz.userOrganisationUnit) dims.ou.push("USER_ORGUNIT");
            if (viz.userOrganisationUnitChildren) dims.ou.push("USER_ORGUNIT_CHILDREN");
            if (viz.userOrganisationUnitGrandChildren) dims.ou.push("USER_ORGUNIT_GRANDCHILDREN");
            
            // Fallbacks for standard charts
            if (!dims.pe.length) dims.pe.push("LAST_12_MONTHS");
            if (!dims.ou.length) dims.ou.push("USER_ORGUNIT");

            data = await fetchStandardAnalytics(dims, auth);
          }
        }

        if (!data || !data.rows || !data.rows.length) {
          items.push({ ...base, name: viz.displayName || base.name, skipped: true, reason: "No data items found" });
          continue;
        }

        if (isPivotTable) {
          items.push({
            ...base,
            name: viz.displayName || base.name,
            vizType: "PIVOT_TABLE",
            data: data,
            layout: { columns: viz.columns || [], rows: viz.rows || [], filters: viz.filters || [] },
          });
        } else {
          items.push({
            ...base,
            name: viz.displayName || base.name,
            vizType: viz.type,
            data: data
          });
        }

      } catch (err) {
        items.push({ ...base, name: base.name, error: err.message });
      }
    }

    res.status(200).json({
      dashboard: { id: dash.id, name: dash.displayName || dash.name || id, itemCount: items.length, loadedAt: new Date().toISOString() },
      items,
    });
  } catch (err) {
    console.error("[dashboard aggregator]", err);
    res.status(500).json({ error: err.message });
  }
}
