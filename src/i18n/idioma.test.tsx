// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LANG_STORAGE_KEY, detectLang, getLang, initLang, resetLang, setLang, t, tp } from './index';
import { LanguageSelect, useT } from './react';

/** El navegador de las pruebas habla español (ver `tests/setup/jsdom.ts`); estas pruebas lo cambian a propósito y lo restauran. */
function browserSpeaks(...languages: string[]): void {
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(navigator, 'language', { value: languages[0], configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  browserSpeaks('es-ES', 'es');
  resetLang();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  browserSpeaks('es-ES', 'es');
  resetLang();
});

describe('elección del idioma en el navegador', () => {
  it('sin nada que decidir, español (el del navegador de las pruebas) y <html lang> acorde', () => {
    expect(initLang()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });

  it('el navegador en inglés da inglés', () => {
    browserSpeaks('en-GB', 'en');
    expect(initLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(detectLang().source).toBe('navigator');
  });

  it('lo elegido (localStorage) manda sobre el navegador', () => {
    browserSpeaks('en-US');
    window.localStorage.setItem(LANG_STORAGE_KEY, 'es');
    expect(initLang()).toBe('es');
  });

  it('?lang= manda sobre lo elegido y sobre el navegador', () => {
    browserSpeaks('es-ES');
    window.localStorage.setItem(LANG_STORAGE_KEY, 'es');
    window.history.replaceState(null, '', '/?lang=en');
    expect(initLang()).toBe('en');
    expect(detectLang().source).toBe('url');
  });

  it('un localStorage que lanza (ventana privada) no impide elegir ni cambiar de idioma', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    browserSpeaks('en-US');
    expect(initLang()).toBe('en');
    expect(() => setLang('es')).not.toThrow();
    expect(getLang()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('cambiar de idioma', () => {
  it('setLang recuerda la elección, pone <html lang> y cambia los textos', () => {
    setLang('en');
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(t('hist.title')).toBe('Version history');
    setLang('es');
    expect(t('hist.title')).toBe('Historial de versiones');
  });

  it('con persist:false (modo embebido) no se recuerda: manda el anfitrión', () => {
    setLang('en', { persist: false });
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBeNull();
    expect(getLang()).toBe('en');
  });

  it('si la dirección trae ?lang=, el cambio la mantiene al día para que recargar no lo deshaga', () => {
    window.history.replaceState(null, '', '/pagina?x=1&lang=es');
    initLang();
    setLang('en');
    expect(new URLSearchParams(window.location.search).get('lang')).toBe('en');
    expect(new URLSearchParams(window.location.search).get('x')).toBe('1');
  });

  it('sin ?lang= en la dirección no se la añade', () => {
    setLang('en');
    expect(window.location.search).toBe('');
  });

  it('un idioma sin catálogo se ignora', () => {
    setLang('en');
    setLang('fr' as never);
    expect(getLang()).toBe('en');
  });

  it('los plurales siguen las reglas de cada idioma', () => {
    setLang('es', { persist: false });
    expect([1, 2].map((n) => tp('hist.count', n))).toEqual(['1 versión', '2 versiones']);
    setLang('en', { persist: false });
    expect([1, 2].map((n) => tp('hist.count', n))).toEqual(['1 version', '2 versions']);
  });
});

describe('<LanguageSelect> y useT', () => {
  function Texto() {
    const { t: tt } = useT();
    return <p data-testid="texto">{tt('hist.title')}</p>;
  }

  it('el selector tiene nombre accesible, ofrece cada idioma escrito en sí mismo y repinta al cambiar', () => {
    render(
      <>
        <LanguageSelect />
        <Texto />
      </>,
    );
    const select = screen.getByRole('combobox', { name: 'Idioma' }) as HTMLSelectElement;
    expect(select.value).toBe('es');
    expect([...select.options].map((o) => [o.value, o.textContent, o.lang])).toEqual([
      ['es', 'Español', 'es'],
      ['en', 'English', 'en'],
    ]);
    expect(screen.getByTestId('texto')).toHaveTextContent('Historial de versiones');

    fireEvent.change(select, { target: { value: 'en' } });

    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    expect(screen.getByTestId('texto')).toHaveTextContent('Version history');
    expect(document.documentElement.lang).toBe('en');
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
  });

  it('con persist={false} el selector cambia el idioma pero no lo recuerda', () => {
    render(<LanguageSelect persist={false} />);
    fireEvent.change(screen.getByTestId('lang-select'), { target: { value: 'en' } });
    expect(getLang()).toBe('en');
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBeNull();
  });
});
