import { pickId } from '@iark/kernel';
import type { EnvironmentKind } from '../types';
import { environmentKind, slug } from './fromMermaid';

/** Opciones de los importadores de infraestructura (Terraform, Kubernetes): además del nombre, la ruta del archivo de origen. */
export interface InfraImportOptions {
  name?: string;
  fallbackName?: string;
  /** Ruta (o solo el nombre) del archivo de origen. */
  file?: string;
  /** Nombre del chart de Helm que generó los manifiestos (`helm template`): da nombre a lo importado cuando el archivo no lo hace. */
  chart?: string;
}

/** Nombres de archivo y de carpeta que no dicen nada del sistema: se usa entonces el de la carpeta que los contiene. */
const GENERIC_NAMES = new Set([
  'main', 'terraform', 'tfstate', 'state', 'plan', 'default', 'all', 'index', 'resources', 'stack', 'infra', 'infrastructure', 'output', 'show',
  'manifest', 'manifests', 'k8s', 'kubernetes', 'kube', 'deployment', 'deployments', 'deploy', 'app', 'apps', 'base', 'overlay', 'rendered', 'stdin',
  'get-all', 'all-resources', 'export', 'dump', 'cluster', 'kustomize', 'helm', 'chart', 'values', 'requirements',
]);

const EXTENSIONS = /\.(?:tf\.json|tfstate(?:\.backup)?|tf|json|ya?ml|txt)$/i;

const tidy = (s: string): string => s.replace(EXTENSIONS, '').replace(EXTENSIONS, '').trim();

/**
 * Nombre con el que se identifica lo importado: el del archivo (sin extensión) o, si es genérico (`main.tf`, `manifests.yaml`),
 * el de la carpeta que lo contiene; si no hay carpeta, el nombre genérico tal cual. Sin archivo, `fallbackName`.
 */
export function sourceName(options: InfraImportOptions): string | undefined {
  const parts = (options.file ?? '').split(/[\\/]+/).filter((p) => p !== '' && p !== '.' && p !== '..');
  const file = parts.pop();
  if (file) {
    const base = tidy(file);
    if (base && !GENERIC_NAMES.has(slug(base))) return base;
    const dir = parts.pop();
    if (dir && !GENERIC_NAMES.has(slug(dir))) return dir;
    if (base) return base;
  }
  const fallback = options.fallbackName ? tidy(options.fallbackName) : '';
  return fallback || undefined;
}

/**
 * Como `sourceName`, pero solo si el origen dice algo del sistema: `undefined` si el archivo, su carpeta y el nombre de reserva son
 * genéricos (`rendered.yaml`, `stdin`) o no hay ninguno. Sirve para decidir si otra fuente (el chart de Helm) da mejor nombre.
 */
export function descriptiveName(options: InfraImportOptions): string | undefined {
  const parts = (options.file ?? '').split(/[\\/]+/).filter((p) => p !== '' && p !== '.' && p !== '..');
  const file = parts.pop();
  if (file) {
    const base = tidy(file);
    if (base && !GENERIC_NAMES.has(slug(base))) return base;
    const dir = parts.pop();
    if (dir && !GENERIC_NAMES.has(slug(dir))) return dir;
  }
  const fallback = options.fallbackName ? tidy(options.fallbackName) : '';
  return fallback && !GENERIC_NAMES.has(slug(fallback)) ? fallback : undefined;
}

const KIND_WORDS: Array<[EnvironmentKind, RegExp]> = [
  ['dr', /^(?:dr|disaster)$/],
  ['staging', /^(?:stag|stage|staging|preprod|preproduction|uat|pre)$/],
  ['test', /^(?:test|testing|qa|pruebas|integration)$/],
  ['dev', /^(?:dev|develop|development|desarrollo)$/],
  ['prod', /^(?:prod|prd|production|produccion|live)$/],
];

/** Tipo de un entorno por su nombre: el nombre entero (`production`) o alguna de sus palabras (`shop-prod`, `eu_staging`). */
export function environmentKindOf(name: string): EnvironmentKind | undefined {
  const whole = environmentKind(name);
  if (whole) return whole;
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const [kind, re] of KIND_WORDS) if (words.some((w) => re.test(w))) return kind;
  return undefined;
}

/** Id estable a partir de una base legible; si ya existe, se antepone `prefix` (el tipo) antes de recurrir al sufijo numérico. */
export function uniqueId(base: string, prefix: string, taken: Set<string>): string {
  const root = slug(base) || slug(prefix) || 'elemento';
  if (!taken.has(root)) return pickId(root, taken);
  return pickId(slug(`${prefix}-${root}`) || root, taken);
}

/** `a ×3, b, c` con un tope de elementos (el resto se resume como «…»). */
export function countedList(items: string[], limit = 12): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  const entries = [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  return entries.length > limit ? `${entries.slice(0, limit).join(', ')}, … (${entries.length - limit} más)` : entries.join(', ');
}

/** `a, b, c` con un tope de elementos. */
export function shortList(items: string[], limit = 8): string {
  return items.length > limit ? `${items.slice(0, limit).join(', ')}, … (${items.length - limit} más)` : items.join(', ');
}

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
