import { createModuleRemoteRoutes } from '../shared/createModuleRoutes';

export default createModuleRemoteRoutes({
  remoteId: 'mfe-enterprise',
  moduleId: 'enterprise',
  shellMountPath: '/modules/enterprise',
});
