import { importBundle, type ImportedProject, type ProjectBundle, type ProjectStore, type VersionedProjectStore } from '@iark/kernel';
import { prepareCreateDiagram, prepareRenameDiagram, type CreateDiagramCommand } from '../domain/diagramWrites';
import { prepareCreateProject, prepareRenameProject } from '../domain/projectWrites';
import { prepareRestoreVersion, prepareVersionLabel } from '../domain/versionWrites';
import { prepareSaveDiagram, type SaveDiagramCommand } from '../domain/saveDiagram';
import { requireVersionedStore } from './queries';

export async function createProjectCommand(store: ProjectStore, input: { name: string; description?: string }) {
  return store.createProject(prepareCreateProject(input));
}

export async function renameProjectCommand(store: ProjectStore, projectId: string, name: string) {
  return store.renameProject(projectId, prepareRenameProject(name));
}

export async function deleteProjectCommand(store: ProjectStore, projectId: string): Promise<void> {
  await store.deleteProject(projectId);
}

export async function importProjectCommand(store: ProjectStore, bundle: ProjectBundle, options: { name?: string } = {}): Promise<ImportedProject> {
  return importBundle(store, bundle, options);
}

export async function createDiagramCommand(store: ProjectStore, projectId: string, input: CreateDiagramCommand) {
  return store.saveDiagram(projectId, prepareCreateDiagram(input));
}

export async function saveDiagramCommand(store: ProjectStore, projectId: string, input: SaveDiagramCommand) {
  return store.saveDiagram(projectId, prepareSaveDiagram(input));
}

export async function renameDiagramCommand(store: ProjectStore, projectId: string, diagramId: string, name: string) {
  return store.renameDiagram(projectId, diagramId, prepareRenameDiagram(name));
}

export async function deleteDiagramCommand(store: ProjectStore, projectId: string, diagramId: string): Promise<void> {
  await store.deleteDiagram(projectId, diagramId);
}

function versions(store: ProjectStore): VersionedProjectStore {
  return requireVersionedStore(store);
}

export async function labelVersionCommand(store: ProjectStore, projectId: string, diagramId: string, versionId: number, label: string) {
  return versions(store).labelVersion(projectId, diagramId, versionId, prepareVersionLabel(label));
}

export async function deleteVersionCommand(store: ProjectStore, projectId: string, diagramId: string, versionId: number): Promise<void> {
  await versions(store).deleteVersion(projectId, diagramId, versionId);
}

export async function restoreVersionCommand(
  store: ProjectStore,
  projectId: string,
  diagramId: string,
  versionId: number,
  input: { ifUpdatedAt?: string; by?: string },
) {
  return versions(store).restoreVersion(projectId, diagramId, versionId, prepareRestoreVersion(input));
}
