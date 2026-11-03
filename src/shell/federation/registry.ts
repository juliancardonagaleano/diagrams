import type { ModuleRemoteRoutes } from './types';

const MODULE_REMOTES: ModuleRemoteRoutes[] = [
  { remoteId: 'mfe-c4', moduleId: 'c4', shellMountPath: '/modules/c4' },
  { remoteId: 'mfe-integration', moduleId: 'integration', shellMountPath: '/modules/integration' },
  { remoteId: 'mfe-data', moduleId: 'data', shellMountPath: '/modules/data' },
  { remoteId: 'mfe-enterprise', moduleId: 'enterprise', shellMountPath: '/modules/enterprise' },
  { remoteId: 'mfe-platform', moduleId: 'platform', shellMountPath: '/modules/platform' },
  { remoteId: 'mfe-security', moduleId: 'security', shellMountPath: '/modules/security' },
];

export function listModuleRemotes(): readonly ModuleRemoteRoutes[] {
  return MODULE_REMOTES;
}

export function moduleRemoteId(moduleId: string): string | undefined {
  return MODULE_REMOTES.find((r) => r.moduleId === moduleId)?.remoteId;
}

export async function importModuleRemote(moduleId: string): Promise<import('./types').ModuleRemoteModule> {
  switch (moduleId) {
    case 'c4':
      return import('../../mfe/mfe-c4/routes').then((m) => m.default);
    case 'integration':
      return import('../../mfe/mfe-integration/routes').then((m) => m.default);
    case 'data':
      return import('../../mfe/mfe-data/routes').then((m) => m.default);
    case 'enterprise':
      return import('../../mfe/mfe-enterprise/routes').then((m) => m.default);
    case 'platform':
      return import('../../mfe/mfe-platform/routes').then((m) => m.default);
    case 'security':
      return import('../../mfe/mfe-security/routes').then((m) => m.default);
    default:
      throw new Error(`No hay remoto para el módulo «${moduleId}».`);
  }
}

export async function importTraceRemote(): Promise<import('./types').TraceRemoteModule> {
  return import('../../mfe/mfe-trace/routes').then((m) => m.default);
}
