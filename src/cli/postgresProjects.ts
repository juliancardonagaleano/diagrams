import { createHash } from 'node:crypto';
import {
  applyPlan,
  cleanBy,
  cleanName,
  findVersion,
  nameKey,
  newestFirst,
  planDelete,
  planLabel,
  planSave,
  ProjectError,
  requireModuleId,
  requireVersionId,
  resolveVersionPolicy,
  slugify,
  uniqueName,
  unsupportedVersions,
  versionMeta,
  type Diagram,
  type DiagramMeta,
  type DiagramVersion,
  type ProjectStore,
  type ProjectSummary,
  type RestoredVersion,
  type RestoreOptions,
  type SaveDiagramInput,
  type VersionMeta,
  type VersionPlan,
  type VersionPolicy,
  type VersionUsage,
} from '@iark/kernel';
import { migrate, type PgMigration } from './postgres/migrate';
import { DatabaseError, isUniqueViolation, type PostgresDatabase, type Tx } from './postgres/pool';
import { isWorkspaceId, MAX_DOCUMENT_BYTES, versionPolicyFromEnv } from './workspace';

/**
 * Los proyectos de `iark serve` en Postgres (Supabase y otros): la implementación de `ProjectStore` para un servicio sin disco persistente
 * (Render, Fly, Cloud Run…) o con varias réplicas. Es el equivalente de `FolderProjectStore` (`workspace.ts`) con la misma semántica observable:
 * los mismos ids y nombres, el mismo control de concurrencia optimista (`ifUpdatedAt`), el mismo historial de versiones (la lógica de qué
 * versión se crea, se sustituye o se descarta es la del núcleo, `planSave`) y las mismas cuotas (`documentUsage`, `versionUsage`).
 *
 *   proyectos   id (texto), nombre, descripción, fechas
 *   diagramas   (proyecto, id), módulo, nombre, el documento como `text` EXACTO, sus bytes y su hash, fechas y el contador del historial
 *   versiones   (proyecto, diagrama, id), quién, cuándo, nombre, tamaño, hash y el documento de esa versión
 *
 * El documento es `text`, no `jsonb`: `jsonb` reordenaría las claves, quitaría espacios y cambiaría el hash y los bytes. Lo que se guarda es lo
 * que se leerá, carácter por carácter (borradores que no son JSON, BOM y saltos de línea incluidos). Lo único que `text` no admite es el
 * carácter NUL (U+0000), que un JSON válido no puede llevar sin escapar: se rechaza con `invalid`.
 *
 * Concurrencia. Cada operación que escribe es UNA transacción, y no depende de la memoria del proceso (puede haber varios):
 *  - guardar un diagrama que ya existe bloquea SU fila (`for update`), compara `ifUpdatedAt` con la fecha que hay ahora y escribe: dos guardados
 *    simultáneos con la misma marca, aunque vengan de procesos distintos, dejan uno guardado y el otro en `conflict`. Las filas de otros diagramas
 *    no se bloquean, así que guardar diagramas distintos del mismo proyecto no se espera;
 *  - crear, renombrar o borrar un diagrama (o un proyecto) bloquea antes la fila del proyecto: así dos altas simultáneas no eligen el mismo id y
 *    la comprobación de nombres repetidos no se cuela. Los nombres repetidos tienen además un índice único como última red;
 *  - el orden de los candados es siempre proyecto y después diagrama, así que no hay interbloqueos entre estas operaciones.
 * Solo SQL que vale en el modo de transacción del pooler de Supabase: sin `SET`, sin sentencias preparadas con nombre, sin `LISTEN`; el único
 * candado de asesoramiento es el de transacción (`tx.lock`).
 *
 * Fechas. `updatedAt` de un diagrama es una marca estrictamente creciente por diagrama (el reloj, o la anterior más un milisegundo) y se guarda con
 * precisión de milisegundos: lo que devuelve un guardado es exactamente lo que se lee después. La de un proyecto es la mayor de la suya (altas,
 * bajas y renombrados) y las de sus diagramas, sin escribir la fila del proyecto en cada guardado.
 *
 * Límite conocido: las cuotas (`documentUsage` y `versionUsage`) se miden en su propia consulta, fuera de la transacción del guardado; con varias
 * réplicas, dos guardados simultáneos pueden pasarse del tope por lo que guardan a la vez (igual que con varias réplicas sobre una carpeta).
 */

const NAMESPACE = 'proyectos';

/** Las migraciones de los proyectos (namespace «proyectos»). Nunca se edita una ya publicada: se añade otra al final. */
export const PROJECT_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    name: 'proyectos, diagramas y versiones',
    up: [
      `create table {schema}.proyectos (
         id          text primary key,
         name        text not null,
         name_key    text not null,
         description text,
         created_at  timestamptz not null,
         updated_at  timestamptz not null
       )`,
      // sin distinguir mayúsculas, como las carpetas de un sistema de archivos que no las distingue y como `sameName`
      'create unique index proyectos_nombre on {schema}.proyectos (name_key)',
      'create unique index proyectos_id_min on {schema}.proyectos (lower(id))',
      `create table {schema}.diagramas (
         project_id      text not null references {schema}.proyectos (id) on delete cascade,
         id              text not null,
         module          text not null,
         name            text not null,
         name_key        text not null,
         documento       text not null,
         bytes           integer generated always as (octet_length(documento)) stored,
         doc_hash        text not null,
         created_at      timestamptz not null,
         updated_at      timestamptz not null,
         version_last_id integer not null default 0,
         version_head    text,
         primary key (project_id, id)
       )`,
      'create unique index diagramas_nombre on {schema}.diagramas (project_id, name_key)',
      'create unique index diagramas_id_min on {schema}.diagramas (project_id, lower(id))',
      `create table {schema}.versiones (
         project_id    text not null,
         diagram_id    text not null,
         id            integer not null check (id > 0),
         saved_at      timestamptz not null,
         saved_by      text,
         label         text,
         size          integer not null check (size >= 0),
         hash          text not null,
         restored_from integer,
         documento     text not null,
         primary key (project_id, diagram_id, id),
         foreign key (project_id, diagram_id) references {schema}.diagramas (project_id, id) on delete cascade
       )`,
    ],
  },
];

export interface PostgresProjectStoreOptions {
  /** Como en `FolderProjectStore`: cuánto historial se guarda por diagrama, `false` para no guardarlo. Por omisión, las variables de entorno (`IARK_VERSIONS…`). */
  versions?: Partial<VersionPolicy> | false;
  /** El reloj de las marcas y de las versiones (las pruebas ponen uno que controlan). */
  clock?: () => Date;
}

/** Un proyecto para importar tal cual (con sus ids, fechas y, si las trae, versiones): ver `PostgresProjectStore.importProject`. */
export interface ImportableProject {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  diagrams: Array<{
    id: string;
    module: string;
    name: string;
    text: string;
    createdAt: string;
    updatedAt: string;
    /** El historial, en cualquier orden; solo se guarda si el almacén guarda historial. */
    versions?: DiagramVersion[];
  }>;
}

export type ImportOutcome =
  | { status: 'imported'; diagrams: number; versions: number; renamed: string[] }
  /** Ya hay un proyecto con ese id y no se pidió reemplazarlo. */
  | { status: 'exists' }
  /** Otro proyecto (con otro id) ya se llama así. */
  | { status: 'name-taken'; id: string };

// ───────────── filas y utilidades ─────────────

interface SummaryRow {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
  d_id: string | null;
  d_module: string | null;
  d_name: string | null;
  d_created: Date | null;
  d_updated: Date | null;
}

interface DiagramRow {
  id: string;
  module: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

interface LockedDiagram extends DiagramRow {
  bytes: number;
  doc_hash: string;
  version_last_id: number;
  version_head: string | null;
  /** El nombre del proyecto (para los mensajes). */
  project_name: string;
}

interface VersionRow {
  id: number;
  saved_at: Date;
  saved_by: string | null;
  label: string | null;
  size: number;
  hash: string;
  restored_from: number | null;
}

type Queryable = Pick<Tx, 'query'>;

const VERSION_COLUMNS = 'id, saved_at, saved_by, label, size, hash, restored_from';
const MAX_DESCRIPTION_LENGTH = 2000;

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1);
const iso = (date: Date): string => date.toISOString();
const shorten = (value: unknown): string => {
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/** Tamaño en bytes (UTF-8) y SHA-256 del documento: lo mismo que `describeContent` del núcleo, con el `crypto` de Node (que es rápido con documentos de megabytes). */
const describe = (text: string): { size: number; hash: string } => ({ size: Buffer.byteLength(text, 'utf8'), hash: createHash('sha256').update(text, 'utf8').digest('hex') });

const metaOf = (row: DiagramRow): DiagramMeta => ({ id: row.id, module: row.module, name: row.name, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

const versionOf = (row: VersionRow): VersionMeta => ({
  id: row.id,
  savedAt: iso(row.saved_at),
  ...(row.saved_by !== null ? { savedBy: row.saved_by } : {}),
  ...(row.label !== null ? { label: row.label } : {}),
  size: row.size,
  hash: row.hash,
  ...(row.restored_from !== null ? { restoredFrom: row.restored_from } : {}),
});

const projectMissing = (id: string): ProjectError => new ProjectError('not-found', `No existe el proyecto «${shorten(id)}».`, { reason: 'project-missing', params: { name: shorten(id) } });
const diagramMissing = (diagram: string, project: string): ProjectError =>
  new ProjectError('not-found', `No existe el diagrama «${shorten(diagram)}» en el proyecto «${project}».`, { reason: 'diagram-missing-in', params: { diagram: shorten(diagram), project } });
const conflict = (name: string): ProjectError => new ProjectError('conflict', `El diagrama «${name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`, { reason: 'diagram-changed', params: { name } });
const projectExists = (name: string): ProjectError => new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`, { reason: 'project-exists', params: { name } });
const diagramExists = (name: string, project: string): ProjectError => new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project}».`, { reason: 'diagram-exists', params: { name, project } });

function requireProjectId(value: unknown): string {
  if (!isWorkspaceId(value)) throw new ProjectError('invalid', `Identificador de proyecto inválido «${shorten(value)}».`);
  return value;
}
function requireDiagramId(value: unknown): string {
  if (!isWorkspaceId(value)) throw new ProjectError('invalid', `Identificador de diagrama inválido «${shorten(value)}».`);
  return value;
}

function descriptionOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ProjectError('invalid', 'La descripción debe ser un texto.');
  const description = raw.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new ProjectError('invalid', `La descripción no puede pasar de ${MAX_DESCRIPTION_LENGTH} caracteres.`);
  return description || undefined;
}

/** Lo que un documento debe cumplir para guardarse: es un texto, cabe y no lleva NUL (que `text` de Postgres no admite). */
function checkDocument(text: unknown): string {
  if (typeof text !== 'string') throw new ProjectError('invalid', 'El documento del diagrama debe ser un texto.', { reason: 'document-not-text' });
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) throw new ProjectError('invalid', `El documento pesa más de ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`);
  if (text.includes('\u0000')) throw new ProjectError('invalid', 'El documento lleva el carácter NUL (U+0000), que Postgres no admite en un texto; en un JSON válido va escapado (\\u0000).');
  return text;
}

/** El primer id libre a partir de `base` (`base`, `base-2`, `base-3`…) que además sea un id válido en el espacio de trabajo (`con`, `aux`… no lo son). */
function freeId(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate.toLowerCase()) && isWorkspaceId(candidate)) return candidate;
  }
}

/** El pool ya dice qué falla sin la contraseña (`DatabaseError`); aquí solo se convierte en el `unavailable` que entiende el resto del servicio. */
function toProjectError(error: unknown): unknown {
  if (error instanceof DatabaseError) return new ProjectError('unavailable', error.message);
  // el servicio se está apagando y el pool ya se cerró mientras entraba una última petición
  if (error instanceof Error && /pool after calling end/i.test(error.message)) return new ProjectError('unavailable', 'La conexión a la base de datos está cerrada.');
  return error;
}

// ───────────── el almacén ─────────────

export class PostgresProjectStore implements ProjectStore {
  readonly kind = 'postgres';
  readonly keepsVersions: boolean;
  /** La política de retención del historial, o `undefined` si este almacén no lo guarda. */
  readonly versionPolicy: VersionPolicy | undefined;
  private readonly clock: () => Date;
  private readonly P: string;
  private readonly D: string;
  private readonly V: string;

  private constructor(
    private readonly db: PostgresDatabase,
    options: PostgresProjectStoreOptions,
  ) {
    const wanted = options.versions ?? versionPolicyFromEnv();
    this.versionPolicy = wanted === false ? undefined : resolveVersionPolicy(wanted);
    this.keepsVersions = this.versionPolicy !== undefined;
    this.clock = options.clock ?? (() => new Date());
    this.P = db.table('proyectos');
    this.D = db.table('diagramas');
    this.V = db.table('versiones');
  }

  /** Deja el esquema al día (migraciones del namespace «proyectos» y endurecimiento) y devuelve el almacén. La conexión es del llamante (`acquireDatabase`). */
  static async open(db: PostgresDatabase, options: PostgresProjectStoreOptions = {}): Promise<PostgresProjectStore> {
    const store = new PostgresProjectStore(db, options);
    try {
      await migrate(db, NAMESPACE, PROJECT_MIGRATIONS);
    } catch (error) {
      throw toProjectError(error);
    }
    return store;
  }

  /** Una descripción para el registro de arranque: sin contraseña. */
  get description(): string {
    return `Postgres ${this.db.config.description}, esquema ${this.db.config.schema}`;
  }

  /** ¿Contesta la base ahora mismo? Es lo que mira la comprobación `workspace` de `/readyz`. */
  ping(): Promise<boolean> {
    return this.db.ping();
  }

  private async guard<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw toProjectError(error);
    }
  }

  /** Una marca de tiempo: la hora del reloj o, si se da `after`, una estrictamente mayor que esa. */
  private stamp(after?: Date): Date {
    const now = this.clock().getTime();
    return new Date(after ? Math.max(now, after.getTime() + 1) : now);
  }

  // ───────────── lecturas comunes ─────────────

  private summarySql(where: string): string {
    return `select p.id, p.name, p.description, p.created_at,
              greatest(p.updated_at, max(x.updated_at) over (partition by p.id)) as updated_at,
              x.id as d_id, x.module as d_module, x.name as d_name, x.created_at as d_created, x.updated_at as d_updated
            from ${this.P} p left join ${this.D} x on x.project_id = p.id ${where}`;
  }

  private summaries(rows: SummaryRow[]): ProjectSummary[] {
    const found = new Map<string, ProjectSummary>();
    for (const r of rows) {
      let summary = found.get(r.id);
      if (!summary) {
        summary = { id: r.id, name: r.name, ...(r.description ? { description: r.description } : {}), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), diagrams: [] };
        found.set(r.id, summary);
      }
      if (r.d_id !== null) summary.diagrams.push({ id: r.d_id, module: r.d_module!, name: r.d_name!, createdAt: iso(r.d_created!), updatedAt: iso(r.d_updated!) });
    }
    for (const summary of found.values()) summary.diagrams.sort(byName);
    return [...found.values()];
  }

  /** El proyecto y el diagrama existen o falla con `not-found` (con el mensaje que corresponde). */
  private async assertDiagram(q: Queryable, projectId: string, diagramId: string): Promise<void> {
    const rows = await q.query<{ name: string; d: string | null }>(`select p.name, d.id as d from ${this.P} p left join ${this.D} d on d.project_id = p.id and d.id = $2 where p.id = $1`, [projectId, diagramId]);
    if (!rows[0]) throw projectMissing(projectId);
    if (rows[0].d === null) throw diagramMissing(diagramId, rows[0].name);
  }

  /**
   * Bloquea la fila de un diagrama (`for update`) y la devuelve, con el nombre de su proyecto. Quien la tiene espera a que otra transacción
   * que la haya bloqueado termine, y lee ya lo que esta dejó: es lo que hace atómico comparar `ifUpdatedAt` y escribir.
   */
  private async lockDiagram(tx: Tx, projectId: string, diagramId: string): Promise<LockedDiagram> {
    const rows = await tx.query<LockedDiagram>(
      `select d.id, d.module, d.name, d.created_at, d.updated_at, d.bytes, d.doc_hash, d.version_last_id, d.version_head, p.name as project_name
         from ${this.D} d join ${this.P} p on p.id = d.project_id where d.project_id = $1 and d.id = $2 for update of d`,
      [projectId, diagramId],
    );
    if (!rows[0]) {
      await this.assertDiagram(tx, projectId, diagramId);
      throw diagramMissing(diagramId, projectId);
    }
    return rows[0];
  }

  /**
   * Bloquea la fila del proyecto y la hace crecer: su `updatedAt` pasa a ser estrictamente mayor que cualquiera de las anteriores (la suya o la
   * de sus diagramas). Es lo primero que hacen crear, renombrar y borrar un diagrama (ver el orden de candados arriba).
   */
  private async touchProject(tx: Tx, projectId: string, now: Date, rename?: { name: string; key: string }): Promise<{ name: string; updated_at: Date }> {
    const grow = `greatest($2::timestamptz, p.updated_at + interval '1 millisecond', coalesce((select max(x.updated_at) from ${this.D} x where x.project_id = p.id) + interval '1 millisecond', p.updated_at))`;
    const rows = rename
      ? await tx.query<{ name: string; updated_at: Date }>(`update ${this.P} p set name = $3, name_key = $4, updated_at = ${grow} where p.id = $1 returning p.name, p.updated_at`, [projectId, iso(now), rename.name, rename.key])
      : await tx.query<{ name: string; updated_at: Date }>(`update ${this.P} p set updated_at = ${grow} where p.id = $1 returning p.name, p.updated_at`, [projectId, iso(now)]);
    if (!rows[0]) throw projectMissing(projectId);
    return rows[0];
  }

  // ───────────── ProjectStore: proyectos ─────────────

  listProjects(): Promise<ProjectSummary[]> {
    return this.guard(async () => this.summaries(await this.db.query<SummaryRow>(this.summarySql(''))).sort(byName));
  }

  getProject(id: string): Promise<ProjectSummary | undefined> {
    return this.guard(async () => {
      if (!isWorkspaceId(id)) return undefined;
      return this.summaries(await this.db.query<SummaryRow>(this.summarySql('where p.id = $1'), [id]))[0];
    });
  }

  createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    return this.guard(async () => {
      const name = cleanName(input.name, 'del proyecto');
      const description = descriptionOf(input.description);
      try {
        return await this.db.transaction(async (tx) => {
          // Las altas de proyectos van de una en una (también entre procesos): así dos altas simultáneas no eligen el mismo id ni el mismo nombre.
          await tx.lock('proyectos:alta');
          if ((await tx.query(`select 1 from ${this.P} where name_key = $1`, [nameKey(name)])).length > 0) throw projectExists(name);
          const base = slugify(name, 'proyecto');
          const used = await tx.query<{ id: string }>(`select lower(id) as id from ${this.P} where lower(id) = $1 or lower(id) like $2`, [base, `${base}-%`]);
          const id = freeId(base, new Set(used.map((r) => r.id)));
          const now = this.stamp();
          await tx.query(`insert into ${this.P} (id, name, name_key, description, created_at, updated_at) values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)`, [id, name, nameKey(name), description ?? null, iso(now)]);
          return { id, name, ...(description ? { description } : {}), createdAt: iso(now), updatedAt: iso(now), diagrams: [] } satisfies ProjectSummary;
        });
      } catch (error) {
        throw this.mapUnique(error, name);
      }
    });
  }

  renameProject(id: string, rawName: string): Promise<ProjectSummary> {
    return this.guard(async () => {
      const projectId = requireProjectId(id);
      let name = '';
      try {
        return await this.db.transaction(async (tx) => {
          const found = await tx.query(`select 1 from ${this.P} where id = $1 for update`, [projectId]);
          if (!found[0]) throw projectMissing(projectId);
          name = cleanName(rawName, 'del proyecto');
          const taken = await tx.query(`select 1 from ${this.P} where name_key = $1 and id <> $2`, [nameKey(name), projectId]);
          if (taken.length > 0) throw projectExists(name);
          // Solo cambia el nombre: el id se conserva, así las rutas y las pertenencias que otros hayan guardado siguen valiendo.
          await this.touchProject(tx, projectId, this.stamp(), { name, key: nameKey(name) });
          return this.summaries(await tx.query<SummaryRow>(this.summarySql('where p.id = $1'), [projectId]))[0];
        });
      } catch (error) {
        throw this.mapUnique(error, name);
      }
    });
  }

  deleteProject(id: string): Promise<void> {
    return this.guard(async () => {
      const projectId = requireProjectId(id);
      // Los diagramas y sus versiones se van con él (`on delete cascade`).
      const rows = await this.db.query(`delete from ${this.P} where id = $1 returning id`, [projectId]);
      if (!rows[0]) throw projectMissing(projectId);
    });
  }

  /** Convierte la violación del índice único de nombres (otra transacción se llevó el nombre en medio) en el `exists` de siempre. */
  private mapUnique(error: unknown, name: string, project?: string): unknown {
    if (isUniqueViolation(error)) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === 'proyectos_nombre') return projectExists(name);
      if (constraint === 'diagramas_nombre') return diagramExists(name, project ?? '');
    }
    return error;
  }

  // ───────────── ProjectStore: diagramas ─────────────

  getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    return this.guard(async () => {
      if (!isWorkspaceId(projectId)) throw projectMissing(projectId);
      if (!isWorkspaceId(diagramId)) {
        if (!(await this.getProject(projectId))) throw projectMissing(projectId);
        return undefined;
      }
      const rows = await this.db.query<DiagramRow & { documento: string }>(`select id, module, name, created_at, updated_at, documento from ${this.D} where project_id = $1 and id = $2`, [projectId, diagramId]);
      if (rows[0]) return { ...metaOf(rows[0]), text: rows[0].documento };
      if ((await this.db.query(`select 1 from ${this.P} where id = $1`, [projectId])).length === 0) throw projectMissing(projectId);
      return undefined;
    });
  }

  saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    return this.guard(async () => {
      const pid = requireProjectId(projectId);
      // Lo que no depende de la base se comprueba antes de abrir la transacción (y de tomar ningún candado).
      const text = checkDocument(input.text);
      if (input.ifUpdatedAt !== undefined && typeof input.ifUpdatedAt !== 'string') throw new ProjectError('invalid', '`ifUpdatedAt` debe ser un texto.');
      if (input.id !== undefined) {
        const id = requireDiagramId(input.id);
        return this.db.transaction(async (tx) => this.writeLocked(tx, await this.lockDiagram(tx, pid, id), pid, { ...input, text }, {}));
      }
      const module = requireModuleId(input.module);
      const name = cleanName(input.name ?? 'Sin título', 'del diagrama');
      try {
        return await this.db.transaction((tx) => this.create(tx, pid, { module, name, text, by: cleanBy(input.by) }));
      } catch (error) {
        throw this.mapUnique(error, name, pid);
      }
    });
  }

  /** Crea un diagrama: con la fila del proyecto bloqueada, comprueba el nombre, elige el id y anota la primera versión. */
  private async create(tx: Tx, projectId: string, input: { module: string; name: string; text: string; by?: string }): Promise<DiagramMeta> {
    const now = this.stamp();
    const project = await this.touchProject(tx, projectId, now);
    const key = nameKey(input.name);
    if ((await tx.query(`select 1 from ${this.D} where project_id = $1 and name_key = $2`, [projectId, key])).length > 0) throw diagramExists(input.name, project.name);
    const base = slugify(input.name, 'diagrama');
    const used = await tx.query<{ id: string }>(`select lower(id) as id from ${this.D} where project_id = $1 and (lower(id) = $2 or lower(id) like $3)`, [projectId, base, `${base}-%`]);
    const id = freeId(base, new Set(used.map((r) => r.id)));
    const content = describe(input.text);
    await tx.query(
      `insert into ${this.D} (project_id, id, module, name, name_key, documento, doc_hash, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)`,
      [projectId, id, input.module, input.name, key, input.text, content.hash, iso(now)],
    );
    if (this.versionPolicy) {
      const plan = await this.record(tx, projectId, id, { lastId: 0, head: null }, { next: input.text, nextFacts: content, savedAt: now, by: input.by });
      await tx.query(`update ${this.D} set version_last_id = $3, version_head = $4 where project_id = $1 and id = $2`, [projectId, id, plan.lastId, plan.headHash]);
    }
    return { id, module: input.module, name: input.name, createdAt: iso(now), updatedAt: iso(now) };
  }

  /**
   * Guarda un diagrama que ya existe y cuya fila está bloqueada (`row`): comprueba módulo y `ifUpdatedAt`, anota la versión y escribe. `restoredFrom`
   * y `coalesce: false` son de una restauración.
   */
  private async writeLocked(tx: Tx, row: LockedDiagram, projectId: string, input: SaveDiagramInput, extra: { restoredFrom?: number; coalesce?: boolean }): Promise<DiagramMeta> {
    if (input.module !== undefined && input.module !== row.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es de «${row.module}»).`, { reason: 'diagram-module-fixed', params: { module: row.module } });
    if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== iso(row.updated_at)) throw conflict(row.name);
    const now = this.stamp(row.updated_at);
    const content = describe(input.text);
    let state = { lastId: row.version_last_id, head: row.version_head };
    if (this.versionPolicy) {
      const plan = await this.record(
        tx,
        projectId,
        row.id,
        state,
        {
          next: input.text,
          nextFacts: content,
          savedAt: now,
          by: cleanBy(input.by),
          previous: { size: row.bytes, hash: row.doc_hash, at: row.updated_at },
          // el documento anterior solo se lee si hace falta registrarlo como línea base
          previousText: async () => (await tx.query<{ documento: string }>(`select documento from ${this.D} where project_id = $1 and id = $2`, [projectId, row.id]))[0]?.documento ?? '',
          ...extra,
        },
      );
      state = { lastId: plan.lastId, head: plan.headHash };
    }
    await tx.query(`update ${this.D} set documento = $3, doc_hash = $4, updated_at = $5::timestamptz, version_last_id = $6, version_head = $7 where project_id = $1 and id = $2`, [
      projectId,
      row.id,
      input.text,
      content.hash,
      iso(now),
      state.lastId,
      state.head,
    ]);
    return { ...metaOf(row), updatedAt: iso(now) };
  }

  renameDiagram(projectId: string, diagramId: string, rawName: string): Promise<DiagramMeta> {
    return this.guard(async () => {
      const pid = requireProjectId(projectId);
      const did = requireDiagramId(diagramId);
      let name = '';
      try {
        return await this.db.transaction(async (tx) => {
          const project = await this.touchProject(tx, pid, this.stamp());
          const row = await this.lockDiagram(tx, pid, did);
          name = cleanName(rawName, 'del diagrama');
          const taken = await tx.query(`select 1 from ${this.D} where project_id = $1 and name_key = $2 and id <> $3`, [pid, nameKey(name), did]);
          if (taken.length > 0) throw diagramExists(name, project.name);
          // Solo cambia el nombre: el documento y su `updatedAt` no se tocan (quien lo tiene abierto no tiene un conflicto por esto).
          await tx.query(`update ${this.D} set name = $3, name_key = $4 where project_id = $1 and id = $2`, [pid, did, name, nameKey(name)]);
          return { ...metaOf(row), name };
        });
      } catch (error) {
        throw this.mapUnique(error, name, pid);
      }
    });
  }

  deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    return this.guard(async () => {
      const pid = requireProjectId(projectId);
      const did = requireDiagramId(diagramId);
      await this.db.transaction(async (tx) => {
        const project = await this.touchProject(tx, pid, this.stamp()); // antes de borrar: crece por encima también de la fecha de este diagrama
        const rows = await tx.query(`delete from ${this.D} where project_id = $1 and id = $2 returning id`, [pid, did]); // su historial se va con él
        if (!rows[0]) throw diagramMissing(did, project.name);
      });
    });
  }

  // ───────────── historial de versiones ─────────────

  /**
   * Anota la versión de un guardado según la política (la decisión es `planSave` del núcleo) y aplica el plan: descarta las versiones que sobran y
   * añade las nuevas. Debe correr con la fila del diagrama bloqueada (o recién creada) para que la lista que lee sea la que se va a modificar.
   */
  private async record(
    tx: Tx,
    projectId: string,
    diagramId: string,
    state: { lastId: number; head: string | null },
    change: { next: string; nextFacts: { size: number; hash: string }; savedAt: Date; by?: string; previous?: { size: number; hash: string; at: Date }; previousText?: () => Promise<string>; restoredFrom?: number; coalesce?: boolean },
  ): Promise<VersionPlan & { after: VersionMeta[] }> {
    const policy = this.versionPolicy!;
    const existing = (await tx.query<VersionRow>(`select ${VERSION_COLUMNS} from ${this.V} where project_id = $1 and diagram_id = $2 order by id`, [projectId, diagramId])).map(versionOf);
    const plan = planSave({
      existing,
      lastId: state.lastId,
      headHash: state.head ?? undefined,
      previous: change.previous ? { size: change.previous.size, hash: change.previous.hash, at: iso(change.previous.at) } : undefined,
      next: { savedAt: iso(change.savedAt), savedBy: change.by, ...change.nextFacts, restoredFrom: change.restoredFrom },
      policy,
      coalesce: change.coalesce ?? true,
    });
    if (plan.drop.length > 0) await tx.query(`delete from ${this.V} where project_id = $1 and diagram_id = $2 and id = any($3::integer[])`, [projectId, diagramId, plan.drop]);
    for (const version of plan.add) {
      const text = version.from === 'previous' ? await change.previousText!() : change.next;
      await tx.query(
        `insert into ${this.V} (project_id, diagram_id, id, saved_at, saved_by, label, size, hash, restored_from, documento) values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10)`,
        [projectId, diagramId, version.id, version.savedAt, version.savedBy ?? null, version.label ?? null, version.size, version.hash, version.restoredFrom ?? null, text],
      );
    }
    return { ...plan, after: applyPlan(existing, plan) };
  }

  private requireHistory(): VersionPolicy {
    if (!this.versionPolicy) throw unsupportedVersions();
    return this.versionPolicy;
  }

  private async versionList(q: Queryable, projectId: string, diagramId: string): Promise<VersionMeta[]> {
    return (await q.query<VersionRow>(`select ${VERSION_COLUMNS} from ${this.V} where project_id = $1 and diagram_id = $2 order by id`, [projectId, diagramId])).map(versionOf);
  }

  listVersions(projectId: string, diagramId: string): Promise<VersionMeta[]> {
    return this.guard(async () => {
      this.requireHistory();
      const pid = requireProjectId(projectId);
      const did = requireDiagramId(diagramId);
      await this.assertDiagram(this.db, pid, did);
      return newestFirst(await this.versionList(this.db, pid, did)).map(versionMeta);
    });
  }

  getVersion(projectId: string, diagramId: string, versionId: number): Promise<DiagramVersion | undefined> {
    return this.guard(async () => {
      requireVersionId(versionId);
      this.requireHistory();
      const pid = requireProjectId(projectId);
      const did = requireDiagramId(diagramId);
      const rows = await this.db.query<VersionRow & { documento: string }>(`select ${VERSION_COLUMNS}, documento from ${this.V} where project_id = $1 and diagram_id = $2 and id = $3`, [pid, did, versionId]);
      if (rows[0]) return { ...versionMeta(versionOf(rows[0])), text: rows[0].documento };
      await this.assertDiagram(this.db, pid, did);
      return undefined;
    });
  }

  restoreVersion(projectId: string, diagramId: string, versionId: number, options: RestoreOptions = {}): Promise<RestoredVersion> {
    return this.guard(async () => {
      requireVersionId(versionId);
      this.requireHistory();
      const pid = requireProjectId(projectId);
      const did = requireDiagramId(diagramId);
      return this.db.transaction(async (tx) => {
        const row = await this.lockDiagram(tx, pid, did);
        const versions = await this.versionList(tx, pid, did);
        const found = findVersion(versions, versionId);
        if (options.ifUpdatedAt !== undefined && options.ifUpdatedAt !== iso(row.updated_at)) throw conflict(row.name);
        if (row.doc_hash === found.hash) return { diagram: metaOf(row), version: versionMeta(versions[versions.length - 1] ?? found), unchanged: true };
        const stored = await tx.query<{ documento: string }>(`select documento from ${this.V} where project_id = $1 and diagram_id = $2 and id = $3`, [pid, did, versionId]);
        if (!stored[0]) throw new ProjectError('not-found', `Falta el documento de la versión ${versionId} en el historial.`);
        const saved = await this.writeLocked(tx, row, pid, { id: did, text: stored[0].documento, by: options.by }, { restoredFrom: versionId, coalesce: false });
        const after = await this.versionList(tx, pid, did);
        return { diagram: saved, version: versionMeta(after[after.length - 1] ?? found), unchanged: false };
      });
    });
  }

  labelVersion(projectId: string, diagramId: string, versionId: number, label: string): Promise<VersionMeta> {
    return this.guard(async () => {
      requireVersionId(versionId);
      const policy = this.requireHistory();
      const pid = requireProjectId(projectId);
      const did = requireDiagramId(diagramId);
      return this.db.transaction(async (tx) => {
        await this.lockDiagram(tx, pid, did); // dos nombrados a la vez no se pasan del máximo, ni se nombra una versión que otro guardado descarta
        const named = planLabel(await this.versionList(tx, pid, did), versionId, label, policy);
        await tx.query(`update ${this.V} set label = $4 where project_id = $1 and diagram_id = $2 and id = $3`, [pid, did, versionId, named.label]);
        return versionMeta(named);
      });
    });
  }

  deleteVersion(projectId: string, diagramId: string, versionId: number): Promise<void> {
    return this.guard(async () => {
      requireVersionId(versionId);
      this.requireHistory();
      const pid = requireProjectId(projectId);
      const did = requireDiagramId(diagramId);
      await this.db.transaction(async (tx) => {
        await this.lockDiagram(tx, pid, did);
        planDelete(await this.versionList(tx, pid, did), versionId);
        await tx.query(`delete from ${this.V} where project_id = $1 and diagram_id = $2 and id = $3`, [pid, did, versionId]);
      });
    });
  }

  // ───────────── cuotas ─────────────

  /**
   * Lo que ocupan los documentos actuales de un proyecto (cuántos diagramas y sus bytes), sin leerlos: suma la columna `bytes`. Es una mitad de lo
   * que cuentan las cuotas de `iark serve --accounts` (la otra, `versionUsage`: ver `accounts/usage.ts`). Se mide en su propia consulta, fuera de la
   * transacción de un guardado.
   */
  documentUsage(projectId: string): Promise<{ diagrams: number; bytes: number }> {
    return this.guard(async () => {
      const pid = requireProjectId(projectId);
      const rows = await this.db.query<{ found: string; diagrams: string; bytes: string }>(
        `select count(distinct p.id) as found, count(d.id) as diagrams, coalesce(sum(d.bytes), 0) as bytes from ${this.P} p left join ${this.D} d on d.project_id = p.id where p.id = $1`,
        [pid],
      );
      if (Number(rows[0]?.found) === 0) throw projectMissing(pid);
      return { diagrams: Number(rows[0].diagrams), bytes: Number(rows[0].bytes) };
    });
  }

  versionUsage(projectId: string): Promise<VersionUsage> {
    return this.guard(async () => {
      this.requireHistory();
      const pid = requireProjectId(projectId);
      const rows = await this.db.query<{ found: string; versions: string; bytes: string }>(
        `select count(distinct p.id) as found, count(v.id) as versions, coalesce(sum(v.size), 0) as bytes from ${this.P} p left join ${this.V} v on v.project_id = p.id where p.id = $1`,
        [pid],
      );
      if (Number(rows[0]?.found) === 0) throw projectMissing(pid);
      return { versions: Number(rows[0].versions), bytes: Number(rows[0].bytes) };
    });
  }

  // ───────────── importar un proyecto con sus ids ─────────────

  /**
   * Trae un proyecto tal cual está en otro almacén (p. ej. una carpeta; ver `workspaceImport.ts`): CONSERVA su id, los de sus diagramas, sus fechas y,
   * si el almacén guarda historial, sus versiones. Conservar el id importa: las pertenencias de las cuentas (`--accounts`) y los enlaces apuntan a él.
   * Una sola transacción: o entra entero o no entra. No pisa un proyecto que ya existe (`exists`) salvo con `replace`, que lo borra y lo vuelve a
   * crear. Dos diagramas con el mismo nombre (una carpeta editada a mano) se numeran (`Nombre (2)`), y cuáles se dice en `renamed`.
   */
  importProject(project: ImportableProject, options: { replace?: boolean } = {}): Promise<ImportOutcome> {
    return this.guard(async () => {
      const id = requireProjectId(project.id);
      const name = cleanName(project.name, 'del proyecto');
      const description = descriptionOf(project.description);
      const diagrams = project.diagrams.map((d) => {
        requireDiagramId(d.id);
        return { ...d, module: requireModuleId(d.module), name: cleanName(d.name, 'del diagrama'), text: checkDocument(d.text) };
      });
      const dates = (created: string, updated: string): [string, string] => {
        if (Number.isNaN(Date.parse(created)) || Number.isNaN(Date.parse(updated))) throw new ProjectError('invalid', `Fechas inválidas en «${shorten(id)}».`);
        return [new Date(created).toISOString(), new Date(updated).toISOString()];
      };
      const [pCreated, pUpdated] = dates(project.createdAt, project.updatedAt);
      return this.db.transaction(async (tx): Promise<ImportOutcome> => {
        await tx.lock('proyectos:alta');
        const same = await tx.query<{ id: string }>(`select id from ${this.P} where lower(id) = $1`, [id.toLowerCase()]);
        if (same[0] && !options.replace) return { status: 'exists' };
        if (same[0]) await tx.query(`delete from ${this.P} where id = $1`, [same[0].id]);
        const clash = await tx.query<{ id: string }>(`select id from ${this.P} where name_key = $1`, [nameKey(name)]);
        if (clash[0]) return { status: 'name-taken', id: clash[0].id };
        await tx.query(`insert into ${this.P} (id, name, name_key, description, created_at, updated_at) values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`, [id, name, nameKey(name), description ?? null, pCreated, pUpdated]);
        const names: string[] = [];
        const renamed: string[] = [];
        let versions = 0;
        for (const d of diagrams) {
          const unique = uniqueName(d.name, names);
          if (unique !== d.name) renamed.push(`${d.id}: «${d.name}» → «${unique}»`);
          names.push(unique);
          const [created, updated] = dates(d.createdAt, d.updatedAt);
          const content = describe(d.text);
          const history = (this.versionPolicy ? [...(d.versions ?? [])] : [])
            .sort((a, b) => a.id - b.id)
            .map((v) => ({ v, facts: describe(checkDocument(v.text)) }));
          const last = history[history.length - 1];
          await tx.query(
            `insert into ${this.D} (project_id, id, module, name, name_key, documento, doc_hash, created_at, updated_at, version_last_id, version_head) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11)`,
            // `head`: el contenido de la última versión; si el documento actual es otro (editado fuera de IArk), el guardado siguiente lo registra como línea base
            [id, d.id, d.module, unique, nameKey(unique), d.text, content.hash, created, updated, last?.v.id ?? 0, last?.facts.hash ?? null],
          );
          for (const { v, facts } of history) {
            await tx.query(
              `insert into ${this.V} (project_id, diagram_id, id, saved_at, saved_by, label, size, hash, restored_from, documento) values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10)`,
              [id, d.id, v.id, v.savedAt, cleanBy(v.savedBy) ?? null, v.label ?? null, facts.size, facts.hash, v.restoredFrom ?? null, v.text],
            );
            versions++;
          }
        }
        return { status: 'imported', diagrams: diagrams.length, versions, renamed };
      });
    });
  }
}
