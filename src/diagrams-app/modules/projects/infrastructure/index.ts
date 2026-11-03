/**
 * Adaptadores de persistencia de `projects` (spec 003). Los almacenes siguen en `src/cli/` hasta moverlos por completo.
 */
export { FolderProjectStore, type FolderProjectStoreOptions } from '../../../../cli/workspace';
export { PostgresProjectStore, type PostgresProjectStoreOptions } from '../../../../cli/postgresProjects';
export { openPostgresProjects, resolveWorkspaceStore, type WorkspaceStoreKind } from '../../../../cli/workspaceStore';
