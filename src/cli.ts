#!/usr/bin/env node
/**
 * xiangxin-hook：给 command 类 hook 用的命令行（Claude Code、Codex、hermes shell hook、dsh 的 hooks 桥接）。
 *
 *   xiangxin-hook [claude-code|codex] [--config <path>]   从 stdin 读 hook 输入，stdout 输出决定
 *   xiangxin-hook explain [--config <path>] < input.json  打印每条规则的 state、答案与是否命中（调阈值用）
 *   xiangxin-hook check [--config <path>]                 只校验配置
 *
 * 任何错误都只写 stderr 并以 0 退出：hook 出问题时智能体照常工作。
 */
import { XiangxinClient } from '@xiangxinai/sdk'
import { findConfig, loadConfigFile } from './config.js'
import { render, type Dialect } from './dialects.js'
import { evaluate, type HookInput } from './engine.js'

function usage(): never {
  process.stderr.write(
    'usage: xiangxin-hook [claude-code|codex|explain|check] [--config <path>]\n' +
      '  配置查找顺序：--config、$XIANGXIN_HOOKS_CONFIG、<cwd>/.xiangxin/hooks.yaml、~/.xiangxin/hooks.yaml\n',
  )
  process.exit(2)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let mode = 'claude-code'
  let configPath: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--config' || a === '-c') configPath = args[++i]
    else if (a === '-h' || a === '--help') usage()
    else if (['claude-code', 'codex', 'explain', 'check'].includes(a)) mode = a
    else usage()
  }

  if (mode === 'check') {
    const path = findConfig(process.cwd(), configPath)
    if (!path) { process.stderr.write('没有找到配置文件\n'); process.exit(1) }
    const cfg = loadConfigFile(path)
    process.stdout.write(`${path}：${cfg.rules.length} 条规则，配置有效\n`)
    return
  }

  const raw = await readStdin()
  const input = JSON.parse(raw) as HookInput
  const path = findConfig(input.cwd ?? process.cwd(), configPath)
  if (!path) {
    if (mode === 'explain') process.stderr.write('没有找到配置文件\n')
    return
  }
  const config = loadConfigFile(path)
  if (mode !== 'explain' && !config.rules.some(r => r.event === input.hook_event_name)) return
  const client = new XiangxinClient({ timeout: config.timeout_ms, retry: { maxRetries: 1 }, logLevel: 'off' })
  const decision = await evaluate(input, config, client)

  if (mode === 'explain') {
    process.stdout.write(JSON.stringify({ config: path, ...decision }, null, 2) + '\n')
    return
  }
  const out = render(input, decision, mode as Dialect)
  if (out) process.stdout.write(JSON.stringify(out) + '\n')
}

main().catch((e: unknown) => {
  process.stderr.write(`xiangxin-hook: ${(e as Error)?.message ?? String(e)}\n`)
  process.exit(0)
})
