// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TRACE_LINK_TYPES, type EditorSpec, type FieldSpec } from '@iark/kernel';
import type { Backlink } from '../links';
import { Inspector, type LinkTools } from './Inspector';

/** Un editor mínimo: un solo tipo de nodo con los campos que declara un módulo real (`ref` y `refType`). */
const FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Nombre', type: 'text' },
  { key: 'ref', label: 'Referencia (URN)', type: 'text' },
  { key: 'refType', label: 'Tipo de enlace', type: 'text' },
];
const spec = {
  nodeKinds: [{ kind: 'asset', label: 'Activo', glyph: 'A', shape: 'rect', fill: '#fff', width: 100, height: 40 }],
  edgeKinds: [],
  read: (doc: Record<string, Record<string, unknown>>, id: string) => (doc[id] ? { type: 'node', kind: 'asset', values: doc[id] } : undefined),
  fields: () => FIELDS,
} as unknown as EditorSpec<unknown>;

const BACKLINKS: Backlink[] = [
  { urn: 'urn:iark:security:a1', moduleId: 'security', moduleLabel: 'Seguridad', elementId: 'a1', name: 'Activo uno', kind: 'asset', type: 'protects' },
  { urn: 'urn:iark:data:d1', moduleId: 'data', moduleLabel: 'Datos', elementId: 'd1', name: 'Dato uno', kind: 'source', type: 'depends-on' },
];

function links(): LinkTools {
  return {
    modules: [
      { id: 'platform', label: 'Plataforma' },
      { id: 'integration', label: 'Integración' },
    ],
    entities: async (moduleId) => (moduleId === 'platform' ? [{ id: 's1', name: 'Servicio', kind: 'service' }] : []),
    backlinks: async () => BACKLINKS,
    follow: vi.fn(),
  };
}

function mount(values: Record<string, unknown>, options: { readOnly?: boolean; withLinks?: boolean } = {}) {
  const onPatch = vi.fn();
  render(
    <Inspector
      spec={spec}
      document={{ a: { id: 'a', name: 'Activo', ...values } }}
      id="a"
      moduleId="security"
      readOnly={options.readOnly ?? false}
      links={options.withLinks === false ? undefined : links()}
      onPatch={onPatch}
      onRemove={vi.fn()}
    />,
  );
  return { onPatch };
}

describe('Inspector: tipo de enlace', () => {
  it('ofrece el vocabulario sugerido junto al destino, con depends-on por omisión', async () => {
    mount({ ref: 'urn:iark:platform:s1' });
    const type = screen.getByRole('combobox', { name: 'Tipo de enlace' });
    expect(within(type).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(TRACE_LINK_TYPES.map((t) => t.id));
    expect(type).toHaveValue('depends-on');
    expect(within(type).getByRole('option', { name: 'depends-on (por omisión)' })).toBeInTheDocument();
    expect(type).toHaveAttribute('title', expect.stringContaining('se apoya en el destino'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Elemento enlazado' })).toHaveValue('s1'));
    expect(screen.getByTestId('ref-picker').querySelector('small')).toHaveTextContent('urn:iark:platform:s1 · depends-on');
  });

  it('muestra seleccionado el tipo que ya tiene el elemento', () => {
    mount({ ref: 'urn:iark:platform:s1', refType: 'protects' });
    expect(screen.getByRole('combobox', { name: 'Tipo de enlace' })).toHaveValue('protects');
  });

  it('un tipo propio se conserva como opción seleccionada', () => {
    mount({ ref: 'urn:iark:platform:s1', refType: 'mi-tipo' });
    const type = screen.getByRole('combobox', { name: 'Tipo de enlace' });
    expect(type).toHaveValue('mi-tipo');
    expect(within(type).getByRole('option', { name: 'mi-tipo (propio)' })).toBeInTheDocument();
    expect(within(type).getAllByRole('option')).toHaveLength(TRACE_LINK_TYPES.length + 1);
  });

  it('elegir un tipo cambia solo el tipo; elegir depends-on lo quita (es el de por omisión)', async () => {
    const user = userEvent.setup();
    const { onPatch } = mount({ ref: 'urn:iark:platform:s1', refType: 'protects' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tipo de enlace' }), 'implements');
    expect(onPatch).toHaveBeenLastCalledWith('a', { refType: 'implements' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tipo de enlace' }), 'depends-on');
    expect(onPatch).toHaveBeenLastCalledWith('a', { refType: '' });
  });

  it('cambiar el destino conserva el tipo y quitar el módulo borra el enlace con su tipo', async () => {
    const user = userEvent.setup();
    const { onPatch } = mount({ ref: 'urn:iark:platform:s1', refType: 'protects' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Elemento enlazado' })).toHaveValue('s1'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Módulo enlazado' }), '');
    expect(onPatch).toHaveBeenLastCalledWith('a', { ref: '', refType: '' });
  });

  it('el destino nuevo no toca el tipo', async () => {
    const user = userEvent.setup();
    const { onPatch } = mount({});
    await user.selectOptions(screen.getByRole('combobox', { name: 'Módulo enlazado' }), 'platform');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Elemento enlazado' }), 's1');
    expect(onPatch).toHaveBeenLastCalledWith('a', { ref: 'urn:iark:platform:s1' });
  });

  it('sin enlace o en solo lectura el selector de tipo está desactivado', () => {
    mount({});
    expect(screen.getByRole('combobox', { name: 'Tipo de enlace' })).toBeDisabled();
    expect(screen.getByTestId('ref-picker')).toHaveTextContent('Sin enlace');
  });

  it('en solo lectura no se puede cambiar el tipo', () => {
    mount({ ref: 'urn:iark:platform:s1', refType: 'protects' }, { readOnly: true });
    expect(screen.getByRole('combobox', { name: 'Tipo de enlace' })).toBeDisabled();
  });

  it('«Referenciado por» muestra el tipo de cada enlace entrante', async () => {
    mount({});
    const backlinks = await screen.findByTestId('backlinks');
    expect(backlinks).toHaveTextContent('Seguridad: Activo uno');
    expect(within(backlinks).getByText('protects')).toBeInTheDocument();
    expect(within(backlinks).getByText('depends-on')).toBeInTheDocument();
  });

  it('sin las herramientas de enlace, el tipo es un campo de texto más', () => {
    mount({ ref: 'urn:iark:platform:s1', refType: 'mi-tipo' }, { withLinks: false });
    expect(screen.queryByTestId('ref-picker')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Tipo de enlace' })).toHaveValue('mi-tipo');
  });
});
