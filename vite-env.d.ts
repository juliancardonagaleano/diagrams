/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Servidor de proyectos que el sitio propone por omisión (https://…); lo fija la compilación desde la variable IARK_SERVER_URL. */
  readonly VITE_IARK_SERVER?: string;
}
