/* RNF-04: avisos claros cuando falla un servicio externo o no se llega a la API (sin conexión, tiempo agotado, 5xx, 429).
 * Si el backend manda su propio mensaje (504 «la IA tardó demasiado», 502 «el CRM…», 503 «la base de datos…»), se muestra ese; el
 * detalle técnico (trazas, rutas, claves) nunca llega aquí: el backend lo deja solo en su log. */

const LANGUAGE_KEY = 'marketgen_language'

const TEXTS = {
  es: {
    network: 'No hay conexión con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    timeout: 'El servidor tardó demasiado en responder. Inténtalo de nuevo.',
    server: 'Ocurrió un error en el servidor. Inténtalo de nuevo en unos minutos.',
    rateLimit: 'Hiciste demasiadas solicitudes seguidas. Espera un momento e inténtalo de nuevo.',
    pollingLost: 'Se perdió la conexión con el servidor mientras se completaba la tarea. Revisa la lista y vuelve a intentarlo.',
    taskStalled: 'La tarea no se pudo iniciar: el servicio que la procesa no respondió a tiempo. No se completó; inténtalo de nuevo en unos minutos.',
    taskTooLong: 'La tarea tardó más de lo esperado y no se completó. Revisa la lista y vuelve a intentarlo.',
  },
  en: {
    network: 'Cannot reach the server. Check your connection and try again.',
    timeout: 'The server took too long to respond. Please try again.',
    server: 'A server error occurred. Please try again in a few minutes.',
    rateLimit: 'Too many requests in a row. Wait a moment and try again.',
    pollingLost: 'The connection to the server was lost while the task was running. Check the list and try again.',
    taskStalled: 'The task could not start: the service that processes it did not respond in time. It was not completed; try again in a few minutes.',
    taskTooLong: 'The task took longer than expected and was not completed. Check the list and try again.',
  },
  pt: {
    network: 'Não há conexão com o servidor. Verifique sua conexão e tente novamente.',
    timeout: 'O servidor demorou demais para responder. Tente novamente.',
    server: 'Ocorreu um erro no servidor. Tente novamente em alguns minutos.',
    rateLimit: 'Muitas solicitações seguidas. Aguarde um momento e tente novamente.',
    pollingLost: 'A conexão com o servidor foi perdida enquanto a tarefa era executada. Verifique a lista e tente novamente.',
    taskStalled: 'A tarefa não pôde ser iniciada: o serviço que a processa não respondeu a tempo. Não foi concluída; tente novamente em alguns minutos.',
    taskTooLong: 'A tarefa demorou mais do que o esperado e não foi concluída. Verifique a lista e tente novamente.',
  },
}

export function currentLanguage() {
  try {
    const stored = String(localStorage.getItem(LANGUAGE_KEY) || '').slice(0, 2).toLowerCase()
    return TEXTS[stored] ? stored : 'es'
  } catch {
    return 'es'
  }
}

export function errorText(key, language = currentLanguage()) {
  return (TEXTS[language] || TEXTS.es)[key]
}

/** Texto para el aviso de un error de la API; `null` si ese error no merece un aviso general (4xx de negocio, 401, 403, cancelada). */
export function apiErrorToastMessage(error, language = currentLanguage()) {
  const status = error?.response?.status
  if (!status) {
    if (error?.code === 'ERR_CANCELED') return null
    return error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' ? errorText('timeout', language) : errorText('network', language)
  }
  if (status === 429) return errorText('rateLimit', language)
  if (status >= 500) {
    const data = error?.response?.data
    const own = typeof data?.message === 'string' ? data.message : typeof data?.detail === 'string' ? data.detail : ''
    // Solo se muestra el mensaje del backend si es corto y sin pinta de traza; si no, el genérico.
    if (own && own.length <= 200 && !/traceback|\bFile "|\.py\b|\bat \w+\./i.test(own)) return own
    return errorText('server', language)
  }
  return null
}
