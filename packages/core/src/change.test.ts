import { expect, it } from 'vitest'
import { changeSchema, type CodeModel, type LanguageExtractor, type VisorEvent } from '@visor/protocol'
import { contentHash, createChange, methodCode, replay } from './change'

it('counts exact UTF-8 file changes and emits real diff hunks', () => {
  const event: Extract<VisorEvent, { kind: 'edit.applied' }> = { v: 1, id: '339cdbac-705c-42e2-b60f-8b6b1319d042', source: 'copilot', sessionId: 'test', seq: 2, ts: 42, kind: 'edit.applied', payload: { tool: 'apply_patch', files: ['a.py'], intent: 'edit', outcome: 'unknown' } }
  const model: CodeModel = { v: 1, classes: [], relations: [] }
  const change = createChange(event, 1, model, model, [{ path: 'a.py', before: 'value = 1\n', after: 'value = 2\n' }])
  expect(changeSchema.safeParse(change).success).toBe(true)
  expect(change.files[0]).toMatchObject({ added: 1, deleted: 1, beforeHash: contentHash('value = 1\n'), afterHash: contentHash('value = 2\n') })
  expect(change.delta[0]).toMatchObject({ op: 'code.hunks', hunks: [{ lines: [{ kind: 'deleted', text: 'value = 1' }, { kind: 'added', text: 'value = 2' }] }] })
  expect(contentHash('value = 1\n')).not.toBe(contentHash('value = 1\r\n'))
})

it('uses the after-state for a post-only late baseline, without inventing the missing edit', () => {
  const extractor: LanguageExtractor = { language: 'py', matches: () => true, extract: (file) => ({ v: 1, language: 'py', file, classes: [], functions: [], imports: [] }) }
  const raw = { id: '339cdbac-705c-42e2-b60f-8b6b1319d042', source: 'copilot', event: 'postToolUse', receivedAt: 42, payload: { session_id: 'cold', tool_name: 'create_file', tool_input: { filePath: 'a.py' } } }
  const changes = replay([{ raw, files: [{ path: 'a.py', before: 'unobserved', after: 'observed' }] }], extractor)
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ seq: 0, cause: { observedAt: 'after-first-edit' }, files: [{ beforeHash: null, afterHash: contentHash('observed') }] })
})

it('previews the entire method with unchanged context and both changed source lines', () => {
  const range = { start: { line: 2, column: 4 }, end: { line: 4, column: 16 } }
  const preview = methodCode({
    file: 'a.py',
    before: { text: 'class A:\r\n    def run(self):\r\n        keep = 1\r\n        return 1\r\n', range },
    after: { text: 'class A:\n    def run(self):\n        keep = 1\n        return 2\n', range }
  })
  expect(preview).toEqual({ file: 'a.py', lines: [
    { kind: 'unchanged', text: '    def run(self):' },
    { kind: 'unchanged', text: '        keep = 1' },
    { kind: 'deleted', text: '        return 1' },
    { kind: 'added', text: '        return 2' }
  ] })
})

it('previews added and removed whole methods without including the next method', () => {
  const source = { text: 'class A:\n    def run(self):\n        return 7\n    def other(self):\n        pass\n', range: { start: { line: 2, column: 4 }, end: { line: 4, column: 0 } } }
  expect(methodCode({ file: 'a.py', before: null, after: source })?.lines).toEqual([
    { kind: 'added', text: '    def run(self):' }, { kind: 'added', text: '        return 7' }
  ])
  expect(methodCode({ file: 'a.py', before: source, after: null })?.lines).toEqual([
    { kind: 'deleted', text: '    def run(self):' }, { kind: 'deleted', text: '        return 7' }
  ])
  expect(methodCode({ file: 'a.py', before: source, after: source })?.lines).toEqual([
    { kind: 'unchanged', text: '    def run(self):' }, { kind: 'unchanged', text: '        return 7' }
  ])
  expect(methodCode({ file: 'a.py', before: null, after: null })).toBeNull()
})