import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RawHook } from '@visor/bridge'
import { writeJsonAtomic } from '@visor/bridge/node'
import { startHookServer } from '../../desktop/src/main/hook-server'
import { hookConfiguration, installHooks } from './install'

const folders: string[] = []
const servers: Awaited<ReturnType<typeof startHookServer>>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function temporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'visor-hook-'))
  folders.push(folder)
  return folder
}

async function runCli({ folder, input, event = 'postToolUse', disableLaunch = true }: { folder: string; input: string; event?: string; disableLaunch?: boolean }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('apps/hook/bin/visor-hook.cjs'), event], {
      env: { ...process.env, VISOR_DATA_DIR: folder, VISOR_APP_PATH: disableLaunch ? '' : undefined }, stdio: 'pipe'
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => resolveResult({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe('visor-hook CLI', () => {
  it.each([
    ['sessionStart', { tool_name: 'create_file' }],
    ['userPromptSubmitted', { prompt: 'Make a plan' }],
    ['agentStop', {}],
    ['preToolUse', { tool_name: 'read_file' }],
    ['postToolUse', { toolName: 'grep_search' }],
    ['PreToolUse', { tool_name: 'run_in_terminal' }],
    ['preToolUse', { tool_name: 'unknown_tool' }]
  ])('does not launch for %s with %j', async (event, payload) => {
    const folder = await temporaryFolder()
    const launcher = "require('node:fs').writeFileSync(require('node:path').join(process.env.VISOR_DATA_DIR, 'launched.json'), '{}')"
    await writeJsonAtomic(join(folder, 'config.json'), { appPath: process.execPath, appArgs: ['--eval', launcher] })
    expect(await runCli({ folder, input: JSON.stringify(payload), event, disableLaunch: false })).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
    expect(await readdir(folder)).not.toContain('launched.json')
  })

  it.runIf(process.platform === 'win32')('forwards stdin through the generated PowerShell hook command', async () => {
    const folder = await temporaryFolder()
    const received: RawHook[] = []
    const server = await startHookServer({ onRaw: (raw) => { received.push(raw) } })
    servers.push(server)
    await writeJsonAtomic(join(folder, 'runtime.json'), server.runtime)
    const hook = hookConfiguration({ nodePath: process.execPath, hookPath: resolve('apps/hook/bin/visor-hook.cjs') }).hooks.sessionStart?.[0]
    if (!hook) throw new Error('The installer did not create a sessionStart hook.')
    const code = await new Promise<number | null>((resolveResult, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hook.powershell], {
        env: { ...process.env, VISOR_DATA_DIR: folder }, stdio: ['pipe', 'ignore', 'ignore']
      })
      child.once('error', reject)
      child.once('close', resolveResult)
      child.stdin.end('{"sessionId":"powershell-session"}')
    })
    expect(code).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0]?.payload).toEqual({ sessionId: 'powershell-session' })
  })

  it('posts the original stdin JSON inside a fresh Copilot envelope', async () => {
    const folder = await temporaryFolder()
    const received: RawHook[] = []
    const server = await startHookServer({ onRaw: (raw) => { received.push(raw) } })
    servers.push(server)
    await writeJsonAtomic(join(folder, 'runtime.json'), server.runtime)
    const payload = { sessionId: 'cli-session', toolName: 'edit', toolArgs: { path: 'cart.py' } }
    expect(await runCli({ folder, input: JSON.stringify(payload) })).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ source: 'copilot', event: 'postToolUse', payload })
    expect(received[0]?.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(received[0]?.receivedAt).toEqual(expect.any(Number))
  })

  it('exits zero without an app or with a stale runtime', async () => {
    const folder = await temporaryFolder()
    expect((await runCli({ folder, input: '{}' })).code).toBe(0)
    await writeJsonAtomic(join(folder, 'runtime.json'), { port: 1, token: 'a'.repeat(64), pid: process.pid })
    expect(await runCli({ folder, input: '{}' })).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
  })

  it('exits zero for malformed or non-object stdin and invalid event names', async () => {
    const folder = await temporaryFolder()
    for (const input of ['not JSON', '', 'null', '[]']) {
      expect(await runCli({ folder, input })).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
    }
    expect((await runCli({ folder, input: '{}', event: '../unsafe' })).code).toBe(0)
  })

  it('ignores post timeouts without failing the agent', async () => {
    const folder = await temporaryFolder()
    const server = await startHookServer({ onRaw: () => new Promise<void>(() => {}) })
    servers.push(server)
    await writeJsonAtomic(join(folder, 'runtime.json'), server.runtime)
    expect(await runCli({ folder, input: '{}' })).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
  })

  it.each([
    ['preToolUse', { tool_name: 'create_file' }],
    ['PreToolUse', { toolName: 'replace_string_in_file' }],
    ['postToolUse', { tool_name: 'multi_replace_string_in_file' }]
  ])('launches a configured mock app for %s with %j and waits for its fresh runtime', async (event, payload) => {
    const folder = await temporaryFolder()
    const launcher = `
      const http = require('node:http');
      const fs = require('node:fs');
      const path = require('node:path');
      const folder = process.env.VISOR_DATA_DIR;
      const token = 'c'.repeat(64);
      const server = http.createServer((request, response) => {
        if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401); response.end(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/health') { response.end(JSON.stringify({ok: true, pid: process.pid})); return; }
        let text = '';
        request.on('data', chunk => { text += chunk; });
        request.on('end', () => {
          fs.writeFileSync(path.join(folder, 'received.json'), text);
          fs.writeFileSync(path.join(folder, 'args.json'), JSON.stringify(process.argv.slice(1)));
          response.end('{}');
          server.close();
          server.closeIdleConnections();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        fs.writeFileSync(path.join(folder, 'runtime.json'), JSON.stringify({port: server.address().port, token, pid: process.pid}));
      });
      setTimeout(() => { server.close(); server.closeAllConnections(); }, 4000).unref();
    `
    const argumentsToPreserve = ['folder with spaces', 'apostrophe\' and "quotes"', 'C:\\trailing\\']
    await writeJsonAtomic(join(folder, 'config.json'), { appPath: process.execPath, appArgs: ['--eval', launcher, '--', ...argumentsToPreserve] })
    expect(await runCli({ folder, input: JSON.stringify({ sessionId: 'cold-start', ...payload }), event, disableLaunch: false })).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
    const input: unknown = JSON.parse(await readFile(join(folder, 'received.json'), 'utf8'))
    expect(input).toMatchObject({ source: 'copilot', event, payload: { sessionId: 'cold-start', ...payload } })
    const receivedArguments: unknown = JSON.parse(await readFile(join(folder, 'args.json'), 'utf8'))
    expect(receivedArguments).toEqual(argumentsToPreserve)
  })

  it('registers the documented events idempotently without overwriting other hooks', async () => {
    const folder = await temporaryFolder()
    const workspace = await temporaryFolder()
    const options = { workspace, folder, config: { appPath: process.execPath, appArgs: [] }, hookPath: resolve('apps/hook/bin/visor-hook.cjs') }
    const path = await installHooks(options)
    const first = await readFile(path, 'utf8')
    expect(await installHooks(options)).toBe(path)
    expect(await readFile(path, 'utf8')).toBe(first)
    const input: unknown = JSON.parse(first)
    expect(input).toMatchObject({ version: 1, hooks: {
      sessionStart: expect.any(Array), userPromptSubmitted: expect.any(Array),
      preToolUse: expect.any(Array), postToolUse: expect.any(Array), agentStop: expect.any(Array)
    } })
    await expect(installHooks({ ...options, nodePath: resolve('different-node.exe') })).rejects.toThrow('Refusing to overwrite')
    expect(await readFile(path, 'utf8')).toBe(first)
  })
})