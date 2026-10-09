import { formatDate, formatNumber, t, tp } from './index';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `1,5 KB` (es) o `1.5 KB` (en), `256 MB`: de 1024 en 1024 y sin decimales de más (como el servicio en `--max-bytes`). */
export function formatBytes(bytes: number): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${formatNumber(rounded, { maximumFractionDigits: 1 })} ${UNITS[unit]}`;
}

/**
 * Hace cuánto fue algo, en una frase corta («hace un momento», «hace 5 min», «hace 3 h»), y la fecha completa aparte (para el `title`). Pasado un día se escribe
 * la fecha; con `days`, hasta los 30 días se cuentan en días. `undefined` si no es una fecha.
 */
export function formatAgo(iso: string, options: { days?: boolean } = {}): { text: string; full: string } | undefined {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  const full = formatDate(time, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  if (seconds < 60) return { text: t('time.now'), full };
  if (seconds < 3600) return { text: t('time.minutes', { count: Math.round(seconds / 60) }), full };
  if (seconds < 86400) return { text: t('time.hours', { count: Math.round(seconds / 3600) }), full };
  if (options.days && seconds < 30 * 86400) return { text: tp('time.days', Math.round(seconds / 86400)), full };
  return { text: formatDate(time, { year: 'numeric', month: 'numeric', day: 'numeric' }), full };
}
