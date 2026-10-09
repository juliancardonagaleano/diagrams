import { z } from 'zod';
import { EMBED_PROTOCOL_VERSION } from '@iark/kernel/protocol';

/**
 * Protocolo postMessage de los módulos de la suite (`modulos.html?embed=1&proto=json&module=<id>`). Es el hermano del
 * protocolo del editor C4 (`protocol.ts`): mismo formato de mensajes (`action` del anfitrión al iframe, `event` del iframe
 * al anfitrión, JSON serializado), pero el documento es el de cualquier módulo (`unknown`) y se añaden dos ideas:
 *
 * - `module`: qué especialidad se abre (`integration`, `data`, `enterprise`, `platform`, `security`…).
 * - `capabilities`: lo que ofrece la instancia (módulos, formatos de importación y exportación, vistas de traza, informes),
 *   en el evento `init` y bajo demanda con la acción `capabilities`. El anfitrión no necesita conocer el interior de ningún módulo.
 *
 * La versión sube de forma compatible: los campos nuevos son opcionales y un evento desconocido se ignora. Es la misma
 * del protocolo del editor C4 (`EMBED_PROTOCOL_VERSION`, `mayor.menor`): el `init` del iframe y el primer `load` del
 * anfitrión la llevan en `version`, cada lado la compara con la suya (`negotiateProtocol`) y, si la mayor difiere, emite un
 * `error` con `code: 'incompatible-protocol'` en vez de funcionar a medias. Un lado que no la declara habla 1.0.
 */
export const MODULE_PROTOCOL_VERSION = EMBED_PROTOCOL_VERSION;

/** Documento de un módulo: el objeto o su texto JSON. */
const documentValue = z.union([z.record(z.string(), z.unknown()), z.string()]);

// ───────────── anfitrión → iframe (action) ─────────────

export const moduleLoadActionSchema = z.object({
  action: z.literal('load'),
  /** Versión del protocolo (`mayor.menor`) que habla el anfitrión; el SDK la añade siempre. Omitida vale 1.0. */
  version: z.string().optional(),
  /** Módulo a abrir; si se omite, el que indicó la URL o el que ya está abierto. */
  module: z.string().optional(),
  /** Documento del módulo. Con `importer`, el texto en ese otro formato. Si se omite, se abre en blanco. */
  document: documentValue.optional(),
  /** Formato de `document` cuando no es JSON del módulo (`mermaid`…): se importa con ese importador. */
  importer: z.string().optional(),
  autosave: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  viewId: z.string().optional(),
});

export const moduleConfigureActionSchema = z.object({
  action: z.literal('configure'),
  theme: z.enum(['light', 'dark']).optional(),
  /** `min` oculta la marca y las pestañas de módulos (el anfitrión ya eligió el módulo) y conserva las acciones. */
  ui: z.enum(['full', 'min']).optional(),
});

export const moduleSetViewActionSchema = z.object({ action: z.literal('setView'), viewId: z.string() });

export const moduleExportActionSchema = z.object({
  action: z.literal('export'),
  /** `json` o el id de un exportador del módulo (`mermaid`, `svg`, `drawio`…; ver `capabilities`). */
  format: z.string(),
  viewId: z.string().optional(),
  requestId: z.string().optional(),
});

export const moduleValidateActionSchema = z.object({ action: z.literal('validate'), requestId: z.string().optional() });

export const moduleRunActionSchema = z.object({
  action: z.literal('run'),
  /** Informe o conversión del módulo (los mismos que `iark <módulo> <comando>`). */
  command: z.string(),
  args: z.array(z.string()).optional(),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  /** Documento de entrada; por defecto, el del editor. Las conversiones (`from-*`) reciben aquí el documento de origen. */
  input: documentValue.optional(),
  requestId: z.string().optional(),
});

export const moduleCapabilitiesActionSchema = z.object({
  action: z.literal('capabilities'),
  /** Módulos de los que se piden las capacidades; por defecto, todos. */
  modules: z.array(z.string()).optional(),
  requestId: z.string().optional(),
});

export const moduleStatusActionSchema = z.object({ action: z.literal('status'), message: z.string(), modified: z.boolean().optional() });
export const moduleDialogActionSchema = z.object({ action: z.literal('dialog'), title: z.string(), message: z.string(), button: z.string().optional() });
export const moduleSaveActionSchema = z.object({ action: z.literal('save'), exit: z.boolean().optional() });
export const moduleExitActionSchema = z.object({ action: z.literal('exit') });

export const moduleActionSchema = z.discriminatedUnion('action', [
  moduleLoadActionSchema,
  moduleConfigureActionSchema,
  moduleSetViewActionSchema,
  moduleExportActionSchema,
  moduleValidateActionSchema,
  moduleRunActionSchema,
  moduleCapabilitiesActionSchema,
  moduleStatusActionSchema,
  moduleDialogActionSchema,
  moduleSaveActionSchema,
  moduleExitActionSchema,
]);

export type ModuleAction = z.infer<typeof moduleActionSchema>;
export type ModuleLoadAction = z.infer<typeof moduleLoadActionSchema>;

// ───────────── iframe → anfitrión (event) ─────────────

export interface ModuleIssueInfo {
  severity: 'error' | 'warning' | 'info';
  message: string;
  elementId?: string;
}

export interface ModuleCapabilitiesInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Versión del contrato `DomainModule` del módulo. Opcional al leer: una instancia anterior no la publica y vale 1. */
  contractVersion?: number;
  documentVersion: string;
  /** La instancia dibuja las vistas del módulo. */
  render: boolean;
  importFormats: Array<{ id: string; label: string; extensions: string[] }>;
  exportFormats: Array<{ id: string; label: string; extension: string; mime: string }>;
  traceViews: Array<{ prefix: string; label: string }>;
  commands: Array<{ name: string; description: string; kind: 'report' | 'convert'; needsInput: boolean; args: string[]; options: string[] }>;
  ai: boolean;
}

export interface SuiteCapabilitiesInfo {
  protocol: string;
  suite: string;
  /** Módulos que ofrece la instancia. */
  available: string[];
  /** Detalle de los módulos cargados o pedidos. */
  modules: ModuleCapabilitiesInfo[];
}

export interface ModuleInitEvent {
  event: 'init';
  version: string;
  /** Módulo que abrió la URL, si la URL lo indicaba. */
  module?: string;
  capabilities: SuiteCapabilitiesInfo;
}
export interface ModuleConfigureEvent {
  event: 'configure';
}
export interface ModuleLoadEvent {
  event: 'load';
  module: string;
  document: unknown;
  viewId?: string;
  issues: ModuleIssueInfo[];
  /** Lo que no se pudo importar tal cual (solo con `importer`). */
  warnings?: string[];
}
export interface ModuleChangeEvent {
  event: 'change' | 'autosave';
  module: string;
  document: unknown;
  issues: ModuleIssueInfo[];
}
export interface ModuleIssuesEvent {
  event: 'issues';
  module: string;
  /** El documento cumple el esquema del módulo. */
  valid: boolean;
  /** Errores de sintaxis o de esquema (si `valid` es falso). */
  schemaIssues: Array<{ path: string; message: string }>;
  /** Reglas semánticas del dominio. */
  issues: ModuleIssueInfo[];
  requestId?: string;
}
export interface ModuleViewChangeEvent {
  event: 'viewChange';
  module: string;
  viewId: string;
  title?: string;
}
export interface ModuleExportEvent {
  event: 'export';
  module: string;
  format: string;
  data: string;
  mime: string;
  extension: string;
  viewId?: string;
  requestId?: string;
}
export interface ModuleResultEvent {
  event: 'result';
  module: string;
  command: string;
  kind: 'report' | 'convert';
  output: string;
  warnings: string[];
  requestId?: string;
}
export interface ModuleCapabilitiesEvent {
  event: 'capabilities';
  capabilities: SuiteCapabilitiesInfo;
  requestId?: string;
}
export interface ModuleSaveEvent {
  event: 'save';
  module: string;
  document: unknown;
  exit: boolean;
}
export interface ModuleExitEvent {
  event: 'exit';
  modified: boolean;
}
export interface ModuleErrorEvent {
  event: 'error';
  message: string;
  issues?: Array<{ path: string; message: string }>;
  requestId?: string;
  /** Qué clase de error es, si el anfitrión puede actuar según ella: `incompatible-protocol` (la versión mayor del protocolo difiere). */
  code?: string;
}

export type ModuleEvent =
  | ModuleInitEvent
  | ModuleConfigureEvent
  | ModuleLoadEvent
  | ModuleChangeEvent
  | ModuleIssuesEvent
  | ModuleViewChangeEvent
  | ModuleExportEvent
  | ModuleResultEvent
  | ModuleCapabilitiesEvent
  | ModuleSaveEvent
  | ModuleExitEvent
  | ModuleErrorEvent;

/** Interpreta un `MessageEvent.data` (objeto o string JSON) como acción del anfitrión. */
export function parseModuleAction(data: unknown): { ok: true; action: ModuleAction } | { ok: false; error: string } {
  let raw = data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'El mensaje no es JSON válido' };
    }
  }
  if (!raw || typeof raw !== 'object' || !('action' in raw)) return { ok: false, error: 'Mensaje sin campo "action"' };
  const result = moduleActionSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, action: result.data };
}
