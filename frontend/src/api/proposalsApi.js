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

export const proposalsApi = {
  list: () => api.get("/proposals"),
  create: (data) => withProposalUpdated(api.post("/proposals", data)),
  update: (id, data) => withProposalUpdated(api.put(`/proposals/${id}`, data)),
  delete: (id) => api.delete(`/proposals/${id}`),
  generateDraft: (data) => withProposalUpdated(api.post("/proposals/generate-draft", data)),
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
  return response.data;
};
export const generateProposalById = async (id, data) => {
  const response = await withProposalUpdated(api.post(`/proposals/${id}/generate`, data, { timeout: 0 }));
  return response.data;
};
export const downloadProposalPdf = (id) =>
  api.get(`/proposals/${id}/download`, { params: { format: "pdf" }, responseType: "blob" });

export const downloadProposalDocx = (id) =>
  api.get(`/proposals/${id}/download`, { params: { format: "docx" }, responseType: "blob" });

export const updateProposalStatus = (id, status) =>
  withProposalUpdated(api.patch(`/proposals/${id}/status`, { status }));
