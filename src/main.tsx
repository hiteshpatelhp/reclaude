import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const platform = window.reclaude?.platform ?? 'unknown';
document.body.classList.add(`platform-${platform}`);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
