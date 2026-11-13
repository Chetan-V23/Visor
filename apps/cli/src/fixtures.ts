import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import Parser from 'web-tree-sitter'
import { z } from 'zod'
import { PythonExtractor, type ReplayFrame } from '@visor/core'

const sessionSchema = z.object({ frames: z.array(z.object({
  capture: z.string(), files: z.array(z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() }))
})) })

export async function pythonParser(): Promise<{ parser: Parser; extractor: PythonExtractor }> {
  await Parser.init()
  const require = createRequire(import.meta.url)
  const language = await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'))
  const parser = new Parser()
  parser.setLanguage(language)
  return { parser, extractor: new PythonExtractor(parser) }
}

export async function loadFrames(folder: string): Promise<ReplayFrame[]> {
  const sessionFile = resolve(folder, 'session.json')
  const document = sessionSchema.parse(JSON.parse(await readFile(sessionFile, 'utf8')))
  const root = dirname(sessionFile)
  return Promise.all(document.frames.map(async (frame) => ({
    raw: JSON.parse(await readFile(resolve(root, '../../raw-hooks', frame.capture), 'utf8')) as unknown,
    files: await Promise.all(frame.files.map(async (file) => ({
      path: file.path,
      before: file.before === null ? null : await readFile(resolve(root, file.before), 'utf8'),
      after: file.after === null ? null : await readFile(resolve(root, file.after), 'utf8')
    })))
  })))
}