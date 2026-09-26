# @xiangxinai/agent-hooks

给智能体加上确定性的 `if`：在 Claude Code、Codex、DeepSeek Harness（dsh）、hermes 等框架的 hook 点上，用[象信一号](https://docs.xiangxinai.cn)或你练好的条件反射做判断，按规则放行、拦截、交给用户确认，或给大模型补一句上下文。

象信一号不是聊天模型，不该做成让大模型"自己决定要不要调"的工具或 MCP。它的位置在框架里：每次工具调用、每条用户输入、每个审批，框架都**无条件**问一次，代码按概率分支。大模型不知道它的存在，也绕不过它。

## 规则文件

一条规则 = 在哪个 hook 点 + 拿什么当 state + 问什么 + 答案满足什么条件 + 然后做什么。像正则表达式一样，写在一个文件里，便于审阅：

```yaml
# .xiangxin/hooks.yaml
rules:
  - id: destructive-shell
    event: PreToolUse
    tools: Bash|bash|shell|exec_command
    state: {命令: "{{tool_input.command}}"}
    questions:
      risk:
        type: choice
        instructions: 一个编程助手想在用户电脑上执行这条命令。它应当怎样处理？
        criteria:
          allow: 直接执行：只读查看、构建、测试、在项目里正常编辑文件
          ask: 先问用户：会对外产生影响，或删改可以恢复但用户可能在意的东西
          deny: 拒绝：不可恢复地删除、清空、覆盖或破坏用户的文件、数据、版本历史或系统配置
    when: risk.p.deny > 0.35
    then: deny
    message: "象信判断这条命令可能破坏数据（{{risk.p.deny}}），请换一种可回退的做法。"
```

完整示例（破坏性命令、对外操作确认、只读自动批准、skill 路由、提示注入检测）见 [examples/hooks.yaml](examples/hooks.yaml)。

| 字段 | 说明 |
|---|---|
| `event` | `PreToolUse` · `PermissionRequest` · `PostToolUse` · `UserPromptSubmit` · `Stop` |
| `tools` | 工具名正则（整名匹配），只对工具类事件有效 |
| `state` | 模板，`{{tool_input.command}}`、`{{prompt}}`、`{{tool_response}}`、`{{cwd}}`；整串只有一个占位符时保留原对象。省略时按事件取默认内容 |
| `questions` | 与 `/v1/systemone` 相同；choice 可加 `skills: [目录…]`，把目录下每个 `SKILL.md` 变成一个选项 |
| `when` | 条件：`x > 0.8`、`skill != "none" and skill.confidence > 0.5`、`risk.p["高"] > 0.3`；支持 `and` `or` `not` 括号 `+ -` |
| `then` | `allow` · `ask` · `deny` · `context` |
| `message` | 拦截理由或注入的上下文，可引用答案 `{{destructive}}`、`{{skill}}` |
| `model` / `reflex` | 换模型，或用练好的条件反射（`reflex: my-approver` 即 `xiangxin-reflex:my-approver`） |

`then` 在各事件上的含义：

| | allow | ask | deny | context |
|---|---|---|---|---|
| PreToolUse | 跳过确认 | 交给用户确认 | 拒绝，理由回给大模型 | 附加上下文 |
| PermissionRequest | 自动批准 | 照常弹窗 | 自动拒绝 | — |
| UserPromptSubmit | — | — | 挡下这条输入 | 附加上下文（如 skill 建议） |
| PostToolUse | — | — | 打回结果 | 附加上下文（如注入警告） |
| Stop | — | — | 不让停，继续干（只拦一次） | — |

同一事件上 state 与模型相同的规则**合并成一次请求**；多条命中时取最严格的（deny > ask > allow）。顶层还有 `model`、`timeout_ms`（默认 3000）、`on_error`（`ignore` 默认 / `ask` / `deny`）、`max_chars`、`log`。

配置查找顺序：`--config`、`$XIANGXIN_HOOKS_CONFIG`、`<项目>/.xiangxin/hooks.yaml`、`~/.xiangxin/hooks.yaml`。需要环境变量 `XIANGXIN_API_KEY`。

## 接入

```bash
npm i -g @xiangxinai/agent-hooks      # 提供 xiangxin-hook 命令
```

**Claude Code**：装插件 `integrations/claude-code`，或把 [hooks.json](integrations/claude-code/hooks/hooks.json) 的 `hooks` 合并进 `~/.claude/settings.json`。

**Codex**：把 [integrations/codex/hooks.json](integrations/codex/hooks.json) 放到 `~/.codex/hooks.json`。Codex 的 PreToolUse 只支持 deny，allow / ask 请改用 PermissionRequest。

**DeepSeek Harness**：原生插件，进程内调用，不起子进程。

```bash
dsh plugin --profile <名> add @xiangxinai/agent-hooks
```

PreToolUse → `tools/pre-execute`，PermissionRequest → `approval/request`，UserPromptSubmit → `agent/pre-step`，PostToolUse → `tools/post-execute`；Stop 暂不支持。

**hermes**：`cli-config.yaml` 的 shell hook 兼容 Claude Code 协议，命令写 `xiangxin-hook claude-code`。

**自己的框架**：

```ts
import { evaluate, loadConfigFile } from '@xiangxinai/agent-hooks'
import { XiangxinClient } from '@xiangxinai/sdk'

const decision = await evaluate(
  { hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command } },
  loadConfigFile('.xiangxin/hooks.yaml'),
  new XiangxinClient(),
)
if (decision.action === 'deny') throw new Error(decision.reason)
```

## 调阈值

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push -f"}}' \
  | xiangxin-hook explain          # 每条规则的 state、答案与是否命中
xiangxin-hook check                # 只校验配置
```

## 从规则到条件反射

设了 `log` 后，每次判断追加一行 JSONL（state、问题、答案、决定）。把其中判断错的几十条改成正确答案，就是 `client.reflexes.create({ name, questions, examples })` 要的样本；练好后在规则里写 `reflex: <名>`，判断就按你的习惯来。

## 注意

- hook 会阻塞智能体。每次请求有网络往返，`timeout_ms` 不宜太大；Claude Code / Codex 的 command hook 每次还要启动一次 node。
- 失败默认 `on_error: ignore`：象信不可用时当作规则没命中，智能体照常工作。安全类规则可以改成 `ask`。
- `allow` 会跳过确认，只对你确信的规则用。
