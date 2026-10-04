// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pretty, type AttachmentSpec } from '@iark/kernel';
import { AttachmentsPanel, cursorOffset } from './attachments';
import { EditHistory } from './canvas/history';
import { FAKE_DOC, fakeEditor, type FakeDoc } from './testing-editor';

const attachments = fakeEditor.attachments as unknown as AttachmentSpec<unknown>;

const DOC: FakeDoc = {
  ...FAKE_DOC,
  contracts: [
    ...FAKE_DOC.contracts,
    { id: 'roto', name: 'Contrato roto', format: 'openapi', text: '{\n  "paths": ' },
    { id: 'eventos', name: 'Eventos', format: 'proto', version: 'v3', text: 'message Pedido {}\nmessage Pago {}' },
  ],
};

interface Harness {
  history: EditHistory;
  notify: ReturnType<typeof vi.fn>;
  onOpenUsage: ReturnType<typeof vi.fn>;
  doc(): FakeDoc;
  selected(): string | undefined;
}

function mount(options: { doc?: FakeDoc | null; selectedId?: string; readOnly?: boolean } = {}): Harness {
  const history = new EditHistory();
  const notify = vi.fn();
  const onOpenUsage = vi.fn();
  const start = options.doc === undefined ? DOC : options.doc;
  let text = start ? pretty(start) : '{';
  let selected = options.selectedId;
  function Host() {
    const [current, setText] = useState(text);
    const [id, setId] = useState(options.selectedId);
    text = current;
    selected = id;
    return (
      <AttachmentsPanel
        attachments={attachments}
        document={start ? (JSON.parse(current) as unknown) : undefined}
        text={current}
        readOnly={options.readOnly ?? false}
        history={history}
        onText={setText}
        notify={notify}
        selectedId={id}
        onSelect={setId}
        onOpenUsage={onOpenUsage}
      />
    );
  }
  render(<Host />);
  return { history, notify, onOpenUsage, doc: () => JSON.parse(text) as FakeDoc, selected: () => selected };
}

const area = (): HTMLTextAreaElement => screen.getByLabelText('Texto del contrato') as HTMLTextAreaElement;
const replaceText = async (value: string): Promise<void> => {
  await userEvent.clear(area());
  if (!value) return;
  await userEvent.click(area());
  await userEvent.paste(value);
};
const contract = (h: Harness, id: string) => h.doc().contracts.find((c) => c.id === id)!;

afterEach(() => vi.restoreAllMocks());

describe('lista', () => {
  it('muestra nombre, formato, versión, usos y el contador de diagnósticos de cada adjunto', () => {
    mount();
    const api = screen.getByTestId('attachment-api-pedidos');
    expect(api).toHaveTextContent('API de pedidos');
    expect(api).toHaveTextContent('OpenAPI');
    expect(api).toHaveTextContent('v1.2.0');
    expect(api).toHaveTextContent('1 uso');
    expect(screen.getByTestId('attachment-diagnostics-api-pedidos')).toHaveTextContent('0');
    expect(screen.getByTestId('attachment-diagnostics-api-pedidos')).toHaveAttribute('title', 'Sin problemas');
    expect(screen.getByTestId('attachment-roto')).toHaveTextContent('sin usos');
    expect(screen.getByTestId('attachment-diagnostics-roto')).toHaveTextContent('1');
    expect(screen.getByTestId('attachment-diagnostics-roto')).toHaveAttribute('title', '1 error');
    expect(screen.getByTestId('attachment-diagnostics-roto')).toHaveClass('error');
    expect(screen.getByTestId('attachment-eventos')).toHaveTextContent('Protobuf');
    expect(screen.getByTestId('attachment-eventos')).toHaveTextContent('v3');
  });

  it('abre el primero si no hay uno elegido y cambia al elegir otro', async () => {
    const h = mount();
    expect(screen.getByLabelText('Nombre')).toHaveValue('API de pedidos');
    await userEvent.click(screen.getByTestId('attachment-eventos'));
    expect(h.selected()).toBe('eventos');
    expect(screen.getByLabelText('Nombre')).toHaveValue('Eventos');
    expect(screen.getByTestId('attachment-eventos')).toHaveAttribute('aria-current', 'true');
  });

  it('con un documento inválido avisa con el mismo mensaje que el lienzo', () => {
    mount({ doc: null });
    expect(screen.getByRole('status')).toHaveTextContent('El documento no es válido: corrígelo en la pestaña JSON para volver a editar los contratos.');
  });

  it('sin adjuntos invita a crear el primero', () => {
    mount({ doc: { ...FAKE_DOC, contracts: [], nodes: [], edges: [] } });
    expect(screen.getByText(/Todavía no hay contratos/)).toBeInTheDocument();
    expect(screen.getByText('Crea un contrato para editar su contenido.')).toBeInTheDocument();
  });
});

describe('creación', () => {
  it('«+ Nuevo» pide formato y nombre, crea el adjunto con un solo registro de deshacer y lo deja abierto', async () => {
    const h = mount();
    await userEvent.click(screen.getByTestId('attachment-add'));
    const form = screen.getByTestId('attachment-new-form');
    await userEvent.selectOptions(within(form).getByLabelText('Formato'), 'proto');
    await userEvent.type(within(form).getByLabelText('Nombre'), 'Pagos');
    await userEvent.click(within(form).getByRole('button', { name: 'Crear' }));
    expect(h.doc().contracts.at(-1)).toMatchObject({ id: 'pagos', name: 'Pagos', format: 'proto' });
    expect(h.selected()).toBe('pagos');
    expect(screen.queryByTestId('attachment-new-form')).toBeNull();
    expect(h.history.canUndo).toBe(true);
  });

  it('sin nombre usa uno por omisión y Cancelar cierra el formulario', async () => {
    const h = mount();
    await userEvent.click(screen.getByTestId('attachment-add'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByTestId('attachment-new-form')).toBeNull();
    await userEvent.click(screen.getByTestId('attachment-add'));
    await userEvent.click(screen.getByRole('button', { name: 'Crear' }));
    expect(h.doc().contracts.at(-1)?.name).toBe('contrato nuevo');
  });
});

describe('ficha del adjunto', () => {
  it('edita nombre, formato, versión, descripción y URL, cada cambio aplicado y deshacible', async () => {
    const h = mount();
    const name = screen.getByLabelText('Nombre');
    await userEvent.clear(name);
    await userEvent.type(name, 'API v2{Enter}');
    expect(contract(h, 'api-pedidos').name).toBe('API v2');
    await userEvent.selectOptions(screen.getByLabelText('Formato'), 'proto');
    expect(contract(h, 'api-pedidos').format).toBe('proto');
    await userEvent.type(screen.getByLabelText('URL'), 'https://x.test/api{Enter}');
    expect(contract(h, 'api-pedidos').url).toBe('https://x.test/api');
    await userEvent.clear(screen.getByLabelText('Descripción'));
    await userEvent.type(screen.getByLabelText('Descripción'), 'Nueva');
    await userEvent.tab();
    expect(contract(h, 'api-pedidos').description).toBe('Nueva');
    expect(screen.getByLabelText('Versión')).toHaveValue('1.2.0');
  });

  it('si el módulo rechaza un cambio, lo avisa y deja el documento como estaba', async () => {
    const h = mount();
    await userEvent.clear(screen.getByLabelText('Nombre'));
    await userEvent.type(screen.getByLabelText('Nombre'), '{Enter}');
    expect(h.notify).toHaveBeenCalledWith('El contrato necesita un nombre.');
    expect(contract(h, 'api-pedidos').name).toBe('API de pedidos');
  });

  it('«Usado por» salta a cada elemento y «Resumen» lista lo que el módulo extrae', async () => {
    const h = mount({ selectedId: 'eventos' });
    expect(within(screen.getByTestId('attachment-summary')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['message Pedido {}', 'message Pago {}']);
    expect(screen.getByTestId('attachment-used-by')).toHaveTextContent('Todavía no lo usa ningún elemento.');
    await userEvent.click(screen.getByTestId('attachment-api-pedidos'));
    await userEvent.click(screen.getByTestId('used-by-api'));
    expect(h.onOpenUsage).toHaveBeenCalledWith('api');
    expect(screen.getByTestId('attachment-used-by')).toHaveTextContent('Usado por (1)');
  });
});

describe('texto y diagnósticos', () => {
  it('los diagnósticos se recalculan mientras se escribe y llevan el cursor a su línea y columna', async () => {
    mount({ selectedId: 'api-pedidos' });
    const panel = screen.getByTestId('attachment-diagnostics');
    expect(panel).toHaveTextContent('Sin problemas');
    await replaceText('{\n  "a": 1,\n  ');
    const jump = await within(panel).findByRole('button', { name: 'línea 3:3' });
    expect(within(panel).getByText('JSON inválido.')).toBeInTheDocument();
    await userEvent.click(jump);
    expect(area()).toHaveFocus();
    expect(area().selectionStart).toBe(cursorOffset(area().value, 3, 3));
    expect(area().selectionEnd).toBe(area().selectionStart);
  });

  it('el borrador no se aplica hasta salir del campo y entonces queda un único paso de deshacer', async () => {
    const h = mount({ selectedId: 'api-pedidos' });
    await replaceText('{"openapi":"3.1.0","paths":{"/pedidos":{}}}');
    expect(screen.getByTestId('attachment-dirty')).toHaveTextContent('Cambios sin aplicar');
    expect(contract(h, 'api-pedidos').text).toBe('{"openapi":"3.1.0"}');
    expect(h.history.canUndo).toBe(false);
    await userEvent.tab();
    expect(contract(h, 'api-pedidos').text).toBe('{"openapi":"3.1.0","paths":{"/pedidos":{}}}');
    expect(screen.queryByTestId('attachment-dirty')).toBeNull();
    expect(h.history.undo(pretty(h.doc()))).toBe(pretty(DOC));
    expect(h.history.canUndo).toBe(false);
  });

  it('aplicar un borrador igual al texto actual no registra nada', async () => {
    const h = mount({ selectedId: 'api-pedidos' });
    await userEvent.click(area());
    await userEvent.tab();
    expect(h.history.canUndo).toBe(false);
  });

  it('el resumen y el contador se recalculan con el borrador', async () => {
    mount({ selectedId: 'api-pedidos' });
    await replaceText('{"openapi":"3.1.0","paths":{"/a":{},"/b":{}}}');
    expect(await within(screen.getByTestId('attachment-summary')).findAllByRole('listitem')).toHaveLength(2);
  });
});

describe('operaciones', () => {
  it('Formatear reescribe el borrador en su forma canónica y lo aplica', async () => {
    const h = mount({ selectedId: 'api-pedidos' });
    await userEvent.click(screen.getByTestId('attachment-format'));
    expect(area().value).toBe('{\n  "openapi": "3.1.0"\n}');
    expect(contract(h, 'api-pedidos').text).toBe('{\n  "openapi": "3.1.0"\n}');
    expect(h.history.canUndo).toBe(true);
  });

  it('Formatear usa el borrador aunque no se haya aplicado, con un solo cambio añadido por la operación', async () => {
    const h = mount({ selectedId: 'api-pedidos' });
    await replaceText('{"openapi":"3.0.0"}');
    await userEvent.click(screen.getByTestId('attachment-format'));
    expect(contract(h, 'api-pedidos').text).toBe('{\n  "openapi": "3.0.0"\n}');
  });

  it('si no se puede formatear, avisa del motivo y deja el texto como está', async () => {
    const h = mount({ selectedId: 'roto' });
    await userEvent.click(screen.getByTestId('attachment-format'));
    expect(h.notify).toHaveBeenCalledWith('No se puede formatear: el JSON no es válido.');
    expect(contract(h, 'roto').text).toBe('{\n  "paths": ');
    expect(h.history.canUndo).toBe(false);
  });

  it('Plantilla inserta la del formato si el texto está vacío y pide confirmación si no', async () => {
    const h = mount({ selectedId: 'eventos' });
    await userEvent.click(screen.getByTestId('attachment-template'));
    expect(screen.getByTestId('attachment-confirm')).toHaveTextContent('El texto actual se sustituirá por la plantilla del formato.');
    await userEvent.click(within(screen.getByTestId('attachment-confirm')).getByRole('button', { name: 'Cancelar' }));
    expect(contract(h, 'eventos').text).toBe('message Pedido {}\nmessage Pago {}');
    await userEvent.click(screen.getByTestId('attachment-template'));
    await userEvent.click(within(screen.getByTestId('attachment-confirm')).getByRole('button', { name: 'Sustituir' }));
    expect(contract(h, 'eventos').text).toBe('syntax = "proto3";\n// Eventos\n');

    await userEvent.clear(area());
    await userEvent.tab();
    expect(contract(h, 'eventos').text).toBe('');
    await userEvent.click(screen.getByTestId('attachment-template'));
    expect(screen.queryByTestId('attachment-confirm')).toBeNull();
    expect(contract(h, 'eventos').text).toBe('syntax = "proto3";\n// Eventos\n');
  });

  it('ofrece solo las transformaciones aplicables al formato y aplica su resultado', async () => {
    const h = mount({ selectedId: 'api-pedidos' });
    expect(screen.getByTestId('attachment-transform-to-yaml')).toBeInTheDocument();
    expect(screen.queryByTestId('attachment-transform-strip')).toBeNull();
    await userEvent.click(screen.getByTestId('attachment-transform-to-yaml'));
    expect(contract(h, 'api-pedidos').text).toBe('# yaml\n{"openapi":"3.1.0"}');
    await userEvent.click(screen.getByTestId('attachment-transform-to-json'));
    expect(h.notify).toHaveBeenCalledWith('No es YAML.');
    expect(contract(h, 'api-pedidos').text).toBe('# yaml\n{"openapi":"3.1.0"}');
  });

  it('las transformaciones de otro formato aparecen al abrir un adjunto de ese formato', async () => {
    mount({ selectedId: 'eventos' });
    expect(screen.getByTestId('attachment-transform-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('attachment-transform-to-yaml')).toBeNull();
  });

  it('Copiar manda el borrador al portapapeles y lo avisa', async () => {
    const h = mount({ selectedId: 'api-pedidos' });
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
    await userEvent.click(screen.getByTestId('attachment-copy'));
    expect(write).toHaveBeenCalledWith('{"openapi":"3.1.0"}');
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith('Copiado'));
    vi.unstubAllGlobals();
  });

  it('Descargar guarda el texto con la extensión de su formato', async () => {
    mount({ selectedId: 'eventos' });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await userEvent.click(screen.getByTestId('attachment-download'));
    expect(names).toEqual(['eventos.proto']);
  });

  it('Borrar pide confirmación, dice cuántos elementos lo usan y limpia las referencias', async () => {
    const h = mount({ selectedId: 'api-pedidos' });
    await userEvent.click(screen.getByTestId('attachment-delete'));
    const confirm = screen.getByTestId('attachment-confirm');
    expect(confirm).toHaveTextContent('¿Borrar el contrato «API de pedidos»? Lo usa 1 elemento.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancelar' }));
    expect(h.doc().contracts).toHaveLength(3);
    await userEvent.click(screen.getByTestId('attachment-delete'));
    await userEvent.click(within(screen.getByTestId('attachment-confirm')).getByRole('button', { name: 'Sí, borrar' }));
    expect(h.doc().contracts.map((c) => c.id)).toEqual(['roto', 'eventos']);
    expect(h.doc().nodes.find((n) => n.id === 'api')?.contractId).toBeUndefined();
    expect(h.selected()).toBeUndefined();
    expect(screen.getByLabelText('Nombre')).toHaveValue('Contrato roto');
    expect(h.history.canUndo).toBe(true);
  });
});

describe('solo lectura', () => {
  it('se puede leer, copiar y descargar, pero no editar', () => {
    mount({ selectedId: 'api-pedidos', readOnly: true });
    expect(area()).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Nombre')).toHaveAttribute('readonly');
    for (const id of ['add', 'delete'].map((s) => `attachment-${s}`).concat(['attachment-format', 'attachment-template', 'attachment-transform-to-yaml'])) expect(screen.getByTestId(id)).toBeDisabled();
    expect(screen.getByTestId('attachment-copy')).toBeEnabled();
    expect(screen.getByTestId('attachment-download')).toBeEnabled();
  });
});

describe('cursorOffset', () => {
  it('convierte línea y columna (desde 1) en una posición del texto, ajustada a lo que existe', () => {
    const text = 'ab\ncde\n\nf';
    expect(cursorOffset(text, 1, 1)).toBe(0);
    expect(cursorOffset(text, 2, 2)).toBe(4);
    expect(cursorOffset(text, 3)).toBe(7);
    expect(cursorOffset(text, 4, 9)).toBe(9);
    expect(cursorOffset(text, 99, 99)).toBe(9);
    expect(cursorOffset(text, 0, 0)).toBe(0);
  });
});

describe('texto del adjunto', () => {
  it('una inserción sintética muy grande entra de una vez en el borrador', () => {
    mount({ selectedId: 'roto' });
    const text = Array.from({ length: 1500 }, (_, i) => `// línea ${i + 1}`).join('\n');
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
    area().setSelectionRange(0, area().value.length);
    act(() => {
      area().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(area().value).toBe(text);
  });
});
