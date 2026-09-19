import type {
  autocompleteMultiselect,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts'

/** The `@clack/prompts` functions the interactive commands use. */
export interface Prompts {
  text: typeof text
  confirm: typeof confirm
  multiselect: typeof multiselect
  select: typeof select
  autocompleteMultiselect: typeof autocompleteMultiselect
  isCancel: typeof isCancel
  // The session look (spec 0007 §5b). Optional: a scripted terminal in a
  // test has prompts only, and gets the plain look.
  intro?: typeof intro
  outro?: typeof outro
  cancel?: typeof cancel
  note?: typeof note
  log?: typeof log
  spinner?: typeof spinner
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
