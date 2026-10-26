// dsh-header-masq
//
// DeepSeek Harness stamps every DeepSeek Messages request with
// `x-deepseek-harness-session-id`. Other harnesses (OpenCode / OpenCode Go, ...)
// use their own names for the same per-conversation identity. This plugin
// copies that value onto the configured target headers so a single DSH session
// keeps one stable conversation identity on every outbound request.
//
// The mapping is a pure header copy and only runs when the source header is
// already present, so requests from adapters that do not send it are untouched.

export const name = 'header-masq'

/** No service is required: the fetch patch is installed during setup. */
export const inject = []

/** Header the DeepSeek adapter sends. */
export const SOURCE_HEADER = 'x-deepseek-harness-session-id'

/** Headers added by default. */
export const DEFAULT_TARGETS = ['x-opencode-session']

/** RFC 9110 token characters allowed in a header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Normalize the row config. Invalid target names are dropped instead of
 * breaking every request later.
 *
 * @param {object} [config]
 * @returns {{source: string, targets: string[], debug: boolean}}
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

  return {
    source: HEADER_NAME_RE.test(source) ? source : SOURCE_HEADER,
    targets,
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
 * Build the merged headers for one request.
 *
 * @param {RequestInfo | URL} input
 * @param {RequestInit | undefined} init
 * @param {{source: string, targets: string[]}} config
 * @returns {Headers | null} merged headers, or null when nothing should change.
 */
export function mapSessionHeaders(input, init, config) {
  const headers = headersOf(input, init)
  const value = headers.get(config.source)
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
 * Wrap a fetch implementation. Only requests already carrying the source
 * header are rewritten; everything else is passed through untouched.
 *
 * @param {typeof fetch} original
 * @param {{source: string, targets: string[], debug: boolean}} config
 * @param {(message: string) => void} [log]
 * @returns {typeof fetch}
 */
export function patchFetch(original, config, log) {
  return function patchedFetch(input, init) {
    let headers
    try {
      headers = mapSessionHeaders(input, init, config)
    } catch {
      // A malformed header container/native request must not break the call.
      return original.apply(this, arguments)
    }
    if (headers === null) return original.apply(this, arguments)

    if (config.debug) {
      log?.(`[header-masq] ${config.source} -> ${config.targets.join(', ')}`)
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

  const patched = patchFetch(
    originalFetch,
    resolved,
    (message) => ctx.logger?.info(message),
  )

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger?.info(
      '[header-masq] active: %s -> %s',
      resolved.source,
      resolved.targets.join(', '),
    )
    return () => {
      // Restore only if we are still the active patch, so a patch installed
      // later by another plugin is never clobbered on unload.
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'header-masq.fetch-patch')
}

export default { name, inject, apply }
