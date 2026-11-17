import api from "./axios";

// RF-VTA-03 — clientes con perfil (industria y tamaño) e historial de propuestas.
// Cada usuario ve solo sus clientes; el servidor lo exige.
export const customersApi = {
  options: () => api.get("/customers/options"),
  list: (params) => api.get("/customers", { params }),
  get: (id) => api.get(`/customers/${id}`),
  create: (data) => api.post("/customers", data),
  update: (id, data) => api.put(`/customers/${id}`, data),
  remove: (id) => api.delete(`/customers/${id}`),
  proposals: (id, params) => api.get(`/customers/${id}/proposals`, { params }),
  importCsv: (file) => {
    const form = new FormData();
    form.append("file", file);
    return api.post("/customers/import", form, { headers: { "Content-Type": "multipart/form-data" } });
  },
};

export const getCustomers = async (params) => {
  const response = await api.get("/customers", { params });
  return response.data?.items ?? response.data?.data ?? response.data ?? [];
};
