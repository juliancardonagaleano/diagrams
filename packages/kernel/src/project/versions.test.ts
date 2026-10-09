import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectVersionsContract } from '../../../../tests/helpers/projectVersionsContract';
import {
  applyPlan,
  cleanBy,
  DEFAULT_VERSION_POLICY,
  describeContent,
  isVersioned,
  MemoryProjectStore,
  parseVersionId,
  planDelete,
  planLabel,
  planSave,
  ProjectError,
  resolveVersionPolicy,
  sha256Hex,
  versionUsageOf,
  type VersionMeta,
  type VersionPolicy,
} from './index';

projectVersionsContract('memoria', async ({ policy, clock }) => ({ store: new MemoryProjectStore(() => clock.now(), { versions: policy }) }));

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('sha256Hex', () => {
  it('coincide con los vectores conocidos', () => {
    expect(sha256Hex(encode(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('coincide con node:crypto en todos los tamaños que cruzan un bloque de 64 bytes, y con datos aleatorios y Unicode', () => {
    for (let length = 0; length <= 200; length++) {
      const bytes = randomBytes(length);
      expect(sha256Hex(bytes), `longitud ${length}`).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    const text = '{"nombre":"Gestión ✓ 日本 𝄞"}\r\n'.repeat(500);
    expect(describeContent(text).hash).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(describeContent(text).size).toBe(Buffer.byteLength(text, 'utf8'));
  });
});

describe('política de retención', () => {
  it('tiene valores por omisión sensatos y deja sitio a las versiones con nombre', () => {
    expect(resolveVersionPolicy()).toEqual(DEFAULT_VERSION_POLICY);
    expect(DEFAULT_VERSION_POLICY).toMatchObject({ coalesceSeconds: 30, keepAutomatic: 50, maxVersions: 150 });
    expect(resolveVersionPolicy({ keepAutomatic: 5 })).toEqual({ coalesceSeconds: 30, keepAutomatic: 5, maxVersions: 150 });
  });

  it('rechaza (no ajusta en silencio) lo que no es un entero dentro de las cotas', () => {
    const bad: Array<Partial<VersionPolicy>> = [
      { coalesceSeconds: -1 },
      { coalesceSeconds: 1.5 },
      { coalesceSeconds: 99999 },
      { keepAutomatic: 0 },
      { keepAutomatic: 5000 },
      { keepAutomatic: 10, maxVersions: 10 }, // no quedaría sitio para ninguna nombrada
      { maxVersions: 1_000_000 },
      { keepAutomatic: Number.NaN },
      { keepAutomatic: '5' as unknown as number },
    ];
    for (const policy of bad) expect(() => resolveVersionPolicy(policy), JSON.stringify(policy)).toThrow(ProjectError);
  });
});

describe('parseVersionId y cleanBy', () => {
  it('solo acepta enteros positivos cortos, sin ceros a la izquierda ni formas raras', () => {
    expect(parseVersionId('7')).toBe(7);
    expect(parseVersionId(7)).toBe(7);
    expect(parseVersionId('123456789')).toBe(123456789);
    for (const bad of ['0', '07', '-1', '1.5', '1e3', ' 1', '1 ', '', 'abc', '١٢', '1234567890', '../1', '%31', null, undefined, {}, [], Number.NaN, 0, -3, 2 ** 53]) {
      expect(parseVersionId(bad), String(bad)).toBeUndefined();
    }
  });

  it('cleanBy quita caracteres de control, colapsa espacios, acota y devuelve undefined si no queda nada', () => {
    expect(cleanBy('  @ana\n')).toBe('@ana');
    expect(cleanBy('a\u0000b\u0007c')).toBe('a b c');
    expect(cleanBy('x'.repeat(500))?.length).toBe(120);
    expect(cleanBy('\u0000 \t')).toBeUndefined();
    expect(cleanBy(42)).toBeUndefined();
    expect(cleanBy(undefined)).toBeUndefined();
  });
});

describe('planSave', () => {
  const policy: VersionPolicy = { coalesceSeconds: 30, keepAutomatic: 3, maxVersions: 5 };
  const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const facts = (name: string) => describeContent(name);
  const meta = (id: number, seconds: number, extra: Partial<VersionMeta> = {}): VersionMeta => ({ id, savedAt: at(seconds), ...facts(`v${id}`), ...extra });

  it('sin historial crea la versión 1', () => {
    const plan = planSave({ existing: [], lastId: 0, next: { savedAt: at(0), ...facts('a') }, policy, coalesce: true });
    expect(plan).toMatchObject({ drop: [], lastId: 1, unchanged: false });
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0]).toMatchObject({ id: 1, from: 'next', hash: facts('a').hash });
  });

  it('el mismo contenido que la última versión no crea otra', () => {
    const existing = [meta(1, 0)];
    const plan = planSave({ existing, lastId: 1, next: { savedAt: at(100), ...facts('v1') }, policy, coalesce: true });
    expect(plan).toMatchObject({ add: [], drop: [], unchanged: true });
  });

  it('línea base: el contenido previo que no está en el historial se registra antes de guardar el nuevo, y nunca se sustituye', () => {
    // sin historial (un diagrama anterior a esta función) o editado fuera de DIAgrams: la última versión no es el contenido previo
    const plan = planSave({ existing: [meta(1, 0)], lastId: 1, previous: { ...facts('editado a mano'), at: at(5) }, next: { savedAt: at(6), ...facts('nuevo') }, policy, coalesce: true });
    expect(plan.add.map((v) => [v.id, v.from, v.hash])).toEqual([
      [2, 'previous', facts('editado a mano').hash],
      [3, 'next', facts('nuevo').hash],
    ]);
    expect(plan.drop).toEqual([]); // aunque pasen 6 s (< 30 s), la línea base no se sustituye
    expect(plan.add[0].savedAt < plan.add[1].savedAt).toBe(true);
  });

  it('línea base sin cambio: guardar lo mismo que ya había solo deja registrado lo previo', () => {
    const plan = planSave({ existing: [], lastId: 0, previous: { ...facts('igual'), at: at(0) }, next: { savedAt: at(1), ...facts('igual') }, policy, coalesce: true });
    expect(plan.unchanged).toBe(true);
    expect(plan.add.map((v) => [v.id, v.from])).toEqual([[1, 'previous']]);
  });

  it('con la línea base ya registrada (la última versión es el contenido previo) no se añade otra', () => {
    const existing = [meta(1, 0)];
    const plan = planSave({ existing, lastId: 1, previous: { ...facts('v1'), at: at(0) }, next: { savedAt: at(100), ...facts('nuevo') }, policy, coalesce: true });
    expect(plan.add.map((v) => [v.id, v.from])).toEqual([[2, 'next']]);
  });

  it('con `headHash`, borrar la última versión no la resucita como línea base ni se sustituye otra en su lugar', () => {
    const existing = [meta(1, 0)]; // la versión 2 (el contenido actual, «v2») se borró a mano
    const common = { existing, lastId: 2, headHash: facts('v2').hash, previous: { ...facts('v2'), at: at(5) }, policy, coalesce: true };
    const plan = planSave({ ...common, next: { savedAt: at(6), ...facts('nuevo') } });
    expect(plan.add.map((v) => [v.id, v.from])).toEqual([[3, 'next']]);
    expect(plan.drop).toEqual([]); // la versión 1 ya no es el contenido actual: no se sustituye
    expect(planSave({ ...common, next: { savedAt: at(6), ...facts('v2') } })).toMatchObject({ unchanged: true, add: [] });
  });

  it('coalescencia: misma persona, versión automática y dentro de la ventana la sustituye, con id nuevo y la fecha del primer guardado', () => {
    const existing = [meta(1, 0), meta(2, 100, { savedBy: '@ana' })];
    const plan = planSave({ existing, lastId: 2, next: { savedAt: at(110), savedBy: '@ana', ...facts('nuevo') }, policy, coalesce: true });
    expect(plan.drop).toEqual([2]);
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0]).toMatchObject({ id: 3, savedAt: at(100), savedBy: '@ana' });
  });

  it('coalescencia: no sustituye con otra persona, con nombre, tras restaurar, fuera de la ventana, con la ventana en 0 ni si se pide no coalescer', () => {
    const base = { lastId: 2, next: { savedAt: at(110), savedBy: '@ana', ...facts('nuevo') }, policy, coalesce: true };
    const last = (extra: Partial<VersionMeta>): VersionMeta[] => [meta(1, 0), meta(2, 100, { savedBy: '@ana', ...extra })];
    expect(planSave({ ...base, existing: last({ savedBy: '@beto' }) }).drop).toEqual([]);
    expect(planSave({ ...base, existing: last({ label: 'Entrega' }) }).drop).toEqual([]);
    expect(planSave({ ...base, existing: last({ restoredFrom: 1 }) }).drop).toEqual([]);
    expect(planSave({ ...base, existing: last({}), next: { ...base.next, savedAt: at(130) } }).drop).toEqual([]); // justo 30 s: ya no
    expect(planSave({ ...base, existing: last({}), policy: { ...policy, coalesceSeconds: 0 } }).drop).toEqual([]);
    expect(planSave({ ...base, existing: last({}), coalesce: false }).drop).toEqual([]);
    expect(planSave({ ...base, existing: last({}), next: { ...base.next, savedAt: at(90) } }).drop).toEqual([]); // un reloj que va hacia atrás no coalesce
    expect(planSave({ ...base, existing: last({}) }).drop).toEqual([2]); // y el caso base sí
  });

  it('retención: descarta las automáticas más viejas, conserva las nombradas y nunca la versión nueva', () => {
    const existing = [meta(1, 0, { label: 'Hito' }), meta(2, 100), meta(3, 200), meta(4, 300)];
    const plan = planSave({ existing, lastId: 4, next: { savedAt: at(400), ...facts('nuevo') }, policy, coalesce: true });
    expect(plan.drop).toEqual([2]); // 3 automáticas (3, 4 y la nueva) + la nombrada = 4 ≤ 5
    expect(applyPlan(existing, plan).map((v) => v.id)).toEqual([1, 3, 4, 5]);
    const tight = planSave({ existing, lastId: 4, next: { savedAt: at(400), ...facts('nuevo') }, policy: { ...policy, keepAutomatic: 1, maxVersions: 3 }, coalesce: true });
    expect(applyPlan(existing, tight).map((v) => v.id)).toEqual([1, 5]);
  });

  it('los ids no se reutilizan: el siguiente sale del mayor id dado, aunque esa versión ya no esté', () => {
    const plan = planSave({ existing: [meta(1, 0)], lastId: 9, next: { savedAt: at(100), ...facts('nuevo') }, policy, coalesce: true });
    expect(plan.add[0].id).toBe(10);
    expect(plan.lastId).toBe(10);
  });

  it('las fechas crecen aunque el reloj no avance o vaya hacia atrás', () => {
    const existing = [meta(1, 100)];
    const plan = planSave({ existing, lastId: 1, next: { savedAt: at(50), ...facts('nuevo') }, policy, coalesce: true });
    expect(plan.add[0].savedAt > existing[0].savedAt).toBe(true);
  });

  it('planLabel respeta el máximo de nombradas y planDelete solo borra las nombradas', () => {
    const versions = [meta(1, 0, { label: 'A' }), meta(2, 1, { label: 'B' }), meta(3, 2)];
    expect(() => planLabel(versions, 3, 'C', policy)).toThrow(/máximo/); // caben 5 - 3 = 2
    expect(planLabel(versions, 2, 'B2', policy).label).toBe('B2');
    expect(() => planLabel(versions, 9, 'x', policy)).toThrow(ProjectError);
    expect(planDelete(versions, 1).id).toBe(1);
    expect(() => planDelete(versions, 3)).toThrow(/nombre/);
    expect(versionUsageOf(versions)).toEqual({ versions: 3, bytes: versions.reduce((n, v) => n + v.size, 0) });
  });
});

describe('MemoryProjectStore sin historial', () => {
  it('lo declara y sus operaciones de historial dicen que no están soportadas, sin romper el resto', async () => {
    const store = new MemoryProjectStore(undefined, { versions: false });
    expect(store.keepsVersions).toBe(false);
    expect(isVersioned(store)).toBe(false);
    const project = await store.createProject({ name: 'Tienda' });
    const diagram = await store.saveDiagram(project.id, { module: 'c4', name: 'Contexto', text: 'a' });
    await store.saveDiagram(project.id, { id: diagram.id, text: 'b' });
    expect((await store.getDiagram(project.id, diagram.id))?.text).toBe('b');
    await expect(store.listVersions(project.id, diagram.id)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(store.restoreVersion(project.id, diagram.id, 1)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('un almacén cualquiera sin los métodos no es versionado aunque diga que sí', () => {
    expect(isVersioned({ kind: 'x', keepsVersions: true } as never)).toBe(false);
    expect(isVersioned({ kind: 'x' } as never)).toBe(false);
  });
});
