/**
 * Compatibilidad de imports históricos: resolución del almacén en `src/diagrams-app/modules/projects/infrastructure/`.
 */
export {
  asCliError,
  openPostgresProjects,
  resolveWorkspaceStore,
  WORKSPACE_STORES,
  type WorkspaceStoreKind,
} from '../diagrams-app/modules/projects/infrastructure/workspaceStore';
