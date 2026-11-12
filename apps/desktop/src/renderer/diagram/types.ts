export type TextChange = 'unchanged' | 'added' | 'deleted'

export interface DiagramMethod {
  id: string
  name: string
  signature: string
  docstring: string
  change: TextChange
}

export interface DiagramClass {
  id: string
  name: string
  file: string
  methods: DiagramMethod[]
}

export interface DiagramEdge {
  id: string
  from: string
  to: string
  label: string
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