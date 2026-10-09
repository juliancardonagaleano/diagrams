import { Fragment, useMemo, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react';
import './lang.css';
import { LANGS, LANG_NAMES, formatDate, formatNumber, getLang, richParts, setLang, subscribeLang, t, tp, type Lang, type MessageArgs, type MessageKey, type PluralKey } from './index';

/** El idioma actual; la pantalla que lo llama se vuelve a pintar cuando la persona lo cambia. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/** Un texto con `<b>…</b>` y `<code>…</code>` convertido en elementos (nunca `innerHTML`). */
export function Rich({ text }: { text: string }): ReactNode {
  return (
    <>
      {richParts(text).map((part, index) => (
        <Fragment key={index}>{part.kind === 'b' ? <strong>{part.text}</strong> : part.kind === 'code' ? <code>{part.text}</code> : part.text}</Fragment>
      ))}
    </>
  );
}

/**
 * Traducción para un componente: `const { t, tp, tr } = useT();`. Llamarla suscribe al componente al idioma (se repinta al cambiarlo);
 * `tr` es `t` con `<b>` y `<code>` convertidos en elementos.
 */
export function useT() {
  const lang = useLang();
  return useMemo(() => ({ lang, t, tp, tr, formatDate, formatNumber }), [lang]);
}

function tr<K extends MessageKey>(key: K, ...args: MessageArgs<K>): ReactNode {
  return <Rich text={t(key, ...args)} />;
}

export interface LanguageSelectProps {
  className?: string;
  /** No recordar la elección (el modo embebido: manda el anfitrión). */
  persist?: boolean;
}

/**
 * Selector de idioma accesible: un `<select>` nativo con nombre accesible («Idioma» / «Language»), cada opción con su propio `lang` y escrita en su idioma
 * (quien no lee el actual debe encontrar el suyo). Cambia al momento, sin recargar.
 */
export function LanguageSelect({ className, persist }: LanguageSelectProps) {
  const lang = useLang();
  const label = t('lang.label');
  return (
    <select
      className={className ?? 'iark-lang'}
      aria-label={label}
      title={label}
      value={lang}
      data-testid="lang-select"
      onChange={(event: ChangeEvent<HTMLSelectElement>) => setLang(event.target.value as Lang, { persist })}
    >
      {LANGS.map((code) => (
        <option key={code} value={code} lang={code}>
          {LANG_NAMES[code]}
        </option>
      ))}
    </select>
  );
}

export type { MessageKey, PluralKey };
