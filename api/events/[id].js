// api/events/[id].js
// A dedicated endpoint ONLY for Event Visualizations, leaving standard charts untouched.

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

async function fetchEventAnalytics(viz, auth) {
  let stageId = null;
  if (viz.programStage) stageId = typeof viz.programStage === 'string' ? viz.programStage : viz.programStage.id;
  else if (viz.program) stageId = typeof viz.program === 'string' ? viz.program : viz.program.id;
  if (!stageId) throw new Error("Event visualization missing program or stage ID.");

  const params = [];
  const axes = [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
  
  let peItems = [];
  let ouItems = [];
  
  for (const axis of axes) {
    if (axis.dimension === "pe") {
      if (axis.items && axis.items.length) peItems = axis.items.map(i => i.id);
    } else if (axis.dimension === "ou") {
      if (axis.items && axis.items.length) ouItems = axis.items.map(i => i.id);
    } else {
      if (axis.items && axis.items.length) {
        params.push(`dimension=${axis.dimension}:${axis.items.map(i => i.id).join(";")}`);
      } else {
        params.push(`dimension=${axis.dimension}`);
      }
    }
  }
  
  const rel = viz.relativePeriods || {};
  for (const [flag, pid] of Object.entries(RELATIVE_PERIOD_MAP)) {
    if (rel[flag]) peItems.push(pid);
  }
  if (viz.userOrganisationUnit) ouItems.push("USER_ORGUNIT");
  if (viz.userOrganisationUnitChildren) ouItems.push("USER_ORGUNIT_CHILDREN");
  if (viz.userOrganisationUnitGrandChildren) ouItems.push("USER_ORGUNIT_GRANDCHILDREN");
  
  if (peItems.length) params.push(`dimension=pe:${[...new Set(peItems)].join(";")}`);
  else params.push(`dimension=pe:LAST_12_MONTHS`);
  
  if (ouItems.length) params.push(`dimension=ou:${[...new Set(ouItems)].join(";")}`);
  else params.push(`dimension=ou:USER_ORGUNIT`);

  if (viz.value && viz.value.id) params.push(`value=${viz.value.id}`);
  else if (viz.value) params.push(`value=${viz.value}`);

  const url = `/api/analytics/events/aggregate/${stageId}.json?${params.join("&")}`;
  return await dhisFetch(url, auth);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing dashboard "id"' });

  const auth = buildAuth(req);

  try {
    const dash = await dhisFetch(`/api/dashboards/${encodeURIComponent(id)}.json?fields=:all,dashboardItems[:all]`, auth);
    const rawItems = dash.dashboardItems || [];

    const eventItems = [];

    for (const item of rawItems) {
      if (item.type !== "VISUALIZATION" && item.type !== "EVENT_VISUALIZATION") continue;

      const vizId = 
        (typeof item.visualization === "string" ? item.visualization : item.visualization?.id) ||
        (typeof item.eventVisualization === "string" ? item.eventVisualization : item.eventVisualization?.id) ||
        item.id;

      if (!vizId) continue;

      try {
        // Strictly fetch from the eventVisualizations endpoint
        const viz = await dhisFetch(`/api/eventVisualizations/${encodeURIComponent(vizId)}.json`, auth);
        
        // If it's an event viz, process it
        if (viz.program || viz.programStage) {
          const data = await fetchEventAnalytics(viz, auth);
          eventItems.push({
            id: vizId,
            name: viz.displayName || item.displayName || "Event Chart",
            data: data
          });
        }
      } catch (e) {
        // Not an event viz, ignore
      }
    }

    res.status(200).json({ events: eventItems });
  } catch (err) {
    console.error("[events aggregator]", err);
    res.status(500).json({ error: err.message });
  }
}
