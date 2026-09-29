/**
 * @xiangxinai/agent-hooks：用象信给智能体加确定性的 if。
 *
 * 同一份规则文件（.xiangxin/hooks.yaml）三种用法：
 * - `xiangxin-hook` 命令行：Claude Code、Codex、hermes 的 command hook
 * - `@xiangxinai/agent-hooks/dsh`：DeepSeek Harness 原生插件
 * - 这里导出的 `evaluate`：自己的框架里直接调
 */
export { evaluate, type HookInput, type Decision, type Fired, type RuleTrace, type SystemOneCaller } from './engine.js'
export { render, type Dialect } from './dialects.js'
export {
  parseConfig,
  loadConfigFile,
  findConfig,
  ConfigError,
  EVENTS,
  ACTIONS,
  type HooksConfig,
  type Rule,
  type QuestionSpec,
  type HookEvent,
  type Action,
} from './config.js'
export { compile as compileWhen } from './expr.js'
