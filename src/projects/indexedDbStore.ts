import {
  cleanBy,
  cleanName,
  describeContent,
  findVersion,
  newestFirst,
  planDelete,
  planLabel,
  planSave,
  ProjectError,
  requireModuleId,
  requireVersionId,
  resolveVersionPolicy,
  sameName,
  unsupportedVersions,
  versionMeta,
  versionUsageOf,
  type Diagram,
  type DiagramMeta,
  type DiagramVersion,
  type ProjectStore,
  type ProjectSummary,
  type RestoredVersion,
  type RestoreOptions,
  type SaveDiagramInput,
  type VersionMeta,
  type VersionPolicy,
  type VersionUsage,
} from '@iark/kernel';

/**
 * Almacén de proyectos en IndexedDB: el de la app web. Tres almacenes de objetos para que listar no lea los documentos:
 * `projects`, `diagrams` (solo metadatos, con índice por proyecto) y `documents` (el texto, por id de diagrama). Cada
 * operación es una sola transacción, así que dos pestañas no pueden dejar un proyecto a medias ni repetir un nombre.
 *
 * El historial de versiones (desde la versión 2 de la base) usa otros tres, con la misma idea: `versions` (los metadatos de cada versión,
 * con índices por diagrama y por proyecto), `versionTexts` (el documento de cada versión, que no se lee al listar) y `versionState` (por
 * diagrama: el mayor id dado y el hash del último contenido, para que los ids no se reutilicen). Guardar un diagrama y anotar su versión
 * es una sola transacción: no puede quedar uno sin la otra. Una base de la versión 1 se actualiza sola; los diagramas que ya tenía
 * conservan su contenido y su historial arranca en su primer guardado (el contenido de antes se registra como línea base).
 */

const DB_NAME = 'iark-projects';
const DB_VERSION = 2;

interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}
interface DiagramRecord extends DiagramMeta {
  projectId: string;
}
interface DocumentRecord {
  id: string;
  text: string;
}
interface VersionRecord extends VersionMeta {
  diagramId: string;
  projectId: string;
}
interface VersionTextRecord {
  diagramId: string;
  id: number;
  text: string;
}
interface VersionState {
  diagramId: string;
  lastId: number;
  head?: string;
}

export interface IndexedDbProjectStoreOptions {
  /** Cuánto historial se guarda por diagrama; `false` para no guardarlo (el almacén lo declara con `keepsVersions: false`). */
  versions?: Partial<VersionPolicy> | false;
  /** El reloj (las pruebas ponen uno que controlan). */
  clock?: () => number;
}

/** Los almacenes de objetos del historial. */
const VERSION_STORES = ['versions', 'versionTexts', 'versionState'] as const;

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1);

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transacción cancelada', 'AbortError'));
  });

function newId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}-${random}`;
}

function toProjectError(error: unknown): unknown {
  if (error instanceof ProjectError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') return new ProjectError('unavailable', 'No hay espacio de almacenamiento en el navegador: exporta o borra proyectos que ya no uses.');
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError' || name === 'AbortError') {
    return new ProjectError('unavailable', 'El almacenamiento del navegador no está disponible (¿ventana privada o permisos bloqueados?).');
  }
  return error;
}

/** `true` si este entorno ofrece IndexedDB (no en algunas ventanas privadas ni en iframes sin permiso). */
export function indexedDbAvailable(factory: IDBFactory | null = globalThis.indexedDB ?? null): boolean {
  return factory !== null && typeof factory !== 'undefined';
}

export class IndexedDbProjectStore implements ProjectStore {
  readonly kind = 'indexeddb';
  readonly keepsVersions: boolean;
  /** La política de retención del historial, o `undefined` si este almacén no lo guarda. */
  readonly versionPolicy: VersionPolicy | undefined;
  private db: Promise<IDBDatabase> | undefined;
  private last = 0;
  private readonly clock: () => number;

  constructor(
    private readonly factory: IDBFactory | null = globalThis.indexedDB ?? null,
    private readonly dbName = DB_NAME,
    options: IndexedDbProjectStoreOptions = {},
  ) {
    this.versionPolicy = options.versions === false ? undefined : resolveVersionPolicy(options.versions);
    this.keepsVersions = this.versionPolicy !== undefined;
    this.clock = options.clock ?? (() => Date.now());
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new ProjectError('unavailable', 'Este navegador no ofrece IndexedDB: los proyectos no se pueden guardar aquí.'));
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      let opening: IDBOpenDBRequest;
      try {
        opening = this.factory!.open(this.dbName, DB_VERSION);
      } catch (error) {
        reject(toProjectError(error));
        return;
      }
      opening.onupgradeneeded = () => {
        const db = opening.result;
        // Versión 1: proyectos, diagramas y documentos. Versión 2: el historial. Una base nueva pasa por las dos; una antigua, solo por la segunda.
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('diagrams')) db.createObjectStore('diagrams', { keyPath: 'id' }).createIndex('byProject', 'projectId');
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('versions')) {
          const versions = db.createObjectStore('versions', { keyPath: ['diagramId', 'id'] });
          versions.createIndex('byDiagram', 'diagramId');
          versions.createIndex('byProject', 'projectId');
        }
        if (!db.objectStoreNames.contains('versionTexts')) db.createObjectStore('versionTexts', { keyPath: ['diagramId', 'id'] });
        if (!db.objectStoreNames.contains('versionState')) db.createObjectStore('versionState', { keyPath: 'diagramId' });
      };
      opening.onsuccess = () => {
        const db = opening.result;
        // Otra pestaña con una versión más nueva pide actualizar: se suelta la conexión para no bloquearla.
        db.onversionchange = () => {
          db.close();
          this.db = undefined;
        };
        resolve(db);
      };
      opening.onerror = () => reject(toProjectError(opening.error));
      opening.onblocked = () => reject(new ProjectError('unavailable', 'Otra pestaña bloquea el almacenamiento de proyectos; ciérrala y reintenta.'));
    }).catch((error) => {
      this.db = undefined;
      throw toProjectError(error);
    });
    return this.db;
  }

  /** Marca de tiempo estrictamente creciente en este almacén (los guardados seguidos no repiten fecha). */
  private now(after = ''): string {
    const previous = after ? Date.parse(after) : 0;
    this.last = Math.max(this.clock(), this.last + 1, Number.isNaN(previous) ? 0 : previous + 1);
    return new Date(this.last).toISOString();
  }

  /** Ejecuta `body` en una transacción; si falla, la cancela entera. */
  private async run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open();
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (error) {
      this.db = undefined;
      throw toProjectError(error);
    }
    const complete = finished(tx);
    complete.catch(() => undefined);
    try {
      const result = await body(tx);
      await complete;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* la transacción ya terminó */
      }
      throw toProjectError(error);
    }
  }

  private summary(project: ProjectRecord, diagrams: DiagramRecord[]): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      ...(project.description ? { description: project.description } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      diagrams: diagrams
        .filter((d) => d.projectId === project.id)
        .map(({ id, module, name, createdAt, updatedAt }) => ({ id, module, name, createdAt, updatedAt }))
        .sort(byName),
    };
  }

  private async projectOf(tx: IDBTransaction, id: string): Promise<ProjectRecord> {
    const project = (await request(tx.objectStore('projects').get(id))) as ProjectRecord | undefined;
    if (!project) throw new ProjectError('not-found', `No existe el proyecto «${id}».`);
    return project;
  }

  private async diagramsOf(tx: IDBTransaction, projectId: string): Promise<DiagramRecord[]> {
    return (await request(tx.objectStore('diagrams').index('byProject').getAll(projectId))) as DiagramRecord[];
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.run(['projects', 'diagrams'], 'readonly', async (tx) => {
      const projects = (await request(tx.objectStore('projects').getAll())) as ProjectRecord[];
      const diagrams = (await request(tx.objectStore('diagrams').getAll())) as DiagramRecord[];
      return projects.map((p) => this.summary(p, diagrams)).sort(byName);
    });
  }

  getProject(id: string): Promise<ProjectSummary | undefined> {
    return this.run(['projects', 'diagrams'], 'readonly', async (tx) => {
      const project = (await request(tx.objectStore('projects').get(id))) as ProjectRecord | undefined;
      return project ? this.summary(project, await this.diagramsOf(tx, id)) : undefined;
    });
  }

  async createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    const name = cleanName(input.name, 'del proyecto');
    return this.run(['projects', 'diagrams'], 'readwrite', async (tx) => {
      const store = tx.objectStore('projects');
      const all = (await request(store.getAll())) as ProjectRecord[];
      if (all.some((p) => sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`);
      const now = this.now();
      const project: ProjectRecord = { id: newId('p'), name, ...(input.description?.trim() ? { description: input.description.trim() } : {}), createdAt: now, updatedAt: now };
      await request(store.add(project));
      return this.summary(project, []);
    });
  }

  async renameProject(id: string, rawName: string): Promise<ProjectSummary> {
    const name = cleanName(rawName, 'del proyecto');
    return this.run(['projects', 'diagrams'], 'readwrite', async (tx) => {
      const store = tx.objectStore('projects');
      const project = await this.projectOf(tx, id);
      const all = (await request(store.getAll())) as ProjectRecord[];
      if (all.some((p) => p.id !== id && sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`);
      const updated = { ...project, name, updatedAt: this.now(project.updatedAt) };
      await request(store.put(updated));
      return this.summary(updated, await this.diagramsOf(tx, id));
    });
  }

  deleteProject(id: string): Promise<void> {
    return this.run(['projects', 'diagrams', 'documents', ...VERSION_STORES], 'readwrite', async (tx) => {
      await this.projectOf(tx, id);
      for (const diagram of await this.diagramsOf(tx, id)) {
        await request(tx.objectStore('documents').delete(diagram.id));
        await request(tx.objectStore('diagrams').delete(diagram.id));
        await this.forgetHistory(tx, diagram.id);
      }
      await request(tx.objectStore('projects').delete(id));
    });
  }

  getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    return this.run(['projects', 'diagrams', 'documents'], 'readonly', async (tx) => {
      await this.projectOf(tx, projectId);
      const meta = (await request(tx.objectStore('diagrams').get(diagramId))) as DiagramRecord | undefined;
      if (!meta || meta.projectId !== projectId) return undefined;
      const document = (await request(tx.objectStore('documents').get(diagramId))) as DocumentRecord | undefined;
      const { id, module, name, createdAt, updatedAt } = meta;
      return { id, module, name, createdAt, updatedAt, text: document?.text ?? '' };
    });
  }

  async saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    if (typeof input.text !== 'string') throw new ProjectError('invalid', 'El documento del diagrama debe ser un texto.');
    return this.run(['projects', 'diagrams', 'documents', ...VERSION_STORES], 'readwrite', (tx) => this.saveIn(tx, projectId, input, {}));
  }

  /** Guarda un diagrama (crea o actualiza) y anota su versión en la misma transacción. `restoredFrom` y `coalesce: false` son de una restauración. */
  private async saveIn(tx: IDBTransaction, projectId: string, input: SaveDiagramInput, extra: { restoredFrom?: number; coalesce?: boolean }): Promise<DiagramMeta> {
    const project = await this.projectOf(tx, projectId);
    const diagrams = tx.objectStore('diagrams');
    const documents = tx.objectStore('documents');
    const touch = async (stamp: string): Promise<void> => void (await request(tx.objectStore('projects').put({ ...project, updatedAt: stamp })));
    const strip = ({ id, module, name, createdAt, updatedAt }: DiagramRecord): DiagramMeta => ({ id, module, name, createdAt, updatedAt });
    const by = cleanBy(input.by);

    if (input.id !== undefined) {
      const current = (await request(diagrams.get(input.id))) as DiagramRecord | undefined;
      if (!current || current.projectId !== projectId) throw new ProjectError('not-found', `No existe el diagrama «${input.id}» en el proyecto «${project.name}».`);
      if (input.module !== undefined && input.module !== current.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es de «${current.module}»).`);
      if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== current.updatedAt) {
        throw new ProjectError('conflict', `El diagrama «${current.name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`);
      }
      const updated: DiagramRecord = { ...current, updatedAt: this.now(current.updatedAt) };
      if (this.versionPolicy) {
        const before = (await request(documents.get(current.id))) as DocumentRecord | undefined;
        await this.recordIn(tx, projectId, current.id, { next: input.text, savedAt: updated.updatedAt, by, previous: { text: before?.text ?? '', at: current.updatedAt }, ...extra });
      }
      await request(documents.put({ id: current.id, text: input.text } satisfies DocumentRecord));
      await request(diagrams.put(updated));
      await touch(updated.updatedAt);
      return strip(updated);
    }

    const module = requireModuleId(input.module);
    const name = cleanName(input.name ?? 'Sin título', 'del diagrama');
    if ((await this.diagramsOf(tx, projectId)).some((d) => sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`);
    const now = this.now();
    const created: DiagramRecord = { id: newId('d'), projectId, module, name, createdAt: now, updatedAt: now };
    await request(documents.add({ id: created.id, text: input.text } satisfies DocumentRecord));
    await request(diagrams.add(created));
    await this.recordIn(tx, projectId, created.id, { next: input.text, savedAt: now, by });
    await touch(now);
    return strip(created);
  }

  async renameDiagram(projectId: string, diagramId: string, rawName: string): Promise<DiagramMeta> {
    const name = cleanName(rawName, 'del diagrama');
    return this.run(['projects', 'diagrams'], 'readwrite', async (tx) => {
      const project = await this.projectOf(tx, projectId);
      const diagrams = tx.objectStore('diagrams');
      const current = (await request(diagrams.get(diagramId))) as DiagramRecord | undefined;
      if (!current || current.projectId !== projectId) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`);
      if ((await this.diagramsOf(tx, projectId)).some((d) => d.id !== diagramId && sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`);
      const updated: DiagramRecord = { ...current, name, updatedAt: this.now(current.updatedAt) };
      await request(diagrams.put(updated));
      await request(tx.objectStore('projects').put({ ...project, updatedAt: updated.updatedAt }));
      const { id, module, createdAt, updatedAt } = updated;
      return { id, module, name, createdAt, updatedAt };
    });
  }

  deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    return this.run(['projects', 'diagrams', 'documents', ...VERSION_STORES], 'readwrite', async (tx) => {
      const project = await this.projectOf(tx, projectId);
      const diagrams = tx.objectStore('diagrams');
      const current = (await request(diagrams.get(diagramId))) as DiagramRecord | undefined;
      if (!current || current.projectId !== projectId) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`);
      await request(tx.objectStore('documents').delete(diagramId));
      await request(diagrams.delete(diagramId));
      await this.forgetHistory(tx, diagramId);
      await request(tx.objectStore('projects').put({ ...project, updatedAt: this.now(project.updatedAt) }));
    });
  }

  // ───────────── historial de versiones ─────────────

  /** Borra todo el historial de un diagrama (cuando el diagrama se borra). */
  private async forgetHistory(tx: IDBTransaction, diagramId: string): Promise<void> {
    const keys = (await request(tx.objectStore('versions').index('byDiagram').getAllKeys(diagramId))) as IDBValidKey[];
    for (const key of keys) {
      await request(tx.objectStore('versions').delete(key));
      await request(tx.objectStore('versionTexts').delete(key));
    }
    await request(tx.objectStore('versionState').delete(diagramId));
  }

  private async versionsOf(tx: IDBTransaction, diagramId: string): Promise<VersionMeta[]> {
    const records = (await request(tx.objectStore('versions').index('byDiagram').getAll(diagramId))) as VersionRecord[];
    return records.map(versionMeta).sort((a, b) => a.id - b.id);
  }

  /** Anota la versión de un guardado según la política (y descarta las que sobran), dentro de la transacción que guarda el diagrama. */
  private async recordIn(
    tx: IDBTransaction,
    projectId: string,
    diagramId: string,
    change: { next: string; savedAt: string; by?: string; previous?: { text: string; at: string }; restoredFrom?: number; coalesce?: boolean },
  ): Promise<void> {
    const policy = this.versionPolicy;
    if (!policy) return;
    const state = (await request(tx.objectStore('versionState').get(diagramId))) as VersionState | undefined;
    const existing = await this.versionsOf(tx, diagramId);
    const plan = planSave({
      existing,
      lastId: state?.lastId ?? 0,
      headHash: state?.head,
      previous: change.previous ? { ...describeContent(change.previous.text), at: change.previous.at } : undefined,
      next: { savedAt: change.savedAt, savedBy: change.by, ...describeContent(change.next), restoredFrom: change.restoredFrom },
      policy,
      coalesce: change.coalesce ?? true,
    });
    for (const id of plan.drop) {
      await request(tx.objectStore('versions').delete([diagramId, id]));
      await request(tx.objectStore('versionTexts').delete([diagramId, id]));
    }
    for (const version of plan.add) {
      await request(tx.objectStore('versions').put({ ...versionMeta(version), diagramId, projectId } satisfies VersionRecord));
      await request(tx.objectStore('versionTexts').put({ diagramId, id: version.id, text: version.from === 'previous' ? (change.previous?.text ?? '') : change.next } satisfies VersionTextRecord));
    }
    await request(tx.objectStore('versionState').put({ diagramId, lastId: plan.lastId, head: plan.headHash } satisfies VersionState));
  }

  /** El diagrama existe en el proyecto (o `not-found`) y este almacén guarda historial (o `unsupported`). */
  private async versionedDiagram(tx: IDBTransaction, projectId: string, diagramId: string): Promise<DiagramRecord> {
    if (!this.versionPolicy) throw unsupportedVersions();
    const project = await this.projectOf(tx, projectId);
    const diagram = (await request(tx.objectStore('diagrams').get(diagramId))) as DiagramRecord | undefined;
    if (!diagram || diagram.projectId !== projectId) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`);
    return diagram;
  }

  listVersions(projectId: string, diagramId: string): Promise<VersionMeta[]> {
    return this.run(['projects', 'diagrams', ...VERSION_STORES], 'readonly', async (tx) => {
      await this.versionedDiagram(tx, projectId, diagramId);
      return newestFirst(await this.versionsOf(tx, diagramId));
    });
  }

  async getVersion(projectId: string, diagramId: string, versionId: number): Promise<DiagramVersion | undefined> {
    requireVersionId(versionId);
    return this.run(['projects', 'diagrams', ...VERSION_STORES], 'readonly', async (tx) => {
      await this.versionedDiagram(tx, projectId, diagramId);
      const record = (await request(tx.objectStore('versions').get([diagramId, versionId]))) as VersionRecord | undefined;
      const text = (await request(tx.objectStore('versionTexts').get([diagramId, versionId]))) as VersionTextRecord | undefined;
      return record && text ? { ...versionMeta(record), text: text.text } : undefined;
    });
  }

  async restoreVersion(projectId: string, diagramId: string, versionId: number, options: RestoreOptions = {}): Promise<RestoredVersion> {
    requireVersionId(versionId);
    return this.run(['projects', 'diagrams', 'documents', ...VERSION_STORES], 'readwrite', async (tx) => {
      const diagram = await this.versionedDiagram(tx, projectId, diagramId);
      const versions = await this.versionsOf(tx, diagramId);
      const found = findVersion(versions, versionId);
      if (options.ifUpdatedAt !== undefined && options.ifUpdatedAt !== diagram.updatedAt) {
        throw new ProjectError('conflict', `El diagrama «${diagram.name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`);
      }
      const current = (await request(tx.objectStore('documents').get(diagramId))) as DocumentRecord | undefined;
      const { id, module, name, createdAt, updatedAt } = diagram;
      if (describeContent(current?.text ?? '').hash === found.hash) {
        return { diagram: { id, module, name, createdAt, updatedAt }, version: versionMeta(versions[versions.length - 1] ?? found), unchanged: true };
      }
      const text = (await request(tx.objectStore('versionTexts').get([diagramId, versionId]))) as VersionTextRecord | undefined;
      const saved = await this.saveIn(tx, projectId, { id: diagramId, text: text?.text ?? '', by: options.by }, { restoredFrom: versionId, coalesce: false });
      const after = await this.versionsOf(tx, diagramId);
      return { diagram: saved, version: versionMeta(after[after.length - 1] ?? found), unchanged: false };
    });
  }

  async labelVersion(projectId: string, diagramId: string, versionId: number, label: string): Promise<VersionMeta> {
    requireVersionId(versionId);
    return this.run(['projects', 'diagrams', ...VERSION_STORES], 'readwrite', async (tx) => {
      await this.versionedDiagram(tx, projectId, diagramId);
      const named = planLabel(await this.versionsOf(tx, diagramId), versionId, label, this.versionPolicy!);
      const record = (await request(tx.objectStore('versions').get([diagramId, versionId]))) as VersionRecord;
      await request(tx.objectStore('versions').put({ ...record, label: named.label } satisfies VersionRecord));
      return versionMeta(named);
    });
  }

  async deleteVersion(projectId: string, diagramId: string, versionId: number): Promise<void> {
    requireVersionId(versionId);
    return this.run(['projects', 'diagrams', ...VERSION_STORES], 'readwrite', async (tx) => {
      await this.versionedDiagram(tx, projectId, diagramId);
      planDelete(await this.versionsOf(tx, diagramId), versionId);
      await request(tx.objectStore('versions').delete([diagramId, versionId]));
      await request(tx.objectStore('versionTexts').delete([diagramId, versionId]));
    });
  }

  versionUsage(projectId: string): Promise<VersionUsage> {
    return this.run(['projects', ...VERSION_STORES], 'readonly', async (tx) => {
      if (!this.versionPolicy) throw unsupportedVersions();
      await this.projectOf(tx, projectId);
      return versionUsageOf((await request(tx.objectStore('versions').index('byProject').getAll(projectId))) as VersionRecord[]);
    });
  }

  /** Cierra la conexión (las pruebas, para poder borrar la base). */
  async close(): Promise<void> {
    const db = await this.db?.catch(() => undefined);
    db?.close();
    this.db = undefined;
  }
}
