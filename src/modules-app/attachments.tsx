import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { pretty, type AttachmentDetail, type AttachmentDiagnostic, type AttachmentInfo, type AttachmentLanguage, type AttachmentSpec, type EditResult } from '@iark/kernel';
import { useBulkInsert } from './bulkInsert';
import { Field } from './canvas/Inspector';
import type { EditHistory } from './canvas/history';
import { copyText, downloadText, fileStem } from './files';

export interface AttachmentsPanelProps {
  attachments: AttachmentSpec<unknown>;
  /** Documento válido actual; sin él el panel avisa en vez de listar. */
  document: unknown | undefined;
  /** Texto del documento (el que se registra en el historial antes de cada edición). */
  text: string;
  readOnly: boolean;
  history: EditHistory;
  onText(text: string): void;
  notify(message: string): void;
  selectedId?: string;
  onSelect(id: string | undefined): void;
  /** Salta al lienzo y encuadra el elemento que usa el adjunto. */
  onOpenUsage(id: string): void;
}

const LINE_HEIGHT = 18;
const SEVERITY_LABEL = { error: 'Error', warning: 'Aviso', info: 'Nota' } as const;
const MIME: Record<AttachmentLanguage, string> = { json: 'application/json', yaml: 'application/yaml', xml: 'application/xml', proto: 'text/plain', graphql: 'text/plain', text: 'text/plain' };

/** Posición en el texto de una línea y columna (desde 1), ajustadas a lo que existe. */
export function cursorOffset(text: string, line: number, column = 1): number {
  const lines = text.split('\n');
  const row = Math.min(Math.max(line, 1), lines.length);
  const col = Math.min(Math.max(column, 1), lines[row - 1].length + 1);
  return lines.slice(0, row - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
}

function guarded<T>(fallback: T, run: () => T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function worst(diagnostics: readonly AttachmentDiagnostic[]): 'error' | 'warning' | 'info' | 'ok' {
  if (diagnostics.some((d) => d.severity === 'error')) return 'error';
  if (diagnostics.some((d) => d.severity === 'warning')) return 'warning';
  return diagnostics.length > 0 ? 'info' : 'ok';
}

function describeCounts(diagnostics: readonly AttachmentDiagnostic[]): string {
  const count = (severity: AttachmentDiagnostic['severity']): number => diagnostics.filter((d) => d.severity === severity).length;
  const parts = [
    count('error') && plural(count('error'), 'error', 'errores'),
    count('warning') && plural(count('warning'), 'aviso', 'avisos'),
    count('info') && plural(count('info'), 'nota', 'notas'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Sin problemas';
}

interface Row {
  info: AttachmentInfo;
  diagnostics: AttachmentDiagnostic[];
}

function NewAttachment({ attachments, onCreate, onCancel }: { attachments: AttachmentSpec<unknown>; onCreate(format: string, name: string): void; onCancel(): void }) {
  const [format, setFormat] = useState(attachments.formats[0]?.id ?? '');
  const [name, setName] = useState('');
  return (
    <form
      className="at-new"
      data-testid="attachment-new-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(format, name.trim() || `${attachments.singular} nuevo`);
      }}
    >
      <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Formato">
        {attachments.formats.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <input type="text" value={name} placeholder={`Nombre del ${attachments.singular}`} aria-label="Nombre" autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <div className="wb-row">
        <button type="submit" className="primary">
          Crear
        </button>
        <button type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

interface EditorProps {
  attachments: AttachmentSpec<unknown>;
  document: unknown;
  detail: AttachmentDetail;
  readOnly: boolean;
  commit(result: EditResult<unknown>): EditResult<unknown>;
  notify(message: string): void;
  onDeleted(): void;
  onOpenUsage(id: string): void;
}

function AttachmentEditor({ attachments, document, detail, readOnly, commit, notify, onDeleted, onOpenUsage }: EditorProps) {
  const [draft, setDraft] = useState(detail.text);
  const [confirming, setConfirming] = useState<'template' | 'delete' | undefined>();
  const area = useRef<HTMLTextAreaElement>(null);
  useBulkInsert(area, setDraft);
  useEffect(() => setDraft(detail.text), [detail.text]);

  const format = attachments.formats.find((f) => f.id === detail.format);
  const checked = useDeferredValue(draft);
  const diagnostics = useMemo(
    () => guarded<AttachmentDiagnostic[]>([{ severity: 'error', message: 'No se pudo analizar el contenido.' }], () => attachments.check(detail.format, checked, { document, id: detail.id })),
    [attachments, detail.format, detail.id, document, checked],
  );
  const suggestions = useMemo(() => guarded<{ title: string; items: string[] } | undefined>(undefined, () => attachments.suggestions?.(document, detail.id, checked)), [attachments, document, detail.id, checked]);
  const summary = useMemo(() => guarded<string[]>([], () => attachments.summary?.(detail.format, checked) ?? []), [attachments, detail.format, checked]);
  const dirty = draft !== detail.text;

  const update = (patch: Parameters<AttachmentSpec<unknown>['update']>[2]): void => void commit(attachments.update(document, detail.id, patch));
  const applyText = (value: string): void => {
    setDraft(value);
    if (value !== detail.text) update({ text: value });
  };

  const reformat = (): void => {
    const result = attachments.reformat(detail.format, draft, { name: detail.name });
    if (result.ok) applyText(result.text);
    else notify(result.reason);
  };
  const insertTemplate = (): void => {
    if (draft.trim() === '') applyText(attachments.template(detail.format, detail.name));
    else setConfirming('template');
  };
  const transform = (run: NonNullable<AttachmentSpec<unknown>['transforms']>[number]['run']): void => {
    const result = run(draft, { name: detail.name, format: detail.format });
    if (result.ok) applyText(result.text);
    else notify(result.reason);
  };
  const copy = async (): Promise<void> => notify((await copyText(draft)) ? 'Copiado' : 'No se pudo copiar');
  const download = (): void => downloadText(`${fileStem(detail.name, attachments.singular)}${format?.extension ?? '.txt'}`, draft, MIME[format?.language ?? 'text']);
  const remove = (): void => {
    setConfirming(undefined);
    if (commit(attachments.remove(document, detail.id)).ok) onDeleted();
  };
  /** Escribe la sugerencia en el cursor (sustituye la selección, si la hay). */
  const insert = (value: string): void => {
    const el = area.current;
    if (!el || readOnly) return;
    const from = el.selectionStart ?? draft.length;
    const to = el.selectionEnd ?? from;
    applyText(`${draft.slice(0, from)}${value}${draft.slice(to)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from + value.length, from + value.length);
    });
  };
  const jump = (d: AttachmentDiagnostic): void => {
    const el = area.current;
    if (!el || !d.line) return;
    const offset = cursorOffset(el.value, d.line, d.column);
    el.focus();
    el.setSelectionRange(offset, offset);
    el.scrollTop = Math.max(0, (d.line - 3) * LINE_HEIGHT);
  };

  const transforms = (attachments.transforms ?? []).filter((t) => !t.formats || t.formats.includes(detail.format));
  const formatOptions = attachments.formats.map((f) => ({ value: f.id, label: f.label }));

  return (
    <div className="at-editor" data-testid="attachment-editor">
      <div className="at-fields">
        <Field field={{ key: 'name', label: 'Nombre', type: 'text' }} value={detail.name} readOnly={readOnly} onCommit={(v) => update({ name: String(v) })} />
        <Field field={{ key: 'format', label: 'Formato', type: 'select', options: formatOptions }} value={detail.format} readOnly={readOnly} onCommit={(v) => update({ format: String(v) })} />
        <Field field={{ key: 'version', label: 'Versión', type: 'text' }} value={detail.version} readOnly={readOnly} onCommit={(v) => update({ version: String(v) })} />
        <Field field={{ key: 'url', label: 'URL', type: 'text' }} value={detail.url} readOnly={readOnly} onCommit={(v) => update({ url: String(v) })} />
        <div className="at-wide">
          <Field field={{ key: 'description', label: 'Descripción', type: 'longtext' }} value={detail.description} readOnly={readOnly} onCommit={(v) => update({ description: String(v) })} />
        </div>
      </div>

      <div className="at-toolbar" role="toolbar" aria-label="Acciones sobre el texto">
        <button type="button" disabled={readOnly} onClick={reformat} title="Reescribe el texto en su forma canónica" data-testid="attachment-format">
          Formatear
        </button>
        <button type="button" disabled={readOnly} onClick={insertTemplate} title="Plantilla inicial del formato" data-testid="attachment-template">
          Plantilla
        </button>
        {transforms.map((t) => (
          <button key={t.id} type="button" disabled={readOnly} onClick={() => transform(t.run)} data-testid={`attachment-transform-${t.id}`}>
            {t.label}
          </button>
        ))}
        <button type="button" onClick={() => void copy()} data-testid="attachment-copy">
          Copiar
        </button>
        <button type="button" onClick={download} title={`Descargar como ${format?.extension ?? '.txt'}`} data-testid="attachment-download">
          Descargar
        </button>
        <button type="button" className="at-danger" disabled={readOnly} onClick={() => setConfirming('delete')} data-testid="attachment-delete">
          Borrar
        </button>
        {dirty && (
          <span className="wb-chip warning" data-testid="attachment-dirty">
            Cambios sin aplicar
          </span>
        )}
      </div>

      {confirming && (
        <div className="at-confirm" role="alertdialog" aria-label="Confirmar" data-testid="attachment-confirm">
          <span>
            {confirming === 'template'
              ? 'El texto actual se sustituirá por la plantilla del formato.'
              : `¿Borrar el ${attachments.singular} «${detail.name}»?${detail.uses > 0 ? ` ${detail.uses === 1 ? 'Lo usa' : 'Lo usan'} ${plural(detail.uses, 'elemento', 'elementos')}.` : ''}`}
          </span>
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (confirming === 'delete') return remove();
              setConfirming(undefined);
              applyText(attachments.template(detail.format, detail.name));
            }}
          >
            {confirming === 'delete' ? 'Sí, borrar' : 'Sustituir'}
          </button>
          <button type="button" onClick={() => setConfirming(undefined)}>
            Cancelar
          </button>
        </div>
      )}

      <textarea
        ref={area}
        className="at-text"
        aria-label={`Texto del ${attachments.singular}`}
        spellCheck={false}
        value={draft}
        readOnly={readOnly}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => !readOnly && applyText(draft)}
        data-testid="attachment-text"
      />

      <div className="at-diagnostics" data-testid="attachment-diagnostics">
        <strong>Diagnósticos</strong>
        {diagnostics.length === 0 ? (
          <span className="wb-chip ok">Sin problemas</span>
        ) : (
          <ul className="wb-issues">
            {diagnostics.map((d, i) => (
              <li key={i}>
                <span className={`wb-chip ${d.severity}`}>{SEVERITY_LABEL[d.severity]}</span>
                <span>
                  {d.message}
                  {d.line && (
                    <>
                      {' '}
                      <button type="button" className="link" onClick={() => jump(d)} title="Llevar el cursor al texto">
                        línea {d.line}
                        {d.column ? `:${d.column}` : ''}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {suggestions && suggestions.items.length > 0 && (
        <details className="at-section" data-testid="attachment-suggestions">
          <summary>
            {suggestions.title} ({suggestions.items.length})
          </summary>
          <p className="at-muted">Pulsa uno para escribirlo en el cursor.</p>
          <div className="at-chips">
            {suggestions.items.map((item) => (
              <button key={item} type="button" className="at-chip" disabled={readOnly} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(item)} data-testid={`suggestion-${item}`}>
                {item}
              </button>
            ))}
          </div>
        </details>
      )}

      {attachments.summary && (
        <details className="at-section" open data-testid="attachment-summary">
          <summary>Resumen</summary>
          {summary.length === 0 ? (
            <p className="at-muted">No hay nada que resumir todavía.</p>
          ) : (
            <ul>
              {summary.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </details>
      )}

      <details className="at-section" open data-testid="attachment-used-by">
        <summary>Usado por ({detail.usedBy.length})</summary>
        {detail.usedBy.length === 0 ? (
          <p className="at-muted">Todavía no lo usa ningún elemento.</p>
        ) : (
          <ul className="at-used">
            {detail.usedBy.map((u) => (
              <li key={u.id}>
                <button type="button" onClick={() => onOpenUsage(u.id)} title="Ver en el lienzo" data-testid={`used-by-${u.id}`}>
                  {u.name} <small>{u.kind}</small> ⤷
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

/** Pestaña de adjuntos del módulo (los contratos de una integración): lista, editor de texto con diagnósticos y operaciones. */
export function AttachmentsPanel({ attachments, document, text, readOnly, history, onText, notify, selectedId, onSelect, onOpenUsage }: AttachmentsPanelProps) {
  const [creating, setCreating] = useState(false);
  const rows = useMemo<Row[]>(() => {
    if (document === undefined) return [];
    return attachments.list(document).map((info) => ({
      info,
      diagnostics: guarded<AttachmentDiagnostic[]>([], () => {
        const detail = attachments.read(document, info.id);
        return detail ? attachments.check(info.format, detail.text, { document, id: info.id }) : [];
      }),
    }));
  }, [attachments, document]);

  if (document === undefined) {
    return (
      <div className="cv-empty" role="status">
        El documento no es válido: corrígelo en la pestaña JSON para volver a editar los {attachments.label.toLowerCase()}.
      </div>
    );
  }

  const currentId = rows.some((r) => r.info.id === selectedId) ? selectedId : rows[0]?.info.id;
  const detail = currentId ? attachments.read(document, currentId) : undefined;
  const formatLabel = (id: string): string => attachments.formats.find((f) => f.id === id)?.label ?? id;

  const commit = (result: EditResult<unknown>): EditResult<unknown> => {
    if (!result.ok) notify(result.reason);
    else {
      history.record(text);
      onText(pretty(result.document));
    }
    return result;
  };

  const create = (format: string, name: string): void => {
    const result = commit(attachments.add(document, format, name));
    if (!result.ok) return;
    setCreating(false);
    const known = new Set(rows.map((r) => r.info.id));
    onSelect(result.id ?? attachments.list(result.document).find((a) => !known.has(a.id))?.id);
  };

  return (
    <div className="wb-panel at-panel" role="tabpanel" aria-label={attachments.label}>
      <aside className="at-list" aria-label={`Lista de ${attachments.label.toLowerCase()}`}>
        <div className="at-list-head">
          <strong>{attachments.label}</strong>
          <button type="button" disabled={readOnly} aria-expanded={creating} onClick={() => setCreating((c) => !c)} data-testid="attachment-add">
            + Nuevo
          </button>
        </div>
        {creating && !readOnly && <NewAttachment attachments={attachments} onCreate={create} onCancel={() => setCreating(false)} />}
        {rows.length === 0 ? (
          <p className="at-muted">Todavía no hay {attachments.label.toLowerCase()}. Crea uno con «+ Nuevo».</p>
        ) : (
          <ul>
            {rows.map(({ info, diagnostics }) => (
              <li key={info.id}>
                <button type="button" className="at-item" aria-current={info.id === currentId || undefined} onClick={() => onSelect(info.id)} data-testid={`attachment-${info.id}`}>
                  <span className="at-name">{info.name}</span>
                  <span className="wb-chip info">{formatLabel(info.format)}</span>
                  {info.version && <span className="at-meta">{/^v/i.test(info.version) ? info.version : `v${info.version}`}</span>}
                  <span className="at-meta">{info.uses === 0 ? 'sin usos' : plural(info.uses, 'uso', 'usos')}</span>
                  <span className={`wb-chip ${worst(diagnostics)}`} title={describeCounts(diagnostics)} data-testid={`attachment-diagnostics-${info.id}`}>
                    {diagnostics.length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {detail ? (
        <AttachmentEditor
          key={detail.id}
          attachments={attachments}
          document={document}
          detail={detail}
          readOnly={readOnly}
          commit={commit}
          notify={notify}
          onDeleted={() => onSelect(undefined)}
          onOpenUsage={onOpenUsage}
        />
      ) : (
        <div className="cv-empty">{rows.length === 0 ? `Crea un ${attachments.singular} para editar su contenido.` : `Elige un ${attachments.singular} de la lista.`}</div>
      )}
    </div>
  );
}
