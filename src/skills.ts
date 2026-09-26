import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface SkillEntry {
  name: string
  description: string
}

export function expandHome(p: string, cwd: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1))
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/** 读 SKILL.md 开头 frontmatter 里的 name / description（支持单行与 `|`、`>` 块）。 */
export function parseFrontmatter(text: string): Partial<SkillEntry> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const lines = m[1]!.split(/\r?\n/)
  const out: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    const key = kv[1]!
    let val = kv[2]!.trim()
    if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
      val = block.join(val.startsWith('|') ? '\n' : ' ')
    }
    out[key] = val.replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return { ...(out.name ? { name: out.name } : {}), ...(out.description ? { description: out.description } : {}) }
}

const cache = new Map<string, SkillEntry[]>()

/** 扫描若干目录下的 `<skill>/SKILL.md`。同名以先出现的为准。 */
export function loadSkills(dirs: readonly string[], cwd: string): SkillEntry[] {
  const key = `${cwd}\0${dirs.join('\0')}`
  const hit = cache.get(key)
  if (hit) return hit
  const seen = new Map<string, SkillEntry>()
  for (const raw of dirs) {
    const dir = expandHome(raw, cwd)
    if (!existsSync(dir)) continue
    for (const sub of readdirSync(dir)) {
      const file = join(dir, sub, 'SKILL.md')
      try {
        if (!statSync(join(dir, sub)).isDirectory() || !existsSync(file)) continue
        const fm = parseFrontmatter(readFileSync(file, 'utf8'))
        const name = fm.name ?? sub
        if (!seen.has(name)) seen.set(name, { name, description: fm.description ?? '' })
      } catch {
        // 读不了的 skill 跳过
      }
    }
  }
  const list = [...seen.values()]
  cache.set(key, list)
  return list
}
