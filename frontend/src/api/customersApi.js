import api from "./axios";

export const customersApi = {
  list: (params) => api.get("/customers", { params }),
};

export const getCustomers = async (params) => {
  const response = await api.get("/customers", { params });
  return response.data?.items ?? response.data?.data ?? response.data ?? [];
};
