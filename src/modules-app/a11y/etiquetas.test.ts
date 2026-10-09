import type { EditorGraph } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { anunciarSeleccion, describirNodo, describirRelacion, enumerar, indexarRelaciones, textoCambio } from './etiquetas';

const GRAFO: EditorGraph = {
  nodes: [
    { id: 'sistema', kind: 'system', label: 'Sistema de pedidos' },
    { id: 'web', kind: 'container', label: 'Web', sublabel: 'React', parentId: 'sistema' },
    { id: 'api', kind: 'container', label: 'API de pedidos', sublabel: 'Node.js', parentId: 'sistema', ref: 'api.json', badges: ['crítico'] },
    { id: 'db', kind: 'database', label: 'Base de datos', parentId: 'sistema' },
    { id: 'cola', kind: 'queue', label: 'Cola' },
  ],
  edges: [
    { id: 'e1', source: 'web', target: 'api', kind: 'sync', label: 'Lee pedidos', badges: ['REST'] },
    { id: 'e2', source: 'api', target: 'db', kind: 'sync' },
    { id: 'e3', source: 'api', target: 'cola', kind: 'async' },
    { id: 'fantasma', source: 'api', target: 'no-existe', kind: 'sync' },
  ],
} as EditorGraph;

const indice = indexarRelaciones(GRAFO);
const nodo = (id: string) => GRAFO.nodes.find((n) => n.id === id)!;

describe('enumerar', () => {
  it('une los nombres con comas y «y», y resume con «y N más» pasado el máximo', () => {
    expect(enumerar([])).toBe('');
    expect(enumerar(['A'])).toBe('A');
    expect(enumerar(['A', 'B'])).toBe('A y B');
    expect(enumerar(['A', 'B', 'C'])).toBe('A, B y C');
    expect(enumerar(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D y 2 más');
    expect(enumerar(['A', 'B', 'C'], 2)).toBe('A, B y 1 más');
  });
});

describe('indexarRelaciones', () => {
  it('resuelve los nombres de origen y destino y cuenta los hijos de cada zona', () => {
    expect(indice.salientes.get('api')).toEqual(['Base de datos', 'Cola']);
    expect(indice.entrantes.get('api')).toEqual(['Web']);
    expect(indice.hijos.get('sistema')).toBe(3);
  });

  it('ignora las relaciones cuyo extremo no existe', () => {
    expect(indice.salientes.get('api')).not.toContain('no-existe');
  });
});

describe('describirNodo', () => {
  it('dice el tipo, el nombre, la tecnología, la zona y con quién se relaciona', () => {
    const texto = describirNodo(nodo('api'), { label: 'Contenedor' }, indice);
    expect(texto).toContain('Contenedor: API de pedidos, Node.js');
    expect(texto).toContain('Dentro de «Sistema de pedidos»');
    expect(texto).toContain('Sale hacia 2: Base de datos y Cola');
    expect(texto).toContain('Recibe de 1: Web');
    expect(texto).toContain('Enlaza con otro módulo');
    expect(texto).toContain('Etiquetas: crítico');
    expect(texto.endsWith('.')).toBe(true);
  });

  it('dice cuántos elementos contiene una zona', () => {
    expect(describirNodo(nodo('sistema'), { label: 'Sistema' }, indice)).toContain('Contiene 3 elementos');
  });

  it('un elemento aislado se describe solo por su tipo y su nombre', () => {
    const solo = indexarRelaciones({ nodes: [{ id: 'x', kind: 'k', label: 'X' }], edges: [] } as EditorGraph);
    expect(describirNodo({ id: 'x', kind: 'k', label: 'X' } as EditorGraph['nodes'][number], { label: 'Cosa' }, solo)).toBe('Cosa: X.');
  });

  it('lee cada marca del nodo con su frase completa, antes de la marca de la comparación', () => {
    const marcado = { ...nodo('db'), marks: [{ text: '≈ Producción', title: 'Equivalente en Producción: Base de pedidos' }, { text: '≈ Staging', title: 'Equivalente en Staging: Base de pedidos' }] };
    const texto = describirNodo(marcado, { label: 'Base' }, indice, 'modified');
    expect(texto).toContain('Equivalente en Producción: Base de pedidos. Equivalente en Staging: Base de pedidos. Modificado respecto');
    expect(texto).not.toContain('≈');
  });

  it('añade la marca de la comparación de versiones', () => {
    expect(describirNodo(nodo('cola'), { label: 'Cola' }, indice, 'added')).toContain(textoCambio('added'));
    expect(describirNodo(nodo('cola'), { label: 'Cola' }, indice, 'removed')).toContain('Quitado respecto');
  });
});

describe('describirRelacion', () => {
  it('dice el tipo, el texto y de dónde a dónde va', () => {
    const e1 = GRAFO.edges.find((e) => e.id === 'e1')!;
    expect(describirRelacion(e1, { label: 'Síncrona' }, indice)).toBe('Síncrona «Lee pedidos «REST»»: de Web a API de pedidos.');
  });

  it('sin texto, nombra solo el tipo', () => {
    const e2 = GRAFO.edges.find((e) => e.id === 'e2')!;
    expect(describirRelacion(e2, { label: 'Síncrona' }, indice)).toBe('Síncrona: de API de pedidos a Base de datos.');
    expect(describirRelacion(e2, { label: 'Síncrona' }, indice, 'modified')).toContain('Modificado respecto');
  });
});

describe('anunciarSeleccion', () => {
  it('anuncia la selección vacía, un elemento o varios', () => {
    expect(anunciarSeleccion([])).toBe('Selección vacía.');
    expect(anunciarSeleccion(['API'])).toBe('Seleccionado: API.');
    expect(anunciarSeleccion(['API', 'Web'])).toBe('2 elementos seleccionados.');
  });
});
