/**
 * Medición de rendimiento con diagramas grandes (`npm run perf`). NO forma parte de `npm test` ni del CI: los tiempos de reloj
 * dependen de la máquina, así que se miden a mano y se anotan en docs/rendimiento.md. Lo que sí se fija en las pruebas es
 * estructural (nodos montados, el cálculo en el hilo de trabajo, el tamaño de los trozos).
 *
 *   npm run perf                       # layout + canvas + chunks con los tamaños por omisión
 *   npm run perf -- layout             # solo el autolayout en Node (ELK): un proceso por caso, con tope de tiempo
 *   npm run perf -- canvas             # solo el lienzo en un Chromium real (necesita npm run build:app)
 *   npm run perf -- chunks             # solo el tamaño de los trozos de dist/app (necesita npm run build:app)
 *
 * Opciones: --modules a,b  --sizes 100,500  --runs 3 (repeticiones por caso)  --timeout 180 (segundos por caso)
 *           --modes smart,fast (modos de layout: C4 smart/fast/interactive; el resto default —el esfuerzo que elige el lienzo según el tamaño— y, si se piden, normal/fast; por omisión: smart, fast, interactive y default)  --port 4185  --json salida.json  --elk thread (lienzo: ELK en el hilo principal)  --c4 bench (lienzo: C4 en el banco de trabajo)
 *
 * Mide de uno en uno y en serie. Cierra otros procesos pesados antes de medir y repite: anota la dispersión, no un solo número.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERF_MODULES, PERF_SIZES, type PerfModuleId } from '../tests/perf/generators';
import { launchBrowser, measureCanvas, type CanvasResult } from './perf/canvas';
import { analyzeBuild, kB } from './perf/chunks';
import type { LayoutCaseResult } from './perf/layoutCase';

type Command = 'layout' | 'canvas' | 'chunks' | 'all';

interface Options {
  command: Command;
  modules: PerfModuleId[];
  sizes: number[];
  runs: number;
  timeoutS: number;
  modes?: string[];
  port: number;
  json?: string;
  /** `--elk thread`: en el lienzo, ELK en el hilo principal (`?elk=thread`), para comparar con el hilo de trabajo con la misma compilación. */
  elk?: 'thread';
  /** `--c4 bench`: C4 en el lienzo común del banco de trabajo en vez de en el editor clásico. */
  c4?: 'bench';
}

function parseArgs(argv: string[]): Options {
  const [first, ...rest] = argv[0] && !argv[0].startsWith('--') ? argv : ['all', ...argv];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) flags.set(rest[i].replace(/^--/, ''), rest[i + 1] ?? '');
  const command = (['layout', 'canvas', 'chunks', 'all'] as const).find((c) => c === first);
  if (!command) throw new Error(`Orden desconocida «${first}»: usa layout, canvas, chunks o all.`);
  const modules = (flags.get('modules')?.split(',') ?? [...PERF_MODULES]) as PerfModuleId[];
  for (const m of modules) if (!PERF_MODULES.includes(m)) throw new Error(`Módulo desconocido «${m}» (${PERF_MODULES.join(', ')}).`);
  return {
    command,
    modules,
    sizes: flags.get('sizes')?.split(',').map(Number) ?? [...PERF_SIZES],
    runs: Number(flags.get('runs') ?? 3),
    timeoutS: Number(flags.get('timeout') ?? 180),
    modes: flags.get('modes')?.split(','),
    port: Number(flags.get('port') ?? process.env.E2E_PORT ?? 4185),
    json: flags.get('json'),
    elk: flags.get('elk') === 'thread' ? 'thread' : undefined,
    c4: flags.get('c4') === 'bench' ? 'bench' : undefined,
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const ms = (value: number | undefined): string => (value === undefined ? '-' : value >= 10000 ? `${(value / 1000).toFixed(1)} s` : `${value.toFixed(0)} ms`);
const spread = (values: number[]): string => (values.length < 2 ? ms(values[0]) : `${ms(median(values))} (${ms(Math.min(...values))}–${ms(Math.max(...values))})`);

function describeMachine(): string {
  const cpu = cpus();
  return `${cpu[0]?.model ?? 'CPU desconocida'}, ${cpu.length} núcleos, ${(totalmem() / 1024 ** 3).toFixed(1)} GB de RAM, Node ${process.version}, ${process.platform}`;
}

const tsxBin = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const layoutCaseFile = fileURLToPath(new URL('./perf/layoutCase.ts', import.meta.url));

/** Un caso de layout en un proceso aparte, que se mata si pasa del tope. */
function runLayoutCase(module: PerfModuleId, size: number, runs: number, mode: string, timeoutS: number): Promise<LayoutCaseResult | { timeout: true }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxBin, layoutCaseFile, module, String(size), String(runs), mode], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => {
      // tsx lanza otro proceso de Node para ejecutar el caso: se mata el grupo entero, no solo el padre (si no, el hijo queda calculando).
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      resolve({ timeout: true });
    }, timeoutS * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return;
      if (code !== 0) return reject(new Error(`El caso ${module}/${size} falló (${code}): ${err.trim().split('\n').slice(0, 4).join(' | ')}`));
      resolve(JSON.parse(out.trim().split('\n').at(-1)!) as LayoutCaseResult);
    });
  });
}

const MODES: Record<PerfModuleId, string[]> = { c4: ['smart', 'fast', 'interactive'], integration: ['default', 'normal', 'fast'], data: ['default', 'normal', 'fast'], enterprise: ['default'], platform: ['default', 'normal', 'fast'], security: ['default', 'normal', 'fast'] };

/** Los modos que se miden si no se pide otra cosa: C4 con sus tres estrategias y el resto con el esfuerzo que elige el lienzo. */
const DEFAULT_MODES: Record<PerfModuleId, string[]> = { c4: ['smart', 'fast', 'interactive'], integration: ['default'], data: ['default'], enterprise: ['default'], platform: ['default'], security: ['default'] };

async function layoutReport(options: Options): Promise<unknown[]> {
  console.log(`\n## Autolayout (ELK en Node, ${options.runs} repeticiones por caso; entre paréntesis, mínimo–máximo)\n`);
  console.log('| Módulo | Modo | Tamaño | Nodos | Aristas | Validar | Proyectar | Layout (ELK) | Construir flujo | Extensión del dibujo |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  const all: unknown[] = [];
  for (const module of options.modules) {
    for (const mode of (options.modes ?? DEFAULT_MODES[module]).filter((m) => MODES[module].includes(m))) {
      let timedOut = false;
      for (const size of options.sizes) {
        if (timedOut) {
          console.log(`| ${module} | ${mode} | ${size} | - | - | - | - | omitido: el tamaño anterior ya pasó del tope | - | - |`);
          continue;
        }
        const result = await runLayoutCase(module, size, options.runs, mode, options.timeoutS);
        if ('timeout' in result) {
          timedOut = true;
          console.log(`| ${module} | ${mode} | ${size} | - | - | - | - | **más de ${options.timeoutS} s (cortado)** | - | - |`);
          all.push({ module, mode, size, timeout: options.timeoutS });
          continue;
        }
        const col = (key: 'parse' | 'project' | 'layout' | 'build'): string => {
          const values = result.runs.flatMap((r) => (r[key] === undefined ? [] : [r[key] as number]));
          return values.length === 0 ? '-' : spread(values);
        };
        console.log(`| ${module} | ${mode} | ${size} | ${result.nodes} | ${result.edges} | ${col('parse')} | ${col('project')} | ${col('layout')} | ${col('build')} | ${result.extent ? `${Math.round(result.extent.width)} × ${Math.round(result.extent.height)} px` : '-'} |`);
        all.push(result);
      }
    }
  }
  return all;
}

async function startPreview(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) return child;
    } catch {
      /* el servidor aún no escucha */
    }
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill();
      throw new Error(`vite preview no arrancó en el puerto ${port} (¿hay algo escuchando ya? ¿falta npm run build:app?)`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function canvasReport(options: Options): Promise<unknown[]> {
  console.log(`\n## Lienzo en Chromium${options.c4 ? ' (C4 en el banco de trabajo)' : ''}${options.elk ? ' con ELK en el hilo principal (?elk=thread)' : ''} (${options.runs} repeticiones por caso; mediana y mínimo–máximo)\n`);
  console.log('| Módulo | Nodos | Aristas | Primer nodo | Asentado | Layout (página) | Tarea más larga | Bloqueado (>50 ms) | Mayor hueco del pulso | Nodos en el DOM | Montón JS | RSS del navegador | Estado «calculando» |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  const server = await startPreview(options.port);
  const browser = await launchBrowser();
  const all: unknown[] = [];
  try {
    console.error(`Chromium ${browser.version()}`);
    for (const module of options.modules) {
      let timedOut = false;
      for (const size of options.sizes) {
        if (timedOut) {
          console.log(`| ${module} | ${size} | - | omitido: el tamaño anterior ya pasó del tope | | | | | | | | | |`);
          continue;
        }
        const results: CanvasResult[] = [];
        for (let i = 0; i < options.runs; i++) {
          results.push(await measureCanvas(browser, `http://localhost:${options.port}`, { module, size, elk: options.elk, c4: options.c4 }, options.timeoutS * 1000));
          if (!results[i].ready) break;
        }
        all.push(...results);
        const last = results[results.length - 1];
        if (!last.ready) {
          timedOut = true;
          console.log(`| ${module} | ${size} | ${last.edges} | **no asentado en ${options.timeoutS} s** | | | ${ms(last.maxBlockMs)} | ${ms(last.blockedMs)} | ${ms(last.maxTickGapMs)} | ${last.domNodes} | ${last.heapMB.toFixed(0)} MB | ${last.rssMB?.toFixed(0) ?? '-'} MB | |`);
          continue;
        }
        const pick = (f: (r: CanvasResult) => number | undefined): number[] => results.flatMap((r) => (f(r) === undefined ? [] : [f(r) as number]));
        const mb = (values: number[]): string => (values.length === 0 ? '-' : `${median(values).toFixed(0)} MB`);
        console.log(
          `| ${module} | ${last.nodes} | ${last.edges} | ${spread(pick((r) => r.firstNodeMs))} | ${spread(pick((r) => r.readyMs))} | ${spread(pick((r) => r.layoutMs))} | ${spread(pick((r) => r.maxBlockMs))} | ${spread(pick((r) => r.blockedMs))} | ${spread(pick((r) => r.maxTickGapMs))} | ${last.domNodes} / ${last.domElements} elem. | ${mb(pick((r) => r.heapMB))} | ${mb(pick((r) => r.rssMB))} | ${last.busyShown ? 'sí' : 'no'} |`,
        );
      }
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  return all;
}

function chunksReport(): unknown {
  const analysis = analyzeBuild('dist/app');
  console.log('\n## Trozos de la compilación (dist/app; 1 kB = 1000 bytes; gzip nivel 9)\n');
  console.log('| Trozo | Tamaño | gzip | En la carga inicial de |');
  console.log('|---|---:|---:|---|');
  for (const chunk of analysis.chunks.slice(0, 20)) console.log(`| \`${chunk.name}\` | ${kB(chunk.bytes)} | ${kB(chunk.gzipBytes)} | ${chunk.initialFor.join(', ') || 'bajo demanda'} |`);
  const over = analysis.chunks.filter((c) => c.bytes > 500_000);
  console.log(`\nTrozos de más de 500 kB: ${over.length} (${over.map((c) => c.name).join(', ') || 'ninguno'}). Total de JS: ${kB(analysis.chunks.reduce((s, c) => s + c.bytes, 0))} en ${analysis.chunks.length} archivos.\n`);
  console.log('| Página | Carga inicial (JS) | gzip | Trozos |');
  console.log('|---|---:|---:|---:|');
  for (const page of analysis.pages) console.log(`| ${page.html} | ${kB(page.bytes)} | ${kB(page.gzipBytes)} | ${page.files.length} |`);
  return analysis;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  console.log(`# Medición de rendimiento\n\nFecha: ${now.toISOString().slice(0, 10)}. Máquina: ${describeMachine()}.`);
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  if (git.status === 0) console.log(`Commit: ${git.stdout.trim()}.`);
  const report: Record<string, unknown> = { date: now.toISOString(), machine: describeMachine() };
  if (options.command === 'layout' || options.command === 'all') report.layout = await layoutReport(options);
  if (options.command === 'canvas' || options.command === 'all') report.canvas = await canvasReport(options);
  if (options.command === 'chunks' || options.command === 'all') report.chunks = chunksReport();
  if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
