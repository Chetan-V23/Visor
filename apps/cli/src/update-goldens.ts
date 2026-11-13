import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CopilotAdapter, replay } from '@visor/core'
import { loadFrames, pythonParser } from './fixtures'

const root = resolve(import.meta.dirname, '../../..')
const rawFolder = resolve(root, 'fixtures/raw-hooks')
const output = resolve(root, 'fixtures/normalized')
await mkdir(output, { recursive: true })
const captures = (await readdir(rawFolder)).filter((file) => file.endsWith('.json')).sort()
const adapter = new CopilotAdapter({ workspaceRoot: '<workspace>', workspaceId: 'capture-workspace', seq: 0 })
for (const file of captures) {
  const raw: unknown = JSON.parse(await readFile(resolve(rawFolder, file), 'utf8'))
  const result = adapter.normalize(raw)
  if (!result.ok) throw new Error(`${file}: ${result.error}`)
  await writeFile(resolve(output, file), `${JSON.stringify(result.events, null, 2)}\n`)
}
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify({ captures }, null, 2)}\n`)
const { parser, extractor } = await pythonParser()
try {
  const folder = resolve(root, 'fixtures/sessions/nifti-replay')
  await writeFile(resolve(folder, 'expected.json'), `${JSON.stringify(replay(await loadFrames(folder), extractor), null, 2)}\n`)
} finally { parser.delete() }
process.stdout.write(`Updated ${captures.length} normalization goldens and the NIfTI replay golden. Review generated output before committing.\n`)