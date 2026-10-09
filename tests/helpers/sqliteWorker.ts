import { writeSync } from 'node:fs';
import { AccountError } from '../../src/cli/accounts/model';
import { SqliteAccountStore } from '../../src/cli/accounts/sqliteStore';

/**
 * Un proceso de verdad que usa la base de cuentas SQLite, para las pruebas de concurrencia entre procesos
 * (`src/cli/accounts/sqliteProcesses.test.ts`). Se lanza con `node --import tsx tests/helpers/sqliteWorker.ts <modo> <base> <n> [clave]`.
 *
 * Escribe una línea JSON por operación **ya confirmada** (`{"ok":true}` o `{"error":"limit"}`) con `writeSync` (sin búfer), de modo
 * que, aunque el proceso muera de golpe, el padre sabe exactamente cuántas operaciones llegaron a confirmarse.
 *
 * Modos:
 * - `invite`: `n` invitaciones con nombres `<clave>-<i>` (todas distintas).
 * - `signin`: `n` perfiles de GitHub (ids 1..n, siempre los mismos en todos los procesos) entran con el registro abierto.
 * - `sessions`: `n` sesiones de la cuenta `<clave>` (que debe existir).
 * - `share`: `n` proyectos `<clave>-p<i>` compartidos con la persona nueva `<clave>-u<i>` (invitación y pertenencia, en una transacción).
 * - `open`: solo abre la base (y migra) y la cierra: escribe `{"ready":true}` justo antes de abrir y `{"ok":true}` al terminar.
 * - `flood`: lo mismo que `share`, sin fin (hasta que el padre lo mate).
 */

const [mode, path, countArg, key = 'w'] = process.argv.slice(2);
const count = Number(countArg);
const report = (line: Record<string, unknown>): void => {
  writeSync(1, `${JSON.stringify(line)}\n`);
};

if (mode === 'open') {
  report({ ready: true });
  SqliteAccountStore.open(path, { busyTimeoutMs: 30_000 }).close();
  report({ ok: true });
  process.exit(0);
}

const store = SqliteAccountStore.open(path, { busyTimeoutMs: 30_000 });

function attempt(operation: () => void): void {
  try {
    operation();
    report({ ok: true });
  } catch (error) {
    if (error instanceof AccountError) report({ error: error.code });
    else throw error;
  }
}

switch (mode) {
  case 'invite':
    for (let i = 0; i < count; i++) attempt(() => store.invite(`${key}-${i}`, 'guest'));
    break;
  case 'signin':
    for (let i = 1; i <= count; i++) attempt(() => store.signIn({ id: i, login: `gh-${i}` }, { signup: 'open', admin: false }));
    break;
  case 'sessions': {
    const user = store.findByLogin(key);
    if (!user) throw new Error(`no existe la cuenta «${key}»`);
    for (let i = 0; i < count; i++) attempt(() => store.createSession(user.id, 3_600_000));
    break;
  }
  case 'share':
    for (let i = 0; i < count; i++) attempt(() => store.shareProject(`${key}-p${i}`, `${key}-u${i}`, 'viewer', 'guest'));
    break;
  case 'flood':
    for (let i = 0; ; i++) attempt(() => store.shareProject(`${key}-p${i}`, `${key}-u${i}`, 'viewer', 'guest'));
  default:
    throw new Error(`modo desconocido «${mode}»`);
}

store.close();
