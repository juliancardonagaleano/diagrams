// Antes que cualquier otro import (se crean esquemas de zod al cargarlos): sin el modo JIT de zod no hay violaciones de la CSP por `new Function`.
import '@iark/kernel/jitless';
import React from 'react';
import ReactDOM from 'react-dom/client';
// Necesario en React 19: Semi UI monta imperativos (Modal.confirm, Toast…) fuera del árbol de
// React y necesita este adaptador para saber cómo crear esa raíz. Sin él, Modal.confirm no
// llega a renderizar nada (solo un error en consola), sin ningún aviso visible al usuario.
import '@douyinfe/semi-ui/react19-adapter';
import '@douyinfe/semi-ui/lib/es/_base/base.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isEmbedMode } from './store/documentStore';
import { completeGithubLogin } from '../projects/login';

// Si la página acaba de volver de GitHub (`#iark_code=…`), la sesión se termina de crear **antes** de montar nada: la sesión de proyectos que
// crea el editor lee la configuración al nacer. No espera nada si no se viene de un inicio de sesión; en modo embebido guarda el anfitrión.
void (isEmbedMode ? Promise.resolve() : completeGithubLogin()).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
