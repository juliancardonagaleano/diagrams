import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createToken, generateToken, hashToken, isTokenRole, listTokens, parseRole, parseTokenFile, revokeToken, roleAllows, TOKEN_ROLES, TokenError, TokenStore, type TokenRole } from './tokens';

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Una carpeta nueva y la ruta de un archivo de tokens (que aún no existe) dentro de ella. */
function tokensPath(name = 'tokens.json'): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'iark-tokens-'));
  folders.push(dir);
  return { dir, file: join(dir, name) };
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const code = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    if (error instanceof TokenError) return error.code;
    throw error;
  }
  return undefined;
};

describe('tokens: generar y calcular el hash', () => {
  it('un token es `iark_` y 32 bytes aleatorios en base64url, y no se repite', () => {
    const token = generateToken();
    expect(token).toMatch(/^iark_[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 caracteres base64url sin relleno
    expect(Buffer.from(token.slice(5), 'base64url')).toHaveLength(32);
    expect(new Set(Array.from({ length: 200 }, generateToken)).size).toBe(200);
  });

  it('el hash es el sha256 del token en hexadecimal', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashToken('iark_x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('iark_x')).not.toBe(hashToken('iark_y'));
  });
});

describe('tokens: roles', () => {
  it('cada rol incluye los de abajo: viewer < editor < admin', () => {
    const expected: Record<TokenRole, Record<TokenRole, boolean>> = {
      viewer: { viewer: true, editor: false, admin: false },
      editor: { viewer: true, editor: true, admin: false },
      admin: { viewer: true, editor: true, admin: true },
    };
    for (const role of TOKEN_ROLES) for (const needed of TOKEN_ROLES) expect(roleAllows(role, needed), `${role} → ${needed}`).toBe(expected[role][needed]);
  });

  it('el rol se acepta sin distinguir mayúsculas ni espacios y solo admite los tres conocidos', () => {
    expect(parseRole(' Editor ')).toBe('editor');
    expect(parseRole('ADMIN')).toBe('admin');
    for (const bad of ['', 'root', 'owner', 'viewer,admin', undefined, 3, null]) expect(code(() => parseRole(bad))).toBe('invalid');
    expect(() => parseRole('root')).toThrow(/viewer, editor o admin/);
    expect(isTokenRole('admin')).toBe(true);
    expect(isTokenRole('Admin')).toBe(false);
  });
});

describe('tokens: crear, listar y revocar', () => {
  it('guarda solo el hash (nunca el token), con la forma documentada, y crea el archivo con modo 0600', () => {
    const { file } = tokensPath();
    const now = new Date('2026-10-03T12:34:56.789Z');
    const { token, record } = createToken(file, { name: 'Ana', role: 'editor' }, now);
    expect(token).toMatch(/^iark_[A-Za-z0-9_-]{43}$/);
    expect(record).toEqual({ name: 'Ana', role: 'editor', createdAt: '2026-10-03T12:34:56.789Z' });
    expect(record).not.toHaveProperty('hash');

    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(5));
    expect(JSON.parse(text)).toEqual({ version: 1, tokens: [{ name: 'Ana', role: 'editor', hash: hashToken(token), createdAt: '2026-10-03T12:34:56.789Z' }] });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    createToken(file, { name: 'Luis', role: 'viewer' });
    expect(read(file).tokens.map((t: { name: string }) => t.name)).toEqual(['Ana', 'Luis']);
  });

  it('el nombre es único sin distinguir mayúsculas ni la forma Unicode de las tildes', () => {
    const { file } = tokensPath();
    createToken(file, { name: 'Ana García', role: 'viewer' });
    for (const repeated of ['ana garcía', 'ANA GARCÍA', '  Ana   García  ', 'Ana García' /* i + tilde combinada */]) {
      expect(code(() => createToken(file, { name: repeated, role: 'admin' })), repeated).toBe('exists');
    }
    expect(() => createToken(file, { name: 'ana garcía', role: 'admin' })).toThrow(/Ya existe un token llamado «ana garcía»/);
    expect(listTokens(file)).toHaveLength(1);
    createToken(file, { name: 'Ana García López', role: 'viewer' }); // otro nombre
    expect(listTokens(file)).toHaveLength(2);
  });

  it('rechaza un nombre vacío, largo o con caracteres de control, y un rol inválido, sin crear el archivo', () => {
    const { file, dir } = tokensPath();
    expect(code(() => createToken(file, { name: '   ', role: 'viewer' }))).toBe('invalid');
    expect(code(() => createToken(file, { name: 'x'.repeat(121), role: 'viewer' }))).toBe('invalid');
    expect(code(() => createToken(file, { name: 'Ana', role: 'superusuario' }))).toBe('invalid');
    expect(code(() => createToken(file, { name: undefined as unknown as string, role: 'viewer' }))).toBe('invalid');
    expect(readdirSync(dir)).toEqual([]);
    // los caracteres de control se limpian como en los nombres de proyecto
    expect(createToken(file, { name: 'Ana\n\tPérez', role: 'viewer' }).record.name).toBe('Ana Pérez');
  });

  it('la escritura es atómica: no deja temporales, reemplaza el archivo entero y devuelve el modo a 0600', () => {
    const { file, dir } = tokensPath();
    createToken(file, { name: 'Ana', role: 'admin' });
    if (process.platform !== 'win32') chmodSync(file, 0o644); // alguien lo abrió demasiado
    createToken(file, { name: 'Luis', role: 'viewer' });
    revokeToken(file, 'Luis');
    expect(readdirSync(dir)).toEqual(['tokens.json']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    // crea las carpetas que falten
    const nested = join(dir, 'a', 'b', 'tokens.json');
    createToken(nested, { name: 'Ana', role: 'admin' });
    expect(listTokens(nested).map((t) => t.name)).toEqual(['Ana']);
  });

  it('un fallo al escribir no deja el archivo a medias ni temporales', () => {
    const { file, dir } = tokensPath();
    createToken(file, { name: 'Ana', role: 'admin' });
    const before = readFileSync(file, 'utf8');
    // un archivo donde debería haber una carpeta: no se puede crear el temporal
    writeFileSync(join(dir, 'archivo'), 'x');
    expect(code(() => createToken(join(dir, 'archivo', 'tokens.json'), { name: 'Luis', role: 'viewer' }))).toBe('unavailable');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(['archivo', 'tokens.json']);
  });

  it('list enseña nombre, rol y fecha, nunca el hash; sin archivo es not-found', () => {
    const { file } = tokensPath();
    expect(code(() => listTokens(file))).toBe('not-found');
    expect(() => listTokens(file)).toThrow(/iark auth create/);
    const { token } = createToken(file, { name: 'Ana', role: 'editor' }, new Date('2026-01-02T03:04:05.000Z'));
    const listed = listTokens(file);
    expect(listed).toEqual([{ name: 'Ana', role: 'editor', createdAt: '2026-01-02T03:04:05.000Z' }]);
    expect(JSON.stringify(listed)).not.toContain(hashToken(token).slice(0, 8));
  });

  it('revoke quita el token por su nombre (sin distinguir mayúsculas) y deja los demás', () => {
    const { file } = tokensPath();
    createToken(file, { name: 'Ana', role: 'admin' });
    const { token: lucia } = createToken(file, { name: 'Lucía', role: 'viewer' });
    createToken(file, { name: 'Luis', role: 'editor' });
    expect(revokeToken(file, 'LUCÍA')).toEqual({ name: 'Lucía', role: 'viewer', createdAt: expect.any(String) });
    expect(listTokens(file).map((t) => t.name)).toEqual(['Ana', 'Luis']);
    expect(readFileSync(file, 'utf8')).not.toContain(hashToken(lucia));
    expect(code(() => revokeToken(file, 'Lucía'))).toBe('not-found');
    expect(() => revokeToken(file, 'Nadie')).toThrow(/No existe ningún token llamado «Nadie»/);
    expect(code(() => revokeToken(tokensPath().file, 'Ana'))).toBe('not-found'); // sin archivo
    expect(listTokens(file)).toHaveLength(2);
  });
});

describe('tokens: un archivo dañado se rechaza entero y nunca se reemplaza', () => {
  const ok = { name: 'Ana', role: 'admin', hash: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' };
  const damaged: Array<[string, string]> = [
    ['no es JSON', '{ roto'],
    ['vacío', ''],
    ['raíz que no es un objeto', '[]'],
    ['sin versión', JSON.stringify({ tokens: [] })],
    ['versión desconocida', JSON.stringify({ version: 2, tokens: [] })],
    ['sin lista de tokens', JSON.stringify({ version: 1 })],
    ['tokens que no es una lista', JSON.stringify({ version: 1, tokens: {} })],
    ['una entrada que no es un objeto', JSON.stringify({ version: 1, tokens: ['x'] })],
    ['sin nombre', JSON.stringify({ version: 1, tokens: [{ ...ok, name: '' }] })],
    ['rol desconocido', JSON.stringify({ version: 1, tokens: [{ ...ok, role: 'root' }] })],
    ['hash corto', JSON.stringify({ version: 1, tokens: [{ ...ok, hash: 'abc' }] })],
    ['hash que no es hexadecimal', JSON.stringify({ version: 1, tokens: [{ ...ok, hash: 'z'.repeat(64) }] })],
    ['fecha inválida', JSON.stringify({ version: 1, tokens: [{ ...ok, createdAt: 'ayer' }] })],
    ['nombre repetido (sin distinguir mayúsculas)', JSON.stringify({ version: 1, tokens: [ok, { ...ok, name: 'ANA', hash: 'b'.repeat(64) }] })],
    ['hash repetido', JSON.stringify({ version: 1, tokens: [ok, { ...ok, name: 'Luis' }] })],
  ];

  it.each(damaged)('%s', (_label, content) => {
    expect(code(() => parseTokenFile(content))).toBe('corrupt');
    const { file } = tokensPath();
    writeFileSync(file, content);
    for (const action of [() => createToken(file, { name: 'Nuevo', role: 'viewer' }), () => listTokens(file), () => revokeToken(file, 'Ana'), () => TokenStore.open(file)]) {
      expect(code(action)).toBe('corrupt');
    }
    expect(readFileSync(file, 'utf8')).toBe(content); // ni se arregló ni se sobrescribió
  });

  it('los motivos no citan el contenido del archivo', () => {
    const secret = 'iark_SECRETO-QUE-NO-DEBE-SALIR';
    for (const content of [`{ ${secret}`, JSON.stringify({ version: 1, tokens: [{ ...ok, name: secret, role: secret }] }), JSON.stringify({ version: 1, tokens: [{ ...ok, hash: secret }] })]) {
      try {
        parseTokenFile(content);
        throw new Error('debía fallar');
      } catch (error) {
        expect((error as Error).message).not.toContain('SECRETO');
      }
    }
  });

  it('acepta el hash en mayúsculas (lo normaliza) y descarta los campos desconocidos', () => {
    const parsed = parseTokenFile(JSON.stringify({ version: 1, extra: 1, tokens: [{ ...ok, hash: 'AB'.repeat(32), otro: true }] }));
    expect(parsed).toEqual({ version: 1, tokens: [{ ...ok, hash: 'ab'.repeat(32) }] });
  });

  it('un archivo que es una carpeta o pasa del tamaño máximo no se usa', () => {
    const { dir, file } = tokensPath();
    mkdirSync(file);
    expect(code(() => TokenStore.open(file))).toBe('unavailable');
    expect(() => TokenStore.open(file)).toThrow(/no es un archivo/);
    const big = join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(5 * 1024 * 1024));
    expect(code(() => TokenStore.open(big))).toBe('corrupt');
  });
});

describe('TokenStore: lo que lee el servidor', () => {
  const logs = (): { lines: string[]; log: (m: string) => void } => {
    const lines: string[] = [];
    return { lines, log: (m) => void lines.push(m) };
  };

  it('reconoce cada token por su dueño y rol; lo demás es desconocido', () => {
    const { file } = tokensPath();
    const ana = createToken(file, { name: 'Ana', role: 'admin' }).token;
    const luis = createToken(file, { name: 'Luis', role: 'viewer' }).token;
    const store = TokenStore.open(file, logs().log);
    expect(store.size).toBe(2);
    expect(store.problem).toBeUndefined();
    expect(store.lookup(ana)).toEqual({ status: 'ok', name: 'Ana', role: 'admin' });
    expect(store.lookup(luis)).toEqual({ status: 'ok', name: 'Luis', role: 'viewer' });
    for (const other of [generateToken(), '', 'iark_', ana.slice(0, -1), `${ana} `, ana.toUpperCase(), hashToken(ana), 'x'.repeat(100_000)]) {
      expect(store.lookup(other), other.slice(0, 20)).toEqual({ status: 'unknown' });
    }
    expect(store.lookup(undefined)).toEqual({ status: 'unknown' });
  });

  it('crear y revocar surten efecto al instante, sin reiniciar', () => {
    const { file } = tokensPath();
    const ana = createToken(file, { name: 'Ana', role: 'admin' }).token;
    const { lines, log } = logs();
    const store = TokenStore.open(file, log);
    const luis = createToken(file, { name: 'Luis', role: 'editor' }).token; // creado con el servidor ya en marcha
    expect(store.lookup(luis)).toEqual({ status: 'ok', name: 'Luis', role: 'editor' });
    revokeToken(file, 'Luis');
    expect(store.lookup(luis)).toEqual({ status: 'unknown' });
    expect(store.lookup(ana).status).toBe('ok');
    revokeToken(file, 'Ana'); // sin ningún token: todo es desconocido, pero el archivo sigue siendo válido
    expect(store.lookup(ana)).toEqual({ status: 'unknown' });
    expect(store.problem).toBeUndefined();
    expect(store.size).toBe(0);
    expect(lines).toEqual(['archivo de tokens recargado: 2 token(s).', 'archivo de tokens recargado: 1 token(s).', 'archivo de tokens recargado: 0 token(s).']);
  });

  it('un cambio del archivo se nota por su fecha aunque el tamaño y el inodo no cambien', () => {
    const { file } = tokensPath();
    const ana = generateToken();
    const eva = generateToken();
    const body = (token: string, name: string) => JSON.stringify({ version: 1, tokens: [{ name, role: 'viewer', hash: hashToken(token), createdAt: '2026-01-01T00:00:00.000Z' }] });
    writeFileSync(file, body(ana, 'Ana'));
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    const store = TokenStore.open(file, logs().log);
    expect(store.lookup(ana).status).toBe('ok');
    writeFileSync(file, body(eva, 'Eva')); // en el sitio: mismo inodo y mismo tamaño
    utimesSync(file, new Date(2_000_000), new Date(2_000_000));
    expect(store.lookup(ana)).toEqual({ status: 'unknown' });
    expect(store.lookup(eva)).toEqual({ status: 'ok', name: 'Eva', role: 'viewer' });
  });

  it('un archivo que se daña con el servidor en marcha cierra el acceso (incluso a los tokens que valían) y se recupera al arreglarlo', () => {
    const { file } = tokensPath();
    const ana = createToken(file, { name: 'Ana', role: 'admin' }).token;
    const saved = readFileSync(file, 'utf8');
    const { lines, log } = logs();
    const store = TokenStore.open(file, log);
    expect(store.lookup(ana).status).toBe('ok');

    for (const content of ['{ roto', '', '[]', JSON.stringify({ version: 9, tokens: [] })]) {
      writeFileSync(file, content);
      utimesSync(file, new Date(), new Date(Date.now() + 5000 * (1 + lines.length))); // una fecha distinta cada vez
      expect(store.lookup(ana), content).toEqual({ status: 'unavailable' });
      expect(store.lookup(undefined)).toEqual({ status: 'unavailable' });
      expect(store.size).toBe(0);
      expect(store.problem).toMatch(/no es válido/);
    }
    // el motivo se anota una vez por cada estado distinto, no una por petición
    const errors = lines.filter((l) => l.startsWith('error:'));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(new Set(errors).size).toBe(errors.length);
    for (let i = 0; i < 5; i++) store.lookup(ana);
    expect(lines.filter((l) => l.startsWith('error:'))).toHaveLength(errors.length);

    writeFileSync(file, saved);
    utimesSync(file, new Date(), new Date(Date.now() + 999_000));
    expect(store.lookup(ana)).toEqual({ status: 'ok', name: 'Ana', role: 'admin' });
    expect(store.problem).toBeUndefined();
    expect(lines[lines.length - 1]).toBe('archivo de tokens recargado: 1 token(s) (vuelve a haber acceso).');
  });

  it('un archivo que desaparece o deja de poder leerse cierra el acceso, y vuelve cuando reaparece', () => {
    const { file } = tokensPath();
    const ana = createToken(file, { name: 'Ana', role: 'admin' }).token;
    const saved = readFileSync(file, 'utf8');
    const store = TokenStore.open(file, logs().log);
    rmSync(file);
    expect(store.lookup(ana)).toEqual({ status: 'unavailable' });
    expect(store.problem).toMatch(/No existe el archivo de tokens/);
    mkdirSync(file); // ahora es una carpeta
    expect(store.lookup(ana)).toEqual({ status: 'unavailable' });
    rmSync(file, { recursive: true });
    writeFileSync(file, saved);
    expect(store.lookup(ana).status).toBe('ok');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      expect(store.lookup(ana)).toEqual({ status: 'unavailable' });
      chmodSync(file, 0o600);
      expect(store.lookup(ana).status).toBe('ok');
    }
  });

  it('al arrancar sí falla si el archivo no existe, para que una errata no deje un servidor que rechaza a todos', () => {
    const { file } = tokensPath();
    expect(code(() => TokenStore.open(file))).toBe('not-found');
    expect(() => TokenStore.open(file)).toThrow(/iark auth create/);
  });

  it('lo que anota en el registro nunca incluye tokens, hashes ni el contenido del archivo', () => {
    const { file } = tokensPath();
    const ana = createToken(file, { name: 'Ana', role: 'admin' }).token;
    const { lines, log } = logs();
    const store = TokenStore.open(file, log);
    const hash = hashToken(ana);
    writeFileSync(file, `{ ${ana} ${hash}`);
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    store.lookup(ana);
    rmSync(file);
    store.lookup(ana);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(ana);
      expect(line).not.toContain(hash);
      expect(line).not.toContain(ana.slice(5));
    }
  });
});
