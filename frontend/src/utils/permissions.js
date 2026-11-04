export const canViewAuditLogs = (user = {}) => {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return roles.includes("admin") || roles.includes("manager");
};

// RF-VTA-02: solo manager y admin crean, editan y desactivan servicios del catálogo.
export const canManageCatalog = (user = {}) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.includes("admin") || roles.includes("manager");
};
