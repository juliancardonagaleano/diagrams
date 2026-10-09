import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createToken } from '../src/cli/tokens';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';
import type { AccessRow, AuditRow } from './helpers/observability';

/**
 * Las opciones de observabilidad de `iark serve` con el CLI empaquetado como proceso: lo que se anuncia al arrancar, los errores de uso (código 2),
 * los registros por archivo y por la salida estándar, las variables de entorno, la reapertura con SIGHUP al rotar y la parada limpia.
 */

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const METRICS_TOKEN = 'metricas-0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let bundle: CliBundle;
beforeAll(async () => {
  bundle = await buildCliBundle('observabilidad');
});
afterAll(() => bundle?.dispose());

const children: ChildProcess[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-obs-cli-'));
  folders.push(dir);
  return dir;
};

interface Running {
  url: string;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<number | null>;
  signal: (signal: NodeJS.Signals) => void;
}

async function startCli(args: string[], env: Record<string, string> = {}): Promise<Running> {
  const child = spawn(process.execPath, [bundle.cli, 'serve', '--port', '0', '--host', '127.0.0.1', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IARK_ACCESS_LOG: '', IARK_AUDIT_LOG: '', IARK_METRICS: '', IARK_METRICS_TOKEN: '', ...env } });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no arrancó: ${stderr}`)), PROCESS_TEST_TIMEOUT - 10_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /escuchando en (http:\/\/\S+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => reject(new Error(`terminó con ${code}: ${stderr}`)));
  });
  return {
    url,
    stdout: () => stdout,
    stderr: () => stderr,
    signal: (signal) => void child.kill(signal),
    stop: () => {
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      return exited;
    },
  };
}

/** Un arranque que debe fallar: el código de salida y lo que dijo por stderr. */
function failingStart(args: string[], env: Record<string, string> = {}): { status: number | null; stderr: string; stdout: string } {
  const run = spawnSync(process.execPath, [bundle.cli, 'serve', '--port', '0', ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, IARK_ACCESS_LOG: '', IARK_AUDIT_LOG: '', IARK_METRICS: '', IARK_METRICS_TOKEN: '', ...env } });
  return { status: run.status, stderr: run.stderr, stdout: run.stdout };
}

const jsonLines = <T>(text: string): T[] => text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/** Una carpeta de trabajo con un archivo de tokens y un token admin. */
function workspace(): { dir: string; root: string; tokens: string; admin: string } {
  const dir = temp();
  const tokens = join(dir, 'tokens.json');
  return { dir, root: join(dir, 'espacio'), tokens, admin: createToken(tokens, { name: 'servicio', role: 'admin' }).token };
}

describe('iark serve: errores de uso de las opciones de observabilidad (código 2, antes de abrir el puerto)', () => {
  it('--metrics sin token fuera de loopback, con --trust-proxy o con un token corto', () => {
    for (const args of [['--metrics', '--host', '0.0.0.0'], ['--metrics', '--host', '127.0.0.1', '--trust-proxy'], ['--metrics', '--metrics-token', 'corto']]) {
      const run = failingStart(args);
      expect(run.status, args.join(' ')).toBe(2);
      expect(run.stderr, args.join(' ')).toMatch(/métricas|\/metrics/);
      expect(run.stderr).not.toContain('escuchando');
    }
    expect(failingStart(['--metrics', '--host', '0.0.0.0']).stderr).toContain('--metrics-token');
  });

  it('un archivo de registro que no se puede abrir, o el mismo archivo para los dos registros', () => {
    const dir = temp();
    writeFileSync(join(dir, 'archivo'), 'x');
    const audit = failingStart(['--audit-log', join(dir, 'archivo', 'dentro.jsonl')]);
    expect(audit.status).toBe(2);
    expect(audit.stderr).toContain('--audit-log');
    expect(failingStart(['--access-log', join(dir, 'archivo', 'dentro.jsonl')]).stderr).toContain('--access-log');
    const same = failingStart(['--access-log', join(dir, 'x.jsonl'), '--audit-log', join(dir, 'x.jsonl')]);
    expect(same.status).toBe(2);
    expect(same.stderr).toContain('el mismo archivo');
    expect(existsSync(join(dir, 'x.jsonl'))).toBe(false);
  });

  it('las ayudas de las cuatro opciones figuran en `iark serve --help`', () => {
    const help = spawnSync(process.execPath, [bundle.cli, 'serve', '--help'], { encoding: 'utf8', timeout: 60_000 }).stdout;
    for (const option of ['--access-log <archivo|->', '--audit-log <archivo|->', '--metrics', '--metrics-token <token>']) expect(help).toContain(option);
  });
});

describe('iark serve: sin opciones, la observabilidad está apagada', () => {
  it('no escribe ningún registro, /metrics no existe, pero hay X-Request-Id, /healthz y /readyz; y se detiene con SIGTERM (código 0)', async () => {
    const w = workspace();
    const cli = await startCli(['--workspace', w.root, '--tokens', w.tokens]);
    await vi.waitFor(() => expect(cli.stderr()).toContain('salud: /healthz (vivo) · /readyz (listo)'));
    expect(cli.stderr()).not.toContain('registro de accesos');
    const res = await fetch(`${cli.url}/api/projects`, { method: 'POST', headers: { ...bearer(w.admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tienda' }) });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toMatch(UUID);
    expect(await (await fetch(`${cli.url}/healthz`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${cli.url}/readyz`)).json()).toEqual({ status: 'ok', checks: { workspace: 'ok', tokens: 'ok', compute: 'ok' } });
    expect((await fetch(`${cli.url}/metrics`, { headers: bearer(METRICS_TOKEN) })).status).toBe(404);
    expect(await cli.stop()).toBe(0);
    expect(cli.stdout()).toBe('');
  });
});

describe('iark serve: registros y métricas encendidos', () => {
  it('--access-log - escribe JSON por línea en la salida estándar con el X-Request-Id de la respuesta; --audit-log deja un archivo 0600 con la misma petición', async () => {
    const w = workspace();
    const auditFile = join(w.dir, 'logs', 'auditoria.jsonl');
    const cli = await startCli(['--workspace', w.root, '--tokens', w.tokens, '--access-log', '-', '--audit-log', auditFile, '--metrics', '--metrics-token', METRICS_TOKEN]);
    await vi.waitFor(() => expect(cli.stderr()).toContain('salud: /healthz'));
    expect(cli.stderr()).toContain('registro de accesos: stdout');
    expect(cli.stderr()).toContain(`auditoría: ${auditFile}`);
    expect(cli.stderr()).toContain('métricas: /metrics (con token Bearer)');
    expect(cli.stderr()).not.toContain(METRICS_TOKEN);
    expect(statSync(auditFile).mode & 0o777).toBe(0o600);

    const created = await fetch(`${cli.url}/api/projects?token=${w.admin}`, { method: 'POST', headers: { ...bearer(w.admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tienda secreta' }) });
    expect(created.status).toBe(201);
    const id = created.headers.get('x-request-id')!;
    const denied = await fetch(`${cli.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Anónimo' }) });
    expect(denied.status).toBe(401);
    await fetch(`${cli.url}/healthz`);
    const metrics = await fetch(`${cli.url}/metrics`, { headers: bearer(METRICS_TOKEN) });
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain('iark_http_requests_total{method="POST",route="/api/projects",status_class="2xx"} 1');
    expect(text).toContain('iark_audit_events_total{action="project.create",result="denied"} 1');
    expect(text).toContain('iark_compute_workers_max');

    await vi.waitFor(() => expect(readFileSync(auditFile, 'utf8').trim().split('\n')).toHaveLength(2));
    const audit = jsonLines<AuditRow>(readFileSync(auditFile, 'utf8'));
    expect(audit[0]).toMatchObject({ action: 'project.create', result: 'ok', status: 201, requestId: id, actor: { kind: 'token', name: 'servicio', role: 'admin' }, target: { project: 'tienda-secreta' } });
    expect(audit[1]).toMatchObject({ action: 'project.create', result: 'denied', status: 401, code: 'unauthorized', actor: { kind: 'anonymous' }, requestId: denied.headers.get('x-request-id') });

    expect(await cli.stop()).toBe(0);
    const access = jsonLines<AccessRow>(cli.stdout());
    const row = access.find((r) => r.requestId === id);
    expect(row).toMatchObject({ method: 'POST', route: '/api/projects', status: 201, remote: '127.0.0.1', actor: { kind: 'token', name: 'servicio', role: 'admin' } });
    expect(access.some((r) => r.route === '/healthz')).toBe(false); // los chequeos que salen bien no llenan el registro
    // nada sensible en ningún registro ni en la salida
    const everything = `${cli.stdout()}\n${readFileSync(auditFile, 'utf8')}`;
    for (const secret of [w.admin, METRICS_TOKEN, 'Tienda secreta', 'token=']) expect(everything, secret).not.toContain(secret);
  });

  it('las variables de entorno hacen lo mismo que las opciones (IARK_ACCESS_LOG, IARK_AUDIT_LOG, IARK_METRICS, IARK_METRICS_TOKEN)', async () => {
    const w = workspace();
    const accessFile = join(w.dir, 'acceso.jsonl');
    const auditFile = join(w.dir, 'auditoria.jsonl');
    const cli = await startCli(['--workspace', w.root, '--tokens', w.tokens], { IARK_ACCESS_LOG: accessFile, IARK_AUDIT_LOG: auditFile, IARK_METRICS: '1', IARK_METRICS_TOKEN: METRICS_TOKEN });
    const res = await fetch(`${cli.url}/api/projects`, { method: 'POST', headers: { ...bearer(w.admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tienda' }) });
    expect(res.status).toBe(201);
    expect((await fetch(`${cli.url}/metrics`)).status).toBe(401);
    expect((await fetch(`${cli.url}/metrics`, { headers: bearer(METRICS_TOKEN) })).status).toBe(200);
    await vi.waitFor(() => expect(jsonLines<AccessRow>(readFileSync(accessFile, 'utf8')).map((r) => r.status)).toEqual(expect.arrayContaining([201, 401])));
    expect(jsonLines<AuditRow>(readFileSync(auditFile, 'utf8')).map((r) => r.action)).toEqual(['project.create']);
    expect(statSync(accessFile).mode & 0o777).toBe(0o600);
    expect(await cli.stop()).toBe(0);
  });

  it('el token de métricas puede venir de un archivo (IARK_METRICS_TOKEN_FILE) y --metrics sin token en loopback sirve solo a conexiones locales', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'token'), `${METRICS_TOKEN}\n`, { mode: 0o600 });
    const withFile = await startCli(['--metrics'], { IARK_METRICS_TOKEN_FILE: join(dir, 'token') });
    expect((await fetch(`${withFile.url}/metrics`)).status).toBe(401);
    expect((await fetch(`${withFile.url}/metrics`, { headers: bearer(METRICS_TOKEN) })).status).toBe(200);
    expect(await withFile.stop()).toBe(0);
    const tokenless = await startCli(['--metrics']);
    await vi.waitFor(() => expect(tokenless.stderr()).toContain('solo conexiones locales'));
    expect((await fetch(`${tokenless.url}/metrics`)).status).toBe(200);
    expect(await tokenless.stop()).toBe(0);
  });

  it('SIGHUP vuelve a abrir los archivos de registro: tras rotar (renombrar), las líneas nuevas van al archivo nuevo y no se pierde ninguna', async () => {
    const w = workspace();
    const accessFile = join(w.dir, 'acceso.jsonl');
    const auditFile = join(w.dir, 'auditoria.jsonl');
    const cli = await startCli(['--workspace', w.root, '--tokens', w.tokens, '--access-log', accessFile, '--audit-log', auditFile]);
    const create = (name: string) => fetch(`${cli.url}/api/projects`, { method: 'POST', headers: { ...bearer(w.admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    expect((await create('Antes')).status).toBe(201);
    await vi.waitFor(() => expect(readFileSync(auditFile, 'utf8')).toContain('antes'));
    await vi.waitFor(() => expect(readFileSync(accessFile, 'utf8')).toContain('/api/projects'));
    renameSync(auditFile, `${auditFile}.1`);
    renameSync(accessFile, `${accessFile}.1`);
    cli.signal('SIGHUP');
    await vi.waitFor(() => expect(existsSync(auditFile) && existsSync(accessFile)).toBe(true));
    expect((await create('Despues')).status).toBe(201);
    await vi.waitFor(() => expect(readFileSync(auditFile, 'utf8')).toContain('despues'));
    await vi.waitFor(() => expect(jsonLines<AccessRow>(readFileSync(accessFile, 'utf8')).length).toBeGreaterThanOrEqual(1));
    expect(readFileSync(`${auditFile}.1`, 'utf8')).toContain('antes');
    expect(readFileSync(`${auditFile}.1`, 'utf8')).not.toContain('despues');
    expect(readFileSync(auditFile, 'utf8')).not.toContain('antes');
    expect(statSync(auditFile).mode & 0o777).toBe(0o600);
    expect(await cli.stop()).toBe(0);
  });

  it('sin archivos de registro, SIGHUP conserva su comportamiento de siempre (el proceso termina)', async () => {
    const cli = await startCli([]);
    const exited = new Promise<number | null>((resolve) => children.at(-1)!.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : null))));
    cli.signal('SIGHUP');
    expect(await exited).not.toBeNull();
  });
});
