import type { RawHook } from './index'

const lifecycle = {
  SessionStart: 'session.started',
  UserPromptSubmit: 'prompt.submitted',
  PreToolUse: 'edit.pending',
  PostToolUse: 'edit.applied',
  Stop: 'turn.ended',
  SessionEnd: 'session.ended'
} as const

export const hookProviders = {
  copilot: {
    label: 'GitHub Copilot',
    events: {
      sessionStart: 'session.started',
      userPromptSubmitted: 'prompt.submitted',
      preToolUse: 'edit.pending',
      postToolUse: 'edit.applied',
      agentStop: 'turn.ended'
    },
    aliases: { UserPromptSubmit: 'prompt.submitted', Stop: 'turn.ended', SessionEnd: 'session.ended', SessionEnded: 'session.ended' },
    editTools: [
      'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
      'insert_edit_into_file', 'apply_patch', 'edit_file',
      'edit_notebook_file', 'create_new_jupyter_notebook', 'vscode_renameSymbol'
    ]
  },
  codex: { label: 'Codex', events: lifecycle, aliases: {}, editTools: ['apply_patch'] },
  'claude-code': { label: 'Claude Code', events: lifecycle, aliases: {}, editTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] }
} as const

export type HookProvider = keyof typeof hookProviders

export function isHookProvider(value: string): value is HookProvider {
  return Object.hasOwn(hookProviders, value)
}

export function hookKind({ source, event }: Pick<RawHook, 'source' | 'event'>) {
  if (!isHookProvider(source)) return undefined
  const { events, aliases } = hookProviders[source]
  return [...Object.entries(events), ...Object.entries(aliases)]
    .find(([name]) => name.toLowerCase() === event.toLowerCase())?.[1]
}

export function isFileChangeHook(raw: RawHook): boolean {
  if (!isHookProvider(raw.source)) return false
  const kind = hookKind(raw)
  const tool = raw.payload.tool_name ?? raw.payload.toolName
  return (kind === 'edit.pending' || kind === 'edit.applied') &&
    hookProviders[raw.source].editTools.some((name) => name === tool)
}
