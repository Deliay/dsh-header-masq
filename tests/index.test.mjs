import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_TARGETS,
  SOURCE_HEADER,
  apply,
  headersOf,
  mapSessionHeaders,
  patchFetch,
  resolveConfig,
  targetsAllowedHost,
  withStore,
} from '../lib/index.js'
import { AsyncLocalStorage } from 'node:async_hooks'

const SOURCE = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe'

function makeCtx() {
  const listeners = new Map()
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, callback) {
      listeners.set(event, callback)
      return () => listeners.delete(event)
    },
    effect(fn) {
      cleanups.push(fn())
    },
  }
  return { ctx, listeners, cleanups }
}

function fakeOriginal() {
  const calls = []
  const original = async (input, init) => {
    calls.push([input, init])
    return new Response('ok')
  }
  original.calls = calls
  return original
}

test('defaults to mapping the DeepSeek session header onto x-opencode-session', () => {
  const config = resolveConfig()
  assert.equal(config.source, SOURCE_HEADER)
  assert.deepEqual(config.targets, DEFAULT_TARGETS)
  assert.deepEqual(DEFAULT_TARGETS, ['x-opencode-session'])
  assert.equal(config.fallbackToSessionId, true)
  assert.deepEqual(config.hosts, [])
})

test('supports multiple target headers from the same source', () => {
  const config = resolveConfig({ targets: ['x-opencode-session', 'x-session-id', 'X-Session-Id'] })
  assert.deepEqual(config.targets, ['x-opencode-session', 'x-session-id'])
})

test('drops invalid header names and falls back to the default source', () => {
  const config = resolveConfig({ source: 'bad header', targets: ['ok-header', 'bad header', ''] })
  assert.equal(config.source, SOURCE_HEADER)
  assert.deepEqual(config.targets, ['ok-header'])
})

test('copies the value from plain object headers', () => {
  const headers = mapSessionHeaders(
    'https://opencode.ai/zen/go/v1/chat/completions',
    { headers: { [SOURCE_HEADER]: SOURCE } },
    resolveConfig(),
  )
  assert.ok(headers)
  assert.equal(headers.get('x-opencode-session'), SOURCE)
  assert.equal(headers.get(SOURCE_HEADER), SOURCE)
})

test('copies the value when headers are a Headers instance', () => {
  const headers = mapSessionHeaders(
    'https://example.test',
    { headers: new Headers({ [SOURCE_HEADER]: SOURCE }) },
    resolveConfig(),
  )
  assert.equal(headers?.get('x-opencode-session'), SOURCE)
})

test('copies from a Request when init has no headers', () => {
  const config = resolveConfig()
  const request = new Request('https://example.test', {
    headers: { [SOURCE_HEADER]: SOURCE },
  })
  assert.equal(headersOf(request, undefined).get(SOURCE_HEADER), SOURCE)
  const headers = mapSessionHeaders(request, undefined, config)
  assert.equal(headers?.get('x-opencode-session'), SOURCE)
})

test('leaves requests without the source header untouched when there is no fallback', () => {
  const config = resolveConfig({ fallbackToSessionId: false })
  assert.equal(mapSessionHeaders('https://example.test', { headers: { accept: 'x' } }, config), null)
})

test('overwrites an existing target header with the source value', () => {
  const headers = mapSessionHeaders(
    'https://example.test',
    { headers: { [SOURCE_HEADER]: SOURCE, 'x-opencode-session': 'stale' } },
    resolveConfig(),
  )
  assert.equal(headers?.get('x-opencode-session'), SOURCE)
})

test('copies an empty source header verbatim', () => {
  const headers = mapSessionHeaders(
    'https://example.test',
    { headers: { [SOURCE_HEADER]: '' } },
    resolveConfig(),
  )
  assert.ok(headers)
  assert.equal(headers.get('x-opencode-session'), '')
})

test('an empty source header also triggers the fallback', () => {
  const headers = mapSessionHeaders(
    'https://custom-provider.example/v1/chat/completions',
    { headers: { [SOURCE_HEADER]: '' } },
    resolveConfig(),
    SOURCE,
  )
  assert.equal(headers?.get('x-opencode-session'), SOURCE)
})

test('falls back to the LLM call sessionId when the source header is absent', () => {
  const headers = mapSessionHeaders(
    'https://custom-provider.example/v1/chat/completions',
    { headers: { accept: 'application/json' } },
    resolveConfig(),
    SOURCE,
  )
  assert.equal(headers?.get('x-opencode-session'), SOURCE)
})

test('the source header wins over the fallback sessionId', () => {
  const headers = mapSessionHeaders(
    'https://example.test',
    { headers: { [SOURCE_HEADER]: 'from-header' } },
    resolveConfig(),
    'from-options',
  )
  assert.equal(headers?.get('x-opencode-session'), 'from-header')
})

test('does not use an unsafe fallback header value', () => {
  const config = resolveConfig()
  assert.equal(mapSessionHeaders('https://example.test', undefined, config, 'bad\nvalue'), null)
  assert.equal(mapSessionHeaders('https://example.test', undefined, config, ''), null)
})

test('host allow-list only limits the fallback, not an explicit source header', () => {
  const config = resolveConfig({ hosts: ['opencode.ai'] })
  assert.equal(targetsAllowedHost('https://opencode.ai/zen/go/v1/chat/completions', config.hosts), true)
  assert.equal(targetsAllowedHost('https://other.example/v1/chat/completions', config.hosts), false)
  // Fallback: blocked on other hosts.
  assert.equal(mapSessionHeaders('https://other.example/v1/chat', undefined, config, SOURCE), null)
  // Explicit source header: still copied.
  const headers = mapSessionHeaders(
    'https://other.example/v1/chat',
    { headers: { [SOURCE_HEADER]: SOURCE } },
    config,
  )
  assert.equal(headers?.get('x-opencode-session'), SOURCE)
})

test('withStore runs downstream pulls inside the store', async () => {
  const als = new AsyncLocalStorage()
  const iterable = {
    async *[Symbol.asyncIterator]() {
      yield als.getStore()?.sessionId
    },
  }
  const wrapped = withStore(iterable, { sessionId: SOURCE }, als)
  const iterator = wrapped[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { done: false, value: SOURCE })
})

test('patched fetch leaves requests untouched outside an LLM stream', async () => {
  const original = fakeOriginal()
  const als = new AsyncLocalStorage()
  const patched = patchFetch(original, resolveConfig(), als)
  const init = { method: 'POST', headers: { accept: 'text/event-stream' } }
  await patched('https://example.test', init)
  assert.equal(original.calls.length, 1)
  assert.equal(original.calls[0][1], init)
})

test('patched fetch uses the active stream sessionId as fallback', async () => {
  const original = fakeOriginal()
  const als = new AsyncLocalStorage()
  const patched = patchFetch(original, resolveConfig(), als)

  await als.run({ sessionId: SOURCE }, () => patched('https://custom.example/v1/chat', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  }))

  const headers = new Headers(original.calls[0][1].headers)
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(headers.get('x-opencode-session'), SOURCE)
})

test('apply installs the fetch patch + stream hook and restores both on dispose', async () => {
  const originalFetch = globalThis.fetch
  const replacement = fakeOriginal()
  globalThis.fetch = replacement
  const { ctx, listeners, cleanups } = makeCtx()
  try {
    apply(ctx, {})
    assert.notEqual(globalThis.fetch, replacement)
    assert.equal(typeof listeners.get('llm/stream'), 'function')

    // A custom provider request: no source header, session id from the waterfall.
    const downstream = {
      async *[Symbol.asyncIterator]() {
        yield await globalThis.fetch('https://custom.example/v1/chat', {
          headers: { accept: 'application/json' },
        })
      },
    }
    const wrapped = listeners.get('llm/stream')({ sessionId: SOURCE }, () => downstream)
    await wrapped[Symbol.asyncIterator]().next()

    const headers = new Headers(replacement.calls[0][1].headers)
    assert.equal(headers.get('x-opencode-session'), SOURCE)

    assert.equal(cleanups.length, 1)
    cleanups[0]()
    assert.equal(globalThis.fetch, replacement)
    assert.equal(listeners.has('llm/stream'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('apply does not clobber a patch installed later', () => {
  const originalFetch = globalThis.fetch
  const { ctx, cleanups } = makeCtx()
  const later = async () => new Response('later')
  try {
    globalThis.fetch = originalFetch
    apply(ctx, {})
    globalThis.fetch = later
    cleanups[0]()
    assert.equal(globalThis.fetch, later)
  } finally {
    globalThis.fetch = originalFetch
  }
})
