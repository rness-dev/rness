export const MIN_NODE_MAJOR = 24

export function nodeMajor(version: string): number {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isNaN(major) ? 0 : major
}

export function isSupportedNode(version: string): boolean {
  return nodeMajor(version) >= MIN_NODE_MAJOR
}
