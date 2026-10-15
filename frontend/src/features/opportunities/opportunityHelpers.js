import * as XLSX from "xlsx-js-style";

export const OPPORTUNITY_STAGES = ["All","Detected","Researching","Contacted","Replied","In Conversation","Won","Customer","Lost"];

export const normalizeStageName = (stage = "") => String(stage || "").trim().toLowerCase().replace(/[_-]+/g, " ");

export const stageMatches = (item, stage) => normalizeStageName(item?.stage || item?.status) === normalizeStageName(stage);

const hasEnrichedOpportunityContact = (item = {}) => Boolean(item.contact || item.contactName || item.contact_name || item.contactEmail || item.contact_email);

export const getOpportunityStageCounts = (opportunities = []) => OPPORTUNITY_STAGES.reduce((counts, stage) => ({
  ...counts,
  [stage]: stage === "All" ? opportunities.length : opportunities.filter((item) => stageMatches(item, stage)).length,
}), {});

export const selectOpportunityMetrics = (opportunities = []) => {
  const stageCounts = getOpportunityStageCounts(opportunities);
  return {
    stageCounts,
    detected: stageCounts.Detected || 0,
    researched: opportunities.filter(hasEnrichedOpportunityContact).length,
    contacted: stageCounts.Contacted || 0,
    replied: stageCounts.Replied || 0,
    won: stageCounts.Won || 0,
  };
};

export const validContentRef = (value) => value && !["-", "—", "â€”"].includes(String(value).trim());

export const normalizeOpportunityKeywords = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
};

export const normalizeOpportunity = (item = {}) => ({
  ...item,
  kw: normalizeOpportunityKeywords(item.kw || item.keywords || item.tags),
});

export const exportOpportunitiesWorkbook = (opportunities = []) => {
  const headers = ["Company", "Job", "Contact", "Role", "Stage", "Score", "Source", "Keywords", "Content", "Date"];
  const rows = opportunities.map((o) => [
    o.company || "",
    o.job || "",
    o.contact || "",
    o.role || "",
    o.stage || "",
    Number.isFinite(Number(o.score)) ? Number(o.score) : "",
    o.source || "",
    normalizeOpportunityKeywords(o.kw).join(", "),
    o.content || "",
    o.date || "",
  ]);
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  const headerStyle = {
    fill: { fgColor: { rgb: "1A2B4A" } },
    font: { color: { rgb: "FFFFFF" }, bold: true },
    alignment: { horizontal: "center", vertical: "center" },
    border: {
      top: { style: "thin", color: { rgb: "D9E2EF" } },
      bottom: { style: "thin", color: { rgb: "D9E2EF" } },
      left: { style: "thin", color: { rgb: "D9E2EF" } },
      right: { style: "thin", color: { rgb: "D9E2EF" } },
    },
  };
  const cellBorder = {
    top: { style: "thin", color: { rgb: "D9E2EF" } },
    bottom: { style: "thin", color: { rgb: "D9E2EF" } },
    left: { style: "thin", color: { rgb: "D9E2EF" } },
    right: { style: "thin", color: { rgb: "D9E2EF" } },
  };

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      if (!worksheet[address]) continue;
      worksheet[address].s = row === 0
        ? headerStyle
        : {
          border: cellBorder,
          alignment: { vertical: "top", wrapText: true },
          ...(row % 2 === 0 ? { fill: { fgColor: { rgb: "F8FAFC" } } } : {}),
        };
      if (col === 5 && row > 0 && worksheet[address].v !== "") {
        worksheet[address].t = "n";
        worksheet[address].z = "0";
      }
    }
  }

  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 30 },
    { wch: 22 },
    { wch: 22 },
    { wch: 18 },
    { wch: 10 },
    { wch: 16 },
    { wch: 30 },
    { wch: 34 },
    { wch: 14 },
  ];
  worksheet["!rows"] = [{ hpt: 24 }];
  worksheet["!autofilter"] = { ref: worksheet["!ref"] };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Opportunities");
  XLSX.writeFile(workbook, "opportunities_export.xlsx", { compression: true });
};
