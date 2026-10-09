import { Button, Empty, Input, Select, Tag } from '@douyinfe/semi-ui';
import { IconDelete, IconPlus, IconTreeTriangleDown, IconTreeTriangleRight } from '@douyinfe/semi-icons';
import { useState } from 'react';
import { suggestViewElements, viewLevel } from '@core/model/factories';
import { VIEW_SCOPE_TYPE, VIEW_TYPE_LABELS, type C4View, type ViewType } from '@core/model/types';
import { useDocumentStore } from '../../store/documentStore';
import { useCampos } from './campos';

function ViewCard({ view }: { view: C4View }) {
  const doc = useDocumentStore((s) => s.doc);
  const activeViewId = useDocumentStore((s) => s.activeViewId);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const { updateView, removeView, setActiveView, addElementToView, removeElementFromView } = useDocumentStore.getState();
  const [open, setOpen] = useState(false);
  const campo = useCampos();
  const active = view.id === activeViewId;
  const scope = doc.model.elements.find((e) => e.id === view.scopeId);
  const scopeOptions = doc.model.elements.filter((e) => e.type === VIEW_SCOPE_TYPE[view.type]).map((e) => ({ value: e.id, label: e.name }));
  const inView = new Set(view.elements.map((e) => e.id));
  const suggested = suggestViewElements(doc, view.type, view.scopeId).filter((id) => !inView.has(id) && id !== view.scopeId);

  return (
    <div className={`c4-card ${active ? 'is-selected' : ''}`}>
      <div
        className="c4-card-header"
        onClick={(e) => {
          if (e.target === e.currentTarget) setActiveView(view.id);
        }}
      >
        <button
          type="button"
          className="c4-card-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Plegar' : 'Desplegar'} las propiedades de la vista ${view.title ?? view.id}`}
          onClick={() => setOpen(!open)}
        >
          {open ? <IconTreeTriangleDown size="small" /> : <IconTreeTriangleRight size="small" />}
        </button>
        <button type="button" className="c4-card-main" aria-pressed={active} aria-label={`Usar la vista ${view.title ?? view.id} (${VIEW_TYPE_LABELS[view.type]}, ${view.elements.length} elementos)`} onClick={() => setActiveView(view.id)}>
          <span className="c4-crumb-level flex-none" title={VIEW_TYPE_LABELS[view.type]}>
            {viewLevel(view)}
          </span>
          <span className="font-medium truncate flex-1">{view.title ?? view.id}</span>
          <Tag size="small" color={view.type === 'systemContext' ? 'blue' : view.type === 'container' ? 'cyan' : 'light-blue'}>
            {VIEW_TYPE_LABELS[view.type]}
          </Tag>
          <span className="text-xs text-color-3">{view.elements.length}</span>
        </button>
      </div>
      {open && (
        <div className="c4-card-body">
          <div className="c4-field">
            <label {...campo('titulo').etiqueta}>Título</label>
            <Input id={campo('titulo').id} size="small" value={view.title ?? ''} disabled={readOnly} onChange={(v) => updateView(view.id, { title: v })} />
          </div>
          <div className="c4-field">
            <label {...campo('tipo').etiqueta}>Tipo</label>
            <Select
              {...campo('tipo').select}
              size="small"
              className="w-full"
              value={view.type}
              disabled={readOnly}
              optionList={(Object.keys(VIEW_TYPE_LABELS) as ViewType[]).map((t) => ({ value: t, label: VIEW_TYPE_LABELS[t] }))}
              onChange={(v) => updateView(view.id, { type: v as ViewType, scopeId: undefined })}
            />
          </div>
          <div className="c4-field">
            <label {...campo('alcance').etiqueta}>Alcance</label>
            <Select {...campo('alcance').select} size="small" className="w-full" showClear value={view.scopeId} placeholder="Sistema o contenedor" disabled={readOnly} optionList={scopeOptions} onChange={(v) => updateView(view.id, { scopeId: (v as string | undefined) ?? undefined })} />
          </div>
          {scope && (
            <p className="text-xs text-color-3 -mt-1 mb-2">
              {view.type === 'systemContext' ? `Sistema descrito: ${scope.name}` : `Se dibuja como boundary: ${scope.name}`}
            </p>
          )}
          <div className="text-xs text-color-2 mb-1">Elementos en la vista</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {view.elements.map((ve) => {
              const el = doc.model.elements.find((e) => e.id === ve.id);
              return (
                <Tag key={ve.id} size="small" closable={!readOnly && !(view.type === 'systemContext' && ve.id === view.scopeId)} onClose={() => removeElementFromView(view.id, ve.id)}>
                  {el?.name ?? ve.id}
                </Tag>
              );
            })}
            {view.elements.length === 0 && <span className="text-xs text-color-3">vacía</span>}
          </div>
          {suggested.length > 0 && (
            <>
              <div className="text-xs text-color-2 mb-1">Sugeridos por el modelo (clic para añadir)</div>
              <div className="flex flex-wrap gap-1 mb-2">
                {suggested.map((id) => (
                  <Tag key={id} size="small" color="grey" className="cursor-pointer" onClick={() => !readOnly && addElementToView(view.id, id)}>
                    + {doc.model.elements.find((e) => e.id === id)?.name ?? id}
                  </Tag>
                ))}
              </div>
            </>
          )}
          <div className="flex justify-between items-center">
            <span className="text-xs text-color-3 font-mono">id: {view.id}</span>
            <Button size="small" type="danger" theme="light" icon={<IconDelete />} disabled={readOnly} onClick={() => removeView(view.id)}>
              Eliminar vista
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ViewsTab() {
  const doc = useDocumentStore((s) => s.doc);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const addView = useDocumentStore((s) => s.addView);
  const campo = useCampos();
  const [type, setType] = useState<ViewType>('systemContext');
  const [scopeId, setScopeId] = useState<string | undefined>();
  const scopeOptions = doc.model.elements.filter((e) => e.type === VIEW_SCOPE_TYPE[type]).map((e) => ({ value: e.id, label: e.name }));
  return (
    <div className="p-3 space-y-2">
      <div className="flex gap-2 items-center">
        <span id={campo('nueva-tipo').etiqueta.id} className="sr-only">
          Tipo de la nueva vista
        </span>
        <Select
          {...campo('nueva-tipo').select}
          size="small"
          className="flex-1"
          value={type}
          optionList={(Object.keys(VIEW_TYPE_LABELS) as ViewType[]).map((t) => ({ value: t, label: VIEW_TYPE_LABELS[t] }))}
          onChange={(v) => {
            setType(v as ViewType);
            setScopeId(undefined);
          }}
          disabled={readOnly}
        />
        <span id={campo('nueva-alcance').etiqueta.id} className="sr-only">
          Alcance de la nueva vista
        </span>
        <Select {...campo('nueva-alcance').select} size="small" className="flex-1" placeholder="Alcance" showClear value={scopeId} optionList={scopeOptions} onChange={(v) => setScopeId(v as string | undefined)} disabled={readOnly} />
        <Button icon={<IconPlus />} theme="solid" size="small" disabled={readOnly || (type !== 'systemContext' && !scopeId)} onClick={() => addView(type, scopeId)} />
      </div>
      <p className="text-xs text-color-3">Al crear una vista se incluyen automáticamente los elementos que el modelo C4 sugiere y se aplica autolayout.</p>
      {doc.views.length === 0 ? (
        <Empty description="Aún no hay vistas" className="py-6" />
      ) : (
        [...doc.views].sort((a, b) => viewLevel(a).localeCompare(viewLevel(b))).map((v) => <ViewCard key={v.id} view={v} />)
      )}
    </div>
  );
}
