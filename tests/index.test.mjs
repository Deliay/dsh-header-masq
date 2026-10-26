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
} from '../lib/index.js'

const SOURCE = 'session-05681fd4-1667-4f46-874f-11fd7f10abbe'

test('defaults to mapping the DeepSeek session header onto x-opencode-session', () => {
  const config = resolveConfig()
  assert.equal(config.source, SOURCE_HEADER)
  assert.deepEqual(config.targets, DEFAULT_TARGETS)
  assert.deepEqual(DEFAULT_TARGETS, ['x-opencode-session'])
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
    { headers: { 'x-deepseek-harness-session-id': SOURCE } },
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

test('leaves requests without the source header untouched', () => {
  const config = resolveConfig()
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

test('copies an empty source value verbatim', () => {
  const headers = mapSessionHeaders(
    'https://example.test',
    { headers: { [SOURCE_HEADER]: '' } },
    resolveConfig(),
  )
  assert.ok(headers)
  assert.equal(headers.get('x-opencode-session'), '')
})

test('patched fetch forwards the original call untouched when there is no source header', async () => {
  const calls = []
  const original = async (input, init) => {
    calls.push([input, init])
    return new Response('ok')
  }
  const patched = patchFetch(original, resolveConfig())
  const init = { method: 'POST', headers: { accept: 'text/event-stream' } }
  await patched('https://example.test', init)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], init)
})

test('patched fetch injects the mapped header and preserves other init fields', async () => {
  let seen
  const original = async (input, init) => {
    seen = { input, init }
    return new Response('ok')
  }
  const patched = patchFetch(original, resolveConfig())
  const signal = new AbortController().signal
  await patched('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    body: '{}',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json', [SOURCE_HEADER]: SOURCE },
  })

  assert.equal(seen.input, 'https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.body, '{}')
  assert.equal(seen.init.redirect, 'error')
  assert.equal(seen.init.signal, signal)
  const headers = new Headers(seen.init.headers)
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(headers.get('x-opencode-session'), SOURCE)
  assert.equal(headers.get(SOURCE_HEADER), SOURCE)
})

test('apply installs the patch and restores the previous fetch on dispose', () => {
  const original = globalThis.fetch
  const cleanup = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      cleanup.push(fn())
    },
  }
  try {
    apply(ctx, {})
    const installed = globalThis.fetch
    assert.notEqual(installed, original)
    assert.equal(cleanup.length, 1)
    cleanup[0]()
    assert.equal(globalThis.fetch, original)
  } finally {
    globalThis.fetch = original
  }
})

test('apply does not clobber a patch installed later', () => {
  const original = globalThis.fetch
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      cleanups.push(fn())
    },
  }
  const later = async () => new Response('later')
  try {
    apply(ctx, {})
    globalThis.fetch = later
    cleanups[0]()
    assert.equal(globalThis.fetch, later)
  } finally {
    globalThis.fetch = original
  }
})
