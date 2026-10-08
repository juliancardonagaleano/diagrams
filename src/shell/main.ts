import '../modules-app/workbench.css';
import './shell.css';
import { createIarkEmbed } from '../embed/iark-embed';
import { createIarkModuleEmbed } from '../embed/iark-module-embed';
import type { ModuleCapabilitiesInfo, ModuleEvent } from '../embed/moduleProtocol';
import { loadManifest, manifestOrigin, type ResolvedManifest, type ResolvedModule } from './manifest';

/**
 * Shell de la suite (`suite.html`): descubre los módulos de una instancia por su manifiesto `/.well-known/iark.json` y los
 * monta en un iframe con el SDK que corresponde. No conoce ningún módulo por nombre: todo sale del manifiesto y del
 * handshake `capabilities`, de modo que una instancia remota con más módulos aparece sin cambiar nada aquí.
 */
const params = new URLSearchParams(window.location.search);
const defaultManifest = new URL('.well-known/iark.json', window.location.href).toString();

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = el<HTMLFormElement>('manifest-form');
const input = el<HTMLInputElement>('manifest-url');
const nav = el<HTMLElement>('modules');
const stage = el<HTMLElement>('stage');
const info = el<HTMLElement>('info');
const log = el<HTMLElement>('log');
const state = el<HTMLElement>('state');

let embed: { destroy(): void } | undefined;
let manifest: ResolvedManifest | undefined;

const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = params.get('theme') ?? (prefersDark ? 'dark' : 'light');

function print(label: string, payload?: unknown): void {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${label}${payload === undefined ? '' : '  ' + JSON.stringify(payload).slice(0, 140)}`;
  log.prepend(line);
}

function describeModule(m: ResolvedModule, caps?: ModuleCapabilitiesInfo): void {
  info.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = `${m.name} · v${m.version}`;
  info.append(title);
  if (m.description) info.append(Object.assign(document.createElement('p'), { textContent: m.description }));
  const rows: Array<[string, string]> = [
    ['Importa', m.importFormats.join(', ') || '—'],
    ['Exporta', m.exportFormats.join(', ') || '—'],
    ['Documento', `versión ${m.documentVersion}`],
  ];
  if (caps) {
    rows.push(['Informes', caps.commands.filter((c) => c.kind === 'report').map((c) => c.name).join(', ') || '—']);
    rows.push(['Conversiones', caps.commands.filter((c) => c.kind === 'convert').map((c) => c.name).join(', ') || '—']);
    rows.push(['Vistas de traza', caps.traceViews.map((t) => t.prefix).join(', ') || '—']);
  }
  if (m.schemaUrl) rows.push(['JSON Schema', m.schemaUrl]);
  const dl = document.createElement('dl');
  for (const [k, v] of rows) {
    dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
  }
  info.append(dl);
}

function open(m: ResolvedModule): void {
  embed?.destroy();
  embed = undefined;
  stage.replaceChildren();
  for (const button of nav.querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.module === m.id));
  describeModule(m);
  if (!m.embedUrl) {
    stage.append(Object.assign(document.createElement('p'), { className: 'wb-empty', textContent: `La instancia no publica un editor embebible para «${m.name}».` }));
    return;
  }
  const common = { container: stage, url: m.embedUrl, title: m.name, ui: 'min' as const };
  try {
    mount(m, common);
  } catch (error) {
    // Los SDK rechazan lo que no sea una URL http(s) (defensa en profundidad: `loadManifest` ya lo filtra).
    stage.replaceChildren(Object.assign(document.createElement('p'), { className: 'wb-note', role: 'alert', textContent: (error as Error).message }));
    print('error', { message: (error as Error).message });
    return;
  }
  print('abre', { module: m.id, url: m.embedUrl });
}

function mount(m: ResolvedModule, common: { container: HTMLElement; url: string; title: string; ui: 'min' }): void {
  if (m.id === 'c4') {
    // El editor C4 habla su propio protocolo (`createIarkEmbed`); el resto, el de módulos.
    embed = createIarkEmbed({
      ...common,
      onInit: () => print('init', { module: m.id }),
      onLoad: ({ document }) => print('load', { module: m.id, elementos: document.model.elements.length }),
      onChange: (document) => print('change', { module: m.id, elementos: document.model.elements.length }),
      onError: (e) => print('error', e),
    });
  } else {
    embed = createIarkModuleEmbed({
      ...common,
      module: m.id,
      onEvent: (event: ModuleEvent) => {
        if (event.event === 'init') {
          const caps = event.capabilities.modules.find((c) => c.id === m.id);
          print('init', { module: m.id, disponibles: event.capabilities.available });
          describeModule(m, caps);
        } else if (event.event === 'load') print('load', { module: event.module, problemas: event.issues.length });
        else if (event.event === 'change') print('change', { module: event.module, problemas: event.issues.length });
        else if (event.event === 'viewChange') print('viewChange', { viewId: event.viewId });
        else if (event.event === 'error') print('error', { message: event.message });
      },
    });
  }
}

async function connect(typed: string): Promise<void> {
  state.textContent = 'conectando…';
  nav.replaceChildren();
  embed?.destroy(); // sin los módulos de la instancia anterior (ni el aviso de confirmación) mientras se conecta
  embed = undefined;
  stage.replaceChildren();
  let url: string;
  try {
    url = new URL(typed, window.location.href).toString(); // acepta rutas relativas a esta página
  } catch {
    state.textContent = 'sin conexión';
    nav.append(Object.assign(document.createElement('p'), { className: 'wb-note', role: 'alert', textContent: `«${typed}» no es una URL.` }));
    return;
  }
  try {
    manifest = await loadManifest(url);
  } catch (error) {
    state.textContent = 'sin conexión';
    nav.append(Object.assign(document.createElement('p'), { className: 'wb-note', role: 'alert', textContent: (error as Error).message }));
    print('error', { message: (error as Error).message });
    return;
  }
  state.textContent = `${manifest.name} v${manifest.version} · ${manifest.modules.length} módulos`;
  print('manifiesto', { url, modulos: manifest.modules.map((m) => m.id) });
  for (const m of manifest.modules) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.module = m.id;
    button.innerHTML = '<strong></strong><small></small>';
    button.querySelector('strong')!.textContent = m.name;
    button.querySelector('small')!.textContent = `${m.id} · v${m.version}`;
    button.addEventListener('click', () => open(m));
    nav.append(button);
  }
  const wanted = params.get('module');
  const first = manifest.modules.find((m) => m.id === wanted) ?? manifest.modules.find((m) => m.id !== 'c4') ?? manifest.modules[0];
  if (first) open(first);
}

/**
 * Un manifiesto de otro origen recibido por enlace (`?manifest=`) no se conecta solo: cualquiera podría mandar un enlace a
 * `suite.html` que cargara en esta página los módulos de una instancia ajena. Se deja el campo relleno y se pide confirmación
 * con el botón «Conectar» (el mismo del formulario, que también sirve para corregir la dirección antes).
 */
function awaitConfirmation(origin: string): void {
  state.textContent = 'pendiente de confirmar';
  nav.replaceChildren();
  stage.replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'wb-note',
      role: 'alert',
      textContent: `Este enlace propone conectar con otra instancia (${origin}). Sus módulos se cargarían en esta página: pulsa «Conectar» solo si la reconoces y confías en ella.`,
    }),
  );
  print('pendiente de confirmar', { origen: origin });
  form.querySelector('button')?.focus();
}

const initial = params.get('manifest') ?? defaultManifest;
input.value = initial;
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void connect(input.value.trim());
});
// El manifiesto por omisión y los del mismo origen se conectan solos; uno que no sea una URL también, para que `connect` explique el error.
const initialOrigin = manifestOrigin(initial, window.location.href);
if (initialOrigin === undefined || initialOrigin === window.location.origin) void connect(initial);
else awaitConfirmation(initialOrigin);
