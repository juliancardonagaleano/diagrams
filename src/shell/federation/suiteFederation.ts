import { listModuleRemotes } from './registry';
import type { ModuleRemoteRoutes } from './types';

export interface SuiteFederationEntry {
  remoteId: string;
  moduleId?: string;
  mountPath: string;
}

export function builtInFederationManifest(): SuiteFederationEntry[] {
  const modules = listModuleRemotes().map((r: ModuleRemoteRoutes) => ({
    remoteId: r.remoteId,
    moduleId: r.moduleId,
    mountPath: r.shellMountPath,
  }));
  return [...modules, { remoteId: 'mfe-trace', mountPath: '/trace' }];
}
