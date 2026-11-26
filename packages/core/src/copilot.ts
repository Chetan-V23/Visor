import type { HarnessAdapter, VisorEvent } from '@visor/protocol'
import { normalizeHook, type AdapterContext, type Normalization } from './hooks'

export { mentionedClassIds, relativePath, type AdapterContext, type Normalization } from './hooks'

export class CopilotAdapter implements HarnessAdapter<unknown> {
  readonly source = 'copilot'
  constructor(private readonly context: AdapterContext) {}

  toEvents(raw: unknown): VisorEvent[] {
    const result = this.normalize(raw)
    return result.ok ? result.events : []
  }

  normalize(raw: unknown): Normalization {
    return normalizeHook(raw, this.context, this.source)
  }
}
