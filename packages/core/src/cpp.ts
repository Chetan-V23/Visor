import type { SymbolFile } from '@visor/protocol'
import type Parser from 'web-tree-sitter'
import { field, SymbolFileBuilder, type ContainerKind, type Syntax } from './symbol-file'

const types: Record<string, ContainerKind> = { class_specifier: 'class', struct_specifier: 'struct', enum_specifier: 'enum', union_specifier: 'struct' }
export function parseCpp(parser: Parser, text: string): Parser.Tree {
  const tree = parser.parse(text)
  const pieces: string[] = []
  let cursor = 0
  for (const specifier of tree.rootNode.descendantsOfType(['class_specifier', 'struct_specifier'])) {
    const parent = specifier.parent
    const name = field(specifier, 'name')
    if (!name || !/(?:^|_)(?:API|(?:DLL_?)?(?:EXPORT|IMPORT))$/.test(name.text) || field(specifier, 'body')) continue
    if (parent?.type !== 'function_definition' || field(parent, 'type')?.id !== specifier.id || field(parent, 'declarator')?.type !== 'identifier') continue
    pieces.push(text.slice(cursor, name.startIndex), ' '.repeat(name.endIndex - name.startIndex))
    cursor = name.endIndex
  }
  if (!pieces.length) return tree
  tree.delete()
  return parser.parse(pieces.join('') + text.slice(cursor))
}

function declaratorName(node: Syntax | null): Syntax | null {
  if (!node) return null
  if (['identifier', 'field_identifier', 'type_identifier', 'qualified_identifier', 'destructor_name', 'operator_name'].includes(node.type)) return node
  return declaratorName(field(node, 'declarator') ?? (node.type === 'reference_declarator' || node.type === 'parenthesized_declarator' ? node.lastNamedChild : null))
}
function functionDeclarator(node: Syntax | null): Syntax | null {
  if (!node) return null
  return node.type === 'function_declarator' ? node : functionDeclarator(field(node, 'declarator') ?? (node.type === 'reference_declarator' ? node.lastNamedChild : null))
}
function parameterKey(node: Syntax): string {
  const identifier = declaratorName(field(node, 'declarator'))
  const end = node.children.find((child) => child.type === '=')?.startIndex ?? node.endIndex
  const tokens: string[] = []
  const visit = (part: Syntax) => {
    if (part.startIndex >= end || part.id === identifier?.id || part.type === 'comment') return
    if (!part.childCount) tokens.push(part.text)
    else for (const child of part.children) visit(child)
  }
  visit(node)
  return tokens.join(' ')
}

export function extractCpp(root: Syntax, graph: SymbolFileBuilder): SymbolFile {
  const moduleId = graph.module(root)
  const filePrefix = `cpp:${graph.file}::`
  const global = () => {
    const id = graph.prefix + '<global>'
    if (!graph.result.symbols.some((symbol) => symbol.id === id)) graph.container(id, '(global)', 'namespace', root, null)
    return id
  }
  const visit = (node: Syntax, owner: string | null, inType: boolean, local = false, template = ''): void => {
    const prefix = local ? filePrefix : graph.prefix
    const inside = owner ? `${owner}.` : prefix
    if (node.type === 'preproc_include') {
      const path = field(node, 'path')
      if (path?.type === 'string_literal') graph.reference(moduleId, path.text, 'imports', path, path.text.slice(1, -1))
      return
    }
    if (node.type === 'template_declaration') {
      const parameters = field(node, 'parameters')
      for (const child of node.namedChildren) if (child.id !== parameters?.id) visit(child, owner, inType, local, `<${parameters?.namedChildCount ?? 0}>`)
      return
    }
    if (node.type === 'namespace_definition') {
      const name = field(node, 'name')?.text.replace(/::/g, '.')
      const id = name ? inside + name : `${filePrefix}<anonymous>${owner ? `.${owner.slice(owner.indexOf('::') + 2)}` : ''}`
      graph.container(id, name ?? '(anonymous)', 'namespace', node, owner)
      for (const child of field(node, 'body')?.namedChildren ?? []) visit(child, id, false, local || !name)
      return
    }
    const kind = types[node.type]
    if (kind) {
      const name = field(node, 'name')?.text
      if (!name) return
      const id = inside + name + template
      const body = field(node, 'body')
      const bases = node.namedChildren.find((child) => child.type === 'base_class_clause')?.namedChildren.filter((child) => child.type !== 'access_specifier') ?? []
      graph.container(id, name, kind, node, owner, bases.map((base) => base.text), !body)
      for (const base of bases) graph.reference(id, base.text, 'inherits', base)
      for (const child of body?.namedChildren ?? []) visit(child, id, true, local)
      return
    }
    if (['declaration_list', 'field_declaration_list', 'linkage_specification', 'preproc_ifdef', 'preproc_if', 'preproc_elif', 'preproc_else'].includes(node.type)) {
      for (const child of node.namedChildren) visit(child, owner, inType, local)
      return
    }
    if (node.type === 'enumerator' && owner) {
      const name = field(node, 'name')?.text
      if (name) graph.value(`${owner}.${name}`, name, owner, node, 'field', null, field(node, 'value'))
      return
    }
    if (!['declaration', 'field_declaration', 'function_definition'].includes(node.type)) return
    const type = field(node, 'type')
    if (type && types[type.type]) visit(type, owner, inType, local, template)
    const declarator = field(node, 'declarator')
    const fn = functionDeclarator(declarator)
    const identifier = declaratorName(fn ? field(fn, 'declarator') : declarator)
    if (!identifier) return
    const scoped = identifier.type === 'qualified_identifier'
    const scopes: string[] = []
    let tail: Syntax | null = identifier
    while (tail?.type === 'qualified_identifier') {
      const scope = field(tail, 'scope')
      if (scope) scopes.push(scope.text.replace(/::/g, '.'))
      tail = field(tail, 'name')
    }
    const name = tail?.text
    if (!name) return
    if (!fn) {
      if (inType && owner) {
        graph.value(inside + name, name, owner, node, 'field', type?.text ?? null, field(node, 'default_value') ?? field(declarator ?? node, 'value'))
        if (type) graph.reference(inside + name, type.text, 'associates', type)
      }
      return
    }
    const classScope = scopes.join('.')
    const internal = !inType && !scoped && node.namedChildren.some((child) => child.type === 'storage_class_specifier' && child.text === 'static')
    const parent = classScope ? inside + classScope : internal ? moduleId : owner ?? global()
    const parameters = field(fn, 'parameters')?.namedChildren.map(parameterKey) ?? []
    const qualifiers = fn.namedChildren.filter((child) => ['type_qualifier', 'ref_qualifier'].includes(child.type)).map((child) => child.text).join(' ')
    const id = `${parent}.${name}${template}(${parameters.join(',') === 'void' ? '' : parameters.join(',')})${qualifiers ? ` ${qualifiers}` : ''}`
    const body = field(node, 'body')
    graph.callable(id, name, parent, node, body, inType || scoped ? 'method' : 'function', tail)
    for (const call of body?.descendantsOfType('call_expression') ?? []) {
      const target = field(call, 'function')
      if (target) graph.reference(id, target.text, 'calls', target)
    }
  }
  for (const child of root.namedChildren) visit(child, null, false)
  return graph.result
}