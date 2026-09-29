# 更新日志

## 0.2.0 (2026-09-28)

- 只有一个模型：象信（xiangxin），默认模型改为 `xiangxin-latest`
- 删除规则里已下线的模型训练字段

## 0.1.2 (2026-09-27)

- 调整默认模型名

## 0.1.1 (2026-09-26)

- 同一请求里同名且定义相同的问题只问一次（几条规则共用一个判断时不再重复计 token；默认限额是 1000 token/秒）
- 示例规则按当时的模型实测重新标定：
  - 命令风险改为一个三选一 choice（allow / ask / deny）加对外写入 noul，deny 取 `risk.p.deny > 0.35`。
    135 条标注命令上 127 条正确，没有放过危险命令；原先的 noul 写法是 115 条，而 0.8 / 0.7 的原始阈值会放过大半危险命令
  - 只读自动批准：阈值从 0.95 降到 0.6（原阈值一个都批不了），并排除读取密钥、凭据的调用
  - 提示注入：改用带 criteria 的问法，阈值 0.3
- 修复：choice 问题 `skills` 里的相对目录改为相对会话工作目录解析（之前相对 `.xiangxin/`，项目内的 `.claude/skills` 扫不到）

## 0.1.0 (2026-09-25)

首个版本。

- `.xiangxin/hooks.yaml` 规则：`event` + `tools` + `state` 模板 + `questions` + `when` + `then`（allow / ask / deny / context）
- 事件：PreToolUse、PermissionRequest、PostToolUse、UserPromptSubmit、Stop
- `xiangxin-hook` 命令行：Claude Code 与 Codex 两种输出方言；`explain`、`check` 子命令
- DeepSeek Harness 原生插件 `@xiangxinai/agent-hooks/dsh`
- `evaluate()` 库函数
- choice 问题可用 `skills` 目录生成选项
- 同 state 同模型的规则合并请求；`on_error` 失败策略；JSONL 判断日志
