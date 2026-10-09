import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VersionMeta, VersionPolicy } from '@iark/kernel';
import { createDefaultRegistry } from './registry';
import { createSuiteServer } from './serve';
import { createToken } from './tokens';
import { FolderProjectStore } from './workspace';
import { ANA, BETO, call, CARLA, cleanupCloud, signIn, startCloud, tracked, type Cloud } from '../../tests/helpers/cloud';

/**
 * El historial de versiones de un diagrama por HTTP (`/api/projects/<p>/diagrams/<d>/versions…`): el servidor es el de verdad (con un
 * espacio de trabajo en una carpeta temporal), con tokens y con sesiones de persona. Aquí se comprueban los roles, la identidad que queda en cada
 * versión y los abusos; el comportamiento del historial en sí lo cubre la suite de contrato de los almacenes.
 */

afterEach(cleanupCloud);

/** Sin coalescencia (cada guardado es una versión), 3 automáticas y 2 nombradas como máximo: lo justo para ver la rotación y el tope. */
const POLICY: Partial<VersionPolicy> = { coalesceSeconds: 0, keepAutomatic: 3, maxVersions: 5 };

const doc = (n: number): string => JSON.stringify({ revision: n });
const PATH = '/api/projects/tienda/diagrams/contexto';

/** Una petición con la ruta y las cabeceras exactas (`fetch` normaliza `..` y no deja cambiar `Host`). */
function raw(base: string, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Versioned extends Cloud {
  /** Tokens con nombre: `Ana` (admin), `Eva` (editor) y `Vic` (viewer). */
  tokens: { admin: string; file: string; editor: string; viewer: string };
}

/** El servicio con tokens y cuentas, y un almacén de carpeta con la política de pruebas (o sin historial con `policy: false`). */
async function start(policy: Partial<VersionPolicy> | false = POLICY): Promise<Versioned> {
  const dir = mkdtempSync(join(tmpdir(), 'iark-versiones-api-'));
  tracked.folders.push(dir);
  const root = join(dir, 'espacio');
  mkdirSync(root);
  const cloud = await startCloud({ tokens: true, signup: 'open', serve: { projects: new FolderProjectStore(root, { versions: policy }) } });
  const { file, admin } = cloud.tokens!;
  return {
    ...cloud,
    root,
    tokens: { admin, file, editor: createToken(file, { name: 'Eva', role: 'editor' }).token, viewer: createToken(file, { name: 'Vic', role: 'viewer' }).token },
  };
}

/** Crea el proyecto `tienda` con el diagrama `contexto` (revisión 1) y lo guarda `saves - 1` veces más (revisiones 2, 3…). */
async function seed(base: string, token: string, saves = 1): Promise<{ updatedAt: string }> {
  const api = call(base, token);
  expect((await api.post('/api/projects', { name: 'Tienda' })).status).toBe(201);
  expect((await api.post('/api/projects/tienda/diagrams', { module: 'c4', name: 'Contexto', text: doc(1) })).status).toBe(201);
  let updatedAt = '';
  for (let n = 2; n <= saves; n++) {
    const saved = await api.put(PATH, { text: doc(n) });
    expect(saved.status).toBe(200);
    updatedAt = (await saved.json()).updatedAt;
  }
  return { updatedAt: updatedAt || (await (await api.get(PATH)).json()).updatedAt };
}

const versions = async (base: string, token: string): Promise<VersionMeta[]> => {
  const res = await call(base, token).get(`${PATH}/versions`);
  expect(res.status).toBe(200);
  return res.json();
};

describe('versiones: leer el historial', () => {
  it('cada guardado deja una versión; la lista va de la más reciente a la más antigua, con tamaño y hash pero sin el documento', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 3);
    const list = await versions(base, tokens.viewer);
    expect(list.map((v) => v.id)).toEqual([3, 2, 1]);
    expect(list[0]).toMatchObject({ id: 3, savedBy: 'Eva', size: Buffer.byteLength(doc(3)) });
    expect(list[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(list[0].savedAt).toISOString()).toBe(list[0].savedAt);
    expect(JSON.stringify(list)).not.toContain('revision');
    expect((await call(base, tokens.viewer).get(`${PATH}/versions`)).headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('leer una versión devuelve su documento tal cual; una que no existe, 404 con su code', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 3);
    const one = await call(base, tokens.viewer).get(`${PATH}/versions/2`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id: 2, text: doc(2), savedBy: 'Eva' });
    const missing = await call(base, tokens.viewer).get(`${PATH}/versions/9`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'not-found' });
    for (const path of ['/api/projects/nada/diagrams/contexto/versions', '/api/projects/tienda/diagrams/nada/versions']) {
      const res = await call(base, tokens.viewer).get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not-found' });
    }
  });

  it('la rotación descarta la automática más vieja y leerla da 404; las nombradas se quedan', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 1);
    expect((await call(base, tokens.editor).patch(`${PATH}/versions/1`, { label: 'Primera entrega' })).status).toBe(200);
    for (let n = 2; n <= 8; n++) await call(base, tokens.editor).put(PATH, { text: doc(n) });
    const list = await versions(base, tokens.viewer);
    // 3 automáticas (las últimas) más la nombrada: nada más
    expect(list.map((v) => v.id)).toEqual([8, 7, 6, 1]);
    expect(list.at(-1)).toMatchObject({ id: 1, label: 'Primera entrega' });
    expect((await call(base, tokens.viewer).get(`${PATH}/versions/3`)).status).toBe(404);
    expect((await call(base, tokens.viewer).get(`${PATH}/versions/1`)).status).toBe(200);
  });

  it('borrar el diagrama borra su historial: uno nuevo con el mismo nombre empieza limpio', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 3);
    expect((await call(base, tokens.editor).del(PATH)).status).toBe(200);
    expect((await call(base, tokens.viewer).get(`${PATH}/versions`)).status).toBe(404);
    await call(base, tokens.editor).post('/api/projects/tienda/diagrams', { module: 'c4', name: 'Contexto', text: doc(77) });
    const list = await versions(base, tokens.viewer);
    expect(list).toHaveLength(1);
    expect((await (await call(base, tokens.viewer).get(`${PATH}/versions/${list[0].id}`)).json()).text).toBe(doc(77));
  });
});

describe('versiones: quién guarda', () => {
  it('la autoría sale de la identidad de la petición: el nombre del token. El cuerpo no la puede fijar, ni al guardar ni al restaurar', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.admin, 1);
    const forged = { by: 'Mallory', savedBy: 'Mallory', restoredFrom: 99, label: 'Mallory', id: 50 };
    expect((await call(base, tokens.editor).put(PATH, { text: doc(2), ...forged })).status).toBe(200);
    expect((await call(base, tokens.editor).post(`${PATH}/versions/1/restore`, forged)).status).toBe(200);
    const list = await versions(base, tokens.viewer);
    expect(list.map((v) => [v.id, v.savedBy])).toEqual([
      [3, 'Eva'],
      [2, 'Eva'],
      [1, 'servicio'],
    ]);
    expect(list.every((v) => v.label === undefined)).toBe(true);
    expect(list[0].restoredFrom).toBe(1);
    expect(list[1].restoredFrom).toBeUndefined();
  });

  it('sin autenticación no se sabe quién guarda y no se anota a nadie', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-versiones-anon-'));
    tracked.folders.push(dir);
    const server = createSuiteServer({ registry: createDefaultRegistry(), version: '1', projects: new FolderProjectStore(dir, { versions: POLICY }) });
    tracked.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await seed(base, '', 2);
    const list = await versions(base, '');
    expect(list.map((v) => v.id)).toEqual([2, 1]);
    expect(list.every((v) => v.savedBy === undefined)).toBe(true);
    // y los orígenes ajenos quedan fuera, también de la lectura del historial
    const evil = { Origin: 'https://evil.example' };
    expect((await call(base).get(`${PATH}/versions`, evil)).status).toBe(403);
    expect((await call(base).get(`${PATH}/versions/1`, evil)).status).toBe(403);
    expect((await call(base).post(`${PATH}/versions/1/restore`, {}, evil)).status).toBe(403);
    expect((await call(base).patch(`${PATH}/versions/1`, { label: 'x' })).status).toBe(200); // el propio sitio (sin Origin) sí
    expect((await fetch(`${base}${PATH}/versions/1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...evil }, body: JSON.stringify({ label: 'y' }) })).status).toBe(403);
    expect((await versions(base, '')).find((v) => v.id === 1)?.label).toBe('x');
    // el Host de un ataque de «DNS rebinding» tampoco
    expect((await raw(base, 'GET', `${PATH}/versions`, { Host: 'evil.example' })).status).toBe(403);
  });
});

describe('versiones: roles de los tokens', () => {
  it('viewer lista y lee; editor además restaura y nombra; borrar una nombrada exige admin', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 3);
    const viewer = call(base, tokens.viewer);
    const editor = call(base, tokens.editor);
    const admin = call(base, tokens.admin);

    // viewer: solo lectura
    expect((await viewer.get(`${PATH}/versions`)).status).toBe(200);
    expect((await viewer.get(`${PATH}/versions/2`)).status).toBe(200);
    for (const res of [await viewer.post(`${PATH}/versions/2/restore`, {}), await viewer.patch(`${PATH}/versions/2`, { label: 'Mía' }), await viewer.del(`${PATH}/versions/2`), await viewer.put(`${PATH}/versions/2`, {})]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden' });
    }
    expect(await versions(base, tokens.viewer)).toHaveLength(3); // y no pasó nada

    // editor: nombra y restaura
    const named = await editor.patch(`${PATH}/versions/2`, { label: 'Antes del cambio' });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ id: 2, label: 'Antes del cambio' });
    const restored = await editor.post(`${PATH}/versions/2/restore`, {});
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ unchanged: false, version: { id: 4, restoredFrom: 2, savedBy: 'Eva' }, diagram: { id: 'contexto' } });

    // borrar una nombrada: el editor no, el admin sí
    const denied = await editor.del(`${PATH}/versions/2`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'forbidden' });
    expect((await versions(base, tokens.viewer)).some((v) => v.id === 2)).toBe(true);
    const deleted = await admin.del(`${PATH}/versions/2`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: 2 });
    expect((await versions(base, tokens.viewer)).some((v) => v.id === 2)).toBe(false);
  });

  it('el rol se decide antes de mirar el recurso: un viewer recibe 403 aunque la versión, el diagrama o el proyecto no existan', async () => {
    const { base, tokens } = await start();
    const viewer = call(base, tokens.viewer);
    for (const path of ['/api/projects/nada/diagrams/nada/versions/9/restore', `${PATH}/versions/9/restore`]) expect((await viewer.post(path, {})).status, path).toBe(403);
    expect((await viewer.patch(`${PATH}/versions/9`, { label: 'x' })).status).toBe(403);
    // sin token, 401; un editor que no es admin, 403 al borrar
    expect((await call(base).get(`${PATH}/versions`)).status).toBe(401);
    expect((await call(base).post(`${PATH}/versions/1/restore`, {})).status).toBe(401);
    expect((await call(base, tokens.editor).del(`${PATH}/versions/9`)).status).toBe(403);
  });

  it('borrar una versión automática no se puede ni siendo admin (se descartan solas): 400 con code invalid', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 2);
    const res = await call(base, tokens.admin).del(`${PATH}/versions/1`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid' });
    expect(await versions(base, tokens.viewer)).toHaveLength(2);
    // y una que no existe, 404
    expect((await call(base, tokens.admin).del(`${PATH}/versions/9`)).status).toBe(404);
  });
});

describe('versiones: abusos', () => {
  it('un número de versión que no es un entero positivo corto se rechaza con 400 antes de tocar nada', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 2);
    const hostile = ['0', '-1', '1e3', '07', '1.5', '99999999999', 'abc', '1%2F2', '%00', '%20', '0x10', '+1'];
    for (const bad of hostile) {
      for (const [method, suffix, body] of [
        ['GET', '', undefined],
        ['PATCH', '', { label: 'x' }],
        ['DELETE', '', undefined],
        ['POST', '/restore', {}],
      ] as const) {
        const send = call(base, tokens.admin);
        const res = await (method === 'GET' ? send.get(`${PATH}/versions/${bad}${suffix}`) : method === 'PATCH' ? send.patch(`${PATH}/versions/${bad}${suffix}`, body) : method === 'DELETE' ? send.del(`${PATH}/versions/${bad}${suffix}`) : send.post(`${PATH}/versions/${bad}${suffix}`, body));
        expect(res.status, `${method} versions/${bad}${suffix}`).toBe(400);
        expect(await res.json(), `${method} versions/${bad}${suffix}`).toMatchObject({ code: 'invalid' });
      }
    }
    expect(await versions(base, tokens.viewer)).toHaveLength(2);
  });

  it('identificadores de proyecto y de diagrama hostiles: 400 (o 404 si el URL se normaliza), sin salirse de la carpeta de trabajo', async () => {
    const { base, root, tokens } = await start();
    await seed(base, tokens.editor, 2);
    const api = call(base, tokens.admin);
    for (const bad of ['a%2Fb', 'a%5Cb', '%00', 'con%20espacio', '.versiones', '.oculto', 'x'.repeat(200)]) {
      for (const path of [`/api/projects/${bad}/diagrams/contexto/versions`, `/api/projects/tienda/diagrams/${bad}/versions`, `/api/projects/tienda/diagrams/${bad}/versions/1`]) {
        const res = await api.get(path);
        expect(res.status, path).toBe(400);
      }
    }
    // con los puntos el servidor los normaliza y la ruta resultante no existe: nunca un 2xx
    for (const bad of ['..', '%2e%2e', '.%2e']) {
      for (const path of [`/api/projects/${bad}/diagrams/contexto/versions`, `/api/projects/tienda/diagrams/${bad}/versions/1`]) {
        const res = await raw(base, 'GET', path, { Authorization: `Bearer ${tokens.admin}` });
        expect(res.status, path).toBeGreaterThanOrEqual(400);
      }
    }
    expect(readdirSync(root).sort()).toEqual(['tienda']);
  });

  it('el nombre de una versión: obligatorio, texto, sin pasarse de largo; los espacios y los saltos de línea se limpian', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 2);
    const editor = call(base, tokens.editor);
    for (const body of [{}, { label: '' }, { label: '   ' }, { label: 7 }, { label: null }, { label: ['a'] }, { label: { a: 1 } }, { label: 'x'.repeat(500) }, { label: '\n\t' }]) {
      const res = await editor.patch(`${PATH}/versions/1`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const sloppy = await editor.patch(`${PATH}/versions/1`, { label: '  Entrega\n  del   viernes  ' });
    expect(sloppy.status).toBe(200);
    const label = (await sloppy.json()).label as string;
    expect(label).not.toMatch(/[\n\t]/);
    expect(label).toBe(label.trim());
    expect(label).toContain('Entrega');
    // el cuerpo tiene que ser un objeto JSON
    for (const raw of ['[]', '"hola"', '7', 'no es json', '']) expect((await editor.patch(`${PATH}/versions/1`, raw)).status, raw).toBe(400);
  });

  it('exige Content-Type JSON en lo que modifica (415), sea cual sea el rol; las lecturas no lo piden', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 2);
    const auth = { Authorization: `Bearer ${tokens.admin}` };
    for (const [method, path] of [
      ['PATCH', `${PATH}/versions/1`],
      ['POST', `${PATH}/versions/1/restore`],
      ['DELETE', `${PATH}/versions/1`],
    ] as const) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const res = await fetch(`${base}${path}`, { method, headers: { ...auth, 'Content-Type': type }, body: method === 'DELETE' ? undefined : '{"label":"x"}' });
        expect(res.status, `${method} ${path} ${type}`).toBe(415);
      }
    }
    expect((await fetch(`${base}${PATH}/versions`, { headers: auth })).status).toBe(200);
    expect(await versions(base, tokens.viewer)).toHaveLength(2);
  });

  it('otros métodos y rutas que no existen: 405 con Allow o 404, y un viewer nunca llega a probarlos', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 2);
    const admin = call(base, tokens.admin);
    for (const [res, allow] of [
      [await admin.post(`${PATH}/versions`, {}), 'GET'],
      [await admin.put(`${PATH}/versions`, {}), 'GET'],
      [await admin.del(`${PATH}/versions`), 'GET'],
      [await admin.put(`${PATH}/versions/1`, {}), 'GET, PATCH, DELETE'],
      [await admin.get(`${PATH}/versions/1/restore`), 'POST'],
      [await admin.put(`${PATH}/versions/1/restore`, {}), 'POST'],
    ] as const) {
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe(allow);
    }
    for (const path of [`${PATH}/versions/1/otra`, `${PATH}/versions/1/restore/mas`, `${PATH}/versions/1/restore/mas/aun`, `${PATH}/versiones`]) {
      const res = await admin.post(path, {});
      expect(res.status, path).toBe(404);
    }
    expect((await call(base, tokens.viewer).post(`${PATH}/versions/1/otra`, {})).status).toBe(403);
  });
});

describe('versiones: restaurar', () => {
  it('crea una versión NUEVA con el contenido antiguo y no toca ninguna de las anteriores', async () => {
    const { base, tokens } = await start({ coalesceSeconds: 0, keepAutomatic: 6, maxVersions: 8 });
    await seed(base, tokens.editor, 3);
    const before = await versions(base, tokens.viewer);
    const res = await call(base, tokens.editor).post(`${PATH}/versions/1/restore`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unchanged).toBe(false);
    expect(body.version).toMatchObject({ id: 4, restoredFrom: 1 });
    expect(body.diagram).toMatchObject({ id: 'contexto' });
    expect((await (await call(base, tokens.viewer).get(PATH)).json()).text).toBe(doc(1));
    const after = await versions(base, tokens.viewer);
    expect(after.map((v) => v.id)).toEqual([4, 3, 2, 1]);
    expect(after.slice(1)).toEqual(before); // las anteriores, idénticas
    // el hash de la nueva es el de la versión que se recuperó
    expect(after[0].hash).toBe(after[3].hash);
  });

  it('restaurar la versión que ya es el contenido actual no guarda nada y lo dice (`unchanged`)', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 3);
    const res = await call(base, tokens.editor).post(`${PATH}/versions/3/restore`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unchanged: true, version: { id: 3 } });
    expect(await versions(base, tokens.viewer)).toHaveLength(3);
  });

  it('respeta ifUpdatedAt: con la marca vieja, 409 con code conflict y el diagrama intacto; con la vigente, se restaura', async () => {
    const { base, tokens } = await start();
    const { updatedAt: stale } = await seed(base, tokens.editor, 1);
    // otra persona guarda en medio
    expect((await call(base, tokens.admin).put(PATH, { text: doc(2) })).status).toBe(200);
    const conflict = await call(base, tokens.editor).post(`${PATH}/versions/1/restore`, { ifUpdatedAt: stale });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'conflict' });
    expect((await (await call(base, tokens.viewer).get(PATH)).json()).text).toBe(doc(2));
    expect(await versions(base, tokens.viewer)).toHaveLength(2);

    const current = (await (await call(base, tokens.viewer).get(PATH)).json()).updatedAt as string;
    const ok = await call(base, tokens.editor).post(`${PATH}/versions/1/restore`, { ifUpdatedAt: current });
    expect(ok.status).toBe(200);
    expect((await (await call(base, tokens.viewer).get(PATH)).json()).text).toBe(doc(1));
    // una marca que no es un texto es un error de quien llama
    expect((await call(base, tokens.editor).post(`${PATH}/versions/1/restore`, { ifUpdatedAt: 5 })).status).toBe(400);
  });

  it('restaurar una versión que ya no existe (o nunca existió): 404 con code not-found', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 8);
    for (const n of [2, 99]) {
      const res = await call(base, tokens.editor).post(`${PATH}/versions/${n}/restore`, {});
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not-found' });
    }
  });

  it('restaurar no se funde con el guardado anterior aunque sea de la misma persona y esté dentro de la ventana de coalescencia', async () => {
    const { base, tokens } = await start({ coalesceSeconds: 600, keepAutomatic: 5, maxVersions: 8 });
    await seed(base, tokens.editor, 3); // crear y guardar dos veces seguidas: la misma persona, una sola versión
    const [base1, ...none] = await versions(base, tokens.viewer);
    expect(none).toEqual([]);
    await call(base, tokens.editor).patch(`${PATH}/versions/${base1.id}`, { label: 'Base' }); // una nombrada nunca se sustituye
    expect((await call(base, tokens.editor).put(PATH, { text: doc(4) })).status).toBe(200);
    expect((await call(base, tokens.editor).put(PATH, { text: doc(5) })).status).toBe(200); // estos dos sí se funden
    expect(await versions(base, tokens.viewer)).toHaveLength(2);
    const restored = await call(base, tokens.editor).post(`${PATH}/versions/${base1.id}/restore`, {});
    expect((await restored.json()).unchanged).toBe(false);
    const list = await versions(base, tokens.viewer);
    expect(list).toHaveLength(3); // la restauración no sustituyó el guardado de antes
    expect(list[0].restoredFrom).toBe(base1.id);
    expect(list[1].restoredFrom).toBeUndefined();
    expect(list[2]).toMatchObject({ id: base1.id, label: 'Base' });
  });
});

describe('versiones: nombrar y su tope', () => {
  it('nombrar es idempotente y se puede renombrar; con el tope de nombradas lleno, 409 con code limit, y borrar una deja sitio', async () => {
    const { base, tokens } = await start();
    await seed(base, tokens.editor, 3);
    const editor = call(base, tokens.editor);
    expect((await editor.patch(`${PATH}/versions/1`, { label: 'Uno' })).status).toBe(200);
    expect((await editor.patch(`${PATH}/versions/1`, { label: 'Uno' })).status).toBe(200);
    expect((await (await editor.patch(`${PATH}/versions/1`, { label: 'Uno bis' })).json()).label).toBe('Uno bis');
    expect((await editor.patch(`${PATH}/versions/2`, { label: 'Dos' })).status).toBe(200);
    const over = await editor.patch(`${PATH}/versions/3`, { label: 'Tres' });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: 'limit' });
    // renombrar una que ya tiene nombre sigue valiendo con el tope lleno
    expect((await editor.patch(`${PATH}/versions/2`, { label: 'Dos bis' })).status).toBe(200);
    expect((await call(base, tokens.admin).del(`${PATH}/versions/1`)).status).toBe(200);
    expect((await editor.patch(`${PATH}/versions/3`, { label: 'Tres' })).status).toBe(200);
  });
});

describe('versiones: un servicio cuyo almacén no guarda historial', () => {
  it('lo dice con 501 y code unsupported en cada ruta de versiones, y guardar diagramas sigue funcionando', async () => {
    const { base, root, tokens } = await start(false);
    await seed(base, tokens.editor, 3);
    expect((await (await call(base, tokens.viewer).get(PATH)).json()).text).toBe(doc(3));
    for (const res of [
      await call(base, tokens.viewer).get(`${PATH}/versions`),
      await call(base, tokens.viewer).get(`${PATH}/versions/1`),
      await call(base, tokens.editor).post(`${PATH}/versions/1/restore`, {}),
      await call(base, tokens.editor).patch(`${PATH}/versions/1`, { label: 'x' }),
      await call(base, tokens.admin).del(`${PATH}/versions/1`),
    ]) {
      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({ code: 'unsupported' });
    }
    // y no deja carpetas de historial en el disco
    expect(readdirSync(join(root, 'tienda'), { recursive: true }).map(String).some((f) => f.includes('.versiones'))).toBe(false);
  });
});

describe('versiones: sesiones de persona (iark serve --accounts)', () => {
  /** Beto crea «Tienda» (es su administrador); Carla es viewer, Dani editor y Ana administra la instancia. Eva no pertenece. */
  async function team() {
    const cloud = await start();
    const beto = await signIn(cloud, BETO);
    const carla = await signIn(cloud, CARLA);
    const ana = await signIn(cloud, ANA);
    const dani = await signIn(cloud, { id: 404, login: 'dani' });
    const eva = await signIn(cloud, { id: 505, login: 'eva' });
    await seed(cloud.base, beto, 3);
    await call(cloud.base, beto).put('/api/projects/tienda/members/carla', { role: 'viewer' });
    await call(cloud.base, beto).put('/api/projects/tienda/members/dani', { role: 'editor' });
    return { cloud, beto, carla, ana, dani, eva };
  }

  it('cada rol del proyecto hace lo suyo: viewer lee, editor restaura y nombra, admin del proyecto o de la instancia borra nombradas', async () => {
    const { cloud, carla, dani, beto, ana } = await team();
    const { base } = cloud;
    expect((await versions(base, carla)).map((v) => v.id)).toEqual([3, 2, 1]);
    expect((await call(base, carla).get(`${PATH}/versions/1`)).status).toBe(200);
    for (const res of [await call(base, carla).post(`${PATH}/versions/1/restore`, {}), await call(base, carla).patch(`${PATH}/versions/1`, { label: 'x' }), await call(base, carla).del(`${PATH}/versions/1`)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden' });
    }

    expect((await call(base, dani).patch(`${PATH}/versions/1`, { label: 'Punto de partida' })).status).toBe(200);
    expect((await call(base, dani).post(`${PATH}/versions/1/restore`, {})).status).toBe(200);
    const denied = await call(base, dani).del(`${PATH}/versions/1`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'forbidden' });

    expect((await call(base, beto).del(`${PATH}/versions/1`)).status).toBe(200);
    expect((await call(base, dani).patch(`${PATH}/versions/2`, { label: 'Otra' })).status).toBe(200);
    expect((await call(base, ana).del(`${PATH}/versions/2`)).status).toBe(200); // administra la instancia, sin ser miembro
  });

  it('quién no pertenece al proyecto recibe 404 en todo, como si no existiera, y quien pertenece pero no tiene rol suficiente, 403', async () => {
    const { cloud, eva, carla } = await team();
    const { base } = cloud;
    for (const [method, suffix, body] of [
      ['GET', '/versions', undefined],
      ['GET', '/versions/1', undefined],
      ['POST', '/versions/1/restore', {}],
      ['PATCH', '/versions/1', { label: 'x' }],
      ['DELETE', '/versions/1', undefined],
    ] as const) {
      const send = call(base, eva);
      const res = await (method === 'GET' ? send.get(`${PATH}${suffix}`) : method === 'POST' ? send.post(`${PATH}${suffix}`, body) : method === 'PATCH' ? send.patch(`${PATH}${suffix}`, body) : send.del(`${PATH}${suffix}`));
      expect(res.status, `${method} ${suffix}`).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not-found' });
    }
    // ni siquiera sabe si la versión existe: lo mismo para una que no
    expect((await call(base, eva).get(`${PATH}/versions/99`)).status).toBe(404);
    expect(await versions(base, carla)).toHaveLength(3); // y no se tocó nada
  });

  it('la autoría es `@usuario` de la sesión; sin sesión (ni token) no se entra', async () => {
    const { cloud, beto, dani } = await team();
    const { base } = cloud;
    await call(base, dani).put(PATH, { text: doc(4), by: 'Mallory', savedBy: 'Mallory' });
    expect((await call(base, dani).post(`${PATH}/versions/2/restore`, { by: 'Mallory' })).status).toBe(200); // la 1 ya rotó
    const list = await versions(base, beto);
    expect(list.map((v) => v.savedBy)).toEqual(['@dani', '@dani', '@beto']); // las tres automáticas que conserva la política de las pruebas
    expect((await call(base).get(`${PATH}/versions`)).status).toBe(401);
    expect((await call(base, 'iark_noexiste').get(`${PATH}/versions`)).status).toBe(401);
  });
});
