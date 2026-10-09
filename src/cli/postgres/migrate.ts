import { DatabaseError, PostgresDatabase, quoteIdent, type Tx } from './pool';

/**
 * Las migraciones del esquema de IArk en Postgres y su endurecimiento. Cada almacén (cuentas, proyectos…) tiene su propia lista
 * numerada y su `namespace`; las versiones aplicadas se anotan en `<esquema>.migraciones`, así que cada almacén evoluciona por su cuenta
 * y varios procesos que arrancan a la vez no se pisan (un candado de asesoramiento serializa todo el arranque).
 *
 * Endurecimiento (`harden`), pensado para Supabase: la API pública de Supabase (PostgREST) expone el esquema `public` a cualquiera que
 * tenga la clave `anon`, que viaja en todo frontend de Supabase. Por eso las tablas de IArk viven en su propio esquema (`iark`, nunca
 * `public`; ver `config.ts`) y, además, en cada arranque:
 *   1. se revoca todo acceso a ese esquema, sus tablas y sus secuencias a `PUBLIC` y a los roles de Supabase (`anon`, `authenticated`,
 *      `service_role`) si existen: el servicio se conecta como dueño (`postgres`), que no los necesita;
 *   2. se activa la seguridad por filas (RLS) en TODAS las tablas del esquema, sin ninguna política: aunque algún día se concediera un
 *      acceso por error o se expusiera el esquema, un rol que no sea el dueño vería cero filas.
 */

export interface PgMigration {
  /** Consecutivas desde 1. */
  version: number;
  /** Para el registro de migraciones y los mensajes. */
  name: string;
  /** Sentencias SQL (cada una se manda por separado). Pueden usar `{schema}` para el esquema ya entrecomillado. */
  up: string[];
}

export interface MigrationResult {
  from: number;
  to: number;
  /** Cuántas migraciones se aplicaron ahora. */
  applied: number;
}

const MIGRATION_LOCK = 'iark:migrate';
const SUPABASE_ROLES = ['anon', 'authenticated', 'service_role'];

/** Valida que la lista esté numerada 1..n sin saltos (un error del código, no de quien usa el servicio). */
export function assertMigrationList(migrations: readonly PgMigration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Las migraciones deben ser consecutivas desde 1: «${m.name}» es la ${m.version} y debía ser la ${i + 1}.`);
  });
}

async function harden(tx: Tx, schema: string): Promise<void> {
  const q = quoteIdent(schema);
  await tx.query(`revoke all on schema ${q} from public`);
  await tx.query(`revoke all on all tables in schema ${q} from public`);
  await tx.query(`revoke all on all sequences in schema ${q} from public`);
  const roles = await tx.query<{ rolname: string }>('select rolname from pg_roles where rolname = any($1)', [SUPABASE_ROLES]);
  for (const { rolname } of roles) {
    const r = quoteIdent(rolname);
    await tx.query(`revoke all on schema ${q} from ${r}`);
    await tx.query(`revoke all on all tables in schema ${q} from ${r}`);
    await tx.query(`revoke all on all sequences in schema ${q} from ${r}`);
    // Lo que se cree DESPUÉS en este esquema tampoco debe heredar permisos para esos roles.
    await tx.query(`alter default privileges in schema ${q} revoke all on tables from ${r}`);
    await tx.query(`alter default privileges in schema ${q} revoke all on sequences from ${r}`);
  }
  const open = await tx.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p') and not c.relrowsecurity`,
    [schema],
  );
  for (const { relname } of open) await tx.query(`alter table ${q}.${quoteIdent(relname)} enable row level security`);
}

/**
 * Deja la base al día para `namespace`: crea el esquema y el registro si faltan, aplica las migraciones pendientes (cada una con su
 * anotación, todo en una transacción) y endurece el esquema. Falla con `incompatible` si la base ya tiene una versión más nueva de
 * la que este IArk conoce (otra instancia más moderna la migró): hay que actualizar este IArk, no tocar la base.
 */
export async function migrate(db: PostgresDatabase, namespace: string, migrations: readonly PgMigration[]): Promise<MigrationResult> {
  assertMigrationList(migrations);
  const schema = db.schemaQuoted;
  const known = migrations.length;
  return db.transaction(async (tx) => {
    await tx.lock(MIGRATION_LOCK);
    await tx.query(`create schema if not exists ${schema}`);
    await tx.query(
      `create table if not exists ${schema}.migraciones (
         namespace  text not null,
         version    integer not null check (version > 0),
         name       text not null,
         applied_at timestamptz not null default now(),
         primary key (namespace, version)
       )`,
    );
    const rows = await tx.query<{ version: number }>(`select version from ${schema}.migraciones where namespace = $1 order by version`, [namespace]);
    const current = rows.length ? rows[rows.length - 1].version : 0;
    if (current > known) {
      throw new DatabaseError('incompatible', `La base tiene el esquema «${namespace}» en la versión ${current}, más nueva que la ${known} que conoce este IArk. Actualice IArk; no modifique la base.`);
    }
    let applied = 0;
    for (const m of migrations.slice(current)) {
      for (const statement of m.up) await tx.query(statement.replaceAll('{schema}', schema));
      await tx.query(`insert into ${schema}.migraciones (namespace, version, name) values ($1, $2, $3)`, [namespace, m.version, m.name]);
      applied++;
    }
    await harden(tx, db.config.schema);
    return { from: current, to: current + applied, applied };
  });
}

/** La versión del esquema de `namespace` en la base (0 si no hay nada), sin crear nada. */
export async function currentVersion(db: PostgresDatabase, namespace: string): Promise<number> {
  const exists = await db.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`${db.schemaQuoted}.migraciones`]);
  if (!exists[0]?.ok) return 0;
  const rows = await db.query<{ version: number | null }>(`select max(version) as version from ${db.schemaQuoted}.migraciones where namespace = $1`, [namespace]);
  return rows[0]?.version ?? 0;
}
