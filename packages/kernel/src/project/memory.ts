import { ProjectError } from './errors';
import { cleanName, requireModuleId, sameName, uniqueSlug } from './names';
import type { Diagram, DiagramMeta, ProjectStore, ProjectSummary, SaveDiagramInput } from './types';
import {
  applyPlan,
  cleanBy,
  describeContent,
  findVersion,
  newestFirst,
  planDelete,
  planLabel,
  planSave,
  requireVersionId,
  resolveVersionPolicy,
  unsupportedVersions,
  versionMeta,
  versionUsageOf,
  type DiagramVersion,
  type RestoredVersion,
  type RestoreOptions,
  type VersionMeta,
  type VersionPlan,
  type VersionPolicy,
  type VersionUsage,
} from './versions';

/** El historial de un diagrama: sus versiones (de la más antigua a la más reciente) con el documento de cada una. */
interface History {
  lastId: number;
  /** Hash del último contenido guardado (ver `PlanInput.headHash`). */
  head?: string;
  versions: VersionMeta[];
  texts: Map<number, string>;
}

interface StoredProject {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  diagrams: Map<string, Diagram>;
  histories: Map<string, History>;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1);

const meta = ({ id, module, name, createdAt, updatedAt }: Diagram): DiagramMeta => ({ id, module, name, createdAt, updatedAt });

/**
 * Almacén en memoria: la referencia del contrato de `ProjectStore` (los demás almacenes deben comportarse igual) y lo que
 * usan las pruebas y los anfitriones sin almacenamiento persistente.
 */
export interface MemoryProjectStoreOptions {
  /** Cuánto historial se guarda por diagrama (ver `VersionPolicy`); `false` para no guardar historial (el almacén lo declara con `keepsVersions: false`). */
  versions?: Partial<VersionPolicy> | false;
}

export class MemoryProjectStore implements ProjectStore {
  readonly kind = 'memory';
  readonly keepsVersions: boolean;
  /** La política de retención del historial, o `undefined` si este almacén no lo guarda. */
  readonly versionPolicy: VersionPolicy | undefined;
  private readonly projects = new Map<string, StoredProject>();
  private counter = 0;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    options: MemoryProjectStoreOptions = {},
  ) {
    this.versionPolicy = options.versions === false ? undefined : resolveVersionPolicy(options.versions);
    this.keepsVersions = this.versionPolicy !== undefined;
  }

  private now(): string {
    // Estrictamente creciente aunque el reloj no avance entre dos llamadas seguidas (las pruebas y los guardados rápidos).
    const stamp = this.clock().getTime();
    this.last = Math.max(stamp, this.last + 1);
    return new Date(this.last).toISOString();
  }
  private last = 0;

  private project(id: string): StoredProject {
    const project = this.projects.get(id);
    if (!project) throw new ProjectError('not-found', `No existe el proyecto «${id}».`, { reason: 'project-missing', params: { name: id } });
    return project;
  }

  private summary(project: StoredProject): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      ...(project.description ? { description: project.description } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      diagrams: [...project.diagrams.values()].map(meta).sort(byName),
    };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return [...this.projects.values()].map((p) => this.summary(p)).sort(byName);
  }

  async getProject(id: string): Promise<ProjectSummary | undefined> {
    const project = this.projects.get(id);
    return project ? this.summary(project) : undefined;
  }

  async createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    const name = cleanName(input.name, 'del proyecto');
    if ([...this.projects.values()].some((p) => sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`, { reason: 'project-exists', params: { name } });
    const now = this.now();
    const id = uniqueSlug(`p${++this.counter}`, this.projects.keys());
    const description = input.description?.trim() || undefined;
    const project: StoredProject = { id, name, description, createdAt: now, updatedAt: now, diagrams: new Map(), histories: new Map() };
    this.projects.set(id, project);
    return this.summary(project);
  }

  async renameProject(id: string, rawName: string): Promise<ProjectSummary> {
    const project = this.project(id);
    const name = cleanName(rawName, 'del proyecto');
    if ([...this.projects.values()].some((p) => p.id !== id && sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`, { reason: 'project-exists', params: { name } });
    project.name = name;
    project.updatedAt = this.now();
    return this.summary(project);
  }

  async deleteProject(id: string): Promise<void> {
    this.project(id);
    this.projects.delete(id);
  }

  async getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    const diagram = this.project(projectId).diagrams.get(diagramId);
    return diagram ? { ...diagram } : undefined;
  }

  async saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    return this.save(projectId, input, {});
  }

  /** Guarda un diagrama (crea o actualiza) y anota la versión. `restoredFrom` y `coalesce: false` son de una restauración. */
  private save(projectId: string, input: SaveDiagramInput, extra: { restoredFrom?: number; coalesce?: boolean }): DiagramMeta {
    const project = this.project(projectId);
    if (typeof input.text !== 'string') throw new ProjectError('invalid', 'El documento del diagrama debe ser un texto.', { reason: 'document-not-text' });
    const now = this.now();
    const by = cleanBy(input.by);
    if (input.id !== undefined) {
      const current = project.diagrams.get(input.id);
      if (!current) throw new ProjectError('not-found', `No existe el diagrama «${input.id}» en el proyecto «${project.name}».`, { reason: 'diagram-missing-in', params: { diagram: input.id, project: project.name } });
      if (input.module !== undefined && input.module !== current.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es de «${current.module}»).`, { reason: 'diagram-module-fixed', params: { module: current.module } });
      if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== current.updatedAt) {
        throw new ProjectError('conflict', `El diagrama «${current.name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`, { reason: 'diagram-changed', params: { name: current.name } });
      }
      this.record(project, current.id, { next: input.text, savedAt: now, by, previous: { text: current.text, at: current.updatedAt }, ...extra });
      const updated: Diagram = { ...current, text: input.text, updatedAt: now };
      project.diagrams.set(current.id, updated);
      project.updatedAt = now;
      return meta(updated);
    }
    const module = requireModuleId(input.module);
    const name = cleanName(input.name ?? 'Sin título', 'del diagrama');
    if ([...project.diagrams.values()].some((d) => sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`, { reason: 'diagram-exists', params: { name, project: project.name } });
    const id = uniqueSlug(`d${++this.counter}`, project.diagrams.keys());
    const created: Diagram = { id, module, name, text: input.text, createdAt: now, updatedAt: now };
    this.record(project, id, { next: input.text, savedAt: now, by });
    project.diagrams.set(id, created);
    project.updatedAt = now;
    return meta(created);
  }

  async renameDiagram(projectId: string, diagramId: string, rawName: string): Promise<DiagramMeta> {
    const project = this.project(projectId);
    const current = project.diagrams.get(diagramId);
    if (!current) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`, { reason: 'diagram-missing-in', params: { diagram: diagramId, project: project.name } });
    const name = cleanName(rawName, 'del diagrama');
    if ([...project.diagrams.values()].some((d) => d.id !== diagramId && sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`, { reason: 'diagram-exists', params: { name, project: project.name } });
    const now = this.now();
    const updated: Diagram = { ...current, name, updatedAt: now };
    project.diagrams.set(diagramId, updated);
    project.updatedAt = now;
    return meta(updated);
  }

  async deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    const project = this.project(projectId);
    if (!project.diagrams.delete(diagramId)) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`, { reason: 'diagram-missing-in', params: { diagram: diagramId, project: project.name } });
    project.histories.delete(diagramId);
    project.updatedAt = this.now();
  }

  // ───────────── historial de versiones ─────────────

  /** Anota la versión de un guardado según la política. Sin historial (`keepsVersions: false`) no hace nada. */
  private record(project: StoredProject, diagramId: string, change: { next: string; savedAt: string; by?: string; previous?: { text: string; at: string }; restoredFrom?: number; coalesce?: boolean }): VersionPlan | undefined {
    const policy = this.versionPolicy;
    if (!policy) return undefined;
    const history = project.histories.get(diagramId) ?? { lastId: 0, versions: [], texts: new Map<number, string>() };
    const next = describeContent(change.next);
    const previous = change.previous ? { ...describeContent(change.previous.text), at: change.previous.at } : undefined;
    const plan = planSave({
      existing: history.versions,
      lastId: history.lastId,
      headHash: history.head,
      previous,
      next: { savedAt: change.savedAt, savedBy: change.by, ...next, restoredFrom: change.restoredFrom },
      policy,
      coalesce: change.coalesce ?? true,
    });
    for (const id of plan.drop) history.texts.delete(id);
    for (const version of plan.add) history.texts.set(version.id, version.from === 'previous' ? (change.previous?.text ?? '') : change.next);
    history.versions = applyPlan(history.versions, plan);
    history.lastId = plan.lastId;
    history.head = plan.headHash;
    project.histories.set(diagramId, history);
    return plan;
  }

  private history(projectId: string, diagramId: string): { project: StoredProject; diagram: Diagram; history: History } {
    if (!this.versionPolicy) throw unsupportedVersions();
    const project = this.project(projectId);
    const diagram = project.diagrams.get(diagramId);
    if (!diagram) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`, { reason: 'diagram-missing-in', params: { diagram: diagramId, project: project.name } });
    return { project, diagram, history: project.histories.get(diagramId) ?? { lastId: 0, versions: [], texts: new Map() } };
  }

  async listVersions(projectId: string, diagramId: string): Promise<VersionMeta[]> {
    return newestFirst(this.history(projectId, diagramId).history.versions).map(versionMeta);
  }

  async getVersion(projectId: string, diagramId: string, versionId: number): Promise<DiagramVersion | undefined> {
    requireVersionId(versionId);
    const { history } = this.history(projectId, diagramId);
    const found = history.versions.find((v) => v.id === versionId);
    const text = history.texts.get(versionId);
    return found && text !== undefined ? { ...versionMeta(found), text } : undefined;
  }

  async restoreVersion(projectId: string, diagramId: string, versionId: number, options: RestoreOptions = {}): Promise<RestoredVersion> {
    requireVersionId(versionId);
    const { diagram, history } = this.history(projectId, diagramId);
    const found = findVersion(history.versions, versionId);
    const text = history.texts.get(versionId) ?? '';
    if (options.ifUpdatedAt !== undefined && options.ifUpdatedAt !== diagram.updatedAt) {
      throw new ProjectError('conflict', `El diagrama «${diagram.name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`, { reason: 'diagram-changed', params: { name: diagram.name } });
    }
    if (describeContent(diagram.text).hash === found.hash) {
      const latest = history.versions[history.versions.length - 1];
      return { diagram: meta(diagram), version: versionMeta(latest ?? found), unchanged: true };
    }
    const saved = this.save(projectId, { id: diagramId, text, by: options.by }, { restoredFrom: versionId, coalesce: false });
    const versions = this.project(projectId).histories.get(diagramId)?.versions ?? [];
    const version = versions[versions.length - 1];
    return { diagram: saved, version: versionMeta(version ?? found), unchanged: false };
  }

  async labelVersion(projectId: string, diagramId: string, versionId: number, label: string): Promise<VersionMeta> {
    requireVersionId(versionId);
    const { history } = this.history(projectId, diagramId);
    const named = planLabel(history.versions, versionId, label, this.versionPolicy!);
    history.versions = history.versions.map((v) => (v.id === versionId ? named : v));
    return versionMeta(named);
  }

  async deleteVersion(projectId: string, diagramId: string, versionId: number): Promise<void> {
    requireVersionId(versionId);
    const { history } = this.history(projectId, diagramId);
    planDelete(history.versions, versionId);
    history.versions = history.versions.filter((v) => v.id !== versionId);
    history.texts.delete(versionId);
  }

  async versionUsage(projectId: string): Promise<VersionUsage> {
    if (!this.versionPolicy) throw unsupportedVersions();
    const project = this.project(projectId);
    return versionUsageOf([...project.histories.values()].flatMap((h) => h.versions));
  }
}
