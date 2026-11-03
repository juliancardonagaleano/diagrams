/**
 * Compatibilidad de imports históricos: la API de proyectos vive en `src/diagrams-app/`.
 */
export {
  createProjectsApi,
  createProjectsHost,
  guard,
  hostName,
  isLoopbackAddress,
  LOOPBACK_HOSTS,
  projectOriginAllowed,
  requiredRole,
  type ProjectsApiContext,
} from '../diagrams-app';
