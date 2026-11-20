import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './lib/i18n-provider'
import { migratePreferences } from './lib/preferences-migration'

try { migratePreferences(window.localStorage) } catch { /* Storage may be blocked. */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider><App /></I18nProvider>
  </StrictMode>,
)
