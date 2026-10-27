/**
 * useTaskPolling — Custom Hook reusable para consultar periódicamente el estado
 * de una tarea asíncrona de Celery en /api/v1/tasks/:taskId cada 2-3 segundos.
 *
 * Uso:
 *   const { isLoading, status, data, error, isDone, isError } = useTaskPolling(taskId, {
 *     interval: 2500,
 *     onComplete: (result) => console.log('Tarea completada:', result),
 *     onError: (err) => console.error('Error en tarea:', err),
 *   })
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { tasksApi } from '@/api/axios'

const TERMINAL_STATUSES = ['SUCCESS', 'FAILURE']

export function useTaskPolling(taskId, options = {}) {
  const {
    interval = 2500,
    onComplete,
    onError,
    enabled = true,
  } = options

  const [status, setStatus] = useState(null)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [task, setTask] = useState(null)

  const completedRef = useRef(false)
  const failedRef = useRef(false)

  const poll = useCallback(async () => {
    if (!taskId || !enabled) return

    try {
      const response = await tasksApi.getStatus(taskId)
      const taskData = response.data || {}
      setTask(taskData)

      const currentStatus = String(taskData.status || '').toUpperCase()
      setStatus(currentStatus)

      if (currentStatus === 'SUCCESS' && !completedRef.current) {
        completedRef.current = true
        setData(taskData.result)
        setError(null)
        onComplete?.(taskData.result)
      } else if (currentStatus === 'FAILURE' && !failedRef.current) {
        failedRef.current = true
        const errorMessage = taskData.error || 'La tarea en segundo plano falló'
        setError(errorMessage)
        onError?.(errorMessage)
      }
    } catch (err) {
      console.error(`[useTaskPolling] Error consultando tarea ${taskId}:`, err)
      const networkError = err.response?.data?.detail || err.message || 'Error de conexión'
      setError(networkError)
    }
  }, [taskId, enabled, onComplete, onError])

  // Reset state when taskId changes
  useEffect(() => {
    setStatus(null)
    setData(null)
    setError(null)
    setTask(null)
    completedRef.current = false
    failedRef.current = false
  }, [taskId])

  // Polling loop
  useEffect(() => {
    if (!taskId || !enabled) return

    const isTerminal = status && TERMINAL_STATUSES.includes(status)
    if (isTerminal) return

    // Consulta inicial inmediata
    poll()

    const timer = setInterval(() => {
      if (!completedRef.current && !failedRef.current) {
        poll()
      } else {
        clearInterval(timer)
      }
    }, interval)

    return () => clearInterval(timer)
  }, [taskId, enabled, status, interval, poll])

  const isDone = status === 'SUCCESS'
  const isError = status === 'FAILURE' || Boolean(error)
  const isLoading = Boolean(taskId) && enabled && !isDone && !isError

  return {
    isLoading,
    status,
    data,
    error,
    isDone,
    isError,
    task,
    refetch: poll,
  }
}
