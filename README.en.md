# dsh-header-masq

A DeepSeek Harness (`dsh`) **0.2.1-rc.2** plugin that exposes the current
session id through the session headers other harnesses understand.

Default mapping:

```http
x-deepseek-harness-session-id: session-05681fd4-...
x-opencode-session:            session-05681fd4-...
```

## Why `x-deepseek-harness-session-id` is empty / missing

This is an adapter difference in DSH 0.2.1-rc.2, not a plugin bug:

| Adapter | Used for | Sends `x-deepseek-harness-session-id` |
|---|---|---|
| `@deepseek-ai/dsh-llm-deepseek` | `deepseek-official`, custom Messages-compatible `baseURL` | **Yes**, set to `GenerateOptions.sessionId` |
| `@deepseek-ai/dsh-llm-pi-ai` | custom providers, OpenAI/Anthropic-compatible routes, pi-ai catalog providers | **No** |

`dsh-llm-pi-ai` only forwards `sessionId` into pi-ai's `streamSimple`; the DSH
wire-extension headers exist only in `dsh-llm-deepseek`. So for a **custom model
provider** the header is absent, not present with an empty value. Direct calls
without a Session omit it too.

The plugin therefore uses **`GenerateOptions.sessionId` from `llm/stream` as
the canonical value**:

- It is the durable DSH Session id, so the main conversation, title
  generation, compaction, and retries of one session all use the same value.
- Custom providers / pi-ai that lack `x-deepseek-harness-session-id` use it
  directly.
- A new DSH session gets a new Session id, so the ssid changes automatically.
- The source header is read only when no live session id is available (for
  example a call outside a model stream).

### Stability guarantee

| Case | `x-opencode-session` |
|---|---|
| Turns 1, 2, N of the same session | exactly the same |
| Title generation / compaction / retry in the same session | exactly the same |
| Custom provider vs DeepSeek adapter in the same session | exactly the same |
| A different session | a new, different value |
| Continuing the same session after a restart | still the same (durable Session id, not random) |

The plugin never generates a new id per request and never shares one fixed id
across sessions.

## Behavior

- Inside a model stream, writes the call's durable `sessionId` to
  `x-opencode-session`.
- Without a live `sessionId`, reads `x-deepseek-harness-session-id` and writes
  the same value.
- Overwrites an existing target so a stale session value cannot survive.
- Handles `Headers`, plain objects, and `Request` inputs.
- Restores the original `fetch` and removes the `llm/stream` listener on unload.

## Install

From a local checkout:

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-header-masq
```

Or from GitHub:

```sh
dsh plugin --profile web add github:Deliay/dsh-header-masq
```

Restart the engine after installing. The package ships a `cordis.patch.yml`, so
the plugin row is activated automatically.

## Configuration

The inserted `header-masq` row (see `cordis.patch.yml`) accepts:

| Key | Default | Meaning |
|---|---|---|
| `source` | `x-deepseek-harness-session-id` | header to read when no live session id exists |
| `targets` | `[x-opencode-session]` | headers to set |
| `fallbackToSessionId` | `true` | use `llm/stream`'s `sessionId` as the canonical fixed value |
| `hosts` | `[]` | optional target host allow-list; empty means every host |
| `debug` | `false` | log every applied mapping |

```yaml
- insert:
    - id: header-masq
      name: dsh-header-masq
      config:
        source: x-deepseek-harness-session-id
        targets:
          - x-opencode-session
          - x-session-affinity
        fallbackToSessionId: true
        hosts:
          - opencode.ai
        debug: true
```

## Compatibility

- DSH: `>=0.2.1-rc.2 <0.3.0` (targets 0.2.1-rc.2)
- Node.js: `>=20`
- Depends only on `globalThis.fetch`, the `llm/stream` event, and Cordis
  `ctx.effect`; imports no DSH internals.

## Development

```sh
npm test
npm run check
```

## Publishing to npm

`.github/workflows/publish.yml` runs the syntax check, tests, then publishes on:

- manual `workflow_dispatch`
- a push to `release` or `release/**`

It runs `npm publish --access public --provenance` with npm Trusted Publishing
(OIDC), so no `NPM_TOKEN` secret is stored in the repository.

Configure the Trusted Publisher on the npm package settings before the first
release:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Repository | `Deliay/dsh-header-masq` |
| Workflow | `publish.yml` |
| Environment | empty |

Release flow:

```sh
# bump "version" in package.json first
git checkout -b release
git push origin release
```

You can also run `Publish dsh-header-masq to npm` manually from the Actions
page. A version can only be published once, so bump `version` first.

## License

MIT
