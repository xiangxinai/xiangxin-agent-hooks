/**
 * `when` 表达式：规则里的 if。只支持比较、and / or / not 与括号，不执行任意代码。
 *
 *     destructive > 0.8
 *     skill != "none" and skill.confidence >= 0.5
 *     risk.p["高"] + risk.p["极高"] > 0.6 or not safe > 0.5
 *
 * 名字取自答案：noul → 概率；score → 期望分；choice → 选中的选项名。
 * `.confidence`、`.p.<选项>`（即 probabilities）可取细节。
 */

export type Value = number | string | boolean | null | { readonly [k: string]: unknown }
export type Env = { readonly [name: string]: unknown }

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }

const OPS = ['>=', '<=', '==', '!=', '>', '<', '(', ')', '[', ']', '.', '+', '-']

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?/i.exec(src.slice(i))!
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++
        s += src[j]
        j++
      }
      if (j >= src.length) throw new SyntaxError(`未闭合的字符串 / unterminated string in: ${src}`)
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    const op = OPS.find(o => src.startsWith(o, i))
    if (op) { out.push({ t: 'op', v: op }); i += op.length; continue }
    // 名字允许中文等任意非空白、非运算符字符
    const m = /^[^\s()[\].<>=!+\-"']+/.exec(src.slice(i))
    if (!m) throw new SyntaxError(`无法识别的字符 / unexpected "${c}" in: ${src}`)
    out.push({ t: 'id', v: m[0] })
    i += m[0].length
  }
  return out
}

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'path'; head: string; rest: string[] }
  | { k: 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }

/** 解析一次，返回可反复求值的函数；语法错误在加载配置时就抛出。 */
export function compile(src: string): (env: Env) => boolean {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => { const t = peek(); return t?.t === 'op' && t.v === v }
  const isWord = (v: string) => { const t = peek(); return t?.t === 'id' && t.v.toLowerCase() === v }
  const expect = (v: string) => {
    if (!isOp(v)) throw new SyntaxError(`缺少 "${v}" / expected "${v}" in: ${src}`)
    p++
  }

  function or(): Node {
    let a = and()
    while (isWord('or')) { p++; a = { k: 'bin', op: 'or', a, b: and() } }
    return a
  }
  function and(): Node {
    let a = unary()
    while (isWord('and')) { p++; a = { k: 'bin', op: 'and', a, b: unary() } }
    return a
  }
  function unary(): Node {
    if (isWord('not')) { p++; return { k: 'not', a: unary() } }
    return cmp()
  }
  function cmp(): Node {
    const a = sum()
    const t = peek()
    if (t?.t === 'op' && ['>=', '<=', '==', '!=', '>', '<'].includes(t.v)) {
      p++
      return { k: 'bin', op: t.v, a, b: sum() }
    }
    return a
  }
  function sum(): Node {
    let a = primary()
    while (isOp('+') || isOp('-')) {
      const op = peek()!.v as string
      p++
      a = { k: 'bin', op, a, b: primary() }
    }
    return a
  }
  function primary(): Node {
    const t = peek()
    if (!t) throw new SyntaxError(`表达式不完整 / unexpected end of: ${src}`)
    if (t.t === 'num' || t.t === 'str') { p++; return { k: 'lit', v: t.v } }
    if (isOp('-')) { p++; return { k: 'bin', op: '-', a: { k: 'lit', v: 0 }, b: primary() } }
    if (isOp('(')) { p++; const e = or(); expect(')'); return e }
    if (t.t === 'id') {
      p++
      const low = t.v.toLowerCase()
      if (low === 'true' || low === 'false') return { k: 'lit', v: low === 'true' }
      if (low === 'null') return { k: 'lit', v: null }
      const rest: string[] = []
      for (;;) {
        if (isOp('.')) {
          p++
          const n = peek()
          if (n?.t !== 'id' && n?.t !== 'num') throw new SyntaxError(`"." 后缺少字段名 / expected field after "." in: ${src}`)
          rest.push(String(n.v)); p++
        } else if (isOp('[')) {
          p++
          const n = peek()
          if (n?.t !== 'str' && n?.t !== 'num') throw new SyntaxError(`[] 里须是字符串或数字 / expected string key in: ${src}`)
          rest.push(String(n.v)); p++
          expect(']')
        } else break
      }
      return { k: 'path', head: t.v, rest }
    }
    throw new SyntaxError(`意外的 "${t.v}" / unexpected "${t.v}" in: ${src}`)
  }

  const ast = or()
  if (p !== toks.length) throw new SyntaxError(`多余的内容 / trailing tokens in: ${src}`)
  return env => truthy(evaluate(ast, env))
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false && v !== 0 && v !== ''
}

function evaluate(n: Node, env: Env): unknown {
  switch (n.k) {
    case 'lit': return n.v
    case 'not': return !truthy(evaluate(n.a, env))
    case 'path': return resolvePath(env, n.head, n.rest)
    case 'bin': {
      if (n.op === 'and') return truthy(evaluate(n.a, env)) && truthy(evaluate(n.b, env))
      if (n.op === 'or') return truthy(evaluate(n.a, env)) || truthy(evaluate(n.b, env))
      const a = evaluate(n.a, env)
      const b = evaluate(n.b, env)
      switch (n.op) {
        case '==': return a === b
        case '!=': return a !== b
        case '+': return num(a) + num(b)
        case '-': return num(a) - num(b)
      }
      // 缺失的值（答案不存在）让比较为假，而不是抛错
      if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) return false
      switch (n.op) {
        case '>': return (a as number) > (b as number)
        case '<': return (a as number) < (b as number)
        case '>=': return (a as number) >= (b as number)
        case '<=': return (a as number) <= (b as number)
      }
      return false
    }
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : NaN
}

/**
 * 取值。答案对象被包装成 `{value, confidence, p}`：路径没有后续字段时取 `value`，
 * 这样 `destructive > 0.8` 与 `skill.confidence` 都能写。
 */
function resolvePath(env: Env, head: string, rest: string[]): unknown {
  let cur: unknown = env[head]
  for (const key of rest) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  if (cur !== null && typeof cur === 'object' && ANSWER in (cur as object)) {
    return (cur as Record<string, unknown>).value
  }
  return cur
}

/** 标记包装过的答案对象。 */
export const ANSWER = '__xiangxin_answer__'
