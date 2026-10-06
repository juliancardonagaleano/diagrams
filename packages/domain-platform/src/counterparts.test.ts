import { describe, expect, it } from 'vitest';
import { platformCommands } from './commands';
import { compareEnvironments, compareMatrix, compareReport, matrixReport, MATCH_NOTES, type EnvironmentComparison } from './compare';
import { counterpartErrors, counterpartsOf, dropCounterparts } from './counterparts';
import { analyzePlatform } from './issues';
import { formatPlatformIssues, validatePlatformDocument } from './schema';
import type { PlatformDocument, Resource } from './types';

type Spec = Partial<Resource> & Pick<Resource, 'id' | 'name' | 'kind' | 'environmentId'>;

const ENVIRONMENTS = [
  { id: 'dev', name: 'Desarrollo', kind: 'dev' },
  { id: 'stg', name: 'Preproducción', kind: 'staging' },
  { id: 'prd', name: 'Producción', kind: 'prod' },
];
const make = (resources: Spec[], extra: Record<string, unknown> = {}): unknown => ({ environments: ENVIRONMENTS, resources, ...extra });
const parse = (input: unknown): PlatformDocument => {
  const r = validatePlatformDocument(input);
  if (!r.ok) throw new Error(formatPlatformIssues(r.issues));
  return r.document;
};
const problems = (input: unknown): string[] => {
  const r = validatePlatformDocument(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('counterpartOf: validación', () => {
  it('acepta una equivalencia entre recursos de entornos distintos, en cualquier sentido y encadenada', () => {
    expect(problems(make([{ id: 'a', name: 'A', kind: 'queue', environmentId: 'dev' }, { id: 'b', name: 'B', kind: 'queue', environmentId: 'prd', counterpartOf: 'a' }]))).toEqual([]);
    const chain = make([
      { id: 'a', name: 'A', kind: 'database', environmentId: 'dev' },
      { id: 'b', name: 'B', kind: 'database', environmentId: 'stg', counterpartOf: 'a' },
      { id: 'c', name: 'C', kind: 'database', environmentId: 'prd', counterpartOf: 'b' },
    ]);
    expect(problems(chain)).toEqual([]);
  });

  it('rechaza un equivalente que no existe, que no es un recurso, que es él mismo o que está en su entorno', () => {
    const doc = (counterpartOf: string): unknown => make([{ id: 'a', name: 'A', kind: 'queue', environmentId: 'dev', counterpartOf }, { id: 'b', name: 'B', kind: 'queue', environmentId: 'prd' }], { networks: [{ id: 'red', name: 'Red', environmentId: 'dev' }] });
    expect(problems(doc('fantasma'))).toEqual(['resources.0.counterpartOf: "a" referencia un recurso equivalente inexistente: "fantasma"']);
    expect(problems(doc('red'))).toEqual(['resources.0.counterpartOf: El equivalente de "a" debe ser un recurso, pero "red" es red']);
    expect(problems(doc('a'))).toEqual(['resources.0.counterpartOf: "a" no puede ser su propio equivalente (counterpartOf)']);
    expect(problems(make([{ id: 'a', name: 'A', kind: 'queue', environmentId: 'dev', counterpartOf: 'b' }, { id: 'b', name: 'B', kind: 'queue', environmentId: 'dev' }]))).toEqual([
      'resources.0.counterpartOf: El recurso "a" y su equivalente "b" están en el mismo entorno ("dev"): el equivalente es el recurso de otro entorno',
    ]);
  });

  it('rechaza una equivalencia ambigua: dos recursos de un entorno equivalentes al mismo de otro', () => {
    const direct = make([
      { id: 'a', name: 'A', kind: 'queue', environmentId: 'dev', counterpartOf: 'x' },
      { id: 'a2', name: 'A2', kind: 'queue', environmentId: 'dev', counterpartOf: 'x' },
      { id: 'x', name: 'X', kind: 'queue', environmentId: 'prd' },
    ]);
    expect(problems(direct)).toEqual([
      'resources.1.counterpartOf: Equivalencia ambigua: "a" y "a2" son del entorno "Desarrollo" y resultan equivalentes de "x" (counterpartOf, directa o por transitividad): en cada entorno solo puede haber un recurso por equivalencia',
    ]);
    // También por transitividad: a → b → c, y c es del mismo entorno que a.
    const transitive = make([
      { id: 'a', name: 'A', kind: 'queue', environmentId: 'dev', counterpartOf: 'b' },
      { id: 'b', name: 'B', kind: 'queue', environmentId: 'stg', counterpartOf: 'c' },
      { id: 'c', name: 'C', kind: 'queue', environmentId: 'dev' },
    ]);
    expect(problems(transitive)).toHaveLength(1);
    expect(problems(transitive)[0]).toMatch(/Equivalencia ambigua: "a" y "c" son del entorno "Desarrollo"/);
  });

  it('no cuenta como duplicado el recurso dado de baja: el sucesor puede declarar lo mismo que el viejo', () => {
    const doc = make([
      { id: 'viejo', name: 'Cola vieja', kind: 'queue', environmentId: 'prd', status: 'decommissioned', counterpartOf: 'a' },
      { id: 'nuevo', name: 'Cola nueva', kind: 'queue', environmentId: 'prd', counterpartOf: 'a' },
      { id: 'a', name: 'Cola', kind: 'queue', environmentId: 'dev' },
    ]);
    expect(problems(doc)).toEqual([]);
  });

  it('el mismo error sale de `counterpartErrors` con el recurso al que se le achaca', () => {
    const doc = parse(make([{ id: 'a', name: 'A', kind: 'queue', environmentId: 'dev' }]));
    expect(counterpartErrors(doc)).toEqual([]);
    const broken = { ...doc, resources: [{ ...doc.resources[0], counterpartOf: 'nada' }] };
    expect(counterpartErrors(broken).map((e) => e.resourceId)).toEqual(['a']);
  });
});

describe('equivalencias (counterpartsOf)', () => {
  const doc = parse(
    make([
      { id: 'a', name: 'A', kind: 'database', environmentId: 'dev' },
      { id: 'b', name: 'B', kind: 'database', environmentId: 'stg', counterpartOf: 'a' },
      { id: 'c', name: 'C', kind: 'database', environmentId: 'prd', counterpartOf: 'b' },
      { id: 'sola', name: 'Sola', kind: 'cache', environmentId: 'dev' },
    ]),
  );
  const by = (id: string): Resource => doc.resources.find((r) => r.id === id)!;
  const counterparts = counterpartsOf(doc);

  it('es simétrica y transitiva', () => {
    expect(counterparts.same(by('a'), by('b'))).toBe(true);
    expect(counterparts.same(by('b'), by('a'))).toBe(true);
    expect(counterparts.same(by('a'), by('c'))).toBe(true);
    expect(counterparts.mates(by('b')).map((r) => r.id)).toEqual(['a', 'c']);
    expect(counterparts.groups.map((g) => g.map((r) => r.id))).toEqual([['a', 'b', 'c']]);
  });

  it('un recurso sin equivalentes no tiene ni grupo ni pareja', () => {
    expect(counterparts.mates(by('sola'))).toEqual([]);
    expect(counterparts.same(by('sola'), by('a'))).toBe(false);
    expect(counterparts.in(by('a'), 'prd')?.id).toBe('c');
    expect(counterparts.in(by('sola'), 'prd')).toBeUndefined();
  });

  it('ignora los enlaces mal formados en vez de romperse', () => {
    const broken = { ...doc, resources: doc.resources.map((r) => (r.id === 'b' ? { ...r, counterpartOf: 'b' } : r.id === 'c' ? { ...r, counterpartOf: 'nada' } : r)) };
    expect(counterpartsOf(broken).groups).toEqual([]);
  });
});

describe('comparar entornos con counterpartOf', () => {
  const pairing = (resources: Spec[], from = 'stg', to = 'prd'): EnvironmentComparison => compareEnvironments(parse(make(resources)), from, to);
  const pairsOf = (c: EnvironmentComparison): string[] => c.resources.filter((r) => r.a && r.b).map((r) => `${r.a!.id}=${r.b!.id}:${r.matchedBy}`);
  const aloneOf = (c: EnvironmentComparison): string[] => c.resources.filter((r) => !(r.a && r.b)).map((r) => (r.a ?? r.b)!.id);

  it('empareja lo que ninguna deducción emparejaría: otro nombre, otra tecnología y otra clase', () => {
    const c = pairing([
      { id: 'a', name: 'Almacén de pedidos', kind: 'database', environmentId: 'stg', technology: 'PostgreSQL', version: '14' },
      { id: 'b', name: 'Pedidos', kind: 'database', environmentId: 'prd', technology: 'Aurora', version: '15', counterpartOf: 'a' },
      { id: 'vm', name: 'Servidor de pruebas', kind: 'vm', environmentId: 'stg' },
      { id: 'k8s', name: 'Clúster principal', kind: 'cluster', environmentId: 'prd', counterpartOf: 'vm' },
    ]);
    expect(pairsOf(c)).toEqual(['a=b:declared', 'vm=k8s:declared']);
    expect(c.resources.find((r) => r.a?.id === 'a')?.kinds).toEqual(['version']);
    expect(aloneOf(c)).toEqual([]);
  });

  it('gana a la deducción: un nombre idéntico no se empareja si el recurso declara a otro', () => {
    const c = pairing([
      { id: 'a', name: 'Pedidos', kind: 'database', environmentId: 'stg', counterpartOf: 'b2' },
      { id: 'b1', name: 'Pedidos', kind: 'database', environmentId: 'prd' },
      { id: 'b2', name: 'Pedidos legado', kind: 'database', environmentId: 'prd' },
    ]);
    expect(pairsOf(c)).toEqual(['a=b2:declared']);
    expect(aloneOf(c)).toEqual(['b1']);
  });

  it('basta que lo declare uno de los dos, en cualquier sentido', () => {
    const forward = pairing([{ id: 'a', name: 'Uno', kind: 'queue', environmentId: 'stg', counterpartOf: 'b' }, { id: 'b', name: 'Otro', kind: 'queue', environmentId: 'prd' }]);
    const backward = pairing([{ id: 'a', name: 'Uno', kind: 'queue', environmentId: 'stg' }, { id: 'b', name: 'Otro', kind: 'queue', environmentId: 'prd', counterpartOf: 'a' }]);
    expect(pairsOf(forward)).toEqual(['a=b:declared']);
    expect(pairsOf(backward)).toEqual(['a=b:declared']);
  });

  it('encadenada: dev → staging y staging → prod hacen equivalentes a dev y prod', () => {
    const doc = parse(
      make([
        { id: 'a', name: 'Colas de pedidos', kind: 'queue', environmentId: 'dev' },
        { id: 'b', name: 'Mensajería', kind: 'queue', environmentId: 'stg', counterpartOf: 'a' },
        { id: 'c', name: 'Broker', kind: 'queue', environmentId: 'prd', counterpartOf: 'b' },
      ]),
    );
    expect(pairsOf(compareEnvironments(doc, 'dev', 'prd'))).toEqual(['a=c:declared']);
    expect(pairsOf(compareEnvironments(doc, 'stg', 'prd'))).toEqual(['b=c:declared']);
  });

  it('un equivalente dado de baja deja al recurso sin pareja en vez de emparejarlo por deducción con otro', () => {
    const c = pairing([
      { id: 'a', name: 'Kafka (stg)', kind: 'queue', environmentId: 'stg', counterpartOf: 'viejo' },
      { id: 'viejo', name: 'Cola retirada', kind: 'queue', environmentId: 'prd', status: 'decommissioned' },
      { id: 'otra', name: 'Kafka (prod)', kind: 'queue', environmentId: 'prd' },
    ]);
    expect(pairsOf(c)).toEqual([]);
    expect(aloneOf(c).sort()).toEqual(['a', 'otra']);
    // Si el sucesor del retirado declara lo mismo, se empareja con él.
    const successor = pairing([
      { id: 'a', name: 'Kafka (stg)', kind: 'queue', environmentId: 'stg', counterpartOf: 'viejo' },
      { id: 'viejo', name: 'Cola retirada', kind: 'queue', environmentId: 'prd', status: 'decommissioned' },
      { id: 'nuevo', name: 'Cola nueva', kind: 'queue', environmentId: 'prd', counterpartOf: 'a' },
    ]);
    expect(pairsOf(successor)).toEqual(['a=nuevo:declared']);
  });

  it('lo que no se declara sigue emparejándose como antes', () => {
    const c = pairing([
      { id: 'a', name: 'Almacén', kind: 'database', environmentId: 'stg', counterpartOf: 'b' },
      { id: 'b', name: 'Base', kind: 'database', environmentId: 'prd' },
      { id: 'k1', name: 'Kafka (stg)', kind: 'queue', environmentId: 'stg' },
      { id: 'k2', name: 'Kafka (prod)', kind: 'queue', environmentId: 'prd' },
    ]);
    expect(pairsOf(c)).toEqual(['a=b:declared', 'k1=k2:normalized']);
  });

  it('el informe lo explica: lista las equivalencias declaradas de nombre distinto y anota la versión que difiere', () => {
    const doc = parse(
      make([
        { id: 'a', name: 'Almacén de pedidos', kind: 'database', environmentId: 'stg', version: '14' },
        { id: 'b', name: 'Pedidos', kind: 'database', environmentId: 'prd', version: '15', counterpartOf: 'a' },
        { id: 'c', name: 'Caché', kind: 'cache', environmentId: 'stg', version: '6' },
        { id: 'd', name: 'Caché', kind: 'cache', environmentId: 'prd', version: '7', counterpartOf: 'c' },
      ]),
    );
    const text = compareReport(doc, compareEnvironments(doc, 'stg', 'prd'));
    expect(text).toContain(`Base de datos «Almacén de pedidos»: Preproducción v14 · Producción v15 (${MATCH_NOTES.declared})`);
    expect(text).toContain('Recursos emparejados por equivalencia declarada (counterpartOf) (1)\n- Base de datos «Almacén de pedidos» con «Pedidos»');
    // Los de nombre idéntico no se repiten en la lista.
    expect(text).not.toContain('«Caché» con «Caché»');
    expect(text).not.toContain('por inferencia');
  });

  it('`iark platform compare` también lo cuenta', () => {
    const doc = make([
      { id: 'a', name: 'Almacén de pedidos', kind: 'database', environmentId: 'stg' },
      { id: 'b', name: 'Pedidos', kind: 'database', environmentId: 'prd', counterpartOf: 'a' },
    ]);
    const compare = platformCommands.find((c) => c.name === 'compare')!;
    const out = compare.run({ args: ['stg', 'prd'], options: {}, input: JSON.stringify(doc) } as never) as string;
    expect(out).toContain('Recursos emparejados por equivalencia declarada (counterpartOf) (1)');
    expect(out).toContain('«Almacén de pedidos» con «Pedidos»');
  });
});

describe('la matriz de varios entornos con counterpartOf', () => {
  const cellIds = (doc: PlatformDocument): string[][] => compareMatrix(doc, ['dev', 'stg', 'prd']).resources.map((row) => row.cells.map((c) => c.resource?.id ?? '-'));

  it('arma una fila por equivalencia, con un recurso por entorno', () => {
    const doc = parse(
      make([
        { id: 'a', name: 'Colas de pedidos', kind: 'queue', environmentId: 'dev', version: '3.5' },
        { id: 'b', name: 'Mensajería', kind: 'queue', environmentId: 'stg', counterpartOf: 'a', version: '3.6' },
        { id: 'c', name: 'Broker', kind: 'queue', environmentId: 'prd', counterpartOf: 'b', version: '3.5' },
      ]),
    );
    expect(cellIds(doc)).toEqual([['a', 'b', 'c']]);
    const [row] = compareMatrix(doc, ['dev', 'stg', 'prd']).resources;
    expect(row.cells.map((c) => c.kinds)).toEqual([[], ['version'], []]);
    expect(row.cells.map((c) => c.matchedBy)).toEqual([undefined, 'declared', 'declared']);
    expect(matrixReport(compareMatrix(doc, ['dev', 'stg', 'prd']))).toContain(`«Mensajería» v3.6 ≠ versión (${MATCH_NOTES.declared})`);
  });

  it('una equivalencia que la referencia no tiene abre su propia fila, y la que le falta en un entorno lo marca', () => {
    const doc = parse(
      make([
        { id: 'solo-b', name: 'Mensajería', kind: 'queue', environmentId: 'stg' },
        { id: 'solo-c', name: 'Broker', kind: 'queue', environmentId: 'prd', counterpartOf: 'solo-b' },
        { id: 'a', name: 'Caché de sesión', kind: 'cache', environmentId: 'dev' },
        { id: 'c', name: 'Caché de sesiones', kind: 'cache', environmentId: 'prd', counterpartOf: 'a' },
      ]),
    );
    expect(cellIds(doc)).toEqual([['a', '-', 'c'], ['-', 'solo-b', 'solo-c']]);
    const [withReference, withoutReference] = compareMatrix(doc, ['dev', 'stg', 'prd']).resources;
    expect(withReference.cells.map((c) => c.kinds)).toEqual([[], ['only-a'], []]);
    expect(withoutReference.cells.map((c) => c.kinds)).toEqual([[], ['only-b'], ['only-b']]);
    expect(withoutReference.cells.map((c) => c.matchedBy)).toEqual([undefined, undefined, 'declared']);
  });

  it('lo declarado manda también aquí: el recurso de otro entorno que la deducción emparejaría con la referencia se queda con su equivalente', () => {
    // «Pedidos» de dev se parece por nombre a «Pedidos» de staging, pero staging declara que el suyo es el de producción.
    const doc = parse(
      make([
        { id: 'dev-pedidos', name: 'Pedidos', kind: 'database', environmentId: 'dev' },
        { id: 'stg-pedidos', name: 'Pedidos', kind: 'database', environmentId: 'stg', counterpartOf: 'prd-ventas' },
        { id: 'prd-ventas', name: 'Ventas', kind: 'database', environmentId: 'prd' },
      ]),
    );
    expect(cellIds(doc)).toEqual([['dev-pedidos', '-', '-'], ['-', 'stg-pedidos', 'prd-ventas']]);
  });

  it('el referente de una equivalencia sigue pudiendo emparejarse por deducción donde esa equivalencia no tiene recurso', () => {
    const doc = parse(
      make([
        { id: 'a', name: 'Kafka (dev)', kind: 'queue', environmentId: 'dev' },
        { id: 'c', name: 'Broker de producción', kind: 'queue', environmentId: 'prd', counterpartOf: 'a' },
        { id: 'b', name: 'Kafka (stg)', kind: 'queue', environmentId: 'stg' },
      ]),
    );
    expect(cellIds(doc)).toEqual([['a', 'b', 'c']]);
    expect(compareMatrix(doc, ['dev', 'stg', 'prd']).resources[0].cells.map((c) => c.matchedBy)).toEqual([undefined, 'normalized', 'declared']);
  });

  it('los dados de baja no entran en la matriz y su equivalencia no cuenta', () => {
    const doc = parse(
      make([
        { id: 'a', name: 'Cola', kind: 'queue', environmentId: 'dev' },
        { id: 'viejo', name: 'Cola retirada', kind: 'queue', environmentId: 'prd', status: 'decommissioned', counterpartOf: 'a' },
      ]),
    );
    expect(cellIds(doc)).toEqual([['a', '-', '-']]);
  });
});

describe('avisos de counterpartOf', () => {
  const warnings = (resources: Spec[]): string[] => analyzePlatform(parse(make(resources))).filter((i) => /counterpartOf/.test(i.message)).map((i) => `${i.severity}: ${i.message}`);

  it('avisa de un equivalente de otra clase, salvo entre máquinas y clústeres', () => {
    expect(warnings([{ id: 'a', name: 'Cola', kind: 'queue', environmentId: 'dev', counterpartOf: 'b' }, { id: 'b', name: 'Caché', kind: 'cache', environmentId: 'prd' }])).toEqual([
      'warning: Cola o broker «Cola» se declara equivalente de caché «Caché» (counterpartOf), que es de otra clase: ¿es el recurso que corresponde?',
    ]);
    expect(warnings([{ id: 'a', name: 'VM', kind: 'vm', environmentId: 'dev', counterpartOf: 'b' }, { id: 'b', name: 'Clúster', kind: 'cluster', environmentId: 'prd' }])).toEqual([]);
  });

  it('avisa de que la comparación no cuenta una equivalencia con un recurso dado de baja', () => {
    expect(warnings([{ id: 'a', name: 'Cola', kind: 'queue', environmentId: 'dev', counterpartOf: 'b' }, { id: 'b', name: 'Cola vieja', kind: 'queue', environmentId: 'prd', status: 'decommissioned' }])).toEqual([
      'info: Cola o broker «Cola» se declara equivalente de cola o broker «Cola vieja» (counterpartOf), pero «Cola vieja» está dado de baja: la comparación de entornos no cuenta esa equivalencia.',
    ]);
  });
});

describe('quitar recursos con counterpartOf', () => {
  const resources = parse(
    make([
      { id: 'a', name: 'A', kind: 'database', environmentId: 'dev' },
      { id: 'b', name: 'B', kind: 'database', environmentId: 'stg', counterpartOf: 'a' },
      { id: 'c', name: 'C', kind: 'database', environmentId: 'prd', counterpartOf: 'b' },
    ]),
  ).resources;
  const links = (rs: Resource[]): string[] => rs.map((r) => `${r.id}→${r.counterpartOf ?? '-'}`);

  it('al quitar el del medio de la cadena, el que lo declaraba pasa a declarar el que él declaraba', () => {
    expect(links(dropCounterparts(resources, new Set(['b'])))).toEqual(['a→-', 'c→a']);
  });

  it('al quitar un extremo, el que lo declaraba pierde el enlace', () => {
    expect(links(dropCounterparts(resources, new Set(['a'])))).toEqual(['b→-', 'c→b']);
    expect(links(dropCounterparts(resources, new Set(['c'])))).toEqual(['a→-', 'b→a']);
  });

  it('al quitar varios a la vez sigue la cadena hasta el que queda', () => {
    expect(links(dropCounterparts(resources, new Set(['a', 'b'])))).toEqual(['c→-']);
  });
});
