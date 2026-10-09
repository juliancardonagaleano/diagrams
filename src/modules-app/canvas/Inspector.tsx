import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_LINK_TYPE, formatUrn, type EditResult, type EditorGraph, type EditorSpec, type EntityRef, type FieldSpec } from '@iark/kernel';
import type { Backlink } from '../links';
import { linkTypeOptions, resolveRef } from '../links';
import type { SelectionItem } from './selection';

/** Lo que el banco de trabajo sabe de los demás módulos, para enlazar sin escribir URN a mano. */
export interface LinkTools {
  modules: Array<{ id: string; label: string }>;
  entities(moduleId: string): Promise<EntityRef[]>;
  backlinks(moduleId: string, elementId: string): Promise<Backlink[]>;
  follow(urn: string): void;
}

interface Props {
  spec: EditorSpec<unknown>;
  document: unknown;
  /** Elemento cuyas propiedades se editan (vacío si no hay exactamente uno seleccionado). */
  id: string;
  /** Con más de un elemento seleccionado, en lugar de propiedades se muestra este resumen. */
  selection?: SelectionItem[];
  readOnly: boolean;
  /** Grafo de la vista abierta: de una relación seleccionada, el panel da a `EditorSpec.fields` sus extremos. */
  graph?: EditorGraph;
  /** Módulo del documento que se edita (para los enlaces entrantes). */
  moduleId?: string;
  links?: LinkTools;
  onPatch(id: string, patch: Record<string, unknown>): void;
  onRemove(id: string): void;
  onRemoveSelection?(): void;
  /** Deja seleccionado solo ese elemento. */
  onPick?(id: string): void;
  /** Aplica un resultado de edición del módulo (con su deshacer) y devuelve el id que trae. */
  onCommit?(result: EditResult<unknown>): string | undefined;
  /** Abre un adjunto del módulo (un contrato) en su editor. */
  onOpenAttachment?(id: string): void;
  /** Contenido añadido al final de las propiedades de un elemento (el formulario para crear una relación sin arrastrar). */
  children?: ReactNode;
}

/** Lo que un campo que apunta a un adjunto necesita para abrirlo o crear uno nuevo. */
interface AttachmentBinding {
  singular: string;
  exists(id: string): boolean;
  open(id: string): void;
  /** Texto del botón para crear uno (con el formato recomendado), o `undefined` si el módulo no sabe crearlos. */
  createLabel?: string;
  create?(): void;
}

/** Lo que el selector de enlace cambia en el elemento: el destino (`ref`) y/o el tipo del enlace (`refType`; vacío = el de por omisión). */
type RefPatch = { ref?: string; refType?: string };

function RefPicker({ value, type, readOnly, links, onCommit }: { value: string; type: string; readOnly: boolean; links: LinkTools; onCommit(patch: RefPatch): void }) {
  const current = resolveRef(value);
  const [moduleId, setModuleId] = useState(current?.moduleId ?? '');
  const [entities, setEntities] = useState<EntityRef[]>([]);
  useEffect(() => {
    setModuleId(current?.moduleId ?? '');
  }, [current?.moduleId]);
  useEffect(() => {
    if (!moduleId) return void setEntities([]);
    let alive = true;
    void links.entities(moduleId).then((list) => alive && setEntities(list));
    return () => {
      alive = false;
    };
  }, [moduleId, links]);
  const typeOptions = linkTypeOptions(type || undefined);
  const selectedType = typeOptions.find((t) => t.id === (type || DEFAULT_LINK_TYPE));
  return (
    <div className="cv-field" data-testid="ref-picker">
      <label htmlFor="cv-f-ref-module">Enlace a otro módulo</label>
      <div className="cv-ref-row">
        <select id="cv-f-ref-module" value={moduleId} disabled={readOnly} onChange={(e) => (setModuleId(e.target.value), e.target.value === '' && onCommit({ ref: '', refType: '' }))} aria-label="Módulo enlazado">
          <option value="">—</option>
          {links.modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={current?.moduleId === moduleId ? current.elementId : ''} disabled={readOnly || !moduleId} onChange={(e) => e.target.value && onCommit({ ref: formatUrn(moduleId, e.target.value) })} aria-label="Elemento enlazado">
          <option value="">{moduleId ? (entities.length ? 'Elige un elemento' : 'Sin elementos') : '—'}</option>
          {entities.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name} ({en.kind})
            </option>
          ))}
        </select>
        {current && (
          <button type="button" className="cv-tool" onClick={() => links.follow(current.urn)} title={`Ir a ${current.urn} (doble clic o Alt+↓)`} data-testid="follow-ref">
            Ir ⤷
          </button>
        )}
      </div>
      <div className="cv-ref-row">
        <select value={type || DEFAULT_LINK_TYPE} disabled={readOnly || !current} onChange={(e) => onCommit({ refType: e.target.value === DEFAULT_LINK_TYPE ? '' : e.target.value })} aria-label="Tipo de enlace" title={selectedType?.description} data-testid="ref-type">
          {typeOptions.map((t) => (
            <option key={t.id} value={t.id} title={t.description}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <small className="cv-hint">{value ? `${value} · ${type || DEFAULT_LINK_TYPE}` : 'Sin enlace'}</small>
    </div>
  );
}

function Backlinks({ moduleId, elementId, links }: { moduleId: string; elementId: string; links: LinkTools }) {
  const [items, setItems] = useState<Backlink[] | undefined>();
  useEffect(() => {
    let alive = true;
    setItems(undefined);
    void links.backlinks(moduleId, elementId).then((list) => alive && setItems(list));
    return () => {
      alive = false;
    };
  }, [moduleId, elementId, links]);
  if (!items || items.length === 0) return null;
  return (
    <div className="cv-field" data-testid="backlinks">
      <span className="cv-field-label" id="cv-backlinks-label">
        Referenciado por
      </span>
      <ul className="cv-backlinks" aria-labelledby="cv-backlinks-label">
        {items.map((b) => (
          <li key={b.urn}>
            <button type="button" className="cv-tool" onClick={() => links.follow(b.urn)} title={`Ir a ${b.urn}`}>
              {b.moduleLabel}: {b.name} <small>({b.kind})</small> <small className="cv-link-type">{b.type}</small> ⤷
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const asList = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : '');

/** Campo del panel de propiedades según su `FieldSpec`; lo reutilizan otros paneles que editan un registro plano. */
export function Field({ field, value, readOnly, onCommit, attachment }: { field: FieldSpec; value: unknown; readOnly: boolean; onCommit(value: unknown): void; attachment?: AttachmentBinding }) {
  const [draft, setDraft] = useState(field.type === 'list' ? asList(value) : asText(value));
  useEffect(() => setDraft(field.type === 'list' ? asList(value) : asText(value)), [value, field.type]);
  const id = `cv-f-${field.key}`;

  if (field.type === 'boolean') {
    return (
      <label className="cv-field cv-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={value === true} disabled={readOnly} onChange={(e) => onCommit(e.target.checked ? true : undefined)} />
        {field.label}
      </label>
    );
  }
  if (field.type === 'select') {
    const current = asText(value);
    return (
      <div className="cv-field">
        <label htmlFor={id}>{field.label}</label>
        <div className="cv-ref-row cv-wrap">
          <select id={id} value={current} disabled={readOnly} title={field.hint} onChange={(e) => onCommit(e.target.value)}>
            {field.allowEmpty && <option value="">—</option>}
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {field.opensAttachment && attachment && current && (
            <button type="button" className="cv-tool" disabled={!attachment.exists(current)} title={attachment.exists(current) ? `Abrir el ${attachment.singular} en su editor` : `El ${attachment.singular} «${current}» no existe`} onClick={() => attachment.open(current)} data-testid="attachment-open">
              Editar ⤷
            </button>
          )}
          {field.opensAttachment && attachment?.create && !current && !readOnly && (
            <button type="button" className="cv-tool" onClick={attachment.create} data-testid="attachment-new">
              {attachment.createLabel}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (field.type === 'number') {
    const confirm = (): void => {
      const typed = draft.trim();
      const current = typeof value === 'number' ? value : undefined;
      if (typed === '') return current === undefined ? undefined : onCommit(undefined);
      const parsed = Number(typed);
      if (!Number.isFinite(parsed)) return setDraft(asText(value));
      if (parsed !== current) onCommit(parsed);
    };
    return (
      <div className="cv-field">
        <label htmlFor={id}>{field.label}</label>
        <input id={id} type="number" min={field.min} step={field.step} value={draft} readOnly={readOnly} placeholder={field.hint} onChange={(e) => setDraft(e.target.value)} onBlur={confirm} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </div>
    );
  }
  const commit = (): void => {
    if (field.type === 'list') {
      const list = draft
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.join(',') !== asList(value).replace(/, /g, ',')) onCommit(list);
    } else if (draft !== asText(value)) onCommit(draft);
  };
  return (
    <div className="cv-field">
      <label htmlFor={id}>{field.label}</label>
      {field.type === 'longtext' ? (
        <textarea id={id} rows={3} value={draft} readOnly={readOnly} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input id={id} type="text" value={draft} readOnly={readOnly} placeholder={field.hint} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
    </div>
  );
}

function bindAttachments(spec: EditorSpec<unknown>, document: unknown, id: string, onCommit: Props['onCommit'], onOpen: Props['onOpenAttachment']): AttachmentBinding | undefined {
  const attachments = spec.attachments;
  if (!attachments || !onOpen) return undefined;
  const format = attachments.suggestFormat?.(document, id);
  const formatLabel = attachments.formats.find((f) => f.id === format)?.label ?? format;
  return {
    singular: attachments.singular,
    exists: (attachmentId) => attachments.read(document, attachmentId) !== undefined,
    open: onOpen,
    ...(attachments.createFor && onCommit
      ? {
          createLabel: `Nuevo ${attachments.singular}${formatLabel ? ` (${formatLabel})` : '…'}`,
          create: () => {
            const created = onCommit(attachments.createFor!(document, id));
            if (created) onOpen(created);
          },
        }
      : {}),
  };
}

/** Panel de propiedades común: los campos de cada tipo los declara el módulo (`EditorSpec.fields`). */
export function Inspector({ spec, document, id, selection, readOnly, graph, moduleId, links, onPatch, onRemove, onRemoveSelection, onPick, onCommit, onOpenAttachment, children }: Props) {
  if (selection && selection.length > 1) {
    return (
      <aside className="cv-inspector" aria-label="Propiedades" data-testid="inspector">
        <h2>{selection.length} elementos seleccionados</h2>
        <ul className="cv-selection" data-testid="selection-list">
          {selection.map((s) => (
            <li key={s.id}>
              <button type="button" className="cv-tool" onClick={() => onPick?.(s.id)} title={`Dejar seleccionado solo «${s.title}»`}>
                <span className="cv-selection-title">{s.title}</span>
                <small>{s.kind}</small>
              </button>
            </li>
          ))}
        </ul>
        {!readOnly && (
          <button type="button" className="cv-danger" onClick={() => onRemoveSelection?.()}>
            Borrar {selection.length} elementos (Supr)
          </button>
        )}
      </aside>
    );
  }
  const item = spec.read(document, id);
  if (!item)
    return (
      <aside className="cv-inspector cv-empty" aria-label="Propiedades" data-testid="inspector-empty">
        Selecciona un elemento o una relación para ver sus propiedades.
      </aside>
    );
  const notation = item.type === 'node' ? spec.nodeKinds.find((k) => k.kind === item.kind) : spec.edgeKinds.find((k) => k.kind === item.kind);
  const edge = item.type === 'edge' ? graph?.edges.find((e) => e.id === id) : undefined;
  const fields = spec.fields({ type: item.type, kind: item.kind, ...(edge ? { id, source: edge.source, target: edge.target } : {}) }, document, item.values);
  const attachment = fields.some((f) => f.type === 'select' && f.opensAttachment) ? bindAttachments(spec, document, id, onCommit, onOpenAttachment) : undefined;
  return (
    <aside className="cv-inspector" aria-label="Propiedades" data-testid="inspector">
      <h2>
        {notation?.label ?? item.kind} <small>{id}</small>
      </h2>
      {fields.map((f) => {
        // Con las herramientas de enlace, el selector del banco de trabajo se ocupa del destino y del tipo del enlace a la vez.
        if (f.key === 'ref' && links) {
          return <RefPicker key={`${id}:ref`} value={asText(item.values.ref)} type={asText(item.values.refType)} readOnly={readOnly} links={links} onCommit={(patch) => onPatch(id, patch)} />;
        }
        if (f.key === 'refType' && links) return null;
        return <Field key={`${id}:${f.key}`} field={f} value={item.values[f.key]} readOnly={readOnly} attachment={attachment} onCommit={(value) => onPatch(id, { [f.key]: value })} />;
      })}
      {links && moduleId && item.type === 'node' && <Backlinks moduleId={moduleId} elementId={id} links={links} />}
      {children}
      {!readOnly && (
        <button type="button" className="cv-danger" onClick={() => onRemove(id)}>
          Borrar (Supr)
        </button>
      )}
    </aside>
  );
}
