import type { ClassSymbol, GraphLanguage, Relation } from '@visor/protocol'

export const languageLabels = { py: ['PY', 'Python'], cpp: ['C++', 'C++'], cs: ['C#', 'C#'], js: ['JS', 'JavaScript'], ts: ['TS', 'TypeScript'] } as const

export type TextChange = 'unchanged' | 'added' | 'deleted'

export interface DiagramMethod {
  id: string
  name: string
  signature: string
  docstring: string
  change: TextChange
  modified?: boolean
  changeId?: string
}

export interface DiagramClass {
  id: string
  name: string
  file: string
  kind?: ClassSymbol['kind']
  language?: GraphLanguage
  methods: DiagramMethod[]
  fields?: { id: string; name: string; type: string | null; change: TextChange | 'modified' }[]
  change?: TextChange | 'modified'
}

export interface DiagramEdge {
  id: string
  from: string
  to: string
  label: string
  kind?: Relation['kind']
  certainty?: Relation['certainty']
  evidence?: Relation['evidence']
  change?: TextChange
}

export interface DiagramChange {
  id: string
  number: number
  summary: string
  time: string
  files: number
  added: number
  deleted: number
  classId: string
}

export interface DiagramView {
  session: { name: string; project: string; branch: string }
  classes: DiagramClass[]
  edges: DiagramEdge[]
  changes: DiagramChange[]
}

export interface DiagramSource {
  load(): DiagramView
}