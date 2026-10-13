import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { ToastProvider } from './components/ToastRegion.js';
import { readSupabaseConfig } from './lib/auth/config.js';
import { SessionProvider } from './lib/auth/session.js';
import { createSupabaseAdapter } from './lib/auth/supabase.js';
import { applyTheme, defaultPrefs, loadPrefs } from './lib/prefs.js';
import { PrefsProvider } from './state/prefs.js';
import { SystemProvider, useSystem } from './state/system.js';
import { UploadQueueProvider } from './state/uploadQueue.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/files.css';
import './styles/upload.css';
import './styles/dialogs.css';
import './styles/auth.css';
import './styles/status.css';
import './styles/chart.css';

/**
 * Entry point.
 *
 * The Supabase adapter is created only when both public values are configured; otherwise the app
 * runs with the anonymous path alone and the sign-in screen says why. The theme is applied before
 * the first render so a dark-mode visitor never sees a white flash.
 */
const { configured, config } = readSupabaseConfig();
const adapter = configured ? createSupabaseAdapter(config) : null;

applyTheme((loadPrefs() ?? defaultPrefs()).theme);

function AuthenticatedProviders() {
  const { limits } = useSystem();
  return (
    <UploadQueueProvider limits={limits}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </UploadQueueProvider>
  );
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <SessionProvider adapter={adapter} authConfigured={configured}>
      <ToastProvider>
        <PrefsProvider>
          <SystemProvider>
            <AuthenticatedProviders />
          </SystemProvider>
        </PrefsProvider>
      </ToastProvider>
    </SessionProvider>
  </StrictMode>,
);
