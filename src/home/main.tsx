// Antes que cualquier otro import (se crean esquemas de zod al cargarlos): sin el modo JIT de zod no hay violaciones de la CSP por `new Function`.
import '@iark/kernel/jitless';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../modules-app/workbench.css';
import './home.css';
import { initLang } from '../i18n';
import { HomeApp } from './Home';

initLang();

const params = new URLSearchParams(window.location.search);
const requested = params.get('theme');
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true;
document.documentElement.dataset.theme = requested === 'light' || requested === 'dark' ? requested : prefersDark ? 'dark' : 'light';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HomeApp />
  </React.StrictMode>,
);
