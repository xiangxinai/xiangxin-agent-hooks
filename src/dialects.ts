import type { Decision, HookInput } from './engine.js'

export type Dialect = 'claude-code' | 'codex'

/**
 * 把决定翻译成 hook 的 stdout JSON。返回 undefined 表示不输出（放行、按原流程走）。
 *
 * 差异：Codex 的 PreToolUse 只支持 deny（allow / ask 会被判为不支持并忽略），
 * 所以在 codex 方言下 allow / ask 不输出 permissionDecision。
 */
export function render(input: HookInput, d: Decision, dialect: Dialect): Record<string, unknown> | undefined {
  const event = input.hook_event_name
  const context = d.context.length ? d.context.join('\n\n') : undefined
  const reason = d.reason ?? '象信规则拦截'
  const notice = dialect === 'claude-code' && d.fired.length
    ? { systemMessage: `象信：${d.fired.map(f => `${f.rule} → ${f.action}`).join('，')}` }
    : {}

  switch (event) {
    case 'PreToolUse': {
      let permission: Record<string, unknown> = {}
      if (d.action === 'deny') permission = { permissionDecision: 'deny', permissionDecisionReason: reason }
      else if (dialect === 'claude-code' && d.action === 'ask') permission = { permissionDecision: 'ask', permissionDecisionReason: reason }
      else if (dialect === 'claude-code' && d.action === 'allow') permission = { permissionDecision: 'allow', permissionDecisionReason: '象信规则放行' }
      if (!Object.keys(permission).length && !context) return undefined
      return {
        ...notice,
        hookSpecificOutput: { hookEventName: 'PreToolUse', ...permission, ...(context ? { additionalContext: context } : {}) },
      }
    }
    case 'PermissionRequest': {
      if (d.action === 'allow') {
        return { ...notice, hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
      }
      if (d.action === 'deny') {
        return { ...notice, hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } }
      }
      return undefined // ask：照常弹出确认
    }
    case 'UserPromptSubmit':
    case 'PostToolUse': {
      if (d.action === 'deny') return { ...notice, decision: 'block', reason }
      if (!context) return undefined
      return { ...notice, hookSpecificOutput: { hookEventName: event, additionalContext: context } }
    }
    case 'Stop': {
      // 已经因 Stop hook 继续过一次就不再拦，避免死循环
      if (d.action !== 'deny' || input.stop_hook_active) return undefined
      return { ...notice, decision: 'block', reason }
    }
    default:
      return undefined
  }
}
