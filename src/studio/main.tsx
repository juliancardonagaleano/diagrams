import React from 'react';
import ReactDOM from 'react-dom/client';
import '@douyinfe/semi-ui/lib/es/_base/base.css';
import '../app/styles.css';
import { Studio } from './Studio';

const params = new URLSearchParams(window.location.search);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Studio initialModule={params.get('module')} />
  </React.StrictMode>,
);
