/**
 * Importador de OWASP Threat Dragon (modelo JSON v2, el que guarda Threat Dragon 2.x en escritorio y en la web) para el módulo de
 * seguridad. Es un diagrama de flujo de datos con sus amenazas, que es justo el modelo del módulo.
 *
 *   Threat Dragon                                     → seguridad
 *   ------------------------------------------------------------------------------------------------------------------
 *   `summary.title`, `description`, `owner`           → nombre y descripción del espacio de trabajo
 *   `actor`                                           → activo `actor`
 *   `process`                                         → activo `process` (aplicación web → tecnología; maneja pagos → datos restringidos)
 *   `store`                                           → activo `datastore` (`isEncrypted` → cifrado en reposo; guarda credenciales → restringido)
 *   `flow`                                            → flujo (`protocol`, `isEncrypted` → cifrado); bidireccional = dos flujos
 *   `trust-boundary-box`                              → zona; el anidamiento se deduce de la geometría (el centro de cada
 *                                                       elemento dentro de la caja más pequeña que lo contiene)
 *   `threats[]` de cada elemento                      → amenaza sobre ese activo o flujo (categoría, estado, severidad)
 *   `mitigation` de cada amenaza                      → control (uno por texto distinto) enlazado a las amenazas que lo citan
 *
 * Qué decide el importador porque el modelo no lo dice (todo se avisa y se corrige en el documento):
 *  - Threat Dragon dibuja las fronteras pero no dice qué lado es más confiable. Lo que queda fuera de toda frontera va a una zona
 *    «Exterior» no confiable; la primera frontera es interna y las anidadas, restringidas; el nombre manda si dice DMZ, Internet
 *    (no confiable) o restringida. Sin ninguna frontera, una sola zona interna con el nombre del diagrama.
 *  - La categoría de una amenaza LINDDUN, CIA u otra se lleva a STRIDE (todas las de LINDDUN menos «Non-repudiation» son
 *    divulgación de información; Confidentiality, Integrity y Availability son divulgación, manipulación y denegación de servicio);
 *    la que no tiene equivalente se infiere por palabras y, si no, es manipulación. La categoría original queda en la descripción.
 *  - La severidad es el impacto; la probabilidad queda en la media. Open → abierta, Mitigated → mitigada, NotApplicable → aceptada
 *    (su texto de mitigación es el motivo y va a la descripción, no a un control).
 *
 * Lo que NO se importa y se avisa: el formato v1 antiguo (`diagramJson`), las fronteras de curva (una curva no delimita un área),
 * las notas de texto, los flujos sin los dos extremos conectados o de un elemento consigo mismo, y los textos de relleno que
 * Threat Dragon pone en una amenaza nueva. Si el archivo trae varios diagramas se unen en un documento, con sus zonas prefijadas
 * por el título del diagrama.
 */
import { asArray, asRecord, asString, pickId, readJsonText, Warnings, type JsonRecord } from '@iark/kernel';
import { formatSecurityIssues, validateSecurityDocument } from '../schema';
import {
  ASSET_LABELS,
  SECURITY_DOCUMENT_VERSION,
  type Asset,
  type AssetKind,
  type Control,
  type ControlKind,
  type Flow,
  type Impact,
  type SecurityDocument,
  type Stride,
  type Threat,
  type ThreatStatus,
  type TrustLevel,
  type Zone,
} from '../types';
import { SecurityImportError, slug, type SecurityImportOptions, type SecurityImportResult } from './fromMermaid';

const LABEL = 'El archivo de Threat Dragon';
const MAX_CELLS = 50_000;
const MAX_BOXES = 1_000;

const strip = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const key = (s: string): string => strip(s).replace(/[^a-z0-9]/g, '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const flag = (v: unknown): boolean => v === true;
const brief = (s: string, max = 80): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};
const shortList = (items: string[], max = 4): string => {
  const unique = [...new Set(items)];
  return unique.length <= max ? unique.join(', ') : `${unique.slice(0, max).join(', ')}… (+${unique.length - max})`;
};

/** ¿El texto es un modelo de Threat Dragon (v1 o v2)? Un objeto con `summary` y `detail.diagrams`. */
export function looksLikeThreatDragon(text: string): boolean {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!/^\s*\{/.test(source) || !source.includes('"diagrams"') || !source.includes('"summary"')) return false;
  if (source.length > 80_000_000) return false;
  try {
    const json = asRecord(JSON.parse(source));
    return !!asRecord(json?.summary) && Array.isArray(asRecord(json?.detail)?.diagrams);
  } catch {
    return false;
  }
}

type CellKind = 'actor' | 'process' | 'store' | 'flow' | 'box' | 'curve' | 'text';
const SHAPES: Record<string, CellKind> = {
  actor: 'actor',
  process: 'process',
  store: 'store',
  flow: 'flow',
  'trust-boundary-box': 'box',
  'trust-boundary-curve': 'curve',
  'trust-broundary-curve': 'curve', // sic: así se escribe en Threat Dragon
  'td-text-block': 'text',
};
const TYPES: Record<string, CellKind> = {
  'tm.actor': 'actor',
  'tm.process': 'process',
  'tm.store': 'store',
  'tm.flow': 'flow',
  'tm.boundarybox': 'box',
  'tm.boundary': 'curve',
  'tm.text': 'text',
};

const KNOWN = new Set<string>(['actor', 'process', 'store', 'flow', 'box', 'curve', 'text']);

const STRIDE_OF: Record<string, Stride> = {
  spoofing: 'spoofing',
  tampering: 'tampering',
  repudiation: 'repudiation',
  informationdisclosure: 'information-disclosure',
  denialofservice: 'denial-of-service',
  elevationofprivilege: 'elevation-of-privilege',
  // LINDDUN
  linkability: 'information-disclosure',
  identifiability: 'information-disclosure',
  detectability: 'information-disclosure',
  disclosureofinformation: 'information-disclosure',
  unawareness: 'information-disclosure',
  noncompliance: 'information-disclosure',
  nonrepudiation: 'repudiation',
  // CIA
  confidentiality: 'information-disclosure',
  integrity: 'tampering',
  availability: 'denial-of-service',
};
/** Las seis categorías STRIDE tal como las escribe Threat Dragon (sin separadores ni mayúsculas). */
const STRIDE_DIRECT = new Set(['spoofing', 'tampering', 'repudiation', 'informationdisclosure', 'denialofservice', 'elevationofprivilege']);
const STRIDE_WORDS: Array<[RegExp, Stride]> = [
  [/spoof|suplant|impersonat/, 'spoofing'],
  [/tamper|manipul|integrity|modif/, 'tampering'],
  [/repudi/, 'repudiation'],
  [/disclos|confiden|privacy|privacidad|leak|fuga/, 'information-disclosure'],
  [/denial|availab|disponib/, 'denial-of-service'],
  [/elevat|privilege|privilegio/, 'elevation-of-privilege'],
];
const IMPACT_OF: Record<string, Impact> = { low: 'low', bajo: 'low', medium: 'medium', medio: 'medium', high: 'high', alto: 'high', critical: 'critical', critico: 'critical' };
const STATUS_OF: Record<string, ThreatStatus> = { open: 'open', mitigated: 'mitigated', notapplicable: 'accepted', na: 'accepted', accepted: 'accepted' };

/** Textos de relleno que Threat Dragon pone en una amenaza nueva: no son información. */
const placeholder = (text: string | undefined): boolean => !text || /^provide (a description|remediation)/i.test(text.trim());

const CONTROL_WORDS: Array<[RegExp, ControlKind]> = [
  [/tasa|rate.?limit|throttl|limitar|cuota|quota|timeout|tiempo maximo/, 'rate-limit'],
  [/cifr|encrypt|\btls\b|\bssl\b|https|hsts|mtls|\bkms\b|hash/, 'encryption'],
  [/autentic|authentic|\bmfa\b|\b2fa\b|token|\bsso\b|oauth|openid|password|contrasena|jwt/, 'authentication'],
  [/autoriz|authoriz|\brol(es)?\b|\brole|rbac|permiso|permission|privilegio minimo|least privilege/, 'authorization'],
  [/valida|sanitiz|escap|parametriz|input|entrada/, 'validation'],
  [/registr|\blogs?\b|audit|traza|monitor|alert/, 'logging'],
  [/copia|backup|replica|restaur/, 'backup'],
  [/secret|vault|credencial|rotacion de claves|key management/, 'secrets'],
  [/firewall|\bwaf\b|segment|\bred\b|network|\bvpn\b|aisla|\bdmz\b/, 'network'],
];
const controlKindOf = (text: string): ControlKind => CONTROL_WORDS.find(([pattern]) => pattern.test(strip(text)))?.[1] ?? 'other';

interface Box {
  zone: Zone;
  area: number;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  parent?: Box;
  depth: number;
}

const kindOfCell = (cell: JsonRecord): CellKind | string => {
  const shape = asString(cell.shape);
  if (shape && SHAPES[shape]) return SHAPES[shape];
  const type = asString(asRecord(cell.data)?.type);
  if (type && TYPES[type.toLowerCase()]) return TYPES[type.toLowerCase()];
  return shape ?? type ?? 'sin forma';
};

/** Vértice central de un elemento (su posición es la esquina superior izquierda). */
const centerOf = (cell: JsonRecord): { x: number; y: number } | undefined => {
  const position = asRecord(cell.position);
  const [x, y] = [num(position?.x), num(position?.y)];
  if (x === undefined || y === undefined) return undefined;
  const size = asRecord(cell.size);
  return { x: x + (num(size?.width) ?? 0) / 2, y: y + (num(size?.height) ?? 0) / 2 };
};

const contains = (box: Box, point: { x: number; y: number }): boolean => point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;

const TRUST_BY_NAME: Array<[RegExp, TrustLevel]> = [
  [/\bdmz\b|zona desmilitarizada/, 'dmz'],
  [/internet|publica?\b|public\b|untrusted|no confiable|externa?\b|external/, 'untrusted'],
  [/restring|restricted|\bpci\b|seguro|secure/, 'restricted'],
];

/**
 * Importa un modelo de Threat Dragon v2 como documento de seguridad (ver la cabecera de este archivo para el mapeo). Lanza
 * `SecurityImportError` con un motivo de una línea si el texto no es un modelo utilizable.
 */
export function fromThreatDragon(source: string, options: SecurityImportOptions = {}): SecurityImportResult {
  const read = readJsonText(source, LABEL);
  if (!read.ok) throw new SecurityImportError(read.message);
  const root = asRecord(read.value);
  const summary = asRecord(root?.summary);
  const detail = asRecord(root?.detail);
  if (!root || !summary || !detail || !Array.isArray(detail.diagrams)) {
    throw new SecurityImportError('El JSON no es un modelo de Threat Dragon: se esperaba un objeto con «summary» y «detail.diagrams».');
  }
  const diagrams = detail.diagrams.map(asRecord).filter((d): d is JsonRecord => !!d);
  if (diagrams.length === 0) throw new SecurityImportError('El modelo de Threat Dragon no tiene ningún diagrama.');
  const legacy = diagrams.filter((d) => !Array.isArray(d.cells) && d.diagramJson !== undefined);
  const current = diagrams.filter((d) => Array.isArray(d.cells));
  if (current.length === 0) {
    throw new SecurityImportError(
      legacy.length > 0
        ? 'El modelo está en el formato antiguo de Threat Dragon (v1, con «diagramJson»): ábrelo con Threat Dragon 2.x, guárdalo y vuelve a importarlo.'
        : 'Ningún diagrama del modelo tiene «cells»: no hay nada que importar.',
    );
  }
  const cellCount = current.reduce((total, d) => total + (d.cells as unknown[]).length, 0);
  if (cellCount > MAX_CELLS) throw new SecurityImportError(`El modelo tiene ${cellCount} elementos (el máximo que se importa es ${MAX_CELLS}).`);

  const warnings = new Warnings();
  const merged = current.length > 1;
  if (legacy.length > 0) warnings.add(`${legacy.length} diagrama(s) están en el formato antiguo v1 («diagramJson») y no se importan: ábrelos con Threat Dragon 2.x y guárdalos.`);
  if (merged) warnings.add(`El modelo tiene ${current.length} diagramas: se unen en un solo documento y sus zonas llevan el título del diagrama («${current.map((d) => asString(d.title) ?? 'sin título').join('», «')}»).`);

  const taken = new Set<string>();
  const zones: Zone[] = [];
  const assets: Asset[] = [];
  const flows: Flow[] = [];
  const threats: Threat[] = [];
  const controls: Control[] = [];
  const controlByText = new Map<string, Control>();
  const flowSignatures = new Set<string>();
  /** Nombre legible de cada activo y flujo por id, para titular las amenazas sin título. */
  const names = new Map<string, string>();

  // Recuentos para los avisos agrupados.
  const curves: string[] = [];
  let texts = 0;
  const unknown: string[] = [];
  const danglingFlows = { unconnected: 0, notAssets: 0, loops: 0 };
  let lostThreats = 0;
  let outsideCount = 0;
  let unplaced = 0;
  const converted = new Map<string, number>();
  const withoutEquivalent: string[] = [];
  let unknownStatuses = 0;
  let anyThreat = false;
  let anyBoxes = false;

  for (const diagram of current) {
    const cells = (diagram.cells as unknown[]).map(asRecord).filter((c): c is JsonRecord => !!c);
    const title = asString(diagram.title) ?? `Diagrama ${current.indexOf(diagram) + 1}`;
    const prefix = merged ? `${title} · ` : '';
    const kinds = cells.map(kindOfCell);

    // ───────────── fronteras → zonas ─────────────
    const boxes: Box[] = [];
    kinds.forEach((kind, i) => {
      const cell = cells[i];
      if (kind === 'curve') curves.push(asString(asRecord(cell.data)?.name) ?? 'sin nombre');
      else if (kind === 'text') texts += 1;
      else if (!KNOWN.has(kind)) unknown.push(kind);
      if (kind !== 'box') return;
      if (boxes.length >= MAX_BOXES) throw new SecurityImportError(`El diagrama «${title}» tiene más de ${MAX_BOXES} fronteras de confianza: demasiadas para importarlo.`);
      const position = asRecord(cell.position);
      const size = asRecord(cell.size);
      const [x, y, w, h] = [num(position?.x) ?? 0, num(position?.y) ?? 0, Math.max(0, num(size?.width) ?? 0), Math.max(0, num(size?.height) ?? 0)];
      const data = asRecord(cell.data);
      const name = asString(data?.name) ?? asString(asRecord(asRecord(cell.attrs)?.headerText)?.text) ?? 'Frontera de confianza';
      const zoneId = pickId(slug(`${prefix}${name}`) || 'frontera', taken);
      const description = asString(data?.description);
      const zone: Zone = { id: zoneId, name: `${prefix}${name}`, trust: 'internal', ...(description ? { description } : {}) };
      zones.push(zone);
      boxes.push({ zone, area: w * h, x, y, w, h, name, depth: 0 });
    });
    anyBoxes ||= boxes.length > 0;
    // Del más pequeño al más grande: el primero que contiene un punto es la zona más específica.
    const bySize = [...boxes].sort((a, b) => a.area - b.area);
    const smallestAround = (point: { x: number; y: number }, except?: Box): Box | undefined =>
      bySize.find((b) => b !== except && (except === undefined || b.area > except.area) && contains(b, point));
    for (const box of boxes) {
      const parent = smallestAround({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, box);
      if (parent) box.parent = parent;
    }
    const depthOf = (box: Box): number => {
      let depth = 0;
      for (let b = box.parent; b; b = b.parent) depth += 1;
      return depth;
    };
    for (const box of boxes) {
      box.depth = depthOf(box);
      box.zone.trust = TRUST_BY_NAME.find(([pattern]) => pattern.test(strip(box.name)))?.[1] ?? (box.depth === 0 ? 'internal' : 'restricted');
      if (box.parent) box.zone.parentId = box.parent.zone.id;
    }

    // La zona de lo que queda fuera de toda frontera (o la única, si el diagrama no dibuja ninguna).
    let fallbackZone: string | undefined;
    const fallback = (): string => {
      if (!fallbackZone) {
        const outside = boxes.length > 0;
        fallbackZone = pickId(slug(outside ? `${prefix}exterior` : title) || 'zona', taken);
        zones.push({ id: fallbackZone, name: outside ? `${prefix}Exterior` : title, trust: outside ? 'untrusted' : 'internal' });
      }
      return fallbackZone;
    };

    // ───────────── actores, procesos y almacenes → activos ─────────────
    const assetByCell = new Map<string, string>();
    const targetOfCell = new Map<string, string>();
    cells.forEach((cell, i) => {
      const kind = kinds[i];
      if (kind !== 'actor' && kind !== 'process' && kind !== 'store') return;
      const data = asRecord(cell.data) ?? {};
      const assetKind: AssetKind = kind === 'store' ? 'datastore' : kind;
      const name = asString(data.name) ?? asString(asRecord(asRecord(cell.attrs)?.text)?.text) ?? asString(asRecord(asRecord(cell.attrs)?.label)?.text) ?? ASSET_LABELS[assetKind];
      const center = centerOf(cell);
      let zoneId: string;
      if (center === undefined) {
        unplaced += 1;
        zoneId = fallback();
      } else {
        const box = smallestAround(center);
        zoneId = box ? box.zone.id : fallback();
        if (!box && boxes.length > 0) outsideCount += 1;
      }
      const notes: Array<string | undefined> = [asString(data.description)];
      let technology: string | undefined;
      let classification: Asset['classification'];
      if (kind === 'actor' && flag(data.providesAuthentication)) notes.push('Proporciona autenticación');
      if (kind === 'process') {
        if (flag(data.isWebApplication)) technology = 'Aplicación web';
        else if (flag(data.isALibrary)) technology = 'Biblioteca';
        if (flag(data.handlesCardPayment)) {
          notes.push('Maneja pagos con tarjeta');
          classification = 'restricted';
        }
        if (flag(data.handlesGoodsOrServices)) notes.push('Maneja bienes o servicios');
        if (asString(data.privilegeLevel)) notes.push(`Nivel de privilegio: ${asString(data.privilegeLevel)}`);
      }
      if (kind === 'store') {
        if (flag(data.storesCredentials)) {
          notes.push('Guarda credenciales');
          classification = 'restricted';
        }
        if (flag(data.storesInventory)) notes.push('Guarda inventario');
        if (flag(data.isALog)) notes.push('Es un registro');
        if (flag(data.isSigned)) notes.push('Está firmado');
      }
      const outOfScope = flag(data.outOfScope);
      if (outOfScope) notes.push(`Fuera de alcance${asString(data.reasonOutOfScope) ? `: ${asString(data.reasonOutOfScope)}` : ''}`);
      const description = notes.filter(Boolean).join(' · ');
      const id = pickId(slug(name) || assetKind, taken);
      names.set(id, name);
      assets.push({
        id,
        name,
        kind: assetKind,
        zoneId,
        ...(description ? { description } : {}),
        ...(technology ? { technology } : {}),
        ...(classification ? { classification } : {}),
        ...(kind === 'store' && typeof data.isEncrypted === 'boolean' ? { encryptedAtRest: data.isEncrypted } : {}),
        ...(outOfScope ? { tags: ['fuera-de-alcance'] } : {}),
      });
      const cellId = cell.id === undefined ? undefined : String(cell.id);
      if (cellId) assetByCell.set(cellId, id);
      targetOfCell.set(String(i), id);
    });

    // ───────────── flujos ─────────────
    const endpoint = (value: unknown): string | undefined => {
      const ref = asRecord(value);
      const id = ref?.cell ?? ref?.id;
      return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
    };
    cells.forEach((cell, i) => {
      if (kinds[i] !== 'flow') return;
      const [from, to] = [endpoint(cell.source), endpoint(cell.target)];
      if (from === undefined || to === undefined) {
        danglingFlows.unconnected += 1;
        lostThreats += asArray(asRecord(cell.data)?.threats).length;
        return;
      }
      const [sourceId, targetId] = [assetByCell.get(from), assetByCell.get(to)];
      if (!sourceId || !targetId) {
        danglingFlows.notAssets += 1;
        lostThreats += asArray(asRecord(cell.data)?.threats).length;
        return;
      }
      if (sourceId === targetId) {
        danglingFlows.loops += 1;
        lostThreats += asArray(asRecord(cell.data)?.threats).length;
        return;
      }
      const data = asRecord(cell.data) ?? {};
      const given = asString(data.name);
      const label = given && !/^(data )?flow$/i.test(given) ? given : asString(data.description);
      const extras = [flag(data.isPublicNetwork) ? 'red pública' : undefined, flag(data.outOfScope) ? 'fuera de alcance' : undefined].filter(Boolean);
      const base = label ? `${label}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}` : extras.length > 0 ? `Flujo (${extras.join(', ')})` : undefined;
      const protocol = asString(data.protocol);
      const encrypted = typeof data.isEncrypted === 'boolean' ? data.isEncrypted : undefined;
      const make = (a: string, b: string): Flow => {
        let description = base;
        for (let n = 2; flowSignatures.has(`${a}|${b}|${protocol ?? ''}|${description ?? ''}`); n += 1) description = base ? `${base} (${n})` : `Flujo ${n}`;
        flowSignatures.add(`${a}|${b}|${protocol ?? ''}|${description ?? ''}`);
        return {
          id: pickId(`${a}--${b}`, taken),
          sourceId: a,
          targetId: b,
          ...(description ? { description } : {}),
          ...(protocol ? { protocol } : {}),
          ...(encrypted !== undefined ? { encrypted } : {}),
        };
      };
      const forward = make(sourceId, targetId);
      names.set(forward.id, forward.description ?? `${sourceId} → ${targetId}`);
      flows.push(forward);
      if (flag(data.isBidirectional)) flows.push(make(targetId, sourceId));
      targetOfCell.set(String(i), forward.id);
    });

    // ───────────── amenazas y mitigaciones ─────────────
    cells.forEach((cell, i) => {
      const list = asArray(asRecord(cell.data)?.threats).map(asRecord).filter((t): t is JsonRecord => !!t);
      if (list.length === 0) return;
      const targetId = targetOfCell.get(String(i));
      if (!targetId) {
        // Las de un flujo descartado ya se contaron al descartarlo; aquí solo las de fronteras, curvas y notas.
        if (kinds[i] !== 'flow') lostThreats += list.length;
        return;
      }
      const targetName = names.get(targetId) ?? targetId;
      for (const raw of list) {
        anyThreat = true;
        const type = asString(raw.type);
        const model = asString(raw.modelType);
        const original = type ?? 'sin categoría';
        let category: Stride | undefined = type ? STRIDE_OF[key(type)] : undefined;
        if (!category) {
          category = type ? STRIDE_WORDS.find(([pattern]) => pattern.test(strip(type)))?.[1] : undefined;
          if (!category) {
            category = 'tampering';
            withoutEquivalent.push(original);
          }
        }
        const isStride = !!type && STRIDE_DIRECT.has(key(type)) && (!model || model.toUpperCase() === 'STRIDE');
        if (!isStride) {
          const origin = model ?? 'otro modelo';
          converted.set(origin, (converted.get(origin) ?? 0) + 1);
        }
        const rawStatus = asString(raw.status);
        const status = rawStatus ? STATUS_OF[key(rawStatus)] : 'open';
        if (!status) unknownStatuses += 1;
        const impact = asString(raw.severity) ? IMPACT_OF[key(asString(raw.severity)!)] : undefined;
        const title = asString(raw.title) ?? `${original} en ${targetName}`;
        const mitigation = asString(raw.mitigation);
        const notes: string[] = [];
        if (!placeholder(asString(raw.description))) notes.push(asString(raw.description)!);
        if (asString(raw.score)) notes.push(`Puntuación: ${asString(raw.score)}`);
        if (!isStride) notes.push(`Categoría original: ${original}${model ? ` (${model})` : ''}`);
        const id = pickId(`${targetId}--${slug(title)}`, taken);
        const threat: Threat = { id, title, category, targetId, ...(impact ? { impact } : {}), status: status ?? 'open' };
        if (mitigation && !placeholder(mitigation)) {
          if (status === 'accepted') notes.push(`Motivo: ${mitigation}`);
          else {
            const mapKey = strip(mitigation).replace(/\s+/g, ' ').trim();
            let control = controlByText.get(mapKey);
            if (!control) {
              const name = brief(mitigation);
              control = {
                id: pickId(`control-${slug(name) || 'mitigacion'}`, taken),
                name,
                kind: controlKindOf(mitigation),
                status: 'planned',
                ...(name !== mitigation.replace(/\s+/g, ' ').trim() ? { description: mitigation } : {}),
              };
              controlByText.set(mapKey, control);
              controls.push(control);
            }
            if (status === 'mitigated') control.status = 'implemented';
            threat.controlIds = [control.id];
          }
        }
        if (notes.length > 0) threat.description = notes.join(' · ');
        threats.push(threat);
      }
    });
  }

  // ───────────── avisos ─────────────
  if (assets.length === 0) throw new SecurityImportError('El modelo de Threat Dragon no tiene actores, procesos ni almacenes que importar.');
  if (anyBoxes) {
    warnings.add('Threat Dragon no dice qué lado de una frontera es más confiable: lo que queda fuera de toda frontera va a una zona «Exterior» no confiable, la primera frontera es interna y las anidadas, restringidas (salvo que su nombre diga DMZ, Internet o restringida). Revisa la confianza de cada zona.');
    if (outsideCount > 0) warnings.add(`${outsideCount} elemento(s) quedan fuera de toda frontera: se colocan en la zona «Exterior».`);
  } else warnings.add('El modelo no dibuja fronteras de confianza: todos los elementos van a una zona interna por diagrama, así que el análisis de fronteras cruzadas no tiene nada que comprobar.');
  if (unplaced > 0) warnings.add(`${unplaced} elemento(s) no traen posición: no se sabe en qué frontera están.`);
  if (curves.length > 0) warnings.add(`${curves.length} frontera(s) de curva (${shortList(curves)}) no se importan como zona: una curva no delimita un área. Los flujos que cruzan una curva no se marcan como cruce de frontera.`);
  if (texts > 0) warnings.add(`${texts} nota(s) de texto no se importan.`);
  if (unknown.length > 0) warnings.add(`${unknown.length} elemento(s) de tipo desconocido no se importan (${shortList(unknown)}).`);
  const skippedFlows = danglingFlows.unconnected + danglingFlows.notAssets + danglingFlows.loops;
  if (skippedFlows > 0) {
    const reasons = [
      danglingFlows.unconnected > 0 ? `${danglingFlows.unconnected} sin origen o destino conectado` : undefined,
      danglingFlows.notAssets > 0 ? `${danglingFlows.notAssets} hacia algo que no es un actor, proceso ni almacén` : undefined,
      danglingFlows.loops > 0 ? `${danglingFlows.loops} de un elemento consigo mismo` : undefined,
    ].filter(Boolean);
    warnings.add(`${skippedFlows} flujo(s) no se importan: ${reasons.join(', ')}.`);
  }
  if (lostThreats > 0) warnings.add(`${lostThreats} amenaza(s) estaban en elementos que no se importan y se pierden.`);
  if (anyThreat) {
    if (converted.size > 0) warnings.add(`Amenazas de otros modelos (${[...converted].map(([model, n]) => `${model}: ${n}`).join(', ')}) se llevaron a la categoría STRIDE más cercana; la categoría original queda en la descripción.`);
    if (withoutEquivalent.length > 0) warnings.add(`${withoutEquivalent.length} amenaza(s) con categoría sin equivalente STRIDE (${shortList(withoutEquivalent)}) se importan como manipulación.`);
    if (unknownStatuses > 0) warnings.add(`${unknownStatuses} amenaza(s) con un estado desconocido se importan como abiertas.`);
    warnings.add('Threat Dragon solo da la severidad de cada amenaza: se importa como impacto y la probabilidad queda en la media. Cada texto de mitigación distinto es un control (implementado si la amenaza está mitigada, previsto si no); si no hay texto, la amenaza no tiene control.');
  }

  const name = options.name?.trim() || asString(summary.title) || options.fallbackName?.trim() || 'Modelo de amenazas';
  const describe = [asString(summary.description), asString(summary.owner) ? `Responsable del modelo: ${asString(summary.owner)}.` : undefined, asString(detail.reviewer) ? `Revisor: ${asString(detail.reviewer)}.` : undefined].filter(Boolean).join(' ');
  const result = validateSecurityDocument({
    version: SECURITY_DOCUMENT_VERSION,
    workspace: { name, ...(describe ? { description: describe } : {}) },
    zones,
    assets,
    flows,
    threats,
    controls,
  });
  if (!result.ok) throw new SecurityImportError(`No se pudo construir un documento válido a partir de Threat Dragon:\n${formatSecurityIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
