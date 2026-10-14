/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: UNIFIED DASHBOARD                                        */
/* ═══════════════════════════════════════════════════════════════ */
export const DEMO_OPPORTUNITIES = [
  { company: "FinServe Global", job: "Data Entry Specialist", contact: "Sarah Chen", role: "VP Operations", stage: "Replied", score: 92, source: "JSearch", kw: ["data entry","back office"], content: "BPO Guide for Finance", date: "Apr 15" },
  { company: "MedTech Inc", job: "Customer Support Lead", contact: "James Wilson", role: "Head of HR", stage: "Contacted", score: 87, source: "Indeed", kw: ["customer support"], content: "Support Excellence", date: "Apr 15" },
  { company: "RetailMax", job: "Accounts Payable Clerk", contact: "Ana Ruiz", role: "Procurement Mgr", stage: "Detected", score: 78, source: "JSearch", kw: ["accounting","BPO"], content: "-", date: "Apr 14" },
  { company: "LogiCorp", job: "Back Office Manager", contact: "Mike Ross", role: "COO", stage: "Won", score: 95, source: "RSS", kw: ["back office","outsourcing"], content: "Outsourcing Playbook", date: "Apr 12" },
  { company: "StartupXYZ", job: "Virtual Assistant", contact: "Lisa Park", role: "Founder", stage: "In Conversation", score: 65, source: "Scraper", kw: ["outsourcing"], content: "Follow-up Template", date: "Apr 10" },
  { company: "DataFlow Inc", job: "Data Analyst", contact: "Tom Brown", role: "VP Data", stage: "Customer", score: 88, source: "JSearch", kw: ["data entry"], content: "Data Entry Services", date: "Mar 28" },
];

export const DEMO_REVIEW_EMAILS = [
  { to: "Sarah Chen", role: "VP Operations", company: "FinServe Global", vacancy: "Data Entry Specialist", score: 92, contentRef: "BPO Guide for Finance", subject: "Optimize your data entry with NoonDalton", preview: "Dear Sarah,\n\nI noticed that FinServe Global is looking for a Data Entry Specialist. At NoonDalton, we help financial services companies scale their back-office operations with dedicated teams.\n\nDrawing from our experience documented in our BPO Guide for Finance, we've helped similar organizations reduce operational costs by up to 40%.\n\nWould you have 15 minutes this week for a brief call?" },
  { to: "James Wilson", role: "Head of HR", company: "MedTech Inc", vacancy: "Customer Support Lead", score: 74, contentRef: "Support Excellence", subject: "Specialized Customer Support for MedTech", preview: "Dear James,\n\nI saw that MedTech Inc is looking for a Customer Support Lead. At NoonDalton, we have extensive experience providing specialized customer support teams for the healthcare sector.\n\nOur whitepaper on Customer Support Excellence outlines the frameworks we use with healthcare clients.\n\nCould we schedule a 20-minute demo?" },
  { to: "Ana Ruiz", role: "Procurement Mgr", company: "RetailMax", vacancy: "Accounts Payable Clerk", score: 68, contentRef: "Data Entry Services", subject: "Accounts Payable as a Service for RetailMax", preview: "Dear Ana,\n\nI noticed the AP Clerk opening at RetailMax. NoonDalton offers comprehensive accounts payable services that could reduce your operational costs by up to 40%.\n\nOur Data Entry Services proposal for the retail sector details our approach." },
];

export const DEMO_OUTREACH_HISTORY = [
  { name: "Sarah Chen", co: "FinServe Global", subj: "Optimize your data entry...", st: "Replied", stc: "bg-green-100 text-green-700", date: "Apr 15", score: "92%", content: "BPO Guide" },
  { name: "Mike Ross", co: "LogiCorp", subj: "Back office outsourcing...", st: "Opened", stc: "bg-blue-100 text-blue-700", date: "Apr 15", score: "95%", content: "Outsourcing Playbook" },
  { name: "Lisa Park", co: "DataFlow", subj: "Professional data entry...", st: "Sent", stc: "bg-gray-100 text-gray-600", date: "Apr 14", score: "88%", content: "Data Entry Services" },
  { name: "Tom Brown", co: "HealthCo", subj: "BPO customer support...", st: "Opened", stc: "bg-blue-100 text-blue-700", date: "Apr 14", score: "81%", content: "Support Excellence" },
  { name: "Ana Ruiz", co: "RetailMax", subj: "AP as a service...", st: "Bounced", stc: "bg-red-100 text-red-700", date: "Apr 13", score: "68%", content: "Data Entry Services" },
];

export const DEMO_CONTENT_ITEMS = [
  { id: "mock-case-study-finance-guide", title: "BPO Guide for Finance", type: "Case Study", industry: "Finance", services: ["data entry","back office"], status: "Published", uses: 23, date: "Apr 15" },
  { id: "mock-proposal-fintech-bpo", title: "BPO Proposal for Fintech", type: "Proposal", industry: "Finance", services: ["BPO"], status: "Sent", uses: 8, date: "Apr 14" },
  { id: "mock-template-follow-up-email", title: "Follow-up Email", type: "Template", industry: "General", services: ["outreach"], status: "Active", uses: 45, date: "Apr 14" },
  { id: "mock-whitepaper-support-excellence", title: "Customer Support Excellence", type: "Whitepaper", industry: "Healthcare", services: ["customer support"], status: "Published", uses: 12, date: "Apr 12" },
  { id: "mock-case-study-outsourcing-playbook", title: "Outsourcing Playbook 2026", type: "Case Study", industry: "General", services: ["outsourcing","BPO"], status: "Draft", uses: 0, date: "Apr 10" },
  { id: "mock-template-cold-outreach", title: "Cold Outreach - Data Entry", type: "Template", industry: "General", services: ["data entry"], status: "Active", uses: 31, date: "Apr 8" },
  { id: "mock-social-posts-q2", title: "LinkedIn Posts: Q2", type: "Social Post", industry: "General", services: ["brand"], status: "Generating...", uses: 0, date: "Apr 8" },
  { id: "mock-one-pager-finance-bpo", title: "BPO One-Pager for Finance", type: "One-Pager", industry: "Finance", services: ["sales enablement"], status: "Generated", uses: 6, date: "Apr 7" },
  { id: "mock-proposal-data-entry-services", title: "Data Entry Services", type: "Proposal", industry: "Retail", services: ["data entry","accounting"], status: "Accepted", uses: 18, date: "Apr 5" },
];
