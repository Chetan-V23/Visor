import type { SymbolFile } from '@visor/protocol'
import { field, SymbolFileBuilder, type ContainerKind, type Syntax } from './symbol-file'

const types: Record<string, ContainerKind> = { class_declaration: 'class', abstract_class_declaration: 'class', class: 'class', interface_declaration: 'interface', enum_declaration: 'enum', type_alias_declaration: 'type' }
const functions = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function', 'arrow_function', 'function_signature'])

function localNames(node: Syntax, body: Syntax): Set<string> {
  const names = new Set<string>()
  const pattern = (part: Syntax | null) => {
    if (!part || part.type === 'type_annotation') return
    if (['identifier', 'shorthand_property_identifier_pattern'].includes(part.type)) { names.add(part.text); return }
    if (part.type === 'pair_pattern') { pattern(field(part, 'value')); return }
    if (part.type === 'assignment_pattern') { pattern(field(part, 'left')); return }
    if (part.type === 'required_parameter' || part.type === 'optional_parameter') { pattern(field(part, 'pattern') ?? part.firstNamedChild); return }
    for (const child of part.namedChildren) pattern(child)
  }
  pattern(field(node, 'parameters') ?? field(node, 'parameter'))
  const collect = (part: Syntax) => {
    if (functions.has(part.type) || types[part.type]) { pattern(field(part, 'name')); return }
    if (part.type === 'variable_declarator' || part.type === 'catch_clause') pattern(field(part, 'name') ?? field(part, 'parameter'))
    for (const child of part.namedChildren) collect(child)
  }
  collect(body)
  return names
}

export function extractWeb(root: Syntax, graph: SymbolFileBuilder): SymbolFile {
  const moduleId = graph.module(root)
  const refs = (node: Syntax, from: string, shadowed: ReadonlySet<string> = new Set()): void => {
    if (functions.has(node.type) || types[node.type]) return
    const target = node.type === 'call_expression' ? field(node, 'function') : node.type === 'new_expression' ? field(node, 'constructor')
      : node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element' ? field(node, 'name') : null
    if (target && !shadowed.has(target.text.split('.')[0] ?? '') && (node.type !== 'jsx_opening_element' && node.type !== 'jsx_self_closing_element' || /^[A-Z]/.test(target.text))) {
      graph.reference(from, target.text, node.type === 'call_expression' ? 'calls' : 'depends', target)
    }
    for (const child of node.namedChildren) refs(child, from, shadowed)
  }
  const visit = (node: Syntax, owner: string, exported = '', alias?: string): void => {
    if (node.type === 'expression_statement' && node.firstNamedChild?.type === 'assignment_expression') {
      const assignment = node.firstNamedChild
      const left = field(assignment, 'left')
      const right = field(assignment, 'right')
      if (!left || !right || left.type !== 'member_expression') return
      const object = field(left, 'object')?.text
      const property = field(left, 'property')?.text
      const key = object === 'module' && property === 'exports' ? 'default' : object === 'exports' || object === 'module.exports' ? property : undefined
      if (!key) return
      if (right.type === 'identifier') graph.result.exports.push({ name: key, id: graph.prefix + right.text })
      else if (functions.has(right.type) || types[right.type]) {
        const label = field(right, 'name')?.text ?? key
        visit(right, owner, '', label)
        graph.result.exports.push({ name: key, id: graph.prefix + label })
      } else if (key === 'default' && right.type === 'object') {
        for (const entry of right.namedChildren) {
          const value = entry.type === 'shorthand_property_identifier' ? entry : field(entry, 'value')
          const label = field(entry, 'key')?.text ?? value?.text
          if (label && value && ['identifier', 'shorthand_property_identifier'].includes(value.type)) graph.result.exports.push({ name: label, id: graph.prefix + value.text })
        }
      }
      return
    }
    if (node.type === 'export_statement') {
      const declaration = field(node, 'declaration') ?? field(node, 'value')
      if (declaration) visit(declaration, owner, node.children.some((child) => child.type === 'default') ? 'default' : 'named')
      else if (!field(node, 'source')) for (const item of node.descendantsOfType('export_specifier')) {
        const name = field(item, 'name')?.text
        if (name) graph.result.exports.push({ name: field(item, 'alias')?.text ?? name, id: graph.prefix + name })
      }
      return
    }
    if (node.type === 'import_statement') {
      const source = field(node, 'source')
      if (!source) return
      const specifier = source.text.slice(1, -1)
      graph.reference(moduleId, specifier, 'imports', source, specifier)
      const clause = node.namedChildren.find((child) => child.type === 'import_clause')
      for (const child of clause?.namedChildren ?? []) {
        if (child.type === 'identifier') graph.result.imports.push({ local: child.text, name: 'default', module: specifier })
        if (child.type === 'namespace_import' && child.lastNamedChild) graph.result.imports.push({ local: child.lastNamedChild.text, name: '*', module: specifier })
        for (const item of child.descendantsOfType('import_specifier')) {
          const name = field(item, 'name')?.text
          if (name) graph.result.imports.push({ local: field(item, 'alias')?.text ?? name, name, module: specifier })
        }
      }
      return
    }
    if (['lexical_declaration', 'variable_declaration', 'ambient_declaration'].includes(node.type)) {
      for (const child of node.namedChildren) visit(child, owner, exported)
      return
    }
    const binding = field(node, 'name')
    if (node.type === 'variable_declarator') {
      const value = field(node, 'value')
      const args = value && field(value, 'arguments')
      const literal = args?.namedChildCount === 1 ? args.firstNamedChild : null
      if (value?.type === 'call_expression' && field(value, 'function')?.text === 'require' && literal?.type === 'string') {
        const module = literal.text.slice(1, -1)
        graph.reference(moduleId, module, 'imports', literal, module)
        if (binding?.type === 'identifier') graph.result.imports.push({ local: binding.text, name: '*', module })
        if (binding?.type === 'object_pattern') for (const entry of binding.namedChildren) {
          const name = field(entry, 'key')?.text ?? entry.text
          const local = field(entry, 'value') ?? entry
          if (local.type === 'identifier' || local.type === 'shorthand_property_identifier_pattern') graph.result.imports.push({ local: local.text, name, module })
        }
        return
      }
      if (binding?.type !== 'identifier') return
    }
    if (binding?.type === 'computed_property_name') return
    const name = alias ?? binding?.text ?? (exported === 'default' ? 'default' : undefined)
    if (!name || /[\u0000-\u001f]/.test(name)) return
    const id = owner === moduleId ? graph.prefix + name : `${owner}.${name}`
    if (node.type === 'variable_declarator') {
      const value = field(node, 'value')
      if (value && (functions.has(value.type) || types[value.type])) { visit(value, owner, exported, name); return }
    }
    if (exported) graph.result.exports.push({ name: exported === 'default' ? 'default' : name, id })
    const kind = types[node.type]
    if (kind) {
      const bases = node.namedChildren.filter((child) => ['class_heritage', 'extends_type_clause'].includes(child.type))
        .flatMap((child) => child.descendantsOfType(['identifier', 'type_identifier']).filter((item) => item.parent?.type !== 'type_arguments'))
      graph.container(id, name, kind, node, owner, bases.map((item) => item.text))
      for (const base of bases) graph.reference(id, base.text, 'inherits', base)
      for (const member of field(node, 'body')?.namedChildren ?? []) visit(member, id)
    } else if (functions.has(node.type) || ['method_definition', 'method_signature', 'abstract_method_signature'].includes(node.type)) {
      const body = field(node, 'body')
      const declaration = alias && node.parent?.type === 'variable_declarator' ? node.parent : node
      graph.callable(id, name, owner, declaration, body, owner === moduleId ? 'function' : 'method')
      if (body) refs(body, id, localNames(node, body))
    } else if (['variable_declarator', 'field_definition', 'public_field_definition', 'property_signature'].includes(node.type)) {
      const value = field(node, 'value')
      graph.value(id, name, owner, node, 'field', field(node, 'type')?.text.replace(/^:\s*/, '') ?? null, value)
      if (value) refs(value, id)
    }
  }
  for (const child of root.namedChildren) visit(child, moduleId)
  return graph.result
}