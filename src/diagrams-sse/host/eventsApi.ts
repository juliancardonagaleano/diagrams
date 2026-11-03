import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProjectStore } from '@iark/kernel';
import { guard } from '../../diagrams-app/host/projectHttpGuards';
import type { Accounts } from '../../diagrams-identity/core/accounts/service';
import { HttpError } from '../../cli/httpError';
import { clientAddress, type Authenticator } from '../../cli/serveAuth';
import { isWorkspaceId } from '../../cli/workspace';
import { EventHub, type StreamSummary } from '../features/events/eventHub';
import type { EventPublisher } from '../features/events/types';

export { EventHub, type EventHubOptions, type StreamSummary } from '../features/events/eventHub';
export type { ChangeEvent, ChangeType, EventPublisher, PublishOptions } from '../features/events/types';

export interface EventsApiContext {
  hub: EventPublisher | undefined;
  store: ProjectStore | undefined;
  cors: string[];
  auth?: Authenticator;
  recheck?: Authenticator;
  accounts?: Accounts;
  trustProxy: boolean;
  streaming?(req: IncomingMessage, summary: StreamSummary): void;
}

/** Feature SSE: `GET /api/events` (spec 005). El hub sigue en memoria hasta existir canal entre procesos. */
export function createEventsApi(ctx: EventsApiContext): (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => Promise<void> {
  return async (req, res, url, parts) => {
    if (!ctx.store) throw new HttpError(404, 'Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)');
    if (parts.length !== 0) throw new HttpError(404, 'Ruta de eventos desconocida: use /api/events.');
    if (req.method !== 'GET') throw new HttpError(405, 'Este endpoint solo admite GET.', { allow: 'GET' });
    if (!ctx.hub) throw new HttpError(404, 'Este servicio no ofrece el canal de eventos en directo (arrancó con --max-streams 0).');
    const identity = await ctx.auth?.identify(req);
    if (identity?.kind === 'user' && !ctx.accounts) throw new HttpError(401, 'Hace falta un token válido: envíe la cabecera «Authorization: Bearer <token>».', { code: 'unauthorized' });
    guard(req, ctx.cors, !!ctx.auth);

    const project = url.searchParams.get('project') ?? undefined;
    if (project !== undefined) {
      if (!isWorkspaceId(project)) throw new HttpError(400, `Identificador de proyecto inválido «${String(project).slice(0, 60)}».`, { code: 'invalid' });
      if (identity?.kind === 'user' && ctx.accounts && identity.siteRole !== 'admin' && !(await ctx.accounts.store.rolesOf(identity.user.id)).has(project)) {
        throw new HttpError(404, `No existe el proyecto «${project.slice(0, 60)}».`, { code: 'not-found' });
      }
    }

    const hub = ctx.hub as EventHub;
    const key = identity?.kind === 'user' ? `u:${identity.user.id}` : identity?.kind === 'token' ? `t:${identity.name}` : `a:${clientAddress(req, ctx.trustProxy)}`;
    if (!hub.admit(key)) {
      throw new HttpError(429, `Hay demasiados canales de eventos abiertos${hub.size >= hub.maxTotal ? ' en este servicio' : ` para esta cuenta (máximo ${hub.maxPerPerson})`}: se sigue sondeando.`, { code: 'limit' }, { 'Retry-After': '30' });
    }

    const recheck = ctx.recheck;
    const summary: StreamSummary = { events: 0, bytes: 0 };
    ctx.streaming?.(req, summary);
    hub.open({
      summary,
      key,
      res,
      identity,
      project,
      credential: req.headers.authorization,
      recheck: async () => {
        if (!recheck) return undefined;
        try {
          return await recheck.identify(req);
        } catch (error) {
          return error instanceof HttpError && error.status === 401 ? 'revoked' : undefined;
        }
      },
    });
  };
}

/** Host `diagrams-sse`: borde HTTP del canal de avisos. */
export function createEventsHost(ctx: EventsApiContext) {
  const route = createEventsApi(ctx);
  return {
    async handle(req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<boolean> {
      if (parts[0] !== 'events') return false;
      await route(req, res, url, parts.slice(1));
      return true;
    },
  };
}
