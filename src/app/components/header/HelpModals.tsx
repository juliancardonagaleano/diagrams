import { Modal } from '@douyinfe/semi-ui';
import { useT } from '../../../i18n/react';
import { t } from '../../../i18n';

const SHORTCUTS: Array<[() => string, () => string]> = [
  [() => 'Ctrl/⌘ + Z', () => t('ed.sc.undo')],
  [() => 'Ctrl/⌘ + Y · Ctrl/⌘ + Shift + Z', () => t('ed.sc.redo')],
  [() => 'Ctrl/⌘ + S', () => t('ed.sc.save')],
  [() => 'Ctrl/⌘ + E', () => t('ed.sc.export')],
  [() => 'Ctrl/⌘ + O', () => t('ed.sc.open')],
  [() => 'Ctrl/⌘ + L', () => t('ed.sc.layout')],
  [() => t('ed.key.delete'), () => t('ed.sc.remove')],
  [() => t('ed.key.walk'), () => t('ed.sc.walk')],
  [() => t('ed.key.shiftArrows'), () => t('ed.sc.nudge')],
  [() => t('ed.key.enter'), () => t('ed.sc.select')],
  [() => t('ed.key.dblclick'), () => t('ed.sc.drill')],
  [() => 'Alt + ↓ / Alt + ↑', () => t('ed.sc.level')],
  [() => t('ed.key.wheel'), () => t('ed.sc.zoom')],
  [() => t('ed.key.wheelScroll'), () => t('ed.sc.scroll')],
  [() => t('ed.key.middle'), () => t('ed.sc.pan')],
  [() => t('ed.key.dragHandle'), () => t('ed.sc.connect')],
];

export function ShortcutsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useT();
  return (
    <Modal title={t('ed.h.shortcuts')} visible={visible} onCancel={onClose} footer={null} size="small">
      <table className="w-full text-sm">
        <tbody>
          {SHORTCUTS.map(([key, text], index) => (
            <tr key={index} className="border-b border-color">
              <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap">{key()}</td>
              <td className="py-1.5 text-color-2">{text()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function AboutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { tr } = useT();
  return (
    <Modal title="IArk - DIAgrams" visible={visible} onCancel={onClose} footer={null} size="small">
      <div className="space-y-2 text-sm">
        <p>{tr('ed.about.p1')}</p>
        <ul className="list-disc pl-5 text-color-2">
          <li>{tr('ed.about.l1')}</li>
          <li>{tr('ed.about.l2')}</li>
          <li>{tr('ed.about.l3')}</li>
        </ul>
      </div>
    </Modal>
  );
}
