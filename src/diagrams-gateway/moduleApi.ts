import type { IncomingMessage, ServerResponse } from 'node:http';
import { commandInfos, moduleCapabilities, type AnyModule, type ModuleRegistry } from '@iark/kernel';
import { COMPUTE_ACTIONS, type ComputeExecutor, type ComputeJob } from '../cli/compute';
import { HttpError } from '../cli/httpError';
import type { Authenticator } from '../cli/serveAuth';

export interface ModuleApiOptions {
  registry: ModuleRegistry;
  executor: ComputeExecutor;
  /** Con autenticación y sin publicCompute, las rutas de cálculo piden credencial. */
  computeAuth?: Authenticator;
  readBody: (req: IncomingMessage) => Promise<string>;
  send: (res: ServerResponse, status: number, body: string | Buffer, headers?: Record<string, string>) => void;
  sendJson: (res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>) => void;
  requireMethod: (req: IncomingMessage, allowed: 'GET' | 'POST') => void;
  unwrapOutcome: (outcome: Awaited<ReturnType<ComputeExecutor['run']>>) => { body: string | Buffer; contentType: string; headers?: Record<string, string> };
}

/**
 * Borde `diagrams-gateway`: catálogo de módulos, esquemas y operaciones de cálculo (`POST /api/trace` y `/api/<módulo>/…`).
 * Organizado por feature en carpetas bajo `src/diagrams-gateway/features/` (extracción incremental).
 */
export function createModuleApi(options: ModuleApiOptions) {
  const { registry, executor, computeAuth, readBody, send, sendJson, requireMethod, unwrapOutcome } = options;

  function moduleOf(id: string): AnyModule {
    const module = registry.get(id);
    if (!module) throw new HttpError(404, `No existe el módulo «${id}». Módulos: ${registry.ids().join(', ')}.`);
    return module;
  }

  const requireComputeAccess = async (req: IncomingMessage): Promise<void> => void (await computeAuth?.identify(req));

  async function runCompute(res: ServerResponse, job: ComputeJob): Promise<void> {
    const abandoned = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abandoned.abort();
    });
    const outcome = await executor.run(job, { signal: abandoned.signal });
    if (abandoned.signal.aborted) return;
    const done = unwrapOutcome(outcome);
    send(res, 200, done.body, { 'Content-Type': done.contentType, ...done.headers });
  }

  /**
   * Atiende rutas del gateway de módulos. Devuelve `true` si la ruta era de este borde (incluido 404 propio del módulo).
   */
  async function handle(req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<boolean> {
    if (parts.length === 1 && parts[0] === 'modules') {
      requireMethod(req, 'GET');
      sendJson(res, 200, registry.list().map(moduleCapabilities));
      return true;
    }
    if (parts.length === 1 && parts[0] === 'trace') {
      await requireComputeAccess(req);
      requireMethod(req, 'POST');
      await runCompute(res, { op: 'trace', body: await readBody(req) });
      return true;
    }
    const [id, action, command] = parts;
    if (!id || !action) return false;
    if (COMPUTE_ACTIONS.has(action)) await requireComputeAccess(req);
    const module = moduleOf(id);

    switch (action) {
      case 'capabilities':
        requireMethod(req, 'GET');
        sendJson(res, 200, moduleCapabilities(module));
        return true;
      case 'schema': {
        requireMethod(req, 'GET');
        const kind = url.searchParams.get('kind') ?? 'document';
        if (kind === 'document') {
          sendJson(res, 200, module.jsonSchema());
          return true;
        }
        if (kind === 'generation' && module.ai) {
          sendJson(res, 200, module.ai.generationJsonSchema());
          return true;
        }
        throw new HttpError(400, `kind debe ser «document»${module.ai ? ' o «generation»' : ''}.`);
      }
      case 'validate':
      case 'views':
      case 'diff':
        requireMethod(req, 'POST');
        await runCompute(res, { op: action, module: module.id, body: await readBody(req) });
        return true;
      case 'export':
        requireMethod(req, 'POST');
        await runCompute(res, {
          op: 'export',
          module: module.id,
          body: await readBody(req),
          format: url.searchParams.get('format') ?? 'json',
          view: url.searchParams.get('view') ?? undefined,
        });
        return true;
      case 'import':
        requireMethod(req, 'POST');
        await runCompute(res, {
          op: 'import',
          module: module.id,
          body: await readBody(req),
          importer: url.searchParams.get('importer') ?? undefined,
          name: url.searchParams.get('name') ?? undefined,
        });
        return true;
      case 'run':
        requireMethod(req, 'POST');
        if (!command) {
          throw new HttpError(
            404,
            `Indica el comando: /api/${id}/run/<comando>. Comandos: ${commandInfos(module).map((c) => c.name).join(', ') || '(ninguno)'}.`,
          );
        }
        await runCompute(res, { op: 'run', module: module.id, command, body: await readBody(req) });
        return true;
      default:
        throw new HttpError(404, `Acción desconocida «${action}». Use capabilities, schema, validate, views, export, import, diff o run.`);
    }
  }

  return { handle, runCompute, moduleOf };
}
