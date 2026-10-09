/** Marca de los `ModuleError` entre copias del kernel: ver `ModuleError[Symbol.hasInstance]`. */
const MODULE_ERROR_BRAND = Symbol.for('iark.ModuleError');

/**
 * Error de uso de un módulo (una entrada que no se puede importar, un activo que no existe…). Los módulos lo extienden
 * para sus propios errores: el CLI lo muestra como un mensaje de una línea, sin stack ni «error inesperado».
 *
 * Un módulo de terceros importa `@iark/kernel` de SU instalación, que no es la copia empaquetada dentro del CLI: dos clases
 * `ModuleError` distintas, y un `instanceof` que dejaría sin reconocer el error de un plugin (saldría como «error inesperado»
 * en vez de un mensaje de uso). Por eso `instanceof ModuleError` también reconoce, por la marca `Symbol.for('iark.ModuleError')`
 * (la misma en todas las copias), a los errores de otra copia. Las subclases conservan el `instanceof` normal.
 */
export class ModuleError extends Error {
  readonly [MODULE_ERROR_BRAND] = true;

  constructor(message: string) {
    super(message);
    this.name = 'ModuleError';
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return this === ModuleError && value instanceof Error && (value as unknown as Record<symbol, unknown>)[MODULE_ERROR_BRAND] === true;
  }
}
