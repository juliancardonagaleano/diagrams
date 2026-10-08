import { assertModuleContract } from './contract';
import { MODULE_ID_PATTERN } from './plugin';
import type { DomainModule, Importer } from './types';

export class UnknownModuleError extends Error {
  constructor(id: string, available: string[]) {
    super(`No existe el módulo «${id}». Módulos disponibles: ${available.length > 0 ? available.join(', ') : '(ninguno)'}.`);
    this.name = 'UnknownModuleError';
  }
}

/** Conjunto de módulos cargados en una instancia (CLI, app o servicio). */
export class ModuleRegistry {
  private modules = new Map<string, DomainModule<any>>();
  /** De dónde viene cada módulo que no es incorporado (el especificador del plugin que lo aportó); los incorporados no figuran. */
  private origins = new Map<string, string>();

  /**
   * Registra un módulo. Falla si su id es inválido o está repetido, si se escribió para un contrato `DomainModule` más nuevo que
   * el del anfitrión o si su cadena de migraciones de documento tiene huecos o ciclos (ver `assertModuleContract`). `origin` anota
   * de dónde viene un módulo de terceros (su especificador en `iark.config.json`) para `originOf`; los incorporados no lo llevan.
   */
  register<TDoc>(module: DomainModule<TDoc>, options: { origin?: string } = {}): this {
    if (!MODULE_ID_PATTERN.test(module.id)) throw new Error(`Identificador de módulo inválido: «${module.id}».`);
    assertModuleContract(module);
    if (this.modules.has(module.id)) throw new Error(`El módulo «${module.id}» ya está registrado.`);
    this.modules.set(module.id, module);
    if (options.origin !== undefined) this.origins.set(module.id, options.origin);
    return this;
  }

  /** El especificador del plugin que aportó el módulo, o `undefined` si es incorporado (o no existe). */
  originOf(id: string): string | undefined {
    return this.origins.get(id);
  }

  has(id: string): boolean {
    return this.modules.has(id);
  }

  get(id: string): DomainModule<any> | undefined {
    return this.modules.get(id);
  }

  /** Como `get`, pero falla con un mensaje que lista los módulos disponibles. */
  require(id: string): DomainModule<any> {
    const module = this.modules.get(id);
    if (!module) throw new UnknownModuleError(id, this.ids());
    return module;
  }

  ids(): string[] {
    return [...this.modules.keys()];
  }

  list(): Array<DomainModule<any>> {
    return [...this.modules.values()];
  }

  /**
   * Importador de un módulo para un archivo: primero por extensión y, si no basta (stdin, extensión desconocida),
   * por el contenido. Devuelve `undefined` si ninguno lo reconoce.
   */
  detectImporter<TDoc>(moduleId: string, file: string | undefined, text: string): Importer<TDoc> | undefined {
    const importers = this.require(moduleId).importers as Array<Importer<TDoc>>;
    const ext = file ? /\.[^./\\]+$/.exec(file.toLowerCase())?.[0] : undefined;
    const byExt = ext ? importers.find((i) => i.extensions.includes(ext)) : undefined;
    // Una extensión conocida manda: si el contenido no encaja, el importador explica por qué (mejor que «formato desconocido»).
    return byExt ?? importers.find((i) => i.detect?.(text));
  }
}
