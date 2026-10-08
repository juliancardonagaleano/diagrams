import { assertModuleShape, resolveModuleExport, type AnyModule } from '@iark/kernel';
import { PluginError, resolvePluginSpecifier, type ResolvedPlugin } from './resolve';

/**
 * Carga de un módulo de terceros: importa el archivo ya resuelto, normaliza lo que exporta por defecto (el módulo o una función
 * que lo construye) y comprueba que cumple el contrato `DomainModule` (`assertModuleShape`: forma, `contractVersion`, migraciones).
 * Cualquier fallo es un `PluginError` que nombra el especificador: un plugin que no carga nunca se ignora en silencio.
 *
 * Importar un módulo EJECUTA su código con los permisos del proceso. Por eso solo se llega aquí desde una configuración que la
 * persona eligió (ver `config.ts`).
 */

export interface LoadedPlugin {
  specifier: string;
  /** URL `file:` desde la que se importó. */
  url: string;
  module: AnyModule;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** `export default` de un módulo ESM; con CommonJS compilado (`exports.default = …`) llega envuelto una vez más. */
function defaultExport(namespace: Record<string, unknown>, specifier: string): unknown {
  let value = namespace.default;
  if (value === undefined) {
    throw new PluginError(specifier, 'el archivo no exporta nada por defecto: debe ser `export default defineModule({ … })` (o una función que devuelva el módulo).');
  }
  if (isRecord(value) && !('id' in value) && 'default' in value) value = value.default;
  return value;
}

/** Importa y valida un plugin ya resuelto. */
export async function importResolvedPlugin(resolved: ResolvedPlugin): Promise<LoadedPlugin> {
  const { specifier, url } = resolved;
  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missing = (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' || (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND';
    throw new PluginError(
      specifier,
      `${detail}${missing ? ' (si falta una dependencia del plugin, instálela junto a él con npm install: @iark/kernel y zod van como peerDependencies)' : ''}`,
    );
  }
  let module: unknown;
  try {
    module = await resolveModuleExport(defaultExport(namespace, specifier), specifier);
    assertModuleShape(module, specifier);
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError(specifier, (error as Error).message.replace(/^El módulo de terceros «[^»]*» /, ''));
  }
  return { specifier, url, module };
}

/**
 * `loadModulePlugin('@acme/iark-module-riesgos', { baseDir })`: resuelve el especificador desde `baseDir` (la carpeta de
 * `iark.config.json`), lo importa y lo valida. Devuelve el módulo listo para registrar.
 */
export async function loadModulePlugin(specifier: string, options: { baseDir: string }): Promise<LoadedPlugin> {
  return importResolvedPlugin(resolvePluginSpecifier(specifier, options.baseDir));
}
