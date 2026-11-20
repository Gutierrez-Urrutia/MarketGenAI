/**
 * useJobPolling — polls GET /jobs/:jobId every 2 seconds until
 * the job reaches status "completed" or "failed".
 *
 * Usage:
 *   const { job, isDone, isError } = useJobPolling(jobId)
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { jobsApi } from '@/api/axios'
import { errorText } from '@/api/errorMessages'

const DONE_STATUSES = ['completed', 'succeeded', 'success']
const ERROR_STATUSES = ['failed', 'error', 'cancelled']
// RNF-04: si la API no responde varias veces seguidas, se deja de sondear y se avisa (antes sondeaba para siempre sin decir nada)
export const MAX_CONSECUTIVE_POLL_FAILURES = 5

export function useJobPolling(jobId, { onProgress, onComplete, onError } = {}) {
  const [job,     setJob]     = useState(null)
  const [isDone,  setIsDone]  = useState(false)
  const [isError, setIsError] = useState(false)
  const completedRef = useRef(false)
  const failedRef = useRef(false)
  const failuresRef = useRef(0)

  const poll = useCallback(async () => {
    if (!jobId) return
    try {
      const { data } = await jobsApi.get(jobId)
      failuresRef.current = 0
      setJob(data)
      onProgress?.(Number(data.progress ?? 0))

      const status = String(data.status || '').toLowerCase()
      if (DONE_STATUSES.includes(status) && !completedRef.current) {
        completedRef.current = true
        setIsDone(true)
        onComplete?.(data)
      } else if (ERROR_STATUSES.includes(status) && !failedRef.current) {
        failedRef.current = true
        setIsError(true)
        onError?.(data.error || data.message || 'Job failed')
      }
    } catch (err) {
      console.error('Job poll error:', err)
      failuresRef.current += 1
      if (failuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES && !failedRef.current) {
        failedRef.current = true
        setIsError(true)
        onError?.(errorText('pollingLost'))
      }
    }
  }, [jobId, onProgress, onComplete, onError])

  useEffect(() => {
    setJob(null)
    setIsDone(false)
    setIsError(false)
    completedRef.current = false
    failedRef.current = false
    failuresRef.current = 0
  }, [jobId])

  useEffect(() => {
    if (!jobId || isDone || isError) return

    poll()
    const interval = setInterval(() => {
      if (!isDone && !isError) poll()
      else clearInterval(interval)
    }, 2000)

    return () => clearInterval(interval)
  }, [jobId, isDone, isError, poll])

  return { job, isDone, isError, isRunning: Boolean(jobId) && !isDone && !isError }
}
