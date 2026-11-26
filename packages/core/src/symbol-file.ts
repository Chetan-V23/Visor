import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type Parser from 'web-tree-sitter'
import type { GraphSymbol, GraphLanguage, SourceRange, SymbolFile } from '@visor/protocol'

export type Syntax = Parser.SyntaxNode
export type ContainerKind = Extract<GraphSymbol, { bases: string[] }>['kind']
export function sourceRange(node: Syntax): SourceRange {
  return { start: { line: node.startPosition.row + 1, column: node.startPosition.column }, end: { line: node.endPosition.row + 1, column: node.endPosition.column } }
}
export function field(node: Syntax, name: string): Syntax | null { return node.childForFieldName(name) }
export function digest(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }

export class SymbolFileBuilder {
  readonly result: SymbolFile
  readonly prefix: string
  constructor(readonly file: string, readonly language: GraphLanguage, scope: string, private readonly text: string) {
    this.prefix = `${language}:${scope}::`
    this.result = { v: 2, language, file, hash: digest(text), symbols: [], selections: [], references: [], imports: [], exports: [], partial: [] }
  }
  module(node: Syntax): string {
    const id = `${this.language}:${this.file}::<module>`
    if (!this.result.symbols.some((symbol) => symbol.id === id)) this.container(id, posix.basename(this.file), 'module', node, null)
    return id
  }
  container(id: string, name: string, kind: ContainerKind, node: Syntax, ownerId: string | null, bases: string[] = [], declaration = false): void {
    this.select(id, field(node, 'name'))
    this.result.symbols.push({ id, name, kind, language: this.language, ownerId, bases,
      locations: [{ file: this.file, range: sourceRange(node), role: declaration ? 'declaration' : 'definition' }] })
  }
  private select(id: string, name: Syntax | null): void {
    if (name) this.result.selections.push({ id, range: sourceRange(name) })
  }
  callable(id: string, name: string, ownerId: string, node: Syntax, body: Syntax | null, kind: 'function' | 'method', selection = field(node, 'name')): void {
    this.select(id, selection)
    this.result.symbols.push({ id, name, kind, ownerId, language: this.language, docstring: '',
      signature: this.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).trim().replace(/;$/, ''),
      bodyHash: body ? digest(this.text.slice(body.startIndex, body.endIndex).replace(/\r\n?/g, '\n')) : null,
      locations: [{ file: this.file, range: sourceRange(node), role: body ? 'definition' : 'declaration' }] })
  }
  value(id: string, name: string, ownerId: string, node: Syntax, kind: 'field' | 'property' | 'event', type: string | null, initializer?: Syntax | null): void {
    this.select(id, field(node, 'name') ?? field(node, 'declarator'))
    this.result.symbols.push({ id, name, kind, ownerId, language: this.language, type,
      ...(initializer ? { initializerHash: digest(initializer.text.replace(/\r\n?/g, '\n')) } : {}),
      locations: [{ file: this.file, range: sourceRange(node), role: 'definition' }] })
  }
  reference(from: string, name: string, kind: SymbolFile['references'][number]['kind'], node: Syntax, module?: string): void {
    let target = node
    while (['member_expression', 'member_access_expression', 'field_expression', 'qualified_identifier'].includes(target.type)) {
      const next = field(target, 'property') ?? field(target, 'name') ?? field(target, 'field')
      if (!next) break
      target = next
    }
    this.result.references.push({ from, name, kind, range: sourceRange(target), ...(module ? { module } : {}) })
  }
}