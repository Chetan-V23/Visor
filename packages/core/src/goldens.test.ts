import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it } from 'vitest'
import { CopilotAdapter, replay } from './index'
import { loadFrames, pythonParser } from '../../../apps/cli/src/fixtures'

const folder = new URL('../../../fixtures/normalized/', import.meta.url)
const manifest = z.object({ captures: z.array(z.string()).min(10) }).parse(JSON.parse(await readFile(new URL('manifest.json', folder), 'utf8')))

it.each(manifest.captures)('matches the reviewed normalization golden for %s', async (file) => {
  const raw: unknown = JSON.parse(await readFile(new URL(`../../../fixtures/raw-hooks/${file}`, import.meta.url), 'utf8'))
  const expected: unknown = JSON.parse(await readFile(new URL(file, folder), 'utf8'))
  expect(new CopilotAdapter({ workspaceRoot: '<workspace>', workspaceId: 'capture-workspace', seq: 0 }).normalize(raw)).toEqual({ ok: true, events: expected })
})

it('replays the actual captured NIfTI hooks against the reviewed source-pair golden', async () => {
  const { parser, extractor } = await pythonParser()
  try {
    const session = new URL('../../../fixtures/sessions/nifti-replay/', import.meta.url)
    const frames = await loadFrames(fileURLToPath(session))
    const actual = replay(frames, extractor)
    expect(actual).toEqual(JSON.parse(await readFile(new URL('expected.json', session), 'utf8')))
    expect(actual).toHaveLength(2)
    expect(actual[1]?.summary).toBe('Added class NiftiImage')
    expect(actual[1]?.delta).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'node.add', node: expect.objectContaining({ name: 'NiftiImage' }) }),
      expect.objectContaining({ op: 'member.add', member: expect.objectContaining({ name: 'compare_nifti' }) })
    ]))
    expect(replay([...frames, ...frames], extractor)).toEqual(actual)
  } finally { parser.delete() }
})