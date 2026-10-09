import { describe, expect, it } from 'vitest';
import { DatabaseConfigError, DEFAULT_POOL_MAX, resolveDatabaseConfig } from './config';

const URL_REMOTE = 'postgresql://postgres.abcd:s3cr%40t@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
const resolve = (env: Record<string, string>, files: Record<string, string> = {}) =>
  resolveDatabaseConfig(env, (path) => {
    if (path in files) return files[path];
    throw Object.assign(new Error('no'), { code: 'ENOENT' });
  });
const fails = (env: Record<string, string>, files: Record<string, string> = {}) => {
  try {
    resolve(env, files);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    return (error as Error).message;
  }
  throw new Error('debía fallar');
};

describe('configuración de Postgres', () => {
  it('lee la cadena, usa TLS con comprobación fuera de localhost y el esquema iark por omisión', () => {
    const c = resolve({ IARK_DATABASE_URL: URL_REMOTE });
    expect(c.sslMode).toBe('verify');
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(c.schema).toBe('iark');
    expect(c.poolMax).toBe(DEFAULT_POOL_MAX);
    expect(c.connectionString).toContain('s3cr%40t'); // la clave codificada se conserva tal cual
  });

  it('en localhost no usa TLS por omisión', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(resolve({ IARK_DATABASE_URL: `postgres://u:p@${host}:5432/db` }).sslMode).toBe('off');
    }
  });

  it('la descripción para los mensajes nunca lleva la contraseña', () => {
    const c = resolve({ IARK_DATABASE_URL: URL_REMOTE });
    expect(c.description).toBe('postgresql://postgres.abcd@aws-0-eu-west-1.pooler.supabase.com:6543/postgres');
    expect(c.description).not.toMatch(/s3cr/);
  });

  it('IARK_DATABASE_SSL manda sobre la cadena; sslmode se respeta solo si es inequívoco y se quita de la cadena', () => {
    expect(resolve({ IARK_DATABASE_URL: `${URL_REMOTE}?sslmode=disable` }).sslMode).toBe('off');
    expect(resolve({ IARK_DATABASE_URL: `${URL_REMOTE}?sslmode=verify-full` }).sslMode).toBe('verify');
    // `require` en libpq no comprueba al servidor; aquí sí, salvo petición expresa
    expect(resolve({ IARK_DATABASE_URL: `${URL_REMOTE}?sslmode=require` }).sslMode).toBe('verify');
    const c = resolve({ IARK_DATABASE_URL: `${URL_REMOTE}?sslmode=require&application_name=x`, IARK_DATABASE_SSL: 'no-verify' });
    expect(c.sslMode).toBe('no-verify');
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(c.connectionString).not.toContain('sslmode');
    expect(c.connectionString).toContain('application_name=x');
  });

  it('la autoridad de certificación se lee de un archivo PEM y no vale sin TLS', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
    const c = resolve({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_CA_FILE: '/ca.pem' }, { '/ca.pem': pem });
    expect(c.ssl).toEqual({ rejectUnauthorized: true, ca: pem });
    expect(fails({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_CA_FILE: '/no.pem' })).toMatch(/IARK_DATABASE_CA_FILE.*ENOENT/);
    expect(fails({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_CA_FILE: '/x' }, { '/x': 'hola' })).toMatch(/no parece un certificado/);
    expect(fails({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_CA_FILE: '/ca.pem', IARK_DATABASE_SSL: 'off' }, { '/ca.pem': pem })).toMatch(/no tiene sentido/);
  });

  it('la cadena puede venir de un archivo, pero no de los dos sitios', () => {
    expect(resolve({ IARK_DATABASE_URL_FILE: '/url' }, { '/url': `${URL_REMOTE}\n` }).description).toContain('supabase.com');
    expect(fails({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_URL_FILE: '/url' }, { '/url': URL_REMOTE })).toMatch(/no las dos/);
    expect(fails({ IARK_DATABASE_URL_FILE: '/nada' })).toMatch(/IARK_DATABASE_URL_FILE.*ENOENT/);
  });

  it('rechaza lo que no es una cadena de Postgres, sin repetir la contraseña', () => {
    expect(fails({})).toMatch(/Falta IARK_DATABASE_URL/);
    expect(fails({ IARK_DATABASE_URL: 'esto no es una url' })).toMatch(/no es una dirección válida/);
    const wrong = fails({ IARK_DATABASE_URL: 'mysql://u:clavesecreta@h/db' });
    expect(wrong).toMatch(/postgres:\/\//);
    expect(wrong).not.toMatch(/clavesecreta/);
    expect(fails({ IARK_DATABASE_URL: 'postgres://u:p@h:5432' })).toMatch(/no dice la base de datos/);
  });

  it('valida el tamaño del pool y el esquema (nunca public ni los de Supabase)', () => {
    expect(resolve({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_POOL: '3' }).poolMax).toBe(3);
    for (const bad of ['0', '51', 'x', '2.5']) expect(fails({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_POOL: bad })).toMatch(/IARK_DATABASE_POOL/);
    expect(resolve({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_SCHEMA: 'mi_iark' }).schema).toBe('mi_iark');
    for (const bad of ['Iark', '1a', 'a-b', 'a"b', 'x'.repeat(41), 'pg_x']) expect(fails({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_SCHEMA: bad })).toMatch(/IARK_DATABASE_SCHEMA/);
    for (const reserved of ['public', 'auth', 'storage', 'graphql_public']) expect(fails({ IARK_DATABASE_URL: URL_REMOTE, IARK_DATABASE_SCHEMA: reserved })).toMatch(/sistema o de Supabase/);
  });
});
