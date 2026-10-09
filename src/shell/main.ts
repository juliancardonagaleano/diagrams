// Antes que cualquier otro import (se crean esquemas de zod al cargarlos): sin el modo JIT de zod no hay violaciones de la CSP por `new Function`.
import '@iark/kernel/jitless';
import '../modules-app/workbench.css';
import './shell.css';
import '../i18n/lang.css';
import { createIarkEmbed } from '../embed/iark-embed';
import { INCOMPATIBLE_PROTOCOL_CODE } from '@iark/kernel/protocol';
import { createIarkModuleEmbed } from '../embed/iark-module-embed';
import type { ModuleCapabilitiesInfo, ModuleEvent } from '../embed/moduleProtocol';
import { LANGS, LANG_NAMES, formatTime, getLang, initLang, setLang, subscribeLang, t, tp, type Lang } from '../i18n';
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

// El idioma de la suite se decide antes de pintar nada (`?lang=` > lo elegido > el del navegador) y se pasa a los módulos que se abren.
initLang();

/** Textos fijos de `suite.html`: el HTML trae el español de origen y esto lo pone en el idioma vigente (también al cambiarlo). */
const STATIC_TEXTS: ReadonlyArray<{ selector: string; attribute?: 'aria-label'; text: () => string }> = [
  { selector: '.wb-skip', text: () => t('wb.skip') },
  { selector: '.sh-header', attribute: 'aria-label', text: () => t('suite.header') },
  { selector: '#manifest-form', attribute: 'aria-label', text: () => t('suite.instance') },
  { selector: 'label[for="manifest-url"]', text: () => t('suite.manifest') },
  { selector: '#manifest-form button', text: () => t('suite.connect') },
  { selector: '.sh-link', text: () => t('wb.traceLink') },
  { selector: '#modules', attribute: 'aria-label', text: () => t('suite.nav') },
  { selector: '#stage', attribute: 'aria-label', text: () => t('suite.stage') },
  { selector: '#info', attribute: 'aria-label', text: () => t('suite.infoRegion') },
  { selector: '#log-title', text: () => t('suite.logTitle') },
];

function applyStatic(): void {
  for (const { selector, attribute, text } of STATIC_TEXTS) {
    const target = document.querySelector(selector);
    if (!target) continue;
    if (attribute) target.setAttribute(attribute, text());
    else target.textContent = text();
  }
}

/** El selector de idioma del encabezado: un `<select>` nativo con nombre accesible, cada idioma escrito en sí mismo. */
function mountLanguageSelect(): void {
  const select = document.createElement('select');
  select.className = 'iark-lang';
  select.setAttribute('data-testid', 'lang-select');
  for (const code of LANGS) {
    const option = Object.assign(document.createElement('option'), { value: code, textContent: LANG_NAMES[code] });
    option.lang = code;
    select.append(option);
  }
  const sync = (): void => {
    select.value = getLang();
    const label = t('lang.label');
    select.setAttribute('aria-label', label);
    select.title = label;
  };
  select.addEventListener('change', () => setLang(select.value as Lang));
  sync();
  subscribeLang(sync);
  state.before(select);
}

let embed: { destroy(): void } | undefined;
let manifest: ResolvedManifest | undefined;
/** Un enlace con un manifiesto de otro origen espera la confirmación de la persona (ver `awaitConfirmation`). */
let awaiting: string | undefined;

const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = params.get('theme') ?? (prefersDark ? 'dark' : 'light');

function print(label: string, payload?: unknown): void {
  const line = document.createElement('div');
  line.textContent = `${formatTime(new Date())}  ${label}${payload === undefined ? '' : '  ' + JSON.stringify(payload).slice(0, 140)}`;
  log.prepend(line);
}

/** El iframe (o este SDK) rechazó el apretón de manos por una versión mayor distinta del protocolo: se dice sobre el escenario, no solo en el registro. */
function reportEmbedError(e: { message: string; code?: string; issues?: unknown }): void {
  print('error', { message: e.message, ...(e.code ? { code: e.code } : {}), ...(e.issues ? { issues: e.issues } : {}) });
  if (e.code !== INCOMPATIBLE_PROTOCOL_CODE || stage.querySelector('[data-protocol-problem]')) return;
  stage.prepend(Object.assign(document.createElement('p'), { className: 'wb-note', role: 'alert', textContent: e.message }));
  stage.firstElementChild?.setAttribute('data-protocol-problem', '');
}

function describeModule(m: ResolvedModule, caps?: ModuleCapabilitiesInfo): void {
  info.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = `${m.name} · v${m.version}`;
  info.append(title);
  if (m.description) info.append(Object.assign(document.createElement('p'), { textContent: m.description }));
  const rows: Array<[string, string]> = [
    [t('suite.row.imports'), m.importFormats.join(', ') || '—'],
    [t('suite.row.exports'), m.exportFormats.join(', ') || '—'],
    [t('suite.row.document'), t('suite.row.documentVersion', { version: m.documentVersion })],
  ];
  if (caps) {
    rows.push([t('suite.row.reports'), caps.commands.filter((c) => c.kind === 'report').map((c) => c.name).join(', ') || '—']);
    rows.push([t('suite.row.conversions'), caps.commands.filter((c) => c.kind === 'convert').map((c) => c.name).join(', ') || '—']);
    rows.push([t('suite.row.traceViews'), caps.traceViews.map((v) => v.prefix).join(', ') || '—']);
  }
  if (m.schemaUrl) rows.push([t('suite.row.schema'), m.schemaUrl]);
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
    stage.append(Object.assign(document.createElement('p'), { className: 'wb-empty', textContent: t('suite.noEmbed', { name: m.name }) }));
    return;
  }
  const common = { container: stage, url: m.embedUrl, title: m.name, ui: 'min' as const, lang: getLang() };
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

function mount(m: ResolvedModule, common: { container: HTMLElement; url: string; title: string; ui: 'min'; lang: Lang }): void {
  if (m.id === 'c4') {
    // El editor C4 habla su propio protocolo (`createIarkEmbed`); el resto, el de módulos.
    embed = createIarkEmbed({
      ...common,
      onInit: () => print('init', { module: m.id }),
      onLoad: ({ document }) => print('load', { module: m.id, elementos: document.model.elements.length }),
      onChange: (document) => print('change', { module: m.id, elementos: document.model.elements.length }),
      onError: reportEmbedError,
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
        else if (event.event === 'error') reportEmbedError(event);
      },
    });
  }
}

async function connect(typed: string): Promise<void> {
  awaiting = undefined;
  state.textContent = t('suite.connecting');
  nav.replaceChildren();
  embed?.destroy(); // sin los módulos de la instancia anterior (ni el aviso de confirmación) mientras se conecta
  embed = undefined;
  stage.replaceChildren();
  let url: string;
  try {
    url = new URL(typed, window.location.href).toString(); // acepta rutas relativas a esta página
  } catch {
    state.textContent = t('suite.offline');
    nav.append(Object.assign(document.createElement('p'), { className: 'wb-note', role: 'alert', textContent: t('suite.notUrl', { typed }) }));
    return;
  }
  try {
    manifest = await loadManifest(url);
  } catch (error) {
    state.textContent = t('suite.offline');
    nav.append(Object.assign(document.createElement('p'), { className: 'wb-note', role: 'alert', textContent: (error as Error).message }));
    print('error', { message: (error as Error).message });
    return;
  }
  const apart = manifest.rejected.length > 0 ? ` (${tp('suite.n.rejected', manifest.rejected.length)})` : '';
  state.textContent = t('suite.connected', { name: manifest.name, version: manifest.version, modules: tp('suite.n.modules', manifest.modules.length), apart });
  print('manifiesto', { url, protocolo: manifest.protocol, modulos: manifest.modules.map((m) => m.id) });
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
  // Los módulos que exigen un contrato más nuevo que el de esta suite no se ofrecen: se avisa por qué en vez de ocultarlos en silencio.
  for (const rejected of manifest.rejected) {
    nav.append(Object.assign(document.createElement('p'), { className: 'wb-note', role: 'alert', textContent: rejected.reason }));
    print('módulo no compatible', { module: rejected.id, motivo: rejected.reason });
  }
  if (manifest.modules.length === 0 && manifest.rejected.length > 0) {
    stage.append(Object.assign(document.createElement('p'), { className: 'wb-empty', textContent: t('suite.noneCompatible') }));
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
  awaiting = origin;
  state.textContent = t('suite.awaiting');
  nav.replaceChildren();
  stage.replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'wb-note',
      role: 'alert',
      textContent: t('suite.confirm', { origin }),
    }),
  );
  print('pendiente de confirmar', { origen: origin });
  form.querySelector('button')?.focus();
}

applyStatic();
mountLanguageSelect();

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

// Al cambiar de idioma se repinta lo fijo y se vuelve a conectar: los módulos abiertos reciben el idioma nuevo al abrirse (viaja en la dirección del iframe).
subscribeLang(() => {
  applyStatic();
  if (awaiting) awaitConfirmation(awaiting);
  else void connect(input.value.trim());
});
