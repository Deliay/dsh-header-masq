# dsh-header-masq

DeepSeek Harness（`dsh`）**0.2.1-rc.2** 插件：把当前会话的 session id 暴露成
其他 harness 认识的请求头。

默认行为：

```http
x-deepseek-harness-session-id: session-05681fd4-...
x-opencode-session:            session-05681fd4-...
```

## 关于 `x-deepseek-harness-session-id` 为空 / 不存在

这不是插件 bug，而是 DSH 0.2.1-rc.2 的适配器差异：

| 适配器 | 用途 | 是否发送 `x-deepseek-harness-session-id` |
|---|---|---|
| `@deepseek-ai/dsh-llm-deepseek` | `deepseek-official`、自定义 `baseURL` 的 Messages 兼容网关 | **发送**，值为 `GenerateOptions.sessionId` |
| `@deepseek-ai/dsh-llm-pi-ai` | 自定义模型厂商、OpenAI / Anthropic 兼容路由、pi-ai 目录里的 provider | **完全不发送** |

`dsh-llm-pi-ai` 只把 `sessionId` 交给 pi-ai 的 `streamSimple`，而 DSH 的这些
wire extension 头只由 `dsh-llm-deepseek` 实现。因此“自定义模型厂商”看到的是
**没有这个头**（而不是有空值）。另外，没有 Session 的直接调用（例如某些一次性
请求）也不会带这个头。

所以插件提供了 **sessionId 回退**：在 `llm/stream` 的调用窗口内，如果出站请求
没有源头（或源头值为空），就直接使用该次模型调用的 `GenerateOptions.sessionId`。这样：

- DeepSeek 适配器：优先使用已有的 `x-deepseek-harness-session-id`；
- 自定义厂商 / pi-ai：自动回退到同一个 DSH session id；
- 窗口之外的普通 HTTP 请求不会被注入。

## 行为

- 读取 `x-deepseek-harness-session-id` 的值。
- 把 `x-opencode-session` 设置为同一个值；目标头已存在时会被覆盖。
- 源头不存在时，若处于模型调用流中且 `fallbackToSessionId: true`，使用该次调用的
  `sessionId`。
- 支持 `Headers`、普通对象、`Request` 三种 `fetch` 入参形式。
- 插件卸载时恢复原始 `fetch` 和 `llm/stream` 监听；不会覆盖之后安装的其他补丁。

## 安装

本地目录：

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-header-masq
```

也可以从 GitHub 安装：

```sh
dsh plugin --profile web add github:Deliay/dsh-header-masq
```

安装后重启引擎。插件包带 `cordis.patch.yml`，会被自动激活。

## 配置

配置位于插件插入的行 `header-masq`（见 `cordis.patch.yml`），全部可选：

| 键 | 默认值 | 说明 |
|---|---|---|
| `source` | `x-deepseek-harness-session-id` | 优先读取的请求头 |
| `targets` | `[x-opencode-session]` | 要写入的请求头列表 |
| `fallbackToSessionId` | `true` | 源头不存在时回退到 `llm/stream` 的 `sessionId` |
| `hosts` | `[]` | 可选的回退目标主机白名单；空表示所有主机 |
| `debug` | `false` | 每次应用映射时写一条 info 日志 |

例如只对 OpenCode Go 主机回退，并同时写多个头：

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

## 兼容性

- DSH：`>=0.2.1-rc.2 <0.3.0`（目标版本 0.2.1-rc.2）
- Node.js：`>=20`
- 只依赖 `globalThis.fetch`、`llm/stream` 事件和 Cordis 的 `ctx.effect`，
  不导入任何 DSH 内部模块。

## 开发

```sh
npm test
npm run check
```

## 许可

MIT
