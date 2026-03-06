import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { hasSsrBootstrap, readInitialStopData } from './initialStopData'

const rootElement = document.getElementById('root')!
const initialStopData = readInitialStopData()
const shouldHydrate = hasSsrBootstrap() && rootElement.hasChildNodes()

function loadAnalytics() {
  if (document.querySelector('script[data-goatcounter]')) return

  const script = document.createElement('script')
  script.dataset.goatcounter = 'https://bauhausbus.goatcounter.com/count'
  script.async = true
  script.src = '//gc.zgo.at/count.js'
  document.body.appendChild(script)
}

const app = (
  <StrictMode>
    <App initialStopData={initialStopData} />
  </StrictMode>
)

if (shouldHydrate) {
  hydrateRoot(rootElement, app)
} else {
  createRoot(rootElement).render(app)
}

if (typeof window !== 'undefined') {
  const run = () => window.setTimeout(loadAnalytics, 1200)
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => run())
  } else {
    run()
  }
}
