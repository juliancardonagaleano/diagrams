import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isVersioned, ProjectError, type ProjectBundle, type ProjectStore } from '@iark/kernel';
import { HttpError } from '../httpError';
import type { Authenticator } from '../serveAuth';
import type { Accounts, QuotaLimits } from './service';
import type { AccountUser } from './store';

/**
 * Cuotas de uso de `iark serve --workspace --accounts`: cuánto ocupa cada persona y qué le falta para llegar a su tope.
 *
 * **Qué se cuenta.** Los bytes de los documentos actuales de los diagramas más los de TODAS las versiones del historial (`versionUsage`, el
 * gancho que dejó el historial de versiones): el historial ocupa disco de verdad, y un diagrama recién creado ya lleva una versión con su
 * contenido, así que cada guardado cuesta, como mucho, el documento nuevo más la versión que se anota. No se cuentan `project.json`, el índice del
 * historial ni los archivos que alguien deje a mano en la carpeta.
 *
 * **A quién se cobra.** A la persona que posee el proyecto (`Accounts.ownerOf`: su persona administradora más antigua, normalmente quien lo creó),
 * no a quien guarda: un editor al que se comparte un proyecto no gasta su cuota sino la de quien lo posee. Un proyecto sin dueño (copiado a mano
 * a la carpeta, o creado con un token de servicio) solo tiene el tope de diagramas por proyecto de la instancia.
 *
 * **Qué topes hay** (`QuotaLimits`; `0` es «sin tope»; una persona puede tener los suyos, fijados por un administrador): bytes por persona,
 * proyectos por persona y diagramas por proyecto.
 *
 * **Qué se rechaza.** Crear un proyecto, importarlo, crear un diagrama y guardar uno: con `409` y `code: "limit"` (el mismo que usa el servicio
 * para los topes de miembros y de versiones con nombre), `quota` (`bytes`, `projects` o `diagrams`), `used` y `limit`. Nunca se pierde nada: un guardado
 * rechazado no toca el disco y quien edita conserva su borrador. Lo que libera espacio o no lo aumenta de forma que importe sigue permitido sin
 * comprobar nada: borrar diagramas y proyectos, borrar versiones con nombre, renombrar, nombrar versiones y **restaurar** una versión (que añade otra
 * versión, pero la rotación del historial la mantiene acotada por diagrama). Un guardado que no hace crecer el uso (el contenido es el mismo,
 * o ocupa menos de lo que libera) también pasa, aunque la persona ya esté por encima del tope (porque se lo bajaron, por ejemplo).
 *
 * **Precisión.** Antes de guardar se estima el crecimiento (`2 × nuevo − actual` con historial; `nuevo − actual` sin él): una cota superior que no descuenta
 * que un guardado pueda sustituir la versión anterior ni la rotación del historial. El uso que se enseña se mide de verdad (tamaños de archivo), con una
 * caché corta por proyecto (`ttlMs`, 30 s) que se invalida con cada cambio que pasa por este proceso; lo que otro proceso o una mano cambie en la carpeta
 * se nota como mucho a los 30 s. Con varias réplicas sobre la misma carpeta, dos guardados simultáneos en réplicas distintas pueden pasarse del tope por
 * la cuantía de lo que se guarda a la vez (dentro de un proceso, los guardados de una misma persona van de uno en uno).
 */

export type QuotaKind = 'bytes' | 'projects' | 'diagrams';
export const QUOTA_KINDS: readonly QuotaKind[] = ['bytes', 'projects', 'diagrams'];

/** Lo que ocupa un proyecto. */
export interface ProjectUsage {
  id: string;
  name: string;
  diagrams: number;
  documentBytes: number;
  versions: number;
  versionBytes: number;
  /** `documentBytes + versionBytes`: lo que cuenta para la cuota. */
  bytes: number;
}

/** Lo que ocupa una persona: la suma de los proyectos que posee. */
export interface PersonUsage {
  bytes: number;
  documentBytes: number;
  versionBytes: number;
  versions: number;
  /** Cuántos proyectos posee. */
  projects: number;
  items: ProjectUsage[];
}

/** Un almacén que sabe decir cuánto ocupan los documentos de un proyecto sin leerlos (el de carpeta). */
interface MeteredStore extends ProjectStore {
  documentUsage(projectId: string): Promise<{ diagrams: number; bytes: number }>;
}
const isMetered = (store: ProjectStore): store is MeteredStore => typeof (store as Partial<MeteredStore>).documentUsage === 'function';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `268435456` → `256 MB` (múltiplos de 1024; un decimal solo si hace falta). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} ${UNITS[unit]}`;
}

/**
 * Un tamaño escrito por una persona (`256M`, `1.5G`, `500k`, `1048576`): enteros o decimales con sufijo `K`, `M`, `G` o `T` (de 1024; con `B`, `iB`
 * o `b` opcional, sin distinguir mayúsculas). `0`, `off`, `none`, `sin-tope` o `unlimited` quitan el tope. Lanza `Error` con el motivo.
 */
export function parseByteSize(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) throw new Error(`«${input}» no es un tamaño: use un número de bytes de 0 en adelante o un sufijo (256M, 2G).`);
    return input;
  }
  const text = input.trim().toLowerCase();
  if (['off', 'none', 'sin-tope', 'sintope', 'unlimited', 'ilimitado'].includes(text)) return 0;
  const match = /^(\d+(?:[.,]\d+)?)\s*([kmgt])?(?:i?b)?$/.exec(text);
  if (!match) throw new Error(`«${input.slice(0, 40)}» no es un tamaño: use un número de bytes o un sufijo (256M, 1.5G, 500K); 0 quita el tope.`);
  const power = match[2] ? 'kmgt'.indexOf(match[2]) + 1 : 0;
  const bytes = Math.round(Number(match[1].replace(',', '.')) * 1024 ** power);
  if (!Number.isSafeInteger(bytes)) throw new Error(`«${input.slice(0, 40)}» es demasiado grande.`);
  return bytes;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export interface QuotasOptions {
  accounts: Accounts;
  store: ProjectStore;
  /** Cuánto vale una medida de un proyecto antes de repetirla (ms). Por omisión, 30 s; `0`, medir siempre. */
  ttlMs?: number;
  /** El reloj en milisegundos (en las pruebas, uno falso). */
  now?: () => number;
}

export const DEFAULT_USAGE_TTL_MS = 30_000;

/** Las cuotas de una instancia: mide el uso, decide qué se rechaza y cuenta los rechazos (sin personas: solo el tipo de tope). */
export class Quotas {
  private readonly accounts: Accounts;
  private readonly store: ProjectStore;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; usage: ProjectUsage }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Cuántas veces se rechazó algo por cada tipo de tope desde que arrancó el servicio (para `/metrics`, sin etiquetas por persona). */
  readonly rejected: Record<QuotaKind, number> = { bytes: 0, projects: 0, diagrams: 0 };

  constructor(options: QuotasOptions) {
    this.accounts = options.accounts;
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? DEFAULT_USAGE_TTL_MS;
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Los topes de la instancia (los que valen si a la persona no se le fijaron otros). */
  get defaults(): QuotaLimits {
    return this.accounts.quotas;
  }

  limitsFor(user: AccountUser): QuotaLimits {
    return this.accounts.limitsFor(user);
  }

  // ───────────── medir ─────────────

  /** Lo que ocupa un proyecto. `fresh` ignora la medida guardada. Falla con `not-found` si el proyecto ya no existe. */
  async project(projectId: string, options: { fresh?: boolean } = {}): Promise<ProjectUsage> {
    const cached = this.cache.get(projectId);
    if (cached && !options.fresh && this.now() - cached.at < this.ttlMs) return cached.usage;
    const summary = await this.store.getProject(projectId);
    if (!summary) throw new ProjectError('not-found', `No existe el proyecto «${projectId}».`);
    let documentBytes: number;
    if (isMetered(this.store)) documentBytes = (await this.store.documentUsage(projectId)).bytes;
    else {
      documentBytes = 0;
      for (const meta of summary.diagrams) documentBytes += Buffer.byteLength((await this.store.getDiagram(projectId, meta.id))?.text ?? '', 'utf8');
    }
    const history = isVersioned(this.store) && this.store.versionUsage ? await this.store.versionUsage(projectId) : { versions: 0, bytes: 0 };
    const usage: ProjectUsage = {
      id: projectId,
      name: summary.name,
      diagrams: summary.diagrams.length,
      documentBytes,
      versions: history.versions,
      versionBytes: history.bytes,
      bytes: documentBytes + history.bytes,
    };
    this.cache.set(projectId, { at: this.now(), usage });
    return usage;
  }

  /** Lo que ocupa una persona: la suma de los proyectos que posee. `fresh` mide de nuevo todos (o solo ese proyecto, si se da su id). */
  async person(userId: string, options: { fresh?: boolean | string } = {}): Promise<PersonUsage> {
    const owned = await this.accounts.ownedProjects(userId);
    const items: ProjectUsage[] = [];
    for (const id of owned) {
      try {
        items.push(await this.project(id, { fresh: options.fresh === true || options.fresh === id }));
      } catch (error) {
        if (!(error instanceof ProjectError && error.code === 'not-found')) throw error; // borrado a mano de la carpeta: ya no ocupa nada
      }
    }
    items.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    const sum = (pick: (p: ProjectUsage) => number): number => items.reduce((total, p) => total + pick(p), 0);
    return {
      bytes: sum((p) => p.bytes),
      documentBytes: sum((p) => p.documentBytes),
      versionBytes: sum((p) => p.versionBytes),
      versions: sum((p) => p.versions),
      projects: owned.length,
      items,
    };
  }

  /** Olvida lo medido de un proyecto (cambió, o se borró). */
  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  // ───────────── decidir ─────────────

  /** Los guardados que pueden gastar de una misma cuota van de uno en uno: dos a la vez no pasan los dos por el mismo hueco. */
  async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  /** La clave de `exclusive` para lo que cuesta una persona (o ninguna, si el proyecto no tiene dueño). */
  async keyFor(projectId: string): Promise<string> {
    return (await this.accounts.ownerOf(projectId))?.id ?? `p:${projectId}`;
  }

  private reject(kind: QuotaKind, message: string, used: number, limit: number): never {
    this.rejected[kind] += 1;
    throw new HttpError(409, message, { code: 'limit', quota: kind, used, limit });
  }

  /**
   * Crear (o importar) un proyecto: la persona no puede pasar de su tope de proyectos. Solo mira las cuentas (no toca el disco), así que se decide
   * antes de leer el cuerpo de la petición.
   */
  async assertCanCreateProject(userId: string): Promise<void> {
    const user = await this.accounts.store.findUser(userId);
    if (!user) return;
    const limit = this.limitsFor(user).projects;
    if (limit === 0) return;
    const used = (await this.accounts.ownedProjects(user.id)).length;
    if (used < limit) return;
    const own = user.quota?.projects !== undefined;
    this.reject(
      'projects',
      `Ya tienes ${plural(used, 'proyecto', 'proyectos')}, ${own ? 'el máximo que te asignó un administrador' : 'el máximo por persona en esta instancia'} (${limit}). Borra alguno o pide a un administrador que suba el tope.`,
      used,
      limit,
    );
  }

  /**
   * Guardar un diagrama (nuevo si no se da `diagramId`). Rechaza si el proyecto ya tiene el máximo de diagramas, o si el crecimiento estimado no cabe en
   * la cuota de bytes de quien posee el proyecto. `actorId` es quien guarda: solo cambia el mensaje (su cuota o la de quien posee el proyecto).
   */
  async assertCanSave(projectId: string, input: { diagramId?: string; text: string; actorId?: string }): Promise<void> {
    const owner = await this.accounts.ownerOf(projectId);
    const limits: QuotaLimits = owner ? this.limitsFor(owner) : { ...this.defaults, bytes: 0, projects: 0 };
    if (input.diagramId === undefined && limits.diagramsPerProject > 0) {
      const summary = await this.store.getProject(projectId);
      const used = summary?.diagrams.length ?? 0;
      if (used >= limits.diagramsPerProject) {
        this.reject('diagrams', `Este proyecto ya tiene ${plural(used, 'diagrama', 'diagramas')}, el máximo por proyecto (${limits.diagramsPerProject}). Borra alguno o pide a un administrador que suba el tope.`, used, limits.diagramsPerProject);
      }
    }
    if (!owner || limits.bytes === 0) return;
    const previous = input.diagramId !== undefined ? ((await this.store.getDiagram(projectId, input.diagramId))?.text ?? '') : '';
    if (input.diagramId !== undefined && previous === input.text) return; // no cambia nada: no ocupa más
    const growth = this.growth(Buffer.byteLength(input.text, 'utf8'), Buffer.byteLength(previous, 'utf8'));
    await this.assertRoom(owner, projectId, growth, input.actorId, 'guardar esto');
  }

  /** Importar un proyecto: caben sus diagramas (y su historial, de una versión por diagrama) en el espacio de quien lo importa, y no pasan del tope por proyecto. */
  async assertCanImport(userId: string, bundle: ProjectBundle): Promise<void> {
    const user = await this.accounts.store.findUser(userId);
    if (!user) return;
    const limits = this.limitsFor(user);
    if (limits.diagramsPerProject > 0 && bundle.diagrams.length > limits.diagramsPerProject) {
      this.reject('diagrams', `El proyecto trae ${plural(bundle.diagrams.length, 'diagrama', 'diagramas')} y el máximo por proyecto es ${limits.diagramsPerProject}. Quita alguno antes de importarlo o pide a un administrador que suba el tope.`, bundle.diagrams.length, limits.diagramsPerProject);
    }
    if (limits.bytes === 0) return;
    let incoming = 0;
    for (const diagram of bundle.diagrams) incoming += this.growth(Buffer.byteLength(diagram.document !== undefined ? JSON.stringify(diagram.document, null, 2) : (diagram.text ?? ''), 'utf8'), 0);
    await this.assertRoom(user, undefined, incoming, user.id, 'importar este proyecto');
  }

  /** Lo que crece el uso al guardar `incoming` bytes donde había `previous`: el documento nuevo y la versión que se anotaría, menos lo que se libera. */
  private growth(incoming: number, previous: number): number {
    return incoming * (isVersioned(this.store) ? 2 : 1) - previous;
  }

  private async assertRoom(owner: AccountUser, projectId: string | undefined, growth: number, actorId: string | undefined, what: string): Promise<void> {
    const limit = this.limitsFor(owner).bytes;
    if (limit === 0 || growth <= 0) return;
    const used = (await this.person(owner.id, { fresh: projectId ?? false })).bytes;
    if (used + growth <= limit) return;
    const whose = actorId === owner.id ? 'tu cuota de espacio' : 'la cuota de espacio de la persona que posee el proyecto';
    this.reject(
      'bytes',
      `No hay espacio para ${what}: ${whose} es de ${formatBytes(limit)} (documentos de los diagramas y versiones del historial) y ya se usan ${formatBytes(used)}; haría falta ${formatBytes(growth)} más. ` +
        'Borra diagramas, proyectos o versiones con nombre para liberar espacio, o pide a un administrador que suba la cuota.',
      used,
      limit,
    );
  }
}

// ───────────── GET /api/usage ─────────────

export interface UsageApiContext {
  accounts: Accounts | undefined;
  auth: Authenticator | undefined;
  quotas: Quotas | undefined;
  sendJson(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void;
}

/** Lo que ve una persona de su cuota (`GET /api/usage`) y un administrador de la de cada cuenta (`/api/admin/users`). */
export interface QuotaReport {
  /** Los topes que valen para ella (`0`: sin tope). */
  limits: QuotaLimits;
  usage: Omit<PersonUsage, 'items'>;
}

export function quotaReport(quotas: Quotas, user: AccountUser, person: PersonUsage): QuotaReport {
  const { items: _items, ...usage } = person;
  void _items;
  return { limits: quotas.limitsFor(user), usage };
}

/**
 * `GET /api/usage`: el uso y la cuota de la persona que llama, con el desglose por proyecto (los que posee, del que más ocupa al que menos). Mide de nuevo,
 * sin caché. Solo para una sesión de persona: un token de `--tokens` no tiene cuenta ni cuota (404).
 */
export function createUsageApi(ctx: UsageApiContext): (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<void> {
  return async (req, res, _url, parts) => {
    const { accounts, auth, quotas } = ctx;
    if (!accounts || !auth || !quotas) throw new HttpError(404, 'Este servicio no tiene cuotas por persona: hacen falta cuentas de GitHub (--accounts) y un espacio de trabajo.');
    if (parts.length !== 0) throw new HttpError(404, 'Ruta desconocida: use /api/usage.');
    if (req.method !== 'GET') throw new HttpError(405, 'Este endpoint solo admite GET.', { allow: 'GET' });
    const identity = await auth.identify(req);
    if (identity.kind !== 'user') throw new HttpError(404, 'Las cuotas son por persona: esta credencial es un token de servicio, sin cuenta ni cuota.', { code: 'not-found' });
    const user = await accounts.store.findUser(identity.user.id);
    if (!user) throw new HttpError(404, 'No existe la cuenta de esta sesión.', { code: 'not-found' });
    const person = await quotas.person(user.id, { fresh: true });
    ctx.sendJson(res, 200, { ...quotaReport(quotas, user, person), projects: person.items });
  };
}
