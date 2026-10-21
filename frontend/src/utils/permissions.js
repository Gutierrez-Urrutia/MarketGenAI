export const isAdminUser = (user = {}) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.includes("admin");
};

export const canViewAuditLogs = (user = {}) => {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return roles.includes("admin") || roles.includes("manager");
};
