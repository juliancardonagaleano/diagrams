import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROCESS_TEST_TIMEOUT } from '../../../tests/helpers/cliBundle';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig, uniqueSchema, type TestPostgres } from '../../../tests/helpers/postgres';
import { currentVersion } from '../postgres/migrate';
import { PostgresDatabase } from '../postgres/pool';
import { MIGRATIONS, PostgresAccountStore } from './postgresStore';
import { MAX_PENDING_USERS, MAX_SESSIONS_PER_USER } from './store';

requirePostgresIfCi();

// Varios procesos de verdad (no varias conexiones de uno) sobre las mismas tablas de Postgres: lo que promete el almacén transaccional, con los
// candados de asesoramiento y el bloqueo de filas. Cada proceso es `tests/helpers/postgresWorker.ts`, lanzado con `node --import tsx`, y toma
// la conexión del entorno como el servicio. Es la contraparte de `sqliteProcesses.test.ts`.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT });

const WORKER = resolve('tests/helpers/postgresWorker.ts');

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Una línea por operación confirmada: `{ ok: true, i }` o `{ error: <código>, i }`. */
  lines: Array<{ ok?: true; ready?: true; error?: string; i?: number }>;
  stderr: string;
}

describe.skipIf(!postgresAvailable())('PostgresAccountStore entre procesos (varios procesos, una base)', () => {
  let server: TestPostgres;
  const schemas: string[] = [];
  const children: ChildProcess[] = [];
  let admin: PostgresDatabase;
  beforeAll(async () => {
    server = await startTestPostgres();
    admin = await PostgresDatabase.connect(testConfig(server.url));
  }, 120_000);
  afterAll(async () => {
    try {
      for (const schema of schemas) await admin?.query(`drop schema if exists "${schema}" cascade`);
    } finally {
      await admin?.close();
      await server?.stop();
    }
  });
  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  });

  const newSchema = (): string => {
    const schema = uniqueSchema();
    schemas.push(schema);
    return schema;
  };

  function launch(schema: string, mode: string, count: number, key = 'w'): { child: ChildProcess; done: Promise<Outcome>; seen: () => number } {
    const env = { ...process.env, IARK_DATABASE_URL: server.url, IARK_DATABASE_SCHEMA: schema, IARK_DATABASE_POOL: '2' };
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, mode, String(count), key], { stdio: ['ignore', 'pipe', 'pipe'], env });
    children.push(child);
    let out = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const done = new Promise<Outcome>((resolveOutcome) => {
      child.once('close', (code, signal) => {
        // Una línea cortada por un SIGKILL a mitad de escritura no cuenta: solo las completas.
        const complete = out.split('\n').slice(0, -1).filter(Boolean);
        resolveOutcome({ code, signal, lines: complete.map((line) => JSON.parse(line) as Outcome['lines'][number]), stderr });
      });
    });
    return { child, done, seen: () => out.split('\n').length - 1 };
  }

  /** Lanza `processes` procesos a la vez con el mismo trabajo y espera a todos. */
  async function race(schema: string, mode: string, processes: number, count: number, key?: (index: number) => string): Promise<Outcome[]> {
    const runs = Array.from({ length: processes }, (_, index) => launch(schema, mode, count, key?.(index)));
    return Promise.all(runs.map((run) => run.done));
  }

  const expectClean = (outcomes: Outcome[]): void => {
    for (const outcome of outcomes) {
      expect(outcome.stderr, 'stderr del proceso').toBe('');
      expect(outcome.code).toBe(0);
      expect(outcome.lines.every((line) => line.ok || line.error === 'limit' || line.error === 'conflict' || line.error === 'last-admin')).toBe(true);
    }
  };
  const countOf = (outcomes: Outcome[], pick: (line: Outcome['lines'][number]) => boolean): number => outcomes.reduce((total, outcome) => total + outcome.lines.filter(pick).length, 0);

  /** Abre el almacén desde el padre sobre ese esquema (lo deja migrado antes de la carrera, o lo mira después). */
  async function open(schema: string): Promise<{ store: PostgresAccountStore; db: PostgresDatabase }> {
    const db = await PostgresDatabase.connect(testConfig(server.url, schema));
    return { store: await PostgresAccountStore.open(db, { release: () => db.close() }), db };
  }
  const n = async (db: PostgresDatabase, sql: string): Promise<number> => Number((await db.query<{ n: string }>(sql))[0]?.n);

  it('el tope de invitaciones sin aceptar se respeta aunque lo disputen cuatro procesos: ni una más ni una menos', async () => {
    const schema = newSchema();
    const { store, db } = await open(schema);
    try {
      // 4 procesos x 150 invitaciones distintas = 600 intentos para 500 plazas.
      const outcomes = await race(schema, 'invite', 4, 150, (index) => `p${index}`);
      expectClean(outcomes);
      expect(countOf(outcomes, (line) => line.ok === true)).toBe(MAX_PENDING_USERS);
      expect(countOf(outcomes, (line) => line.error === 'limit')).toBe(600 - MAX_PENDING_USERS);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')} where github_id is null`)).toBe(MAX_PENDING_USERS);
    } finally {
      await store.close();
    }
  });

  it('la misma persona que entra a la vez por cuatro procesos acaba con una sola cuenta (nunca duplicada)', async () => {
    const schema = newSchema();
    const { store, db } = await open(schema);
    try {
      const outcomes = await race(schema, 'signin', 4, 60);
      expectClean(outcomes);
      expect(countOf(outcomes, (line) => line.ok === true)).toBe(4 * 60);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')}`)).toBe(60);
      expect(await n(db, `select count(distinct github_id) as n from ${db.table('cuentas_users')}`)).toBe(60);
      expect(await n(db, `select count(distinct login_key) as n from ${db.table('cuentas_users')}`)).toBe(60);
    } finally {
      await store.close();
    }
  });

  it('el tope de sesiones por cuenta se respeta con cuatro procesos abriendo sesiones a la vez', async () => {
    const schema = newSchema();
    const { store, db } = await open(schema);
    try {
      const user = await store.invite('ana', 'member');
      const outcomes = await race(schema, 'sessions', 4, 40, () => 'ana');
      expectClean(outcomes);
      expect(countOf(outcomes, (line) => line.ok === true)).toBe(160);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_sessions')} where user_id = '${user.id}'`)).toBe(MAX_SESSIONS_PER_USER);
    } finally {
      await store.close();
    }
  });

  it('compartir un proyecto con una persona nueva (invitación y pertenencia) es indivisible: nunca queda una sin la otra', async () => {
    const schema = newSchema();
    const { store, db } = await open(schema);
    try {
      const outcomes = await race(schema, 'share', 4, 80, (index) => `c${index}`);
      expectClean(outcomes);
      expect(countOf(outcomes, (line) => line.ok === true)).toBe(320);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')}`)).toBe(320);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_members')}`)).toBe(320);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')} u where not exists (select 1 from ${db.table('cuentas_members')} m where m.user_id = u.id)`)).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('dos procesos que degradan a la vez a las dos únicas administradoras de un proyecto: en cada proyecto solo uno lo consigue (nunca se queda sin administración)', async () => {
    const schema = newSchema();
    const { store, db } = await open(schema);
    try {
      const open_ = { signup: 'open', admin: false } as const;
      const ana = await store.signIn({ id: 1, login: 'ana' }, open_);
      const beto = await store.signIn({ id: 2, login: 'beto' }, open_);
      const PROJECTS = 40;
      for (let i = 0; i < PROJECTS; i++) {
        await store.registerProject(`pr-${i}`, ana.id);
        await store.setMember(`pr-${i}`, beto.id, 'admin');
      }
      const outcomes = await Promise.all([launch(schema, 'demote', PROJECTS, 'ana').done, launch(schema, 'demote', PROJECTS, 'beto').done]);
      expectClean(outcomes);
      for (let i = 0; i < PROJECTS; i++) {
        const results = outcomes.map((outcome) => outcome.lines.find((line) => line.i === i)?.error ?? 'ok').sort();
        expect(results, `proyecto pr-${i}`).toEqual(['last-admin', 'ok']);
        expect(await n(db, `select count(*) as n from ${db.table('cuentas_members')} where project_id = 'pr-${i}' and role = 'admin'`), `administradoras de pr-${i}`).toBe(1);
      }
    } finally {
      await store.close();
    }
  });

  it('un proceso que muere de golpe (SIGKILL) en plena escritura no deja una operación a medias, y la base sigue usable', async () => {
    const schema = newSchema();
    const { store, db } = await open(schema);
    try {
      const run = launch(schema, 'flood', 0, 'k');
      // Esperar a que lleve unas cuantas operaciones confirmadas y matarlo sin avisar, a mitad de la siguiente.
      await vi.waitFor(() => expect(run.seen()).toBeGreaterThanOrEqual(25), { timeout: 60_000, interval: 20 });
      run.child.kill('SIGKILL');
      const outcome = await run.done;
      expect(outcome.signal).toBe('SIGKILL');

      const confirmed = outcome.lines.filter((line) => line.ok).length;
      expect(confirmed).toBeGreaterThanOrEqual(25);
      const users = await n(db, `select count(*) as n from ${db.table('cuentas_users')}`);
      const members = await n(db, `select count(*) as n from ${db.table('cuentas_members')}`);
      // Todo lo confirmado está, y como mucho una operación más (la que llegó a confirmarse justo antes del golpe sin que el padre leyera su línea).
      expect(users).toBeGreaterThanOrEqual(confirmed);
      expect(users).toBeLessThanOrEqual(confirmed + 1);
      expect(members).toBe(users); // la invitación y la pertenencia van juntas o no van

      // Y el candado de escritura no se quedó tomado por la conexión muerta: el servicio sigue escribiendo.
      const before = await store.userCount();
      await store.invite('despues', 'guest');
      expect(await store.userCount()).toBe(before + 1);
    } finally {
      await store.close();
    }
  });

  it('cuatro servicios que arrancan a la vez sobre una base vacía migran sin errores: el esquema se aplica una sola vez', async () => {
    const schema = newSchema(); // sin abrir antes: los cuatro procesos lo crean y migran a la vez
    const outcomes = await race(schema, 'invite', 4, 10, (index) => `a${index}`);
    expectClean(outcomes);
    expect(countOf(outcomes, (line) => line.ok === true)).toBe(40);
    const db = await PostgresDatabase.connect(testConfig(server.url, schema));
    try {
      expect(await currentVersion(db, 'cuentas')).toBe(MIGRATIONS.length);
      expect(await n(db, `select count(*) as n from ${db.table('cuentas_users')}`)).toBe(40);
    } finally {
      await db.close();
    }
  });
});
