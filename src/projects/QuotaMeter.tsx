import { useEffect, useMemo, useState } from 'react';
import type { AccountUsage, ProjectSummary } from '@iark/kernel';
import { isUnlimited, percentOf, quotaLines, quotaWarning, type QuotaLine } from './quota';
import type { ProjectSession } from './session';

export interface QuotaMeterProps {
  session: ProjectSession;
  /** La lista de proyectos que se está mostrando: cuando cambia (se guardó, se creó o se borró algo) se vuelve a preguntar cuánto se usa. */
  projects: ProjectSummary[];
  /** El proyecto elegido: si lo posee quien mira, se muestran también sus diagramas frente al tope por proyecto. */
  selected?: ProjectSummary;
  /** Cuánto se espera tras un cambio antes de volver a preguntar (las pruebas lo ponen a 0). */
  delayMs?: number;
}

/**
 * Cuánto de su cuota usa la persona, en la cabecera del gestor de proyectos: el espacio, los proyectos y los diagramas del proyecto elegido, con un
 * aviso (`role="status"`) cuando alguno está a punto de llegar al tope (desde el 80 %) o ya llegó. Los números los mide el servidor
 * (`GET /api/usage`); aquí solo se ven.
 *
 * No aparece (no pinta nada) si no hay nada que enseñar: este navegador, un servidor sin cuentas o con un token (no hay cuota por persona), un
 * servidor anterior a las cuotas, o una cuota sin ningún tope. Si el servidor no responde se queda con lo último que supo y no molesta: el
 * error que importa (guardar, crear) ya lo dice el gestor al intentarlo.
 */
export function QuotaMeter({ session, projects, selected, delayMs = 400 }: QuotaMeterProps) {
  const applicable = session.remote && session.credential === 'session';
  const [usage, setUsage] = useState<AccountUsage | undefined>();
  // Cambia cuando cambia algo que pesa: qué proyectos hay, cuándo se tocaron y qué diagramas tienen.
  const stamp = useMemo(() => projects.map((p) => `${p.id}@${p.updatedAt}:${p.diagrams.map((d) => `${d.id}@${d.updatedAt}`).join(',')}`).join('|'), [projects]);

  useEffect(() => {
    if (!applicable) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      session.usage().then(
        (found) => {
          if (alive) setUsage(found);
        },
        () => undefined,
      );
    }, delayMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [applicable, session, stamp, delayMs]);

  if (!applicable || !usage || isUnlimited(usage.limits)) return null;

  // El tope de diagramas se cobra al proyecto, y el proyecto a quien lo posee: solo se muestra el de un proyecto que posee quien mira.
  const owned = selected ? usage.projects.some((p) => p.id === selected.id) : false;
  const lines = quotaLines(usage, selected && owned ? { id: selected.id, name: selected.name, diagrams: selected.diagrams.length } : undefined).filter((l) => l.limit > 0);
  const warning = quotaWarning(lines);

  return (
    <section className="pj-quota" aria-label="Tu cuota de uso" data-testid="quota-meter" data-level={warning?.level ?? 'ok'}>
      <ul className="pj-quota-lines">
        {lines.map((l) => (
          <Meter key={l.kind} line={l} />
        ))}
      </ul>
      {warning && (
        <p className={warning.level === 'full' ? 'pj-error' : 'pj-warn'} role="status" data-testid="quota-warning" data-level={warning.level}>
          {warning.text}
        </p>
      )}
    </section>
  );
}

function Meter({ line }: { line: QuotaLine }) {
  const percent = percentOf(line.used, line.limit);
  return (
    <li className="pj-quota-line" data-kind={line.kind} data-level={line.level}>
      <span className="pj-quota-label">{line.label}</span>
      {percent !== undefined && <progress className="pj-quota-bar" value={percent} max={100} aria-label={`${line.label}: ${percent} % del tope`} />}
      <span className="pj-quota-text">{line.text}</span>
    </li>
  );
}
