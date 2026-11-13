import api from "./axios";

// RF-VTA-02 — catálogo de servicios y tipos. Todos leen; crear/editar es solo manager/admin (el servidor lo exige).
export const catalogApi = {
  listServices: (params) => api.get("/catalog/services", { params }),
  getService: (id) => api.get(`/catalog/services/${id}`),
  createService: (data) => api.post("/catalog/services", data),
  updateService: (id, data) => api.patch(`/catalog/services/${id}`, data),
  listServiceTypes: (params) => api.get("/catalog/service-types", { params }),
  createServiceType: (data) => api.post("/catalog/service-types", data),
  updateServiceType: (id, data) => api.patch(`/catalog/service-types/${id}`, data),
};

/** Devuelve `items` de la lista de servicios (acepta los mismos parámetros que la API). */
export const getServices = async (params) => {
  const response = await catalogApi.listServices(params);
  return response.data?.items ?? [];
};

export const getServiceTypes = async (params) => {
  const response = await catalogApi.listServiceTypes(params);
  return response.data?.items ?? [];
};
