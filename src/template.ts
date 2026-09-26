import { ANSWER } from './expr.js'

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/

function lookup(env: Record<string, unknown>, path: string): unknown {
  let cur: unknown = env
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  if (cur !== null && typeof cur === 'object' && ANSWER in (cur as object)) {
    return (cur as Record<string, unknown>).value
  }
  return cur
}

function show(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

function clip(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  // 长内容保留头尾：命令、工具输出的关键信息常在两端
  const head = Math.ceil(maxChars * 0.7)
  return `${s.slice(0, head)}\n…（省略 ${s.length - maxChars} 字）…\n${s.slice(s.length - (maxChars - head))}`
}

/** 字符串模板：`"命令 {{tool_input.command}}"`。 */
export function renderString(tpl: string, env: Record<string, unknown>): string {
  return tpl.replace(PLACEHOLDER, (_, path: string) => show(lookup(env, path)))
}

/**
 * 渲染 state 模板。整串只有一个占位符时保留原值（对象、数组原样放进 state），
 * 其他字符串做替换；所有字符串按 maxChars 截断。
 */
export function renderState(tpl: unknown, env: Record<string, unknown>, maxChars: number): unknown {
  if (typeof tpl === 'string') {
    const whole = WHOLE.exec(tpl)
    const v = whole ? lookup(env, whole[1]!) : renderString(tpl, env)
    return clipDeep(v, maxChars)
  }
  if (Array.isArray(tpl)) return tpl.map(x => renderState(x, env, maxChars))
  if (tpl !== null && typeof tpl === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(tpl)) {
      const r = renderState(v, env, maxChars)
      if (r !== undefined && r !== '') out[k] = r
    }
    return out
  }
  return tpl
}

function clipDeep(v: unknown, maxChars: number): unknown {
  if (typeof v === 'string') return clip(v, maxChars)
  if (Array.isArray(v)) return v.map(x => clipDeep(x, maxChars))
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x, maxChars)]))
  }
  return v
}
