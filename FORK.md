# laokashouji-agy-cli

这是 Magpie 社区插件 agy-cli（`@magpie-community/opencode-agy-cli-auth`）的修改版，代码来自 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/agy-cli` 目录，额外包含以下修复：

- Claude Code 压缩上下文后，继续沿用原来的 agy 会话，不再新开会话。
- 用量按 agy 实际测得的上下文窗口计算。
- 对话中途切换工作目录（如 Claude Code 执行裸 `cd` 导致 `x-magpie-work-dir` 变化）时，继续沿用原来的 agy 会话，不再销毁会话并截断历史。
- SQLite 步级用量（`gen_metadata`）在同次生成拆出带文本/思考的后续工具响应、agy 内部压缩使 ACP 累计大于库内记录，或已验证可用库出现单轮瞬态回退时，不再永久关闭进程级读取；已回退估算时若 `end_turn` 窗口显著缩水则同步下调 `contextAnchor`。

## 安装

```sh
magpie plugin add github:Laokashouji/laokashouji-agy-cli
```

包名和官方版相同，安装后会替换官方版。之后执行 `magpie plugin update` 即可获取新版本。

## 与上游同步

GitHub Actions 每天合并一次上游的新提交（见 `.github/workflows/sync-upstream.yml`）。合并无冲突且测试通过才更新 `main`；否则 `main` 保持不变，并自动开一个 `sync-failed` issue。

`upstream` 分支是上游 `packages/agy-cli` 目录的原样历史。
