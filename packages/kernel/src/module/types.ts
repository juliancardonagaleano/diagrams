import type { ZodType } from 'zod';
import type { EditorSpec } from './editor';

/**
 * Contrato que cumple cada especialidad de la suite (C4 hoy; integraciones, datos, empresarial, plataforma…).
 * Un módulo no conoce a los demás: la app, el CLI y el widget embebible lo descubren a través del
 * `ModuleRegistry` y de su manifiesto, y se relacionan entre sí solo por referencias URN (ver `urn.ts`).
 */

export type IssueSeverity = 'error' | 'warning' | 'info';

/** Problema semántico de un documento (más allá de que cumpla el esquema). */
export interface ModuleIssue {
  severity: IssueSeverity;
  message: string;
  /** Elemento del documento al que se refiere, si aplica. */
  elementId?: string;
}

export interface ImportContext {
  /** Nombre del documento: sustituye al que declare la fuente. */
  name?: string;
  /** Nombre a usar si la fuente no declara ninguno (p. ej. el del archivo). */
  fallbackName?: string;
  /** Ruta del archivo de origen, si lo hay. */
  file?: string;
  /**
   * Opciones propias de cada importador (p. ej. cómo resolver los `!include` del DSL de Structurizr). Los importadores con
   * `multiFile` reciben aquí `files` (`SourceFile[]`): ver `joinSourceFiles`.
   */
  extra?: Record<string, unknown>;
}

/** Un archivo de origen de una importación de varios archivos: su nombre (con la ruta que se quiera ver en los avisos) y su texto. */
export interface SourceFile {
  name: string;
  text: string;
}

export interface ImportOutcome<TDoc> {
  document: TDoc;
  /** Lo que no se pudo importar tal cual. Vacío si todo encajó. */
  warnings: string[];
}

/** Convierte una fuente externa (draw.io, Structurizr, Mermaid…) en un documento del módulo. */
export interface Importer<TDoc> {
  /** Identificador estable del formato (`drawio`, `dsl`, `mermaid`). */
  id: string;
  label: string;
  /** Extensiones en minúsculas con punto (`.drawio`). */
  extensions: string[];
  /** Reconoce el formato por el contenido (para stdin o extensiones desconocidas). */
  detect?(text: string): boolean;
  /**
   * Si el formato se reparte en varios archivos que se leen juntos (los `.tf` de una carpeta de Terraform): las extensiones
   * (en minúsculas y con punto) de los que se juntan al importar una carpeta o varios archivos. En ese caso `import` recibe
   * todos los textos concatenados (el mismo documento que si se hubieran concatenado a mano) y, en `context.extra.files`, el
   * detalle por archivo para que los avisos y los errores digan de cuál vienen (ver `joinSourceFiles`).
   */
  multiFile?: { extensions: string[] };
  import(text: string, context: ImportContext): Promise<ImportOutcome<TDoc>> | ImportOutcome<TDoc>;
}

export interface ExportContext {
  /** Vista a exportar, para los formatos que exportan una sola. */
  viewId?: string;
  /** Opciones propias de cada exportador (notación, idioma…). */
  options?: Record<string, unknown>;
}

/** Convierte un documento del módulo a un formato de texto. */
export interface Exporter<TDoc> {
  id: string;
  label: string;
  /** Extensión sugerida con punto (`.drawio`). */
  extension: string;
  mime: string;
  export(document: TDoc, context: ExportContext): Promise<string> | string;
}

/**
 * Cómo se genera o refina un documento del módulo con una IA (o con un agente sin clave de API, usando solo los
 * prompts y el JSON Schema). El kernel aporta el proveedor, los reintentos y la salida estructurada.
 */
export interface AiSpec<TDoc> {
  /** Esquema zod de lo que produce el modelo (normalmente el documento sin coordenadas ni datos derivados). */
  generationSchema: ZodType<unknown>;
  generationJsonSchema(): unknown;
  system(): string;
  /** Mensaje de usuario: la instrucción y, si se refina, el documento base. */
  user(instruction: string, base?: TDoc): string;
  /** Mensaje con el que se le devuelven al modelo los problemas de su intento anterior. */
  retry(issues: string): string;
  /** Convierte lo generado en documento del módulo; si no es válido, devuelve los motivos para el reintento. */
  toDocument(generated: unknown): { ok: true; document: TDoc } | { ok: false; issues: string };
  /**
   * Al refinar, devuelve a `generated` lo que el modelo no genera y `base` ya tenía (p. ej. el texto de los contratos); se
   * aplica después de conservar los `ref`. Opcional.
   */
  carry?(base: TDoc, generated: TDoc): TDoc;
  /** Acabado del documento generado (p. ej. autolayout). Opcional. */
  finish?(document: TDoc): Promise<TDoc> | TDoc;
}

/** Elemento del documento al que otros módulos pueden apuntar. */
export interface EntityRef {
  /** Id dentro del documento. */
  id: string;
  name: string;
  /** Tipo propio del módulo (`softwareSystem`, `queue`, `table`…). */
  kind: string;
}

/** Vista que un módulo deriva de un documento: su `id` es el que se pasa como `viewId` al exportar. */
export interface ViewRef {
  id: string;
  title: string;
  /** Si es una variante de otra vista (la misma vista coloreada por otro criterio): id de la vista base. El lienzo la ofrece en un selector aparte en lugar de en «Vista». */
  variantOf?: string;
  /** Nombre corto de la variante en ese selector («Criticidad»). */
  variantLabel?: string;
  /** Título del selector de variantes de esta vista y las suyas («Notación»); por defecto, «Colorear por». */
  variantsLabel?: string;
}

/** Vista bajo demanda de un elemento del documento (`<prefix>:<id>`), como el impacto, el linaje o el alcance. */
export interface TraceViewSpec {
  prefix: string;
  label: string;
  /** Qué elementos admiten la vista (por defecto, todos). */
  applies?(entity: EntityRef): boolean;
}

export interface CommandOption {
  /** Como en commander: `-o, --out <archivo>`. */
  flags: string;
  description: string;
  default?: string | boolean;
  /**
   * La opción hace que el comando lea o escriba en el sistema de archivos del proceso (o abra la red, o lance procesos): p. ej.
   * `--pack <archivo>`. Solo tiene sentido en el CLI local, donde quien la pasa es dueño de esa máquina. `runCommand` la rechaza
   * cuando el comando se ejecuta en nombre de un cliente remoto (`remote: true`, el servicio HTTP): si no, `POST /api/<módulo>/run/…`
   * dejaría a cualquiera leer archivos del servidor. Todo comando que toque el disco, la red o los procesos debe marcarla.
   */
  local?: boolean;
}

export interface CommandContext {
  args: string[];
  options: Record<string, unknown>;
  /** Contenido del archivo o de la entrada estándar, si el comando declara `input`. */
  input?: string;
  /** Emite un aviso sin mezclarlo con el resultado (stderr en el CLI, la lista de avisos en la interfaz web). */
  warn?(message: string): void;
}

/** Subcomando que el módulo aporta al CLI (`iark <módulo> <nombre>`). Devuelve el texto que se escribe en stdout. */
export interface CommandSpec {
  name: string;
  description: string;
  /**
   * `report` (por defecto): el resultado es un informe en texto (Markdown). `convert`: el resultado es un documento JSON de
   * ESTE módulo construido a partir del documento de otro (`from-integration`, `from-platform`…).
   */
  kind?: 'report' | 'convert';
  /** Si el comando lee un documento: el CLI añade `[archivo]`, `--stdin` y `--out`, lee la entrada y la pasa en `context.input`. */
  input?: { description: string };
  /** `local`: el argumento es una ruta u otro recurso de la máquina que ejecuta el comando; ver `CommandOption.local`. */
  args?: Array<{ name: string; description: string; required?: boolean; local?: boolean }>;
  options?: CommandOption[];
  run(context: CommandContext): Promise<string | void> | string | void;
}

/**
 * Cómo se comparan dos versiones de un documento del módulo (`diffDocuments`). La comparación es estructural y no
 * necesita nada del módulo; esto solo declara lo que no es contenido. Las rutas son de claves separadas por punto, sin
 * índices ni ids: `views.elements.x` es la `x` de los elementos de todas las vistas.
 */
export interface DiffSpec {
  /**
   * Rutas que NO cuentan como cambio de contenido: la maquetación guardada y los datos derivados (coordenadas, tamaños,
   * rutas de aristas…). Una ruta cubre también todo lo que cuelga de ella. Por defecto, ninguna: todo es contenido.
   */
  ignore?: string[];
  /**
   * Rutas de listas cuyo orden es parte del contenido (los pasos de un flujo, las etapas de un pipeline…). En el resto de
   * listas, cambiar solo el orden no es un cambio.
   */
  ordered?: string[];
}

export interface DomainModule<TDoc = unknown> {
  /** Identificador estable en minúsculas (`c4`, `integration`, `data`…): forma parte de las URN. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Versión del formato de documento que produce y acepta. */
  documentVersion: string;
  /** Esquema del documento, para validarlo antes de operar con él. */
  schema: ZodType<TDoc>;
  /** JSON Schema del documento, para agentes de IA y editores. */
  jsonSchema(): unknown;
  /** Reglas semánticas del dominio (más allá del esquema). */
  validate(document: TDoc): ModuleIssue[];
  importers: Importer<TDoc>[];
  exporters: Exporter<TDoc>[];
  ai?: AiSpec<TDoc>;
  /** Elementos referenciables desde otros módulos por URN. */
  entities?(document: TDoc): EntityRef[];
  /** Vistas que el módulo deriva del documento (las que exportan sus exportadores de diagramas). */
  views?(document: TDoc): ViewRef[];
  /** Vistas bajo demanda de un elemento. */
  traceViews?: TraceViewSpec[];
  cliCommands?: CommandSpec[];
  /** Qué ignora y qué respeta de orden la comparación de versiones de un documento (`diffDocuments`). Opcional: sin él, todo cuenta. */
  diff?: DiffSpec;
  /** Edición interactiva: notación, proyección a grafo, formularios y operaciones. Sin él, el módulo solo se ve y se edita como JSON. */
  editor?: EditorSpec<TDoc>;
}
