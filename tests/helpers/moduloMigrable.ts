import { z } from 'zod';
import type { DocumentMigration, DomainModule } from '@iark/kernel';

/**
 * Un módulo de prueba cuyo formato ha cambiado dos veces, para probar las migraciones de documentos de punta a punta (los seis
 * módulos reales siguen en 1.0, sin migraciones):
 *  - 1.0: `{ name, items: [{ id, label }] }`
 *  - 1.1: el nombre pasa a `workspace.name`
 *  - 2.0: `label` pasa a `title` (versión actual)
 */
export interface DocMigrable {
  version: '2.0';
  workspace: { name: string };
  items: Array<{ id: string; title: string }>;
}

const schema = z.object({
  version: z.literal('2.0').default('2.0'),
  workspace: z.object({ name: z.string() }),
  items: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
});

export const MIGRACIONES: DocumentMigration[] = [
  {
    from: '1.0',
    to: '1.1',
    description: 'El nombre pasa a workspace.name',
    migrate(document) {
      const { name, ...rest } = document as { name: string };
      return { ...rest, workspace: { name } };
    },
  },
  {
    from: '1.1',
    to: '2.0',
    description: 'label pasa a title',
    migrate(document) {
      const old = document as { items?: Array<{ id: string; label: string }> };
      return { ...old, items: (old.items ?? []).map(({ id, label }) => ({ id, title: label })) };
    },
  },
];

export const moduloMigrable: DomainModule<DocMigrable> = {
  id: 'prueba',
  name: 'Módulo de prueba',
  version: '1.0.0',
  documentVersion: '2.0',
  migrations: MIGRACIONES,
  schema: schema as unknown as DomainModule<DocMigrable>['schema'],
  jsonSchema: () => ({}),
  validate: () => [],
  importers: [],
  exporters: [{ id: 'txt', label: 'Texto', extension: '.txt', mime: 'text/plain', export: (d) => d.items.map((i) => i.title).join('\n') }],
  entities: (doc) => doc.items.map((i) => ({ id: i.id, name: i.title, kind: 'item' })),
  views: () => [{ id: 'lista', title: 'Lista' }],
};

/** El mismo documento tal como lo guardaba cada versión del formato. */
export const DOC_V10 = { version: '1.0', name: 'Pedidos', items: [{ id: 'alta', label: 'Alta' }] };
export const DOC_V11 = { version: '1.1', workspace: { name: 'Pedidos' }, items: [{ id: 'alta', label: 'Alta' }] };
export const DOC_V20 = { version: '2.0', workspace: { name: 'Pedidos' }, items: [{ id: 'alta', title: 'Alta' }] };
