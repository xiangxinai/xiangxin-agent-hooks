import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Answer, Questions, State, SystemOneRequest, SystemOneResult } from '@xiangxinai/sdk'
import type { Action, HookEvent, HooksConfig, QuestionSpec, Rule } from './config.js'
import { ANSWER, compile } from './expr.js'
import { expandHome, loadSkills } from './skills.js'
import { renderState, renderString } from './template.js'

/**
 * 框架无关的 hook 输入，字段沿用 Claude Code 的 hook 协议（Codex、hermes、dsh 的桥接都用同一套名字）。
 */
export interface HookInput {
  hook_event_name: HookEvent | string
  cwd?: string
  session_id?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  prompt?: string
  /** Stop：本轮最后一条助手消息（Claude Code、Codex 会带）。 */
  last_assistant_message?: string
  /** Stop：已经被 Stop hook 拦过一次，防止死循环。 */
  stop_hook_active?: boolean
  [extra: string]: unknown
}

/** 调用象信的最小接口，便于测试替换；XiangxinClient 满足它。 */
export interface SystemOneCaller {
  systemOne(request: SystemOneRequest<Questions>): PromiseLike<SystemOneResult<Questions>>
}

export interface Fired {
  rule: string
  action: Action
  message?: string
}

export interface RuleTrace {
  rule: string
  model: string
  state: unknown
  answers?: Record<string, Answer>
  matched?: boolean
  error?: string
  ms?: number
}

export interface Decision {
  /** 最严格的那个：deny > ask > allow；没有规则命中时为 undefined。 */
  action?: 'allow' | 'ask' | 'deny'
  /** deny / ask 的理由（多条合并）。 */
  reason?: string
  /** 交给大模型的额外上下文。 */
  context: string[]
  fired: Fired[]
  trace: RuleTrace[]
}

const RANK = { allow: 1, ask: 2, deny: 3 } as const

/** 事件的默认 state：规则没写 state 时用。 */
function defaultState(input: HookInput): unknown {
  switch (input.hook_event_name) {
    case 'PreToolUse':
    case 'PermissionRequest':
      return { 工具: input.tool_name, 参数: input.tool_input }
    case 'PostToolUse':
      return { 工具: input.tool_name, 参数: input.tool_input, 结果: input.tool_response }
    case 'UserPromptSubmit':
      return { 用户输入: input.prompt }
    case 'Stop':
      return { 助手最后的回复: input.last_assistant_message }
    default:
      return input
  }
}

function toolMatches(rule: Rule, input: HookInput): boolean {
  if (rule.tools === undefined) return true
  if (input.tool_name === undefined) return false
  return new RegExp(`^(?:${rule.tools})$`).test(input.tool_name)
}

/** 把 skills 目录展开成 choice 的选项；相对路径相对项目目录（会话的 cwd）。 */
function buildQuestion(q: QuestionSpec, cwd: string): Questions[string] {
  const { skills, ...rest } = q
  if (!skills) return rest as Questions[string]
  const criteria: Record<string, unknown> = {}
  for (const s of loadSkills(skills, cwd)) {
    criteria[s.name] = s.description.slice(0, 400) || null
  }
  Object.assign(criteria, (q.criteria as Record<string, unknown> | undefined) ?? {})
  return { ...rest, criteria } as Questions[string]
}

/** 答案包装成表达式可用的值：`x` 取主值，`x.confidence`、`x.p.<选项>` 取细节。 */
function wrap(a: Answer): Record<string, unknown> {
  switch (a.type) {
    case 'noul':
      return { [ANSWER]: true, value: a.noul, p: { true: a.noul, false: 1 - a.noul } }
    case 'choice':
      return { [ANSWER]: true, value: a.choice, confidence: a.confidence, p: a.probabilities }
    case 'score':
      return { [ANSWER]: true, value: a.score, confidence: a.confidence, p: a.probabilities }
  }
}

interface Group {
  model: string
  state: unknown
  questions: Record<string, Questions[string]>
  /** 规则 → (原问题名 → 请求里的问题名) */
  members: { rule: Rule; names: Record<string, string> }[]
}

/**
 * 对一个 hook 事件求值：挑出匹配的规则，把 state 相同、模型相同的规则合成一次请求（并行发出），
 * 再按 when 判断、合并出最严格的决定。任何调用失败按 on_error 处理，绝不抛错。
 */
export async function evaluate(input: HookInput, config: HooksConfig, client: SystemOneCaller): Promise<Decision> {
  const cwd = input.cwd ?? process.cwd()
  const rules = config.rules.filter(r => r.event === input.hook_event_name && toolMatches(r, input))
  const decision: Decision = { context: [], fired: [], trace: [] }
  if (rules.length === 0) return decision

  const env: Record<string, unknown> = { ...input, tool: input.tool_name, input: input.tool_input }
  const groups = new Map<string, Group>()
  for (const rule of rules) {
    const model = rule.reflex ? `xiangxin-reflex:${rule.reflex}` : rule.model ?? config.model
    const state = rule.state === undefined
      ? renderState(defaultState(input), {}, config.max_chars)
      : renderState(rule.state, env, config.max_chars)
    const key = `${model}\0${JSON.stringify(state)}`
    let g = groups.get(key)
    if (!g) groups.set(key, g = { model, state, questions: {}, members: [] })
    const names: Record<string, string> = {}
    for (const [name, q] of Object.entries(rule.questions)) {
      let wire = name
      for (let n = 2; wire in g.questions; n++) wire = `${name}_${n}`
      g.questions[wire] = buildQuestion(q, cwd)
      names[name] = wire
    }
    g.members.push({ rule, names })
  }

  const reasons: string[] = []
  await Promise.all([...groups.values()].map(async (g) => {
    const t0 = Date.now()
    let result: SystemOneResult<Questions> | undefined
    let error: string | undefined
    if (isEmptyState(g.state)) {
      error = 'state 为空，跳过'
    } else {
      try {
        result = await client.systemOne({ model: g.model, state: g.state as State, questions: g.questions })
      } catch (e) {
        error = (e as Error).message ?? String(e)
      }
    }
    const ms = Date.now() - t0
    for (const { rule, names } of g.members) {
      const trace: RuleTrace = { rule: rule.id, model: g.model, state: g.state, ms }
      decision.trace.push(trace)
      if (!result) {
        trace.error = error
        if (config.on_error !== 'ignore' && error !== 'state 为空，跳过') {
          merge(decision, config.on_error, `象信调用失败（${rule.id}）：${error}`, reasons)
        }
        continue
      }
      const answers: Record<string, Answer> = {}
      const scope: Record<string, unknown> = { ...env }
      for (const [name, wire] of Object.entries(names)) {
        const a = result.answers[wire]
        if (a) { answers[name] = a; scope[name] = wrap(a) }
      }
      trace.answers = answers
      trace.matched = compile(rule.when)(scope)
      if (!trace.matched) continue
      const message = rule.message ? renderString(rule.message, scope) : undefined
      decision.fired.push({ rule: rule.id, action: rule.then, ...(message ? { message } : {}) })
      if (rule.then === 'context') {
        if (message) decision.context.push(message)
      } else {
        merge(decision, rule.then, message ?? `象信规则 ${rule.id}`, reasons)
      }
    }
  }))
  if (reasons.length) decision.reason = reasons.join('；')
  if (config.log) writeLog(config, input, decision)
  return decision
}

function merge(d: Decision, action: 'allow' | 'ask' | 'deny', reason: string, reasons: string[]): void {
  if (!d.action || RANK[action] > RANK[d.action]) {
    d.action = action
    reasons.length = 0
  }
  if (action === d.action && action !== 'allow') reasons.push(reason)
}

function isEmptyState(s: unknown): boolean {
  if (s === undefined || s === null || s === '') return true
  if (Array.isArray(s)) return s.length === 0
  if (typeof s === 'object') return Object.keys(s).length === 0
  return false
}

function writeLog(config: HooksConfig, input: HookInput, d: Decision): void {
  try {
    const path = expandHome(config.log!, config.base_dir)
    mkdirSync(dirname(path), { recursive: true })
    const line = {
      time: new Date().toISOString(),
      event: input.hook_event_name,
      session_id: input.session_id,
      tool: input.tool_name,
      action: d.action ?? null,
      fired: d.fired.map(f => f.rule),
      trace: d.trace,
    }
    appendFileSync(path, JSON.stringify(line) + '\n')
  } catch {
    // 日志失败不影响判断
  }
}
