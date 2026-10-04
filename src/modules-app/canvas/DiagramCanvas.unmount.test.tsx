// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pretty, type EditorSpec, type GraphLayout } from '@iark/kernel';
import { installFlowMocks } from '../testing-dom';
import { FAKE_DOC, fakeEditor } from '../testing-editor';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

// La cámara (`fitView` de React Flow) se sustituye por una función que controla la prueba: así se decide si la animación
// termina, si nunca avisa (React Flow la interrumpe sin avisar) o si termina después de desmontar el lienzo.
const cam = vi.hoisted(() => ({ fitView: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  const { useMemo } = await import('react');
  return {
    ...actual,
    // Mismo objeto estable que el real (el lienzo lo usa como dependencia de efectos), solo con `fitView` sustituida.
    useReactFlow: () => {
      const real = actual.useReactFlow();
      return useMemo(() => ({ ...real, fitView: cam.fitView }), [real]);
    },
  };
});

beforeAll(installFlowMocks);
beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const spec = fakeEditor as unknown as EditorSpec<unknown>;
const box = (id: string, x: number, y: number) => ({ id, x, y, width: 160, height: 64 });
const LAYOUT: GraphLayout = {
  nodes: [box('api', 20, 40), box('cola', 220, 40), box('worker', 420, 40), box('libre', 20, 240)],
  groups: [box('zona', 0, 0)],
  edges: [],
  width: 600,
  height: 320,
};
// Colocación propia del módulo e inmediata: no depende de ELK, así que el único temporizador del encuadre es el de la cámara.
const own = { ...spec, layout: () => Promise.resolve(LAYOUT) } as EditorSpec<unknown>;
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const canvas = (): HTMLElement => screen.getByTestId('module-canvas');

function mount() {
  return render(<DiagramCanvas moduleId="fake" spec={own} document={FAKE_DOC} text={pretty(FAKE_DOC)} views={[]} onView={vi.fn()} readOnly={false} history={new EditHistory()} onText={vi.fn()} notify={vi.fn()} />);
}

/** Monta el lienzo y deja el encuadre en curso: la colocación aplicada y el retardo de 60 ms pasados, con `fitView` llamada una vez. */
async function mountFitting() {
  const view = mount();
  await advance(0); // la colocación propia se aplica
  await advance(70); // pasa el retardo del primer encuadre: se llama a `fitView` y se arma el plazo de reserva
  expect(cam.fitView).toHaveBeenCalledTimes(1);
  expect(canvas()).toHaveAttribute('data-layout', 'pending'); // aún no hay noticia de que la cámara haya terminado
  return view;
}

/** Errores sin capturar (promesas rechazadas) que salten mientras `run` corre, dejando pasar un turno real del bucle de eventos. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = [];
  const onRejection = (error: unknown): void => void errors.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return errors;
}

describe('lienzo: desmontar con un encuadre de la cámara en curso', () => {
  it('no deja ningún temporizador vivo ni vuelve a mover la cámara', async () => {
    cam.fitView = vi.fn(() => new Promise(() => undefined)); // React Flow interrumpe la animación sin avisar: solo queda el plazo de reserva
    const view = await mountFitting();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // el plazo de reserva está armado

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(5000);
    expect(cam.fitView).toHaveBeenCalledTimes(1);
  });

  it('desmontar antes de que pase el retardo del primer encuadre tampoco encuadra ni deja temporizadores', async () => {
    cam.fitView = vi.fn(() => new Promise(() => undefined));
    const view = mount();
    await advance(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(5000);
    expect(cam.fitView).not.toHaveBeenCalled();
  });

  // Reproduce el fallo: el plazo de reserva seguía vivo tras desmontar y, al dispararse con el entorno ya destruido,
  // `setFittedFor` leía `window.event` (React) y lanzaba «window is not defined» como rechazo sin capturar.
  it('con el entorno ya destruido, el plazo de reserva pendiente no dispara ningún error', async () => {
    cam.fitView = vi.fn(() => new Promise(() => undefined));
    const view = await mountFitting();
    view.unmount();
    const real = window;

    const errors = await unhandledDuring(async () => {
      vi.stubGlobal('window', undefined); // jsdom ya destruido
      try {
        await vi.advanceTimersByTimeAsync(5000);
      } finally {
        vi.stubGlobal('window', real);
      }
    });
    expect(errors).toEqual([]);
  });

  it('con el entorno ya destruido, el final tardío de la animación de React Flow tampoco dispara ningún error', async () => {
    let endAnimation: (ok: boolean) => void = () => undefined;
    cam.fitView = vi.fn(() => new Promise<boolean>((resolve) => (endAnimation = resolve)));
    const view = await mountFitting();
    view.unmount();
    const real = window;

    const errors = await unhandledDuring(async () => {
      vi.stubGlobal('window', undefined);
      try {
        endAnimation(true);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(5000);
      } finally {
        vi.stubGlobal('window', real);
      }
    });
    expect(errors).toEqual([]);
  });
});

describe('lienzo: el encuadre sigue asentándose igual con el lienzo montado', () => {
  it('cuando la animación termina, el lienzo pasa a «ready» y el plazo de reserva se libera', async () => {
    let endAnimation: (ok: boolean) => void = () => undefined;
    cam.fitView = vi.fn(() => new Promise<boolean>((resolve) => (endAnimation = resolve)));
    await mountFitting();

    endAnimation(true);
    await advance(0);
    expect(canvas()).toHaveAttribute('data-layout', 'ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('si React Flow no avisa, el lienzo pasa a «ready» pasada la duración más el margen (200 + 300 ms)', async () => {
    cam.fitView = vi.fn(() => new Promise(() => undefined));
    await mountFitting();

    await advance(450);
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await advance(100);
    expect(canvas()).toHaveAttribute('data-layout', 'ready');
    expect(cam.fitView).toHaveBeenCalledTimes(1); // la cámara se tocó una sola vez
  });
  // Mismo fallo con el autolayout: ELK responde tarde, tras desmontar, y `apply` pintaba estado de un lienzo que ya no está
  // (con el entorno destruido, `setLayout` lanzaba «window is not defined» y el `catch` volvía a lanzarlo desde `fail`).
  it('con el entorno ya destruido, la respuesta tardía del autolayout tampoco dispara ningún error', async () => {
    cam.fitView = vi.fn(() => new Promise(() => undefined));
    let place: (layout: GraphLayout) => void = () => undefined;
    const slow = { ...spec, layout: () => new Promise<GraphLayout>((resolve) => (place = resolve)) } as EditorSpec<unknown>;
    const view = render(<DiagramCanvas moduleId="fake" spec={slow} document={FAKE_DOC} text={pretty(FAKE_DOC)} views={[]} onView={vi.fn()} readOnly={false} history={new EditHistory()} onText={vi.fn()} notify={vi.fn()} />);
    await advance(0); // la colocación queda en vuelo
    view.unmount();
    const real = window;

    const errors = await unhandledDuring(async () => {
      vi.stubGlobal('window', undefined);
      try {
        place(LAYOUT);
        await vi.advanceTimersByTimeAsync(5000);
      } finally {
        vi.stubGlobal('window', real);
      }
    });
    expect(errors).toEqual([]);
  });
});
