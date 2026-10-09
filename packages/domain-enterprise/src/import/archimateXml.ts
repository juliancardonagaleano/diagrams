import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { EnterpriseImportError } from './fromMermaid';

/**
 * Lectura de XML de ArchiMate a un modelo neutro (elementos, relaciones y vistas), sin interpretar todavía qué significa
 * cada tipo para el módulo empresarial. Entiende el Open Group Exchange File Format (`<model>` en el espacio de nombres
 * `http://www.opengroup.org/xsd/archimate/3.x/`, con nombres y documentación multi-idioma y propiedades definidas en
 * `propertyDefinitions`) y el formato nativo de Archi (`<archimate:model>`, con carpetas, nombres en atributos y
 * propiedades `key`/`value`).
 */

export const EXCHANGE_NAMESPACE = 'http://www.opengroup.org/xsd/archimate/';
export const ARCHI_NAMESPACE = 'http://www.archimatetool.com/archimate';

export interface RawProperty {
  key: string;
  value: string;
}

export interface RawElement {
  id: string;
  /** Tipo de ArchiMate sin prefijo (`BusinessActor`, `AndJunction`…). */
  type: string;
  name: string;
  documentation?: string;
  properties: RawProperty[];
}

export interface RawRelationship {
  id: string;
  /** Tipo sin prefijo ni sufijo (`Serving`, `Association`…). */
  type: string;
  source: string;
  target: string;
  name?: string;
  /** Solo para la asociación: si el modelo la declara dirigida. */
  directed: boolean;
  properties: RawProperty[];
}

export interface RawModel {
  format: 'exchange' | 'archi';
  name?: string;
  documentation?: string;
  properties: RawProperty[];
  elements: RawElement[];
  relationships: RawRelationship[];
  /** Nombres de las vistas (diagramas) del modelo; no se importan. */
  views: string[];
}

export interface ReadOptions {
  /** Idioma preferido para nombres, documentación y valores (por defecto, español). */
  lang?: string;
}

// ───────────── detección ─────────────

const PROLOG_STEP = /^(?:﻿|\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)/i;
const ROOT_TAG = /^<(?:[\w.-]+:)?([\w.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;

/** Raíz del documento (nombre local y atributos tal como están escritos), saltando prólogo, comentarios y DOCTYPE. */
export function rootTag(text: string): { local: string; attrs: string } | undefined {
  let rest = text.slice(0, 65536);
  for (let guard = 0; guard < 200; guard += 1) {
    const step = PROLOG_STEP.exec(rest);
    if (!step) break;
    rest = rest.slice(step[0].length);
  }
  const tag = ROOT_TAG.exec(rest);
  return tag ? { local: tag[1], attrs: tag[2] } : undefined;
}

/** Formato XML de ArchiMate que parece ser el texto, mirando solo la etiqueta raíz. */
export function archimateFormat(text: string): RawModel['format'] | undefined {
  const root = rootTag(text);
  if (!root || root.local !== 'model') return undefined;
  if (root.attrs.includes(EXCHANGE_NAMESPACE)) return 'exchange';
  if (root.attrs.includes(ARCHI_NAMESPACE)) return 'archi';
  return undefined;
}

export const looksLikeArchimate = (text: string): boolean => archimateFormat(text) !== undefined;

// ───────────── utilidades sobre el árbol de fast-xml-parser ─────────────

type Tree = Record<string, unknown>;

const isTree = (x: unknown): x is Tree => typeof x === 'object' && x !== null && !Array.isArray(x);
const local = (key: string): string => key.slice(key.lastIndexOf(':') + 1);

/** Hijos con ese nombre local (con cualquier prefijo de espacio de nombres), siempre como lista de nodos: el parser devuelve un objeto, un texto o un arreglo según haya uno o varios. */
function kids(node: unknown, name: string): Tree[] {
  if (!isTree(node)) return [];
  const out: Tree[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key.startsWith('#') || key.startsWith('?') || local(key) !== name) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (isTree(item)) out.push(item);
      else if (typeof item === 'string' || typeof item === 'number') out.push({ '#text': String(item) });
      else out.push({});
    }
  }
  return out;
}

const child = (node: unknown, name: string): Tree | undefined => kids(node, name)[0];

const attr = (node: Tree, name: string): string | undefined => {
  const value = node[`@_${name}`];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** Atributo con ese nombre local y prefijo (`xsi:type`, el prefijo lo elige quien escribe el archivo); si no, el que no lo lleva. */
function typeAttr(node: Tree): string | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') && key.includes(':') && local(key) === 'type' && typeof value === 'string') return value;
  }
  return attr(node, 'type');
}

const textOf = (node: Tree): string => (typeof node['#text'] === 'string' ? node['#text'] : '');

interface LangText {
  lang?: string;
  text: string;
}

const langOf = (node: Tree): string | undefined => attr(node, 'xml:lang') ?? attr(node, 'lang');

function langTexts(node: unknown, tag: string): LangText[] {
  return kids(node, tag)
    .map((k) => ({ lang: langOf(k), text: textOf(k).trim() }))
    .filter((t) => t.text !== '');
}

/**
 * Elige entre las versiones de un texto en varios idiomas: la del idioma preferido (primero el código exacto, luego el
 * idioma sin región), la que no declara idioma, la inglesa y, si no, la primera.
 */
export function pickText(texts: LangText[], preferred: string): string | undefined {
  if (texts.length === 0) return undefined;
  const want = preferred.toLowerCase();
  const base = want.split('-')[0];
  const lang = (t: LangText): string | undefined => t.lang?.toLowerCase();
  return (
    texts.find((t) => lang(t) === want) ??
    texts.find((t) => lang(t)?.split('-')[0] === base) ??
    texts.find((t) => lang(t) === undefined) ??
    texts.find((t) => lang(t)?.split('-')[0] === 'en') ??
    texts[0]
  ).text;
}

// ───────────── mensajes de error del XML ─────────────

const XML_MESSAGES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^Closing tag '(.+)' has not been opened\.$/, (m) => `la etiqueta de cierre «</${m[1]}>» no tiene su apertura`],
  [/^Closing tag '(.+)' doesn't have proper closing\.$/, (m) => `la etiqueta de cierre «</${m[1]}>» no termina en «>»`],
  [/^Closing tag '(.+)' can't have attributes or invalid starting\.$/, (m) => `la etiqueta de cierre «</${m[1]}>» no puede llevar atributos`],
  [/^Unclosed tag '(.+)'\.$/, (m) => `la etiqueta «<${m[1]}>» no se cierra`],
  [/^Expected closing tag '(.+)' \(opened in line (\d+), col (\d+)\) instead of closing tag '(.+)'\.$/, (m) => `se esperaba «</${m[1]}>» (abierta en la línea ${m[2]}, columna ${m[3]}) y se encontró «</${m[4]}>»`],
  [/^Tag '(.+)' is an invalid name\.$/, (m) => `«${m[1]}» no es un nombre de etiqueta válido`],
  [/^Invalid space after '<'\.$/, () => 'hay un espacio justo después de «<»'],
  [/^Attribute '(.+)' is repeated\.$/, (m) => `el atributo «${m[1]}» está repetido`],
  [/^Attribute '(.+)' is without value\.$/, (m) => `el atributo «${m[1]}» no tiene valor`],
  [/^Attribute '(.+)' has no space in starting\.$/, (m) => `falta un espacio antes del atributo «${m[1]}»`],
  [/^Attribute '(.+)' is an invalid name\.$/, (m) => `«${m[1]}» no es un nombre de atributo válido`],
  [/^boolean attribute '(.+)' is not allowed\.$/, (m) => `el atributo «${m[1]}» no tiene valor entre comillas`],
  [/^attribute (.+) has no value assigned\.$/, (m) => `el atributo «${m[1]}» no tiene valor`],
  [/^Attributes for '(.+)' have open quote\.$/, (m) => `los atributos de «${m[1]}» tienen una comilla sin cerrar`],
  [/^char '(.+)' is not expected\.$/, (m) => `carácter inesperado «${m[1]}»`],
  [/^Multiple possible root nodes found\.$/, () => 'hay más de un elemento raíz'],
  [/^Start tag expected\.$/, () => 'se esperaba una etiqueta de apertura'],
  [/^Extra text at the end$/, () => 'hay texto sobrante al final del documento'],
  [/^XML declaration allowed only at the start of the document\.$/, () => 'la declaración «<?xml …?>» solo puede ir al principio del documento'],
];

/** Con varias etiquetas abiertas al final el validador no da posición (siempre 1:1): se nombran las etiquetas y se omite. */
const OPEN_AT_END = /^Invalid '(\[.*\])' found\.$/;

export function describeXmlError(message: string, line: number, col: number): string {
  const open = OPEN_AT_END.exec(message);
  if (open) {
    let tags: string[] = [];
    try {
      tags = (JSON.parse(open[1]) as unknown[]).map(String);
    } catch {
      // se queda sin nombres
    }
    return `el documento termina con etiquetas sin cerrar${tags.length ? ` (${tags.map((t) => `«<${t}>»`).join(', ')})` : ''}.`;
  }
  for (const [pattern, translate] of XML_MESSAGES) {
    const match = pattern.exec(message);
    if (match) return `${translate(match)} (línea ${line}, columna ${col}).`;
  }
  return `${message} (línea ${line}, columna ${col}).`;
}

// ───────────── lectura ─────────────

const REPEATED = new Set(['element', 'relationship', 'name', 'documentation', 'property', 'value', 'propertyDefinition', 'view', 'folder', 'label', 'item']);
const DIAGRAM_TYPES = new Set(['ArchimateDiagramModel', 'SketchModel', 'CanvasModel']);

/** Lee un modelo de ArchiMate (Exchange Format o formato nativo de Archi) a elementos y relaciones sin interpretar. */
export function readArchimate(text: string, options: ReadOptions = {}): RawModel {
  const source = text.replace(/^﻿/, '');
  if (source.trim() === '') throw new EnterpriseImportError('El archivo de ArchiMate está vacío.');
  if (/<!ENTITY/i.test(source)) throw new EnterpriseImportError('El XML declara entidades propias (<!ENTITY>), que no se admiten en un modelo de ArchiMate.');
  const valid = XMLValidator.validate(source);
  if (valid !== true) {
    const { msg, line, col } = valid.err;
    throw new EnterpriseImportError(`XML mal formado: ${describeXmlError(msg, line, col)}`);
  }
  const format = archimateFormat(source);
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    // Un elemento repetido llega como arreglo y uno solo como objeto: se fuerza el arreglo en los que se repiten.
    isArray: (name) => REPEATED.has(local(name)),
  }).parse(source) as Tree;
  const rootKey = Object.keys(parsed).find((k) => !k.startsWith('?') && !k.startsWith('#'));
  if (!rootKey) throw new EnterpriseImportError('El XML no tiene elemento raíz.');
  if (!format) {
    if (local(rootKey) === 'model') {
      throw new EnterpriseImportError(`La raíz «${rootKey}» no declara el espacio de nombres de ArchiMate (${EXCHANGE_NAMESPACE}3.0/): no es un modelo en el formato de intercambio de ArchiMate.`);
    }
    throw new EnterpriseImportError(`La raíz del XML es «${rootKey}»: un modelo de ArchiMate empieza por «model» en el espacio de nombres ${EXCHANGE_NAMESPACE}3.0/ (formato de intercambio) o por «archimate:model» (Archi).`);
  }
  const root = isTree(parsed[rootKey]) ? (parsed[rootKey] as Tree) : {};
  const preferred = (options.lang ?? 'es').trim() || 'es';
  return format === 'exchange' ? readExchange(root, preferred) : readArchi(root);
}

function readExchange(root: Tree, preferred: string): RawModel {
  const definitions = new Map<string, string>();
  for (const def of kids(child(root, 'propertyDefinitions'), 'propertyDefinition')) {
    const id = attr(def, 'identifier');
    if (id) definitions.set(id, pickText(langTexts(def, 'name'), preferred) ?? id);
  }
  const propertiesOf = (node: Tree): RawProperty[] =>
    kids(child(node, 'properties'), 'property').flatMap((p) => {
      const ref = attr(p, 'propertyDefinitionRef');
      const key = ref ? (definitions.get(ref) ?? ref) : undefined;
      return key ? [{ key, value: pickText(langTexts(p, 'value'), preferred) ?? '' }] : [];
    });
  const nameOf = (node: Tree): string => pickText(langTexts(node, 'name'), preferred) ?? '';

  const elements: RawElement[] = [];
  for (const el of kids(child(root, 'elements'), 'element')) {
    const id = attr(el, 'identifier');
    const type = typeAttr(el)?.replace(/^.*:/, '');
    if (!id || !type) continue;
    const documentation = pickText(langTexts(el, 'documentation'), preferred);
    elements.push({ id, type, name: nameOf(el), ...(documentation ? { documentation } : {}), properties: propertiesOf(el) });
  }
  const relationships: RawRelationship[] = [];
  for (const rel of kids(child(root, 'relationships'), 'relationship')) {
    const id = attr(rel, 'identifier');
    const type = typeAttr(rel)?.replace(/^.*:/, '');
    const source = attr(rel, 'source');
    const target = attr(rel, 'target');
    if (!id || !type || !source || !target) continue;
    relationships.push({ id, type, source, target, ...(nameOf(rel) ? { name: nameOf(rel) } : {}), directed: attr(rel, 'isDirected') === 'true', properties: propertiesOf(rel) });
  }
  const views = kids(child(child(root, 'views'), 'diagrams'), 'view').map((v) => nameOf(v) || attr(v, 'identifier') || 'vista sin nombre');
  const documentation = pickText(langTexts(root, 'documentation'), preferred);
  return { format: 'exchange', name: nameOf(root) || undefined, ...(documentation ? { documentation } : {}), properties: propertiesOf(root), elements, relationships, views };
}

function readArchi(root: Tree): RawModel {
  const properties = (node: Tree): RawProperty[] =>
    kids(node, 'property').flatMap((p) => {
      const key = attr(p, 'key');
      return key ? [{ key, value: attr(p, 'value') ?? '' }] : [];
    });
  const elements: RawElement[] = [];
  const relationships: RawRelationship[] = [];
  const views: string[] = [];

  const visit = (node: Tree): void => {
    for (const el of kids(node, 'element')) {
      const type = typeAttr(el)?.replace(/^.*:/, '');
      const id = attr(el, 'id');
      if (!type || !id) continue;
      const name = attr(el, 'name') ?? '';
      if (DIAGRAM_TYPES.has(type)) {
        views.push(name || id);
      } else if (type.endsWith('Relationship')) {
        const source = attr(el, 'source');
        const target = attr(el, 'target');
        if (!source || !target) continue;
        relationships.push({ id, type: type.slice(0, -'Relationship'.length), source, target, ...(name ? { name } : {}), directed: attr(el, 'directed') === 'true', properties: properties(el) });
      } else {
        // Archi guarda la unión Y/O como `Junction` con `type="or"`.
        const kind = type === 'Junction' ? (attr(el, 'type') === 'or' ? 'OrJunction' : 'AndJunction') : type;
        const documentation = textOf(child(el, 'documentation') ?? {}).trim();
        elements.push({ id, type: kind, name, ...(documentation ? { documentation } : {}), properties: properties(el) });
      }
    }
    for (const folder of kids(node, 'folder')) visit(folder);
  };
  visit(root);

  const purpose = textOf(child(root, 'purpose') ?? {}).trim();
  return { format: 'archi', name: attr(root, 'name'), ...(purpose ? { documentation: purpose } : {}), properties: properties(root), elements, relationships, views };
}
