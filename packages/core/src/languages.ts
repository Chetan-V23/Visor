import { posix } from 'node:path'
import Parser from 'web-tree-sitter'
import { grammarExtensions, grammarForFile, isProjectMarker, type Grammar, type LanguageExtractor, type SemanticDocument, type SymbolFile, type FileModel } from '@visor/protocol'
import { PythonExtractor } from './python'
import { extractCSharp } from './csharp'
import { extractCpp, parseCpp } from './cpp'
import { extractWeb } from './web'
import { SymbolFileBuilder } from './symbol-file'
import { assembleModel } from './model'

export async function loadSourceParsers(resolveGrammar: (grammar: Grammar) => string) {
  await Parser.init()
  const parsers: Parser[] = []
  const extractors: LanguageExtractor[] = []
  const dispose = () => { for (const parser of parsers.splice(0)) parser.delete() }
  try {
    for (const grammar of Object.keys(grammarExtensions) as Grammar[]) {
      const parser = new Parser()
      parsers.push(parser)
      parser.setLanguage(await Parser.Language.load(resolveGrammar(grammar)))
      if (grammar === 'python') { extractors.push(new PythonExtractor(parser)); continue }
      const language = grammar === 'javascript' ? 'js' : grammar === 'c_sharp' ? 'cs' : grammar === 'cpp' ? 'cpp' : 'ts'
      const extract = language === 'cs' ? extractCSharp : language === 'cpp' ? extractCpp : extractWeb
      extractors.push({ language, matches: (file) => grammarForFile(file) === grammar, extract(file, text, scope = '@workspace') {
        const tree = grammar === 'cpp' ? parseCpp(parser, text) : parser.parse(text)
        try { return extract(tree.rootNode, new SymbolFileBuilder(file, language, language === 'js' || language === 'ts' ? file : scope, text)) }
        finally { tree.delete() }
      } })
    }
    return { extractors, dispose }
  } catch (error) { dispose(); throw error }
}

export function analyzeSources(sources: ReadonlyMap<string, string>, extractors: LanguageExtractor[], semantic: SemanticDocument[] = []) {
  const markers = [...sources.keys()].filter(isProjectMarker)
  const files: (FileModel | SymbolFile)[] = []
  for (const [file, text] of sources) {
    const extractor = extractors.find((candidate) => candidate.matches(file))
    if (!extractor) continue
    let scope = '@workspace'
    if (extractor.language === 'cpp' || extractor.language === 'cs') {
      const candidates = markers.filter((marker) => /\.csproj$/i.test(marker) === (extractor.language === 'cs'))
      for (let folder = posix.dirname(file); ; folder = posix.dirname(folder)) {
        const local = candidates.filter((marker) => posix.dirname(marker) === folder)
        if (local.length) { scope = local.length === 1 ? local[0] ?? file : file; break }
        if (folder === '.') break
      }
    }
    files.push(extractor.extract(file, text, scope))
  }
  return assembleModel(files, semantic)
}

export function referencePositions(file: FileModel | SymbolFile) {
  const positions = file.v === 2 ? file.references.map((reference) => reference.range.start)
    : file.analysis?.relations.flatMap((relation) => [relation.from, relation.to].flatMap((reference) => reference.range && !reference.name.startsWith('py:') ? [reference.range.start] : [])) ?? []
  return [...new Map(positions.map((point) => [`${point.line}:${point.column}`, point])).values()].slice(0, 512)
}