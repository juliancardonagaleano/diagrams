import { contractVersionOf, ModuleRegistry } from '@iark/kernel';
import { c4Module } from '@iark/domain-c4';
import { dataModule } from '@iark/domain-data';
import { enterpriseModule } from '@iark/domain-enterprise';
import { integrationModule } from '@iark/domain-integration';
import { platformModule } from '@iark/domain-platform';
import { securityModule } from '@iark/domain-security';
import { info } from './io';
import type { LoadedConfig } from './plugins/config';
import { importResolvedPlugin } from './plugins/load';
import { PluginError, resolvePluginSpecifier, type ResolvedPlugin } from './plugins/resolve';

/** Módulo que se usa cuando no se indica `--module`. */
export const DEFAULT_MODULE = 'c4';

/**
 * Nombres que el CLI ya usa como comando de primer nivel: un módulo de terceros con uno de ellos como id colgaría su grupo de
 * comandos (`iark <módulo> …`) encima de un comando existente. Una prueba (`registry.test.ts`) comprueba que la lista no se queda
 * atrás cuando se añade un comando.
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = ['generate', 'explain', 'review', 'layout', 'convert', 'import', 'validate', 'migrate', 'schema', 'prompt', 'example', 'modules', 'serve', 'trace', 'diff', 'project', 'auth', 'accounts', 'help'];

/** Módulos que trae esta instalación del CLI. Las demás especialidades se añaden aquí al incorporarse a la suite. */
export function createDefaultRegistry(): ModuleRegistry {
  return new ModuleRegistry().register(c4Module).register(integrationModule).register(dataModule).register(enterpriseModule).register(platformModule).register(securityModule);
}

export interface CreateRegistryOptions {
  /** La configuración (`iark.config.json`) cuyos módulos de terceros se cargan además de los incorporados. */
  config?: LoadedConfig;
  /** Módulos de terceros ya resueltos (los hilos de cálculo reciben los del hilo principal en lugar de volver a leer la configuración). */
  plugins?: ResolvedPlugin[];
  /** Dónde se anota cada módulo cargado. Por omisión, stderr; los hilos de cálculo pasan una función vacía (ya lo anotó el principal). */
  log?: (message: string) => void;
}

/** Resuelve los módulos de una configuración (sin importarlos): falla con `PluginError` en el primero que no se encuentra. */
export function resolveConfigPlugins(config: LoadedConfig): ResolvedPlugin[] {
  return config.modules.map((specifier) => resolvePluginSpecifier(specifier, config.dir));
}

/**
 * Los módulos incorporados más los de terceros de la configuración, cada uno comprobado contra el contrato `DomainModule`.
 * Sin configuración equivale a `createDefaultRegistry()`. El id de un plugin no puede coincidir con el de un módulo incorporado,
 * con el de otro plugin ni con un comando del CLI: es un error, nunca una sustitución. Cada módulo cargado se anota con su origen.
 */
export async function createRegistry(options: CreateRegistryOptions = {}): Promise<ModuleRegistry> {
  const registry = createDefaultRegistry();
  const plugins = options.plugins ?? (options.config ? resolveConfigPlugins(options.config) : []);
  const log = options.log ?? info;
  for (const resolved of plugins) {
    const { module, specifier } = await importResolvedPlugin(resolved);
    if (RESERVED_COMMAND_NAMES.includes(module.id)) {
      throw new PluginError(specifier, `el id «${module.id}» es el de un comando del CLI (iark ${module.id}): elija otro id para el módulo.`);
    }
    if (registry.has(module.id)) {
      const origin = registry.originOf(module.id);
      throw new PluginError(specifier, `el id «${module.id}» ya lo usa ${origin === undefined ? 'un módulo incorporado' : `el módulo de terceros cargado desde «${origin}»`}: un módulo de terceros no puede sustituir a otro (cambie su id).`);
    }
    registry.register(module, { origin: specifier });
    log(`Módulo de terceros cargado: ${module.id} ← ${specifier} (contrato ${contractVersionOf(module)}, documento ${module.documentVersion})`);
  }
  return registry;
}
