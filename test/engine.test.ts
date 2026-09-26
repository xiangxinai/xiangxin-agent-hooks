import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Questions, SystemOneRequest, SystemOneResult } from '@xiangxinai/sdk'
import { ConfigError, compileWhen, evaluate, parseConfig, render, type SystemOneCaller } from '../src/index.js'
import { apply } from '../src/dsh.js'
import { parseFrontmatter } from '../src/skills.js'

/** 假客户端：按问题名给出预设答案，并记录请求。 */
function fake(answers: Record<string, unknown>): SystemOneCaller & { calls: SystemOneRequest<Questions>[] } {
  const calls: SystemOneRequest<Questions>[] = []
  return {
    calls,
    async systemOne(req) {
      calls.push(req)
      const out: Record<string, unknown> = {}
      for (const name of Object.keys(req.questions)) {
        const base = name.replace(/_\d+$/, '')
        if (base in answers) out[name] = answers[base]
      }
      return { model: String(req.model), answers: out, usage: { input_tokens: 1, output_tokens: 1 } } as SystemOneResult<Questions>
    },
  }
}

const noul = (p: number) => ({ type: 'noul', noul: p })
const choice = (c: string, probabilities: Record<string, number>, confidence = 0.8) => ({ type: 'choice', choice: c, probabilities, confidence })

const DANGER = {
  id: 'danger',
  event: 'PreToolUse',
  tools: 'Bash|shell',
  state: { 命令: '{{tool_input.command}}' },
  questions: { destructive: { type: 'noul', instructions: '会删除或覆盖用户数据吗？' } },
  when: 'destructive > 0.8',
  then: 'deny',
  message: '疑似破坏性命令（{{destructive}}）',
}

describe('when 表达式', () => {
  const wrap = (value: unknown, extra: object = {}) => ({ __xiangxin_answer__: true, value, ...extra })
  it('比较、逻辑与字段', () => {
    const env = { d: wrap(0.9), skill: wrap('pptx', { confidence: 0.7, p: { pptx: 0.8, 无: 0.2 } }) }
    expect(compileWhen('d > 0.8')(env)).toBe(true)
    expect(compileWhen('d > 0.8 and skill != "无"')(env)).toBe(true)
    expect(compileWhen('skill.confidence >= 0.75 or not d > 0.5')(env)).toBe(false)
    expect(compileWhen('skill.p["pptx"] - skill.p.无 > 0.5')(env)).toBe(true)
    expect(compileWhen('(d < 0.5 or skill == "pptx") and true')(env)).toBe(true)
  })
  it('缺失的答案让比较为假', () => {
    expect(compileWhen('missing > 0.1')({})).toBe(false)
  })
  it('语法错误在编译时抛出', () => {
    expect(() => compileWhen('d >')).toThrow(SyntaxError)
    expect(() => compileWhen('d > 0.8 0.9')).toThrow(SyntaxError)
  })
})

describe('配置校验', () => {
  it('补默认值', () => {
    const c = parseConfig({ rules: [DANGER] }, '/x')
    expect(c.model).toBe('xiangxin-latest')
    expect(c.timeout_ms).toBe(3000)
    expect(c.on_error).toBe('ignore')
  })
  it('拒绝写错的规则', () => {
    expect(() => parseConfig({ rules: [{ ...DANGER, when: 'destructive >' }] }, '/')).toThrow(ConfigError)
    expect(() => parseConfig({ rules: [{ ...DANGER, then: 'maybe' }] }, '/')).toThrow(ConfigError)
    expect(() => parseConfig({ rules: [{ ...DANGER, event: 'Whatever' }] }, '/')).toThrow(ConfigError)
    expect(() => parseConfig({ rules: [DANGER, DANGER] }, '/')).toThrow(/重复/)
    expect(() => parseConfig({ rules: [{ ...DANGER, reflex: 'Bad Name' }] }, '/')).toThrow(ConfigError)
  })
})

describe('evaluate', () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~/photos' }, cwd: '/tmp' }

  it('命中则 deny，并渲染 state 与理由', async () => {
    const client = fake({ destructive: noul(0.97) })
    const d = await evaluate(input, parseConfig({ rules: [DANGER] }, '/'), client)
    expect(client.calls[0]!.state).toEqual({ 命令: 'rm -rf ~/photos' })
    expect(d.action).toBe('deny')
    expect(d.reason).toBe('疑似破坏性命令（0.97）')
  })

  it('未命中不做决定', async () => {
    const d = await evaluate(input, parseConfig({ rules: [DANGER] }, '/'), fake({ destructive: noul(0.1) }))
    expect(d.action).toBeUndefined()
    expect(d.trace[0]!.matched).toBe(false)
  })

  it('工具名不匹配就不调用', async () => {
    const client = fake({ destructive: noul(0.99) })
    const d = await evaluate({ ...input, tool_name: 'Read' }, parseConfig({ rules: [DANGER] }, '/'), client)
    expect(client.calls).toHaveLength(0)
    expect(d.fired).toHaveLength(0)
  })

  it('完全相同的问题只问一次', async () => {
    const twin = { ...DANGER, id: 'twin', when: 'destructive > 0.5', then: 'ask' }
    const client = fake({ destructive: noul(0.7) })
    const d = await evaluate(input, parseConfig({ rules: [DANGER, twin] }, '/'), client)
    expect(Object.keys(client.calls[0]!.questions)).toEqual(['destructive'])
    expect(d.action).toBe('ask')
  })

  it('state 相同的规则合成一次请求，同名问题改名；取最严格的决定', async () => {
    const other = { ...DANGER, id: 'secrets', questions: { destructive: { type: 'noul' }, leak: { type: 'noul' } }, when: 'leak > 0.5', then: 'ask', message: '可能泄露密钥' }
    const client = fake({ destructive: noul(0.9), leak: noul(0.6) })
    const d = await evaluate(input, parseConfig({ rules: [DANGER, other] }, '/'), client)
    expect(client.calls).toHaveLength(1)
    expect(Object.keys(client.calls[0]!.questions).sort()).toEqual(['destructive', 'destructive_2', 'leak'])
    expect(d.action).toBe('deny')
    expect(d.reason).toBe('疑似破坏性命令（0.90）')
    expect(d.fired.map(f => f.rule)).toEqual(['danger', 'secrets'])
  })

  it('reflex 规则用 xiangxin-reflex:<名>', async () => {
    const client = fake({ ok: noul(0.9) })
    const rule = { id: 'auto', event: 'PermissionRequest', reflex: 'my-approver', questions: { ok: { type: 'noul' } }, when: 'ok > 0.8', then: 'allow' }
    const d = await evaluate({ ...input, hook_event_name: 'PermissionRequest' }, parseConfig({ rules: [rule] }, '/'), client)
    expect(client.calls[0]!.model).toBe('xiangxin-reflex:my-approver')
    expect(client.calls[0]!.state).toEqual({ 工具: 'Bash', 参数: { command: 'rm -rf ~/photos' } })
    expect(d.action).toBe('allow')
  })

  it('调用失败按 on_error 处理', async () => {
    const broken: SystemOneCaller = { systemOne: async () => { throw new Error('timeout') } }
    const ignore = await evaluate(input, parseConfig({ rules: [DANGER] }, '/'), broken)
    expect(ignore.action).toBeUndefined()
    expect(ignore.trace[0]!.error).toBe('timeout')
    const ask = await evaluate(input, parseConfig({ on_error: 'ask', rules: [DANGER] }, '/'), broken)
    expect(ask.action).toBe('ask')
  })

  it('skills 目录展开为 choice 选项，context 注入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xh-'))
    mkdirSync(join(dir, 'pptx'))
    writeFileSync(join(dir, 'pptx', 'SKILL.md'), '---\nname: pptx\ndescription: 创建和编辑 PowerPoint 演示文稿\n---\n正文')
    mkdirSync(join(dir, 'pdf'))
    writeFileSync(join(dir, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: >\n  读写 PDF\n  合并拆分\n---\n')
    const rule = {
      id: 'skill-router', event: 'UserPromptSubmit',
      questions: { skill: { type: 'choice', skills: [dir], criteria: { none: '不需要任何 skill' } } },
      when: 'skill != "none" and skill.confidence > 0.5', then: 'context',
      message: '与本次请求相关的 skill：{{skill}}（若不符合用户真实意图请忽略）',
    }
    const client = fake({ skill: choice('pptx', { pptx: 0.9, pdf: 0.05, none: 0.05 }) })
    const d = await evaluate({ hook_event_name: 'UserPromptSubmit', prompt: '帮我做个路演 PPT' }, parseConfig({ rules: [rule] }, '/'), client)
    expect((client.calls[0]!.questions.skill as { criteria: object }).criteria).toEqual({
      pptx: '创建和编辑 PowerPoint 演示文稿', pdf: '读写 PDF 合并拆分', none: '不需要任何 skill',
    })
    expect(d.context).toEqual(['与本次请求相关的 skill：pptx（若不符合用户真实意图请忽略）'])
  })

  it('skills 相对路径相对会话 cwd，而不是配置文件目录', async () => {
    const project = mkdtempSync(join(tmpdir(), 'xh-'))
    mkdirSync(join(project, '.claude', 'skills', 'pptx'), { recursive: true })
    writeFileSync(join(project, '.claude', 'skills', 'pptx', 'SKILL.md'), '---\nname: pptx\ndescription: 演示文稿\n---\n')
    const rule = { id: 'r', event: 'UserPromptSubmit', questions: { skill: { type: 'choice', skills: ['.claude/skills'], criteria: { none: null } } }, when: 'skill != "none"', then: 'context' }
    const client = fake({ skill: choice('none', { pptx: 0.1, none: 0.9 }) })
    await evaluate({ hook_event_name: 'UserPromptSubmit', prompt: 'PPT', cwd: project }, parseConfig({ rules: [rule] }, join(project, '.xiangxin')), client)
    expect(Object.keys((client.calls[0]!.questions.skill as { criteria: object }).criteria)).toEqual(['pptx', 'none'])
  })

  it('写日志', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xh-'))
    await evaluate(input, parseConfig({ log: 'log/hooks.jsonl', rules: [DANGER] }, dir), fake({ destructive: noul(0.95) }))
    const line = JSON.parse(readFileSync(join(dir, 'log/hooks.jsonl'), 'utf8').trim())
    expect(line.action).toBe('deny')
    expect(line.trace[0].answers.destructive.noul).toBe(0.95)
  })

  it('长字符串截断', async () => {
    const client = fake({ destructive: noul(0.1) })
    await evaluate({ ...input, tool_input: { command: 'x'.repeat(10_000) } }, parseConfig({ max_chars: 100, rules: [DANGER] }, '/'), client)
    expect((client.calls[0]!.state as { 命令: string }).命令.length).toBeLessThan(200)
  })
})

describe('输出方言', () => {
  const base = { context: [], trace: [] }
  const fired = [{ rule: 'r', action: 'deny' as const }]
  it('Claude Code PreToolUse', () => {
    const out = render({ hook_event_name: 'PreToolUse' }, { ...base, fired, action: 'deny', reason: '不行' }, 'claude-code')
    expect(out).toEqual({ systemMessage: '象信：r → deny', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '不行' } })
  })
  it('Codex 的 PreToolUse 不输出 allow / ask', () => {
    expect(render({ hook_event_name: 'PreToolUse' }, { ...base, fired, action: 'ask' }, 'codex')).toBeUndefined()
    expect(render({ hook_event_name: 'PreToolUse' }, { ...base, fired, action: 'deny', reason: 'x' }, 'codex'))
      .toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } })
  })
  it('PermissionRequest / UserPromptSubmit / Stop', () => {
    expect(render({ hook_event_name: 'PermissionRequest' }, { ...base, fired: [], action: 'allow' }, 'codex'))
      .toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(render({ hook_event_name: 'UserPromptSubmit' }, { ...base, fired: [], context: ['a', 'b'] }, 'codex'))
      .toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'a\n\nb' } })
    expect(render({ hook_event_name: 'Stop' }, { ...base, fired: [], action: 'deny', reason: '测试还没跑' }, 'codex'))
      .toEqual({ decision: 'block', reason: '测试还没跑' })
    expect(render({ hook_event_name: 'Stop', stop_hook_active: true }, { ...base, fired: [], action: 'deny' }, 'codex')).toBeUndefined()
  })
})

describe('frontmatter', () => {
  it('单行、引号、块', () => {
    expect(parseFrontmatter('---\nname: "a"\ndescription: |\n  x\n  y\n---')).toEqual({ name: 'a', description: 'x\ny' })
    expect(parseFrontmatter('无 frontmatter')).toEqual({})
  })
})

describe('dsh 插件', () => {
  it('pre-execute 拦截，approval 用记下的参数自动批准', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xh-'))
    mkdirSync(join(dir, '.xiangxin'))
    writeFileSync(join(dir, '.xiangxin', 'hooks.yaml'), `
rules:
  - id: danger
    event: PreToolUse
    tools: bash
    state: {命令: "{{tool_input.command}}"}
    questions: {destructive: {type: noul}}
    when: destructive > 0.8
    then: deny
  - id: safe-read
    event: PermissionRequest
    questions: {readonly: {type: noul}}
    when: readonly > 0.9
    then: allow
`)
    const listeners = new Map<string, (...a: any[]) => any>()
    const ctx = { on: (e: string, f: (...a: any[]) => any) => listeners.set(e, f), logger: { warn: () => {} } }
    process.env.XIANGXIN_API_KEY = 'sk-xx-test'
    apply(ctx)
    // 用假 fetch 替换网络：拦截全局 fetch
    const realFetch = globalThis.fetch
    const bodies: any[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const answers = Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: 'noul', noul: k === 'destructive' ? 0.95 : 0.99 }]))
      return new Response(JSON.stringify({ model: 'm', answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const agent = { session: { header: { id: 's', cwd: dir } } }
      const next = async () => ({ kind: 'allow' })
      const denied = await listeners.get('tools/pre-execute')!({ callId: 'c1', name: 'bash', arguments: { command: 'rm -rf /' }, agent }, next)
      expect(denied).toEqual({ kind: 'deny', reason: '象信规则 danger' })
      await listeners.get('tools/pre-execute')!({ callId: 'c2', name: 'read_file', arguments: { path: 'a.txt' }, agent }, next)
      const outcome = await listeners.get('approval/request')!({ agent, toolName: 'read_file', callId: 'c2' }, async () => 'rejected')
      expect(outcome).toBe('allowed-once')
      expect(bodies.at(-1).state).toEqual({ 工具: 'read_file', 参数: { path: 'a.txt' } })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
