import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { RawHook } from '@visor/bridge'
import { startHookServer } from './hook-server'

const servers: Awaited<ReturnType<typeof startHookServer>>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())) })

async function start(onRaw: (raw: RawHook) => void = () => {}) {
  const server = await startHookServer({ onRaw })
  servers.push(server)
  return {
    url: `http://127.0.0.1:${server.runtime.port}`,
    headers: { Authorization: `Bearer ${server.runtime.token}`, 'Content-Type': 'application/json' }
  }
}

describe('authenticated local hook server', () => {
  it('requires a token for health and ingest', async () => {
    const { url, headers } = await start()
    expect((await fetch(`${url}/health`)).status).toBe(401)
    expect((await fetch(`${url}/health`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${url}/health`, { headers })).status).toBe(200)
    expect((await fetch(`${url}/hooks/raw`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('rejects every browser Origin, even with the correct token', async () => {
    const { url, headers } = await start()
    for (const origin of ['http://localhost', 'null', '']) {
      expect((await fetch(`${url}/health`, { headers: { ...headers, Origin: origin } })).status).toBe(403)
      expect((await fetch(`${url}/hooks/raw`, { method: 'POST', headers: { ...headers, Origin: origin }, body: '{}' })).status).toBe(403)
    }
  })

  it('delivers a valid raw envelope unchanged', async () => {
    const received: RawHook[] = []
    const { url, headers } = await start((raw) => { received.push(raw) })
    const raw: RawHook = { id: randomUUID(), source: 'copilot', event: 'sessionStart', receivedAt: 42, payload: { sessionId: 'test-session', cwd: 'test-workspace' } }
    const response = await fetch(`${url}/hooks/raw`, { method: 'POST', headers, body: JSON.stringify(raw) })
    expect(response.status).toBe(202)
    expect(received).toEqual([raw])
  })

  it('rejects invalid bodies and keeps serving health checks', async () => {
    const { url, headers } = await start()
    for (const body of ['not json', '{}', 'null']) {
      expect((await fetch(`${url}/hooks/raw`, { method: 'POST', headers, body })).status).toBe(400)
    }
    expect((await fetch(`${url}/hooks/raw`, { method: 'POST', headers, body: ' '.repeat(1024 * 1024 + 1) })).status).toBe(413)
    expect((await fetch(`${url}/health`, { headers })).status).toBe(200)
  })
})