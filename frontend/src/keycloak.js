/**
 * Keycloak instance — configured once, shared across the app.
 *
 * Environment variables (set in .env or docker-compose):
 *   VITE_KEYCLOAK_URL          e.g. http://localhost:8080
 *   VITE_KEYCLOAK_REALM        e.g. nd-marketing
 *   VITE_KEYCLOAK_CLIENT_ID    e.g. nd-frontend
 */
import Keycloak from 'keycloak-js'

const keycloak = new Keycloak({
  url:      import.meta.env.VITE_KEYCLOAK_URL      || 'http://localhost:8080',
  realm:    import.meta.env.VITE_KEYCLOAK_REALM    || 'nd-marketing',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'nd-frontend',
})

export default keycloak
