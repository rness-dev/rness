import type {
  autocompleteMultiselect,
  confirm,
  isCancel,
  text,
} from '@clack/prompts'

/** The `@clack/prompts` functions the interactive commands use. */
export interface Prompts {
  text: typeof text
  confirm: typeof confirm
  autocompleteMultiselect: typeof autocompleteMultiselect
  isCancel: typeof isCancel
}

/** What an interactive command needs from the terminal; tests replace it with scripted answers. */
export interface Terminal {
  isTty(): boolean
  prompts(): Promise<Prompts>
}

export const defaultTerminal: Terminal = {
  isTty: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  // Lazy: the prompt library stays off every non-interactive path.
  prompts: () => import('@clack/prompts'),
}
