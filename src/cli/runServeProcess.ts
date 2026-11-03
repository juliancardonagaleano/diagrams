import { existsSync, statSync } from 'node:fs';
import type { ModuleRegistry } from '@iark/kernel';
import { ComputePool } from './computePool';
import { resolveComputeSettings } from './computeConfig';
import { createSuiteServer } from './serve';
import { setupObservability } from './observability/options';
import type { ReadinessProcess } from './observability/readinessChecks';
import { isLoopbackHost } from '../diagrams-identity/core/authenticator';
import { parseFrameAncestors } from './securityHeaders';
import { setupAccounts } from '../diagrams-identity/core/accounts/setup';
import { formatBytes } from '../diagrams-identity/core/accounts/usage';
import { TokenStore } from '../diagrams-identity/core/tokens';
import { FolderProjectStore } from '../diagrams-app/modules/projects/infrastructure/workspace';
import { releaseDatabase } from './postgres/shared';
import { openPostgresProjects, resolveWorkspaceStore } from './workspaceStore';
import { openEventsStack } from './eventsStack';
import { CliError, info } from './io';
import type { ResolvedPlugin } from './plugins/resolve';

export type ServeCliRole = ReadinessProcess;

const CLI_VERSION = '0.1.0';

const ROLE_LABEL: Record<Exclude<ServeCliRole, 'suite'>, string> = {
  gateway: 'diagrams-gateway',
  identity: 'diagrams-identity',
  app: 'diagrams-app',
  sse: 'diagrams-sse',
};

export interface RunServeProcessInput {
  role: ServeCliRole;
  opts: Record<string, unknown>;
  registry: ModuleRegistry;
  plugins: ResolvedPlugin[];
}

function parseCors(raw: unknown): string[] {
  return typeof raw === 'string' ? raw.split(',').map((o) => o.trim()).filter(Boolean) : [];
}

function parseStreams(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const streams = Number(raw);
  if (!Number.isInteger(streams) || streams < 0 || streams > 1000) throw new CliError('--max-streams debe ser un entero entre 0 (desactiva el canal) y 1000.', 2);
  return streams;
}

function workspaceRequired(role: ServeCliRole): boolean {
  // `iark serve` (suite) puede arrancar solo API sin proyectos; los procesos partidos sí exigen almacén.
  return role === 'app' || role === 'sse';
}

function accountsWorkspaceFlag(role: ServeCliRole, hasWorkspace: boolean): boolean {
  return hasWorkspace || role === 'identity';
}

/** Arranca y bloquea hasta SIGINT/SIGTERM. Usado por `iark serve` (suite) y por los procesos partidos. */
export async function runServeProcess(input: RunServeProcessInput): Promise<void> {
  let { role } = input;
  const { registry, plugins } = input;
  const opts = input.opts;

  if (process.env.IARK_STATIC) throw new CliError('IARK_STATIC ya no sirve el sitio desde iark serve: publique dist/pages en GitHub Pages o use un CDN (spec 009).', 2);

  const envRole = (process.env.IARK_SERVE_ROLE ?? '').trim().toLowerCase();
  if (envRole && role === 'suite') {
    const mapped: Record<string, ServeCliRole> = { gateway: 'gateway', identity: 'identity', app: 'app', sse: 'sse', suite: 'suite' };
    const fromEnv = mapped[envRole];
    if (!fromEnv) throw new CliError(`IARK_SERVE_ROLE debe ser gateway, identity, app, sse o suite; no «${envRole.slice(0, 40)}».`, 2);
    if (fromEnv !== 'suite') role = fromEnv;
  }

  if (opts.workspace && existsSync(String(opts.workspace)) && !statSync(String(opts.workspace)).isDirectory()) {
    throw new CliError(`El espacio de trabajo «${opts.workspace}» no es una carpeta.`, 2);
  }

  let frameAncestors: string[];
  try {
    frameAncestors = parseFrameAncestors(opts.frameAncestors as string | undefined);
  } catch (error) {
    throw new CliError((error as Error).message, 2);
  }

  const cors = parseCors(opts.cors);
  const workspaceStore = resolveWorkspaceStore(opts.workspaceStore as string | undefined, opts.workspace as string | undefined);
  const hasWorkspace = workspaceStore === 'postgres' || !!opts.workspace;
  if (workspaceRequired(role) && !hasWorkspace) {
    const cmd = role === 'sse' ? 'serve-sse' : role === 'app' ? 'serve-app' : 'serve';
    throw new CliError(`${cmd} exige --workspace o --workspace-store postgres.`, 2);
  }

  const accounts = await setupAccounts(opts as Parameters<typeof setupAccounts>[0], { workspace: accountsWorkspaceFlag(role, hasWorkspace), cors });
  const host = String(opts.host ?? '127.0.0.1');
  const loopback = isLoopbackHost(host);
  const trustProxy = Boolean(opts.trustProxy);
  const tlsNote = (why: string): string =>
    trustProxy ? `  detrás de un proxy de confianza (--trust-proxy): el HTTPS lo pone el proxy, compruebe que la dirección pública es https; ${why}` : `aviso: este servicio no habla TLS: ponga delante un proxy con HTTPS (Caddy, nginx…); ${why}`;

  if ((role === 'suite' || role === 'app') && hasWorkspace && !opts.tokens && !accounts && !loopback) {
    throw new CliError(
      `Con un espacio de trabajo, escuchar en ${host} sin autenticación dejaría los proyectos al alcance de quien llegue a ese puerto: el servicio no arranca así. ` +
        'Elija una de las salidas: exija un token con --tokens <archivo> (o IARK_TOKENS), active el inicio de sesión con GitHub (--accounts) o escuche solo en loopback con --host 127.0.0.1.',
      2,
    );
  }

  const compute = role === 'gateway' || role === 'suite' ? resolveComputeSettings(opts) : { workers: 0, timeoutMs: 30_000, maxQueue: 16, publicCompute: false };
  const streams = role === 'identity' || role === 'gateway' ? 0 : parseStreams(opts.maxStreams);
  const observed = setupObservability(opts, { host, trustProxy, version: CLI_VERSION });
  const tokens = opts.tokens ? TokenStore.open(String(opts.tokens)) : undefined;
  const pool =
    (role === 'gateway' || role === 'suite') && compute.workers > 0
      ? new ComputePool({ size: compute.workers, timeoutMs: compute.timeoutMs, maxQueue: compute.maxQueue, plugins })
      : undefined;

  const projects =
    role === 'gateway' || role === 'identity'
      ? undefined
      : workspaceStore === 'postgres'
        ? await openPostgresProjects()
        : opts.workspace
          ? new FolderProjectStore(String(opts.workspace))
          : undefined;

  const eventsOn = (role === 'suite' || role === 'app' || role === 'sse') && !!projects && streams !== 0;
  const eventsStack = eventsOn ? await openEventsStack({ projects, accounts, events: { maxPerPerson: streams ?? 8 } }) : undefined;

  const server = createSuiteServer({
    registry,
    version: CLI_VERSION,
    cors,
    projects,
    tokens,
    accounts,
    trustProxy,
    frameAncestors: role === 'suite' ? frameAncestors : undefined,
    compute: pool,
    publicCompute: compute.publicCompute,
    observability: observed.observability,
    metricsToken: observed.metricsToken,
    events: eventsOn ? { maxPerPerson: streams ?? 8 } : false,
    eventsStack,
    readinessProcess: role,
  });

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once('error', rejectListening);
      server.listen(Number(opts.port), host, resolveListening);
    });
  } catch (error) {
    if (projects?.kind === 'postgres') await releaseDatabase();
    throw error;
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : Number(opts.port);
  const hostLabel = host.includes(':') ? `[${host}]` : host;
  if (role === 'suite') {
    info(`DIAgrams escuchando en http://${hostLabel}:${port} (solo API; el sitio va en Pages o CDN)`);
    info(`  manifiesto: /.well-known/iark.json · módulos: /api/modules`);
  } else {
    info(`${ROLE_LABEL[role]} escuchando en http://${hostLabel}:${port}`);
  }
  for (const line of observed.lines) info(line);

  if (role === 'gateway' || role === 'suite') {
    const thirdParty = registry.ids().filter((id) => registry.originOf(id) !== undefined);
    if (thirdParty.length > 0) {
      info(
        role === 'suite'
          ? `  módulos de terceros (se operan por la API y salen en el manifiesto; el sitio web no los trae): ${thirdParty.join(', ')}`
          : `  módulos de terceros: ${thirdParty.join(', ')}`,
      );
    }
    if (pool) {
      info(
        role === 'suite'
          ? `  cálculo: hasta ${pool.size} hilo(s) de trabajo · tiempo límite ${pool.timeoutMs / 1000} s por operación · cola de ${pool.maxQueue}`
          : `  cálculo: hasta ${pool.size} hilo(s) · ${pool.timeoutMs / 1000} s por operación · cola ${pool.maxQueue}`,
      );
    } else if (role === 'suite') info('aviso: --workers 0: el cálculo corre en el hilo principal, sin tiempo límite ni cola; una exportación grande bloquea el servicio entero.');
    else if (role === 'gateway') info('aviso: --workers 0: el cálculo corre en el hilo principal.');
  }

  if ((role === 'gateway' || role === 'suite') && (tokens || accounts)) {
    info(
      compute.publicCompute
        ? role === 'suite'
          ? 'aviso: --public-compute: las rutas de cálculo (validar, exportar, importar, informes, trazas) están abiertas a quien llegue al puerto, aunque haya autenticación.'
          : 'aviso: --public-compute: las rutas de cálculo están abiertas sin credencial.'
        : '  las rutas de cálculo (validar, exportar, importar, informes, trazas) exigen credencial; /api/modules, capabilities y schema siguen públicos',
    );
  }

  if (projects && (role === 'app' || role === 'suite' || role === 'sse')) {
    info(`  espacio de trabajo: ${projects instanceof FolderProjectStore ? projects.root : projects.description}${role === 'suite' || role === 'app' ? ' · proyectos: /api/projects' : ''}`);
    if (role === 'suite') {
      info(streams === 0 ? '  cambios en tiempo real: desactivados (--max-streams 0); los clientes sondean cada 30 s' : `  cambios en tiempo real: /api/events (hasta ${streams ?? 8} canal(es) por persona)`);
    } else if (role === 'sse') info('  cambios en tiempo real: GET /api/events');
  }

  if (accounts && (role === 'identity' || role === 'app' || role === 'suite' || role === 'sse')) {
    if (role === 'suite' || role === 'app') {
      info(`  inicio de sesión: GitHub (${accounts.github?.clientId}) · callback ${accounts.callbackUrl} · cuentas: ${accounts.store.path} (${await accounts.store.userCount()}, almacén ${accounts.store.kind}) · entrada: ${accounts.signup === 'open' ? 'abierta' : 'solo por invitación'} · administradores: ${accounts.adminCount}`);
      const q = accounts.quotas;
      const shown = (value: number, unit = ''): string => (value === 0 ? 'sin tope' : `${value}${unit}`);
      info(`  cuotas por persona: espacio ${q.bytes === 0 ? 'sin tope' : formatBytes(q.bytes)} · proyectos ${shown(q.projects)} · diagramas por proyecto ${shown(q.diagramsPerProject)} (ajustables a cada persona desde la administración; /api/usage)`);
    } else {
      info(`  inicio de sesión: GitHub (${accounts.github?.clientId}) · callback ${accounts.callbackUrl}`);
      if (role === 'identity') info(`  cuentas: ${accounts.store.path} (${await accounts.store.userCount()}, ${accounts.store.kind}) · administradores: ${accounts.adminCount}`);
    }
    if (!loopback) info(tlsNote(role === 'suite' ? 'GitHub solo devuelve a la persona a la dirección pública, y las sesiones viajan por ella.' : 'las sesiones y los tokens viajan por la dirección pública.'));
  }

  if (tokens) {
    if (role === 'suite') {
      info(`  autenticación: tokens de ${tokens.path} (${tokens.size}), roles viewer, editor y admin · /api/whoami`);
      if (tokens.size === 0) info('aviso: el archivo no tiene ningún token: cree uno con `iark auth create <nombre> --role admin` (no hace falta reiniciar).');
    } else info(`  tokens: ${tokens.path} (${tokens.size}) · /api/whoami`);
    if (!loopback && role === 'suite') info(tlsNote('si no, los tokens viajan en claro.'));
  }

  if (role === 'gateway') info('  API de módulos: /api/modules · POST /api/trace');
  if (role === 'identity') info('  identidad: /api/auth · /api/admin · /api/usage · /api/whoami');
  if (projects?.kind === 'postgres' && role === 'sse') info('  canal: Postgres NOTIFY/LISTEN (IARK_DATABASE_SESSION_URL si el pooler no admite LISTEN)');

  if (process.platform !== 'win32' && observed.observability.hasFiles) process.on('SIGHUP', () => observed.observability.reopen());

  await new Promise<void>((resolveClosed) => {
    const stop = (): void =>
      void server.close(() =>
        void (pool?.close() ?? Promise.resolve())
          .then(() => observed.observability.close())
          .then(() => accounts?.store.close())
          .then(() => (projects?.kind === 'postgres' ? releaseDatabase() : undefined))
          .then(() => resolveClosed()),
      );
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
