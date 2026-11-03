import { createModuleRemoteRoutes } from '../shared/createModuleRoutes';

export default createModuleRemoteRoutes({
  remoteId: 'mfe-data',
  moduleId: 'data',
  shellMountPath: '/modules/data',
});
