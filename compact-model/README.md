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
	"fallbackToDefault": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。false 时钩子第一行返回，完全零侵入 |
| `provider` / `model` | 空 | 压缩专用模型（models.json 里的 provider key + model id） |
| `thinkingLevel` | `"off"` | `"off"`：压缩不烧思考（推荐）；`"inherit"`：用会话当前级别 |
| `fallbackToDefault` | `true` | 指定模型失败时回退 pi 原版压缩（永不阻断会话）；`false` 时直接报错 |

## 命令

```
/compact-model                              # 状态：配置 + 模型解析 + 鉴权
/compact-model set <provider> <modelId>     # 指定并启用（tab 补全 provider）
/compact-model off                          # 停用，恢复原版
/compact-model thinking [off|inherit]       # 压缩 thinking 级别
/compact-model fallback [on|off]            # 失败回退策略
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
│   └── decide.ts       # 纯决策函数（fileOps 继承 / 回退 / 参数组装）
└── test/               # node:test + jiti（本机 Node 无 strip-types）
```

## 已知限制 / 设计决策

- **fileOps 累积**：pi 对扩展提供的压缩标记 `fromHook=true`，默认不会从上一次
  压缩继承文件列表；本扩展在调用 `compact()` 前手动把最近一次 compaction 的
  `details.readFiles/modifiedFiles` 并回 `preparation.fileOps`，保持累积语义。
- **streamFn 传 undefined**：走 `completeSimple` 直连（鉴权已通过参数传入），
  不经 ModelRuntime 的 `streamSimple`。因此 client-mimic 的 `wrapProviders`
  （wrap provider 的 `streamSimple`）**不覆盖压缩请求**——需要客户端伪装头
  的端点不适合作为压缩模型；选非伪装端点即可。
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
