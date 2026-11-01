import { describe, expect, it } from 'vitest';
import { assembleDestinations, focusedView, readElementLinks, sameDocumentViews } from './navigator';

const document = {
  views: [
    { id: 'contexto', title: 'Contexto', scopeId: 'banca', elements: [{ id: 'banca' }, { id: 'cliente' }] },
    { id: 'contenedores', title: 'Contenedores', scopeId: 'banca', elements: [{ id: 'banca' }, { id: 'api' }] },
    { id: 'componentes-api', title: 'Componentes', scopeId: 'api', elements: [{ id: 'api' }] },
    { id: 'topologia', title: 'Topología', elements: [{ id: 'api' }, { id: 'web' }, { id: 'db' }] },
    { id: 'env-prod', title: 'Producción', elements: [{ id: 'api' }] },
  ],
  model: {
    elements: [
      { id: 'banca', ref: 'urn:iark:enterprise:banca', refType: 'realizes', links: [{ ref: 'urn:iark:platform:banca', view: 'env-prod' }, { ref: 'urn:iark:enterprise:banca' }] },
      { id: 'api' },
    ],
  },
};

describe('destinos de un elemento', () => {
  it('junta la vista del mismo documento, el detalle y los enlaces sin repetir la URN', () => {
    const links = readElementLinks(document, 'banca');
    expect(links.map((link) => link.ref)).toEqual(['urn:iark:enterprise:banca', 'urn:iark:platform:banca']);
    const destinations = assembleDestinations({
      views: sameDocumentViews(document, 'banca', 'contexto'),
      detail: { label: 'Detallar' },
      links,
      backlinks: [{ urn: 'urn:iark:security:banca', moduleId: 'security', moduleLabel: 'Seguridad', elementId: 'flujo', name: 'Banca', kind: 'flujo', type: 'flujo' }],
    });
    expect(destinations.map((d) => d.label)).toEqual(['Contenedores', 'urn:iark:enterprise:banca · realizes', 'urn:iark:platform:banca', 'Banca · flujo']);
  });

  it('el detalle no se ofrece si ya hay una vista', () => {
    const destinations = assembleDestinations({ views: [{ id: 'contenedores', title: 'Contenedores' }], detail: { label: 'Detallar' }, links: [] });
    expect(destinations).toEqual([{ kind: 'view', id: 'view:contenedores', label: 'Contenedores' }]);
  });

  it('la vista de alcance gana; si no, la que dibuja el elemento con menos nodos', () => {
    const module = {
      views: () => document.views.map((view) => ({ id: view.id, title: view.title })),
      editor: {
        project(doc: unknown, viewId: string) {
          const view = (doc as typeof document).views.find((item) => item.id === viewId);
          return { nodes: (view?.elements ?? []).map((element) => ({ id: element.id })) };
        },
      },
    };
    expect(focusedView(module as never, document, 'api')).toBe('componentes-api');
    expect(focusedView(module as never, document, 'web')).toBe('topologia');
  });
});
