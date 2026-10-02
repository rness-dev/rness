import { spawn } from 'node:child_process'

/** Open a URL in the browser of this machine; failures are nobody's problem: the URL is on the screen. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // no browser here: the URL is on the screen
  }
}

/** Over SSH there is no browser on this end: the URL is printed and that is all (spec 0004 §2). */
export function canOpenBrowser(): boolean {
  return process.env['SSH_CONNECTION'] === undefined
}
