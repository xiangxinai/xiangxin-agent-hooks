# 更新日志

## 0.1.0 (2026-09-25)

首个版本。

- `.xiangxin/hooks.yaml` 规则：`event` + `tools` + `state` 模板 + `questions` + `when` + `then`（allow / ask / deny / context）
- 事件：PreToolUse、PermissionRequest、PostToolUse、UserPromptSubmit、Stop
- `xiangxin-hook` 命令行：Claude Code 与 Codex 两种输出方言；`explain`、`check` 子命令
- DeepSeek Harness 原生插件 `@xiangxinai/agent-hooks/dsh`
- `evaluate()` 库函数
- choice 问题可用 `skills` 目录生成选项；`reflex` 字段使用条件反射
- 同 state 同模型的规则合并请求；`on_error` 失败策略；JSONL 判断日志
