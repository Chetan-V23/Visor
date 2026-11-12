export function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}