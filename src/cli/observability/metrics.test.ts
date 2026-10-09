import { describe, expect, it } from 'vitest';
import { Counter, DURATION_BUCKETS, formatValue, Histogram, Metrics, methodLabel, statusClass } from './metrics';

/** Lo que Prometheus acepta por línea: comentario, o `nombre{etiquetas} valor`. */
const LINE = /^(# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .*|[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\\n]|\\.)*"(,|(?=\})))*\})? (-?\d+(\.\d+)?(e[+-]?\d+)?|NaN|\+Inf|-Inf))$/;

describe('formato de texto de Prometheus', () => {
  it('un contador con etiquetas: HELP, TYPE y una línea por serie', () => {
    const counter = new Counter('iark_prueba_total', 'Cuenta algo.', ['method', 'route']);
    counter.inc({ method: 'GET', route: '/a' });
    counter.inc({ method: 'GET', route: '/a' }, 2);
    counter.inc({ method: 'POST', route: '/b' });
    expect(counter.render()).toEqual(['# HELP iark_prueba_total Cuenta algo.', '# TYPE iark_prueba_total counter', 'iark_prueba_total{method="GET",route="/a"} 3', 'iark_prueba_total{method="POST",route="/b"} 1']);
    expect(counter.get({ method: 'GET', route: '/a' })).toBe(3);
  });

  it('un contador sin etiquetas sale con 0 aunque no se haya tocado; uno con etiquetas, solo cuando tiene series', () => {
    expect(new Counter('iark_x_total', 'x', []).render()).toEqual(['# HELP iark_x_total x', '# TYPE iark_x_total counter', 'iark_x_total 0']);
    expect(new Counter('iark_y_total', 'y', ['a']).render()).toEqual([]);
  });

  it('escapa las comillas, la barra y el salto de línea en los valores de las etiquetas, y la barra y el salto en la ayuda', () => {
    const counter = new Counter('iark_e_total', 'línea 1\nlínea 2 \\', ['v']);
    counter.inc({ v: 'a"b\\c\nd' });
    const lines = counter.render();
    expect(lines[0]).toBe('# HELP iark_e_total línea 1\\nlínea 2 \\\\');
    expect(lines[2]).toBe('iark_e_total{v="a\\"b\\\\c\\nd"} 1');
    for (const line of lines) expect(line).toMatch(LINE);
  });

  it('un histograma es acumulado: los cubos suman, +Inf es el total y sum y count cuadran', () => {
    const histogram = new Histogram('iark_h_seconds', 'h', ['route'], [0.1, 1, 10]);
    for (const value of [0.05, 0.1, 0.5, 2, 100]) histogram.observe({ route: '/a' }, value);
    const lines = histogram.render();
    expect(lines).toEqual([
      '# HELP iark_h_seconds h',
      '# TYPE iark_h_seconds histogram',
      'iark_h_seconds_bucket{route="/a",le="0.1"} 2',
      'iark_h_seconds_bucket{route="/a",le="1"} 3',
      'iark_h_seconds_bucket{route="/a",le="10"} 4',
      'iark_h_seconds_bucket{route="/a",le="+Inf"} 5',
      'iark_h_seconds_sum{route="/a"} 102.65',
      'iark_h_seconds_count{route="/a"} 5',
    ]);
  });

  it('los cubos por omisión van de 5 ms a 1 min y están ordenados', () => {
    expect([...DURATION_BUCKETS]).toEqual([...DURATION_BUCKETS].sort((a, b) => a - b));
    expect(DURATION_BUCKETS[0]).toBe(0.005);
    expect(DURATION_BUCKETS.at(-1)).toBe(60);
  });

  it('formatValue: enteros, decimales y los valores especiales', () => {
    expect([1, 0, 0.25, 1e21, NaN, Infinity, -Infinity].map(formatValue)).toEqual(['1', '0', '0.25', '1e+21', 'NaN', '+Inf', '-Inf']);
  });
});

describe('cardinalidad', () => {
  it('pasado el tope de series, las nuevas se suman a una sola serie `other` y no se pierde ninguna cuenta', () => {
    const counter = new Counter('iark_c_total', 'c', ['route']);
    for (let i = 0; i < 2000; i++) counter.inc({ route: `/r${i}` });
    const lines = counter.render().filter((l) => !l.startsWith('#'));
    expect(lines.length).toBe(501);
    expect(lines).toContain('iark_c_total{route="other"} 1500');
    expect(lines.reduce((sum, l) => sum + Number(l.split(' ').at(-1)), 0)).toBe(2000);
  });

  it('el método y la clase de estado salen de conjuntos cerrados', () => {
    expect(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PURGE', 'get', 'x"y', ''].map(methodLabel)).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER', 'OTHER', 'OTHER', 'OTHER']);
    expect([100, 200, 204, 302, 404, 429, 500, 503, 499, 0, 999].map(statusClass)).toEqual(['1xx', '2xx', '2xx', '3xx', '4xx', '4xx', '5xx', '5xx', '4xx', '1xx', '5xx']);
  });
});

describe('Metrics', () => {
  it('render: todas las líneas son del formato, cada familia declara su TYPE una vez y el texto acaba en salto de línea', () => {
    const metrics = new Metrics('1.2.3');
    metrics.start();
    try {
      metrics.observeRequest('GET', '/api/modules', 200, 0.012);
      metrics.observeRequest('POST', '/api/projects', 429, 0.001);
      metrics.authFailures.inc({ reason: 'invalid' });
      metrics.auditEvents.inc({ action: 'project.create', result: 'ok' });
      metrics.addCollector(() => [{ name: 'iark_extra', help: 'extra', type: 'gauge', samples: [{ labels: { state: 'a' }, value: 2 }, { value: 3 }] }]);
      const text = metrics.render();
      expect(text.endsWith('\n')).toBe(true);
      const lines = text.trimEnd().split('\n');
      for (const line of lines) expect(line, line).toMatch(LINE);
      const types = lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]);
      expect(new Set(types).size).toBe(types.length);
      expect(lines).toContain('iark_http_requests_total{method="GET",route="/api/modules",status_class="2xx"} 1');
      expect(lines).toContain('iark_http_rate_limited_total 1');
      expect(lines).toContain('iark_build_info{version="1.2.3"} 1');
      expect(lines).toContain('iark_extra{state="a"} 2');
      for (const name of ['process_start_time_seconds', 'process_uptime_seconds', 'process_resident_memory_bytes', 'process_cpu_seconds_total', 'nodejs_eventloop_lag_seconds', 'nodejs_eventloop_lag_p99_seconds', 'nodejs_eventloop_lag_max_seconds', 'iark_http_requests_in_flight']) {
        expect(types, name).toContain(name);
      }
    } finally {
      metrics.stop();
    }
  });

  it('el retraso del bucle de eventos se mide: un bloqueo de ~120 ms se ve en el máximo y la lectura siguiente vuelve a empezar', async () => {
    const metrics = new Metrics('x');
    metrics.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const end = Date.now() + 120;
      while (Date.now() < end); // bloquea el bucle
      await new Promise((resolve) => setTimeout(resolve, 30));
      const max = (text: string): number => Number(/^nodejs_eventloop_lag_max_seconds (\S+)$/m.exec(text)![1]);
      const first = max(metrics.render());
      expect(first).toBeGreaterThan(0.05);
      expect(first).toBeLessThan(5);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(max(metrics.render())).toBeLessThan(first);
    } finally {
      metrics.stop();
    }
  });
});
