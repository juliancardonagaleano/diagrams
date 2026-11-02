import { useEffect, useMemo, useState } from 'react';
import { Input, Tabs, TabPane } from '@douyinfe/semi-ui';
import { SCENES, sceneById, type MockNode, type MockScene } from './mocks';

type Panel = 'elements' | 'relationships' | 'views';

/**
 * Mockup de distribución. El marco es el del editor C4 clásico; las figuras y las fichas son fijas.
 * Sirve para ver cómo se reparte cada diagramador, no para editar un documento.
 */
export function Studio({ initialModule }: { initialModule: string | null }) {
  const [moduleId, setModuleId] = useState(sceneById(initialModule).id);
  const [panel, setPanel] = useState<Panel>('elements');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const scene = useMemo(() => sceneById(moduleId), [moduleId]);
  const activeView = view && scene.views.includes(view) ? view : scene.views[0];
  const selected = scene.nodes.find((node) => node.id === selectedId) ?? scene.nodes[0];

  const open = (next: MockScene) => {
    setModuleId(next.id);
    setSelectedId(next.nodes[0]?.id ?? null);
    setView(next.views[0] ?? null);
    setPanel('elements');
    const url = new URL(window.location.href);
    url.searchParams.set('studio', '1');
    url.searchParams.set('module', next.id);
    window.history.replaceState(null, '', url);
  };

  useEffect(() => {
    document.body.setAttribute('theme-mode', dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <div className="h-full flex flex-col overflow-hidden theme">
      <header className="c4-header mesa-bar flex justify-between items-center border-b px-3 py-1.5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-8 w-8 rounded-md flex items-center justify-center text-white font-bold text-sm flex-none" style={{ backgroundColor: 'var(--c4-primary)' }}>
            IA
          </div>
          <div className="min-w-0">
            <h1 className="m-0 text-xl font-medium truncate">{scene.diagram}</h1>
            <div className="flex items-center gap-1">
              {SCENES.map((item) => (
                <button key={item.id} type="button" className="c4-menu-item" aria-current={item.id === scene.id ? 'true' : undefined} onClick={() => open(item)} style={item.id === scene.id ? { color: 'var(--c4-primary)', fontWeight: 600 } : undefined}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-none">
          <span className="text-sm text-color-2">Mockup</span>
          <button type="button" className="c4-menu-item" onClick={() => setDark((value) => !value)}>
            {dark ? 'Claro' : 'Oscuro'}
          </button>
          <button type="button" className="c4-menu-item" disabled style={{ opacity: 0.7, background: 'var(--c4-primary)', color: '#fff', borderRadius: 6, padding: '6px 12px' }}>
            Exportar .drawio
          </button>
        </div>
      </header>
      <div className="flex h-full min-h-0 overflow-hidden">
        <aside className="flex h-full flex-none" style={{ width: 374 }} aria-label="Panel lateral">
          <div className="flex flex-col h-full flex-1 min-w-0 sidesheet-theme border-r border-color">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <Tabs type="card" activeKey={panel} onChange={(key) => setPanel(key as Panel)} tabBarClassName="sticky top-0 z-10 sidesheet-theme px-2 pt-2 c4-tabbar">
                <TabPane tab={`Elementos (${scene.nodes.length})`} itemKey="elements">
                  <div className="flex flex-col gap-2 p-3">
                    {scene.nodes.map((node) => (
                      <NodeCard key={node.id} node={node} selected={node.id === selected.id} onSelect={() => setSelectedId(node.id)} />
                    ))}
                  </div>
                </TabPane>
                <TabPane tab={`Relaciones (${scene.edges.length})`} itemKey="relationships">
                  <ul className="m-0 p-3 flex flex-col gap-2 list-none">
                    {scene.edges.map((edge) => (
                      <li key={edge.id} className="c4-card">
                        <div className="c4-card-header">
                          <strong>{edge.label}</strong>
                          <span className="text-color-3 text-sm">
                            {nameOf(scene, edge.from)} → {nameOf(scene, edge.to)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </TabPane>
                <TabPane tab={`Vistas (${scene.views.length})`} itemKey="views">
                  <ul className="m-0 p-3 flex flex-col gap-2 list-none">
                    {scene.views.map((item) => (
                      <li key={item}>
                        <button type="button" className="c4-card w-full" onClick={() => setView(item)} style={item === activeView ? { borderColor: 'var(--c4-primary)' } : undefined}>
                          <span className="c4-card-header">{item}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </TabPane>
              </Tabs>
            </div>
          </div>
        </aside>
        <main className="relative flex-1 min-w-0 h-full overflow-hidden" aria-label="Lienzo del mockup">
          <Canvas scene={scene} selectedId={selected.id} onSelect={setSelectedId} />
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-24px)]">
            <div className="py-1.5 px-3 flex items-center gap-2 rounded-xl select-none toolbar-theme border border-color text-sm">
              <span>100%</span>
              <span className="text-color-3">+</span>
              <span className="text-color-3">−</span>
              <span className="text-color-3">Deshacer</span>
              <span style={{ color: 'var(--c4-primary)' }}>Autolayout</span>
            </div>
          </div>
          <div className="absolute bottom-3 left-3 z-10">
            <div className="py-1 px-2 rounded-lg toolbar-theme border border-color text-sm">{scene.crumb}</div>
          </div>
          <p className="absolute bottom-3 right-3 z-10 m-0 text-sm text-color-3">Vista: {activeView}</p>
        </main>
      </div>
    </div>
  );
}

function nameOf(scene: MockScene, id: string): string {
  return scene.nodes.find((node) => node.id === id)?.name ?? id;
}

function NodeCard({ node, selected, onSelect }: { node: MockNode; selected: boolean; onSelect(): void }) {
  return (
    <article className={selected ? 'c4-card is-selected' : 'c4-card'}>
      <button type="button" className="c4-card-header w-full" onClick={onSelect} style={{ border: 0, background: 'transparent', width: '100%' }}>
        <span className="c4-card-main">
          <strong className="truncate">{node.name}</strong>
        </span>
        <span className="text-color-3 text-sm flex-none">{node.kind}</span>
      </button>
      {selected && (
        <div className="c4-card-body">
          {node.fields.map((item) => (
            <div key={item.label} className="c4-field">
              <label>{item.label}</label>
              <Input className="flex-1 min-w-0" size="small" readonly value={item.value} aria-label={item.label} />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function Canvas({ scene, selectedId, onSelect }: { scene: MockScene; selectedId: string; onSelect(id: string): void }) {
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  return (
    <div className="c4-canvas h-full w-full relative" style={{ backgroundImage: 'radial-gradient(circle, var(--c4-grid-dot) 1px, transparent 1px)', backgroundSize: '16px 16px' }}>
      <svg className="absolute inset-0 w-full h-full" aria-hidden="true">
        {scene.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + from.w / 2;
          const y1 = from.y + from.h / 2;
          const x2 = to.x + to.w / 2;
          const y2 = to.y + to.h / 2;
          return (
            <g key={edge.id}>
              <line x1={`${x1}%`} y1={`${y1}%`} x2={`${x2}%`} y2={`${y2}%`} stroke="var(--c4-relationship)" strokeWidth="1.5" />
              <text x={`${(x1 + x2) / 2}%`} y={`${(y1 + y2) / 2}%`} fill="var(--semi-color-text-2)" fontSize="12" textAnchor="middle">
                {edge.label}
              </text>
            </g>
          );
        })}
      </svg>
      {scene.nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          onClick={() => onSelect(node.id)}
          className="absolute text-left"
          style={{
            left: `${node.x}%`,
            top: `${node.y}%`,
            width: `${node.w}%`,
            height: `${node.h}%`,
            borderRadius: 8,
            border: node.id === selectedId ? '2px solid var(--c4-primary)' : '1px solid var(--c4-node-border)',
            background: 'var(--c4-node-bg)',
            color: 'var(--c4-node-text)',
            padding: '8px 10px',
            zIndex: node.w * node.h > 800 ? 1 : 2,
          }}
        >
          <strong className="block truncate text-sm">{node.name}</strong>
          <span className="block text-xs text-color-3">{node.kind}</span>
        </button>
      ))}
    </div>
  );
}
