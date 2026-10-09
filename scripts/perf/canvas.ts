import { readFileSync, readdirSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import { generateDocument, type PerfModuleId } from '../../tests/perf/generators';

/**
 * Medición del lienzo en un Chromium real (`npm run perf canvas`): abre el banco de trabajo (`modulos.html`) o el editor C4
 * (`index.html`) con un documento grande ya guardado como borrador y anota, por caso:
 *  - `firstNodeMs`: desde que empieza la navegación hasta que React Flow dibuja el primer nodo (primer render);
 *  - `readyMs`: hasta que el lienzo está asentado (`data-layout="ready"`: autolayout aplicado y cámara encuadrada);
 *  - `layoutMs`: lo que duró el autolayout visto desde la página (marca de User Timing `iark:autolayout`);
 *  - `maxBlockMs`: la tarea más larga del hilo principal y `blockedMs` la suma de lo que pasó de 50 ms (API Long Tasks);
 *  - `maxTickGapMs`: el mayor hueco entre dos pulsos de un temporizador de 50 ms (mide lo mismo sin depender de la API);
 *  - `domNodes` y `domElements`: nodos de React Flow montados y elementos del DOM al terminar;
 *  - `heapMB`: memoria de JavaScript de la página tras forzar la recolección de basura, y `rssMB` la residente de todos los
 *    procesos del navegador (incluye el hilo de trabajo del autolayout).
 */

export interface CanvasCase {
  module: PerfModuleId;
  size: number;
  /** `thread` abre la página con `?elk=thread`: el cálculo corre en el hilo principal, como antes del hilo de trabajo (misma compilación, para comparar). */
  elk?: 'thread';
  /** C4 se puede abrir en el editor clásico (`index.html`, por omisión) o en el lienzo común del banco de trabajo (`modulos.html?module=c4`). */
  c4?: 'editor' | 'bench';
}

export interface CanvasResult extends CanvasCase {
  nodes: number;
  edges: number;
  ready: boolean;
  firstNodeMs?: number;
  readyMs?: number;
  layoutMs?: number;
  maxBlockMs: number;
  blockedMs: number;
  maxTickGapMs: number;
  domNodes: number;
  domElements: number;
  heapMB: number;
  rssMB?: number;
  /** Texto del estado de cálculo si el lienzo lo mostraba mientras calculaba (a partir de la mejora). */
  busyShown?: boolean;
}

/** Instrumentación que se instala en la página antes de que cargue ningún script suyo. */
function installProbes(): void {
  const w = window as unknown as { __perf: Record<string, unknown> };
  const perf: { longTasks: number[]; maxTickGap: number; firstNode?: number; ready?: number; busy?: boolean } = { longTasks: [], maxTickGap: 0 };
  w.__perf = perf as unknown as Record<string, unknown>;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* sin Long Tasks API: queda el pulso del temporizador */
  }
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    perf.maxTickGap = Math.max(perf.maxTickGap, now - last);
    last = now;
  }, 50);
  const look = (): void => {
    if (perf.firstNode === undefined && document.querySelector('.react-flow__node')) perf.firstNode = performance.now();
    if (document.querySelector('[data-testid="calculating"], [data-testid="canvas-busy"]')) perf.busy = true;
    const canvas = document.querySelector('[data-testid="module-canvas"], [data-testid="c4-canvas"]');
    // Asentado = autolayout aplicado y cámara encuadrada. Con el recorte de nodos fuera de pantalla el encuadre puede caer en una zona
    // vacía (zoom mínimo en diagramas enormes): no se exige ningún nodo montado.
    if (perf.ready === undefined && canvas?.getAttribute('data-layout') === 'ready') perf.ready = performance.now();
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-layout'] });
}

/** Memoria residente (MB) de los procesos del navegador: los descendientes de este proceso cuya línea de órdenes nombra a Chromium (Linux). */
function browserRssMB(): number | undefined {
  if (process.platform !== 'linux') return undefined;
  const status = new Map<number, { ppid: number; rssKb: number; chromium: boolean }>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const text = readFileSync(`/proc/${entry}/status`, 'utf8');
      const ppid = Number(/PPid:\s+(\d+)/.exec(text)?.[1] ?? 0);
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(text)?.[1] ?? 0);
      const chromium = /chrom/i.test(readFileSync(`/proc/${entry}/cmdline`, 'utf8'));
      status.set(Number(entry), { ppid, rssKb, chromium });
    } catch {
      /* el proceso terminó mientras se leía */
    }
  }
  const family = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, info] of status) if (!family.has(id) && family.has(info.ppid)) (family.add(id), (grew = true));
  }
  return [...family].reduce((sum, id) => sum + (status.get(id)?.chromium ? (status.get(id)?.rssKb ?? 0) : 0), 0) / 1024;
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.CHROMIUM_PATH ?? (process.env.CI ? undefined : '/opt/pw-browsers/chromium');
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--enable-precise-memory-info'] });
}

export async function measureCanvas(browser: Browser, baseUrl: string, spec: CanvasCase, readyTimeoutMs: number): Promise<CanvasResult> {
  const generated = generateDocument(spec.module, spec.size);
  const c4 = spec.module === 'c4';
  const c4Classic = c4 && spec.c4 !== 'bench';
  const text = JSON.stringify(generated.document);
  const c4Doc = c4 ? (generated.document as { model: { relationships: unknown[] }; views: Array<{ elements: unknown[] }> }) : undefined;
  const c4Counts = c4Doc ? { nodes: c4Doc.views[0].elements.length, edges: c4Doc.model.relationships.length } : undefined;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const stored = c4Classic
      ? { key: 'iark-diagrams', value: JSON.stringify({ state: { doc: generated.document, activeViewId: generated.viewId, lastSavedAt: 1 }, version: 0 }) }
      : { key: `iark.workbench.${spec.module}`, value: text };
    await context.addInitScript(
      ({ key, value }) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          /* sin almacenamiento: la prueba fallará en la lectura */
        }
      },
      stored,
    );
    // tsx compila con `keepNames` y envuelve las funciones con un ayudante `__name` que no existe en la página: se le da uno vacío.
    await context.addInitScript('window.__name = window.__name || ((target) => target);');
    await context.addInitScript(installProbes);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const forced = spec.elk === 'thread' ? 'elk=thread' : '';
    await page.goto(c4Classic ? `${baseUrl}/${forced ? `?${forced}` : ''}` : `${baseUrl}/modulos.html?module=${spec.module}${forced ? `&${forced}` : ''}`, { waitUntil: 'commit' });
    const ready = await page
      .waitForFunction(() => (window as unknown as { __perf?: { ready?: number } }).__perf?.ready !== undefined, undefined, { timeout: readyTimeoutMs, polling: 250 })
      .then(
        () => true,
        () => false,
      );
    const probe = await page.evaluate(() => {
      const perf = (window as unknown as { __perf: { longTasks: number[]; maxTickGap: number; firstNode?: number; ready?: number; busy?: boolean } }).__perf;
      const layout = performance.getEntriesByName('iark:autolayout').map((e) => e.duration);
      const meta = layout.length > 0 ? (performance.getEntriesByName('iark:autolayout').at(-1) as PerformanceMeasure).detail : undefined;
      return {
        firstNode: perf.firstNode,
        ready: perf.ready,
        busy: perf.busy,
        layout: layout.length > 0 ? layout.reduce((a, b) => a + b, 0) : undefined,
        longTasks: perf.longTasks,
        maxTickGap: perf.maxTickGap,
        domNodes: document.querySelectorAll('.react-flow__node').length,
        domElements: document.getElementsByTagName('*').length,
        graph: meta as { nodes?: number; edges?: number } | undefined,
      };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
    const heap = metrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
    if (errors.length > 0) process.stderr.write(`  [${spec.module} ${spec.size}] errores de la página: ${errors.slice(0, 2).join(' | ')}\n`);
    return {
      ...spec,
      nodes: probe.graph?.nodes ?? c4Counts?.nodes ?? 0,
      edges: probe.graph?.edges ?? c4Counts?.edges ?? 0,
      ready,
      firstNodeMs: probe.firstNode,
      readyMs: probe.ready,
      layoutMs: probe.layout,
      maxBlockMs: probe.longTasks.length > 0 ? Math.max(...probe.longTasks) : 0,
      blockedMs: probe.longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0),
      maxTickGapMs: probe.maxTickGap,
      domNodes: probe.domNodes,
      domElements: probe.domElements,
      heapMB: heap / 1024 / 1024,
      rssMB: browserRssMB(),
      busyShown: probe.busy,
    };
  } finally {
    await context.close();
  }
}
