import { isProjectRole, isSiteRole } from '../accounts/store';
import { classifyRoute, type RouteInfo, type RouteParams } from './route';
import { jsonLine, type LogSink } from './sink';
import type { Metrics } from './metrics';

/**
 * Auditoría de `iark serve` (`--audit-log`): quién intentó cambiar qué, y con qué resultado. Una línea JSON por **intento**, también los
 * denegados. Solo se añade, el archivo es 0600 y nunca lleva contenido: ni diagramas, ni nombres de proyecto, ni tokens, ni cookies, ni
 * direcciones (para saber desde dónde, se cruza el `requestId` con el registro de accesos).
 *
 *   { "ts", "type": "audit", "requestId", "action", "result": "ok" | "denied" | "error", "status", "code"?, "actor", "target"?, "change"? }
 *
 *  - `actor`: `{ kind: "user", id, login, role }` (una sesión de GitHub; `role` es el rol en la instancia), `{ kind: "token", name, role }` o
 *    `{ kind: "anonymous" }`.
 *  - `target`: sobre qué, por identificadores (`project`, `diagram`, `login` de la persona afectada). `change`: lo que se pidió, solo valores de
 *    un conjunto cerrado (`role`, `siteRole`, `disabled`).
 *  - `result`: `ok` (la petición salió bien), `denied` (401 o 403; también el 404 de un proyecto al que una persona sin rol de administración no
 *    pertenece, que el servidor no distingue a propósito de uno que no existe) y `error` (todo lo demás: conflicto, dato inválido, fallo). `code`: el código del
 *    error (`unauthorized`, `forbidden`, `not-found`, `conflict`, `last-admin`…) o `http-<estado>`.
 *
 * Las acciones de los cambios se deducen de la petición (método + plantilla de la ruta, ver `ACTIONS`) cuando termina, sin tocar los manejadores
 * de la API; solo el inicio de sesión (`auth.login`, `auth.login-failed`) lo anotan los manejadores de `/api/auth`, que son quienes saben el
 * motivo. Las 429 (el freno de intentos) no dejan fila: ya son una métrica y el intento no se llegó a evaluar, y una dirección que insiste no
 * debe llenar el archivo.
 */

export type Actor =
  | { kind: 'user'; id: string; login: string; role: string }
  | { kind: 'token'; name: string; role: string }
  | { kind: 'anonymous' };

export type AuditResult = 'ok' | 'denied' | 'error';

export interface AuditTarget {
  project?: string;
  diagram?: string;
  /** El número de la versión del historial, en restaurar, nombrar y borrar versiones. */
  version?: string;
  login?: string;
}

export interface AuditChange {
  role?: string;
  siteRole?: string;
  disabled?: boolean;
}

/** Lo que decide quien deduce o anota la acción; el resto (fecha, identificador de la petición, estado) lo pone `AuditLog`. */
export interface AuditDraft {
  action: string;
  result: AuditResult;
  code?: string;
  /** Quién; si falta, el de la petición (el que identificó la autenticación). */
  actor?: Actor;
  target?: AuditTarget;
  change?: AuditChange;
}

export interface AuditRecord {
  ts: string;
  type: 'audit';
  requestId: string;
  action: string;
  result: AuditResult;
  status: number;
  code?: string;
  actor: Actor;
  target?: AuditTarget;
  change?: AuditChange;
}

const present = <T extends object>(value: T | undefined): T | undefined => (value && Object.values(value).some((v) => v !== undefined) ? (Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T) : undefined);

/** Escribe las filas de auditoría y cuenta las que salen (por acción y resultado, nunca por persona). */
export class AuditLog {
  constructor(
    private readonly sink: LogSink | undefined,
    private readonly metrics?: Metrics,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(draft: AuditDraft & { actor: Actor }, meta: { requestId: string; status: number }): void {
    const target = present(draft.target);
    const change = present(draft.change);
    const record: AuditRecord = {
      ts: this.now().toISOString(),
      type: 'audit',
      requestId: meta.requestId,
      action: draft.action,
      result: draft.result,
      status: meta.status,
      ...(draft.code ? { code: draft.code } : {}),
      actor: draft.actor,
      ...(target ? { target } : {}),
      ...(change ? { change } : {}),
    };
    // Primero se cuenta: que el destino falle no debe dejar la métrica sin la fila.
    this.metrics?.auditEvents.inc({ action: draft.action, result: draft.result });
    this.sink?.write(jsonLine(record));
  }
}

// ───────────── qué petición es qué acción ─────────────

/**
 * Las peticiones que son un cambio (o sacar un proyecto entero), por `MÉTODO plantilla`. Si se añade una ruta que modifica algo, va aquí:
 * `audit.test.ts` comprueba que cada ruta que cambia algo de la API de proyectos y de cuentas figura aquí.
 */
export const ACTIONS: Readonly<Record<string, string>> = {
  'POST /api/projects': 'project.create',
  'POST /api/projects/import': 'project.import',
  'PATCH /api/projects/:project': 'project.rename',
  'DELETE /api/projects/:project': 'project.delete',
  'GET /api/projects/:project/bundle': 'project.export',
  'POST /api/projects/:project/diagrams': 'diagram.create',
  'PUT /api/projects/:project/diagrams/:diagram': 'diagram.save',
  'PATCH /api/projects/:project/diagrams/:diagram': 'diagram.rename',
  'DELETE /api/projects/:project/diagrams/:diagram': 'diagram.delete',
  // Historial de versiones: restaurar crea una versión nueva; nombrar y borrar una nombrada cambian el historial.
  'POST /api/projects/:project/diagrams/:diagram/versions/:version/restore': 'version.restore',
  'PATCH /api/projects/:project/diagrams/:diagram/versions/:version': 'version.label',
  'DELETE /api/projects/:project/diagrams/:diagram/versions/:version': 'version.delete',
  // Compartir y cambiar de rol son la misma petición (PUT): cuál de las dos fue lo dice el estado (201 o 200); si se rechazó, `member.set`.
  'PUT /api/projects/:project/members/:login': 'member.set',
  'DELETE /api/projects/:project/members/:login': 'member.remove',
  // Un PUT a una cuenta invita (201) o cambia rol y/o activación (200): se refina con el cuerpo; si no se llegó a leer, `user.set`.
  'PUT /api/admin/users/:login': 'user.set',
  'DELETE /api/admin/users/:login': 'user.remove',
  'POST /api/auth/logout': 'auth.logout',
};

/** Lo que se sabe de una petición terminada. */
export interface FinishedRequest {
  method: string;
  route: RouteInfo;
  status: number;
  /** El `code` del error con que se respondió, si lo hubo. */
  errorCode?: string;
  actor: Actor;
  /** Por qué falló la autenticación, si falló. */
  authFailure?: 'missing' | 'invalid' | 'rate_limited' | 'unavailable';
  /** La cabecera `Location` de la respuesta (de ahí sale el identificador de lo que se creó). */
  location?: string;
  /** El cuerpo de la petición, solo en las rutas cuyo `change` se deduce de él (miembros y cuentas). */
  body?: string;
}

function resultOf(request: FinishedRequest): AuditResult {
  if (request.status < 400) return 'ok';
  if (request.status === 401 || request.status === 403) return 'denied';
  // El servidor responde 404 a quien no pertenece a un proyecto (igual que si no existiera): para una persona que no administra la instancia, es una denegación.
  if (request.status === 404 && request.actor.kind === 'user' && request.actor.role !== 'admin' && request.route.template.startsWith('/api/projects/')) return 'denied';
  return 'error';
}

function bodyObject(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const targetOf = (params: RouteParams, created?: RouteParams): AuditTarget => ({ project: created?.project ?? params.project, diagram: created?.diagram ?? params.diagram, version: params.version, login: params.login });

/** Las filas de auditoría de una petición terminada (ninguna, la mayoría de las veces). */
export function deriveAudit(request: FinishedRequest): AuditDraft[] {
  if (request.status === 429) return [];
  const { route } = request;
  const result = resultOf(request);
  const code = result === 'ok' ? undefined : (request.errorCode ?? `http-${request.status}`);
  const base = { result, ...(code ? { code } : {}) };
  const action = ACTIONS[`${request.method} ${route.template}`];

  if (action) {
    const created = request.location && result === 'ok' ? classifyRoute('GET', request.location.split('?')[0]).params : undefined;
    const target = targetOf(route.params, created);
    const body = bodyObject(request.body);
    if (action === 'member.set') {
      const role = body && isProjectRole(body.role) ? body.role : undefined;
      const refined = result !== 'ok' ? 'member.set' : request.status === 201 ? 'member.add' : 'member.role';
      return [{ action: refined, ...base, target, change: { role } }];
    }
    if (action === 'user.set') {
      const siteRole = body && isSiteRole(body.siteRole) ? body.siteRole : undefined;
      const disabled = body && typeof body.disabled === 'boolean' ? body.disabled : undefined;
      if (result === 'ok' && request.status === 201) return [{ action: 'user.invite', ...base, target, change: { siteRole } }];
      const rows: AuditDraft[] = [];
      if (siteRole) rows.push({ action: 'user.role', ...base, target, change: { siteRole } });
      if (disabled !== undefined) rows.push({ action: disabled ? 'user.disable' : 'user.enable', ...base, target, change: { disabled } });
      return rows.length > 0 ? rows : [{ action, ...base, target }];
    }
    return [{ action, ...base, target }];
  }
  if (route.compute && (request.status === 401 || request.status === 403)) return [{ action: 'compute.denied', ...base }];
  if (route.protected && (request.authFailure === 'invalid' || request.status === 403)) return [{ action: 'auth.denied', ...base, target: targetOf(route.params) }];
  return [];
}
