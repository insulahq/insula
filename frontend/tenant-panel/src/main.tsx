import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { GlobalTooltips } from './components/ui/GlobalTooltips';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Every title="…" renders as a styled tooltip — mounted outside App so
        the login page and the error fallback get it too. */}
    <GlobalTooltips />
    <App />
  </React.StrictMode>,
);
