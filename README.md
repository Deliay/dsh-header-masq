# dsh-header-masq

DeepSeek Harness（`dsh`）**0.2.1-rc.2** 插件：把 DeepSeek 适配器已经发出的
`x-deepseek-harness-session-id` 请求头，映射成其他 harness 认识的会话请求头。

默认行为：

```http
x-deepseek-harness-session-id: session-05681fd4-...
x-opencode-session:            session-05681fd4-...
```

这样同一个 DSH session 在所有出站请求里都带有稳定、一致的会话标识，OpenCode /
OpenCode Go 之类的网关可以按会话做路由和缓存亲和（避免 `400 MissingSessionID`，
也不会像固定值那样让所有会话共用一个缓存桶）。

## 行为

- 读取 `x-deepseek-harness-session-id` 的值。
- 把 `x-opencode-session` 设置为同一个值；目标头已存在时会被覆盖。
- 源请求头不存在时不改动请求（其他适配器、非模型请求完全不受影响）。
- 支持 `Headers`、普通对象、`Request` 三种 `fetch` 入参形式。
- 插件卸载时恢复原始 `fetch`；如果之后已有别的插件打补丁，不会覆盖它。

## 安装

本地目录：

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-header-masq
```

也可以发布后从 npm 安装，或在支持 `github:` 说明符的环境里直接从仓库安装。
安装后重启引擎。

> 插件包带 `cordis.patch.yml`，安装时会被自动激活，无需手动编辑 profile。

## 配置

配置位于插件插入的行 `header-masq`（见 `cordis.patch.yml`），全部可选：

| 键 | 默认值 | 说明 |
|---|---|---|
| `source` | `x-deepseek-harness-session-id` | 要读取的请求头 |
| `targets` | `[x-opencode-session]` | 要写入的请求头列表；可以加其他 harness 的头 |
| `debug` | `false` | 每次应用映射时写一条 info 日志 |

例如同时映射到多个头：

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

## 兼容性

- DSH：`>=0.2.1-rc.2 <0.3.0`（目标版本 0.2.1-rc.2）
- Node.js：`>=20`
- 只依赖 `globalThis.fetch` 和 Cordis 的 `ctx.effect`，不导入任何 DSH 内部模块。

## 开发

```sh
npm test
npm run check
```

## 许可

MIT
