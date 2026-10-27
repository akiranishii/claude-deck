// POSIX shell quoting for the few places where a command line must be produced as text
// (Terminal launcher scripts and the remote command string sent by `ssh -t`).

// '=' is safe except as the first character (zsh expands a leading `=cmd`).
const SAFE = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/

/** Quote one argument for sh/bash/zsh. Anything not obviously safe is single-quoted. */
export function shq(arg: string): string {
  if (arg === '') return "''"
  if (/[\x00]/.test(arg)) throw new Error('Arguments must not contain NUL bytes')
  if (SAFE.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function shJoin(args: string[]): string {
  return args.map(shq).join(' ')
}
