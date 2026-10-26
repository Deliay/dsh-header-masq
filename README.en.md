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

The plugin therefore supports a **sessionId fallback**: inside the
`llm/stream` window, if the outgoing request has no source header (or an empty
one), the call's `GenerateOptions.sessionId` is used. That means:

- DeepSeek adapter: the existing `x-deepseek-harness-session-id` wins.
- Custom provider / pi-ai: the same DSH session id is used as a fallback.
- Ordinary HTTP requests outside the stream window are untouched.

## Behavior

- Reads the value of `x-deepseek-harness-session-id`.
- Sets `x-opencode-session` to that value, overwriting an existing target.
- Falls back to the model call's `sessionId` when the source header is absent
  and `fallbackToSessionId` is enabled.
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
| `source` | `x-deepseek-harness-session-id` | header to read first |
| `targets` | `[x-opencode-session]` | headers to set |
| `fallbackToSessionId` | `true` | use `llm/stream`'s `sessionId` when the source header is absent |
| `hosts` | `[]` | optional allow-list for the fallback; empty means every host |
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

## License

MIT
