import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { EntryType } from '@xiangxinai/sdk'
import { compile } from './expr.js'

/** 支持的 hook 点（Claude Code 的事件名；其他框架由适配器映射到这里）。 */
export const EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const
export type HookEvent = (typeof EVENTS)[number]

/**
 * 规则命中后做什么：
 * - `allow`：放行（PreToolUse 跳过确认；PermissionRequest 自动批准）
 * - `ask`：交给用户确认（PreToolUse）
 * - `deny`：拦截（工具调用被拒、用户输入被挡、工具结果被打回、Stop 被拦下继续干）
 * - `context`：把 `message` 作为额外上下文交给大模型
 */
export const ACTIONS = ['allow', 'ask', 'deny', 'context'] as const
export type Action = (typeof ACTIONS)[number]

export interface QuestionSpec {
  type: 'noul' | 'choice' | 'score'
  instructions?: EntryType
  criteria?: unknown
  /** 仅 choice：把这些目录下的 skill（`<dir>/<name>/SKILL.md`）加为选项。 */
  skills?: string[]
}

export interface Rule {
  /** 规则名，出现在日志和给用户的提示里。 */
  id: string
  event: HookEvent
  /** 工具名匹配（正则，整名匹配），只对工具类事件有效；省略表示所有工具。 */
  tools?: string
  /** 模型；默认用配置顶层的 model。 */
  model?: string
  /** 练好的条件反射名，等价于 `model: xiangxin-reflex:<名>`。 */
  reflex?: string
  /** state 模板，`{{tool_input.command}}` 之类；省略时按事件取默认内容。 */
  state?: unknown
  questions: Record<string, QuestionSpec>
  /** 条件表达式，见 expr.ts。 */
  when: string
  then: Action
  /** 拦截理由 / 注入的上下文，可引用答案：`{{skill}}`、`{{destructive}}`。 */
  message?: string
}

export interface HooksConfig {
  model: string
  /** 单次请求超时（毫秒）。hook 会阻塞智能体，默认 3 秒。 */
  timeout_ms: number
  /** 调用失败时：`ignore` 当作没有规则命中（默认），`ask` 交给用户，`deny` 一律拦截。 */
  on_error: 'ignore' | 'ask' | 'deny'
  /** state 里每个字符串的最大字数。 */
  max_chars: number
  /** 每次判断追加一行 JSONL（state、问题、答案、决定），可用来标注后练条件反射。 */
  log?: string
  rules: Rule[]
  /** 配置文件所在目录，用于解析相对路径。 */
  base_dir: string
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** 校验并补默认值；表达式在这里就编译一次，写错立刻报。 */
export function parseConfig(raw: unknown, baseDir: string): HooksConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('配置须是对象 / config must be a mapping')
  const r = raw as Record<string, unknown>
  const rules = r.rules ?? []
  if (!Array.isArray(rules)) throw new ConfigError('rules 须是列表 / rules must be a list')
  const onError = (r.on_error ?? 'ignore') as HooksConfig['on_error']
  if (!['ignore', 'ask', 'deny'].includes(onError)) throw new ConfigError(`on_error 只能是 ignore / ask / deny`)
  const ids = new Set<string>()
  const out: HooksConfig = {
    model: typeof r.model === 'string' ? r.model : 'xiangxin-s1-latest',
    timeout_ms: typeof r.timeout_ms === 'number' ? r.timeout_ms : 3000,
    on_error: onError,
    max_chars: typeof r.max_chars === 'number' ? r.max_chars : 4000,
    ...(typeof r.log === 'string' ? { log: r.log } : {}),
    rules: rules.map((x, i) => parseRule(x, i, ids)),
    base_dir: baseDir,
  }
  return out
}

function parseRule(x: unknown, i: number, ids: Set<string>): Rule {
  const where = `rules[${i}]`
  if (x === null || typeof x !== 'object') throw new ConfigError(`${where} 须是对象`)
  const r = x as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id ? r.id : `rule-${i + 1}`
  if (ids.has(id)) throw new ConfigError(`${where}: 规则名重复 "${id}"`)
  ids.add(id)
  const at = `规则 "${id}"`
  if (!EVENTS.includes(r.event as HookEvent)) throw new ConfigError(`${at}: event 须是 ${EVENTS.join(' / ')}`)
  if (!ACTIONS.includes(r.then as Action)) throw new ConfigError(`${at}: then 须是 ${ACTIONS.join(' / ')}`)
  if (typeof r.when !== 'string' || !r.when.trim()) throw new ConfigError(`${at}: 缺少 when`)
  try {
    compile(r.when)
  } catch (e) {
    throw new ConfigError(`${at}: when 写错了：${(e as Error).message}`)
  }
  if (r.tools !== undefined) {
    if (typeof r.tools !== 'string') throw new ConfigError(`${at}: tools 须是正则字符串，如 "Bash|shell"`)
    try { new RegExp(r.tools) } catch (e) { throw new ConfigError(`${at}: tools 正则无效：${(e as Error).message}`) }
  }
  const qs = r.questions
  if (qs === null || typeof qs !== 'object' || Array.isArray(qs) || Object.keys(qs).length === 0) {
    throw new ConfigError(`${at}: questions 须是非空映射`)
  }
  for (const [name, q] of Object.entries(qs as Record<string, unknown>)) {
    const t = (q as QuestionSpec | null)?.type
    if (t !== 'noul' && t !== 'choice' && t !== 'score') throw new ConfigError(`${at}: 问题 "${name}" 的 type 须是 noul / choice / score`)
    if (t !== 'choice' && (q as QuestionSpec).skills) throw new ConfigError(`${at}: 只有 choice 问题能用 skills`)
  }
  if (r.model !== undefined && r.reflex !== undefined) throw new ConfigError(`${at}: model 与 reflex 只能写一个`)
  if (r.reflex !== undefined && (typeof r.reflex !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(r.reflex))) {
    throw new ConfigError(`${at}: reflex 名须为小写字母、数字或连字符`)
  }
  return {
    id,
    event: r.event as HookEvent,
    ...(typeof r.tools === 'string' ? { tools: r.tools } : {}),
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    ...(typeof r.reflex === 'string' ? { reflex: r.reflex } : {}),
    ...(r.state !== undefined ? { state: r.state } : {}),
    questions: qs as Record<string, QuestionSpec>,
    when: r.when,
    then: r.then as Action,
    ...(typeof r.message === 'string' ? { message: r.message } : {}),
  }
}

export function loadConfigFile(path: string): HooksConfig {
  const text = readFileSync(path, 'utf8')
  const raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
  return parseConfig(raw, dirname(path))
}

/**
 * 找配置：显式路径 → $XIANGXIN_HOOKS_CONFIG → <项目>/.xiangxin/hooks.yaml → ~/.xiangxin/hooks.yaml。
 * 都没有时返回 undefined（什么都不做）。
 */
export function findConfig(cwd: string, explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.XIANGXIN_HOOKS_CONFIG,
    join(cwd, '.xiangxin', 'hooks.yaml'),
    join(cwd, '.xiangxin', 'hooks.yml'),
    join(homedir(), '.xiangxin', 'hooks.yaml'),
    join(homedir(), '.xiangxin', 'hooks.yml'),
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return undefined
}
