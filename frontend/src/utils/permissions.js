export const isAdminUser = (user = {}) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.includes("admin");
};

// RNF-02: el registro de auditoría lo consulta solo un administrador (el backend responde 403 al resto).
export const canViewAuditLogs = (user = {}) => isAdminUser(user);

// RF-VTA-01: cualquier usuario carga documentos a la base de conocimiento de la empresa; solo manager y admin los eliminan.
export const canDeleteKnowledge = (user = {}) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.includes("admin") || roles.includes("manager");
};

// RF-VTA-02: solo manager y admin crean, editan y desactivan servicios del catálogo.
export const canManageCatalog = (user = {}) => {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  return roles.includes("admin") || roles.includes("manager");
};
