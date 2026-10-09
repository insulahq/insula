import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { GlobalTooltips } from './components/ui/GlobalTooltips';
import './index.css';
import { reloadForNewBuild } from './lib/stale-chunk';

// A file of the previous build that fails to load outside a render (an event
// handler's import, a preload) never reaches the error boundary; Vite reports
// every such failure here. One that reaches the boundary too finds the reload
// already under way.
window.addEventListener('vite:preloadError', () => { reloadForNewBuild(); });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Every title="…" renders as a styled tooltip — mounted outside App so
        the login page and the error fallback get it too. */}
    <GlobalTooltips />
    <App />
  </React.StrictMode>,
);
