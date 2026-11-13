import { createHash } from 'node:crypto'
import { diffLines, structuredPatch } from 'diff'
import type { MethodCode } from '@visor/bridge'
import { changeSchema, type Change, type CodeModel, type LanguageExtractor, type MethodSymbol, type VisorEvent } from '@visor/protocol'
import { CopilotAdapter } from './copilot'
import { assembleModel, diffModels, summarize } from './model'

export interface SourcePair { path: string; before: string | null; after: string | null }
export interface ReplayFrame { raw: unknown; files: SourcePair[] }

export function contentHash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }

type MethodSource = { text: string; range: NonNullable<MethodSymbol['range']> }

export function methodCode(input: { file: string; before: MethodSource | null; after: MethodSource | null }): MethodCode | null {
  if (!input.before && !input.after) return null
  const body = (source: MethodSource | null): string => {
    if (!source) return ''
    const { start, end } = source.range
    const lines = source.text.replace(/\r\n/g, '\n').split('\n').slice(start.line - 1, end.line - (end.column === 0 ? 1 : 0))
    if (end.column > 0 && lines.length > 0) lines[lines.length - 1] = (lines[lines.length - 1] ?? '').slice(0, end.column)
    return lines.length ? `${lines.join('\n')}\n` : ''
  }
  return { file: input.file, lines: diffLines(body(input.before), body(input.after)).flatMap((part) =>
    part.value.slice(0, -1).split('\n').map((text) => ({ kind: part.added ? 'added' : part.removed ? 'deleted' : 'unchanged', text }))
  ) }
}

export function createChange(event: Extract<VisorEvent, { kind: 'edit.applied' }>, seq: number, before: CodeModel, after: CodeModel, sources: SourcePair[]): Change {
  const delta = diffModels(before, after)
  const files = sources.filter((source) => source.before !== source.after).map((source) => {
    const patch = structuredPatch(source.path, source.path, source.before ?? '', source.after ?? '')
    const hunks = patch.hunks.map((hunk) => ({
      oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
      lines: hunk.lines.filter((line) => !line.startsWith('\\')).map((line) => ({
        kind: line.startsWith('+') ? 'added' as const : line.startsWith('-') ? 'deleted' as const : 'context' as const, text: line.slice(1)
      }))
    }))
    delta.push({ v: 1, op: 'code.hunks', file: source.path, hunks })
    return {
      path: source.path, beforeHash: source.before === null ? null : contentHash(source.before), afterHash: source.after === null ? null : contentHash(source.after),
      added: hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === 'added').length, 0),
      deleted: hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === 'deleted').length, 0)
    }
  })
  return changeSchema.parse({
    v: 1, id: event.id, sessionId: event.sessionId, seq, ts: event.ts,
    cause: { kind: 'tool', eventId: event.id, tool: event.payload.tool, ...(event.payload.toolCallId ? { toolCallId: event.payload.toolCallId } : {}) },
    summary: summarize(delta, files.length), files, delta
  })
}

export function replay(frames: ReplayFrame[], extractor: LanguageExtractor): Change[] {
  const sessions = new Map<string, { sources: Map<string, string>; model: CodeModel; seq: number; eventSeq: number }>()
  const seen = new Set<string>()
  const changes: Change[] = []
  for (const frame of frames) {
    const probe = new CopilotAdapter({ workspaceRoot: '<workspace>', workspaceId: 'capture-workspace', seq: 0 }).normalize(frame.raw)
    if (!probe.ok) throw new Error(probe.error)
    for (const event of probe.events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      let state = sessions.get(event.sessionId)
      if (!state) {
        const snapshot = frame.files.map((file) => ({ path: file.path, text: event.kind === 'edit.applied' ? file.after : file.before }))
        const sources = new Map(snapshot.filter((file) => file.text !== null).map((file) => [file.path, file.text ?? '']))
        const model = assembleModel([...sources].filter(([path]) => extractor.matches(path)).map(([path, text]) => extractor.extract(path, text)))
        state = { sources, model, seq: 0, eventSeq: 0 }
        sessions.set(event.sessionId, state)
        changes.push(changeSchema.parse({
          v: 1, id: event.id, sessionId: event.sessionId, seq: 0, ts: event.ts,
          cause: { kind: 'baseline', eventId: event.id, observedAt: event.kind === 'session.started' ? 'session-start' : event.kind === 'edit.applied' ? 'after-first-edit' : 'before-first-edit' },
          summary: event.kind === 'edit.applied' ? 'Late baseline' : 'Baseline',
          files: [...sources].map(([path, text]) => ({ path, beforeHash: null, afterHash: contentHash(text), added: 0, deleted: 0 })), delta: []
        }))
        if (event.kind === 'edit.applied') continue
      }
      state.eventSeq++
      if (event.kind !== 'edit.applied' || event.payload.outcome === 'failed') continue
      const pairs = event.payload.files.map((path) => {
        const supplied = frame.files.find((file) => file.path === path)
        if (!supplied) throw new Error('Replay frame is missing an applied file snapshot.')
        return { path, before: state.sources.get(path) ?? null, after: supplied.after }
      })
      if (!pairs.some((pair) => pair.before !== pair.after)) continue
      for (const pair of pairs) {
        if (pair.after === null) state.sources.delete(pair.path)
        else state.sources.set(pair.path, pair.after)
      }
      const after = assembleModel([...state.sources].filter(([path]) => extractor.matches(path)).map(([path, text]) => extractor.extract(path, text)))
      changes.push(createChange({ ...event, seq: state.eventSeq }, ++state.seq, state.model, after, pairs))
      state.model = after
    }
  }
  return changes
}