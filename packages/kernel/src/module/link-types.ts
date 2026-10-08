import { z } from 'zod';
import type { FieldSpec } from './editor';

/**
 * Tipos de enlace de la trazabilidad. Un elemento que apunta a otro con `ref` puede decir además de qué clase es el enlace con
 * `refType` (`implements`, `protects`…). El vocabulario es abierto: lo de aquí es lo sugerido por la suite y el que entienden
 * las superficies (selector del banco de trabajo, etiquetas de las aristas), pero un tercero puede usar el suyo mientras
 * respete la forma `[a-z][a-z0-9-]*`. Un tipo fuera del vocabulario se acepta y solo se anota como aviso informativo.
 */

/** Tipo de un enlace que no declara `refType`. */
export const DEFAULT_LINK_TYPE = 'depends-on';

/** Forma de un tipo de enlace: minúsculas, dígitos y guiones, empezando por letra (como los ids de módulo). */
export const LINK_TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Tope de longitud: un tipo es una etiqueta de arista, no un texto libre. */
export const MAX_LINK_TYPE_LENGTH = 40;

export interface LinkTypeInfo {
  id: string;
  /** Una línea, leída como «origen <tipo> destino». */
  description: string;
}

/** El vocabulario sugerido, en el orden en que se ofrece. El primero es el valor por omisión. */
export const TRACE_LINK_TYPES: readonly LinkTypeInfo[] = [
  { id: DEFAULT_LINK_TYPE, description: 'El origen se apoya en el destino (valor por omisión cuando no se declara tipo).' },
  { id: 'implements', description: 'El origen implementa al destino: la pieza concreta frente a lo que lleva a cabo (un servicio de plataforma y el sistema de integración).' },
  { id: 'deploys', description: 'El origen despliega al destino: lo aloja o lo ejecuta (un recurso de plataforma y el nodo que corre en él).' },
  { id: 'protects', description: 'El origen protege al destino: el activo o control de seguridad que cubre a un elemento.' },
  { id: 'realizes', description: 'El origen realiza al destino: lo hace efectivo en otra capa (una aplicación empresarial y el sistema que la materializa).' },
  { id: 'derives', description: 'El origen se deriva del destino: nace de él o lo toma como fuente (un nodo de integración generado desde un contenedor C4).' },
  { id: 'documents', description: 'El origen documenta o describe al destino (un inventario, una ficha o un catálogo).' },
];

/** ¿Tiene la forma de un tipo de enlace (la que exige el esquema de `refType`)? */
export function isValidLinkType(type: string): boolean {
  return type.length <= MAX_LINK_TYPE_LENGTH && LINK_TYPE_PATTERN.test(type);
}

/** ¿Está en el vocabulario sugerido? Los demás se aceptan, con un aviso informativo. */
export function isSuggestedLinkType(type: string): boolean {
  return TRACE_LINK_TYPES.some((t) => t.id === type);
}

/** Esquema de `refType`, que comparten los esquemas de los seis módulos junto a su `ref`. */
export const refTypeSchema = z
  .string()
  .max(MAX_LINK_TYPE_LENGTH, `El tipo de enlace admite como mucho ${MAX_LINK_TYPE_LENGTH} caracteres.`)
  .regex(LINK_TYPE_PATTERN, 'El tipo de enlace usa minúsculas, dígitos y guiones, y empieza por una letra (p. ej. «implements»).')
  .describe(
    `Tipo del enlace que declara \`ref\` (vocabulario abierto; sugeridos: ${TRACE_LINK_TYPES.map((t) => t.id).join(', ')}). Sin él, el enlace es «${DEFAULT_LINK_TYPE}».`,
  );

/**
 * El campo del formulario de un elemento para su `refType`, junto al de `ref`. El banco de trabajo lo sustituye por un selector
 * (el vocabulario sugerido más el tipo que ya tenga el elemento); en cualquier otro panel es un campo de texto.
 */
export const REF_TYPE_FIELD: FieldSpec = { key: 'refType', label: 'Tipo de enlace', type: 'text', hint: `${TRACE_LINK_TYPES.map((t) => t.id).join(' · ')} · o uno propio` };
