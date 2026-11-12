import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { MAX_HOOK_BYTES, rawHookSchema, type RawHook, type Runtime } from '@visor/bridge'

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function authorized(request: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  const received = Buffer.from(request.headers.authorization ?? '')
  return expected.length === received.length && timingSafeEqual(expected, received)
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > MAX_HOOK_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startHookServer({ onRaw }: {
  onRaw: (raw: RawHook) => void | Promise<void>
}): Promise<{ runtime: Runtime; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex')
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.origin !== undefined) {
        reply(response, 403, { error: 'Browser requests are not allowed.' })
        return
      }
      if (!authorized(request, token)) {
        reply(response, 401, { error: 'Unauthorized.' })
        return
      }
      if (request.method === 'GET' && request.url === '/health') {
        reply(response, 200, { ok: true, pid: process.pid })
        return
      }
      if (request.method !== 'POST' || request.url !== '/hooks/raw') {
        reply(response, 404, { error: 'Not found.' })
        return
      }
      if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        reply(response, 415, { error: 'Expected application/json.' })
        return
      }
      const body = await readBody(request)
      if (body === null) {
        reply(response, 413, { error: 'Payload is too large.' })
        return
      }
      let input: unknown
      try { input = JSON.parse(body) } catch {
        reply(response, 400, { error: 'Invalid JSON.' })
        return
      }
      const parsed = rawHookSchema.safeParse(input)
      if (!parsed.success) {
        reply(response, 400, { error: 'Invalid raw hook envelope.' })
        return
      }
      await onRaw(parsed.data)
      reply(response, 202, { accepted: true, id: parsed.data.id })
    })().catch(() => {
      if (!response.headersSent) reply(response, 500, { error: 'Hook ingest failed.' })
      else response.end()
    })
  })
  server.requestTimeout = 2000
  server.headersTimeout = 2000
  server.on('connection', (socket) => socket.setTimeout(2000, () => socket.destroy()))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Cannot determine the hook server port.')

  return {
    runtime: { port: address.port, token, pid: process.pid },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    }
  }
}