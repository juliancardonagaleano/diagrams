import { findEnvironment, nextEnvironment } from './actions';
import { counterpartsOf, type Counterparts } from './counterparts';
import { ENVIRONMENT_KINDS, RESOURCE_LABELS, statusOf, type Deployment, type Environment, type PlatformDocument, type Resource, type ResourceKind, type Service } from './types';

/**
 * Comparación de dos entornos (p. ej. preproducción y producción): qué servicios y recursos solo están en uno, y cuáles
 * están en los dos pero con otra versión o con otras réplicas. Es lo que dibuja la vista `compare:<A>:<B>` y lo que cuenta
 * el informe de diferencias. Los servicios se corresponden por id; los recursos, por lo que declaran (`counterpartOf`) o, si no, por
 * nombre y por lo poco que se pueda deducir con certeza (ver `pairResources`), y cada par dice cómo se emparejó (`MatchedBy`).
 *
 * Con tres o más entornos (`compare:<A>:<B>:<C>…` o `compare:all`) la comparación es una matriz: una fila por servicio (o por
 * recurso emparejado) y una columna por entorno, y cada celda se compara con la de la referencia, que es el primer entorno de
 * la lista (`compareMatrix`). Comparar la referencia con cada columna es, por construcción, la comparación de dos entornos de siempre.
 */
export type DiffKind = 'only-a' | 'only-b' | 'version' | 'replicas';

/** Lo que un servicio tiene desplegado en un entorno (puede correr en varios anfitriones). */
export interface Presence {
  deploymentIds: string[];
  /** Suma de réplicas (una instancia sin réplicas declaradas cuenta una). */
  replicas: number;
  versions: string[];
  hostIds: string[];
}

export interface ServiceDifference {
  service: Service;
  a?: Presence;
  b?: Presence;
  /** Vacío si es igual en los dos entornos. */
  kinds: DiffKind[];
}

/**
 * Con qué criterio se emparejó un recurso de un entorno con su equivalente del otro (de más a menos fiable): `declared` = uno de los
 * dos declara al otro como su equivalente (`counterpartOf`, directa o encadenada), y eso gana a cualquier deducción; `name` = mismo
 * nombre y clase; `normalized` = mismo nombre una vez quitado el del entorno («Kafka (dev)» y «Kafka (prod)»), los acentos y las
 * mayúsculas; `technology` = única pareja posible de su clase y tecnología; `similar-name` = varias parejas posibles de su clase y
 * tecnología, y se eligió la de nombre más parecido; `only-candidate` = único recurso de su clase en cada entorno, y de una clase
 * que no suele repetirse (un clúster, una pasarela).
 */
export type MatchedBy = 'declared' | 'name' | 'normalized' | 'technology' | 'similar-name' | 'only-candidate';

/** Cómo se cuenta el criterio de emparejado en el informe y en el lienzo. */
export const MATCH_NOTES: Record<MatchedBy, string> = {
  declared: 'emparejado por equivalencia declarada',
  name: 'emparejado por nombre',
  normalized: 'emparejado por nombre normalizado',
  technology: 'emparejado por tecnología',
  'similar-name': 'emparejado por nombre parecido',
  'only-candidate': 'emparejado por ser el único de su clase',
};

export interface ResourceDifference {
  a?: Resource;
  b?: Resource;
  kinds: DiffKind[];
  /** Cómo se emparejaron `a` y `b`; solo cuando están los dos. */
  matchedBy?: MatchedBy;
}

export interface EnvironmentComparison {
  a: Environment;
  b: Environment;
  services: ServiceDifference[];
  resources: ResourceDifference[];
}

const presenceIn = (deployments: Deployment[]): Presence | undefined =>
  deployments.length === 0
    ? undefined
    : {
        deploymentIds: deployments.map((d) => d.id),
        replicas: deployments.reduce((sum, d) => sum + (d.replicas ?? 1), 0),
        versions: [...new Set(deployments.map((d) => d.version).filter((v): v is string => !!v))],
        hostIds: deployments.map((d) => d.hostId),
      };

export const versionText = (versions: string[]): string => (versions.length === 0 ? 'sin versión' : versions.map((v) => `v${v}`).join(' + '));
const sameVersions = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * Palabras con las que un nombre suele decir en qué entorno está («kafka-prod», «Postgres de pruebas», «Redis (preproducción)»), ya
 * sin acentos ni mayúsculas. Son las de todas las clases de entorno, no solo las del entorno del recurso: una base «de pruebas» puede
 * vivir en preproducción. Se les suman el id y el nombre de cada entorno (los personalizados: «Pruebas de carga», «acme»…).
 */
const ENVIRONMENT_WORDS = [
  'dev', 'develop', 'development', 'desarrollo', 'desa',
  'test', 'testing', 'prueba', 'pruebas', 'qa', 'uat',
  'staging', 'stage', 'stg', 'preprod', 'preproduccion', 'preproduction', 'pre prod', 'pre produccion', 'pre production',
  'prod', 'prd', 'production', 'produccion',
  'dr', 'disaster recovery', 'recuperacion ante desastres',
];
/** Nexos que no dicen nada del recurso: sobran al final o al principio de un nombre al quitarle el entorno («Postgres de pruebas» → «postgres»). */
const CONNECTORS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'para', 'of', 'the', 'for', 'in', 'and']);
/**
 * Clases de las que un entorno suele tener una sola: si cada entorno tiene exactamente un recurso de la clase, y no se llevan la
 * contraria en tecnología, se emparejan aunque no haya otra pista. En las que se repiten (bases de datos, colas, cachés, máquinas,
 * almacenamientos, balanceadores, DNS, certificados, espacios de nombres…) un recurso suelto de cada lado puede ser cualquiera
 * de los dos y se prefiere decir «solo en A» y «solo en B» que inventar una diferencia de versión.
 */
const SINGLETON_KINDS: ResourceKind[] = ['cluster', 'gateway', 'secret-store', 'registry'];

/** Palabras de un texto: sin acentos, en minúsculas y sin signos («k8s-dev» → k8s, dev). */
const tokensOf = (text: string): string[] => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Lo que, dicho en el nombre de un recurso, señala a un entorno: las palabras de cualquier clase de entorno («prod», «producción»…) y el id y el nombre del suyo (o de varios, si el lado agrupa recursos de más de uno). */
function environmentPhrases(env: Environment | Environment[]): Set<string> {
  const phrases = new Set([...ENVIRONMENT_WORDS, ...[env].flat().flatMap((e) => [tokensOf(e.id).join(' '), tokensOf(e.name).join(' ')])]);
  phrases.delete('');
  return phrases;
}

/** Palabras del nombre de un recurso sin las que nombran a su entorno ni los nexos de los extremos; si no queda nada, las del nombre entero. */
function nameWithoutEnvironment(name: string, phrases: Set<string>): string[] {
  const tokens = tokensOf(name);
  const longest = Math.max(1, ...[...phrases].map((p) => p.split(' ').length));
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let skip = 0;
    for (let length = Math.min(longest, tokens.length - i); length > 0 && skip === 0; length--) if (phrases.has(tokens.slice(i, i + length).join(' '))) skip = length;
    if (skip > 0) i += skip;
    else kept.push(tokens[i++]);
  }
  while (kept.length > 0 && CONNECTORS.has(kept[0])) kept.shift();
  while (kept.length > 0 && CONNECTORS.has(kept[kept.length - 1])) kept.pop();
  return kept.length > 0 ? kept : tokens;
}

/** Parecido entre dos nombres (0 a 1): palabras compartidas sobre palabras distintas, sin nexos ni la tecnología (que ya comparten los del mismo grupo). */
function similarity(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((t) => b.has(t)).length;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
}

/** El elemento de `others` más parecido a `x`, solo si lo es de forma inequívoca (parecido mayor que cero y sin empate). */
function mostSimilar<T>(x: Set<string>, others: Array<[T, Set<string>]>): T | undefined {
  const ranked = others.map(([o, tokens]) => ({ o, score: similarity(x, tokens) })).sort((p, q) => q.score - p.score);
  return ranked[0] && ranked[0].score > 0 && ranked[0].score > (ranked[1]?.score ?? 0) ? ranked[0].o : undefined;
}

interface ResourcePair {
  a?: Resource;
  b?: Resource;
  matchedBy?: MatchedBy;
}

/** Qué recursos de cada lado no se emparejan por deducción porque ya tienen su sitio (en la matriz, los que ya están en la fila de su equivalencia declarada). */
interface Taken {
  left?: ReadonlySet<Resource>;
  right?: ReadonlySet<Resource>;
}

/**
 * Empareja los recursos de dos entornos sin adivinar. Siempre dentro de la misma clase, salvo la primera regla, y por este orden:
 * 0. por lo que declaran (`counterpartOf`, ver `Counterparts`): dos recursos que son equivalentes por declaración se emparejan sea
 *    cual sea su nombre, tecnología o clase. Lo que declaran gana a todo lo demás, y un recurso cuyo equivalente declarado en el
 *    otro lado está dado de baja se queda sin pareja en vez de buscarle otra por deducción;
 * 1. por nombre idéntico (sin distinguir mayúsculas);
 * 2. por nombre normalizado: sin el del entorno, los acentos ni las mayúsculas («Kafka (dev)» y «Kafka (prod)»); si dos recursos
 *    de un lado quedan con el mismo nombre normalizado, no decide entre ellos;
 * 3. por tecnología, cuando cada entorno tiene un solo recurso de esa clase y tecnología; si tiene varios, solo si el nombre
 *    más parecido (palabras compartidas) es uno y solo uno, y lo es de los dos lados;
 * 4. por clase, únicamente si es de las que no se repiten (`SINGLETON_KINDS`), cada entorno tiene una sola y no declaran
 *    tecnologías distintas.
 * Lo que no encaja con certeza queda sin pareja («solo en A» o «solo en B»): una pareja equivocada inventaría diferencias de
 * versión que no existen. Los grupos se cuentan sobre todos los recursos del entorno, no solo sobre los que quedan libres: si hay
 * dos colas Kafka y una ya se emparejó por nombre, la otra de cada lado no tiene por qué ser la misma.
 */
function pairResources(left: Resource[], right: Resource[], a: Environment | Environment[], b: Environment | Environment[], counterparts: Counterparts, taken: Taken = {}): ResourcePair[] {
  const pairs: ResourcePair[] = [];
  let restLeft = left.filter((l) => !taken.left?.has(l));
  let restRight = right.filter((r) => !taken.right?.has(r));
  const take = (l: Resource, r: Resource, matchedBy: MatchedBy): void => {
    pairs.push({ a: l, b: r, matchedBy });
    restLeft = restLeft.filter((x) => x !== l);
    restRight = restRight.filter((x) => x !== r);
  };
  for (const l of [...restLeft]) {
    const r = restRight.find((x) => counterparts.same(l, x));
    if (r) take(l, r, 'declared');
  }
  // Un equivalente declarado en el otro lado que está dado de baja no es una pareja, pero tampoco deja que otro recurso ocupe su sitio.
  const environmentIds = (e: Environment | Environment[]): Set<string> => new Set([e].flat().map((x) => x.id));
  const [idsA, idsB] = [environmentIds(a), environmentIds(b)];
  const retired = (r: Resource, otherSide: Set<string>): boolean => counterparts.mates(r).some((m) => otherSide.has(m.environmentId) && statusOf(m) === 'decommissioned');
  const openLeft = (): Resource[] => restLeft.filter((l) => !retired(l, idsB));
  const openRight = (): Resource[] => restRight.filter((r) => !retired(r, idsA));
  const [phrasesA, phrasesB] = [environmentPhrases(a), environmentPhrases(b)];
  const technologyOf = (r: Resource): string => tokensOf(r.technology ?? '').join(' ');
  /** Palabras que distinguen a un recurso de los demás de su grupo: su nombre sin entorno, nexos ni tecnología. */
  const wordsOf = (r: Resource, phrases: Set<string>): Set<string> => {
    const technology = new Set(tokensOf(r.technology ?? ''));
    return new Set(nameWithoutEnvironment(r.name, phrases).filter((t) => !CONNECTORS.has(t) && !technology.has(t)));
  };

  /** Empareja por una clave de nombre, dentro de la misma clase. Con `unique`, solo si la clave no se repite entre los libres de ninguno de los dos lados. */
  const byName = (keyA: (r: Resource) => string, keyB: (r: Resource) => string, matchedBy: MatchedBy, unique: boolean): void => {
    for (const l of openLeft()) {
      const key = keyA(l);
      const sameLeft = openLeft().filter((x) => x.kind === l.kind && keyA(x) === key);
      const sameRight = openRight().filter((r) => r.kind === l.kind && keyB(r) === key);
      if (key && sameRight.length > 0 && (!unique || (sameLeft.length === 1 && sameRight.length === 1))) take(l, sameRight[0], matchedBy);
    }
  };
  byName((r) => r.name.trim().toLowerCase(), (r) => r.name.trim().toLowerCase(), 'name', false);
  byName((r) => nameWithoutEnvironment(r.name, phrasesA).join(' '), (r) => nameWithoutEnvironment(r.name, phrasesB).join(' '), 'normalized', true);

  for (const group of new Set(openLeft().filter((r) => technologyOf(r)).map((r) => `${r.kind}|${technologyOf(r)}`))) {
    const inGroup = (r: Resource): boolean => `${r.kind}|${technologyOf(r)}` === group;
    const [freeLeft, freeRight] = [openLeft().filter(inGroup), openRight().filter(inGroup)];
    if (freeLeft.length === 0 || freeRight.length === 0) continue;
    if (left.filter(inGroup).length === 1 && right.filter(inGroup).length === 1) {
      take(freeLeft[0], freeRight[0], 'technology');
      continue;
    }
    const [wordsLeft, wordsRight] = [freeLeft.map((r): [Resource, Set<string>] => [r, wordsOf(r, phrasesA)]), freeRight.map((r): [Resource, Set<string>] => [r, wordsOf(r, phrasesB)])];
    for (const [l, words] of wordsLeft) {
      const r = mostSimilar(words, wordsRight);
      if (r && mostSimilar(wordsRight.find(([x]) => x === r)![1], wordsLeft) === l) take(l, r, 'similar-name');
    }
  }

  for (const l of openLeft()) {
    const inClass = (r: Resource): boolean => r.kind === l.kind;
    const r = openRight().find(inClass);
    if (!r || !SINGLETON_KINDS.includes(l.kind) || left.filter(inClass).length !== 1 || right.filter(inClass).length !== 1) continue;
    const [techLeft, techRight] = [technologyOf(l), technologyOf(r)];
    if (techLeft && techRight && techLeft !== techRight) continue;
    take(l, r, 'only-candidate');
  }
  return [...pairs, ...restLeft.map((l): ResourcePair => ({ a: l })), ...restRight.map((r): ResourcePair => ({ b: r }))];
}

/** Recursos de un entorno que se comparan: los que no están dados de baja. */
const liveResources = (doc: PlatformDocument, environmentId: string): Resource[] => doc.resources.filter((r) => r.environmentId === environmentId && r.status !== 'decommissioned');

/** En qué se distingue lo que un servicio tiene en un entorno (`b`) de lo que tiene en el de referencia (`a`). */
function serviceKinds(a: Presence | undefined, b: Presence | undefined): DiffKind[] {
  if (a && !b) return ['only-a'];
  if (b && !a) return ['only-b'];
  if (!a || !b) return [];
  return [...(sameVersions(a.versions, b.versions) ? [] : (['version'] as const)), ...(a.replicas === b.replicas ? [] : (['replicas'] as const))];
}

/** Lo mismo para un par de recursos: solo en uno de los dos, o con otra versión. */
const resourceKinds = (a: Resource | undefined, b: Resource | undefined): DiffKind[] => (a && !b ? ['only-a'] : b && !a ? ['only-b'] : (a?.version ?? '') !== (b?.version ?? '') ? ['version'] : []);

export function compareEnvironments(doc: PlatformDocument, aId: string, bId: string): EnvironmentComparison {
  const a = doc.environments.find((e) => e.id === aId);
  const b = doc.environments.find((e) => e.id === bId);
  if (!a || !b) throw new Error(`No existe el entorno «${!a ? aId : bId}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.`);
  if (a.id === b.id) throw new Error('Elige dos entornos distintos para compararlos.');
  const services: ServiceDifference[] = [];
  for (const service of doc.services) {
    const pa = presenceIn(doc.deployments.filter((d) => d.serviceId === service.id && d.environmentId === a.id));
    const pb = presenceIn(doc.deployments.filter((d) => d.serviceId === service.id && d.environmentId === b.id));
    if (!pa && !pb) continue;
    services.push({ service, ...(pa ? { a: pa } : {}), ...(pb ? { b: pb } : {}), kinds: serviceKinds(pa, pb) });
  }
  const resources = pairResources(liveResources(doc, a.id), liveResources(doc, b.id), a, b, counterpartsOf(doc)).map(({ a: ra, b: rb, matchedBy }): ResourceDifference => {
    return { ...(ra ? { a: ra } : {}), ...(rb ? { b: rb } : {}), kinds: resourceKinds(ra, rb), ...(ra && rb && matchedBy ? { matchedBy } : {}) };
  });
  return { a, b, services, resources };
}

/** El entorno con el que comparar otro cuando no se indica: el siguiente en el camino a producción o, si no lo hay, el anterior. */
export function counterpart(doc: PlatformDocument, environmentId: string): Environment | undefined {
  const next = nextEnvironment(doc, environmentId);
  if (next) return next;
  const rank = (e: Environment): number => (e.kind ? ENVIRONMENT_KINDS.indexOf(e.kind) : -1);
  const from = doc.environments.find((e) => e.id === environmentId);
  if (!from) return undefined;
  const earlier = doc.environments.filter((e) => e.id !== from.id && rank(e) >= 0 && rank(e) < rank(from)).sort((x, y) => rank(y) - rank(x))[0];
  return earlier ?? doc.environments.find((e) => e.id !== from.id);
}

/**
 * Los dos entornos que nombra una vista `compare:<A>:<B>` (el texto tras `compare:`): por id o por nombre. Con uno solo
 * (`compare:<A>`), el otro es su contrapartida en el camino a producción.
 */
export function resolveComparison(doc: PlatformDocument, text: string): [Environment, Environment] {
  const [first = '', ...rest] = text.split(':');
  const a = findEnvironment(doc, first);
  if (!a) throw new Error(`No existe el entorno «${first}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.`);
  const second = rest.join(':');
  const b = second ? findEnvironment(doc, second) : counterpart(doc, a.id);
  if (!b) throw new Error(second ? `No existe el entorno «${second}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.` : `Indica con qué entorno comparar «${a.name}»: compare:${a.id}:<entorno>.`);
  return [a, b];
}

/** Número de diferencias de cada clase (los elementos iguales no cuentan). */
export function summarize(comparison: EnvironmentComparison): Record<DiffKind | 'same', number> {
  const total: Record<DiffKind | 'same', number> = { 'only-a': 0, 'only-b': 0, version: 0, replicas: 0, same: 0 };
  for (const x of [...comparison.services, ...comparison.resources]) {
    if (x.kinds.length === 0) total.same += 1;
    for (const k of x.kinds) total[k] += 1;
  }
  return total;
}

/** Informe de diferencias en Markdown. */
export function compareReport(doc: PlatformDocument, comparison: EnvironmentComparison): string {
  const { a, b } = comparison;
  const hosts = new Map(doc.resources.map((r) => [r.id, r.name]));
  const describe = (p: Presence): string => [`${p.replicas} ${p.replicas === 1 ? 'réplica' : 'réplicas'}`, versionText(p.versions), `en ${[...new Set(p.hostIds.map((h) => hosts.get(h) ?? h))].join(', ')}`].join(' · ');
  const diffs = comparison.services.filter((s) => s.kinds.length > 0);
  const out = [`Comparación de «${a.name}» (A) y «${b.name}» (B)`, ''];
  const section = (title: string, lines: string[]): void => {
    if (lines.length > 0) out.push(`${title} (${lines.length})`, ...lines.map((l) => `- ${l}`), '');
  };
  section(`Servicios solo en ${a.name}`, diffs.filter((s) => s.kinds.includes('only-a')).map((s) => `${s.service.name}: ${describe(s.a!)}`));
  section(`Servicios solo en ${b.name}`, diffs.filter((s) => s.kinds.includes('only-b')).map((s) => `${s.service.name}: ${describe(s.b!)}`));
  section('Versión distinta', diffs.filter((s) => s.kinds.includes('version')).map((s) => `${s.service.name}: ${a.name} ${versionText(s.a!.versions)} · ${b.name} ${versionText(s.b!.versions)}`));
  section('Réplicas distintas', diffs.filter((s) => s.kinds.includes('replicas')).map((s) => `${s.service.name}: ${a.name} ${s.a!.replicas} · ${b.name} ${s.b!.replicas}`));
  const resourceName = (r: Resource): string => `${RESOURCE_LABELS[r.kind]} «${r.name}»`;
  section(`Recursos solo en ${a.name}`, comparison.resources.filter((r) => r.kinds.includes('only-a')).map((r) => resourceName(r.a!)));
  section(`Recursos solo en ${b.name}`, comparison.resources.filter((r) => r.kinds.includes('only-b')).map((r) => resourceName(r.b!)));
  /** Los pares que no se emparejaron por nombre idéntico lo dicen, para que se pueda juzgar si la diferencia es real. */
  const matchNote = (r: ResourceDifference): string => (r.matchedBy && r.matchedBy !== 'name' ? ` (${MATCH_NOTES[r.matchedBy]})` : '');
  section('Recursos con otra versión', comparison.resources.filter((r) => r.kinds.includes('version')).map((r) => `${resourceName(r.a!)}: ${a.name} ${r.a!.version ? `v${r.a!.version}` : 'sin versión'} · ${b.name} ${r.b!.version ? `v${r.b!.version}` : 'sin versión'}${matchNote(r)}`));
  // Las parejas que se dedujeron sin que el nombre las delate se listan aunque no difieran: es lo único que dice que se emparejaron.
  // Las declaradas (`counterpartOf`) no son una deducción: se listan aparte, y solo las de nombre distinto (las de igual nombre no sorprenden a nadie).
  const sameName = (r: ResourceDifference): boolean => r.a!.name.trim().toLowerCase() === r.b!.name.trim().toLowerCase();
  section('Recursos emparejados por equivalencia declarada (counterpartOf)', comparison.resources.filter((r) => r.matchedBy === 'declared' && !sameName(r)).map((r) => `${resourceName(r.a!)} con «${r.b!.name}»`));
  section('Recursos emparejados por inferencia', comparison.resources.filter((r) => r.matchedBy && !['declared', 'name', 'normalized'].includes(r.matchedBy)).map((r) => `${resourceName(r.a!)} con «${r.b!.name}»${matchNote(r)}`));
  const totals = summarize(comparison);
  out.push(totals['only-a'] + totals['only-b'] + totals.version + totals.replicas === 0 ? 'Los dos entornos son equivalentes: mismos servicios, versiones y réplicas.' : `Iguales en ambos: ${totals.same} elemento(s).`);
  return out.join('\n').trimEnd();
}

// --- Comparación de varios entornos: la matriz --------------------------------------------------------------------------------

/**
 * Lo que un servicio tiene en un entorno de la matriz y en qué se distingue de la referencia (el primer entorno). Con el mismo
 * sentido que en la comparación de dos entornos, siendo A la referencia y B el entorno de la columna: `only-a` = la referencia lo
 * tiene y este entorno no (falta); `only-b` = este entorno lo tiene y la referencia no. La celda de la referencia nunca difiere.
 */
export interface ServiceCell {
  presence?: Presence;
  kinds: DiffKind[];
}

/** Un servicio y sus celdas, una por entorno y en el mismo orden que `EnvironmentMatrix.environments`. */
export interface ServiceRow {
  service: Service;
  cells: ServiceCell[];
}

/** Lo que un recurso (el emparejado con el de la referencia) es en un entorno de la matriz; `matchedBy` dice cómo se emparejó con el de la referencia. */
export interface ResourceCell {
  resource?: Resource;
  kinds: DiffKind[];
  matchedBy?: MatchedBy;
}

export interface ResourceRow {
  cells: ResourceCell[];
}

/**
 * Matriz de servicios y recursos por entorno. `environments[0]` es la referencia. Las filas de recursos son primero las de la
 * referencia y luego las de recursos que ella no tiene (los de otros entornos que se corresponden entre sí van en la misma fila).
 */
export interface EnvironmentMatrix {
  environments: Environment[];
  services: ServiceRow[];
  resources: ResourceRow[];
}

/** Palabras que, en la lista de una vista `compare:`, valen por «todos (los demás) entornos con contenido». */
const ALL_WORDS = ['all', 'todos', 'todas'];

/** Entornos que se pueden comparar (los que tienen recursos o despliegues), en el orden del documento. */
export function comparableEnvironments(doc: PlatformDocument): Environment[] {
  return doc.environments.filter((e) => doc.resources.some((r) => r.environmentId === e.id) || doc.deployments.some((d) => d.environmentId === e.id));
}

/** ¿El texto de una vista `compare:` pide «todos los entornos»? (Un entorno que se llame así tiene preferencia.) */
export const isAllEnvironments = (doc: PlatformDocument, text: string): boolean => ALL_WORDS.includes(text.trim().toLowerCase()) && !findEnvironment(doc, text);

/**
 * Los entornos que nombra una vista `compare:` (el texto tras `compare:`), por id o por nombre y separados por «:»; el primero es
 * la referencia. `<A>:<B>` y `<A>` solos significan lo de siempre (ver `resolveComparison`); `<A>:<B>:<C>…` compara tres o más;
 * `all` son todos los entornos con contenido, en el orden del documento, y `<A>:all`, esos mismos con A como referencia.
 * Un nombre de entorno con «:» se reconoce uniendo las partes.
 */
export function resolveEnvironments(doc: PlatformDocument, text: string): Environment[] {
  const parts = text.split(':');
  const notFound = (name: string): Error => new Error(`No existe el entorno «${name}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.`);
  // `compare:<A>:<B>` de siempre: el segundo es un solo entorno aunque su nombre lleve «:».
  const first = findEnvironment(doc, parts[0]);
  const rest = findEnvironment(doc, parts.slice(1).join(':'));
  if (parts.length > 2 && first && rest) return [first, rest];

  const chosen: Environment[] = [];
  let everyone = false;
  for (let i = 0; i < parts.length; ) {
    if (isAllEnvironments(doc, parts[i])) {
      everyone = true;
      i += 1;
      continue;
    }
    let length = 1;
    let found = findEnvironment(doc, parts[i]);
    while (!found && i + length < parts.length) found = findEnvironment(doc, parts.slice(i, i + ++length).join(':'));
    if (!found) throw notFound(parts[i]);
    if (chosen.includes(found)) throw new Error(`El entorno «${found.name}» está repetido: elige entornos distintos para compararlos.`);
    chosen.push(found);
    i += length;
  }
  if (everyone) chosen.push(...comparableEnvironments(doc).filter((e) => !chosen.includes(e)));
  if (chosen.length === 0) throw new Error('El documento no tiene entornos con contenido que comparar.');
  if (chosen.length > 1) return chosen;
  const other = everyone ? undefined : counterpart(doc, chosen[0].id);
  if (!other) throw new Error(everyone ? `No hay otro entorno con contenido con el que comparar «${chosen[0].name}».` : `Indica con qué entorno comparar «${chosen[0].name}»: compare:${chosen[0].id}:<entorno>.`);
  return [chosen[0], other];
}

/**
 * Compara tres o más entornos con el primero (la referencia). Cada servicio con despliegue en alguno es una fila; cada celda dice si
 * falta, sobra o difiere en versión o réplicas respecto a la de la referencia. Los recursos se emparejan con los de la referencia
 * como en la comparación de dos entornos (`pairResources`, con su `matchedBy`); los que no tiene la referencia se emparejan entre
 * sí (un balanceador que está en preproducción y en producción pero no en desarrollo es una sola fila). Primero se arman las filas
 * de las equivalencias declaradas (`counterpartOf`), que mandan: una fila por equivalencia, con un recurso por entorno; los que
 * quedan se emparejan por deducción.
 */
export function compareMatrix(doc: PlatformDocument, ids: string[]): EnvironmentMatrix {
  const environments = ids.map((id) => {
    const environment = doc.environments.find((e) => e.id === id);
    if (!environment) throw new Error(`No existe el entorno «${id}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.`);
    return environment;
  });
  if (environments.length < 2) throw new Error('Elige al menos dos entornos para compararlos.');
  if (new Set(ids).size !== ids.length) throw new Error('Elige entornos distintos para compararlos.');

  const services: ServiceRow[] = [];
  for (const service of doc.services) {
    const presences = environments.map((e) => presenceIn(doc.deployments.filter((d) => d.serviceId === service.id && d.environmentId === e.id)));
    if (presences.every((p) => !p)) continue;
    services.push({ service, cells: presences.map((presence, i) => ({ ...(presence ? { presence } : {}), kinds: i === 0 ? [] : serviceKinds(presences[0], presence) })) });
  }

  const counterparts = counterpartsOf(doc);
  const columns = environments.map((e) => liveResources(doc, e.id));
  const columnOf = new Map(columns.flatMap((resources, i) => resources.map((r): [Resource, number] => [r, i])));
  const blank = (): ResourceCell[] => environments.map(() => ({ kinds: [] }));
  /** La fila de cada recurso de la referencia: la suya o la de su equivalencia declarada. */
  const rowOf = new Map<Resource, ResourceRow>();
  const extras: ResourceRow[] = [];
  /** Los recursos que ya tienen su fila por una equivalencia declarada: no se les busca pareja por deducción en las columnas donde la tienen. */
  const placed = new Set<Resource>();
  for (const group of counterparts.groups) {
    const cells = blank();
    // Un recurso por entorno (el primero del documento): si la equivalencia tuviera más, los demás se quedan para la deducción.
    const members = new Set<number>();
    for (const member of group) {
      const column = columnOf.get(member);
      if (column !== undefined && !cells[column].resource) {
        cells[column] = { resource: member, kinds: [] };
        members.add(column);
      }
    }
    if (members.size < 2) continue;
    const columnsOf = [...members].sort((x, y) => x - y);
    const reference = cells[0].resource;
    for (const column of columnsOf) {
      const resource = cells[column].resource!;
      placed.add(resource);
      if (column === 0) continue;
      // Frente a la referencia, si la equivalencia la tiene; si no, es de lo que la referencia no tiene (y el primero de la fila no se empareja con nadie).
      cells[column] = reference ? { resource, kinds: resourceKinds(reference, resource), matchedBy: 'declared' } : { resource, kinds: ['only-b'], ...(column === columnsOf[0] ? {} : { matchedBy: 'declared' as const }) };
    }
    const row: ResourceRow = { cells };
    if (reference) rowOf.set(reference, row);
    else extras.push(row);
  }
  const rows: ResourceRow[] = columns[0].map((resource) => {
    const row = rowOf.get(resource) ?? { cells: blank().map((cell, i) => (i === 0 ? { resource, kinds: [] } : cell)) };
    rowOf.set(resource, row);
    return row;
  });
  const firstColumn = (row: ResourceRow): number => row.cells.findIndex((c) => c.resource);
  environments.forEach((environment, i) => {
    if (i === 0) return;
    const [filledRight, filledLeft] = [new Set(columns[i].filter((r) => placed.has(r))), new Set(columns[0].filter((r) => rowOf.get(r)!.cells[i].resource))];
    const leftovers: Resource[] = [];
    for (const pair of pairResources(columns[0], columns[i], environments[0], environment, counterparts, { left: filledLeft, right: filledRight })) {
      if (pair.a) rowOf.get(pair.a)!.cells[i] = { ...(pair.b ? { resource: pair.b, ...(pair.matchedBy ? { matchedBy: pair.matchedBy } : {}) } : {}), kinds: resourceKinds(pair.a, pair.b) };
      else leftovers.push(pair.b!);
    }
    // Lo que la referencia no tiene: se empareja con lo ya visto en los entornos anteriores y, si no, abre una fila.
    const open = extras.filter((row) => !row.cells[i].resource && firstColumn(row) < i);
    const merged = new Set<Resource>();
    if (open.length > 0) {
      const earlier = environments.slice(1, i);
      for (const pair of pairResources(open.map((row) => row.cells[firstColumn(row)].resource!), leftovers, earlier, environment, counterparts)) {
        if (!pair.a || !pair.b) continue;
        open.find((row) => row.cells.some((c) => c.resource === pair.a))!.cells[i] = { resource: pair.b, kinds: ['only-b'], ...(pair.matchedBy ? { matchedBy: pair.matchedBy } : {}) };
        merged.add(pair.b);
      }
    }
    for (const resource of leftovers.filter((r) => !merged.has(r))) extras.push({ cells: blank().map((cell, k) => (k === i ? { resource, kinds: ['only-b'] } : cell)) });
  });
  return { environments, services, resources: [...rows, ...extras] };
}

/** Cuántos elementos de cada entorno (menos la referencia) difieren de ella y de qué manera, servicios y recursos juntos; `same` son los que están en los dos y no difieren. */
export function summarizeMatrix(matrix: EnvironmentMatrix): Array<{ environment: Environment; counts: Record<DiffKind | 'same', number> }> {
  return matrix.environments.slice(1).map((environment, k) => {
    const counts: Record<DiffKind | 'same', number> = { 'only-a': 0, 'only-b': 0, version: 0, replicas: 0, same: 0 };
    const tally = (reference: unknown, here: unknown, kinds: DiffKind[]): void => {
      if (reference && here && kinds.length === 0) counts.same += 1;
      for (const kind of kinds) counts[kind] += 1;
    };
    for (const row of matrix.services) tally(row.cells[0].presence, row.cells[k + 1].presence, row.cells[k + 1].kinds);
    for (const row of matrix.resources) tally(row.cells[0].resource, row.cells[k + 1].resource, row.cells[k + 1].kinds);
    return { environment, counts };
  });
}

/** Letra de la columna de un entorno en la matriz (A es la referencia); pasadas las 26, su número. */
export const columnLetter = (index: number): string => (index < 26 ? String.fromCharCode(65 + index) : String(index + 1));

const cellEscape = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Informe de la comparación de varios entornos en Markdown: una tabla de servicios y otra de recursos, y lo que difiere de la referencia en cada entorno. */
export function matrixReport(matrix: EnvironmentMatrix): string {
  const { environments } = matrix;
  const reference = environments[0];
  const head = (e: Environment, i: number): string => `${e.name} (${columnLetter(i)}${i === 0 ? ', referencia' : ''})`;
  const out = [`Comparación de ${environments.length} entornos: ${environments.map((e, i) => `«${e.name}» (${columnLetter(i)}${i === 0 ? ', referencia' : ''})`).join(', ')}`, ''];
  const marks = (kinds: DiffKind[]): string => {
    const what = [kinds.includes('version') && 'versión', kinds.includes('replicas') && 'réplicas'].filter(Boolean).join(' y ');
    return kinds.includes('only-b') ? ' (no está en la referencia)' : what ? ` ≠ ${what}` : '';
  };
  const table = (noun: string, explanation: string, rows: Array<{ label: string; cells: string[] }>): void => {
    if (rows.length === 0) return;
    out.push(`${noun} (${rows.length}): ${explanation}`, `| ${noun.replace(/s$/, '')} | ${environments.map((e, i) => cellEscape(head(e, i))).join(' | ')} |`, `|---|${environments.map(() => '---').join('|')}|`);
    for (const row of rows) out.push(`| ${cellEscape(row.label)} | ${row.cells.map(cellEscape).join(' | ')} |`);
    out.push('');
  };
  table(
    'Servicios',
    `versión y réplicas en cada entorno; «≠» marca lo que difiere de «${reference.name}»`,
    matrix.services.map((row) => ({
      label: row.service.name,
      cells: row.cells.map((c, i) => (c.presence ? `${versionText(c.presence.versions)} ×${c.presence.replicas}${marks(c.kinds)}` : row.cells[0].presence && i > 0 ? '— falta' : '—')),
    })),
  );
  const named = (row: ResourceRow): Resource => row.cells.find((c) => c.resource)!.resource!;
  table(
    'Recursos',
    `cada fila reúne los que se corresponden entre entornos; «≠» marca lo que difiere de «${reference.name}»`,
    matrix.resources.map((row) => ({
      label: `${RESOURCE_LABELS[named(row).kind]} «${named(row).name}»`,
      cells: row.cells.map((c, i) => {
        if (!c.resource) return row.cells[0].resource && i > 0 ? '— falta' : '—';
        const note = c.matchedBy && c.matchedBy !== 'name' && (c.kinds.length > 0 || c.matchedBy !== 'normalized') ? ` (${MATCH_NOTES[c.matchedBy]})` : '';
        return `«${c.resource.name}» ${c.resource.version ? `v${c.resource.version}` : 'sin versión'}${marks(c.kinds)}${note}`;
      }),
    })),
  );
  const totals = summarizeMatrix(matrix);
  const differences = totals.map(({ environment, counts }, k) => {
    const parts = [
      counts.version > 0 && `versión distinta: ${counts.version}`,
      counts.replicas > 0 && `réplicas distintas: ${counts.replicas}`,
      counts['only-a'] > 0 && `faltan: ${counts['only-a']}`,
      counts['only-b'] > 0 && `no están en la referencia: ${counts['only-b']}`,
    ].filter(Boolean);
    return `- ${environment.name} (${columnLetter(k + 1)}): ${parts.length > 0 ? `${parts.join(' · ')} · ` : 'sin diferencias · '}iguales: ${counts.same}`;
  });
  out.push(`Diferencias frente a «${reference.name}» (A)`, ...differences, '');
  const serviceCells = matrix.services.map((row) => row.cells.map((c) => ({ here: !!c.presence, kinds: c.kinds })));
  const resourceCells = matrix.resources.map((row) => row.cells.map((c) => ({ here: !!c.resource, kinds: c.kinds })));
  const identical = [...serviceCells, ...resourceCells].filter((cells) => cells.every((c) => c.here && c.kinds.length === 0)).length;
  const different = [...serviceCells, ...resourceCells].some((cells) => cells.some((c) => c.kinds.length > 0));
  out.push(different ? `Iguales en los ${environments.length} entornos: ${identical} elemento(s).` : `Los ${environments.length} entornos son equivalentes: mismos servicios, versiones y réplicas.`);
  return out.join('\n').trimEnd();
}
