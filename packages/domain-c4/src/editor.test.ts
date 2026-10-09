import { describe, expect, it } from 'vitest';
import banca from '../../../examples/banca.json';
import { c4Editor } from './editor';
import { c4Module } from './module';
import { analyzeDocument } from './model/issues';
import { deriveView } from './model/viewDerivation';
import type { C4Document } from './model/types';

const doc = c4Module.schema.parse(banca) as C4Document;
const valid = (d: C4Document): boolean => c4Module.schema.safeParse(d).success;
const errors = (d: C4Document): string[] => analyzeDocument(d).filter((i) => i.severity === 'error').map((i) => i.message);

/** El documento de un resultado correcto; falla la prueba si la operación se rechazó. */
function applied<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  return result as Extract<T, { ok: true }>;
}
const rejected = (result: { ok: boolean; reason?: string }): string => {
  expect(result.ok).toBe(false);
  return result.reason ?? '';
};
const action = (id: string) => c4Editor.actions!.find((a) => a.id === id)!;

describe('proyección C4', () => {
  it('la vista de contenedores dibuja el sistema como límite de sus contenedores, con la figura, el color y la tecnología de cada uno', () => {
    const g = c4Editor.project(doc, 'contenedores');
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['api', 'banca', 'cliente', 'db', 'email', 'mainframe', 'mobile-app', 'spa', 'web-app']);
    expect(g.nodes.find((n) => n.id === 'api')).toMatchObject({ kind: 'container', parentId: 'banca', sublabel: expect.stringContaining('[') });
    expect(g.nodes.find((n) => n.id === 'banca')).toMatchObject({ kind: 'softwareSystem' });
    expect(g.nodes.find((n) => n.id === 'banca')?.parentId).toBeUndefined();
    // Las formas convencionales de C4 son figuras de la geometría compartida.
    expect(g.nodes.find((n) => n.id === 'db')?.shape).toBe('cylinder');
    expect(g.nodes.find((n) => n.id === 'web-app')?.shape).toBe('card');
    expect(g.nodes.find((n) => n.id === 'mobile-app')?.shape).toBe('pill');
    expect(g.nodes.find((n) => n.id === 'api')?.shape).toBeUndefined();
    // Lo externo va gris y discontinuo.
    expect(g.nodes.find((n) => n.id === 'mainframe')).toMatchObject({ dashed: true, fill: '#999999' });
    expect(g.edges.find((e) => e.id === 'r11')).toMatchObject({ kind: 'relationship', source: 'api', target: 'db' });
  });

  it('cada nivel muestra lo suyo: contexto sin contenedores, componentes dentro del contenedor del alcance', () => {
    const contexto = c4Editor.project(doc, 'contexto');
    expect(contexto.nodes.map((n) => n.id).sort()).toEqual(['banca', 'cliente', 'email', 'mainframe']);
    expect(contexto.nodes.every((n) => n.parentId === undefined)).toBe(true);
    const componentes = c4Editor.project(doc, 'componentes-api');
    expect(componentes.nodes.find((n) => n.id === 'signin')).toMatchObject({ kind: 'component', parentId: 'api' });
    // Sin indicar vista se usa la primera; una vista que no existe (la versión base de «Comparar») no tiene nada que dibujar.
    expect(c4Editor.project(doc).nodes.map((n) => n.id)).toEqual(c4Editor.project(doc, 'contexto').nodes.map((n) => n.id));
    expect(c4Editor.project(doc, 'no-existe')).toEqual({ nodes: [], edges: [] });
  });

  it('una relación cuyos extremos no se ven se dibuja implícita, entre sus ancestros visibles, y no se crea ni se borra a mano', () => {
    const sinR1: C4Document = { ...doc, model: { ...doc.model, relationships: doc.model.relationships.filter((r) => r.id !== 'r1') } };
    const g = c4Editor.project(sinR1, 'contexto');
    const implied = g.edges.find((e) => e.kind === 'implied');
    expect(implied).toMatchObject({ id: 'r5@cliente->banca', source: 'cliente', target: 'banca' });
    expect(c4Editor.edgeKinds.find((k) => k.kind === 'implied')).toMatchObject({ addable: false, line: 'dashed' });
    // Se lee y se edita como la relación real que hay detrás.
    expect(c4Editor.read(sinR1, 'r5@cliente->banca')).toMatchObject({ type: 'edge', kind: 'implied' });
    const edited = applied(c4Editor.update(sinR1, 'r5@cliente->banca', { description: 'Entra por el navegador' }));
    expect(edited.document.model.relationships.find((r) => r.id === 'r5')?.description).toBe('Entra por el navegador');
    expect(rejected(c4Editor.remove(sinR1, 'r5@cliente->banca'))).toMatch(/implícita/);
    expect(c4Editor.canConnect!(sinR1, 'implied', 'cliente', 'email')).toMatch(/implícita/);
    expect(rejected(c4Editor.addEdge(sinR1, 'implied', 'cliente', 'email'))).toMatch(/implícita/);
  });

  it('la descripción y la tecnología de una relación van sobre la línea', () => {
    const conTecnologia: C4Document = { ...doc, model: { ...doc.model, relationships: doc.model.relationships.map((r) => (r.id === 'r9' ? { ...r, description: 'Llama', technology: 'JSON/HTTPS' } : r)) } };
    expect(c4Editor.project(conTecnologia, 'contenedores').edges.find((e) => e.id === 'r9')?.label).toBe('Llama [JSON/HTTPS]');
    expect(c4Editor.project(doc, 'contenedores').edges.find((e) => e.id === 'r9')?.label).toBeTruthy();
  });

  it('valida en vivo: los elementos con un error de validate() llevan su marca sobre el dibujo', () => {
    const roto: C4Document = { ...doc, model: { ...doc.model, elements: doc.model.elements.map((e) => (e.id === 'db' ? { ...e, parentId: undefined } : e.id === 'spa' ? { ...e, parentId: 'cliente' } : e)) } };
    const g = c4Editor.project(roto, 'contenedores');
    expect(g.nodes.find((n) => n.id === 'db')?.badges).toEqual(['⚠ Sin padre']);
    expect(g.nodes.find((n) => n.id === 'spa')?.badges).toEqual(['⚠ Padre incorrecto']);
    // Los que tienen error son exactamente los que el módulo marca con severidad de error.
    const marcados = g.nodes.filter((n) => n.badges?.some((b) => b.startsWith('⚠'))).map((n) => n.id).sort();
    const delModulo = c4Module.validate(roto).filter((i) => i.severity === 'error' && i.elementId).map((i) => i.elementId!).sort();
    expect(marcados).toEqual([...new Set(delModulo)].filter((id) => g.nodes.some((n) => n.id === id)));
    // Un documento correcto no marca nada.
    expect(c4Editor.project(doc, 'contenedores').nodes.some((n) => n.badges?.some((b) => b.startsWith('⚠')))).toBe(false);
  });

  it('marca con «⤵ Detalle» el elemento que tiene vista de nivel inferior, salvo que esté enlazado a otro módulo (entonces el doble clic sigue el enlace)', () => {
    const badges = (d: C4Document, view: string, id: string) => c4Editor.project(d, view).nodes.find((n) => n.id === id)?.badges;
    expect(badges(doc, 'contexto', 'banca')).toEqual(['⤵ Detalle']);
    expect(badges(doc, 'contenedores', 'api')).toEqual(['⤵ Detalle']);
    // Sin vista de detalle (la base de datos), una persona o el límite que rodea a los suyos: nada.
    expect(badges(doc, 'contenedores', 'db')).toBeUndefined();
    expect(badges(doc, 'contexto', 'cliente')).toBeUndefined();
    expect(badges(doc, 'contenedores', 'banca')).toBeUndefined();
    const enlazado: C4Document = { ...doc, model: { ...doc.model, elements: doc.model.elements.map((e) => (e.id === 'banca' ? { ...e, ref: 'urn:iark:integration:pedidos' } : e)) } };
    expect(badges(enlazado, 'contexto', 'banca')).toBeUndefined();
  });
});

describe('lectura y campos', () => {
  it('lee los valores de un elemento y de una relación, con la figura predeterminada explícita', () => {
    expect(c4Editor.read(doc, 'db')).toMatchObject({ type: 'node', kind: 'container', values: { type: 'container', name: expect.any(String), parentId: 'banca', shape: 'database' } });
    expect(c4Editor.read(doc, 'api')?.values.shape).toBe('default');
    expect(c4Editor.read(doc, 'r11')).toMatchObject({ type: 'edge', kind: 'relationship' });
    expect(c4Editor.read(doc, 'nada')).toBeUndefined();
  });

  it('los campos dependen del tipo: el padre es un sistema para un contenedor y un contenedor para un componente, y una persona no tiene figura', () => {
    const fieldsOf = (kind: string, id: string) => c4Editor.fields({ type: 'node', kind }, doc, c4Editor.read(doc, id)?.values);
    const container = fieldsOf('container', 'api');
    expect(container.map((f) => f.key)).toEqual(expect.arrayContaining(['type', 'name', 'description', 'technology', 'parentId', 'shape', 'external', 'color', 'tags', 'ref', 'refType']));
    const parent = container.find((f) => f.key === 'parentId');
    expect(parent).toMatchObject({ type: 'select', options: expect.arrayContaining([{ value: 'banca', label: expect.any(String) }]) });
    expect(parent && parent.type === 'select' && parent.options.every((o) => doc.model.elements.find((e) => e.id === o.value)?.type === 'softwareSystem')).toBe(true);
    const component = fieldsOf('component', 'signin').find((f) => f.key === 'parentId');
    expect(component && component.type === 'select' && component.options.every((o) => doc.model.elements.find((e) => e.id === o.value)?.type === 'container')).toBe(true);
    expect(fieldsOf('person', 'cliente').map((f) => f.key)).not.toEqual(expect.arrayContaining(['shape', 'parentId']));
    expect(c4Editor.fields({ type: 'edge', kind: 'relationship' }, doc).map((f) => f.key)).toEqual(['description', 'technology', 'tags']);
  });
});

describe('alta de elementos y relaciones', () => {
  it('un contenedor nuevo en la vista de contenedores pertenece al sistema de la vista y aparece en ella', () => {
    const added = applied(c4Editor.addNode(doc, 'container', 'Caché', undefined, 'contenedores'));
    const created = added.document.model.elements.find((e) => e.id === added.id)!;
    expect(created).toMatchObject({ type: 'container', name: 'Caché', parentId: 'banca' });
    expect(added.document.views.find((v) => v.id === 'contenedores')?.elements.some((e) => e.id === added.id)).toBe(true);
    expect(valid(added.document)).toBe(true);
    expect(c4Editor.project(added.document, 'contenedores').nodes.find((n) => n.id === added.id)).toMatchObject({ parentId: 'banca' });
    // No introduce errores nuevos de validación.
    expect(errors(added.document)).toEqual(errors(doc));
  });

  it('un componente toma como padre el contenedor seleccionado (o el del hermano seleccionado)', () => {
    const porContenedor = applied(c4Editor.addNode(doc, 'component', 'Auditoría', 'api', 'componentes-api'));
    expect(porContenedor.document.model.elements.find((e) => e.id === porContenedor.id)?.parentId).toBe('api');
    const porHermano = applied(c4Editor.addNode(doc, 'component', 'Auditoría', 'signin', 'componentes-api'));
    expect(porHermano.document.model.elements.find((e) => e.id === porHermano.id)?.parentId).toBe('api');
    expect(valid(porHermano.document)).toBe(true);
  });

  it('una persona o un sistema se añaden a cualquier vista, con un id que no choca con los existentes', () => {
    const persona = applied(c4Editor.addNode(doc, 'person', 'Persona nuevo', undefined, 'contexto'));
    expect(doc.model.elements.some((e) => e.id === persona.id)).toBe(false);
    expect(persona.document.model.elements.find((e) => e.id === persona.id)?.name).toBe('Persona nueva');
    const otra = applied(c4Editor.addNode(persona.document, 'person', 'Persona nuevo', undefined, 'contexto'));
    expect(otra.id).not.toBe(persona.id);
    expect(valid(otra.document)).toBe(true);
  });

  it('rechaza lo que la vista no muestra o lo que no tiene padre posible, sin tocar el documento', () => {
    expect(rejected(c4Editor.addNode(doc, 'container', 'X', undefined, 'contexto'))).toMatch(/contexto/);
    expect(rejected(c4Editor.addNode(doc, 'component', 'X', undefined, 'contenedores'))).toMatch(/contenedores/);
    const sinSistemas: C4Document = { ...doc, model: { elements: doc.model.elements.filter((e) => e.type === 'person'), relationships: [] }, views: [] };
    expect(rejected(c4Editor.addNode(sinSistemas, 'container', 'X'))).toMatch(/sistema de software/);
    expect(rejected(c4Editor.addNode(doc, 'nube', 'X'))).toMatch(/no es un tipo/);
  });

  it('una relación nueva se crea con la descripción «Usa» y respeta las reglas de relationshipCreationBlocked', () => {
    expect(c4Editor.canConnect!(doc, 'relationship', 'cliente', 'cliente')).toMatch(/distintos/);
    expect(c4Editor.canConnect!(doc, 'relationship', 'cliente', 'banca')).toMatch(/Ya existe/);
    expect(c4Editor.canConnect!(doc, 'relationship', 'cliente', 'email', 'contexto')).toBeUndefined();
    const added = applied(c4Editor.addEdge(doc, 'relationship', 'web-app', 'db'));
    expect(added.document.model.relationships.find((r) => r.id === added.id)).toMatchObject({ sourceId: 'web-app', targetId: 'db', description: 'Usa' });
    expect(valid(added.document)).toBe(true);
    expect(c4Editor.project(added.document, 'contenedores').edges.some((e) => e.id === added.id)).toBe(true);
    expect(rejected(c4Editor.addEdge(doc, 'relationship', 'cliente', 'banca'))).toMatch(/Ya existe/);
    expect(rejected(c4Editor.addEdge(doc, 'relationship', 'cliente', 'fantasma'))).toMatch(/no existen/);
  });

  it('un límite (el sistema que rodea a sus contenedores) no se conecta: la relación no se vería en esa vista', () => {
    expect(c4Editor.canConnect!(doc, 'relationship', 'email', 'banca', 'contenedores')).toMatch(/límite/);
    expect(c4Editor.canConnect!(doc, 'relationship', 'banca', 'cliente', 'contenedores')).toMatch(/límite/);
    // Pero sí en contexto, donde el sistema es un nodo más.
    expect(c4Editor.canConnect!(doc, 'relationship', 'email', 'banca', 'contexto')).toBeUndefined();
    expect(c4Editor.canConnect!(doc, 'relationship', 'banca', 'cliente', 'contexto')).toBeUndefined();
  });
});

describe('edición de propiedades', () => {
  it('renombra, describe, etiqueta, marca como externo, cambia figura y color, y limpia lo vacío', () => {
    let next = applied(c4Editor.update(doc, 'api', { name: '  API de banca  ', description: 'Reglas de negocio', technology: 'Java', tags: ['core', ' core ', ''], external: true, shape: 'queue', color: '#112233' })).document;
    expect(next.model.elements.find((e) => e.id === 'api')).toMatchObject({ name: 'API de banca', description: 'Reglas de negocio', technology: 'Java', tags: ['core'], external: true, shape: 'queue', color: '#112233' });
    expect(c4Editor.project(next, 'contenedores').nodes.find((n) => n.id === 'api')).toMatchObject({ label: 'API de banca', shape: 'pipe', fill: '#112233', dashed: true });
    next = applied(c4Editor.update(next, 'api', { description: '', tags: [], external: undefined, shape: 'default', color: '' })).document;
    const api = next.model.elements.find((e) => e.id === 'api')!;
    for (const key of ['description', 'tags', 'external', 'shape', 'color']) expect(api).not.toHaveProperty(key);
    expect(valid(next)).toBe(true);
  });

  it('rechaza un nombre vacío, un color mal escrito y una figura desconocida', () => {
    expect(rejected(c4Editor.update(doc, 'api', { name: '   ' }))).toMatch(/nombre/);
    expect(rejected(c4Editor.update(doc, 'api', { color: 'rojo' }))).toMatch(/#RRGGBB/);
    expect(rejected(c4Editor.update(doc, 'api', { shape: 'triángulo' }))).toMatch(/figura/);
    expect(rejected(c4Editor.update(doc, 'fantasma', { name: 'X' }))).toMatch(/no existe/);
  });

  it('el padre solo puede ser del tipo que exige el elemento', () => {
    const otro = applied(c4Editor.addNode(doc, 'softwareSystem', 'Sistema de pagos', undefined, 'contexto'));
    const movido = applied(c4Editor.update(otro.document, 'db', { parentId: otro.id }));
    expect(movido.document.model.elements.find((e) => e.id === 'db')?.parentId).toBe(otro.id);
    expect(rejected(c4Editor.update(doc, 'db', { parentId: 'cliente' }))).toMatch(/sistema de software/);
    expect(rejected(c4Editor.update(doc, 'db', { parentId: '' }))).toMatch(/pertenecer/);
    expect(rejected(c4Editor.update(doc, 'db', { parentId: 'fantasma' }))).toMatch(/no existe/);
    expect(rejected(c4Editor.update(doc, 'cliente', { parentId: 'banca' }))).toMatch(/no pertenece/);
  });

  it('cambiar el tipo respeta lo que cuelga del elemento y suelta un padre que ya no encaja', () => {
    expect(rejected(c4Editor.update(doc, 'banca', { type: 'person' }))).toMatch(/hijos|alcance/);
    expect(rejected(c4Editor.update(doc, 'api', { type: 'person' }))).toMatch(/hijos|alcance/);
    const cambiado = applied(c4Editor.update(doc, 'db', { type: 'softwareSystem' }));
    const db = cambiado.document.model.elements.find((e) => e.id === 'db')!;
    expect(db.type).toBe('softwareSystem');
    expect(db.parentId).toBeUndefined();
    expect(valid(cambiado.document)).toBe(true);
    expect(rejected(c4Editor.update(doc, 'db', { type: 'nube' }))).toMatch(/no es un tipo/);
  });

  it('el enlace a otro módulo se escribe con su tipo y al quitarlo se quita también el tipo', () => {
    const enlazado = applied(c4Editor.update(doc, 'api', { ref: 'urn:iark:integration:pedidos', refType: 'implements' })).document;
    expect(enlazado.model.elements.find((e) => e.id === 'api')).toMatchObject({ ref: 'urn:iark:integration:pedidos', refType: 'implements' });
    expect(c4Editor.project(enlazado, 'contenedores').nodes.find((n) => n.id === 'api')?.ref).toBe('urn:iark:integration:pedidos');
    expect(valid(enlazado)).toBe(true);
    const suelto = applied(c4Editor.update(enlazado, 'api', { ref: '', refType: '' })).document;
    const api = suelto.model.elements.find((e) => e.id === 'api')!;
    expect(api).not.toHaveProperty('ref');
    expect(api).not.toHaveProperty('refType');
  });

  it('una relación se edita en su descripción, tecnología y etiquetas, sin tocar sus extremos', () => {
    const next = applied(c4Editor.update(doc, 'r9', { description: 'Pide datos', technology: 'JSON/HTTPS', tags: ['sync'], sourceId: 'db' })).document;
    expect(next.model.relationships.find((r) => r.id === 'r9')).toEqual({ id: 'r9', sourceId: 'spa', targetId: 'api', description: 'Pide datos', technology: 'JSON/HTTPS', tags: ['sync'] });
  });
});

describe('borrado', () => {
  it('borrar un contenedor arrastra sus componentes, sus relaciones y las vistas que trataban de él', () => {
    const next = applied(c4Editor.remove(doc, 'api')).document;
    expect(next.model.elements.map((e) => e.id)).toEqual(['cliente', 'banca', 'mainframe', 'email', 'web-app', 'spa', 'mobile-app', 'db']);
    expect(next.model.relationships.every((r) => ![r.sourceId, r.targetId].some((id) => ['api', 'signin', 'accounts', 'security', 'mainframe-facade'].includes(id)))).toBe(true);
    expect(next.views.map((v) => v.id)).toEqual(['contexto', 'contenedores']);
    expect(next.views.find((v) => v.id === 'contenedores')?.elements.some((e) => e.id === 'api')).toBe(false);
    expect(valid(next)).toBe(true);
    expect(errors(next)).toEqual([]);
  });

  it('borrar un sistema borra todo su interior', () => {
    const next = applied(c4Editor.remove(doc, 'banca')).document;
    expect(next.model.elements.map((e) => e.id)).toEqual(['cliente', 'mainframe', 'email']);
    expect(next.views).toEqual([]);
    expect(valid(next)).toBe(true);
  });

  it('borrar una relación purga las rutas guardadas en las vistas, también las implícitas', () => {
    const conRutas: C4Document = {
      ...doc,
      views: doc.views.map((v) =>
        v.id === 'contexto'
          ? { ...v, edges: [{ id: 'r1', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, { id: 'r5@cliente->banca', points: [{ x: 0, y: 0 }, { x: 2, y: 2 }] }, { id: 'r2', points: [{ x: 0, y: 0 }, { x: 3, y: 3 }] }] }
          : v,
      ),
    };
    const next = applied(c4Editor.remove(conRutas, 'r1')).document;
    expect(next.model.relationships.some((r) => r.id === 'r1')).toBe(false);
    expect(next.views.find((v) => v.id === 'contexto')?.edges?.map((r) => r.id)).toEqual(['r5@cliente->banca', 'r2']);
    const sinRutas = applied(c4Editor.remove({ ...next }, 'r2')).document;
    expect(sinRutas.views.find((v) => v.id === 'contexto')?.edges?.map((r) => r.id)).toEqual(['r5@cliente->banca']);
    expect(valid(sinRutas)).toBe(true);
  });
});

describe('anidar un contenedor en su límite', () => {
  const dosSistemas = applied(c4Editor.addNode(doc, 'softwareSystem', 'Sistema de pagos', undefined, 'contenedores')).document;
  const pagos = dosSistemas.model.elements.at(-1)!.id;

  it('soltar un contenedor sobre otro sistema lo pasa a ese sistema y descarta su posición guardada', () => {
    const conPosiciones: C4Document = { ...dosSistemas, views: dosSistemas.views.map((v) => (v.id === 'contenedores' ? { ...v, elements: v.elements.map((e) => (e.id === 'db' ? { ...e, x: 10, y: 20, width: 100, height: 50 } : e)) } : v)) };
    const result = c4Editor.drop!(conPosiciones, 'db', pagos, 'contenedores');
    const next = applied(result!).document;
    expect(next.model.elements.find((e) => e.id === 'db')?.parentId).toBe(pagos);
    expect(next.views.find((v) => v.id === 'contenedores')?.elements.find((e) => e.id === 'db')).toEqual({ id: 'db' });
    expect(valid(next)).toBe(true);
    expect(errors(next)).toEqual(errors(conPosiciones));
  });

  it('soltarlo sobre lo que no puede ser su padre, o sobre su padre actual, no significa nada', () => {
    expect(c4Editor.drop!(dosSistemas, 'db', 'cliente', 'contenedores')).toBeUndefined();
    expect(c4Editor.drop!(dosSistemas, 'db', 'api', 'contenedores')).toBeUndefined();
    expect(c4Editor.drop!(dosSistemas, 'db', 'banca', 'contenedores')).toBeUndefined();
    expect(c4Editor.drop!(dosSistemas, 'cliente', pagos, 'contenedores')).toBeUndefined();
  });
});

describe('niveles, enlaces y vistas', () => {
  it('doble clic sobre un sistema abre su vista de contenedores sin tocar el documento', () => {
    const result = applied(c4Editor.activate!(doc, 'banca', 'contexto')!);
    expect(result.view).toBe('contenedores');
    expect(result.document).toBe(doc);
  });

  it('si no tiene vista de detalle, la crea con su alcance y lo que le corresponde según C4', () => {
    const sinVista: C4Document = { ...doc, views: doc.views.filter((v) => v.id === 'contexto') };
    const result = applied(c4Editor.activate!(sinVista, 'banca', 'contexto')!);
    const created = result.document.views.find((v) => v.id === result.view)!;
    expect(created).toMatchObject({ type: 'container', scopeId: 'banca' });
    expect(created.elements.map((e) => e.id)).toEqual(expect.arrayContaining(['web-app', 'spa', 'mobile-app', 'api', 'db', 'cliente', 'mainframe', 'email']));
    expect(created.elements.some((e) => e.id === 'banca')).toBe(false);
    expect(valid(result.document)).toBe(true);
    expect(errors(result.document)).toEqual(errors(sinVista));
    const componentes = applied(c4Editor.activate!(sinVista, 'api', 'contenedores')!);
    expect(componentes.document.views.find((v) => v.id === componentes.view)).toMatchObject({ type: 'component', scopeId: 'api' });
  });

  it('con enlace a otro módulo el doble clic no baja de nivel (lo sigue el lienzo); una persona o un componente no tienen detalle', () => {
    const enlazado = applied(c4Editor.update(doc, 'banca', { ref: 'urn:iark:integration:pedidos' })).document;
    expect(c4Editor.activate!(enlazado, 'banca', 'contexto')).toBeUndefined();
    expect(c4Editor.activate!(doc, 'cliente', 'contexto')).toBeUndefined();
    expect(c4Editor.activate!(doc, 'signin', 'componentes-api')).toBeUndefined();
    // «Detallar» sí baja aunque haya enlace, y avisa si el elemento no se detalla.
    expect(applied(action('detail').run(enlazado, ['banca'])).view).toBe('contenedores');
    expect(action('detail').disabled!(doc, ['cliente'])).toMatch(/sistema o un contenedor/);
    expect(action('detail').disabled!(doc, ['banca'])).toBeUndefined();
    expect(rejected(action('detail').run(doc, ['cliente']))).toMatch(/sistema o un contenedor/);
  });

  it('subir de nivel lleva a la vista del nivel superior; en contexto no hay nivel superior', () => {
    expect(applied(action('up').run(doc, [], undefined, 'componentes-api')).view).toBe('contenedores');
    expect(applied(action('up').run(doc, [], undefined, 'contenedores')).view).toBe('contexto');
    expect(action('up').disabled!(doc, [], 'contexto')).toMatch(/nivel superior/);
    expect(action('up').disabled!(doc, [], 'contenedores')).toBeUndefined();
    expect(rejected(action('up').run(doc, [], undefined, 'contexto'))).toMatch(/nivel superior/);
  });

  it('Alt+↓ y Alt+↑ están reclamados por bajar y subir de nivel', () => {
    expect(c4Editor.actions!.filter((a) => a.shortcut).map((a) => [a.id, a.shortcut])).toEqual([
      ['detail', 'alt+down'],
      ['up', 'alt+up'],
    ]);
  });

  it('la miga lleva de C1 a la vista abierta con el rótulo del editor principal, y es vacía sin vista o con una vista que no existe', () => {
    expect(c4Editor.breadcrumb!(doc, 'componentes-api')).toEqual([
      { id: 'contexto', label: 'C1 Contexto del sistema · Sistema de banca en línea' },
      { id: 'contenedores', label: 'C2 Contenedores · Sistema de banca en línea' },
      { id: 'componentes-api', label: 'C3 Componentes · Aplicación API' },
    ]);
    expect(c4Editor.breadcrumb!(doc, 'contexto').map((c) => c.id)).toEqual(['contexto']);
    expect(c4Editor.breadcrumb!(doc)).toEqual([]);
    expect(c4Editor.breadcrumb!(doc, 'nope')).toEqual([]);
  });

  it('quitar de la vista deja el elemento en el modelo, y el alcance no se puede quitar', () => {
    const remove = action('remove-from-view');
    const next = applied(remove.run(doc, ['email', 'mainframe'], undefined, 'contenedores')).document;
    expect(next.views.find((v) => v.id === 'contenedores')?.elements.map((e) => e.id)).toEqual(['cliente', 'web-app', 'spa', 'mobile-app', 'api', 'db']);
    expect(next.model.elements.some((e) => e.id === 'email')).toBe(true);
    expect(valid(next)).toBe(true);
    expect(remove.disabled!(doc, ['banca'], 'contenedores')).toMatch(/alcance/);
    expect(remove.disabled!(doc, ['banca'], 'contexto')).toMatch(/contexto/);
    expect(remove.disabled!(doc, ['signin'], 'contenedores')).toMatch(/no está/);
    expect(remove.disabled!(doc, ['email'], 'contenedores')).toBeUndefined();
  });

  it('mostrar en la vista añade un elemento existente por su nombre o su id, si la vista puede mostrarlo', () => {
    const show = action('show-in-view');
    const sinEmail = applied(action('remove-from-view').run(doc, ['email'], undefined, 'contenedores')).document;
    expect(show.prompt!.suggestions!(sinEmail, 'contenedores')).toContain('Sistema de correo');
    const porNombre = applied(show.run(sinEmail, [], 'sistema de correo', 'contenedores'));
    expect(porNombre.id).toBe('email');
    expect(porNombre.document.views.find((v) => v.id === 'contenedores')?.elements.some((e) => e.id === 'email')).toBe(true);
    expect(applied(show.run(sinEmail, [], 'email', 'contenedores')).id).toBe('email');
    expect(rejected(show.run(doc, [], 'email', 'contenedores'))).toMatch(/ya está/);
    expect(rejected(show.run(doc, [], 'nada', 'contenedores'))).toMatch(/No hay ningún elemento/);
    expect(rejected(show.run(doc, [], 'signin', 'contenedores'))).toMatch(/no muestra/);
    expect(rejected(show.run(doc, [], 'signin', 'contexto'))).toMatch(/no muestra/);
  });

  it('completar la vista añade lo que C4 manda mostrar y avisa cuando no queda nada', () => {
    const complete = action('complete-view');
    const vacia: C4Document = { ...doc, views: doc.views.map((v) => (v.id === 'contenedores' ? { ...v, elements: [] } : v)) };
    expect(complete.disabled!(vacia, [], 'contenedores')).toBeUndefined();
    const next = applied(complete.run(vacia, [], undefined, 'contenedores')).document;
    expect(next.views.find((v) => v.id === 'contenedores')?.elements.map((e) => e.id)).toEqual(expect.arrayContaining(['web-app', 'spa', 'mobile-app', 'api', 'db']));
    expect(valid(next)).toBe(true);
    expect(complete.disabled!(next, [], 'contenedores')).toMatch(/ya muestra/);
    expect(rejected(complete.run(next, [], undefined, 'contenedores'))).toMatch(/ya muestra/);
  });

  it('crea una vista de contexto (de un sistema o general), la renombra y la elimina', () => {
    const create = action('new-view');
    expect(create.prompt!.initial!(doc, ['banca'])).toBe('Contexto - Sistema de banca en línea');
    expect(create.prompt!.initial!(doc, [])).toBe('Contexto');
    const creada = applied(create.run(doc, ['banca'], 'Contexto de la banca'));
    const view = creada.document.views.find((v) => v.id === creada.view)!;
    expect(view).toMatchObject({ type: 'systemContext', scopeId: 'banca', title: 'Contexto de la banca' });
    expect(view.elements.some((e) => e.id === 'banca')).toBe(true);
    expect(valid(creada.document)).toBe(true);
    expect(errors(creada.document)).toEqual(errors(doc));
    const general = applied(create.run(doc, [], ''));
    expect(general.document.views.find((v) => v.id === general.view)).toMatchObject({ title: 'Contexto' });

    const rename = action('rename-view');
    expect(rename.prompt!.initial!(creada.document, [], creada.view)).toBe('Contexto de la banca');
    const renamed = applied(rename.run(creada.document, [], 'Banca · contexto', creada.view)).document;
    expect(renamed.views.find((v) => v.id === creada.view)?.title).toBe('Banca · contexto');
    expect(rejected(rename.run(creada.document, [], '  ', creada.view))).toMatch(/vacío/);

    const del = action('delete-view');
    const borrada = applied(del.run(renamed, [], undefined, creada.view));
    expect(borrada.document.views.some((v) => v.id === creada.view)).toBe(false);
    expect(borrada.view).toBe('contexto');
    expect(borrada.document.model).toBe(renamed.model);
    expect(del.disabled!(doc, [], 'no-existe')).toBeTruthy();
  });
});

describe('colocación', () => {
  it('coloca los elementos y los límites con ELK y ancla cada relación por el lado que mira a su destino', async () => {
    const layout = await c4Editor.layout!(doc, 'contenedores');
    expect(layout).toBeDefined();
    const ids = deriveView(doc, 'contenedores');
    expect(layout!.nodes.map((n) => n.id).sort()).toEqual(ids.nodes.map((n) => n.id).sort());
    expect(layout!.groups.map((g) => g.id)).toEqual(['banca']);
    const banca = layout!.groups[0];
    // Los contenedores quedan dentro del límite de su sistema.
    for (const id of ['web-app', 'spa', 'mobile-app', 'api', 'db']) {
      const box = layout!.nodes.find((n) => n.id === id)!;
      expect(box.x).toBeGreaterThanOrEqual(banca.x);
      expect(box.y).toBeGreaterThanOrEqual(banca.y);
      expect(box.x + box.width).toBeLessThanOrEqual(banca.x + banca.width);
      expect(box.y + box.height).toBeLessThanOrEqual(banca.y + banca.height);
    }
    expect(layout!.edges.map((e) => e.id).sort()).toEqual(ids.edges.map((e) => e.id).sort());
    expect(layout!.edges.every((e) => e.sides && e.points.length === 2)).toBe(true);
    expect(layout!.width).toBeGreaterThan(0);
  });

  it('respeta las posiciones guardadas en la vista salvo que el autolayout pida recalcular', async () => {
    const guardado: C4Document = {
      ...doc,
      views: doc.views.map((v) => (v.id === 'contexto' ? { ...v, elements: v.elements.map((e, i) => ({ ...e, x: 1000 * (i + 1), y: 40, width: 240, height: 130 })) } : v)),
    };
    const respetado = await c4Editor.layout!(guardado, 'contexto');
    expect(respetado!.nodes.find((n) => n.id === 'cliente')).toMatchObject({ x: 1000, y: 40 });
    const nuevo = await c4Editor.layout!(guardado, 'contexto', { fresh: true });
    expect(nuevo!.nodes.find((n) => n.id === 'cliente')?.x).not.toBe(1000);
  });

  it('una vista sin elementos que colocar deja la colocación al autolayout común', async () => {
    const vacio: C4Document = { ...doc, views: doc.views.map((v) => (v.id === 'contenedores' ? { ...v, elements: [] } : v)) };
    expect(await c4Editor.layout!(vacio, 'contenedores')).toBeUndefined();
    expect(await c4Editor.layout!(doc, 'no-existe')).toBeUndefined();
  });
});

describe('contrato', () => {
  it('es el editor del módulo C4 y no cambia el documento: lo editado vuelve a pasar el esquema y la migración no hace falta', () => {
    expect(c4Module.editor).toBe(c4Editor);
    expect(c4Module.migrations).toEqual([]);
    expect(c4Editor.nodeKinds.map((k) => k.kind)).toEqual(['person', 'softwareSystem', 'container', 'component']);
    expect(c4Editor.defaultEdgeKind).toBe('relationship');
    expect(c4Editor.edgeKinds.filter((k) => k.addable !== false).map((k) => k.kind)).toEqual(['relationship']);
    // Las figuras de la notación son las del vocabulario compartido.
    expect(c4Editor.nodeKinds.find((k) => k.kind === 'person')?.shape).toBe('actor');
  });
});
