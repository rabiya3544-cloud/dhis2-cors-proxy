// api/events/[id].js
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

function buildAuth(req) { return req.headers.authorization || DEFAULT_AUTH; }

async function dhisFetch(path, auth) {
  const res = await fetch(`${DHIS2_BASE}${path}`, { headers: { Authorization: auth, Accept: "application/json" } });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`Expected JSON, got "${ct}"`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}: ${body.message || res.statusText}`);
  }
  return res.json();
}

// Unified parameter builder for both Event charts and Group Set pivots
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

  for (const d of [...new Set(dataDims)]) {
    params.push(`dimension=${d}`);
  }

  // Periods
  const peItems = [];
  const rel = viz.relativePeriods || {};
  for (const [flag, pid] of Object.entries(RELATIVE_PERIOD_MAP)) {
    if (rel[flag]) peItems.push(pid);
  }
  params.push(`dimension=pe:${peItems.length ? [...new Set(peItems)].join(";") : "LAST_12_MONTHS"}`);

  // Org Units
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

  return params.join("&");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing dashboard "id"' });

  const auth = buildAuth(req);

  try {
    const dash = await dhisFetch(`/api/dashboards/${encodeURIComponent(id)}.json?fields=:all,dashboardItems[:all]`, auth);
    const rawItems = dash.dashboardItems || [];

    const eventItems = [];
    const debug = [];

    for (const item of rawItems) {
      let vizId = null;

      if (item.type === "EVENT_CHART") {
        vizId = item.eventChart?.id || item.eventVisualization?.id;
      } else if (item.type === "EVENT_REPORT") {
        vizId = item.eventReport?.id || item.eventVisualization?.id;
      } else if (item.type === "EVENT_VISUALIZATION") {
        vizId = item.eventVisualization?.id || item.visualization?.id;
      } else if (item.type === "VISUALIZATION") {
        vizId = item.visualization?.id;
      }

      if (!vizId) continue;

      try {
        // 1. Try eventVisualizations first (since both Disease and Inpatient use this)
        let viz = null;
        try {
          viz = await dhisFetch(`/api/eventVisualizations/${encodeURIComponent(vizId)}.json`, auth);
        } catch (e) {
          // Fallback to standard visualizations (Disease chart might live here)
          viz = await dhisFetch(`/api/visualizations/${encodeURIComponent(vizId)}.json`, auth);
        }

        if (!viz) continue;

        const axes = [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
        const dxItems = axes.filter(a => (a.id || a.dimension) === "dx").flatMap(a => a.items || []);

        let data = null;

        // --- CASE A: Group Set Pivot Table (Disease) ---
        if (viz.type === "PIVOT_TABLE" && dxItems.length === 0) {
          const params = buildQueryParams(viz);
          data = await dhisFetch(`/api/analytics.json?${params}`, auth);
        } 
        // --- CASE B: Event Chart / Report (Inpatient) ---
        else if (viz.program || viz.programStage) {
          let stageId = viz.programStage?.id || viz.programStage || viz.program?.id || viz.program;
          if (!stageId) throw new Error("Missing program/stage ID");
          
          const params = buildQueryParams(viz);
          data = await dhisFetch(`/api/analytics/events/aggregate/${stageId}.json?${params}`, auth);
        } 
        else {
          continue; // Skip standard charts
        }

        if (!data || !data.rows || !data.rows.length) {
          debug.push(`No data rows for ${vizId} (${viz.displayName})`);
          continue;
        }

        eventItems.push({
          id: vizId,
          name: viz.displayName || item.displayName || "Chart",
          vizType: viz.type,
          data: data,
          layout: { columns: viz.columns || [], rows: viz.rows || [], filters: viz.filters || [] },
          position: { x: item.x, y: item.y, w: item.width, h: item.height }
        });

      } catch (e) {
        debug.push(`Failed ${vizId}: ${e.message}`);
      }
    }

    res.status(200).json({ events: eventItems, _debug: debug });
  } catch (err) {
    console.error("[events aggregator]", err);
    res.status(500).json({ error: err.message });
  }
}
