import { assertModuleContract } from './contract';
import type { AnyModule } from './operations';
import type { DomainModule } from './types';
import { parseMajorMinor } from './version';

/**
 * Lo que necesita quien escribe un módulo de terceros (un paquete npm o un archivo `.mjs`/`.js` cuyo `default` es un
 * `DomainModule`) y lo que comprueba el anfitrión antes de aceptarlo. Es código sin entrada/salida: leer la configuración,
 * resolver el paquete e importarlo es cosa del CLI (`src/cli/plugins/`), porque el kernel no toca el sistema de archivos.
 */

/** Forma de un identificador de módulo: forma parte de las URN, de la ruta de la API y del nombre del grupo de comandos. */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Declara un módulo de terceros. Es la identidad: no hace nada en ejecución, pero fija el tipo del documento a partir del
 * `schema` y comprueba el módulo contra `DomainModule` mientras se escribe (con JSDoc también sirve en JavaScript).
 *
 * ```ts
 * import { defineModule } from '@iark/kernel';
 * export default defineModule({ id: 'risk', name: 'Riesgos', version: '1.0.0', documentVersion: '1.0', schema, jsonSchema, validate, importers: [], exporters: [] });
 * ```
 */
export function defineModule<TDoc>(module: DomainModule<TDoc>): DomainModule<TDoc> {
  return module;
}

/** Una fábrica de módulo: el `default` de un plugin puede ser una función (síncrona o asíncrona) que lo construye al cargarlo. */
export type ModuleFactory<TDoc = unknown> = () => DomainModule<TDoc> | Promise<DomainModule<TDoc>>;

/** Lo que exporta por defecto un plugin: el módulo o una fábrica que lo devuelve. */
export type ModulePluginExport<TDoc = unknown> = DomainModule<TDoc> | ModuleFactory<TDoc>;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Normaliza lo que exporta un plugin: un módulo se devuelve tal cual y una fábrica se ejecuta (y se espera si es asíncrona).
 * `origin` es cómo se llama el plugin en los mensajes (el especificador de la configuración). No valida la forma del módulo:
 * eso es `assertModuleShape`.
 */
export async function resolveModuleExport(exported: unknown, origin: string): Promise<unknown> {
  if (typeof exported !== 'function') return exported;
  try {
    return await (exported as () => unknown)();
  } catch (error) {
    throw new Error(`La fábrica de módulo que exporta «${origin}» falló al construirlo: ${describeError(error)}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isFn = (value: unknown): boolean => typeof value === 'function';
const isExtension = (value: unknown): boolean => typeof value === 'string' && /^\.[^\s.]/.test(value) && value === value.toLowerCase();

/** Lista de comprobaciones de una colección de elementos con `id` (importadores, exportadores…): cada uno con su forma y sin repetir `id`. */
function checkCollection(problems: string[], label: string, key: string, items: unknown, check: (item: Record<string, unknown>, name: string) => void): void {
  if (!Array.isArray(items)) {
    problems.push(`«${label}» debe ser una lista (puede ir vacía)`);
    return;
  }
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`${label}[${index}] debe ser un objeto`);
      return;
    }
    const id = item[key];
    const name = isText(id) ? `${label} «${id}»` : `${label}[${index}]`;
    if (!isText(id)) problems.push(`${name} no tiene «${key}» (una cadena no vacía)`);
    else if (seen.has(id)) problems.push(`${label} repite el ${key} «${id}»`);
    else seen.add(id);
    check(item, name);
  });
}

/**
 * Comprueba que lo que importó el anfitrión de un plugin es un `DomainModule` utilizable y lanza un `Error` en español que
 * nombra el plugin (`origin`) y lista TODO lo que falla, no solo lo primero: un id inválido, un campo obligatorio ausente,
 * `schema` sin `safeParse`, importadores o exportadores mal formados, `contractVersion` mayor que el del anfitrión
 * (`assertModuleContract`) o una cadena de migraciones rota. Además llama a `jsonSchema()` una vez: un plugin cuyo esquema no
 * se puede describir fallaría más tarde, en `iark schema` o en la API, lejos de su causa.
 */
export function assertModuleShape(module: unknown, origin: string): asserts module is AnyModule {
  const head = `El módulo de terceros «${origin}» no cumple el contrato DomainModule`;
  if (!isRecord(module)) {
    throw new Error(
      `${head}: lo que exporta por defecto no es un módulo (es ${module === undefined ? 'undefined' : Array.isArray(module) ? 'una lista' : typeof module}). ` +
        'Debe ser un DomainModule o una función que lo devuelva: `export default defineModule({ … })`.',
    );
  }
  const problems: string[] = [];
  if (!isText(module.id) || !MODULE_ID_PATTERN.test(module.id)) {
    problems.push(`«id» debe ser un identificador en minúsculas (letras, dígitos y guiones, empezando por una letra) y es ${JSON.stringify(module.id)}`);
  }
  if (!isText(module.name)) problems.push('falta «name» (el nombre legible)');
  if (!isText(module.version)) problems.push('falta «version» (la versión del módulo, p. ej. «1.0.0»)');
  if (!isText(module.documentVersion) || !parseMajorMinor(module.documentVersion)) {
    problems.push(`«documentVersion» debe ser «mayor.menor» (p. ej. «1.0») y es ${JSON.stringify(module.documentVersion)}`);
  }
  if (!isRecord(module.schema) || !isFn(module.schema.safeParse)) problems.push('«schema» debe ser un esquema de zod (con safeParse)');
  if (!isFn(module.jsonSchema)) problems.push('falta «jsonSchema» (una función que devuelve el JSON Schema del documento)');
  if (!isFn(module.validate)) problems.push('falta «validate» (una función que devuelve las incidencias del documento)');
  checkCollection(problems, 'importers', 'id', module.importers, (item, name) => {
    if (!isText(item.label)) problems.push(`${name} no tiene «label»`);
    if (!Array.isArray(item.extensions) || !item.extensions.every(isExtension)) problems.push(`${name}: «extensions» debe ser una lista de extensiones en minúsculas con punto (p. ej. «.csv»)`);
    if (!isFn(item.import)) problems.push(`${name} no tiene la función «import»`);
    if (item.detect !== undefined && !isFn(item.detect)) problems.push(`${name}: «detect» debe ser una función`);
  });
  checkCollection(problems, 'exporters', 'id', module.exporters, (item, name) => {
    if (!isText(item.label)) problems.push(`${name} no tiene «label»`);
    if (!isExtension(item.extension)) problems.push(`${name}: «extension» debe ser una extensión en minúsculas con punto (p. ej. «.md»)`);
    if (!isText(item.mime)) problems.push(`${name} no tiene «mime»`);
    if (!isFn(item.export)) problems.push(`${name} no tiene la función «export»`);
  });
  for (const key of ['entities', 'views'] as const) {
    if (module[key] !== undefined && !isFn(module[key])) problems.push(`«${key}» debe ser una función`);
  }
  if (module.traceViews !== undefined) {
    checkCollection(problems, 'traceViews', 'prefix', module.traceViews, (item, name) => {
      if (!isText(item.label)) problems.push(`${name} no tiene «label»`);
    });
  }
  if (module.cliCommands !== undefined) {
    checkCollection(problems, 'cliCommands', 'name', module.cliCommands, (item, name) => {
      if (isText(item.name) && !MODULE_ID_PATTERN.test(item.name)) problems.push(`${name}: el nombre del comando debe ser en minúsculas (letras, dígitos y guiones)`);
      if (!isText(item.description)) problems.push(`${name} no tiene «description»`);
      if (!isFn(item.run)) problems.push(`${name} no tiene la función «run»`);
    });
  }
  if (module.ai !== undefined) {
    const ai = module.ai;
    if (!isRecord(ai) || !['generationJsonSchema', 'system', 'user', 'retry', 'toDocument'].every((key) => isFn(ai[key])) || !isRecord(ai.generationSchema)) {
      problems.push('«ai» debe traer generationSchema y las funciones generationJsonSchema, system, user, retry y toDocument');
    }
  }
  if (problems.length > 0) throw new Error(`${head}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  // Con la forma correcta, lo que exige el registro (versión del contrato y cadena de migraciones) y una llamada de prueba a jsonSchema().
  try {
    assertModuleContract(module as unknown as AnyModule);
  } catch (error) {
    throw new Error(`${head}: ${describeError(error)}`);
  }
  try {
    const jsonSchema = (module.jsonSchema as () => unknown)();
    if (!isRecord(jsonSchema)) throw new Error(`devolvió ${jsonSchema === undefined ? 'undefined' : typeof jsonSchema} en vez de un objeto`);
  } catch (error) {
    throw new Error(`${head}: jsonSchema() falló: ${describeError(error)}`);
  }
}
