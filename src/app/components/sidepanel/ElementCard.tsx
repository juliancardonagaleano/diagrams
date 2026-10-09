import { Button, Input, Select, Switch, TextArea, Tooltip } from '@douyinfe/semi-ui';
import { IconDelete, IconEyeClosed, IconEyeOpened, IconTreeTriangleDown, IconTreeTriangleRight } from '@douyinfe/semi-icons';
import { useEffect, useState } from 'react';
import { C4_COLORS, C4_EXTERNAL_COLOR, ELEMENT_TYPE_LABELS, PARENT_TYPE, type C4Element, type ElementShape, type ElementType } from '@core/model/types';
import { isValidParentType, typeChangeBlockedReason } from '@core/model/factories';
import { useDocumentStore } from '../../store/documentStore';
import { useCampos } from './campos';

const SHAPES: Array<{ value: ElementShape; label: string }> = [
  { value: 'default', label: 'Rectángulo' },
  { value: 'database', label: 'Base de datos' },
  { value: 'queue', label: 'Cola' },
  { value: 'browser', label: 'Navegador' },
  { value: 'mobile', label: 'Móvil' },
];

export function ElementCard({ element, inActiveView, selected }: { element: C4Element; inActiveView: boolean; selected: boolean }) {
  const doc = useDocumentStore((s) => s.doc);
  const activeViewId = useDocumentStore((s) => s.activeViewId);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const { updateElement, removeElement, addElementToView, removeElementFromView, select } = useDocumentStore.getState();
  const [open, setOpen] = useState(selected);
  const campo = useCampos();
  const expanded = open || selected;
  const color = element.color ?? (element.external ? C4_EXTERNAL_COLOR : C4_COLORS[element.type]);
  const parentType = PARENT_TYPE[element.type];
  const parents = parentType ? doc.model.elements.filter((e) => e.type === parentType) : [];

  // Borrador local del nombre: si el store lo controlara directamente, vaciar el campo para
  // reescribirlo "rebotaría" al valor anterior (el store ignora los cambios a nombre vacío).
  const [nameDraft, setNameDraft] = useState(element.name);
  useEffect(() => setNameDraft(element.name), [element.id, element.name]);
  const activeView = doc.views.find((v) => v.id === activeViewId);
  // Alcance de la vista activa. En contenedores/componentes es el boundary (nunca entra como elemento);
  // en contexto es un nodo más: solo queda bloqueado mientras esté en la vista (si falta, se puede añadir).
  const isScope = activeView?.scopeId === element.id && (activeView.type !== 'systemContext' || inActiveView);
  // Motivo (si lo hay) por el que algún otro tipo no se puede elegir: tiene hijos o es alcance de una vista.
  const typeBlockedReason = (Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).map((t) => typeChangeBlockedReason(doc, element.id, t)).find(Boolean) ?? null;

  const toggleCard = (): void => {
    setOpen(!expanded);
    select({ kind: 'element', id: element.id });
  };

  return (
    <div className={`c4-card ${selected ? 'is-selected' : ''}`} data-element-id={element.id}>
      <div
        className="c4-card-header"
        onClick={(e) => {
          if (e.target === e.currentTarget) toggleCard();
        }}
      >
        <button type="button" className="c4-card-main" aria-expanded={expanded} onClick={toggleCard}>
          {expanded ? <IconTreeTriangleDown size="small" /> : <IconTreeTriangleRight size="small" />}
          <span className="h-3 w-3 rounded-sm flex-none" style={{ backgroundColor: color }} aria-hidden="true" />
          <span className="font-medium truncate flex-1">{element.name}</span>
          <span className="text-xs text-color-3 font-mono flex-none">{ELEMENT_TYPE_LABELS[element.type]}</span>
        </button>
        {activeView && (
          <Tooltip content={isScope ? 'Es el alcance de la vista' : inActiveView ? 'Quitar de la vista activa' : 'Añadir a la vista activa'}>
            <Button
              size="small"
              theme="borderless"
              type="tertiary"
              disabled={readOnly || isScope}
              aria-label={isScope ? 'Es el alcance de la vista' : inActiveView ? `Quitar ${element.name} de la vista activa` : `Añadir ${element.name} a la vista activa`}
              icon={inActiveView || isScope ? <IconEyeOpened /> : <IconEyeClosed className="opacity-50" />}
              onClick={(e) => {
                e.stopPropagation();
                if (inActiveView) removeElementFromView(activeView.id, element.id);
                else addElementToView(activeView.id, element.id);
              }}
            />
          </Tooltip>
        )}
      </div>
      {expanded && (
        <div className="c4-card-body">
          <div className="c4-field">
            <label {...campo('nombre').etiqueta}>Nombre</label>
            <Input
              id={campo('nombre').id}
              size="small"
              value={nameDraft}
              disabled={readOnly}
              validateStatus={nameDraft.trim() ? 'default' : 'error'}
              onChange={(v) => {
                setNameDraft(v);
                if (v.trim()) updateElement(element.id, { name: v });
              }}
            />
          </div>
          <div className="c4-field">
            <label {...campo('tipo').etiqueta}>Tipo</label>
            <Select
              {...campo('tipo').select}
              size="small"
              className="w-full"
              value={element.type}
              disabled={readOnly}
              optionList={(Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).map((t) => ({ value: t, label: ELEMENT_TYPE_LABELS[t], disabled: !!typeChangeBlockedReason(doc, element.id, t) }))}
              onChange={(v) => {
                const newType = v as ElementType;
                const currentParent = element.parentId ? doc.model.elements.find((e) => e.id === element.parentId) : undefined;
                const parentStillValid = isValidParentType(currentParent?.type, newType);
                updateElement(element.id, { type: newType, parentId: parentStillValid ? element.parentId : undefined });
              }}
            />
          </div>
          {typeBlockedReason && (
            <p className="text-xs text-color-3 -mt-1">Otros tipos no están disponibles: este elemento {typeBlockedReason}.</p>
          )}
          {parentType && (
            <div className="c4-field">
              <label {...campo('padre').etiqueta}>Pertenece a</label>
              <Select
                {...campo('padre').select}
                size="small"
                className="w-full"
                placeholder={`Elige ${ELEMENT_TYPE_LABELS[parentType].toLowerCase()}`}
                value={element.parentId}
                disabled={readOnly}
                showClear
                optionList={parents.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(v) => updateElement(element.id, { parentId: (v as string | undefined) ?? undefined })}
              />
            </div>
          )}
          {(element.type === 'container' || element.type === 'component') && (
            <div className="c4-field">
              <label {...campo('tecnologia').etiqueta}>Tecnología</label>
              <Input id={campo('tecnologia').id} size="small" value={element.technology ?? ''} placeholder="p. ej. Node.js, PostgreSQL" disabled={readOnly} onChange={(v) => updateElement(element.id, { technology: v })} />
            </div>
          )}
          {element.type !== 'person' && (
            <div className="c4-field">
              <label {...campo('forma').etiqueta}>Forma</label>
              <Select {...campo('forma').select} size="small" className="w-full" value={element.shape ?? 'default'} disabled={readOnly} optionList={SHAPES} onChange={(v) => updateElement(element.id, { shape: v === 'default' ? undefined : (v as ElementShape) })} />
            </div>
          )}
          <div className="c4-field">
            <label {...campo('externo').etiqueta}>Externo</label>
            <Switch id={campo('externo').id} size="small" checked={!!element.external} disabled={readOnly} onChange={(v) => updateElement(element.id, { external: v || undefined })} />
            <label {...campo('color').etiqueta} className="!w-auto ml-2">
              Color
            </label>
            <input
              id={campo('color').id}
              type="color"
              className="h-6 w-8 cursor-pointer rounded border border-color bg-transparent"
              value={color}
              disabled={readOnly}
              onChange={(e) => updateElement(element.id, { color: e.target.value })}
              title="Color de acento (vacío = color C4 por tipo)"
            />
            {element.color && (
              <Button size="small" theme="borderless" type="tertiary" onClick={() => updateElement(element.id, { color: undefined })}>
                reset
              </Button>
            )}
          </div>
          <div className="c4-field items-start">
            <label {...campo('descripcion').etiqueta} className="pt-1">
              Descripción
            </label>
            <TextArea id={campo('descripcion').id} autosize rows={2} value={element.description ?? ''} disabled={readOnly} onChange={(v) => updateElement(element.id, { description: v })} />
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-color-3 font-mono">id: {element.id}</span>
            <Button size="small" type="danger" theme="light" icon={<IconDelete />} disabled={readOnly} onClick={() => removeElement(element.id)}>
              Eliminar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
