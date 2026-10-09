import type { IncomingMessage, ServerResponse } from 'node:http';
import { isGithubLogin } from '../accounts/store';
import type { PublicUser } from '../accounts/service';
import { HttpError } from '../httpError';
import { clientAddress, type Identity } from '../serveAuth';
import { AuditLog, deriveAudit, type Actor, type AuditDraft } from './audit';
import { Metrics } from './metrics';
import { requestIdFrom } from './requestId';
import { classifyRoute, type RouteInfo } from './route';
import { jsonLine, type LogSink } from './sink';

/**
 * Observabilidad de `iark serve`: el identificador de cada petición, el registro de accesos, la auditoría de cambios y las métricas, atados al
 * ciclo de vida de cada petición. El servidor (`serve.ts`) llama a `begin` al recibirla y va anotando en su `RequestContext` lo que va sabiendo
 * (quién es, cuántos bytes envió, con qué error respondió); al terminar la respuesta, el contexto escribe todo de una vez. Los manejadores de la API
 * no saben que existe, salvo los de `/api/auth`, que anotan el inicio de sesión.
 *
 * Nada de esto cambia lo que se responde, salvo la cabecera `X-Request-Id` (que va siempre, estén o no activados los registros), y un fallo aquí
 * (un registro que no se puede escribir) nunca llega a quien llama: se cuenta, se avisa por stderr una vez y el servicio sigue.
 */

export interface ObservabilitySettings {
  /** Dónde va el registro de accesos (`--access-log`). Sin él, no hay registro de accesos. */
  accessSink?: LogSink;
  /** Dónde va la auditoría (`--audit-log`). Sin él, no se escribe, aunque las filas se siguen contando en las métricas. */
  auditSink?: LogSink;
  /** Recoge métricas (`--metrics`); las sirve `metricsEndpoint.ts`. */
  metrics?: boolean;
  /** La versión, para `iark_build_info`. */
  version?: string;
  /** Dónde van los avisos. Por omisión, stderr. */
  warn?: (message: string) => void;
  /** El reloj de la auditoría (en las pruebas, uno falso). */
  now?: () => Date;
}

/** Los motivos por los que la autenticación de una petición falla; también etiqueta de `iark_auth_failures_total`. */
export type AuthFailure = 'missing' | 'invalid' | 'rate_limited' | 'unavailable';

/** Cuerpos de petición que se guardan para deducir el `change` de la auditoría: solo los de miembros y cuentas, y pequeños. */
const BODY_TEMPLATES = new Set(['/api/projects/:project/members/:login', '/api/admin/users/:login']);
const MAX_KEPT_BODY = 4096;

const SAFE_METHOD = /^[A-Z][A-Z-]{0,19}$/;

export class RequestContext {
  readonly route: RouteInfo;
  readonly method: string;
  actor: Actor = { kind: 'anonymous' };
  authFailure: AuthFailure | undefined;
  /** El `code` del error con que se respondió, si lo hubo. */
  errorCode: string | undefined;
  /** Bytes de cuerpo enviados. */
  bytes = 0;
  /** La cabecera `Location` de la respuesta (de ahí sale el identificador de lo que se creó). */
  location: string | undefined;
  /** El cuerpo de la petición, solo en las rutas cuyo `change` de auditoría se deduce de él. */
  body: string | undefined;
  /** Filas de auditoría que anotaron los manejadores. */
  readonly drafts: AuditDraft[] = [];
  readonly startedAt = process.hrtime.bigint();
  private finished = false;

  constructor(
    private readonly owner: Observability,
    readonly id: string,
    readonly req: IncomingMessage,
    readonly trustProxy: boolean,
  ) {
    this.method = SAFE_METHOD.test(req.method ?? '') ? (req.method as string) : 'OTHER';
    this.route = classifyRoute(this.method, pathnameOf(req.url));
  }

  /** Quién llama, cuando la autenticación lo identificó. Solo se guardan el id, el nombre de usuario y el rol: nunca el token ni la sesión. */
  identified(identity: Identity): void {
    this.actor =
      identity.kind === 'token'
        ? { kind: 'token', name: identity.name, role: identity.role }
        : { kind: 'user', id: identity.user.id, login: identity.user.login, role: identity.siteRole };
  }

  /** La autenticación de la petición falló con este error (401, 429 o 503); `presented`: la petición traía cabecera `Authorization`. */
  authFailed(error: unknown, presented: boolean): void {
    if (!(error instanceof HttpError)) return;
    const reason: AuthFailure | undefined = error.status === 401 ? (presented ? 'invalid' : 'missing') : error.status === 429 ? 'rate_limited' : error.status === 503 ? 'unavailable' : undefined;
    if (!reason) return;
    this.authFailure ??= reason;
    this.owner.metrics?.authFailures.inc({ reason });
  }

  /** Se envió una respuesta: cuántos bytes de cuerpo y qué cabeceras (`Location` dice qué se creó). */
  sent(bytes: number, headers: Record<string, string>): void {
    this.bytes += bytes;
    this.location ??= headers.Location;
  }

  /** La petición terminó en error con este código (`unauthorized`, `forbidden`, `conflict`…). */
  failed(code: unknown): void {
    this.errorCode = typeof code === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(code) ? code : undefined;
  }

  /** El cuerpo leído de la petición; solo se conserva (en memoria, hasta que termina) en las rutas cuyo `change` se deduce de él. */
  readBody(text: string): void {
    if (BODY_TEMPLATES.has(this.route.template) && text.length <= MAX_KEPT_BODY) this.body = text;
  }

  /** Una fila de auditoría que decide un manejador (el inicio de sesión); `status` y `requestId` los pone el contexto al terminar. */
  audit(draft: AuditDraft): void {
    this.drafts.push(draft);
  }

  /** Una persona completó el inicio de sesión (cambió su código por una sesión): una fila `auth.login` y, desde ahora, la petición es suya. */
  loggedIn(user: PublicUser): void {
    this.actor = { kind: 'user', id: user.id, login: user.login, role: user.siteRole };
    this.audit({ action: 'auth.login', result: 'ok' });
  }

  /**
   * Un intento de iniciar sesión que no llegó a sesión: una fila `auth.login-failed` y un fallo de autenticación en las métricas. `login` es el
   * nombre de GitHub de quien lo intentó (para que quien administra sepa a quién invitar), si GitHub llegó a decirlo y es un nombre válido.
   */
  loginFailed(failure: { reason: string; result: 'denied' | 'error'; login?: string }): void {
    this.owner.metrics?.authFailures.inc({ reason: 'login_failed' });
    this.audit({ action: 'auth.login-failed', result: failure.result, code: failure.reason, target: { login: isGithubLogin(failure.login) ? failure.login : undefined } });
  }

  /** La respuesta terminó (o el cliente colgó antes): se escribe el registro de accesos, la auditoría y las métricas. */
  finish(res: ServerResponse, aborted: boolean): void {
    if (this.finished) return;
    this.finished = true;
    try {
      const status = aborted && !res.headersSent ? 499 : res.statusCode;
      const seconds = Number(process.hrtime.bigint() - this.startedAt) / 1e9;
      this.owner.finishRequest(this, status, seconds, aborted);
    } catch (error) {
      this.owner.fault(error);
    }
  }
}

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

export class Observability {
  readonly metrics: Metrics | undefined;
  readonly accessSink: LogSink | undefined;
  readonly auditSink: LogSink | undefined;
  private readonly auditLog: AuditLog | undefined;
  private readonly contexts = new WeakMap<object, RequestContext>();
  /** Dónde van los avisos de la observabilidad (por omisión, stderr). */
  readonly warn: (message: string) => void;
  private faulted = false;

  constructor(settings: ObservabilitySettings = {}) {
    this.accessSink = settings.accessSink;
    this.auditSink = settings.auditSink;
    this.warn = settings.warn ?? ((message) => void process.stderr.write(`${message}\n`));
    this.metrics = settings.metrics ? new Metrics(settings.version ?? '0.0.0') : undefined;
    this.metrics?.start();
    this.auditLog = this.auditSink || this.metrics ? new AuditLog(this.auditSink, this.metrics, settings.now) : undefined;
    this.metrics?.addCollector(() => {
      const sinks = [['access', this.accessSink], ['audit', this.auditSink]] as const;
      const active = sinks.filter((entry): entry is readonly ['access' | 'audit', LogSink] => entry[1] !== undefined);
      return [
        { name: 'iark_log_lines_total', help: 'Líneas de registro, por registro y resultado (written, dropped).', type: 'counter', samples: active.flatMap(([log, sink]) => [{ labels: { log, outcome: 'written' }, value: sink.stats.written }, { labels: { log, outcome: 'dropped' }, value: sink.stats.dropped }]) },
        { name: 'iark_log_errors_total', help: 'Fallos al abrir o escribir un registro, por registro.', type: 'counter', samples: active.map(([log, sink]) => ({ labels: { log }, value: sink.stats.errors })) },
      ];
    });
  }

  /** El contexto de una petición (por la petición o por su respuesta), si `begin` la vio. */
  contextOf(target: IncomingMessage | ServerResponse): RequestContext | undefined {
    return this.contexts.get(target);
  }

  /** Empieza a observar una petición: le da su identificador (cabecera `X-Request-Id` de la respuesta) y se engancha a su final. */
  begin(req: IncomingMessage, res: ServerResponse, options: { trustProxy?: boolean } = {}): RequestContext {
    const id = requestIdFrom(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', id);
    const context = new RequestContext(this, id, req, options.trustProxy ?? false);
    this.contexts.set(req, context);
    this.contexts.set(res, context);
    if (this.metrics) this.metrics.inFlight += 1;
    res.once('finish', () => context.finish(res, false));
    res.once('close', () => context.finish(res, true));
    return context;
  }

  /** Lo hace `RequestContext.finish`: escribe el registro de accesos, la auditoría y las métricas de una petición terminada. */
  finishRequest(context: RequestContext, status: number, seconds: number, aborted: boolean): void {
    const { req, trustProxy, bytes, location, body, errorCode, drafts, route, method, id, actor } = context;
    // Cada paso va aparte: que falle uno (un destino que lanza) no deja sin escribir los otros.
    this.guarded(() => {
      if (!this.metrics) return;
      this.metrics.inFlight -= 1;
      this.metrics.observeRequest(method, route.template, status, seconds);
    });
    // Las comprobaciones de las máquinas (/healthz, /readyz, /metrics) solo dejan línea cuando fallan: a diario serían miles sin información.
    this.guarded(() => {
      if (!this.accessSink || (route.operational && status < 400)) return;
      this.accessSink.write(
        jsonLine({
          ts: new Date().toISOString(),
          type: 'access',
          requestId: id,
          method,
          route: route.template,
          status,
          durationMs: Math.round(seconds * 1e5) / 100,
          bytes,
          remote: clientAddress(req, trustProxy),
          ...(actor.kind === 'anonymous' ? {} : { actor }),
          ...(aborted ? { aborted: true } : {}),
        }),
      );
    });
    this.guarded(() => {
      if (!this.auditLog) return;
      const derived = deriveAudit({ method, route, status, errorCode, actor, authFailure: context.authFailure, location, body });
      for (const draft of [...derived, ...drafts]) this.auditLog.record({ ...draft, actor: draft.actor ?? actor }, { requestId: id, status });
    });
  }

  private guarded(step: () => void): void {
    try {
      step();
    } catch (error) {
      this.fault(error);
    }
  }

  /** Un fallo del propio código de observabilidad: se avisa una sola vez y la petición ya respondida no se ve afectada. */
  fault(error: unknown): void {
    if (this.faulted) return;
    this.faulted = true;
    this.warn(`aviso: falló la observabilidad de una petición (${(error as Error)?.message ?? String(error)}); se sigue sirviendo.`);
  }

  /** ¿Algún registro va a un archivo? (Solo entonces tiene sentido reabrir con `SIGHUP`.) */
  get hasFiles(): boolean {
    return [this.accessSink, this.auditSink].some((sink) => sink !== undefined && sink.target !== 'stdout');
  }

  /** Vuelve a abrir los archivos de registro (tras rotarlos con `logrotate` y `SIGHUP`). */
  reopen(): void {
    this.accessSink?.reopen();
    this.auditSink?.reopen();
  }

  /** Para el recolector de métricas y vacía los registros. Los destinos que abrió quien creó esto se cierran aquí. */
  async close(): Promise<void> {
    this.metrics?.stop();
    await Promise.all([this.accessSink?.close(), this.auditSink?.close()]);
  }
}
