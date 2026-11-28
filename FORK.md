# laokashouji-agy-cli

这是 Magpie 社区插件 agy-cli（`@magpie-community/opencode-agy-cli-auth`）的修改版，代码来自 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/agy-cli` 目录，额外包含以下修复：

- Claude Code 压缩上下文后，继续沿用原来的 agy 会话，不再新开会话。
- 用量按 agy 实际测得的上下文窗口计算。
- 对话中途切换工作目录（如 Claude Code 执行裸 `cd` 导致 `x-magpie-work-dir` 变化）时，继续沿用原来的 agy 会话，不再销毁会话并截断历史。
- SQLite 步级用量（`gen_metadata`）在同次生成拆出带文本/思考的后续工具响应、agy 内部压缩使 ACP 累计大于库内记录，或已验证可用库出现单轮瞬态回退时，不再永久关闭进程级读取；已回退估算时若 `end_turn` 窗口显著缩水则同步下调 `contextAnchor`。
- 上游自 `0.1.152` 起将 `sessions.json` 持久化上限提高到 256。fork 支持通过 `AGY_BRIDGE_MAX_PARKED` 设置上限，并优先保留有状态对话，一次性/无状态请求（如后台摘要、记忆蒸馏）不挤占长会话的 `sessions.json` 与进程池 `evictLRU` 名额，且采用更短的空闲回收时间（`AGY_BRIDGE_EPHEMERAL_IDLE_MS`，默认 60s）。
- Claude Code `/btw` 旁路提问自动隔离到独立临时会话（不写入 `sessions.json`、完成后立即回收），不再污染主会话 `expectedMessages` 或在主会话忙时触发 503。
- 客户端在交付 `tool_result` 后、模型生成中途取消请求（HTTP 499）并丢弃半截回复继续发后续指令时，沿用已取消的原活会话，不再因残留 `tool_result` 触发 `forceNew` 强杀会话。

上游自 `0.1.145` 起已原生支持 `ToolSearch` 动态新增工具时在同一会话提交结果、重新加载工具并继续。fork 保留了工具重新加载失败时回退的回归测试。

## 安装

```sh
magpie plugin add github:Laokashouji/laokashouji-agy-cli
```

包名和官方版相同，安装后会替换官方版。之后执行 `magpie plugin update` 即可获取新版本。

## 与上游同步

日常由定时任务每天自动拉取上游新提交并运行全量 `bun test`；遇到合并冲突或测试失败时由 AI 自动解冲突并复跑测试，全量通过后自动推送 `main` 与 `upstream`。

仓库内的 `.github/workflows/sync-upstream.yml` 保留为手动触发（`workflow_dispatch`）的备用入口。`upstream` 分支是上游 `packages/agy-cli` 目录的原样历史。
