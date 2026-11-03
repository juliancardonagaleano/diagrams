import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../../../tests/helpers/postgres';
import { postgresAvailable, requirePostgresIfCi, startTestPostgres, type TestPostgres } from '../../../../tests/helpers/postgres';
import { notifyProjectChange, parseProjectChange, PostgresEventListener, serializeProjectChange } from './postgresBridge';

requirePostgresIfCi();

describe('postgresBridge', () => {
  it('serializa y parsea un aviso de cambio', () => {
    const text = serializeProjectChange({ type: 'project.created', project: 'tienda', updatedAt: '2020-01-01T00:00:00.000Z', by: '@ana' }, { alsoUsers: ['u1'] });
    expect(parseProjectChange(text)).toEqual({
      event: { type: 'project.created', project: 'tienda', updatedAt: '2020-01-01T00:00:00.000Z', by: '@ana' },
      options: { alsoUsers: ['u1'] },
    });
  });

  it('rechaza JSON inválido', () => {
    expect(parseProjectChange('not json')).toBeUndefined();
    expect(parseProjectChange('{}')).toBeUndefined();
  });
});

describe.skipIf(!postgresAvailable())('postgresBridge NOTIFY/LISTEN (Postgres real)', () => {
  let pg: TestPostgres;
  beforeAll(async () => {
    pg = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it('NOTIFY en el pool llega al LISTEN de sesión', async () => {
    const config = testConfig(pg.url);
    const { PostgresDatabase } = await import('../../../cli/postgres/pool');
    const db = await PostgresDatabase.connect(config);
    const received = vi.fn();
    const listener = new PostgresEventListener({
      config,
      onChange: (event, options) => received(event, options),
    });
    await listener.start();
    try {
      const event = { type: 'diagram.saved' as const, project: 'tienda', diagram: 'ctx', updatedAt: '2020-01-01T00:00:00.000Z', by: '@ana' };
      await notifyProjectChange(db, event, { alsoUsers: ['u1'] });
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith(event, { alsoUsers: ['u1'] }), { timeout: 5000 });
      expect(await listener.ping()).toBe(true);
    } finally {
      await listener.close();
      await db.close();
    }
  });
});
