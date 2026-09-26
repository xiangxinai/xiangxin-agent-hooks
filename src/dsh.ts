/**
 * DeepSeek Harness（dsh）原生插件：把同一份 hooks.yaml 挂到 dsh 的拦截点上，进程内调用，不起子进程。
 *
 *   dsh plugin --profile <名> add @xiangxinai/agent-hooks
 *
 * 映射：
 * - PreToolUse        → `tools/pre-execute`（deny / ask；allow 不短路后面的策略，自动批准请用 PermissionRequest）
 * - PermissionRequest → `approval/request`（allow → allowed-once，deny → rejected）
 * - UserPromptSubmit  → `agent/pre-step`（deny → reject，context → 追加一条插件消息）
 * - PostToolUse       → `tools/post-execute`（deny → block，context → additionalContexts）
 * - Stop 暂不支持（dsh 的 turn-stopping 不带最后一条回复）。
 *
 * 为了不给 dsh 包加硬依赖，这里用结构类型描述用到的那一小部分接口。
 */
import { statSync } from 'node:fs'
import { XiangxinClient } from '@xiangxinai/sdk'
import { findConfig, loadConfigFile, type HooksConfig } from './config.js'
import { evaluate, type Decision, type HookInput } from './engine.js'

export const name = 'xiangxin-agent-hooks'

export interface Config {
  /** 规则文件；省略时按 $XIANGXIN_HOOKS_CONFIG、<会话目录>/.xiangxin/hooks.yaml、~/.xiangxin/hooks.yaml 查找。 */
  configPath?: string
}

type TextBlock = { type: 'text'; text: string }
type ContentBlock = TextBlock | { type: string }
interface UserMessageLike { content: ContentBlock[] }
interface AgentLike { session: { header: { id: string; cwd?: string } } }
interface ToolExecutionLike { callId: string; name: string; arguments: unknown; agent?: AgentLike }
type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
type PostToolDecision = { kind: 'accept'; additionalContexts?: unknown[]; [k: string]: unknown } | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: unknown[] }
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[]; [k: string]: unknown }
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface ContextLike {
  on(event: string, listener: (...args: any[]) => unknown): unknown
  logger: { warn(msg: string): void; info?(msg: string): void }
}

const SOURCE = { kind: 'plugin', plugin: name } as const

export function apply(ctx: ContextLike, options: Config = {}): void {
  let client: XiangxinClient | undefined
  const configs = new Map<string, { mtime: number; config: HooksConfig }>()
  // approval/request 只带工具名和 callId，参数从 pre-execute 记下来
  const pending = new Map<string, ToolExecutionLike>()

  function configFor(cwd: string): HooksConfig | undefined {
    const path = findConfig(cwd, options.configPath)
    if (!path) return undefined
    const mtime = statSync(path).mtimeMs
    const hit = configs.get(path)
    if (hit && hit.mtime === mtime) return hit.config
    try {
      const config = loadConfigFile(path)
      configs.set(path, { mtime, config })
      return config
    } catch (e) {
      ctx.logger.warn(`${name}: 配置无效 ${path}：${(e as Error).message}`)
      return undefined
    }
  }

  async function run(input: HookInput): Promise<Decision | undefined> {
    const config = configFor(input.cwd ?? process.cwd())
    if (!config || !config.rules.some(r => r.event === input.hook_event_name)) return undefined
    try {
      client ??= new XiangxinClient({ timeout: config.timeout_ms, retry: { maxRetries: 1 }, logLevel: 'off' })
      const d = await evaluate(input, config, client)
      for (const t of d.trace) if (t.error) ctx.logger.warn(`${name}: ${t.rule} 调用失败：${t.error}`)
      return d
    } catch (e) {
      ctx.logger.warn(`${name}: ${(e as Error).message}`)
      return undefined
    }
  }

  const base = (agent: AgentLike | undefined, event: string): HookInput => ({
    hook_event_name: event,
    ...(agent?.session.header.cwd ? { cwd: agent.session.header.cwd } : {}),
    ...(agent ? { session_id: agent.session.header.id } : {}),
  })

  async function contextMessage(texts: string[]): Promise<unknown | undefined> {
    if (!texts.length) return undefined
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    return createUserMessage({ content: texts.map(text => ({ type: 'text' as const, text })), source: SOURCE } as never)
  }

  ctx.on('tools/pre-execute', async (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    pending.set(exec.callId, exec)
    if (pending.size > 256) pending.delete(pending.keys().next().value as string)
    const d = await run({ ...base(exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments })
    if (d?.action === 'deny') return { kind: 'deny', reason: d.reason ?? '象信规则拦截' }
    if (d?.action === 'ask') return { kind: 'ask', ...(d.reason ? { reason: d.reason } : {}) }
    return next()
  })

  ctx.on('approval/request', async (req: { agent: AgentLike; toolName: string; callId?: string }, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    const exec = req.callId ? pending.get(req.callId) : undefined
    const d = await run({ ...base(req.agent, 'PermissionRequest'), tool_name: req.toolName, tool_input: exec?.arguments })
    if (d?.action === 'allow') return 'allowed-once'
    if (d?.action === 'deny') return 'rejected'
    return next()
  })

  ctx.on('agent/pre-step', async (
    payload: { agent: AgentLike; messages: UserMessageLike[] },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const prompt = payload.messages
      .flatMap(m => m.content)
      .filter((b): b is TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    if (!prompt) return next()
    const d = await run({ ...base(payload.agent, 'UserPromptSubmit'), prompt })
    if (d?.action === 'deny') {
      ctx.logger.warn(`${name}: 已拦下用户输入：${d.reason ?? ''}`)
      return { kind: 'reject' }
    }
    const downstream = await next()
    const extra = await contextMessage(d?.context ?? [])
    if (!extra || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages, extra] }
  })

  ctx.on('tools/post-execute', async (
    exec: ToolExecutionLike,
    result: { content: ContentBlock[] },
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const tool_response = result.content.filter((b): b is TextBlock => b.type === 'text').map(b => b.text).join('')
    const d = await run({ ...base(exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_response })
    const extra = await contextMessage(d?.context ?? [])
    if (d?.action === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: d.reason ?? '象信规则拦截' } as TextBlock], ...(extra ? { additionalContexts: [extra] } : {}) }
    }
    const downstream = await next()
    if (!extra) return downstream
    return { ...downstream, additionalContexts: [extra, ...(downstream.additionalContexts ?? [])] }
  })
}
