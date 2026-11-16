import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { visorEventSchema, type CodeModel } from '@visor/protocol'
import { CopilotAdapter, mentionedClassIds, relativePath } from './copilot'

const adapter = new CopilotAdapter({ workspaceRoot: '<workspace>', workspaceId: 'capture-workspace', seq: 0 })
const raw = (tool: string, input: unknown, event = 'preToolUse') => ({
  id: randomUUID(), source: 'copilot', event, receivedAt: 42,
  payload: { session_id: 'test', tool_name: tool, tool_input: input }
})

describe('Copilot normalization', () => {
  it.each([
    ['sessionStart-1.json', 'session.started'], ['sessionStart-2.json', 'session.started'],
    ['userPromptSubmitted-1.json', 'prompt.submitted'], ['agentStop-1.json', 'turn.ended'], ['agentStop-2.json', 'turn.ended'],
    ['preToolUse-1.json', 'edit.pending'], ['preToolUse-2.json', 'edit.pending'], ['preToolUse-4.json', 'edit.pending'],
    ['postToolUse-1.json', 'edit.applied'], ['postToolUse-3.json', 'edit.applied']
  ])('normalizes real capture %s as %s', async (fixture, kind) => {
    const capture: unknown = JSON.parse(await readFile(new URL(`../../../fixtures/raw-hooks/${fixture}`, import.meta.url), 'utf8'))
    const result = adapter.normalize(capture)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.events[0]?.kind).toBe(kind)
    expect(result.events.every((event) => visorEventSchema.safeParse(event).success)).toBe(true)
    if (kind.startsWith('edit.')) expect(result.events[0]?.payload).toMatchObject({ files: ['image_compare.py'] })
    if (kind === 'edit.applied') expect(result.events[0]?.payload).toMatchObject({ outcome: 'unknown' })
  })
  it.each(['get_errors', 'read_file', 'grep_search', 'run_in_terminal', 'configure_python_environment', 'install_python_packages', 'memory'])('ignores %s for edits', (tool) => {
    expect(adapter.toEvents(raw(tool, { filePath: 'image_compare.py' }, 'postToolUse'))).toEqual([])
  })
  it.each([null, 42, {}, { id: 'invalid' }, raw('create_file', {}), raw('apply_patch', { input: 'not a patch' }), raw('create_file', { filePath: '../private.py' })])('returns an error without throwing for malformed input %#', (input) => {
    expect(() => adapter.normalize(input)).not.toThrow()
    expect(adapter.normalize(input).ok).toBe(false)
  })
  it('extracts only operation-header paths and retains rename source and destination', () => {
    const result = adapter.toEvents(raw('apply_patch', { input: '*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n@@\n+*** Update File: secret.py\n*** End Patch' }))
    expect(result[0]?.payload).toMatchObject({ files: ['a.py', 'b.py'], intent: 'rename' })
  })
  it('deduplicates multi-edit paths', () => {
    const result = adapter.toEvents(raw('multi_replace_string_in_file', { replacements: [{ filePath: 'a.py' }, { filePath: 'a.py' }, { filePath: 'b.py' }] }))
    expect(result[0]?.payload).toMatchObject({ files: ['a.py', 'b.py'] })
  })
  it('records explicit failure without guessing from empty or textual responses', () => {
    const hook = raw('create_file', { filePath: 'a.py' }, 'postToolUse')
    expect(adapter.toEvents({ ...hook, payload: { ...hook.payload, tool_response: { isError: true } } })[0]?.payload).toMatchObject({ outcome: 'failed' })
  })
})

describe('tool class mentions', () => {
  const symbol = (name: string, file = 'image_compare.py') => ({ id: `py:${file}::${name}`, name, file, range: null, bases: [], methods: [], fields: [] })
  const model: CodeModel = { v: 1, classes: ['JpegLossless', 'JpegImageFlipper', 'Flipper', 'Main', 'Unmentioned'].map((name) => symbol(name)), relations: [] }
  const context = { workspaceRoot: '<workspace>', files: ['image_compare.py'], models: [model] }

  it('resolves classes from replacement snippets and explanation without including other classes in the file', () => {
    const input = { explanation: 'Add Flipper class and call it after JpegImageFlipper.', replacements: [
      { filePath: 'image_compare.py', oldString: 'class Main:\n    IMAGE_A_PATH', newString: 'class Flipper(JpegLossless):\n    pass\n\nclass Main:\n    IMAGE_A_PATH' },
      { filePath: 'image_compare.py', oldString: 'JpegImageFlipper().display()', newString: 'JpegImageFlipper().display()\nself.flippers = (Flipper(), Flipper())' }
    ] }
    expect(mentionedClassIds(raw('multi_replace_string_in_file', input), context).sort()).toEqual(['Flipper', 'JpegImageFlipper', 'JpegLossless', 'Main'].map((name) => `py:image_compare.py::${name}`).sort())
  })

  it('ignores patch file headers and resolves unchanged context explicitly supplied by the tool', () => {
    expect(mentionedClassIds(raw('apply_patch', { input: '*** Begin Patch\n*** Update File: image_compare.py\n@@\n JpegImageFlipper().display()\n+Flipper()\n*** Update File: Unmentioned.py\n*** End Patch' }), context).sort()).toEqual(['py:image_compare.py::Flipper', 'py:image_compare.py::JpegImageFlipper'])
  })

  it('prefers classes in the edited file and does not guess ambiguous foreign names', () => {
    const models: CodeModel[] = [{ v: 1, classes: [symbol('Main'), symbol('Main', 'other.py'), symbol('Duplicate', 'one.py'), symbol('Duplicate', 'two.py')], relations: [] }]
    expect(mentionedClassIds(raw('replace_string_in_file', { filePath: 'image_compare.py', oldString: 'Main', newString: 'Main Duplicate' }), { ...context, models })).toEqual(['py:image_compare.py::Main'])
  })
})

it('confines both Windows and POSIX paths to the workspace', () => {
  expect(relativePath('D:\\Work\\src\\main.py', 'D:\\Work')).toBe('src/main.py')
  expect(relativePath('d:/work/src/main.py', 'D:\\Work')).toBe('src/main.py')
  expect(relativePath('/work/src/main.py', '/work')).toBe('src/main.py')
  expect(relativePath('src/main.py', '/work')).toBe('src/main.py')
  expect(relativePath('C:/private.py', 'D:\\Work')).toBeNull()
  expect(relativePath('/private.py', '/work')).toBeNull()
  expect(relativePath('src/../main.py', '/work')).toBeNull()
  expect(relativePath('/workspace-other/main.py', '/workspace')).toBeNull()
})