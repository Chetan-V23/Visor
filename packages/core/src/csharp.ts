import type { SymbolFile } from '@visor/protocol'
import { field, SymbolFileBuilder, type ContainerKind, type Syntax } from './symbol-file'

const types: Record<string, ContainerKind> = { class_declaration: 'class', interface_declaration: 'interface', struct_declaration: 'struct', record_declaration: 'record', record_struct_declaration: 'record', enum_declaration: 'enum' }
function arity(node: Syntax): string {
  const count = node.namedChildren.find((child) => child.type === 'type_parameter_list')?.namedChildren.length
  return count ? `<${count}>` : ''
}
function parameterTypes(parameters: Syntax | null): string {
  return (parameters?.namedChildren ?? []).filter((item) => item.type === 'parameter').map((item) => {
    const ref = item.children.some((child) => ['ref', 'in', 'out'].includes(child.text))
    return `${field(item, 'type')?.text.replace(/\s/g, '') ?? '?'}${ref ? '&' : ''}`
  }).join(',')
}

export function extractCSharp(root: Syntax, graph: SymbolFileBuilder): SymbolFile {
  const calls = (body: Syntax, from: string) => {
    for (const expression of body.descendantsOfType(['invocation_expression', 'object_creation_expression'])) {
      const target = field(expression, 'function') ?? field(expression, 'type')
      if (target) graph.reference(from, target.text, expression.type === 'invocation_expression' ? 'calls' : 'depends', target)
    }
  }
  const visit = (node: Syntax, parent: string | null): void => {
    const name = field(node, 'name')?.text
    const prefix = parent ? `${parent}.` : graph.prefix
    if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
      if (!name) return
      const id = prefix + name
      graph.container(id, name, 'namespace', node, parent)
      for (const child of (field(node, 'body') ?? node).namedChildren) visit(child, id)
      return
    }
    const kind = types[node.type]
    if (name && kind) {
      const id = prefix + name + arity(node)
      const bases = (field(node, 'bases') ?? node.namedChildren.find((child) => child.type === 'base_list'))?.namedChildren ?? []
      graph.container(id, name, kind, node, parent, bases.map((base) => base.text))
      if (node.namedChildren.some((child) => child.type === 'modifier' && child.text === 'partial')) graph.result.partial.push(id)
      for (const base of bases) graph.reference(id, base.text, 'inherits', base)
      const members = field(node, 'body')?.namedChildren ?? []
      if (kind === 'record') {
        const parameters = field(node, 'parameters') ?? node.namedChildren.find((item) => item.type === 'parameter_list')
        for (const parameter of parameters?.namedChildren ?? []) {
          const property = field(parameter, 'name')?.text
          if (property && !members.some((item) => field(item, 'name')?.text === property)) graph.value(`${id}.${property}`, property, id, parameter, 'property', field(parameter, 'type')?.text ?? null)
        }
      }
      for (const child of members) visit(child, id)
      return
    }
    if (!parent) return
    if (['method_declaration', 'constructor_declaration', 'destructor_declaration', 'operator_declaration', 'conversion_operator_declaration'].includes(node.type)) {
      const operator = field(node, 'operator') ?? field(node, 'type')
      const label = node.type === 'destructor_declaration' && name ? `~${name}` : name ?? (operator ? `operator ${operator.text}` : undefined)
      if (!label) return
      const id = `${prefix}${label}${arity(node)}(${parameterTypes(field(node, 'parameters'))})`
      const body = field(node, 'body') ?? node.namedChildren.find((child) => child.type === 'arrow_expression_clause') ?? null
      graph.callable(id, label, parent, node, body, 'method')
      if (body) calls(body, id)
    } else if (node.type === 'field_declaration' || node.type === 'event_field_declaration') {
      const declaration = node.namedChildren.find((child) => child.type === 'variable_declaration')
      if (!declaration) return
      const type = field(declaration, 'type')
      for (const variable of declaration.namedChildren.filter((child) => child.type === 'variable_declarator')) {
        const label = (field(variable, 'name') ?? variable.firstNamedChild)?.text
        if (!label) continue
        graph.value(prefix + label, label, parent, variable, node.type === 'event_field_declaration' ? 'event' : 'field', type?.text ?? null, variable.namedChildren[1])
        if (type) graph.reference(prefix + label, type.text, 'associates', type)
      }
    } else if (name && ['property_declaration', 'event_declaration', 'enum_member_declaration'].includes(node.type)) {
      const type = field(node, 'type')
      graph.value(prefix + name, name, parent, node, node.type === 'event_declaration' ? 'event' : node.type === 'property_declaration' ? 'property' : 'field', type?.text ?? null, field(node, 'value') ?? field(node, 'accessors') ?? field(node, 'body'))
      if (type) graph.reference(prefix + name, type.text, 'associates', type)
    }
  }
  for (const node of root.namedChildren) visit(node, null)
  return graph.result
}