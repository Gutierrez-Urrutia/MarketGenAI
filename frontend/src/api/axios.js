import axios from 'axios'
import toast from 'react-hot-toast'

export const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? '/api/v1' : 'http://127.0.0.1:8000/api/v1')

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
})

const emitMarketgenEvent = (name) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(name))
  }
}

const withMarketgenEvent = (request, eventName) =>
  request.then((response) => {
    emitMarketgenEvent(eventName)
    return response
  })

const ACCESS_TOKEN_KEY = 'marketgen_access_token'
const REFRESH_TOKEN_KEY = 'marketgen_refresh_token'
const USER_KEY = 'marketgen_user'
const EXPIRES_AT_KEY = 'marketgen_expires_at'
const MOCK_REFRESH_TOKEN = 'mock-refresh-token'
const LEGACY_LOCAL_REFRESH_TOKEN = 'local-registered-user'
const AUTH_KEYS = [ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY, EXPIRES_AT_KEY]

const storageOrder = [sessionStorage, localStorage]

function readJson(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function getTokenPayload(token) {
  try {
    const payload = token.split('.')[1]
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

function getExpiresAt(authData) {
  if (authData.expiresAt) return Number(authData.expiresAt)
  if (authData.expiresIn) return Date.now() + Number(authData.expiresIn) * 1000

  const token = authData.accessToken || authData.access_token
  const exp = token ? getTokenPayload(token)?.exp : null
  return exp ? exp * 1000 : null
}

export function normalizeAuthResponse(data = {}) {
  return {
    accessToken: data.accessToken || data.access_token || data.token || '',
    refreshToken: data.refreshToken || data.refresh_token || '',
    user: data.user || data.profile || null,
    expiresIn: data.expiresIn || data.expires_in || null,
    expiresAt: getExpiresAt(data),
  }
}

function getAuthStorage() {
  return storageOrder.find((storage) => storage.getItem(ACCESS_TOKEN_KEY))
}

export const authTokenStore = {
  getAccessToken: () => getAuthStorage()?.getItem(ACCESS_TOKEN_KEY) || null,
  getRefreshToken: () => getAuthStorage()?.getItem(REFRESH_TOKEN_KEY) || null,
  getUser: () => {
    const storage = getAuthStorage()
    return storage ? readJson(storage, USER_KEY) : null
  },
  getExpiresAt: () => {
    const storage = getAuthStorage()
    return storage ? Number(storage.getItem(EXPIRES_AT_KEY) || 0) || null : null
  },
  isAccessTokenValid: () => {
    const token = authTokenStore.getAccessToken()
    if (!token || token.startsWith('local-')) return false

    const expiresAt = authTokenStore.getExpiresAt()
    return !expiresAt || expiresAt > Date.now() + 30000
  },
  setTokens: (data, options = {}) => {
    const authData = normalizeAuthResponse(data)
    const hasRememberOption = Object.prototype.hasOwnProperty.call(options, 'remember')
    const targetStorage = hasRememberOption
      ? (options.remember ? localStorage : sessionStorage)
      : getAuthStorage() || sessionStorage
    const otherStorage = targetStorage === localStorage ? sessionStorage : localStorage

    AUTH_KEYS.forEach((key) => otherStorage.removeItem(key))

    if (authData.accessToken) targetStorage.setItem(ACCESS_TOKEN_KEY, authData.accessToken)
    if (authData.refreshToken) targetStorage.setItem(REFRESH_TOKEN_KEY, authData.refreshToken)
    if (authData.user) targetStorage.setItem(USER_KEY, JSON.stringify(authData.user))
    if (authData.expiresAt) targetStorage.setItem(EXPIRES_AT_KEY, String(authData.expiresAt))

    return authData
  },
  clear: () => {
    storageOrder.forEach((storage) => {
      AUTH_KEYS.forEach((key) => storage.removeItem(key))
      storage.removeItem('marketgen_demo_session')
    })
  },
}

export async function refreshAuthSession() {
  const refreshToken = authTokenStore.getRefreshToken()
  if (!refreshToken) return false
  if (refreshToken === MOCK_REFRESH_TOKEN) return authTokenStore.isAccessTokenValid()
  if (refreshToken === LEGACY_LOCAL_REFRESH_TOKEN) {
    authTokenStore.clear()
    return false
  }

  try {
    const { data } = await axios.post(`${api.defaults.baseURL}/auth/refresh`, { refreshToken })
    authTokenStore.setTokens(data)
    return authTokenStore.isAccessTokenValid()
  } catch {
    authTokenStore.clear()
    return false
  }
}

// Coalesces concurrent refresh attempts (e.g. a batch of dashboard requests
// firing at once) into a single /auth/refresh call instead of one per request.
let refreshPromise = null
function ensureFreshSession() {
  if (!refreshPromise) {
    refreshPromise = refreshAuthSession().finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

api.interceptors.request.use(async (config) => {
  if (!authTokenStore.isAccessTokenValid() && authTokenStore.getRefreshToken()) {
    await ensureFreshSession()
  }

  const token = authTokenStore.getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status
    const originalRequest = error.config

    if (status === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true
      const refreshed = await ensureFreshSession()
      const token = authTokenStore.getAccessToken()
      if (refreshed && token) {
        originalRequest.headers.Authorization = `Bearer ${token}`
        return api(originalRequest)
      }
    }

    if (status === 403 && authTokenStore.getAccessToken() && !originalRequest?.suppressPermissionToast) {
      toast.error('You do not have permission to perform this action.')
    }

    if (status >= 500) {
      toast.error('Server error. Please try again.')
    }

    return Promise.reject(error)
  },
)

export default api

export const authApi = {
  register: async (data, options = {}) => {
    const response = await api.post('/auth/register', data)
    if (!options.noSession) authTokenStore.setTokens(response.data, options)
    return response
  },
  login: async ({ usernameOrEmail, password }, options = {}) => {
    const payload = { usernameOrEmail, password }

    try {
      const response = await api.post('/auth/login', payload)
      authTokenStore.setTokens(response.data, options)
      return response
    } catch (error) {
      const status = error.response?.status
      const canRetryWithEmail = [400, 422].includes(status) && usernameOrEmail.includes('@')

      if (!canRetryWithEmail) throw error

      const response = await api.post('/auth/login', { email: usernameOrEmail, password })
      authTokenStore.setTokens(response.data, options)
      return response
    }
  },
  logout: async () => {
    const refreshToken = authTokenStore.getRefreshToken()
    try {
      if (refreshToken && refreshToken !== MOCK_REFRESH_TOKEN) {
        await api.post('/auth/logout', { refreshToken })
      }
    } finally {
      authTokenStore.clear()
    }
  },
  forgotPassword: (data) => api.post('/auth/forgot-password', data),
  resetPassword: (data) => api.post('/auth/reset-password', data),
}

export const booksApi = {
  list: (params) => api.get('/books', { params }),
  create: (data) => api.post('/books', data),
  get: (id) => api.get(`/books/${id}`),
  getBook: (id) => api.get(`/books/${id}`),
  update: (id, data) => api.put(`/books/${id}`, data),
  updateBook: (id, data) => api.put(`/books/${id}`, data),
  createBook: (data) => api.post('/books', data),
  delete: (id) => api.delete(`/books/${id}`),
  getChapters: (id) => api.get(`/books/${id}`).then((response) => ({
    ...response,
    data: response.data?.chapters ?? [],
  })),
  generateChapters: (id, data) => api.post(`/books/${id}/chapters/generate`, data),
  addChapter: (id, data) => api.post(`/books/${id}/chapters`, data),
  updateChapter: (id, cid, data) => api.put(`/books/${id}/chapters/${cid}`, data),
  reorderChapters: (id, data) => api.put(`/books/${id}/chapters/reorder`, data),
  deleteChapter: (id, cid) => api.delete(`/books/${id}/chapters/${cid}`),
  generateAllContent: (id, data = {}) => api.post(`/books/${id}/content/generate`, data),
  generateChapterContent: (id, cid, data) => api.post(`/books/${id}/chapters/${cid}/content/generate`, data),
  refineContent: (id, cid, data) => api.post(`/books/${id}/chapters/${cid}/content/refine`, data),
  saveContent: (id, cid, data) => api.put(`/books/${id}/chapters/${cid}/content`, data),
}

export const jobsApi = {
  get: (id) => api.get(`/jobs/${id}`),
}

export const proposalsApi = {
  list: (params) => api.get('/proposals', { params }),
  create: (data) => withMarketgenEvent(api.post('/proposals', data), 'marketgen:proposal-updated'),
  get: (id) => api.get(`/proposals/${id}`),
  update: (id, data) => withMarketgenEvent(api.put(`/proposals/${id}`, data), 'marketgen:proposal-updated'),
  delete: (id) => api.delete(`/proposals/${id}`),
  generate: (id, data) => withMarketgenEvent(api.post(`/proposals/${id}/generate`, data), 'marketgen:proposal-updated'),
  export: (id, fmt = 'pdf') => api.get(`/proposals/${id}/download`, {
    params: { format: fmt },
    responseType: 'blob',
  }),
}

export const campaignsApi = {
  list: (params) => api.get('/campaigns', { params }),
  create: (data) => withMarketgenEvent(api.post('/campaigns', data), 'marketgen:campaign-updated'),
  get: (id) => api.get(`/campaigns/${id}`),
  update: (id, data) => withMarketgenEvent(api.put(`/campaigns/${id}`, data), 'marketgen:campaign-updated'),
  delete: (id) => api.delete(`/campaigns/${id}`),
  generate: (id) => withMarketgenEvent(api.post(`/campaigns/${id}/generate`, undefined, { timeout: 60000 }), 'marketgen:campaign-updated'),
}

export const opportunitiesApi = {
  list: (params) => api.get('/opportunities', { params }),
  create: (data) => withMarketgenEvent(api.post('/opportunities', data), 'marketgen:opportunity-updated'),
  get: (id) => api.get(`/opportunities/${id}`),
  update: (id, data) => withMarketgenEvent(api.put(`/opportunities/${id}`, data), 'marketgen:opportunity-updated'),
  delete: (id) => api.delete(`/opportunities/${id}`),
}

export const customersApi = {
  list: (params) => api.get('/customers', { params }),
  create: (data) => api.post('/customers', data),
  get: (id) => api.get(`/customers/${id}`),
  update: (id, data) => api.put(`/customers/${id}`, data),
  delete: (id) => api.delete(`/customers/${id}`),
  import: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post('/customers/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
}

export const templatesApi = {
  list: (params) => api.get('/templates', { params }),
  create: (data) => api.post('/templates', data),
  get: (id) => api.get(`/templates/${id}`),
  update: (id, data) => api.put(`/templates/${id}`, data),
  delete: (id) => api.delete(`/templates/${id}`),
}

export const assetsApi = {
  list: (params) => api.get('/assets', { params }),
  get: (id) => api.get(`/assets/${id}`),
  delete: (id) => api.delete(`/assets/${id}`),
  generateOnePager: (bookId, data) => api.post(`/books/${bookId}/assets/one-pager`, data),
  generateWhitepaper: (bookId, data) => api.post(`/books/${bookId}/assets/whitepaper`, data),
  generateSocialPosts: (bookId, data) => api.post(`/books/${bookId}/assets/social-posts`, data),
  generateInfographic: (bookId, data) => api.post(`/books/${bookId}/assets/infographic`, data),
  download: (id) => api.get(`/assets/${id}/download`, { responseType: 'blob' }),
}

export const settingsApi = {
  get: () => api.get('/settings'),
  update: (data) => api.put('/settings', data),
  put: (data) => api.put('/settings', data),
}

export const socialApi = {
  status: () => api.get('/settings/social/status'),
  connectFacebook: () => api.post('/settings/social/facebook/connect'),
  connectManual: (platform, data) => api.post(`/settings/social/${platform}/manual`, data),
  disconnect: (platform) => api.delete(`/settings/social/${platform}`),
  disconnectFacebook: () => api.delete('/settings/social/facebook'),
  publish: (data) => api.post('/settings/social/publish', data),
}

export const reportsApi = {
  overview: (params) => api.get('/reports/overview', { params }),
  dashboard: (params) => api.get('/reports/dashboard', { params }),
  books: (params) => api.get('/reports/books', { params }),
  proposals: (params) => api.get('/reports/proposals', { params }),
  content: (params) => api.get('/reports/content', { params }),
  export: (params) => api.get('/reports/export', { params, responseType: 'blob' }),
}

export const chatApi = {
  send: (data) => api.post('/chat', data),
  history: (sessionId) => api.get(`/chat/${sessionId}`),
}

export const analysisApi = {
  seo: (data) => api.post('/analysis/seo', data),
  plagiarism: (data) => api.post('/analysis/plagiarism', data),
  aiDetection: (data) => api.post('/analysis/ai-detection', data),
}

export const publishingApi = {
  publish: (bookId, data) => api.post(`/books/${bookId}/publish`, data),
  status: (bookId) => api.get(`/books/${bookId}/publish/status`),
  translate: (bookId, data) => api.post(`/books/${bookId}/translate`, data),
}
