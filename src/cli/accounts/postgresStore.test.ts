import { afterAll, beforeAll, describe } from 'vitest';
import { accountStoreContract } from '../../../tests/helpers/accountStoreContract';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, testConfig, uniqueSchema, type TestPostgres } from '../../../tests/helpers/postgres';
import { PostgresDatabase } from '../postgres/pool';
import { PostgresAccountStore } from './postgresStore';

requirePostgresIfCi();

// El contrato de `AccountStore` (el mismo que cumplen JSON y SQLite) contra un Postgres de verdad. La ruta que genera el contrato identifica el esquema de
// prueba: volver a abrir la misma ruta es volver a las mismas tablas (un reinicio del servicio).
describe.skipIf(!postgresAvailable())('PostgresAccountStore', () => {
  let server: TestPostgres;
  const schemas = new Map<string, string>();
  beforeAll(async () => {
    server = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    if (server) {
      const admin = await PostgresDatabase.connect(testConfig(server.url));
      try {
        for (const schema of schemas.values()) await admin.query(`drop schema if exists "${schema}" cascade`);
      } finally {
        await admin.close();
      }
    }
    await server?.stop();
  });

  accountStoreContract('postgres', {
    fileName: 'cuentas',
    open: async (path, options) => {
      const schema = schemas.get(path) ?? uniqueSchema();
      schemas.set(path, schema);
      const db = await PostgresDatabase.connect(testConfig(server.url, schema));
      return PostgresAccountStore.open(db, { ...options, release: () => db.close() });
    },
  });
});
