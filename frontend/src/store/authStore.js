/**
 * Zustand store for authentication state.
 * Populated by the ReactKeycloakProvider event callbacks.
 */
import { create } from 'zustand'

const useAuthStore = create((set) => ({
  // ── State ──────────────────────────────────────────────────────────────────
  isAuthenticated: false,
  isLoading:       true,
  user:            null,     // { sub, email, name, preferred_username, roles }
  token:           null,     // raw Keycloak access token

  // ── Actions ────────────────────────────────────────────────────────────────
  setAuthenticated: (keycloak) => {
    const parsed = keycloak.tokenParsed || {}
    set({
      isAuthenticated: true,
      isLoading:       false,
      token:           keycloak.token,
      user: {
        sub:                parsed.sub,
        email:              parsed.email,
        name:               parsed.name,
        preferred_username: parsed.preferred_username,
        roles:              parsed.realm_access?.roles ?? [],
      },
    })
  },

  setUnauthenticated: () =>
    set({ isAuthenticated: false, isLoading: false, user: null, token: null }),

  setLoading: (loading) => set({ isLoading: loading }),

  updateToken: (token) => set({ token }),
}))

export default useAuthStore
