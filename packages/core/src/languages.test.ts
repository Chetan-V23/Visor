import { createRequire } from 'node:module'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { graphFromModel, grammarForFile, type SemanticDocument } from '@visor/protocol'
import { analyzeSources, loadSourceParsers } from './languages'
import { diffModels } from './model'
import { digest } from './symbol-file'

const require = createRequire(import.meta.url)
let registry: Awaited<ReturnType<typeof loadSourceParsers>>
beforeAll(async () => { registry = await loadSourceParsers((grammar) => require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`)) })
afterAll(() => registry.dispose())
const analyze = (files: Record<string, string>, semantic: SemanticDocument[] = []) => analyzeSources(new Map(Object.entries(files)), registry.extractors, semantic)

it('recognizes JS/TS module suffixes and JSX dialects without treating extensionless names as source', () => {
  expect(['a.mjs', 'a.cjs', 'a.jsx', 'a.mts', 'a.cts', 'a.tsx', 'a.C', 'a.HPP', 'a.cs', 'ts', 'a.md'].map(grammarForFile))
    .toEqual(['javascript', 'javascript', 'javascript', 'typescript', 'typescript', 'tsx', 'cpp', 'cpp', 'c_sharp', undefined, undefined])
})

it('links a named import and JSX dependency but not a shadowing parameter or an external package', () => {
  const model = analyze({ 'lib.ts': 'export function format(n:number) { return n; }', 'Panel.jsx': 'export default function Panel() { return <div/>; }',
    'view.tsx': 'import {format as fmt} from "./lib"; import Panel from "./Panel"; import remote from "missing"; export const View = () => <Panel>{fmt(1)}</Panel>; export function run(fmt: () => void) { fmt(); remote(); }' })
  expect(model.relations.filter((edge) => edge.kind === 'calls').map((edge) => [edge.from, edge.to])).toEqual([['ts:view.tsx::View', 'ts:lib.ts::format']])
  expect(model.relations).toContainEqual(expect.objectContaining({ kind: 'depends', from: 'ts:view.tsx::View', to: 'js:Panel.jsx::Panel' }))
})

it('resolves literal CommonJS requires and named and default exports without inventing computed imports', () => {
  const model = analyze({ 'lib.cjs': 'function read() { return 1; } module.exports = {read};', 'fn.cjs': 'module.exports = function format() { return 2; };',
    'use.cjs': 'const {\nread: get\n} = require("./lib.cjs"); const format = require("./fn.cjs"); const other = require(path); function run() { return format(get()) + other(); }' })
  expect(model.relations.filter((edge) => edge.kind === 'calls').map((edge) => edge.to).sort()).toEqual(['js:fn.cjs::format', 'js:lib.cjs::read'])
})

it('retains declaration-only TS overload changes and exposes C# positional record properties', () => {
  const source = 'export function read(input:string):string; export function read(input:any) { return input; }'
  const before = analyze({ 'api.ts': source })
  const after = analyze({ 'api.ts': source.replace('input:string', 'input:number') })
  expect(diffModels(before, after)).toEqual([expect.objectContaining({ op: 'member.change', after: expect.objectContaining({ name: 'read' }) })])
  expect(analyze({ 'Person.cs': 'public record Person(string Name, int Age);' }).classes[0]?.fields.map((field) => [field.name, field.type])).toEqual([['Name', 'string'], ['Age', 'int']])
})

it('preserves qualified C++ overload identity and definition locations outside the namespace block', () => {
  const sources = { 'calc.hpp': 'namespace shop { struct Calc { int get(const int& a) const; int get(double a) const; }; }',
    'calc.cpp': '#include "calc.hpp"\nint shop::Calc::get(const int &renamed) const { return renamed; }' }
  const before = analyze(sources)
  const owner = before.classes.find((node) => node.name === 'Calc')
  expect(owner?.methods).toHaveLength(2)
  const method = owner?.methods.find((item) => item.bodyHash !== null)
  expect(method?.locations?.map(({ file, role }) => [file, role])).toEqual([['calc.hpp', 'declaration'], ['calc.cpp', 'definition']])
  const after = analyze({ ...sources, 'calc.cpp': sources['calc.cpp'].replace('return renamed;', 'return renamed + 1;') })
  expect(diffModels(before, after)).toEqual([expect.objectContaining({ op: 'member.change', after: expect.objectContaining({ id: method?.id }) })])
})

it.each([
  ['include guard', '#ifndef READER_H\n#define READER_H\nnamespace recon { struct Reader { void process(); }; }\n#endif'],
  ['export macro', 'namespace recon { class Recon_EXPORT Reader : public Base { public: void process(); }; }'],
])('keeps a C++ logging edit on the implementation method with a header %s', (_label, header) => {
  const source = '#include "Reader.h"\nvoid recon::Reader::process() {\n  consume();\n}'
  const before = analyze({ 'Reader.h': header, 'Reader.cpp': source })
  const after = analyze({ 'Reader.h': header, 'Reader.cpp': source.replace('  consume();', '  log("start");\n  consume();') })
  expect(diffModels(before, after)).toEqual([expect.objectContaining({ op: 'member.change', after: expect.objectContaining({
    name: 'process', locations: expect.arrayContaining([expect.objectContaining({ file: 'Reader.cpp', role: 'definition' })]),
  }) })])
  const reader = after.classes.find((node) => node.name === 'Reader')
  expect(reader?.methods.map((method) => method.name)).toEqual(['process'])
  expect(reader?.methods[0]?.locations).toContainEqual(expect.objectContaining({ file: 'Reader.h', role: 'declaration' }))
})

it('merges C# partial types within their project, keeps overload calls unresolved and ignores line movement', () => {
  const files = { 'app/App.csproj': '<Project/>', 'other/Other.csproj': '<Project/>', 'app/A.cs': 'namespace Shop; partial class Box { void Set(int n) { } void Run() { Set(1); } }',
    'app/B.cs': 'namespace Shop; partial class Box { void Set(string n) {} }', 'other/A.cs': 'namespace Shop; partial class Box { void Set(int n) {} }' }
  const model = analyze(files)
  const owners = model.classes.filter((item) => item.name === 'Box')
  expect(owners.map((item) => item.id)).toEqual(['cs:app/App.csproj::Shop.Box', 'cs:other/Other.csproj::Shop.Box'])
  expect(owners[0]?.methods.filter((method) => method.name === 'Set')).toHaveLength(2)
  expect(model.relations.filter((edge) => edge.kind === 'calls')).toEqual([])
  expect(diffModels(model, analyze({ ...files, 'app/A.cs': '\n' + files['app/A.cs'] }))).toEqual([])
})

it('uses IDE links only when the source and target hashes match the saved files', () => {
  const files = { 'use.js': 'export function run() { unknown(); }', 'other.ts': 'export function resolved() {}' }
  const document: SemanticDocument = { v: 1, workspaceRoot: 'workspace', provider: 'test', file: 'use.js', hash: digest(files['use.js']),
    definitions: [{ position: { line: 1, column: files['use.js'].indexOf('unknown') }, targets: [{ file: 'other.ts', hash: digest(files['other.ts']), range: { start: { line: 1, column: 16 }, end: { line: 1, column: 24 } } }] }] }
  const calls = (sources: Record<string, string>) => graphFromModel(analyze(sources, [document])).relations.filter((edge) => edge.kind === 'calls')
  expect(calls(files)).toEqual([expect.objectContaining({ from: 'js:use.js::run', to: 'ts:other.ts::resolved' })])
  expect(calls({ ...files, 'use.js': files['use.js'] + ' ' })).toEqual([])
  expect(calls({ ...files, 'other.ts': files['other.ts'] + ' ' })).toEqual([])
  const inside = structuredClone(document)
  const location = inside.definitions[0]?.targets[0]
  if (!location) throw new Error('Missing target location.')
  location.range = { start: { line: 1, column: 28 }, end: { line: 1, column: 29 } }
  expect(analyze(files, [inside]).relations.filter((edge) => edge.kind === 'calls')).toEqual([])
})