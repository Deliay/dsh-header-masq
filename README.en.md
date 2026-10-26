# dsh-header-masq

A DeepSeek Harness (`dsh`) **0.2.1-rc.2** plugin that mirrors the
`x-deepseek-harness-session-id` header already sent by the DeepSeek adapter
onto the session headers other harnesses understand.

Default mapping:

```http
x-deepseek-harness-session-id: session-05681fd4-...
x-opencode-session:            session-05681fd4-...
```

Every request of one DSH session therefore carries the same stable conversation
identity. OpenCode / OpenCode Go style gateways can route on it and keep the
prompt cache warm (this fixes `400 MissingSessionID` without collapsing all
sessions into one fixed affinity bucket).

## Behavior

- Reads the value of `x-deepseek-harness-session-id`.
- Sets `x-opencode-session` to that value, overwriting an existing target.
- Requests without the source header are untouched (other adapters and
  non-model requests are unaffected).
- Handles `Headers`, plain objects, and `Request` inputs.
- Restores the original `fetch` on unload, unless another plugin installed a
  newer patch afterwards.

## Install

From a local checkout:

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-header-masq
```

Restart the engine after installing. The package ships a `cordis.patch.yml`, so
the plugin row is activated automatically.

## Configuration

The inserted `header-masq` row (see `cordis.patch.yml`) accepts:

| Key | Default | Meaning |
|---|---|---|
| `source` | `x-deepseek-harness-session-id` | header to read |
| `targets` | `[x-opencode-session]` | headers to set; add more for other harnesses |
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
        debug: true
```

## Compatibility

- DSH: `>=0.2.1-rc.2 <0.3.0` (targets 0.2.1-rc.2)
- Node.js: `>=20`
- Depends only on `globalThis.fetch` and Cordis `ctx.effect`; imports no DSH
  internals.

## Development

```sh
npm test
npm run check
```

## License

MIT
