import api from "./axios";

const emitProposalUpdated = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("marketgen:proposal-updated"));
  }
};

const withProposalUpdated = async (request) => {
  const response = await request;
  emitProposalUpdated();
  return response;
};

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_TIMEOUT_MS = 180000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const pollProposalJob = async (jobId, proposalId) => {
  const startTime = Date.now();
  const doneStatuses = ["completed", "succeeded", "success"];
  const errorStatuses = ["failed", "error", "cancelled"];

  while (Date.now() - startTime < MAX_POLL_TIMEOUT_MS) {
    const jobRes = await api.get(`/jobs/${jobId}`, { suppressPermissionToast: true });
    const job = jobRes.data;
    const status = String(job?.status || "").toLowerCase();

    if (doneStatuses.includes(status)) {
      const finalProposalId =
        proposalId || job?.result?.proposalId || job?.output?.proposalId || job?.proposal_id;
      if (finalProposalId) {
        const propRes = await api.get(`/proposals/${finalProposalId}`);
        return propRes.data;
      }
      return job?.result || job;
    }

    if (errorStatuses.includes(status)) {
      throw new Error(job?.error || job?.message || "Proposal generation failed");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Proposal generation timed out");
};

export const proposalsApi = {
  list: () => api.get("/proposals"),
  create: (data) => withProposalUpdated(api.post("/proposals", data)),
  update: (id, data) => withProposalUpdated(api.put(`/proposals/${id}`, data)),
  delete: (id) => api.delete(`/proposals/${id}`),
  generateDraft: async (data) => {
    const response = await withProposalUpdated(api.post("/proposals/generate-draft", data));
    if (response.data && response.data.job_id) {
      const finalProposal = await pollProposalJob(response.data.job_id, response.data.proposal_id);
      emitProposalUpdated();
      return { ...response, data: finalProposal };
    }
    return response;
  },
  downloadPdf: (id) =>
    api.get(`/proposals/${id}/download`, { params: { format: "pdf" }, responseType: "blob" }),
  downloadDocx: (id) =>
    api.get(`/proposals/${id}/download`, { params: { format: "docx" }, responseType: "blob" }),
};

export const getProposals = async () => {
  const response = await api.get("/proposals");
  return response.data;
};
export const createProposal = async (data) => {
  const response = await withProposalUpdated(api.post("/proposals", data));
  return response.data;
};
export const updateProposal = (id, data) => withProposalUpdated(api.put(`/proposals/${id}`, data));
export const deleteProposal = (id) => api.delete(`/proposals/${id}`);

export const generateProposalDraft = async (data) => {
  const response = await withProposalUpdated(api.post("/proposals/generate-draft", data, { timeout: 0 }));
  if (response.data && response.data.job_id) {
    const finalProposal = await pollProposalJob(response.data.job_id, response.data.proposal_id);
    emitProposalUpdated();
    return finalProposal;
  }
  return response.data;
};
export const generateProposalById = async (id, data) => {
  const response = await withProposalUpdated(api.post(`/proposals/${id}/generate`, data, { timeout: 0 }));
  if (response.data && response.data.job_id) {
    const finalProposal = await pollProposalJob(response.data.job_id, id || response.data.proposal_id);
    emitProposalUpdated();
    return finalProposal;
  }
  return response.data;
};
export const downloadProposalPdf = (id) =>
  api.get(`/proposals/${id}/download`, { params: { format: "pdf" }, responseType: "blob" });

export const downloadProposalDocx = (id) =>
  api.get(`/proposals/${id}/download`, { params: { format: "docx" }, responseType: "blob" });

export const updateProposalStatus = (id, status) =>
  withProposalUpdated(api.patch(`/proposals/${id}/status`, { status }));
