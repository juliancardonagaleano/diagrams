import { useReactFlow, type FitViewOptions } from '@xyflow/react';
import { useCallback } from 'react';
import { create } from 'zustand';
import { duracion } from '../../../modules-app/a11y/movimiento';

/**
 * Encuadres de cámara que el editor ha pedido y aún no han terminado (programados o animándose). Mientras haya alguno
 * el lienzo publica `data-layout="pending"`: así las pruebas, y quien integre el editor, saben cuándo la cámara ha
 * dejado de moverse. Es un contador compartido porque los encuadres los piden el lienzo (tras un autolayout o al bajar
 * de nivel) y la barra flotante (al pulsar Autolayout), que son componentes distintos.
 */
const useCameraStore = create<{ pending: number }>(() => ({ pending: 0 }));

/** true mientras quede algún encuadre pedido por el editor sin terminar. */
export const useCameraPending = (): boolean => useCameraStore((s) => s.pending > 0);

/**
 * Anota un encuadre como pendiente. La función devuelta lo da por terminado (si se llama más de una vez, cuenta solo
 * la primera). Se anota ANTES de cambiar la vista o lanzar el autolayout, para que el render que ya muestra el cambio
 * encuentre el encuadre anotado y no haya un intervalo en que el lienzo parezca asentado.
 */
export function holdCamera(): () => void {
  useCameraStore.setState((s) => ({ pending: s.pending + 1 }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useCameraStore.setState((s) => ({ pending: Math.max(0, s.pending - 1) }));
  };
}

/**
 * Encuadres del editor. `fit` encuadra tras `delay` ms y mantiene el encuadre anotado hasta que acaba la animación (o,
 * si React Flow la interrumpe sin avisar, poco después de lo que debía durar). `fitAfter` anota el encuadre ya y lo
 * lanza cuando `work` termina; si `work` falla no encuadra y suelta el encuadre anotado.
 */
export function useFitCamera() {
  const { fitView } = useReactFlow();

  const fit = useCallback(
    (options: FitViewOptions, delay = 0, release: () => void = holdCamera()): void => {
      // Con «reducir movimiento» activo en el sistema, la cámara salta sin animar (WCAG 2.3.3).
      const effective = options.duration === undefined ? options : { ...options, duration: duracion(options.duration) };
      const run = (): void => {
        // La promesa de fitView no se resuelve si la animación se interrumpe: se acota con la duración prevista.
        const animation = new Promise((resolve) => resolve(fitView(effective)));
        const limit = new Promise((resolve) => window.setTimeout(resolve, (effective.duration ?? 0) + 300));
        void Promise.race([animation, limit]).then(release, release);
      };
      // Sin retardo se encuadra al instante, como antes de anotarlo: el aplazamiento solo existe donde ya lo había.
      if (delay > 0) window.setTimeout(run, delay);
      else run();
    },
    [fitView],
  );

  const fitAfter = useCallback(
    (work: Promise<unknown>, options: FitViewOptions, delay = 0): void => {
      const release = holdCamera();
      void work.then(() => fit(options, delay, release), release);
    },
    [fit],
  );

  return { fit, fitAfter };
}
