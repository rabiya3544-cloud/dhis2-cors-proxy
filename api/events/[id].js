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

    for (const item of rawItems) {
      let vizId = null;

      // 1. Extract IDs based on the exact types we saw in Inpatient Discharge
      if (item.type === "EVENT_CHART") {
        vizId = item.eventChart?.id || item.eventVisualization?.id || item.id;
      } else if (item.type === "EVENT_REPORT") {
        vizId = item.eventReport?.id || item.eventVisualization?.id || item.id;
      } else if (item.type === "EVENT_VISUALIZATION") {
        vizId = item.eventVisualization?.id || item.visualization?.id || item.id;
      } else if (item.type === "VISUALIZATION") {
        vizId = item.visualization?.id || item.id;
      }

      if (!vizId) continue;

      try {
        let viz = null;
        const endpoints = ["eventVisualizations", "eventCharts", "eventReports", "visualizations"];
        
        for (const ep of endpoints) {
          try {
            const ev = await dhisFetch(`/api/${ep}/${encodeURIComponent(vizId)}.json`, auth);
            if (ev) { viz = ev; break; }
          } catch (e) {}
        }

        if (!viz) continue;

        const axes = [...(viz.columns || []), ...(viz.rows || []), ...(viz.filters || [])];
        const dxItems = axes.filter(a => a.dimension === "dx").flatMap(a => a.items || []);

        let data = null;
        let vizType = viz.type;

        // Handle Pivot Tables with group sets (no dx)
        if (viz.type === "PIVOT_TABLE" && dxItems.length === 0) {
          const params = [];
          for (const axis of axes) {
            if (axis.id && axis.id !== "pe" && axis.id !== "ou") {
              params.push(`dimension=${axis.id}`);
            }
          }
          const rel = viz.relativePeriods || {};
          const peItems = [];
          for (const [flag, pid] of Object.entries(RELATIVE_PERIOD_MAP)) {
            if (rel[flag]) peItems.push(pid);
          }
          params.push(`dimension=pe:${peItems.length ? [...new Set(peItems)].join(";") : "LAST_12_MONTHS"}`);
          
          const ouItems = [];
          if (viz.userOrganisationUnit) ouItems.push("USER_ORGUNIT");
          if (viz.userOrganisationUnitChildren) ouItems.push("USER_ORGUNIT_CHILDREN");
          if (viz.userOrganisationUnitGrandChildren) ouItems.push("USER_ORGUNIT_GRANDCHILDREN");
          params.push(`dimension=ou:${ouItems.length ? [...new Set(ouItems)].join(";") : "USER_ORGUNIT"}`);

          data = await dhisFetch(`/api/analytics.json?${params.join("&")}`, auth);
        } 
        // Handle Event Charts / Reports
        else if (viz.program || viz.programStage) {
          data = await fetchEventAnalytics(viz, auth);
        } 
        else {
          continue; // Skip standard charts
        }

        if (!data) continue;

        eventItems.push({
          id: vizId,
          name: viz.displayName || item.displayName || "Event Chart",
          vizType: vizType,
          data: data,
          layout: { columns: viz.columns || [], rows: viz.rows || [], filters: viz.filters || [] },
          position: { x: item.x, y: item.y, w: item.width, h: item.height }
        });

      } catch (e) {
        console.warn(`Events endpoint skipped ${vizId}: ${e.message}`);
      }
    }

    res.status(200).json({ events: eventItems });
  } catch (err) {
    console.error("[events aggregator]", err);
    res.status(500).json({ error: err.message });
  }
}
