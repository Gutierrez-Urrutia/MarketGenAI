import api from "./axios";

export const templatesApi = {
  list: (params) => api.get("/templates", { params }),
};

export const getTemplates = async (params) => {
  const response = await api.get("/templates", { params });
  return response.data?.items ?? response.data?.data ?? response.data ?? [];
};
