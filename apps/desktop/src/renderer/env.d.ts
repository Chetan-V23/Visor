import type { HistoryBridge, HookBridge } from '@visor/bridge'

declare global {
  interface Window { visorHooks?: HookBridge; visorHistory?: HistoryBridge }
}