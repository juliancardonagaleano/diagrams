import { z } from 'zod';
import { uniqueId, type DomainModule, type EdgeMark, type EditResult, type EditorSpec } from '@iark/kernel';

/** Documento y `EditorSpec` de pruebas que ejercitan todo lo que el banco de trabajo ofrece a un módulo, sin ningún dominio real. */
export interface FakeNode {
  id: string;
  kind: 'service' | 'queue' | 'zone';
  name: string;
  zone?: string;
  retries?: number;
  contractId?: string;
  /** Enlace de prueba (`urn:iark:…`). El lienzo lo lee del documento, no del grafo proyectado. */
  ref?: string;
}

export interface FakeEdge {
  id: string;
  source: string;
  target: string;
  kind: 'sync' | 'async';
  step?: number;
  pattern?: string;
  contractId?: string;
}

export interface FakeContract {
  id: string;
  name: string;
  format: 'openapi' | 'proto';
  version?: string;
  description?: string;
  url?: string;
  text: string;
}

export interface FakeDoc {
  nodes: FakeNode[];
  edges: FakeEdge[];
  contracts: FakeContract[];
}

export const FAKE_DOC: FakeDoc = {
  nodes: [
    { id: 'zona', kind: 'zone', name: 'Pedidos' },
    { id: 'api', kind: 'service', name: 'API', zone: 'zona', retries: 2, contractId: 'api-pedidos' },
    { id: 'cola', kind: 'queue', name: 'Cola de pedidos', zone: 'zona' },
    { id: 'worker', kind: 'service', name: 'Worker' },
    { id: 'libre', kind: 'service', name: 'Servicio libre' },
  ],
  edges: [
    { id: 'api-cola', source: 'api', target: 'cola', kind: 'async', step: 1, pattern: 'saga' },
    { id: 'cola-worker', source: 'cola', target: 'worker', kind: 'async', step: 2 },
  ],
  contracts: [{ id: 'api-pedidos', name: 'API de pedidos', format: 'openapi', version: '1.2.0', description: 'Contrato público', text: '{"openapi":"3.1.0"}' }],
};

const ok = (document: FakeDoc, id?: string): EditResult<FakeDoc> => ({ ok: true, document, ...(id ? { id } : {}) });
const fail = (reason: string): EditResult<FakeDoc> => ({ ok: false, reason });

const marksOf = (e: FakeEdge): EdgeMark[] => [...(e.step ? [{ text: String(e.step), title: `Paso ${e.step}` }] : []), ...(e.pattern ? [{ icon: ['M2 8h12'], title: `Patrón ${e.pattern}` }] : [])];

const contractOptions = (doc: FakeDoc) => doc.contracts.map((c) => ({ value: c.id, label: c.name }));
const used = (doc: FakeDoc, contractId: string): Array<{ id: string; name: string; kind: string }> => [
  ...doc.nodes.filter((n) => n.contractId === contractId).map((n) => ({ id: n.id, name: n.name, kind: n.kind })),
  ...doc.edges.filter((e) => e.contractId === contractId).map((e) => ({ id: e.id, name: e.id, kind: 'relación' })),
];

const contractFormat = (id: string) => ({ id, label: id === 'openapi' ? 'OpenAPI' : 'Protobuf', language: id === 'openapi' ? ('json' as const) : ('proto' as const), extension: id === 'openapi' ? '.json' : '.proto' });

export const fakeEditor: EditorSpec<FakeDoc> = {
  nodeKinds: [
    { kind: 'service', label: 'Servicio', glyph: 'S', shape: 'rounded', fill: '#2563eb', width: 160, height: 64 },
    { kind: 'queue', label: 'Cola', glyph: 'Q', shape: 'pill', fill: '#d97706', width: 160, height: 56 },
    { kind: 'zone', label: 'Zona', glyph: 'Z', shape: 'rect', fill: '#475569', width: 200, height: 120, addable: false },
  ],
  edgeKinds: [
    { kind: 'sync', label: 'Síncrona', stroke: '#334155' },
    { kind: 'async', label: 'Asíncrona', stroke: '#b45309', line: 'dashed' },
  ],
  project(doc) {
    return {
      nodes: doc.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.name, ...(n.zone ? { parentId: n.zone } : {}), ...(n.kind === 'zone' ? { fill: '#0ea5e9', stroke: '#0369a1' } : {}) })),
      edges: doc.edges.map((e) => ({ id: e.id, kind: e.kind, source: e.source, target: e.target, ...(marksOf(e).length > 0 ? { marks: marksOf(e) } : {}) })),
    };
  },
  fields(target, doc) {
    if (target.type === 'edge') return [{ key: 'step', label: 'Paso', type: 'number', min: 1, step: 1 }, { key: 'contractId', label: 'Contrato', type: 'select', options: contractOptions(doc), allowEmpty: true, opensAttachment: true }];
    return [
      { key: 'name', label: 'Nombre', type: 'text' },
      { key: 'retries', label: 'Reintentos', type: 'number', min: 0, step: 1 },
      { key: 'contractId', label: 'Contrato', type: 'select', options: contractOptions(doc), allowEmpty: true, opensAttachment: true },
    ];
  },
  read(doc, id) {
    const node = doc.nodes.find((n) => n.id === id);
    if (node) return { type: 'node', kind: node.kind, values: { name: node.name, retries: node.retries, contractId: node.contractId } };
    const edge = doc.edges.find((e) => e.id === id);
    return edge ? { type: 'edge', kind: edge.kind, values: { step: edge.step, contractId: edge.contractId } } : undefined;
  },
  addNode(doc, kind, name, parentId) {
    const id = uniqueId(name, [...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
    return ok({ ...doc, nodes: [...doc.nodes, { id, kind: kind as FakeNode['kind'], name, ...(parentId ? { zone: parentId } : {}) }] }, id);
  },
  addEdge(doc, kind, source, target) {
    const id = uniqueId(`${source}-${target}`, [...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
    return ok({ ...doc, edges: [...doc.edges, { id, source, target, kind: kind as FakeEdge['kind'] }] }, id);
  },
  update(doc, id, patch) {
    const clean = (value: unknown): unknown => (value === '' ? undefined : value);
    if (doc.nodes.some((n) => n.id === id)) {
      if (patch.name !== undefined && String(patch.name).trim() === '') return fail('El nombre no puede quedar vacío.');
      return ok({ ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, clean(v)])) } : n)) });
    }
    if (doc.edges.some((e) => e.id === id)) return ok({ ...doc, edges: doc.edges.map((e) => (e.id === id ? { ...e, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, clean(v)])) } : e)) });
    return fail(`No existe «${id}».`);
  },
  remove(doc, id) {
    if (doc.nodes.some((n) => n.id === id)) return ok({ ...doc, nodes: doc.nodes.filter((n) => n.id !== id), edges: doc.edges.filter((e) => e.source !== id && e.target !== id) });
    if (doc.edges.some((e) => e.id === id)) return ok({ ...doc, edges: doc.edges.filter((e) => e.id !== id) });
    return fail(`No existe «${id}».`);
  },
  actions: [
    {
      id: 'group',
      label: 'Agrupar en zona',
      hint: 'Mete los servicios seleccionados en una zona',
      needs: 'many',
      prompt: {
        label: 'Nombre de la zona',
        placeholder: 'p. ej. Pedidos',
        initial: (doc, ids) => doc.nodes.find((n) => ids.includes(n.id))?.zone ?? '',
        suggestions: (doc) => doc.nodes.filter((n) => n.kind === 'zone').map((n) => n.name),
      },
      run(doc, ids, input) {
        const name = (input ?? '').trim();
        if (!name) return fail('Escribe el nombre de la zona.');
        const zone = doc.nodes.find((n) => n.kind === 'zone' && n.name === name);
        const zoneId = zone?.id ?? uniqueId(name, doc.nodes.map((n) => n.id));
        const nodes = zone ? doc.nodes : [...doc.nodes, { id: zoneId, kind: 'zone' as const, name }];
        return ok({ ...doc, nodes: nodes.map((n) => (ids.includes(n.id) && n.kind !== 'zone' ? { ...n, zone: zoneId } : n)) }, zoneId);
      },
    },
    {
      id: 'renumber',
      label: 'Renumerar pasos',
      needs: 'none',
      run: (doc) => ok({ ...doc, edges: doc.edges.map((e, i) => ({ ...e, step: i + 1 })) }),
    },
    {
      id: 'inspect',
      label: 'Revisar',
      needs: 'one',
      disabled: (doc, ids) => (doc.nodes.find((n) => n.id === ids[0])?.kind === 'queue' ? 'Las colas no se revisan.' : undefined),
      run: (doc, ids) => ok({ ...doc, nodes: doc.nodes.map((n) => (n.id === ids[0] ? { ...n, retries: (n.retries ?? 0) + 1 } : n)) }),
    },
  ],
  attachments: {
    label: 'Contratos',
    singular: 'contrato',
    formats: [contractFormat('openapi'), contractFormat('proto')],
    list: (doc) => doc.contracts.map((c) => ({ id: c.id, name: c.name, format: c.format, version: c.version, uses: used(doc, c.id).length })),
    read(doc, id) {
      const c = doc.contracts.find((x) => x.id === id);
      return c && { id: c.id, name: c.name, format: c.format, version: c.version, uses: used(doc, id).length, description: c.description, url: c.url, text: c.text, usedBy: used(doc, id) };
    },
    check(format, text) {
      if (text.trim() === '') return [{ severity: 'warning', message: 'El contrato está vacío.', line: 1, column: 1 }];
      if (format === 'proto') return text.includes('syntax') ? [] : [{ severity: 'warning', message: 'Falta la línea syntax.', line: 1, column: 1 }];
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        return parsed.openapi ? [] : [{ severity: 'info', message: 'Falta el campo openapi.', line: 1, column: 1 }];
      } catch {
        return [{ severity: 'error', message: 'JSON inválido.', line: text.split('\n').length, column: 3 }];
      }
    },
    reformat(format, text) {
      if (format === 'proto') return { ok: true, text: text.split('\n').map((l) => l.trim()).join('\n') };
      try {
        return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) };
      } catch {
        return { ok: false, reason: 'No se puede formatear: el JSON no es válido.' };
      }
    },
    template: (format, name) => (format === 'proto' ? `syntax = "proto3";\n// ${name}\n` : JSON.stringify({ openapi: '3.1.0', info: { title: name, version: '1.0.0' } }, null, 2)),
    summary(format, text) {
      if (format === 'proto') return text.split('\n').filter((l) => l.startsWith('message'));
      try {
        return Object.keys((JSON.parse(text) as { paths?: object }).paths ?? {});
      } catch {
        return [];
      }
    },
    transforms: [
      { id: 'to-yaml', label: 'Pasar a YAML', formats: ['openapi'], run: (text) => ({ ok: true, text: `# yaml\n${text}` }) },
      { id: 'to-json', label: 'Pasar a JSON', formats: ['openapi'], run: () => ({ ok: false, reason: 'No es YAML.' }) },
      { id: 'strip', label: 'Quitar comentarios', formats: ['proto'], run: (text) => ({ ok: true, text: text.split('\n').filter((l) => !l.startsWith('//')).join('\n') }) },
    ],
    add(doc, format, name) {
      const id = uniqueId(name, doc.contracts.map((c) => c.id));
      const text = format === 'proto' ? '' : '{}';
      return ok({ ...doc, contracts: [...doc.contracts, { id, name, format: format as FakeContract['format'], text }] }, id);
    },
    update(doc, id, patch) {
      if (patch.name !== undefined && patch.name.trim() === '') return fail('El contrato necesita un nombre.');
      if (!doc.contracts.some((c) => c.id === id)) return fail(`No existe el contrato «${id}».`);
      const { format, ...rest } = patch;
      return ok({ ...doc, contracts: doc.contracts.map((c) => (c.id === id ? { ...c, ...rest, ...(format ? { format: format as FakeContract['format'] } : {}) } : c)) });
    },
    remove: (doc, id) =>
      ok({
        ...doc,
        contracts: doc.contracts.filter((c) => c.id !== id),
        nodes: doc.nodes.map((n) => (n.contractId === id ? { ...n, contractId: undefined } : n)),
        edges: doc.edges.map((e) => (e.contractId === id ? { ...e, contractId: undefined } : e)),
      }),
    createFor(doc, targetId) {
      const id = uniqueId(`contrato-${targetId}`, doc.contracts.map((c) => c.id));
      const contract: FakeContract = { id, name: `Contrato de ${targetId}`, format: 'openapi', text: '{}' };
      return ok(
        {
          ...doc,
          contracts: [...doc.contracts, contract],
          nodes: doc.nodes.map((n) => (n.id === targetId ? { ...n, contractId: id } : n)),
          edges: doc.edges.map((e) => (e.id === targetId ? { ...e, contractId: id } : e)),
        },
        id,
      );
    },
    suggestFormat: () => 'openapi',
  },
};

export const fakeModule: DomainModule<FakeDoc> = {
  id: 'fake',
  name: 'Módulo de pruebas',
  version: '0.0.0',
  documentVersion: '1',
  schema: z.custom<FakeDoc>((v) => typeof v === 'object' && v !== null && Array.isArray((v as FakeDoc).nodes) && Array.isArray((v as FakeDoc).edges) && Array.isArray((v as FakeDoc).contracts)),
  jsonSchema: () => ({}),
  validate: () => [],
  importers: [],
  exporters: [],
  editor: fakeEditor,
};
