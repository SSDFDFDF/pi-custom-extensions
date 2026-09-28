# pi-loop

`/loop` —— 让 pi 按间隔循环汇报,或在指定时间 / 指定延迟后执行任务。

```
/loop 3m                     每 3 分钟汇报一次进度(默认指令)
/loop 3m 汇报构建状态         每 3 分钟执行这条指令并简短汇报
/loop 30s x5 now 检查日志     立即开始,30 秒一次,共 5 次后自动结束
/loop 1h30m 巡检一下部署      支持复合间隔
/loop in 10m 检查部署         10 分钟后执行一次
/loop in 2h30m 提醒喝水       2 小时 30 分钟后执行一次
/loop at 15:30 部署上线       在 15:30 执行一次(今天已过则顺延明天)
/loop at 2026-09-21 09:30 备份 在指定日期时间执行一次
/loop at 15:30 every 5m x3 巡检 15:30 开始,每 5 分钟一次,共 3 次
/loop now 汇报一下            立即执行一次
/loop stop                   停止当前任务
/loop status                 查看当前任务(无参数的 /loop 等价于 status)
/loop help                   用法
```

## 语法

```
/loop <间隔> [xN] [now] [指令]              定时循环(旧写法,等价于循环)
/loop in <时长> [every <间隔>] [xN] [指令]   延迟启动;默认单次
/loop at <时间> [every <间隔>] [xN] [指令]   指定时间启动;默认单次
/loop now [指令]                           立即执行一次
```

- 间隔写法:`500ms` / `30s` / `3m` / `1.5m` / `2h` / `1d` / `1h30m`,裸数字按秒算。最小 5s。
- 时间写法:`HH:MM` 或 `HH:MM:SS`,也支持带日期的 `YYYY-MM-DD HH:MM` / `YYYY-MM-DDTHH:MM`。
  `at` 可写成 `在` / `到` / `@`;`in` 可写成 `+10m`。
- `xN` 限制总次数:`x1` 就是单次。**没有 `every` 时默认只执行一次**;要给指定次数配重复间隔请用
  `every 5m x3`,或直接 `in 10m x3`(以延迟为间隔,+10m/+20m/+30m 各一次)。
- `now` 让循环的第一次立刻触发,不能与 `at` / `in` 同用。
- **时间已过**:`at 09:00` 若今天 09:00 已过,自动顺延到明天同一时间(会提示);
  刚好错过不到 1 分钟则立即触发;显式写了过去的日期则报错。
- 同时只有一个任务,重新 `/loop` 会替换旧任务。

## 行为

- 每次触发通过 `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` 注入一条
  `loop-tick` 自定义消息,进入 LLM 上下文并驱动一次回复,因此**每次触发都会消耗 token**。
- 触发时 agent 正忙(`ctx.isIdle() === false`)则顺延重试:循环任务等一个间隔,单次任务等 30s,
  跳过次数会写进下一次汇报。
- 底部状态栏:等待启动时显示 `⏱ loop → 15:30 in 2h13m`,运行中显示 `⏱ loop 3m → #4 in 2m41s` /
  `⏱ loop 单次 → #1 in 30s`,每秒刷新。
- 长延迟按 1 小时分片重新挂载定时器,避免 `setTimeout` 溢出并容忍时钟跳动。
- 循环/任务状态以 `loop-state` 自定义条目持久化(含 `startAt`):`/reload` 后自动恢复,
  未到点的单次任务继续等待;会话关闭期间已过期的单次任务会被跳过并提示。
  用 `/resume` 打开旧会话**不会**自动重启任务。
- `session_shutdown` 会清理定时器;定时器 `unref()`,不会阻止 pi 退出。
- 只在当前进程内有效。要唤醒已关闭的会话,需要 cron / systemd 之类的外部调度。

## 与「指定次数 / 单次」的对应

| 需求 | 写法 |
| --- | --- |
| 单次,立即 | `/loop now 指令` 或 `/loop 1m x1 now 指令` |
| 单次,几分钟后 | `/loop in 10m 指令` 或 `/loop 10m x1 指令` |
| 单次,指定时刻 | `/loop at 15:30 指令` |
| 指定次数,固定间隔 | `/loop 5m x10 指令` |
| 指定次数,延迟后开始 | `/loop in 30m every 5m x3 指令` |
| 指定时刻开始,指定次数 | `/loop at 15:30 every 5m x3 指令` |

## 结构

```
pi-loop/
├── index.ts            目录发现入口(package.json 的 pi.extensions 优先)
├── src/index.ts        扩展主体:命令、定时器、状态栏、持久化
├── src/parse.ts        间隔 / 时间 / 参数解析
└── test/*.test.mjs     单元测试(含 mock timers 驱动的触发逻辑)
```

## 开发

```bash
npm test      # node --experimental-strip-types --test test/*.test.mjs
npm run check # 语法检查;tsc -p tsconfig.json 做类型检查
```

测试与类型检查需要 Node ≥ 22.6(带 `--experimental-strip-types`)。若系统 node 未编译该特性
(`node -e 'console.log(process.features.typescript)'` 输出 `false`),请换用官方 Node 构建。
`node_modules/@earendil-works/*` 是指向 pi 安装目录的软链接,仅供测试和类型检查解析导入。
