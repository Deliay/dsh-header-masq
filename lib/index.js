// dsh-header-masq
//
// DeepSeek Harness exposes the per-conversation identity of a model call as
// `GenerateOptions.sessionId` on the `llm/stream` waterfall. The DeepSeek
// adapter additionally sends it as `x-deepseek-harness-session-id`, but the
// pi-ai adapter — used by custom / third-party model providers — does not
// implement the DeepSeek wire extensions at all.
//
// This plugin therefore uses the live `options.sessionId` of the model call as
// the canonical value (it is the durable Session id, so all calls of one
// session share one value and a new session gets a new one). When no live
// session id is available, it falls back to an existing
// `x-deepseek-harness-session-id` request header sent by the DeepSeek adapter.
//
// Only requests issued inside an LLM stream receive the live session id, so
// non-model HTTP traffic is not touched.

import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'header-masq'

/** Requires the LLM service so the `llm/stream` waterfall exists. */
export const inject = ['llm']

/** Header the DeepSeek adapter sends. */
export const SOURCE_HEADER = 'x-deepseek-harness-session-id'

/** Headers added by default. */
export const DEFAULT_TARGETS = ['x-opencode-session']

/** RFC 9110 token characters allowed in a header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Visible ASCII only: the subset `Headers.set` can always send as a ByteString. */
const HEADER_VALUE_RE = /^[\x20-\x7e]+$/

/**
 * Normalize the row config. Invalid target names are dropped instead of
 * breaking every request later.
 *
 * @param {object} [config]
 * @returns {{source: string, targets: string[], fallbackToSessionId: boolean, hosts: string[], debug: boolean}}
 */
export function resolveConfig(config = {}) {
  const source = typeof config?.source === 'string' && config.source.trim() !== ''
    ? config.source.trim().toLowerCase()
    : SOURCE_HEADER

  const rawTargets = Array.isArray(config?.targets) && config.targets.length > 0
    ? config.targets
    : DEFAULT_TARGETS

  const targets = [...new Set(
    rawTargets
      .map((target) => String(target).trim().toLowerCase())
      .filter((target) => HEADER_NAME_RE.test(target)),
  )]

  const hosts = Array.isArray(config?.hosts)
    ? [...new Set(
        config.hosts
          .map((host) => String(host).trim().toLowerCase())
          .filter((host) => host !== ''),
      )]
    : []

  return {
    source: HEADER_NAME_RE.test(source) ? source : SOURCE_HEADER,
    targets,
    fallbackToSessionId: config?.fallbackToSessionId !== false,
    hosts,
    debug: config?.debug === true,
  }
}

/**
 * Read the headers a fetch call would send, following native precedence:
 * `init.headers` wins, otherwise a `Request`'s headers are the base.
 *
 * @param {RequestInfo | URL} input
 * @param {RequestInit | undefined} init
 * @returns {Headers}
 */
export function headersOf(input, init) {
  if (init?.headers !== undefined) return new Headers(init.headers)
  if (typeof Request !== 'undefined' && input instanceof Request) return new Headers(input.headers)
  return new Headers()
}

/**
 * True when the request target is allowed by an optional host allow-list.
 * An empty list allows every host, which is the default and keeps one session's
 * id identical across all of its provider requests.
 *
 * @param {RequestInfo | URL} input
 * @param {string[]} hosts
 * @returns {boolean}
 */
export function targetsAllowedHost(input, hosts) {
  if (hosts.length === 0) return true
  try {
    const raw = typeof input === 'string' ? input : input?.url
    if (typeof raw !== 'string') return false
    return hosts.includes(new URL(raw).host.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Build the merged headers for one request.
 *
 * The active model call's `sessionId` is the canonical value: it is the
 * durable Session id, so every request of one session gets the same value and a
 * new session gets a new one. The source header is only used when no live
 * session id is available (for example an adapter call outside the agent loop).
 *
 * @param {RequestInfo | URL} input
 * @param {RequestInit | undefined} init
 * @param {{source: string, targets: string[], fallbackToSessionId: boolean, hosts: string[]}} config
 * @param {string} [sessionId]
 * @returns {Headers | null} merged headers, or null when nothing should change.
 */
export function mapSessionHeaders(input, init, config, sessionId) {
  if (!targetsAllowedHost(input, config.hosts)) return null

  const headers = headersOf(input, init)

  let value = null
  if (config.fallbackToSessionId
    && typeof sessionId === 'string'
    && HEADER_VALUE_RE.test(sessionId)) {
    // Canonical: the durable DSH Session id of this model call. It is identical
    // on every turn of the session and differs for every other session.
    value = sessionId
  } else {
    const fromHeader = headers.get(config.source)
    if (fromHeader !== null) value = fromHeader
  }
  if (value === null) return null

  let changed = false
  for (const target of config.targets) {
    if (headers.get(target) === value) continue
    headers.set(target, value)
    changed = true
  }
  return changed ? headers : null
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store. The provider adapter performs its HTTP request
 * while the iterator is pulled, so the patched fetch can see the store.
 *
 * @param {AsyncIterable<any>} iterable
 * @param {{sessionId?: string}} store
 * @param {AsyncLocalStorage<{sessionId?: string}>} als
 * @returns {AsyncIterable<any>}
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/**
 * Wrap a fetch implementation. Inside an LLM stream the call's session id is
 * always used, so every request of one session gets exactly the same value.
 * Outside a stream an existing source header is copied when present.
 *
 * @param {typeof fetch} original
 * @param {{source: string, targets: string[], fallbackToSessionId: boolean, hosts: string[], debug: boolean}} config
 * @param {AsyncLocalStorage<{sessionId?: string}>} als
 * @param {(message: string) => void} [log]
 * @returns {typeof fetch}
 */
export function patchFetch(original, config, als, log) {
  return function patchedFetch(input, init) {
    let headers
    try {
      const store = als.getStore()
      headers = mapSessionHeaders(input, init, config, store?.sessionId)
    } catch {
      // A malformed header container/native request must not break the call.
      return original.apply(this, arguments)
    }
    if (headers === null) return original.apply(this, arguments)

    if (config.debug) {
      const store = als.getStore()
      log?.(`[header-masq] ${config.source} -> ${config.targets.join(', ')}`
        + (store?.sessionId === undefined ? '' : ` (session ${store.sessionId})`))
    }

    const nextInit = init === undefined || init === null
      ? { headers }
      : { ...init, headers }
    return original.call(this, input, nextInit)
  }
}

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  if (resolved.targets.length === 0) {
    ctx.logger?.warn('[header-masq] no valid target headers configured; plugin is idle')
    return
  }

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger?.warn('[header-masq] globalThis.fetch is unavailable; cannot mirror session headers')
    return
  }

  const als = new AsyncLocalStorage()
  const patched = patchFetch(
    originalFetch,
    resolved,
    als,
    (message) => ctx.logger?.info(message),
  )

  ctx.effect(() => {
    globalThis.fetch = patched

    const off = ctx.on('llm/stream', (options, next) => {
      const downstream = next()
      if (downstream === undefined || downstream === null) return downstream
      if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

      const raw = options?.sessionId
      const sessionId = raw === undefined || raw === null ? undefined : String(raw)
      if (sessionId === undefined) return downstream
      return withStore(downstream, { sessionId }, als)
    }, { prepend: true })

    ctx.logger?.info(
      '[header-masq] active: %s -> %s (fallbackToSessionId=%s%s)',
      resolved.source,
      resolved.targets.join(', '),
      resolved.fallbackToSessionId,
      resolved.hosts.length === 0 ? '' : `, hosts=${resolved.hosts.join(',')}`,
    )

    return () => {
      off?.()
      // Restore only if we are still the active patch, so a patch installed
      // later by another plugin is never clobbered on unload.
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'header-masq')
}

export default { name, inject, apply }
