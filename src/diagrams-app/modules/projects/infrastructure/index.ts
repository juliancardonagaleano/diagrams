/**
 * Adaptadores de persistencia de `projects` (spec 003).
 */
export { FolderProjectStore, HISTORY_FORMAT, isWorkspaceId, MAX_DOCUMENT_BYTES, PROJECT_BUNDLE_EXTENSION, SIDECAR_FORMAT, VERSIONS_DIR, versionPolicyFromEnv, type FolderProjectStoreOptions } from './workspace';
export { PostgresProjectStore, type ImportableProject, type PostgresProjectStoreOptions } from './postgresProjects';
export { asCliError, openPostgresProjects, resolveWorkspaceStore, WORKSPACE_STORES, type WorkspaceStoreKind } from './workspaceStore';
