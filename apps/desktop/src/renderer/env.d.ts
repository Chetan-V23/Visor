import type { HookBridge } from '@visor/bridge'

declare global {
  interface Window { visorHooks?: HookBridge }
}