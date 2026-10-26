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

所以插件以 **`llm/stream` 的 `GenerateOptions.sessionId` 作为规范值**：

- 它是持久化的 DSH Session id，同一 session 的主对话、标题生成、压缩、重试
  都是同一个值；
- 自定义厂商 / pi-ai 没有 `x-deepseek-harness-session-id` 时，直接使用它；
- 切换到新 session 时，DSH 会给出新的 Session id，因此 ssid 自动变化；
- 只有在拿不到活动 session id 时（例如模型流之外的调用），才回退去读
  `x-deepseek-harness-session-id`。

### 固定性保证

| 场景 | `x-opencode-session` |
|---|---|
| 同一 session 的第 1、2、N 轮对话 | 完全相同 |
| 同一 session 的标题生成 / 压缩 / 重试 | 完全相同 |
| 同一 session 自定义厂商 vs DeepSeek 适配器 | 完全相同 |
| 新建另一个 session | 新的、不同的值 |
| 进程重启后继续同一 session | 仍然相同（用的是持久化 Session id，不是随机数） |

插件不会“每次请求生成一个新 id”，也不会给所有 session 共用一个固定值。

## 行为

- 在模型调用流中，把该次调用的持久化 `sessionId` 写入 `x-opencode-session`。
- 拿不到活动 `sessionId` 时，读取 `x-deepseek-harness-session-id` 并写入同一个值。
- 目标头已存在时会被覆盖，避免残留旧 session 的值。
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
| `source` | `x-deepseek-harness-session-id` | 没有活动 sessionId 时读取的请求头 |
| `targets` | `[x-opencode-session]` | 要写入的请求头列表 |
| `fallbackToSessionId` | `true` | 使用 `llm/stream` 的 `sessionId` 作为固定规范值 |
| `hosts` | `[]` | 可选的目标主机白名单；空表示所有主机 |
| `debug` | `false` | 每次应用映射时写一条 info 日志 |

例如只对 OpenCode Go 主机生效，并同时写多个头：

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

## 发布到 npm

`.github/workflows/publish.yml` 会在以下时机运行语法检查、测试并发布：

- 手动触发 `workflow_dispatch`
- push 到 `release` 或 `release/**` 分支

发布命令为 `npm publish --access public --provenance`，使用 npm Trusted Publishing
（OIDC），不需要在仓库里保存 `NPM_TOKEN`。

首次发布前需要在 npm 包设置里配置 Trusted Publisher：

| 项 | 值 |
|---|---|
| Provider | GitHub Actions |
| Repository | `Deliay/dsh-header-masq` |
| Workflow | `publish.yml` |
| Environment | 留空 |

发布流程：

```sh
# 先更新 package.json 的 version
git checkout -b release
git push origin release
```

也可以在 GitHub Actions 页面手动运行 `Publish dsh-header-masq to npm`。
同一个版本不能重复发布，请先修改 `version`。

## 许可

MIT
