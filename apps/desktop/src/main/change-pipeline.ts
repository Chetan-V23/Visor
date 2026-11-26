import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { RawHook } from '@visor/bridge'
import type { PendingHook } from '@visor/bridge/pending'
import { analyzeSources, contentHash, normalizeHook, createChange, diffModels, mentionedClassIds, SOURCE_ANALYSIS_VERSION, summarize } from '@visor/core'
import { changeSchema, grammarForFile, type Change, type CodeModel, type LanguageExtractor, type VisorEvent } from '@visor/protocol'
import type { ChangeStore, SnapshotFile, StoredChange } from '@visor/store'
import { readSource, readSourceSync, scanSources, snapshotPolicy, workspaceRoot } from '@visor/bridge/workspace'

export class ChangePipeline {
  private queue: Promise<void> = Promise.resolve()
  private readonly recovered = new Map<string, StoredChange>()

  constructor(private readonly options: {
    store: ChangeStore
    extractors: LanguageExtractor[]
    onNormalized: (events: VisorEvent[], error?: string) => void
    onChangeAdded: (change: StoredChange) => void
  }) {}

  enqueue(raw: RawHook, pending?: Pick<PendingHook, 'captured' | 'baseline'>): void {
    if (this.options.store.hasEvent(raw.id)) return
    let captured: SnapshotFile[] | undefined = pending?.captured
    try {
      const root = typeof raw.payload.cwd === 'string' ? raw.payload.cwd : ''
      const result = normalizeHook(raw, { workspaceRoot: root, workspaceId: contentHash(root), seq: 0 })
      const event = result.ok ? result.events[0] : undefined
      if (event?.kind === 'edit.pending' || event?.kind === 'edit.applied') {
        if (event.payload.files.length > 64) throw new Error('Tool snapshot exceeds the file limit.')
        const canonicalRoot = workspaceRoot(root)
        const allowed = snapshotPolicy(canonicalRoot)
        captured = captured?.filter((file) => event.payload.files.includes(file.path) && allowed(file.path))
          ?? event.payload.files.filter((path) => allowed(path)).map((path) => ({ path, text: readSourceSync(canonicalRoot, path) }))
        if (captured.reduce((bytes, file) => bytes + Buffer.byteLength(file.text ?? '', 'utf8'), 0) > 16 * 1024 * 1024) throw new Error('Tool snapshot exceeds the byte limit.')
      }
    } catch {
      this.options.onNormalized([], 'Tool snapshot failed. Check workspace access and source-size limits.')
      return
    }
    this.queue = this.queue.then(() => this.process(raw, captured, pending?.baseline)).catch(() => {
      this.options.onNormalized([], 'Change processing failed. Check workspace access and the Visor data folder.')
    })
  }

  async flush(): Promise<void> { await this.queue }

  listChanges(sessionId: string): Change[] {
    return this.options.store.listChanges(sessionId).filter((change) => change.cause.kind === 'baseline'
      || change.files.some((file) => this.options.extractors.some((extractor) => extractor.matches(file.path))))
  }

  snapshot(stored: StoredChange): StoredChange {
    const { change } = stored
    const hasFacts = this.options.store.semanticDocuments(change.sessionId).length > 0
    if (!hasFacts) {
      if ((stored.model.analysisVersion ?? 1) >= SOURCE_ANALYSIS_VERSION || !this.options.extractors.some((extractor) => extractor.language === 'cpp')) return stored
      if (!change.files.some((file) => grammarForFile(file.path) === 'cpp') && !stored.model.classes.some((node) => node.id.startsWith('cpp:'))) return stored
      const cached = this.recovered.get(change.id)
      if (cached) return cached
    }
    const snapshots = this.options.store.filesAtChange(change.sessionId, change.seq)
    if (!snapshots.length) return stored
    const after = new Map(snapshots.map((file) => [file.path, file.text ?? '']))
    if (change.files.some((file) => file.afterHash !== null ? !after.has(file.path) : file.beforeHash === null)) return stored
    const model = this.model(after, change.sessionId)
    let result: StoredChange = { change, model }
    if (change.cause.kind !== 'baseline') {
      const before = new Map(after)
      for (const file of change.files) {
        if (file.beforeHash === null) { before.delete(file.path); continue }
        const text = this.options.store.getBlob(file.beforeHash)
        if (text === null) return stored
        before.set(file.path, text)
      }
      const delta = [...diffModels(this.model(before, change.sessionId), model), ...change.delta.filter((entry) => entry.op === 'code.hunks' && entry.hunks.length > 0)]
      result = { model, change: { ...change, delta, summary: summarize(delta, change.files.length) } }
    }
    if (!hasFacts) {
      const oldest = this.recovered.keys().next().value
      if (this.recovered.size >= 4 && oldest !== undefined) this.recovered.delete(oldest)
      this.recovered.set(change.id, result)
    }
    return result
  }

  private model(files: Map<string, string>, sessionId = ''): CodeModel {
    return analyzeSources(files, this.options.extractors, this.options.store.semanticDocuments(sessionId))
  }

  private async process(raw: RawHook, captured?: SnapshotFile[], frozenBaseline?: SnapshotFile[]): Promise<void> {
    const store = this.options.store
    if (store.hasEvent(raw.id)) return
    const requestedRoot = typeof raw.payload.cwd === 'string' ? raw.payload.cwd : ''
    const probe = normalizeHook(raw, { workspaceRoot: requestedRoot, workspaceId: contentHash(requestedRoot), seq: 0 })
    if (!probe.ok) { this.options.onNormalized([], probe.error); return }
    if (!probe.events.length) return
    const root = workspaceRoot(requestedRoot)
    const project = { id: contentHash(process.platform === 'win32' ? root.toLowerCase() : root), root, name: basename(root), branch: '' }
    const normalized = normalizeHook(raw, { workspaceRoot: requestedRoot, workspaceId: project.id, seq: store.nextEventSequence(probe.events[0]?.sessionId ?? '') })
    if (!normalized.ok) { this.options.onNormalized([], normalized.error); return }
    const event = normalized.events[0]
    if (!event) return
    const affected = event.kind === 'edit.pending' || event.kind === 'edit.applied' ? captured?.map((file) => file.path) ?? event.payload.files : []
    const latest = store.latestChange(event.sessionId)
    let baseline: StoredChange | undefined
    let baselineFiles: SnapshotFile[] | undefined
    if (!latest) {
      baselineFiles = frozenBaseline ?? await scanSources(root)
      if (event.kind === 'edit.pending' || event.kind === 'edit.applied') {
        for (const path of affected) {
          const snapshot = captured?.find((file) => file.path === path)
          const text = snapshot ? snapshot.text : await readSource(root, path)
          const existing = baselineFiles.find((file) => file.path === path)
          if (existing) existing.text = text
          else baselineFiles.push({ path, text })
        }
      }
      const files = new Map(baselineFiles.filter((file) => file.text !== null).map((file) => [file.path, file.text ?? '']))
      const late = event.kind === 'edit.applied'
      baseline = {
        model: this.model(files, event.sessionId),
        change: changeSchema.parse({
          v: 1, id: randomUUID(), sessionId: event.sessionId, seq: 0, ts: event.ts,
          cause: { kind: 'baseline', eventId: event.id, observedAt: event.kind === 'session.started' ? 'session-start' : late ? 'after-first-edit' : 'before-first-edit' },
          summary: late ? 'Late baseline' : 'Baseline', files: [...files].map(([path, text]) => ({ path, beforeHash: null, afterHash: contentHash(text), added: 0, deleted: 0 })), delta: []
        })
      }
    }
    if (event.kind === 'edit.pending') {
      const model = latest?.model ?? baseline?.model
      const mentions = model ? mentionedClassIds(raw, { workspaceRoot: requestedRoot, files: affected, models: [model] }) : []
      if (mentions.length) event.payload[mentions.every((id) => id.startsWith('py:')) ? 'mentionedClasses' : 'mentionedSymbols'] = mentions
    }
    const pending = event.kind === 'edit.pending'
      ? captured ?? await Promise.all(event.payload.files.map(async (path) => ({ path, text: await readSource(root, path) }))) : undefined
    let change: StoredChange | undefined
    let snapshots = baselineFiles
    if (event.kind === 'edit.applied' && event.payload.outcome !== 'failed' && latest) {
      const before = new Map(store.currentFiles(event.sessionId).filter((file) => file.text !== null).map((file) => [file.path, file.text ?? '']))
      const observedBefore = event.payload.toolCallId ? store.pendingFiles(event.sessionId, event.payload.toolCallId) : []
      for (const file of observedBefore) {
        if (file.text === null) before.delete(file.path)
        else before.set(file.path, file.text)
      }
      const after = new Map(before)
      snapshots = captured ?? await Promise.all(event.payload.files.map(async (path) => ({ path, text: await readSource(root, path) })))
      const pairs = snapshots.map((file) => ({ path: file.path, before: before.get(file.path) ?? null, after: file.text }))
      for (const file of snapshots) {
        if (file.text === null) after.delete(file.path)
        else after.set(file.path, file.text)
      }
      if (pairs.some((pair) => pair.before !== pair.after && this.options.extractors.some((extractor) => extractor.matches(pair.path)))) {
        const model = this.model(after, event.sessionId)
        const beforeModel = this.model(before, event.sessionId)
        const pendingMentions = event.payload.toolCallId ? store.pendingClassMentions(event.sessionId, event.payload.toolCallId) : []
        const mentions = new Set([...pendingMentions, ...mentionedClassIds(raw, { workspaceRoot: requestedRoot, files: affected, models: [beforeModel, model] })])
        if (mentions.size) event.payload[[...mentions].every((id) => id.startsWith('py:')) ? 'mentionedClasses' : 'mentionedSymbols'] = [...mentions]
        change = { change: createChange(event, store.nextChangeSequence(event.sessionId), beforeModel, model, pairs), model }
      }
    }
    if (!store.commit(event, project, { ...(baseline ? { baseline } : {}), ...(change ? { change } : {}), ...(snapshots ? { snapshots } : {}), ...(pending ? { pending } : {}) })) return
    this.options.onNormalized([event])
    if (baseline) this.options.onChangeAdded(baseline)
    if (change) this.options.onChangeAdded(change)
  }
}