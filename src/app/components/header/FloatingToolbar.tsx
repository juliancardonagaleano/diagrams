import { Button, Divider, Dropdown, Tooltip } from '@douyinfe/semi-ui';
import { IconBolt, IconChevronDown, IconMinus, IconMoon, IconPlus, IconRedo, IconSave, IconSun, IconUndo, IconExpand } from '@douyinfe/semi-icons';
import { useReactFlow, useStore as useFlowStore } from '@xyflow/react';
import { useActions } from '../../hooks/useActions';
import { isEmbedMode, useDocumentStore, useTemporalStore } from '../../store/documentStore';
import { ELEMENT_TYPE_LABELS, type ElementType, type LayoutDirection, type LayoutDirectionOption, type LayoutDistribution } from '@core/model/types';
import { formatQuality } from '@core/layout/quality';
import { useFitCamera } from '../canvas/camera';
import { duracion } from '../../../modules-app/a11y/movimiento';

const ADD_BUTTONS: Array<{ type: ElementType; glyph: string }> = [
  { type: 'person', glyph: '👤' },
  { type: 'softwareSystem', glyph: '▣' },
  { type: 'container', glyph: '▢' },
  { type: 'component', glyph: '◫' },
];

export const DIRECTION_GLYPH: Record<LayoutDirection, string> = { DOWN: '↓', RIGHT: '→', UP: '↑', LEFT: '←' };

export const DIRECTIONS: Array<{ value: LayoutDirectionOption; label: string; glyph: string }> = [
  { value: 'auto', label: 'Automática (C1 ↓, C2/C3 →)', glyph: 'A' },
  { value: 'DOWN', label: 'Arriba → abajo', glyph: '↓' },
  { value: 'RIGHT', label: 'Izquierda → derecha', glyph: '→' },
  { value: 'LEFT', label: 'Derecha → izquierda', glyph: '←' },
  { value: 'UP', label: 'Abajo → arriba', glyph: '↑' },
];

export const DISTRIBUTIONS: Array<{ value: LayoutDistribution; label: string }> = [
  { value: 'auto', label: 'Distribución automática (centrada si sale limpia)' },
  { value: 'centered', label: 'Centrada y uniforme' },
  { value: 'elk', label: 'Colocación de ELK' },
];

export function FloatingToolbar({ onEmbedSave }: { onEmbedSave?: (exit: boolean) => void }) {
  const { zoomIn, zoomOut, zoomTo, screenToFlowPosition } = useReactFlow();
  const zoom = useFlowStore((s) => s.transform[2]);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const theme = useDocumentStore((s) => s.ui.theme);
  const direction = useDocumentStore((s) => s.ui.direction);
  const distribution = useDocumentStore((s) => s.ui.distribution);
  const layoutBusy = useDocumentStore((s) => s.layoutBusy);
  const quality = useDocumentStore((s) => s.lastLayoutQuality);
  const activeViewId = useDocumentStore((s) => s.activeViewId);
  const toggleTheme = useDocumentStore((s) => s.toggleTheme);
  const setUi = useDocumentStore((s) => s.setUi);
  const addElement = useDocumentStore((s) => s.addElement);
  const pastStates = useTemporalStore((t) => t.pastStates.length);
  const futureStates = useTemporalStore((t) => t.futureStates.length);
  const actions = useActions();
  const { fit, fitAfter } = useFitCamera();

  // Recoloca la vista y, cuando termina, encuadra; el encuadre queda anotado desde el clic (ver `camera.ts`).
  const autoLayoutAndFit = (direction?: LayoutDirectionOption, distribution?: LayoutDistribution) =>
    fitAfter(actions.autoLayout(direction, distribution), { padding: 0.15, duration: 300 }, 30);

  const addAt = (type: ElementType) => {
    const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
    const center = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2 + (Math.random() * 60 - 30), y: rect.top + rect.height / 2 + (Math.random() * 60 - 30) })
      : { x: 0, y: 0 };
    addElement(type, { x: Math.round(center.x - 120), y: Math.round(center.y - 65) });
    setUi({ panelTab: 'elements', showSidebar: true });
  };

  const zoomLevels = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

  return (
    <div className="py-1.5 px-3 flex items-center gap-1 rounded-xl select-none toolbar-theme shadow-lg border border-color">
      <Dropdown
        trigger="click"
        position="bottomLeft"
        render={
          <Dropdown.Menu>
            <Dropdown.Item onClick={() => fit({ padding: 0.15, duration: 300 })}>Ajustar a la ventana</Dropdown.Item>
            <Dropdown.Divider />
            {zoomLevels.map((z) => (
              <Dropdown.Item key={z} onClick={() => zoomTo(z, { duration: duracion(200) })}>
                {Math.round(z * 100)}%
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        }
      >
        <div className="flex items-center gap-1 px-2 py-1 rounded hover-2 cursor-pointer text-sm">
          <span className="w-[40px] text-right tabular-nums">{Math.round(zoom * 100)}%</span>
          <IconChevronDown size="small" />
        </div>
      </Dropdown>
      <Tooltip content="Acercar (Ctrl + rueda)">
        <Button icon={<IconPlus />} theme="borderless" type="tertiary" aria-label="Acercar" onClick={() => zoomIn({ duration: duracion(150) })} />
      </Tooltip>
      <Tooltip content="Alejar">
        <Button icon={<IconMinus />} theme="borderless" type="tertiary" aria-label="Alejar" onClick={() => zoomOut({ duration: duracion(150) })} />
      </Tooltip>
      <Tooltip content="Ajustar a la ventana">
        <Button icon={<IconExpand />} theme="borderless" type="tertiary" aria-label="Ajustar a la ventana" onClick={() => fit({ padding: 0.15, duration: 300 })} />
      </Tooltip>
      <Divider layout="vertical" margin="6px" />
      <Tooltip content="Deshacer (Ctrl+Z)">
        <Button icon={<IconUndo />} theme="borderless" type="tertiary" aria-label="Deshacer" className="disabled:opacity-50" disabled={pastStates === 0 || readOnly} onClick={actions.undo} />
      </Tooltip>
      <Tooltip content="Rehacer (Ctrl+Y)">
        <Button icon={<IconRedo />} theme="borderless" type="tertiary" aria-label="Rehacer" className="disabled:opacity-50" disabled={futureStates === 0 || readOnly} onClick={actions.redo} />
      </Tooltip>
      <Divider layout="vertical" margin="6px" />
      {ADD_BUTTONS.map((b) => (
        <Tooltip key={b.type} content={`Añadir ${ELEMENT_TYPE_LABELS[b.type].toLowerCase()}`}>
          <Button theme="borderless" type="tertiary" aria-label={`Añadir ${ELEMENT_TYPE_LABELS[b.type].toLowerCase()}`} disabled={readOnly || !activeViewId} onClick={() => addAt(b.type)}>
            <span className="text-base leading-none">{b.glyph}</span>
          </Button>
        </Tooltip>
      ))}
      <Divider layout="vertical" margin="6px" />
      <Tooltip
        content={
          quality && quality.viewId === activeViewId
            ? `Último autolayout: ${formatQuality(quality)}${quality.strategy ? ` · estrategia ${quality.strategy}` : ''}`
            : 'Autolayout de la vista (Ctrl+L): prueba varias estrategias y elige la de menos cruces y solapes'
        }
      >
        <Button
          icon={<IconBolt />}
          theme="light"
          type="primary"
          aria-label="Autolayout"
          loading={layoutBusy}
          disabled={readOnly || !activeViewId}
          onClick={() => autoLayoutAndFit()}
        >
          Autolayout
        </Button>
      </Tooltip>
      {quality && quality.viewId === activeViewId && (
        <span className="c4-quality" data-testid="layout-quality" title="Calidad del último autolayout">
          {quality.crossings === 0 && quality.edgeNodeOverlaps + quality.labelOverlaps === 0 ? '✓ ' : ''}
          {formatQuality({ ...quality, candidates: undefined })}
          {quality.direction ? ` · ${DIRECTION_GLYPH[quality.direction]}` : ''}
          {quality.distribution ? ` ${quality.distribution === 'centered' ? 'centrado' : 'ELK'}` : ''}
        </span>
      )}
      <Dropdown
        trigger="click"
        position="bottomLeft"
        render={
          <Dropdown.Menu>
            <Dropdown.Title>Dirección</Dropdown.Title>
            {DIRECTIONS.map((d) => (
              <Dropdown.Item key={d.value} active={d.value === direction} onClick={() => autoLayoutAndFit(d.value)}>
                <span className="inline-block w-5 font-mono">{d.glyph}</span> {d.label}
              </Dropdown.Item>
            ))}
            <Dropdown.Divider />
            <Dropdown.Title>Distribución</Dropdown.Title>
            {DISTRIBUTIONS.map((d) => (
              <Dropdown.Item key={d.value} active={d.value === distribution} onClick={() => autoLayoutAndFit(undefined, d.value)}>
                {d.label}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        }
      >
        <Button theme="borderless" type="tertiary" aria-label="Dirección y distribución del autolayout" disabled={readOnly}>
          <span className="text-base font-mono">{DIRECTIONS.find((d) => d.value === direction)?.glyph}</span>
          <IconChevronDown size="small" />
        </Button>
      </Dropdown>
      <Divider layout="vertical" margin="6px" />
      <Tooltip content={isEmbedMode ? 'Guardar (Ctrl+S)' : 'Guardar JSON (Ctrl+S)'}>
        <Button icon={<IconSave />} theme="borderless" type="tertiary" aria-label="Guardar" onClick={() => (isEmbedMode ? onEmbedSave?.(false) : actions.saveJson())} />
      </Tooltip>
      <Tooltip content={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}>
        <Button icon={theme === 'dark' ? <IconSun /> : <IconMoon />} theme="borderless" type="tertiary" aria-label={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} onClick={toggleTheme} />
      </Tooltip>
    </div>
  );
}
