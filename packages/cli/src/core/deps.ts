import type { GitProvider } from './provider.ts'
import type { Terminal } from './terminal.ts'
import type { Transport } from './transport.ts'

/**
 * What a command takes from the outside world, each part replaceable in
 * tests: the terminal (prompts), the transport (SSH or HTTPS) and the
 * provider (GitHub, as whom). A missing part is the real one.
 */
export interface CommandDeps {
  terminal: Terminal
  transport: Transport
  provider: GitProvider
}
