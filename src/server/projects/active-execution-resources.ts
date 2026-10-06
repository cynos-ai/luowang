const activeResources = new Set<string>();

/** Process-local liveness only. A restart deliberately clears this so stale resources can recover. */
export function registerActiveExecutionResource(resourceId: string): () => void {
  if (activeResources.has(resourceId)) throw new Error('执行资源已经处于活动状态');
  activeResources.add(resourceId);
  return () => activeResources.delete(resourceId);
}

export function isExecutionResourceActive(resourceId: string): boolean {
  return activeResources.has(resourceId);
}
