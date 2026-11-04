/**
 * What may be printed about an API call. Used by the axios interceptors
 * (src/api/axios.js) and by components that log a failed call. These logs run
 * in production builds too, so nothing here prints a secret.
 */

// Fields whose name says they hold a secret, wherever they are nested.
export const SECRET_KEY_PATTERN = /password|passwd|secret|token|api_?key|consumer_?key|authorization|credential/i
export const REDACTED = '[redacted]'

// A copy of `value` with secret-named fields replaced. FastAPI's 422 echoes
// the submitted value in `input`: it is hidden when `loc` names a secret field,
// or always with `allInputs` (calls marked logBody: false).
export function redactSecrets(value, { allInputs = false } = {}, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 8) return value
  if (typeof FormData !== 'undefined' && value instanceof FormData) return value
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value
  const options = { allInputs }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, options, depth + 1))
  const hideInput = Array.isArray(value.loc) && (allInputs
    || value.loc.some((part) => typeof part === 'string' && SECRET_KEY_PATTERN.test(part)))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key) || (hideInput && key === 'input') ? REDACTED : redactSecrets(item, options, depth + 1),
  ]))
}

// A request body as it may be logged: JSON text is parsed and redacted.
export function loggableBody(data) {
  if (typeof data !== 'string') return redactSecrets(data)
  try {
    return redactSecrets(JSON.parse(data))
  } catch {
    return data
  }
}

// "METHOD url (duration) - Status: n": never a body, a header or a token.
export function describeApiError(error) {
  const config = error?.config
  if (!config && !error?.response) return `${error?.name || 'Error'}: ${error?.message || ''}`.trim()
  const duration = config?._startTime ? `${Date.now() - config._startTime}ms` : ''
  const status = error?.response?.status || error?.code || 'TIMEOUT/NETWORK_ERR'
  return `${config?.method?.toUpperCase() || ''} ${config?.url || ''} (${duration}) - Status: ${status}`
}

// For components: log a failed call without its request or response.
export function logApiError(context, error) {
  console.error(`❌ [${context}] ${describeApiError(error)}`)
}
