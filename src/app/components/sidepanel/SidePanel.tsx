import { Tabs, TabPane } from '@douyinfe/semi-ui';
import { IconCode, IconList } from '@douyinfe/semi-icons';
import { useCallback, useRef } from 'react';
import { useDocumentStore, type PanelTab } from '../../store/documentStore';
import { AiTab } from './AiTab';
import { ElementsTab } from './ElementsTab';
import { IssuesPanel } from './IssuesPanel';
import { JsonView } from './JsonView';
import { RelationshipsTab } from './RelationshipsTab';
import { ViewsTab } from './ViewsTab';

const MIN_WIDTH = 374;

export function SidePanel() {
  const doc = useDocumentStore((s) => s.doc);
  const ui = useDocumentStore((s) => s.ui);
  const setUi = useDocumentStore((s) => s.setUi);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      setUi({ sidebarWidth: Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.7, e.clientX)) });
    },
    [setUi],
  );
  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Cambiar el ancho sin arrastrar (WCAG 2.5.7): flechas izquierda y derecha, y Inicio / Fin para el mínimo y el máximo.
  const onSeparatorKey = (e: React.KeyboardEvent) => {
    const max = Math.round(window.innerWidth * 0.7);
    const step = e.shiftKey ? 80 : 20;
    const next = e.key === 'ArrowLeft' ? ui.sidebarWidth - step : e.key === 'ArrowRight' ? ui.sidebarWidth + step : e.key === 'Home' ? MIN_WIDTH : e.key === 'End' ? max : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setUi({ sidebarWidth: Math.max(MIN_WIDTH, Math.min(max, next)) });
  };

  return (
    <aside className="flex h-full flex-none" style={{ width: ui.sidebarWidth }} aria-label="Panel lateral">
      <div className="flex flex-col h-full flex-1 min-w-0 sidesheet-theme border-r border-color">
        {ui.sidebarMode === 'structure' ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Tabs type="card" activeKey={ui.panelTab} onChange={(k) => setUi({ panelTab: k as PanelTab })} lazyRender keepDOM={false} tabBarClassName="sticky top-0 z-10 sidesheet-theme px-2 pt-2 c4-tabbar">
              <TabPane tab={`Elementos (${doc.model.elements.length})`} itemKey="elements">
                <ElementsTab />
              </TabPane>
              <TabPane tab={`Relaciones (${doc.model.relationships.length})`} itemKey="relationships">
                <RelationshipsTab />
              </TabPane>
              <TabPane tab={`Vistas (${doc.views.length})`} itemKey="views">
                <ViewsTab />
              </TabPane>
              <TabPane tab="IA" itemKey="ai">
                <AiTab />
              </TabPane>
            </Tabs>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <JsonView />
          </div>
        )}
        {ui.showIssues && ui.sidebarMode === 'structure' && <IssuesPanel />}
        <div className="flex items-center justify-between px-3 py-1 border-t border-color text-xs text-color-2">
          <div className="flex items-center gap-3">
            <span title="Elementos">▣ {doc.model.elements.length}</span>
            <span title="Relaciones">→ {doc.model.relationships.length}</span>
            <span title="Vistas">▤ {doc.views.length}</span>
          </div>
          <div className="flex rounded-md border border-color overflow-hidden">
            <button type="button" className={`px-2 py-0.5 flex items-center ${ui.sidebarMode === 'structure' ? 'segmented-item-active' : 'hover-1'}`} onClick={() => setUi({ sidebarMode: 'structure' })} title="Estructura" aria-label="Estructura" aria-pressed={ui.sidebarMode === 'structure'}>
              <IconList size="small" />
            </button>
            <button type="button" className={`px-2 py-0.5 flex items-center ${ui.sidebarMode === 'json' ? 'segmented-item-active' : 'hover-1'}`} onClick={() => setUi({ sidebarMode: 'json' })} title="JSON" aria-label="JSON" aria-pressed={ui.sidebarMode === 'json'}>
              <IconCode size="small" />
            </button>
          </div>
        </div>
      </div>
      <div
        className="w-0.5 cursor-col-resize hover:bg-blue-500 active:bg-blue-500 transition-colors"
        role="separator"
        aria-orientation="vertical"
        aria-label="Ancho del panel lateral (flechas izquierda y derecha para cambiarlo)"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.round(window.innerWidth * 0.7)}
        aria-valuenow={Math.round(ui.sidebarWidth)}
        tabIndex={0}
        onKeyDown={onSeparatorKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </aside>
  );
}
