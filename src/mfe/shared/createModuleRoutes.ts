import { bootModuleRemote } from '../../modules-app/bootModuleRemote';
import type { ModuleRemoteModule, ModuleRemoteMountOptions, ModuleRemoteRoutes } from '../contract';

export function createModuleRemoteRoutes(routes: ModuleRemoteRoutes): ModuleRemoteModule {
  return {
    routes,
    async mount(options: ModuleRemoteMountOptions) {
      return bootModuleRemote({ moduleId: routes.moduleId, host: options.host, search: options.searchParams });
    },
  };
}
