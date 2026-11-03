import type { ModuleSlotHost, ProjectSlotContext } from '../slot';
import { importModuleRemote, importTraceRemote } from './registry';

function hostFromSearch(moduleId: string, search: string): ModuleSlotHost {
  const params = new URLSearchParams(search);
  const context: ProjectSlotContext = {
    moduleId,
    projectId: params.get('project') ?? undefined,
    diagramId: params.get('diagram') ?? undefined,
  };
  return { getContext: () => context };
}

export async function mountModuleRemoteInShell(moduleId: string, search: string): Promise<void> {
  const params = new URLSearchParams(search);
  if (params.get('bank') === '1') {
    await import('../../modules-app/main.tsx');
    return;
  }
  const remote = await importModuleRemote(moduleId);
  const handle = await remote.mount({ host: hostFromSearch(moduleId, search), searchParams: params });
  window.addEventListener('pagehide', () => handle.unmount(), { once: true });
}

export async function mountTraceRemoteInShell(search: string): Promise<void> {
  const remote = await importTraceRemote();
  const handle = await remote.mount({ searchParams: new URLSearchParams(search) });
  window.addEventListener('pagehide', () => handle.unmount(), { once: true });
}
