import { ProjectError } from './errors';
import { cleanName, uniqueName } from './names';
import type { DiagramMeta, ProjectSnapshot, ProjectStore, ProjectSummary } from './types';

/** Busca un proyecto por id o, si no hay ninguno con ese id, por nombre (sin distinguir mayúsculas). */
export async function findProject(store: ProjectStore, idOrName: string): Promise<ProjectSummary> {
  const direct = await store.getProject(idOrName);
  if (direct) return direct;
  const wanted = idOrName.trim().toLocaleLowerCase();
  const found = (await store.listProjects()).find((p) => p.name.toLocaleLowerCase() === wanted);
  if (!found) throw new ProjectError('not-found', `No existe el proyecto «${idOrName}».`, { reason: 'project-missing', params: { name: idOrName } });
  return found;
}

/** Busca un diagrama de un proyecto por id o por nombre. */
export function findDiagram(project: ProjectSummary, idOrName: string): DiagramMeta {
  const wanted = idOrName.trim().toLocaleLowerCase();
  const found = project.diagrams.find((d) => d.id === idOrName) ?? project.diagrams.find((d) => d.name.toLocaleLowerCase() === wanted);
  if (!found) throw new ProjectError('not-found', `No existe el diagrama «${idOrName}» en el proyecto «${project.name}».`, { reason: 'diagram-missing-in', params: { diagram: idOrName, project: project.name } });
  return found;
}

/** El proyecto con todos sus documentos (lo que se exporta y lo que se comprueba). */
export async function snapshotProject(store: ProjectStore, projectId: string): Promise<ProjectSnapshot> {
  const project = await store.getProject(projectId);
  if (!project) throw new ProjectError('not-found', `No existe el proyecto «${projectId}».`, { reason: 'project-missing', params: { name: projectId } });
  const diagrams = [];
  for (const meta of project.diagrams) {
    const diagram = await store.getDiagram(projectId, meta.id);
    if (diagram) diagrams.push(diagram);
  }
  return { ...project, diagrams };
}

/**
 * Copia un diagrama (en el mismo proyecto o en otro). Con `name` se llama así; si no, «<nombre> (copia)», y con un nombre
 * ocupado se le añade un número.
 */
export async function duplicateDiagram(store: ProjectStore, projectId: string, diagramId: string, options: { toProjectId?: string; name?: string } = {}): Promise<DiagramMeta> {
  const source = await store.getDiagram(projectId, diagramId);
  if (!source) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}».`, { reason: 'diagram-missing', params: { diagram: diagramId } });
  const targetId = options.toProjectId ?? projectId;
  const target = await store.getProject(targetId);
  if (!target) throw new ProjectError('not-found', `No existe el proyecto «${targetId}».`, { reason: 'project-missing', params: { name: targetId } });
  const base = options.name !== undefined ? cleanName(options.name, 'del diagrama') : `${source.name} (copia)`;
  const name = options.name !== undefined ? base : uniqueName(base, target.diagrams.map((d) => d.name));
  return store.saveDiagram(targetId, { module: source.module, name, text: source.text });
}
