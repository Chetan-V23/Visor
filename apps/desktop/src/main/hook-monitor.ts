import {
  isSessionStart, MAX_RECENT_EVENTS, sessionIdFrom, type HookSnapshot, type RawHook
} from '@visor/bridge'
import { captureRaw, sanitizeRaw } from './raw-capture'

export class HookMonitor {
  private events: RawHook[] = []
  private sessionId: string | null = null
  private debugEnabled = false
  private captureError: string | null = null
  private captureQueue: Promise<void> = Promise.resolve()
  private capturedIds = new Set<string>()

  constructor(private readonly options: {
    port: number
    dataFolder: string
    captureFolder: string | null
    onSnapshot: (snapshot: HookSnapshot) => void
    onSessionStart: () => void
  }) {}

  snapshot(): HookSnapshot {
    return {
      sessionId: this.sessionId,
      port: this.options.port,
      dataFolder: this.options.dataFolder,
      devMode: this.options.captureFolder !== null,
      debugEnabled: this.debugEnabled,
      captureFolder: this.options.captureFolder,
      captureError: this.captureError,
      events: this.debugEnabled ? structuredClone(this.events) : []
    }
  }

  setDebugEnabled(enabled: boolean): HookSnapshot {
    this.debugEnabled = enabled && this.options.captureFolder !== null
    if (this.debugEnabled) {
      for (const raw of this.events) this.enqueueCapture(raw)
    }
    this.options.onSnapshot(this.snapshot())
    return this.snapshot()
  }

  ingest(raw: RawHook): void {
    if (this.events.some((event) => event.id === raw.id)) return
    const sessionId = sessionIdFrom(raw)
    if (sessionId) this.sessionId = sessionId
    if (isSessionStart(raw.event)) this.options.onSessionStart()
    this.events.push(sanitizeRaw(raw))
    if (this.events.length > MAX_RECENT_EVENTS) this.events.shift()
    this.options.onSnapshot(this.snapshot())
    if (this.debugEnabled) this.enqueueCapture(raw)
  }

  private enqueueCapture(raw: RawHook): void {
    const folder = this.options.captureFolder
    if (folder && !this.capturedIds.has(raw.id)) {
      this.capturedIds.add(raw.id)
      this.captureQueue = this.captureQueue.then(() => captureRaw({ raw, folder })).catch(() => {
        this.capturedIds.delete(raw.id)
        this.captureError = 'Raw fixture capture failed. Check access to the capture folder.'
        this.options.onSnapshot(this.snapshot())
      })
    }
  }

  async flush(): Promise<void> { await this.captureQueue }
}