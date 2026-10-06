import { quoteWindowsCmdArgument } from '../shared/child-process/windows-command-line'

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    // Why: a pasted `\"` flips cmd.exe's quote parity (so `&` runs), and `%VAR%` expands inside quotes.
    return quoteWindowsCmdArgument(value)
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}
