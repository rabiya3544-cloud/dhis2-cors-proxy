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

const REPORTING_METRICS = ["REPORTING_RATE", "REPORTING_RATE_ON_TIME", "ACTUAL_REPORTS", "ACTUAL_REPORTS_ON_TIME", "EXPECTED_REPORTS"];

// BUG FIX 1: include `items` on columns/rows/filters so axes come back fully populated
const VIZ_FIELDS = [
  "id", "displayName", "type",
  "columns[id,dimension,items[id,dimension]]",
  "rows[id,dimension,items[id,dimension]]",
  "filters[id,dimension,items[id,dimension]]",
  "relativePeriods", "userOrganisationUnit", "userOrganisationUnitChildren", "userOrganisationUnitGrandChildren",
  "program", "programStage", "organisationUnits[id]"
].join(",");

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
    throw new Error(`DHIS2 ${res.status}: ${body.message || res.statusText}`);
  }
  return res.json();
}

// BUG FIX 2: extract items from actual axis objects, not just relativePeriods/user flags
function extractDimension(axes, dimension, viz) {
  const items = [];
  for (const axis of axes) {
    if (axis.dimension === dimension && Array.isArray(axis.items)) {
      for (const it of axis.items) if (it?.id) items.push(it.id);
    }
  }
  return [...new Set(items)];
}

function resolvePeriods(viz, axes) {
  const fromItems = extractDimension(axes, "pe", viz);
  if (fromItems.length) return fromItems.join(";");
  const rel = viz.relativePeriods || {};
  const mapped = Object.keys(rel).filter(k => rel[k] && RELATIVE_PERIOD_MAP[k]).map(k => RELATIVE_PERIOD_MAP[k]);
  if (mapped.length) return mapped.join(";");
  return "THIS_YEAR";
}

function resolveOrgUnits(viz, axes) {
  // explicit org units on the visualization
  const explicit = (viz.organisationUnits || []).map(o => o.id).filter(Boolean);
  if (explicit.length) return explicit.join(";");

  // items on the `ou` axis (e.g. a specific district)
  const fromItems = extractDimension(axes, "ou", viz);
  if (fromItems.length) return fromItems.join(";");

  // user-scoped flags
  if (viz.userOrganisationUnit || viz.userOrganisationUnitChildren || viz.userOrganisationUnitGrandChildren) {
    return "USER_ORGUNIT";
  }
  return "USER_ORGUNIT";
}

function allAxes(viz) {
  return [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
}

async function buildAnalyticsQuery(viz, auth) {
  const axes = allAxes(viz);
  const dx = extractDimension(axes, "dx", viz);
  const pe = resolvePeriods(viz, axes);
  const ou = resolveOrgUnits(viz, axes);

  if (!dx.length) return null;

  // skip non-data viz (text, spacer, etc.)
  if (!CHARTABLE_TYPES.has(viz.type) && !["PIVOT_TABLE", "SINGLE_VALUE"].includes(viz.type)) {
    return null;
  }

  const params = new URLSearchParams();
  params.set("dimension", `dx:${dx.join(";")}`);
  params.append("dimension", `pe:${pe}`);
  params.append("dimension", `ou:${ou}`);
  if (viz.program) params.set("program", viz.program.id || viz.program);
  if (viz.programStage) params.set("stage", viz.programStage.id || viz.programStage);

  const url = `/api/analytics.json?${params.toString()}`;
  const data = await dhisFetch(url, auth);

  return {
    id: viz.id,
    name: viz.displayName,
    type: viz.type,
    query: url,
    headers: data.headers || [],
    rows: data.rows || [],
    metaData: data.metaData || {},
  };
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing dashboard id" });
  const auth = buildAuth(req);

  try {
    const dash = await dhisFetch(
      `/api/dashboards/${id}.json?fields=id,displayName,dashboardItems[id,type,visualization[id],chart[id],map[id],reportTable[id]]`,
      auth
    );

    const items = dash.dashboardItems || [];
    const results = [];
    const failures = [];

    for (const item of items) {
      const vizRef = item.visualization || item.chart || item.reportTable;
      if (!vizRef?.id) continue;

      try {
        // BUG FIX 1 in action: fetch with full `fields` so axes include items
        const viz = await dhisFetch(`/api/visualizations/${vizRef.id}.json?fields=${VIZ_FIELDS}`, auth);
        const result = await buildAnalyticsQuery(viz, auth);
        if (result) results.push(result);
        else failures.push({ id: vizRef.id, name: viz.displayName, reason: "unsupported type or no dx" });
      } catch (err) {
        failures.push({ id: vizRef.id, reason: err.message });
      }
    }

    res.status(200).json({
      dashboard: { id: dash.id, name: dash.displayName },
      total: items.length,
      succeeded: results.length,
      failed: failures.length,
      visualizations: results,
      failures,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
