import { listModuleRemotes } from './registry';
import type { ModuleRemoteRoutes } from './types';

export function expectedEmbedPath(moduleId: string): string {
  const remote = listModuleRemotes().find((r) => r.moduleId === moduleId);
  if (!remote) throw new Error(`Módulo desconocido: ${moduleId}`);
  if (moduleId === 'c4') return '/';
  return remote.shellMountPath;
}

export function manifestEmbedForModule(moduleId: string): string {
  if (moduleId === 'c4') return '../';
  return `../modules/${moduleId}`;
}

export function remoteRoutesByModuleId(moduleId: string): ModuleRemoteRoutes | undefined {
  return listModuleRemotes().find((r) => r.moduleId === moduleId);
}
