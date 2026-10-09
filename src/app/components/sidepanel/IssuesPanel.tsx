import { accionable } from '../../../modules-app/a11y/accionable';
import { IconAlertCircle, IconAlertTriangle, IconChevronDown } from '@douyinfe/semi-icons';
import { useMemo, useState } from 'react';
import { analyzeDocument } from '@core/model/issues';
import { useDocumentStore } from '../../store/documentStore';

export function IssuesPanel() {
  const doc = useDocumentStore((s) => s.doc);
  const select = useDocumentStore((s) => s.select);
  const setUi = useDocumentStore((s) => s.setUi);
  const [collapsed, setCollapsed] = useState(false);
  const issues = useMemo(() => analyzeDocument(doc), [doc]);
  const errors = issues.filter((i) => i.severity === 'error').length;
  return (
    <div className="mt-auto border-t-2 border-color shadow-inner sidesheet-theme">
      <div className="flex items-center justify-between px-3 py-1.5 cursor-pointer select-none hover-1" {...accionable(() => setCollapsed(!collapsed), { expandido: !collapsed })}>
        <div className="flex items-center gap-2 text-sm font-medium">
          Problemas
          <span className={`text-xs rounded-full px-1.5 ${errors ? 'bg-red-500 text-white' : issues.length ? 'bg-amber-400 text-black' : 'bg-green-500 text-white'}`}>{issues.length}</span>
        </div>
        <IconChevronDown size="small" className={collapsed ? '-rotate-90 transition' : 'transition'} />
      </div>
      {!collapsed && (
        <div className="max-h-40 overflow-y-auto px-3 pb-2 text-xs space-y-1">
          {issues.length === 0 && <div className="text-color-3">Sin problemas detectados.</div>}
          {issues.map((i, idx) => (
            <div
              key={idx}
              className="flex items-start gap-1.5 cursor-pointer hover-1 rounded px-1 py-0.5"
              {...accionable(() => {
                if (i.elementId) {
                  select({ kind: 'element', id: i.elementId });
                  setUi({ panelTab: 'elements' });
                } else if (i.relationshipId) {
                  select({ kind: 'relationship', id: i.relationshipId });
                  setUi({ panelTab: 'relationships' });
                } else if (i.viewId) setUi({ panelTab: 'views' });
              })}
            >
              {i.severity === 'error' ? <IconAlertCircle size="small" className="text-red-500 mt-0.5" aria-label="Error" /> : <IconAlertTriangle size="small" className="text-amber-500 mt-0.5" aria-label="Aviso" />}
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
