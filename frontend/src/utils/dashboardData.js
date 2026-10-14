import api from "@/api/axios";

export const asArray = (value) => Array.isArray(value)
  ? value
  : Array.isArray(value?.items)
  ? value.items
  : Array.isArray(value?.data)
  ? value.data
  : [];

export async function fetchOptional(endpoint, fallback = null) {
  try {
    const { data } = await api.get(endpoint, { suppressPermissionToast: true });
    return data;
  } catch {
    return fallback;
  }
}
