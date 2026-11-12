import fixture from '../fixtures/sample-diagram.json'
import type { DiagramSource, DiagramView } from './types'

function isDiagramView(value: typeof fixture): value is DiagramView {
  return value.classes.every((symbol) => symbol.methods.every((method) =>
    method.change === 'unchanged' || method.change === 'added' || method.change === 'deleted'
  ))
}

if (!isDiagramView(fixture)) {
  throw new Error('The sample diagram contains an invalid method change state.')
}

const view: DiagramView = fixture

export const fixtureSource: DiagramSource = {
  load: () => structuredClone(view)
}