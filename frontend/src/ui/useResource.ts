/**
 * A data-loading hook for read paths.
 *
 * <p>Two things it gets right that a naive `useEffect` + `setState` gets wrong:
 *
 * <ul>
 *   <li><b>Out-of-order responses are discarded.</b> Typing in a search box fires four
 *       requests; if the third resolves after the fourth, applying it blindly shows
 *       results for a query the user has already moved on from. Each load carries a
 *       generation number and only the newest may write state.</li>
 *   <li><b>Unmounting is safe.</b> A response arriving after the component is gone
 *       would set state on a dead component; React logs a warning and, worse, the work
 *       is wasted.</li>
 * </ul>
 *
 * <p>It does no caching and no background polling. Live updates arrive over the
 * WebSocket and trigger {@link Resource.reload}, which is why there is no timer here:
 * two independent update paths would fight over the same state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/client'

export interface Resource<T> {
  data: T | undefined
  error: ApiError | null
  loading: boolean
  reload: () => void
}

export function useResource<T>(loader: () => Promise<T>, deps: readonly unknown[]): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [generation, setGeneration] = useState(0)

  const loaderRef = useRef(loader)
  loaderRef.current = loader

  // Monotonic counter; only the newest generation may commit its result.
  const issued = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const ticket = ++issued.current
    setLoading(true)

    loaderRef
      .current()
      .then((result) => {
        if (!mounted.current || ticket !== issued.current) return
        setData(result)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (!mounted.current || ticket !== issued.current) return
        setError(caught instanceof ApiError ? caught : new ApiError({ status: 0, code: 'CLIENT', message: String(caught) }, 'Request failed'))
      })
      .finally(() => {
        if (!mounted.current || ticket !== issued.current) return
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, generation])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])

  return { data, error, loading, reload }
}