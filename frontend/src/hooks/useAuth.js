/**
 * useAuth - convenience hook for accessing auth state.
 */
import { authApi, authTokenStore } from '@/api/axios'

function fallbackUserFromToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    const email = payload.email || payload.preferred_username || payload.sub || ''

    return {
      email,
      name: payload.name || email.split('@')[0] || 'User',
      preferred_username: payload.preferred_username || email,
      roles: payload.roles || payload.realm_access?.roles || [],
    }
  } catch {
    return null
  }
}

export function useAuth() {
  const token = authTokenStore.getAccessToken()
  const storedUser = authTokenStore.getUser()
  const user = storedUser || fallbackUserFromToken(token)

  return {
    user,
    isAuthenticated: authTokenStore.isAccessTokenValid(),
    isLoading: false,
    token,
    logout: async () => {
      await authApi.logout()
      window.location.assign('/login')
    },
    login: () => window.location.assign('/login'),
    hasRole: (role) => user?.roles?.includes(role) ?? false,
  }
}
