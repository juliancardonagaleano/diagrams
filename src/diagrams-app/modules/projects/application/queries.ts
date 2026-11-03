import {
  bundleToText,
  checkProject,
  createBundle,
  isVersioned,
  ProjectError,
  snapshotProject,
  unsupportedVersions,
  type ModuleRegistry,
  type ProjectStore,
  type VersionedProjectStore,
} from '@iark/kernel';

export async function listProjectsQuery(store: ProjectStore) {
  return store.listProjects();
}

export async function getProjectQuery(store: ProjectStore, projectId: string) {
  return store.getProject(projectId);
}

export async function getDiagramQuery(store: ProjectStore, projectId: string, diagramId: string) {
  return store.getDiagram(projectId, diagramId);
}

export async function projectBundleQuery(store: ProjectStore, _registry: ModuleRegistry, projectId: string) {
  const snapshot = await snapshotProject(store, projectId);
  const file = bundleToText(createBundle(snapshot, { generator: 'DIAgrams' }));
  return { snapshot, file };
}

export async function projectCheckQuery(store: ProjectStore, registry: ModuleRegistry, projectId: string) {
  return checkProject(await snapshotProject(store, projectId), registry);
}

export function requireVersionedStore(store: ProjectStore): VersionedProjectStore {
  if (!isVersioned(store)) throw unsupportedVersions();
  return store;
}

export async function listVersionsQuery(store: ProjectStore, projectId: string, diagramId: string) {
  return requireVersionedStore(store).listVersions(projectId, diagramId);
}

export async function getVersionQuery(store: ProjectStore, projectId: string, diagramId: string, versionId: number) {
  const version = await requireVersionedStore(store).getVersion(projectId, diagramId, versionId);
  if (!version) {
    throw new ProjectError('not-found', `No existe la versión ${versionId} del diagrama «${diagramId}» (¿se descartó al rotar el historial?).`);
  }
  return version;
}
