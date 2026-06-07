import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.jsx'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

const clerkAppearance = {
  variables: {
    colorPrimary: '#7c3aed',
    colorBackground: '#14141f',
    colorText: '#f5f5fa',
    colorTextSecondary: '#a1a1b5',
    colorInputBackground: '#1d1d2b',
    colorInputText: '#f5f5fa',
    borderRadius: '14px',
  },
  elements: {
    socialButtonsBlockButton: {
      backgroundColor: '#ffffff',
      color: '#1a1a2e',
      border: '1px solid #ffffff',
    },
    socialButtonsBlockButtonText: {
      color: '#1a1a2e',
      fontWeight: '600',
    },
  },
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      afterSignOutUrl="/"
      appearance={clerkAppearance}
    >
      <App />
    </ClerkProvider>
  </StrictMode>,
)