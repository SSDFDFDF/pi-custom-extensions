# compact-model

为 pi 的上下文压缩（compaction）指定**专用模型**：配置后压缩摘要改用指定的
provider/model 生成；未配置时走 pi 原版行为（零侵入）。

## 原理

拦截 `session_before_compact` 钩子，调用 pi 官方导出的 `compact()`——同一套
摘要 prompt、切点计算、`<read-files>`/`<modified-files>` 文件列表、split-turn
双摘要合并、usage 统计——**只替换 LLM 与鉴权**。因此生成的 `CompactionEntry`
与原版格式完全一致，只是换了个（更便宜/更快的）模型在跑。

动机：压缩是单次离线摘要，没必要烧主对话模型的思考预算；deepseek-flash 之类
的便宜快模型足够。

## 配置

`~/.pi/agent/compact-model.config.json`（首次由 `/compact-model set` 或 `saveConfig` 写入）：

```json
{
	"enabled": false,
	"provider": "",
	"model": "",
	"thinkingLevel": "off",
	"fallbackToDefault": true,
	"followClientMimic": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。false 时钩子第一行返回，完全零侵入 |
| `provider` / `model` | 空 | 压缩专用模型（models.json 里的 provider key + model id） |
| `thinkingLevel` | `"off"` | `"off"`：压缩不烧思考（推荐）；`"inherit"`：用会话当前级别 |
| `fallbackToDefault` | `true` | 指定模型失败时回退 pi 原版压缩（永不阻断会话）；`false` 时取消本次压缩并报错（`session_compact_failed`），不回退原版 |
| `followClientMimic` | `true` | 压缩请求沿用 client-mimic 的客户端伪装（见下节）；client-mimic 未安装/未激活时自动无效 |

## 与 client-mimic 协作

pi 的压缩摘要走 provider `streamSimple`，**不经过**扩展钩子
`before_provider_headers` / `before_provider_request`——client-mimic 平时正是
靠这两个钩子生效的。所以压缩请求曾会以 pi 的默认指纹发出，对接了客户端指纹
校验的网关会拒绝压缩（而普通对话正常）。

现在的做法：client-mimic 把同一套改写逻辑发布成进程级服务
（`Symbol.for("pi.client-mimic.rewrite-service")`），本扩展在压缩请求上按与
普通回合相同的顺序应用：

1. `rewriteHeaders`（先）：User-Agent / originator / session-id / stainless 等
   头部改写，并为本次请求签发新的 Codex `turn_id`；
2. `patchPayload`（后）：`prompt_cache_key` + `metadata`（Codex）或
   `metadata.user_id` + billing system（Claude Code）等 body 补丁。

实测（本地 mock 网关）主回合与压缩请求的身份字段完全一致：Codex 的
`metadata.session_id/thread_id/window_id` 相同、`turn_id` 每请求不同；
Claude Code 的 `metadata.user_id`、`x-anthropic-billing-header` preamble 一致。

降级策略（任一条件不满足即原样发出，压缩绝不因伪装失败而中断）：

- client-mimic 未安装 / 已禁用 / `active=off`；
- 服务版本不符（契约 `version` 不是 1）；
- 改写过程抛错（只丢弃该步改写）。

`/compact-model mimic off` 可单独关掉这层适配（伪装只用于主对话）。
`/compact-model status` 会显示当前生效的 profile。

## 命令

```
/compact-model                              # 状态：配置 + 模型解析 + 鉴权
/compact-model set <provider> <modelId>     # 指定并启用（tab 补全 provider）
/compact-model off                          # 停用，恢复原版
/compact-model thinking [off|inherit]       # 压缩 thinking 级别
/compact-model fallback [on|off]            # 失败回退策略
/compact-model mimic [on|off]               # 压缩请求是否沿用 client-mimic 伪装
/compact-model test                         # 发一条最小请求验证指定模型
/compact-model path                         # 配置文件路径
```

## 结构（形态 A）

```
compact-model/
├── package.json        # pi.extensions → ./src/index.ts（唯一入口）
├── src/
│   ├── index.ts        # 钩子装配 + /compact-model 命令
│   ├── config.ts       # 配置读写（原子写，PI_CODING_AGENT_DIR 支持）
│   ├── decide.ts       # 纯决策函数（fileOps 继承 / 回退 / 参数组装）
│   └── mimic.ts        # client-mimic 服务解析 + 伪装 streamFn（失败即透传）
└── test/               # node:test + jiti（本机 Node 无 strip-types）
```

## 已知限制 / 设计决策

- **fileOps 累积**：pi 对扩展提供的压缩标记 `fromHook=true`，默认不会从上一次
  压缩继承文件列表；本扩展在调用 `compact()` 前手动把最近一次 compaction 的
  `details.readFiles/modifiedFiles` 并回 `preparation.fileOps`，保持累积语义。
- **请求链路**：压缩始终走 `compact()` 的 `streamFn`（默认即官方
  `completeSimple`），不经过 ModelRuntime 的 `streamSimple`。这是有意的：
  避免与 client-mimic 的 `wrapProviders`（provider 级 wrap）叠加导致同一份
  伪装被应用两次；伪装由上一节的共享服务单独施加一次。
- **`wrapProviders` 仍然只服务普通对话 + 其自身覆盖的路径**；压缩不再依赖它，
  也不需要把压缩 provider 加进去。
- **thinkingLevel 默认 off**：压缩是单次摘要，`reasoning` 模型仅在显式
  `inherit` 时下发 thinking。
- **retry**：透传 `~/.pi/agent/settings.json` 的 `retry` 字段给 `compact()`
  （与 kun-retry 的大重试预算联动）。
- **分支摘要（/tree）不走本扩展**：那条路径是 `session_before_tree` +
  `generateBranchSummary`，如需同样指定模型可后续加钩子。

## 测试

```bash
npm test   # node --test test/*.test.mjs（jiti 加载 TS）
```
