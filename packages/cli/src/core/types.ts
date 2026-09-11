export type Fields = Record<string, unknown>

export interface MarkdownItem {
  /** Absolute path. */
  path: string
  /** POSIX path relative to the collected directory. */
  rel: string
  /** Parsed front matter; null when absent or invalid (see fieldsError). */
  fields: Fields | null
  /** Parse error message when the front matter block is invalid. */
  fieldsError: string | null
  title: string | null
  body: string
}

export interface RepoEntry {
  url: string
}

export interface ScopeEntry {
  path: string
  extends: string[]
}

export interface Manifest {
  contract: 1
  repos: Record<string, RepoEntry>
  scopes: Record<string, ScopeEntry>
}

export interface Workspace {
  root: string
  rnessDir: string
}

export type CollectionName = 'standards' | 'adr' | 'specs' | 'plans' | 'skills'

export interface ContextFile {
  rel: string
  scope: string | null
  title: string | null
  body: string
}

export interface ContextCollection {
  name: CollectionName
  files: ContextFile[]
}

export interface Context {
  scope: string | null
  collections: ContextCollection[]
}
