/**
 * Lectura común de los importadores de contratos (OpenAPI y AsyncAPI): texto → árbol JSON, con los topes de tamaño y de
 * profundidad que comparten todos los importadores, y resolución de `$ref` solo internos (`#/…`). Nada de red ni de disco:
 * una referencia a otro archivo o a una URL no se sigue, se cuenta para avisarlo.
 *
 * El servicio ejecuta `import` sobre entrada no confiable, así que aquí se cierran las vías clásicas de abuso: YAML solo con la
 * librería `yaml` (sin etiquetas propias, con el tope de alias por defecto contra las «bombas» de alias), JSON con
 * `JSON.parse`, tamaño y profundidad acotados y recorridos con pila propia.
 */
import { IMPORT_LIMITS, textSizeProblem, treeProblem } from '@iark/kernel';
import { isRecord, stripBom } from '../contracts/json';
import { parseStructured, resolveLocalRef } from '../contracts/shared';
import { IntegrationImportError } from './fromMermaid';

export type Json = Record<string, unknown>;

export const rec = (v: unknown): Json | undefined => (isRecord(v) ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Texto no vacío y recortado; un número o un booleano (YAML sin comillas) se convierte a texto. */
export const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
};

export type SpecKind = 'openapi' | 'swagger' | 'asyncapi';

/**
 * Qué contrato parece el texto, mirando solo el campo raíz (`openapi: 3.x`, `swagger: 2.x`, `asyncapi: 2.x|3.x`) y sin
 * recorrer el resto. El JSON se analiza (la clave puede ir en cualquier posición); en YAML basta la clave en la columna 0.
 * Es la parte fiable de `detect`: dos contratos o un JSON cualquiera no se confunden.
 */
export function specKind(text: string): SpecKind | undefined {
  if (text.length > IMPORT_LIMITS.maxChars) return undefined;
  const head = stripBom(text);
  const classify = (key: string, value: string): SpecKind | undefined => {
    if (key === 'openapi') return /^3(?:\.|$)/.test(value) ? 'openapi' : undefined;
    if (key === 'swagger') return /^2(?:\.|$)/.test(value) ? 'swagger' : undefined;
    return /^[23](?:\.|$)/.test(value) ? 'asyncapi' : undefined;
  };
  if (/^\s*[{[]/.test(head)) {
    if (!/"(?:openapi|swagger|asyncapi)"/.test(head)) return undefined;
    try {
      const root = rec(JSON.parse(head));
      for (const key of ['openapi', 'swagger', 'asyncapi'] as const) {
        const value = str(root?.[key]);
        const kind = value ? classify(key, value) : undefined;
        if (kind) return kind;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  const match = /^(openapi|swagger|asyncapi)[ \t]*:[ \t]*(["']?)(\d[\w.-]*)\2[ \t]*(?:#.*)?$/m.exec(head);
  return match ? classify(match[1], match[3]) : undefined;
}

export interface SpecSource {
  /** Árbol analizado (la raíz es siempre un objeto). */
  root: Json;
  /** Texto original, sin la marca de orden de bytes. */
  text: string;
}

/**
 * Lee un contrato (JSON o YAML) con los topes comunes. Falla con un `IntegrationImportError` de una línea si el texto está
 * vacío, es demasiado grande o profundo, no se puede analizar (con línea y columna) o su raíz no es un objeto. `label` es el
 * nombre del formato para los mensajes («OpenAPI»).
 */
export function readSpec(source: string, label: string): SpecSource {
  const text = stripBom(source);
  if (text.trim() === '') throw new IntegrationImportError(`El archivo de ${label} está vacío.`);
  const big = textSizeProblem(text, `El archivo de ${label}`);
  if (big) throw new IntegrationImportError(big);
  let parsed: ReturnType<typeof parseStructured>;
  try {
    parsed = parseStructured(text, true);
  } catch (error) {
    // Un anidamiento enorme agota la pila del analizador antes de que el recorrido propio lo mida.
    if (error instanceof RangeError) throw new IntegrationImportError(`El archivo de ${label} está demasiado anidado para analizarlo.`);
    throw error;
  }
  if (!parsed.ok) {
    // El analizador YAML recoge su propio desbordamiento de pila como un error de sintaxis: se dice con su nombre.
    if (/call stack|anidamiento excesivo/i.test(parsed.message)) throw new IntegrationImportError(`El archivo de ${label} está demasiado anidado para analizarlo.`);
    const reason = parsed.message.replace(/[.\s]+$/, '');
    throw new IntegrationImportError(`El archivo de ${label} no se puede leer (línea ${parsed.line}, columna ${parsed.column}): ${reason}.`);
  }
  const deep = treeProblem(parsed.value, `El contrato de ${label}`);
  if (deep) throw new IntegrationImportError(deep);
  if (!isRecord(parsed.value)) {
    const what = Array.isArray(parsed.value) ? 'una lista' : parsed.value === null ? 'vacío' : `un valor de tipo ${typeof parsed.value}`;
    throw new IntegrationImportError(`El archivo de ${label} es ${what}: se esperaba un objeto (mapa) con los campos del contrato.`);
  }
  return { root: parsed.value, text };
}

/** Los `$ref` que una importación no pudo resolver, por motivo. */
export interface RefReport {
  external: string[];
  broken: string[];
  cyclic: string[];
}

/**
 * Sigue cadenas de `$ref` internos con control de ciclos y de profundidad. Una referencia a otro archivo o a una URL
 * (`other.yaml#/X`, `https://…`) no se sigue nunca; una que no existe o que da vueltas sobre sí misma se anota. Ninguna lanza.
 */
export class RefResolver {
  private readonly external = new Set<string>();
  private readonly broken = new Set<string>();
  private readonly cyclic = new Set<string>();

  constructor(
    private readonly root: unknown,
    /** Saltos máximos en una cadena de referencias (`a → b → c…`). */
    private readonly maxHops = 32,
  ) {}

  /** El valor al que lleva `node` si es una referencia (siguiendo la cadena); `node` mismo si no lo es; `undefined` si no se puede resolver. */
  resolve(node: unknown): unknown {
    let current = node;
    const seen = new Set<string>();
    for (let hop = 0; hop <= this.maxHops; hop += 1) {
      const ref = isRecord(current) && typeof current.$ref === 'string' ? current.$ref : undefined;
      if (ref === undefined) return current;
      if (!ref.startsWith('#')) {
        this.external.add(ref);
        return undefined;
      }
      if (seen.has(ref)) {
        this.cyclic.add(ref);
        return undefined;
      }
      seen.add(ref);
      const target = resolveLocalRef(this.root, ref);
      if (target === undefined) {
        this.broken.add(ref);
        return undefined;
      }
      current = target;
    }
    this.cyclic.add([...seen][0] ?? '#');
    return undefined;
  }

  report(): RefReport {
    return { external: [...this.external].sort(), broken: [...this.broken].sort(), cyclic: [...this.cyclic].sort() };
  }
}

/** Último segmento de una referencia (`#/components/schemas/Pet` → `Pet`), con los escapes de JSON Pointer deshechos. */
export function refName(ref: string): string {
  const last = ref.slice(ref.lastIndexOf('/') + 1);
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Claves cuyo contenido es un dato de ejemplo y no estructura: no se recorren buscando referencias. */
const DATA_KEYS = new Set(['example', 'examples', 'default', 'enum', 'const', 'x-examples']);

/**
 * Nombres de los esquemas con nombre (`#/components/schemas/X`, `#/definitions/X`, `#/components/messages/X`) que alcanza `start`
 * siguiendo referencias internas, en el orden en que aparecen (primero los directos). Recorrido con pila propia, con un
 * `visited` compartido para que un mismo esquema no se recorra dos veces (así un grafo con ciclos o con muchos rombos cuesta
 * lo que tiene de nodos) y un presupuesto de pasos para que una entrada enorme no se coma el proceso.
 */
export function reachableNames(
  resolver: RefResolver,
  starts: unknown[],
  prefixes: readonly string[],
  state: { visited: Set<string>; budget: number },
  max = 30,
): string[] {
  const names: string[] = [];
  const stack: unknown[] = [...starts].reverse();
  while (stack.length > 0 && state.budget > 0) {
    const node = stack.pop();
    state.budget -= 1;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }
    if (!isRecord(node)) continue;
    const ref = typeof node.$ref === 'string' ? node.$ref : undefined;
    if (ref !== undefined) {
      if (state.visited.has(ref)) continue;
      state.visited.add(ref);
      if (prefixes.some((p) => ref.startsWith(p)) && names.length < max) names.push(refName(ref));
      const target = resolver.resolve(node);
      if (target !== undefined && target !== node) stack.push(target);
      continue;
    }
    const children = Object.entries(node).filter(([key]) => !DATA_KEYS.has(key));
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i][1]);
  }
  return names;
}

/** Quita de una URL las credenciales (`https://usuario:clave@host`) y la corta si es muy larga: un contrato no debe filtrar secretos al documento. */
export function cleanUrl(url: string): string {
  const withoutUser = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
  return withoutUser.length > 200 ? `${withoutUser.slice(0, 197)}…` : withoutUser;
}

/** Sustituye las `{variables}` de una URL por su valor por defecto cuando el contrato lo declara. */
export function fillVariables(url: string, variables: unknown): string {
  const vars = rec(variables);
  if (!vars) return url;
  return url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const def = Object.hasOwn(vars, name) ? str(rec(vars[name])?.default) : undefined;
    return def ?? whole;
  });
}

/** Primer párrafo de un texto, en una sola línea y con un tope de longitud. */
export function brief(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const first = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (first === '') return undefined;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** `a, b, c` con un tope de elementos; el resto se resume como «… (n más)». */
export function shortList(items: string[], limit = 8): string {
  return items.length > limit ? `${items.slice(0, limit).join(', ')}, … (${items.length - limit} más)` : items.join(', ');
}

/** Id legible a partir de un nombre (sin tildes, en minúsculas y con guiones), como el de los demás importadores. */
export const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Resume en avisos los `$ref` que no se pudieron resolver. */
export function refWarnings(report: RefReport): string[] {
  const out: string[] = [];
  if (report.external.length > 0) {
    out.push(`${report.external.length} referencia(s) «$ref» a otros archivos o URL no se siguen (por seguridad el importador no lee de la red ni del disco): ${shortList(report.external, 5)}.`);
  }
  if (report.broken.length > 0) out.push(`${report.broken.length} referencia(s) «$ref» apuntan a algo que no existe en el documento: ${shortList(report.broken, 5)}.`);
  if (report.cyclic.length > 0) out.push(`${report.cyclic.length} referencia(s) «$ref» dan vueltas sobre sí mismas y se cortaron: ${shortList(report.cyclic, 5)}.`);
  return out;
}
