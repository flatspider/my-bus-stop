import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import StopPage from './StopPage.tsx'
import { DEFAULT_STOP_CODE } from './stopConfig'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to={`/stop/${DEFAULT_STOP_CODE}`} replace />} />
        <Route path="/stop/:stopCode" element={<StopPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
