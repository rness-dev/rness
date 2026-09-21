import { run as runCli } from './cli.ts'
import { catchUp } from './core/catch-up.ts'

/**
 * What a launcher calls when it delegates to this copy. A launcher older than
 * 0.5.1 knows nothing about a pin that moved, so the check runs here as well
 * (spec 0008 §4); a launcher that already looked says so, and this is a no-op.
 */
export async function run(argv: string[]): Promise<number> {
  return (await catchUp(argv)) ?? runCli(argv)
}

export { VERSION } from './version.ts'
export {
  contextCommand,
  renderMarkdown,
  type ContextOptions,
} from './commands/context.ts'
export { validateCommand, type ValidateOptions } from './commands/validate.ts'
export { addCommand, type AddOptions } from './commands/add.ts'
export {
  createCommand,
  type CreateDeps,
  type CreateOptions,
  type Prompts,
} from './commands/create.ts'
export { parseFrontMatter, extractTitle } from './core/frontmatter.ts'
export { collectMarkdown } from './core/collect.ts'
export {
  loadManifest,
  NAME,
  NAME_RULE,
  ORG_NAME,
  parseRepoSpec,
  writeManifest,
} from './core/manifest.ts'
export { findWorkspace } from './core/workspace.ts'
export { resolveScope, scopeChain } from './core/scope.ts'
export {
  assembleContext,
  COLLECTIONS,
  type AssembleInput,
} from './core/context.ts'
export { checkContract, STATUSES } from './core/contract.ts'
export { scaffoldDir, SCAFFOLD_FILES } from './core/scaffold.ts'
export type * from './core/types.ts'
export { syncCommand, type SyncOptions } from './commands/sync.ts'
export { loginCommand, type LoginOptions } from './commands/login.ts'
export { logoutCommand } from './commands/logout.ts'
export type { CommandDeps } from './core/deps.ts'
export type {
  GitCredentials,
  GitProvider,
  Organization,
  OrganizationAccess,
} from './core/provider.ts'
export {
  GitHubOAuthProvider,
  githubProvider,
} from './core/github-oauth-provider.ts'
export { upgradeCommand, type UpgradeOptions } from './commands/upgrade.ts'
export { defaultTerminal, type Terminal } from './core/terminal.ts'
export {
  renderBlock,
  blockHash,
  parseHeader,
  bodyOf,
  BEGIN,
  END,
  BLOCK_SIZE_WARNING,
  type BlockInput,
  type RenderedBlock,
  type BlockHeader,
} from './core/block.ts'
export {
  mergeBlock,
  findBlock,
  ensureClaudeMd,
  type MergeResult,
  type FindResult,
} from './core/merge.ts'
export { exists, readOrNull, writeFileAtomic } from './core/fs.ts'
export {
  checkBlocks,
  type CheckBlocksInput,
  type CheckBlocksResult,
} from './core/blocks.ts'
export {
  addRepository,
  workspaceDirs,
  type AddRepositoryInput,
  type AddRepositoryResult,
} from './core/repos.ts'
export { copyScaffold, type ScaffoldTokens } from './core/scaffold-copy.ts'
export {
  detectPackageManager,
  isPackageManager,
  packageManagerVersion,
  installDependencies,
  PACKAGE_MANAGERS,
  type PackageManager,
} from './core/pm.ts'
export {
  repoUrl,
  probeRemote,
  classifyProbe,
  DEFAULT_HOST,
  SSH_HOST,
  type Probe,
} from './core/remote.ts'
export {
  detectGithubSsh,
  defaultTransport,
  GITHUB_HOSTS,
  type DetectSsh,
  type Hosts,
  type SshAccess,
  type Transport,
} from './core/transport.ts'
