import { createHash } from 'node:crypto'
import Parser from 'web-tree-sitter'
import { fileModelSchema, type ClassSymbol, type FieldSymbol, type FileModel, type LanguageExtractor, type MethodSymbol, type RelationCandidate, type SourceRange, type SymbolReference } from '@visor/protocol'

type Node = Parser.SyntaxNode

function hash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex')
}

function range(node: Node): SourceRange {
  return {
    start: { line: node.startPosition.row + 1, column: node.startPosition.column },
    end: { line: node.endPosition.row + 1, column: node.endPosition.column }
  }
}

function definition(node: Node): Node {
  return node.type === 'decorated_definition' ? node.childForFieldName('definition') ?? node : node
}

function docstring(body: Node | null): string {
  const first = body?.firstNamedChild
  const string = first?.type === 'expression_statement' ? first.firstNamedChild : null
  if (string?.type !== 'string') return ''
  return string.text.replace(/^[rRuUbB]*('''|"""|'|")/, '').replace(/('''|"""|'|")$/, '')
}

function method(node: Node, owner: string): MethodSymbol | null {
  const name = node.childForFieldName('name')?.text
  const parameters = node.childForFieldName('parameters')?.text
  if (!name || !parameters || !/^[A-Za-z_]\w*$/.test(name)) return null
  const returnType = node.childForFieldName('return_type')?.text
  const body = node.childForFieldName('body')
  return {
    kind: 'method', id: `${owner}${name}`, name,
    signature: `${name}${parameters}${returnType ? ` -> ${returnType}` : ''}`,
    docstring: docstring(body), range: range(node), bodyHash: body ? hash(body.text) : null
  }
}

function assignments(node: Node): Node[] {
  if (['class_definition', 'function_definition', 'decorated_definition', 'lambda'].includes(node.type)) return []
  if (node.type === 'assignment') return [node]
  return node.namedChildren.flatMap(assignments)
}

function constructorName(node: Node | null): string | undefined {
  if (node?.type === 'call') return node.childForFieldName('function')?.text
  if (node?.type !== 'conditional_expression') return undefined
  const branches = [node.firstNamedChild, node.lastNamedChild]
  if (branches.some((branch) => !branch || (branch.type !== 'none' && !constructorName(branch)))) return undefined
  const names = new Set(branches.flatMap((branch) => {
    const name = constructorName(branch)
    return name ? [name] : []
  }))
  return names.size === 1 ? [...names][0] : undefined
}

function fields(node: Node, owner: string, instance: boolean): FieldSymbol[] {
  return assignments(node).flatMap((assignment) => {
    const left = assignment.childForFieldName('left')
    const name = left?.type === 'identifier' && !instance ? left.text
      : left?.type === 'attribute' && instance && left.childForFieldName('object')?.text === 'self'
        ? left.childForFieldName('attribute')?.text : undefined
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) return []
    const value = assignment.childForFieldName('right')
    const declaredType = assignment.childForFieldName('type')?.text
    const constructor = constructorName(value)
    return [{
      kind: 'field', id: `${owner}.${name}`, name,
      type: declaredType ?? (constructor && /(?:^|\.)[A-Z]\w*$/.test(constructor) ? constructor : null),
      range: range(assignment), ...(value ? { initializerHash: hash(value.text) } : {})
    } satisfies FieldSymbol]
  })
}

function descendants(node: Node): Node[] {
  if (['class_definition', 'function_definition', 'lambda'].includes(node.type)) return []
  return [node, ...node.namedChildren.flatMap(descendants)]
}

function typeReferences(node: Node | null): SymbolReference[] {
  if (!node) return []
  if (['identifier', 'attribute', 'dotted_name'].includes(node.type)) {
    return ['self', 'None', 'str', 'int', 'float', 'bool', 'list', 'tuple', 'dict', 'set', 'Optional', 'Union', 'Any', 'Callable', 'Path'].includes(node.text) ? [] : [{ name: node.text, range: range(node) }]
  }
  return node.namedChildren.flatMap(typeReferences)
}

function sourceAnalysis(path: string, text: string, root: Node, nodes: Map<string, Node>): NonNullable<FileModel['analysis']> {
  const bindings: NonNullable<FileModel['analysis']>['bindings'] = []
  for (const statement of root.namedChildren) {
    if (statement.type === 'import_from_statement') {
      const module = statement.childForFieldName('module_name')
      for (const item of statement.namedChildren.filter((child) => child.id !== module?.id)) {
        const name = item.childForFieldName('name')?.text ?? item.text
        if (name !== '*') bindings.push({ local: item.childForFieldName('alias')?.text ?? name, module: module?.text ?? '', name })
      }
    } else if (statement.type === 'import_statement') {
      for (const item of statement.namedChildren) {
        const module = item.childForFieldName('name')?.text ?? item.text
        bindings.push({ local: item.childForFieldName('alias')?.text ?? module.split('.')[0] ?? module, module, name: null })
      }
    }
  }
  const relations: RelationCandidate[] = []
  for (const [ownerId, node] of nodes) {
    const owner: SymbolReference = { name: ownerId, range: range(node) }
    const body = node.childForFieldName('body')
    if (!body) continue
    const members = body.namedChildren.map(definition).filter((member) => member.type === 'function_definition')
    const known = new Map<string, SymbolReference>([['self', owner]])
    const pending: { method: Node; environment: Map<string, SymbolReference>; statements: Node[] }[] = []
    for (const methodNode of members) {
      const environment = new Map(known)
      const parameters = methodNode.childForFieldName('parameters')?.namedChildren ?? []
      for (const parameter of parameters) {
        const references = typeReferences(parameter.childForFieldName('type'))
        const name = parameter.childForFieldName('name')?.text ?? parameter.firstNamedChild?.text
        if (name && references.length === 1 && references[0]) environment.set(name, references[0])
      }
      const methodBody = methodNode.childForFieldName('body')
      const statements = methodBody ? descendants(methodBody) : []
      for (const assignment of statements.filter((item) => item.type === 'assignment')) {
        const left = assignment.childForFieldName('left')
        const value = assignment.childForFieldName('right')
        if (!left) continue
        const declared = typeReferences(assignment.childForFieldName('type'))
        const constructor = constructorName(value)
        const constructed = constructor && /(?:^|\.)[A-Z]\w*$/.test(constructor)
        const supplied = value ? environment.get(value.text) ?? known.get(value.text) : undefined
        const reference = declared.length === 1 ? declared[0] : constructed ? { name: constructor, range: value ? range(value) : null } : supplied ?? (constructor ? { name: constructor, range: value ? range(value) : null } : undefined)
        if (reference) {
          environment.set(left.text, reference)
          if (left.text.startsWith('self.')) known.set(left.text, reference)
        }
        if (!left.text.startsWith('self.')) continue
        const collection = /\b(list|set|tuple|dict|Sequence|Iterable)\b/.test(assignment.childForFieldName('type')?.text ?? '')
          || ['list', 'set', 'dictionary', 'tuple'].includes(value?.type ?? '')
          || parameters.some((parameter) => (parameter.childForFieldName('name')?.text ?? parameter.firstNamedChild?.text) === value?.text && /\b(list|set|tuple|dict|Sequence|Iterable)\b/.test(parameter.childForFieldName('type')?.text ?? ''))
        const created = value && ['list', 'set', 'dictionary', 'tuple'].includes(value.type)
          ? descendants(value).filter((item) => item.type === 'call').flatMap((call) => { const name = constructorName(call); return name && /(?:^|\.)[A-Z]\w*$/.test(name) ? [{ name, range: range(call) }] : [] }) : []
        for (const target of created.length ? created : reference ? [reference] : []) relations.push({
          from: owner, to: { ...target, range: range(left.lastNamedChild ?? left) },
          kind: constructed || created.length ? 'composes' : collection ? 'aggregates' : 'associates',
          label: left.childForFieldName('attribute')?.text ?? left.text.slice(5), certainty: 'inferred',
          evidence: { file: path, range: range(assignment), reason: constructed || created.length ? 'Constructed and retained in a field; exclusive lifetime is inferred.' : collection ? 'Retained collection of references; shared lifetime is inferred.' : 'Retained reference; ownership is not established.' }
        })
      }
      pending.push({ method: methodNode, environment, statements })
    }
    for (const { method: methodNode, environment, statements } of pending) {
      const resolve = (expression: Node | null): SymbolReference | undefined => expression ? environment.get(expression.text) ?? known.get(expression.text) : undefined
      for (const call of statements.filter((item) => item.type === 'call')) {
        const callee = call.childForFieldName('function')
        const constructor = constructorName(call)
        if (constructor && /(?:^|\.)[A-Z]\w*$/.test(constructor)) relations.push({ from: owner, to: { name: constructor, range: callee ? range(callee) : null }, kind: 'depends', label: methodNode.childForFieldName('name')?.text ?? '', certainty: 'inferred', evidence: { file: path, range: range(call), reason: 'Constructor used by this method.' } })
        if (callee?.type !== 'attribute' || !['connect', 'subscribe'].includes(callee.childForFieldName('attribute')?.text ?? '')) continue
        const signal = callee.childForFieldName('object')
        const publisher = resolve(signal?.childForFieldName('object') ?? signal)
        const handler = call.childForFieldName('arguments')?.namedChildren[0]
        const receiver = resolve(handler?.childForFieldName('object') ?? null)
        const signalName = signal?.childForFieldName('attribute')?.text
        const handlerName = handler?.childForFieldName('attribute')?.text
        if (publisher && receiver && signalName && handlerName) relations.push({ from: publisher, to: receiver, kind: 'connects', label: `${signalName} -> ${handlerName}`, certainty: 'declared', evidence: { file: path, range: range(call), reason: 'Explicit signal/event subscription; runtime delivery is not asserted.' } })
      }
    }
  }
  return { hash: createHash('sha256').update(text).digest('hex'), bindings, relations }
}

export class PythonExtractor implements LanguageExtractor {
  readonly language = 'py'

  constructor(private readonly parser: Parser) {}

  matches(path: string): boolean { return path.toLowerCase().endsWith('.py') }

  extract(path: string, text: string): FileModel {
    const tree = this.parser.parse(text)
    const classes = new Map<string, ClassSymbol>()
    const nodes = new Map<string, Node>()
    const functions = new Map<string, MethodSymbol>()
    const imports: string[] = []
    const visit = (container: Node, prefix: string): void => {
      for (const child of container.namedChildren) {
        const node = definition(child)
        if (node.type === 'class_definition') {
          const name = node.childForFieldName('name')?.text
          const body = node.childForFieldName('body')
          if (!name || !body || !/^[A-Za-z_]\w*$/.test(name)) continue
          const qualified = `${prefix}${name}`
          const id = `py:${path}::${qualified}`
          nodes.set(id, node)
          const members = new Map<string, MethodSymbol>()
          const attributes = new Map<string, FieldSymbol>()
          for (const statement of body.namedChildren) {
            const item = definition(statement)
            if (item.type === 'function_definition') {
              const symbol = method(item, `${id}.`)
              if (symbol) {
                const prior = members.get(symbol.name)
                members.set(symbol.name, prior ? {
                  ...prior, bodyHash: hash(`${prior.bodyHash ?? ''}:${symbol.bodyHash ?? ''}`),
                  range: prior.range && symbol.range ? { start: prior.range.start, end: symbol.range.end } : prior.range
                } : symbol)
              }
              const functionBody = item.childForFieldName('body')
              if (functionBody) for (const field of fields(functionBody, id, true)) attributes.set(field.name, field)
            } else {
              for (const field of fields(item, id, false)) attributes.set(field.name, field)
            }
          }
          for (const member of members.values()) attributes.delete(member.name)
          classes.set(id, {
            id, name: qualified, file: path, range: range(node),
            bases: node.childForFieldName('superclasses')?.namedChildren.map((base) => base.text) ?? [],
            methods: [...members.values()], fields: [...attributes.values()]
          })
          visit(body, `${qualified}.`)
        } else if (node.type === 'function_definition' && prefix === '') {
          const symbol = method(node, `py:${path}::`)
          if (symbol) functions.set(symbol.id, symbol)
        } else if (node.type === 'import_statement' || node.type === 'import_from_statement') {
          imports.push(node.text)
        } else if (!['function_definition', 'class_definition'].includes(node.type)) {
          visit(node, prefix)
        }
      }
    }
    try {
      visit(tree.rootNode, '')
      return fileModelSchema.parse({ v: 1, language: this.language, file: path, classes: [...classes.values()], functions: [...functions.values()], imports, analysis: sourceAnalysis(path, text, tree.rootNode, nodes) })
    } finally { tree.delete() }
  }
}