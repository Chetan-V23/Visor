import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import Parser from 'web-tree-sitter'
import { z } from 'zod'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fileModelSchema } from '@visor/protocol'
import { PythonExtractor } from './python'
import { assembleModel, diffModels } from './model'

let parser: Parser
let extractor: PythonExtractor
beforeAll(async () => {
  await Parser.init()
  const require = createRequire(import.meta.url)
  const language = await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'))
  parser = new Parser()
  parser.setLanguage(language)
  extractor = new PythonExtractor(parser)
})
afterAll(() => parser.delete())

it('extracts classes, properties, fields and imports from the reconstructed NIfTI source fixture', async () => {
  const input = z.object({ payload: z.object({ tool_input: z.object({ content: z.string() }) }) }).parse(JSON.parse(await readFile(new URL('../../../fixtures/raw-hooks/preToolUse-1.json', import.meta.url), 'utf8')))
  const model = extractor.extract('image_compare.py', input.payload.tool_input.content)
  expect(model.classes.map((symbol) => symbol.name)).toEqual(['NpyImage', 'Main'])
  expect(model.classes[0]?.methods.map((symbol) => symbol.name)).toEqual(['__init__', 'name', 'shape'])
  expect(model.classes[0]?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'data', type: 'np.ndarray' })]))
  expect(model.classes[1]?.fields.map((symbol) => symbol.name)).toEqual(['IMAGE_A_PATH', 'IMAGE_B_PATH', 'image_a', 'image_b'])
  expect(model.imports).toHaveLength(3)
})

it('tracks initializer-only changes without exposing their values', () => {
  const before = extractor.extract('main.py', 'class Main:\n    IMAGE_A_PATH = "before.npy"\n')
  const after = extractor.extract('main.py', 'class Main:\n    IMAGE_A_PATH = "after.npy"\n')
  expect(before.classes[0]?.fields[0]?.initializerHash).not.toBe(after.classes[0]?.fields[0]?.initializerHash)
  expect(JSON.stringify(after)).not.toContain('after.npy')
})

it('resolves optional constructor fields without mistaking the condition for their type', () => {
  const model = extractor.extract('images.py', 'class Main:\n    def __init__(self, path):\n        self.image = Image(path) if path is not None else None\n        self.other = None if path is None else Viewer(path)\n        self.unknown = Image(path) if path else Viewer(path)\n        self.borrowed = Image(path) if path else cached\n')
  expect(model.classes[0]?.fields.map((field) => ({ name: field.name, type: field.type }))).toEqual([
    { name: 'image', type: 'Image' },
    { name: 'other', type: 'Viewer' },
    { name: 'unknown', type: null },
    { name: 'borrowed', type: null }
  ])
})

it('connects ownership, supplied references, collections and signals across imports', () => {
  const images = extractor.extract('models.py', 'class Loader:\n    completed = Signal()\n\nclass Viewer:\n    def refresh(self):\n        pass\n')
  const main = extractor.extract('main.py', 'from models import Loader, Viewer as Display\n\nclass Main:\n    def __init__(self, path, viewer: Display, viewers: list[Display]):\n        self.loader = Loader(path) if path else None\n        self.viewer = viewer\n        self.viewers = viewers\n        self.loader.completed.connect(self.viewer.refresh)\n')
  const model = assembleModel([images, main])
  expect(model.relations).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: 'py:main.py::Main', to: 'py:models.py::Loader', kind: 'composes', label: 'loader', certainty: 'inferred' }),
    expect.objectContaining({ from: 'py:main.py::Main', to: 'py:models.py::Viewer', kind: 'associates', label: 'viewer' }),
    expect.objectContaining({ from: 'py:main.py::Main', to: 'py:models.py::Viewer', kind: 'aggregates', label: 'viewers' }),
    expect.objectContaining({ from: 'py:models.py::Loader', to: 'py:models.py::Viewer', kind: 'connects', label: 'completed -> refresh', certainty: 'declared' })
  ]))
  expect(model.relations).toHaveLength(4)
  expect(model.relations.every((relation) => relation.evidence?.[0]?.range !== null)).toBe(true)
})

it('uses matching IDE type definitions for opaque fields and ignores stale source or target versions', () => {
  const target = extractor.extract('reader.py', 'class Reader:\n    pass\n\nclass OtherReader:\n    pass\n')
  const source = extractor.extract('main.py', 'class Main:\n    def __init__(self):\n        self.reader = make_reader()\n')
  const reference = source.analysis?.relations.find((relation) => relation.label === 'reader')
  const symbol = target.classes[0]
  const alternative = target.classes[1]
  if (!reference?.to.range || !symbol?.range || !alternative?.range || !source.analysis || !target.analysis) throw new Error('Missing semantic test locations.')
  const document = { v: 1 as const, workspaceRoot: 'D:/project', file: source.file, hash: source.analysis.hash, provider: 'vscode', definitions: [{ position: reference.to.range.start, targets: [{ file: target.file, hash: target.analysis.hash, range: symbol.range }] }] }
  expect(assembleModel([source, target]).relations).toEqual([])
  expect(assembleModel([source, target], [document]).relations[0]).toMatchObject({ kind: 'associates', to: symbol.id, label: 'reader' })
  expect(assembleModel([source, target], [{ ...document, hash: 'a'.repeat(64) }]).relations).toEqual([])
  expect(assembleModel([source, target], [{ ...document, definitions: [{ ...document.definitions[0], position: reference.to.range.start, targets: [{ file: target.file, hash: 'a'.repeat(64), range: symbol.range }] }] }]).relations).toEqual([])
  expect(assembleModel([source, target], [{ ...document, definitions: [{ position: reference.to.range.start, targets: [{ file: target.file, hash: target.analysis.hash, range: symbol.range }, { file: target.file, hash: target.analysis.hash, range: alternative.range }] }] }]).relations).toEqual([])
})

it('preserves both field labels and ignores evidence-only line shifts', () => {
  const source = 'class Image:\n    pass\n\nclass Main:\n    def compare(self):\n        self.image_a = Image()\n        self.image_b = Image()\n'
  const before = assembleModel([extractor.extract('images.py', source)])
  const after = assembleModel([extractor.extract('images.py', '\n' + source)])
  expect(before.relations).toHaveLength(1)
  expect(before.relations[0]).toMatchObject({ kind: 'composes', label: 'image_a / image_b' })
  expect(diffModels(before, after)).toEqual([])
})

it('extracts inheritance, nested classes, decorated methods, docstrings and free functions', () => {
  const model = extractor.extract('shapes.py', 'from abc import ABC\n\nclass Shape(ABC):\n    count: int = 0\n    @staticmethod\n    def draw(size: int) -> str:\n        """Draw a shape."""\n        return "ok"\n    class Options:\n        color: str\n\ndef build(shape: Shape) -> Shape:\n    return shape\n')
  expect(model.classes.map((symbol) => symbol.name)).toEqual(['Shape', 'Shape.Options'])
  expect(model.classes[0]?.bases).toEqual(['ABC'])
  expect(model.classes[0]?.methods[0]).toMatchObject({ signature: 'draw(size: int) -> str', docstring: 'Draw a shape.' })
  expect(model.classes[1]?.fields[0]).toMatchObject({ name: 'color', type: 'str' })
  expect(model.functions[0]?.id).toBe('py:shapes.py::build')
})

it('keeps getter/setter identity unique and observes setter body changes', () => {
  const source = 'class Item:\n    @property\n    def value(self):\n        return self._value\n    @value.setter\n    def value(self, value):\n        self._value = value\n'
  const before = extractor.extract('item.py', source)
  const after = extractor.extract('item.py', source.replace('self._value = value', 'self._value = str(value)'))
  expect(before.classes[0]?.methods).toHaveLength(1)
  expect(before.classes[0]?.methods[0]?.bodyHash).not.toBe(after.classes[0]?.methods[0]?.bodyHash)
  expect(fileModelSchema.safeParse(after).success).toBe(true)
})

it('recovers readable classes after a syntax error inside a method', () => {
  const model = extractor.extract('broken.py', 'class Broken:\n    def run(self):\n        value = (\n        return value\n\nclass Healthy:\n    def run(self):\n        return 1\n')
  expect(model.classes.map((symbol) => symbol.name)).toEqual(['Broken', 'Healthy'])
})

it('uses 1-based lines and UTF-16 columns, and normalizes body line endings', () => {
  const text = 'class Item:\n    def value(self): return "\u{1f642}"\n'
  const model = extractor.extract('item.py', text)
  expect(model.classes[0]?.methods[0]?.range).toEqual({ start: { line: 2, column: 4 }, end: { line: 2, column: 32 } })
  expect(model.classes[0]?.methods[0]?.bodyHash).toBe(extractor.extract('item.py', text.replace(/\n/g, '\r\n')).classes[0]?.methods[0]?.bodyHash)
})