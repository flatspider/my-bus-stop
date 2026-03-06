import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { readInitialStopData } from './initialStopData'

const initialStopData = readInitialStopData()

function loadAnalytics() {
  if (document.querySelector('script[data-goatcounter]')) return

  const script = document.createElement('script')
  script.dataset.goatcounter = 'https://bauhausbus.goatcounter.com/count'
  script.async = true
  script.src = '//gc.zgo.at/count.js'
  document.body.appendChild(script)
}

hydrateRoot(document.getElementById('root')!,
  <StrictMode>
    <App initialStopData={initialStopData} />
  </StrictMode>,
)

if (typeof window !== 'undefined') {
  const run = () => window.setTimeout(loadAnalytics, 1200)
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => run())
  } else {
    run()
  }
}
