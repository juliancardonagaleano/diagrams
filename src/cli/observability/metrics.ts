import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Métricas de `iark serve` en el formato de texto de Prometheus (versión 0.0.4), escritas a mano: sin librerías. Solo existen si se arranca con
 * `--metrics` (ver `metricsEndpoint.ts`).
 *
 * **Privacidad y cardinalidad.** Ninguna etiqueta lleva una persona, un proyecto, un diagrama, un token ni una dirección IP: las etiquetas salen
 * de conjuntos cerrados (el método HTTP normalizado, la plantilla de la ruta de `route.ts`, la clase de estado, la acción de auditoría, el
 * motivo de un fallo de autenticación). Aun así, cada familia limita sus series (`MAX_SERIES`): si algún día se colara una etiqueta de valores
 * ilimitados, las series nuevas se agrupan en `other` en vez de crecer sin fin.
 */

export type Labels = Record<string, string>;
export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Lo que devuelve un colector en cada lectura: una familia con sus muestras. */
export interface MetricFamily {
  name: string;
  help: string;
  type: Exclude<MetricType, 'histogram'>;
  samples: Array<{ labels?: Labels; value: number }>;
}

const MAX_SERIES = 500;

const escapeLabelValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escapeHelp = (help: string): string => help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

function renderLabels(labels: Labels | undefined, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all);
  if (keys.length === 0) return '';
  return `{${keys.map((key) => `${key}="${escapeLabelValue(all[key])}"`).join(',')}}`;
}

export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

abstract class Family<T> {
  protected readonly series = new Map<string, { labels: Labels; state: T }>();

  constructor(
    readonly name: string,
    readonly help: string,
    protected readonly labelNames: readonly string[],
  ) {}

  /** La serie de estas etiquetas (se crea la primera vez); pasado el tope, la serie común `other`. */
  protected seriesFor(labels: Labels, create: () => T): T {
    const key = this.labelNames.map((name) => labels[name] ?? '').join('\u0000');
    let found = this.series.get(key);
    if (!found && this.series.size >= MAX_SERIES) {
      const other = Object.fromEntries(this.labelNames.map((name) => [name, 'other']));
      const otherKey = this.labelNames.map(() => 'other').join('\u0000');
      found = this.series.get(otherKey) ?? { labels: other, state: create() };
      this.series.set(otherKey, found);
      return found.state;
    }
    if (!found) {
      found = { labels: Object.fromEntries(this.labelNames.map((name) => [name, labels[name] ?? ''])), state: create() };
      this.series.set(key, found);
    }
    return found.state;
  }

  abstract render(): string[];
}

export class Counter extends Family<{ value: number }> {
  inc(labels: Labels = {}, by = 1): void {
    this.seriesFor(labels, () => ({ value: 0 })).value += by;
  }

  /** El valor de una serie (para las pruebas). */
  get(labels: Labels = {}): number {
    const key = this.labelNames.map((name) => labels[name] ?? '').join('\u0000');
    return this.series.get(key)?.state.value ?? 0;
  }

  render(): string[] {
    if (this.series.size === 0 && this.labelNames.length > 0) return [];
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} counter`];
    if (this.series.size === 0) lines.push(`${this.name} 0`);
    for (const { labels, state } of this.series.values()) lines.push(`${this.name}${renderLabels(labels)} ${formatValue(state.value)}`);
    return lines;
  }
}

interface HistogramState {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Family<HistogramState> {
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    private readonly buckets: readonly number[],
  ) {
    super(name, help, labelNames);
  }

  observe(labels: Labels, value: number): void {
    const state = this.seriesFor(labels, () => ({ counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    state.sum += value;
    state.count += 1;
    this.buckets.forEach((upper, index) => {
      if (value <= upper) state.counts[index] += 1;
    });
  }

  render(): string[] {
    if (this.series.size === 0) return [];
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (const { labels, state } of this.series.values()) {
      this.buckets.forEach((upper, index) => lines.push(`${this.name}_bucket${renderLabels(labels, { le: formatValue(upper) })} ${state.counts[index]}`));
      lines.push(`${this.name}_bucket${renderLabels(labels, { le: '+Inf' })} ${state.count}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${formatValue(state.sum)}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${state.count}`);
    }
    return lines;
  }
}

function renderFamily(family: MetricFamily): string[] {
  const lines = [`# HELP ${family.name} ${escapeHelp(family.help)}`, `# TYPE ${family.name} ${family.type}`];
  for (const sample of family.samples) lines.push(`${family.name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
  return lines;
}

/** Segundos de cada cubo del histograma de duración: de 5 ms a 1 min (el cálculo tiene 30 s de tiempo límite por omisión). */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** El método HTTP como etiqueta: los conocidos tal cual y todo lo demás `OTHER` (nadie puede crear etiquetas con métodos inventados). */
export const methodLabel = (method: string): string => (KNOWN_METHODS.has(method) ? method : 'OTHER');
/** `200` → `2xx`. */
export const statusClass = (status: number): string => `${Math.min(5, Math.max(1, Math.floor(status / 100)))}xx`;

const RESOLUTION_MS = 10;

export class Metrics {
  readonly requests = new Counter('iark_http_requests_total', 'Peticiones atendidas, por método, plantilla de ruta y clase de estado.', ['method', 'route', 'status_class']);
  readonly duration = new Histogram('iark_http_request_duration_seconds', 'Duración de las peticiones en segundos, por plantilla de ruta.', ['route'], DURATION_BUCKETS);
  readonly rateLimited = new Counter('iark_http_rate_limited_total', 'Respuestas 429 (freno de intentos fallidos o tope de inicios de sesión).', []);
  readonly authFailures = new Counter('iark_auth_failures_total', 'Autenticaciones fallidas, por motivo (missing, invalid, rate_limited, unavailable, login_failed).', ['reason']);
  readonly auditEvents = new Counter('iark_audit_events_total', 'Filas de auditoría, por acción y resultado.', ['action', 'result']);
  inFlight = 0;
  private readonly collectors: Array<() => MetricFamily[]> = [];
  private loop: IntervalHistogram | undefined;
  private readonly startedAt = Date.now() / 1000;

  constructor(private readonly version: string) {}

  /** Empieza a medir el retraso del bucle de eventos. */
  start(): void {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.loop.enable();
  }

  stop(): void {
    this.loop?.disable();
    this.loop = undefined;
  }

  /** Añade una familia que se calcula al leer (recuentos del pool, de las cuentas…). */
  addCollector(collector: () => MetricFamily[]): void {
    this.collectors.push(collector);
  }

  /** `timed` falso (un canal que se queda abierto, p. ej. los eventos en tiempo real) cuenta la petición pero no su duración: horas de conexión no son latencia. */
  observeRequest(method: string, route: string, status: number, seconds: number, timed = true): void {
    this.requests.inc({ method: methodLabel(method), route, status_class: statusClass(status) });
    if (timed) this.duration.observe({ route }, seconds);
    if (status === 429) this.rateLimited.inc();
  }

  /** El retraso del bucle de eventos desde la lectura anterior (media, percentil 99 y máximo), en segundos. */
  private loopLag(): MetricFamily[] {
    const histogram = this.loop;
    const seconds = (nanoseconds: number): number => (Number.isFinite(nanoseconds) ? Math.max(0, nanoseconds / 1e9 - RESOLUTION_MS / 1000) : 0);
    const mean = histogram ? seconds(histogram.mean) : 0;
    const p99 = histogram ? seconds(histogram.percentile(99)) : 0;
    const max = histogram ? seconds(histogram.max) : 0;
    histogram?.reset();
    return [
      { name: 'nodejs_eventloop_lag_seconds', help: 'Retraso medio del bucle de eventos desde la lectura anterior.', type: 'gauge', samples: [{ value: mean }] },
      { name: 'nodejs_eventloop_lag_p99_seconds', help: 'Percentil 99 del retraso del bucle de eventos desde la lectura anterior.', type: 'gauge', samples: [{ value: p99 }] },
      { name: 'nodejs_eventloop_lag_max_seconds', help: 'Retraso máximo del bucle de eventos desde la lectura anterior.', type: 'gauge', samples: [{ value: max }] },
    ];
  }

  private processFamilies(): MetricFamily[] {
    const cpu = process.cpuUsage();
    return [
      { name: 'iark_build_info', help: 'Versión de IArk (siempre 1).', type: 'gauge', samples: [{ labels: { version: this.version }, value: 1 }] },
      { name: 'process_start_time_seconds', help: 'Momento de arranque del proceso (segundos desde 1970).', type: 'gauge', samples: [{ value: this.startedAt }] },
      { name: 'process_uptime_seconds', help: 'Segundos que lleva en marcha el proceso.', type: 'gauge', samples: [{ value: Math.round(process.uptime() * 1000) / 1000 }] },
      { name: 'process_resident_memory_bytes', help: 'Memoria residente del proceso (RSS), en bytes.', type: 'gauge', samples: [{ value: process.memoryUsage.rss() }] },
      { name: 'process_cpu_seconds_total', help: 'Segundos de CPU del proceso (usuario y sistema).', type: 'counter', samples: [{ value: (cpu.user + cpu.system) / 1e6 }] },
      ...this.loopLag(),
    ];
  }

  /** Todas las métricas en el formato de texto de Prometheus. */
  render(): string {
    const lines: string[] = [];
    for (const family of [this.requests, this.duration, this.rateLimited, this.authFailures, this.auditEvents]) lines.push(...family.render());
    lines.push(...renderFamily({ name: 'iark_http_requests_in_flight', help: 'Peticiones en curso ahora mismo.', type: 'gauge', samples: [{ value: this.inFlight }] }));
    for (const family of this.processFamilies()) lines.push(...renderFamily(family));
    for (const collector of this.collectors) {
      for (const family of collector()) lines.push(...renderFamily(family));
    }
    return `${lines.join('\n')}\n`;
  }
}
