import api from "./axios";

export const getDashboardData = async () => {
  const response = await api.get("/reports/dashboard");
  return response.data;
};

export const dashboardApi = {
  getData: getDashboardData,
};