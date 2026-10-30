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
  "PIE", "RADAR", "GAUGE", "SCATTER", "BUBBLE", "PIVOT_TABLE", "SINGLE_VALUE"
]);

const REPORTING_METRICS = new Set([
  "REPORTING_RATE", "REPORTING_RATE_ON_TIME", "ACTUAL_REPORTS", "ACTUAL_REPORTS_ON_TIME", "EXPECTED_REPORTS"
]);

// BUG FIX 1: request items on columns/rows/filters so axes are fully populated
const VIZ_FIELDS = [
  "id", "displayName", "type",
  "columns[id,dimension,items[id,dimension]]",
  "rows[id,dimension,items[id,dimension]]",
  "filters[id,dimension,items[id,dimension]]",
  "relativePeriods",
  "userOrganisationUnit", "userOrganisationUnitChildren", "userOrganisationUnitGrandChildren",
  "program[id]", "programStage[id]", "organisationUnits[id]"
].join(",");

const DASHBOARD_FIELDS = [
  "id", "displayName",
  "dashboardItems[id,type,visualization[id,displayName,type],chart[id,displayName,type],reportTable[id,displayName,type],map[id,displayName]]"
].join(",");

function buildAuth(req) {
  return req.headers.authorization || DEFAULT_AUTH;
}

async function dhisFetch(path, auth) {
  const res = await fetch(`${DHIS2_BASE}${path}`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
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

function allAxes(viz) {
  return [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
}

// BUG FIX 2: read dimension items from the actual axis objects
function extractDimension(axes, dimension) {
  const items = [];
  for (const axis of axes) {
    if (axis.dimension === dimension && Array.isArray(axis.items)) {
      for (const it of axis.items) if (it?.id) items.push(it.id);
    }
  }
  return [...new Set(items)];
}

function resolvePeriods(viz, axes) {
  const fromItems = extractDimension(axes, "pe");
  if (fromItems.length) return fromItems.join(";");
  const rel = viz.relativePeriods || {};
  const mapped = Object.keys(rel)
    .filter(k => rel[k] && RELATIVE_PERIOD_MAP[k])
    .map(k => RELATIVE_PERIOD_MAP[k]);
  if (mapped.length) return mapped.join(";");
  return "THIS_YEAR";
}

function resolveOrgUnits(viz, axes) {
  const explicit = (viz.organisationUnits || []).map(o => o.id).filter(Boolean);
  if (explicit.length) return explicit.join(";");

  const fromItems = extractDimension(axes, "ou");
  if (fromItems.length) return fromItems.join(";");

  if (viz.userOrganisationUnit || viz.userOrganisationUnitChildren || viz.userOrganisationUnitGrandChildren) {
    return "USER_ORGUNIT";
  }
  return "USER_ORGUNIT";
}

function resolveProgram(viz) {
  const p = viz.program;
  return p?.id || p || null;
}
function resolveStage(viz) {
  const s = viz.programStage;
  return s?.id || s || null;
}

function isReportingRate(dx) {
  return dx.length > 0 && dx.every(id => REPORTING_METRICS.has(id));
}

async function fetchAnalytics(viz, auth) {
  const axes = allAxes(viz);
  const dx = extractDimension(axes, "dx");
  if (!dx.length) return null;
  if (!CHARTABLE_TYPES.has(viz.type)) return null;

  const pe = resolvePeriods(viz, axes);
  const ou = resolveOrgUnits(viz, axes);
  const program = resolveProgram(viz);
  const stage = resolveStage(viz);

  // Reporting rates use a dedicated endpoint in some DHIS2 versions
  if (isReportingRate(dx)) {
    const params = new URLSearchParams();
    params.set("dimension", `dx:${dx.join(";")}`);
    params.append("dimension", `pe:${pe}`);
    params.append("dimension", `ou:${ou}`);
    const url = `/api/analytics.json?${params.toString()}`;
    try {
      const data = await dhisFetch(url, auth);
      return { id: viz.id, name: viz.displayName, type: viz.type, query: url, headers: data.headers || [], rows: data.rows || [], metaData: data.metaData || {} };
    } catch (err) {
      // fall through to standard query below
    }
  }

  const params = new URLSearchParams();
  params.set("dimension", `dx:${dx.join(";")}`);
  params.append("dimension", `pe:${pe}`);
  params.append("dimension", `ou:${ou}`);
  if (program) params.set("program", program);
  if (stage) params.set("stage", stage);

  const url = `/api/analytics.json?${params.toString()}`;
  const data = await dhisFetch(url, auth);
  return { id: viz.id, name: viz.displayName, type: viz.type, query: url, headers: data.headers || [], rows: data.rows || [], metaData: data.metaData || {} };
}

async function fetchMap(mapRef, auth) {
  // Maps don't use /api/analytics.json; fetch their own data payload
  const url = `/api/maps/${mapRef.id}/data.json`;
  const data = await dhisFetch(url, auth);
  return {
    id: mapRef.id,
    name: mapRef.displayName || mapRef.id,
    type: "MAP",
    query: url,
    mapData: data,
  };
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Missing dashboard id" });
  const auth = buildAuth(req);

  try {
    const dash = await dhisFetch(`/api/dashboards/${id}.json?fields=${DASHBOARD_FIELDS}`, auth);

    const items = dash.dashboardItems || [];
    const results = [];
    const failures = [];

    for (const item of items) {
      if (!item?.type) continue;

      // Map items
      if (item.type === "MAP" && item.map?.id) {
        try {
          results.push(await fetchMap(item.map, auth));
        } catch (err) {
          failures.push({ id: item.map.id, name: item.map.displayName, type: "MAP", reason: err.message });
        }
        continue;
      }

      // Visualization / chart / reportTable items
      const vizRef = item.visualization || item.chart || item.reportTable;
      if (!vizRef?.id) continue;

      try {
        // BUG FIX 1: fetch with full `fields` so axes include items
        const viz = await dhisFetch(`/api/visualizations/${vizRef.id}.json?fields=${VIZ_FIELDS}`, auth);
        const result = await fetchAnalytics(viz, auth);
        if (result) results.push(result);
        else failures.push({ id: vizRef.id, name: viz.displayName, type: viz.type, reason: "unsupported type or no dx" });
      } catch (err) {
        failures.push({ id: vizRef.id, name: vizRef.displayName, type: vizRef.type, reason: err.message });
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
