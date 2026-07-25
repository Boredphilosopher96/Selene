import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import '../../../../web/src/styles.css';
import '@selene/ui/designer-workspace.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('The application root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
