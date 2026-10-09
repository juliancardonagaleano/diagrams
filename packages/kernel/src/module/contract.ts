import { validateMigrationChain } from './migrate';
import type { AnyModule } from './operations';

/**
 * Versión del contrato `DomainModule` (`types.ts`) que implementa este anfitrión: un entero que sube cuando el contrato cambia
 * de forma incompatible (un campo obligatorio nuevo, uno que cambia de significado). Los cambios compatibles (un campo
 * opcional) no la suben. Cada módulo declara contra qué versión se escribió con `DomainModule.contractVersion`; si lo omite, 1.
 *
 * Los nombres de este archivo (`CONTRACT_VERSION`, `isContractCompatible`, `assertModuleContract`) los importan los plugins y
 * `iark.config` (la carga de módulos externos): no se renombran sin avisar a quien los usa.
 */
export const CONTRACT_VERSION = 1;

/** La versión de contrato que se asume para un módulo que no la declara (los módulos anteriores a `contractVersion`). */
export const DEFAULT_CONTRACT_VERSION = 1;

/** La versión de contrato de `module`: la que declara o, si la omite, `DEFAULT_CONTRACT_VERSION`. */
export function contractVersionOf(module: { contractVersion?: number }): number {
  return module.contractVersion ?? DEFAULT_CONTRACT_VERSION;
}

/**
 * ¿Puede este anfitrión (que implementa `host`, por omisión `CONTRACT_VERSION`) cargar un módulo escrito para `declared`?
 * Sí si es un entero ≥ 1 y no mayor que el del anfitrión; omitido vale 1. Un contrato más antiguo se acepta: el anfitrión
 * conserva la compatibilidad hacia atrás dentro de una misma serie; uno más nuevo, no (no sabe qué exige).
 */
export function isContractCompatible(declared: number | undefined, host: number = CONTRACT_VERSION): boolean {
  const version = declared ?? DEFAULT_CONTRACT_VERSION;
  return Number.isInteger(version) && version >= 1 && version <= host;
}

/**
 * Comprueba que `module` cumple lo que el anfitrión exige para cargarlo, y lanza un `Error` en español que dice qué falla
 * si no: un `contractVersion` que no es un entero ≥ 1 o es mayor que `CONTRACT_VERSION`, o una cadena de migraciones con
 * huecos o ciclos, o que no termina en su `documentVersion`. `ModuleRegistry.register` lo llama.
 */
export function assertModuleContract(module: AnyModule): void {
  const declared = module.contractVersion;
  if (declared !== undefined && (!Number.isInteger(declared) || declared < 1)) {
    throw new Error(`El módulo «${module.id}» declara un contractVersion inválido (${String(declared)}): debe ser un entero mayor o igual que 1.`);
  }
  if (!isContractCompatible(declared)) {
    throw new Error(
      `El módulo «${module.id}» se escribió para la versión ${declared} del contrato DomainModule y este DIAgrams implementa la ${CONTRACT_VERSION}: ` +
        'actualiza DIAgrams o usa una versión del módulo escrita para el contrato anterior.',
    );
  }
  const problems = validateMigrationChain(module.documentVersion, module.migrations ?? []);
  if (problems.length > 0) {
    throw new Error(`El módulo «${module.id}» declara migraciones de documento inválidas: ${problems.join(' ')}`);
  }
}
