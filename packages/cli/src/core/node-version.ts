/** The runtime floor of the published CLI (ADR 0010): Node 22.17, the line where `fs.glob` is stable. */
export const MIN_NODE = { major: 22, minor: 17 } as const
export const MIN_NODE_LABEL = `${MIN_NODE.major}.${MIN_NODE.minor}`

function component(version: string, index: number): number {
  const n = Number.parseInt(version.split('.')[index] ?? '', 10)
  return Number.isNaN(n) ? -1 : n
}

export function nodeMajor(version: string): number {
  return Math.max(component(version, 0), 0)
}

/** True from `MIN_NODE` on: a newer major, or the same major from its minor. */
export function isSupportedNode(version: string): boolean {
  const major = component(version, 0)
  const minor = component(version, 1)
  if (major < 0 || minor < 0) return false
  if (major !== MIN_NODE.major) return major > MIN_NODE.major
  return minor >= MIN_NODE.minor
}
