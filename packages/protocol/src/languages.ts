export const grammarExtensions = {
  python: ['py'], javascript: ['js', 'jsx', 'mjs', 'cjs'], typescript: ['ts', 'mts', 'cts'], tsx: ['tsx'],
  c_sharp: ['cs'], cpp: ['cpp', 'cc', 'cxx', 'c++', 'h', 'hpp', 'hh', 'hxx', 'ipp', 'tpp', 'inl']
} as const
export type Grammar = keyof typeof grammarExtensions
const byExtension = new Map<string, Grammar>()
for (const grammar of Object.keys(grammarExtensions) as Grammar[]) {
  for (const extension of grammarExtensions[grammar]) byExtension.set(extension, grammar)
}
export const sourceGlob = `**/*.{${[...byExtension.keys(), 'C'].join(',')}}`
export function grammarForFile(path: string): Grammar | undefined {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]
  return extension === 'C' ? 'cpp' : extension ? byExtension.get(extension.toLowerCase()) : undefined
}
export function isProjectMarker(path: string): boolean { return /(?:\.(?:csproj|vcxproj)|(?:^|\/)CMakeLists\.txt)$/i.test(path) }