import { writeSync } from 'node:fs';
import { AccountError } from '../../src/cli/accounts/model';
import { PostgresAccountStore } from '../../src/cli/accounts/postgresStore';
import { acquireDatabase, releaseDatabase } from '../../src/cli/postgres/shared';

/**
 * Un proceso de verdad que usa las cuentas en Postgres, para las pruebas de concurrencia entre procesos
 * (`src/cli/accounts/postgresProcesses.test.ts`). Se lanza con `node --import tsx tests/helpers/postgresWorker.ts <modo> <n> [clave]`; la
 * conexión sale del entorno (`IARK_DATABASE_URL` y `IARK_DATABASE_SCHEMA`), como en el servicio, y se abre con el pool compartido del proceso.
 *
 * Escribe una línea JSON por operación **ya confirmada** (`{"ok":true,"i":3}` o `{"error":"limit","i":3}`) con `writeSync` (sin búfer), de
 * modo que, aunque el proceso muera de golpe, el padre sabe exactamente cuántas operaciones llegaron a confirmarse.
 *
 * Modos (el mismo trabajo que `sqliteWorker.ts`, más el de los administradores):
 * - `invite`: `n` invitaciones con nombres `<clave>-<i>` (todas distintas).
 * - `signin`: `n` perfiles de GitHub (ids 1..n, siempre los mismos en todos los procesos) entran con el registro abierto.
 * - `sessions`: `n` sesiones de la cuenta `<clave>` (que debe existir).
 * - `share`: `n` proyectos `<clave>-p<i>` compartidos con la persona nueva `<clave>-u<i>` (invitación y pertenencia, en una transacción).
 * - `demote`: baja a `viewer` a la cuenta `<clave>` en los proyectos `pr-0`…`pr-<n-1>` (que el padre dejó con dos administradoras).
 * - `open`: solo abre el almacén (y migra) y lo cierra: escribe `{"ready":true}` justo antes de abrir y `{"ok":true}` al terminar.
 * - `flood`: lo mismo que `share`, sin fin (hasta que el padre lo mate).
 */

const [mode, countArg, key = 'w'] = process.argv.slice(2);
const count = Number(countArg);
const report = (line: Record<string, unknown>): void => {
  writeSync(1, `${JSON.stringify(line)}\n`);
};

async function attempt(i: number, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    report({ ok: true, i });
  } catch (error) {
    if (error instanceof AccountError) report({ error: error.code, i });
    else throw error;
  }
}

async function main(): Promise<void> {
  if (mode === 'open') report({ ready: true });
  const store = await PostgresAccountStore.open(await acquireDatabase(), { release: releaseDatabase });
  if (mode === 'open') {
    await store.close();
    report({ ok: true });
    return;
  }
  switch (mode) {
    case 'invite':
      for (let i = 0; i < count; i++) await attempt(i, () => store.invite(`${key}-${i}`, 'guest'));
      break;
    case 'signin':
      for (let i = 1; i <= count; i++) await attempt(i, () => store.signIn({ id: i, login: `gh-${i}` }, { signup: 'open', admin: false }));
      break;
    case 'sessions': {
      const user = await store.findByLogin(key);
      if (!user) throw new Error(`no existe la cuenta «${key}»`);
      for (let i = 0; i < count; i++) await attempt(i, () => store.createSession(user.id, 3_600_000));
      break;
    }
    case 'share':
      for (let i = 0; i < count; i++) await attempt(i, () => store.shareProject(`${key}-p${i}`, `${key}-u${i}`, 'viewer', 'guest'));
      break;
    case 'demote': {
      const user = await store.findByLogin(key);
      if (!user) throw new Error(`no existe la cuenta «${key}»`);
      for (let i = 0; i < count; i++) await attempt(i, () => store.setMember(`pr-${i}`, user.id, 'viewer'));
      break;
    }
    case 'flood':
      for (let i = 0; ; i++) await attempt(i, () => store.shareProject(`${key}-p${i}`, `${key}-u${i}`, 'viewer', 'guest'));
    default:
      throw new Error(`modo desconocido «${mode}»`);
  }
  await store.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
