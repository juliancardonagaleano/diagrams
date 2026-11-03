import { createModuleRemoteRoutes } from '../shared/createModuleRoutes';

export default createModuleRemoteRoutes({
  remoteId: 'mfe-security',
  moduleId: 'security',
  shellMountPath: '/modules/security',
});
