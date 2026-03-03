import { useState, useEffect, useCallback } from 'react'

const STEPS = [
  {
    target: '[data-tutorial="card"]',
    text: 'Each card is a route. Tap one for details on MTA BusTime.',
    borderRadius: 16,
  },
  {
    target: '[data-tutorial="stop-input"]',
    text: 'Enter your 6-digit stop code to track your stop.',
    borderRadius: 10,
  },
]

interface Props {
  onClose: () => void
  onOpenSettings: () => void
}

export default function Tutorial({ onClose, onOpenSettings }: Props) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const measure = useCallback(() => {
    const el = document.querySelector(STEPS[step].target)
    if (el) {
      setRect(el.getBoundingClientRect())
    }
  }, [step])

  useEffect(() => {
    if (step === 1) {
      onOpenSettings()
      const timer = setTimeout(measure, 300)
      return () => clearTimeout(timer)
    }
    measure()
  }, [step, measure, onOpenSettings])

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  function next() {
    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      onClose()
    }
  }

  if (!rect) return null

  const pad = 8
  const spotStyle: React.CSSProperties = {
    position: 'fixed',
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
    borderRadius: STEPS[step].borderRadius,
  }

  // Position tooltip below spotlight, or above if not enough space
  const tooltipBelow = rect.bottom + pad + 16 + 120 < window.innerHeight
  const tooltipStyle: React.CSSProperties = {
    position: 'fixed',
    left: rect.left,
    width: Math.min(rect.width + pad * 2, 340),
    ...(tooltipBelow
      ? { top: rect.bottom + pad + 16 }
      : { bottom: window.innerHeight - rect.top + pad + 16 }),
  }

  return (
    <div className="tutorial-fade-in">
      <div className="tutorial-spotlight" style={spotStyle} />

      <div className="tutorial-tooltip" style={tooltipStyle}>
        <p className="tutorial-tooltip__text">{STEPS[step].text}</p>
        <button className="tutorial-tooltip__btn" onClick={next}>
          {step < STEPS.length - 1 ? 'Next' : 'Done'}
        </button>
      </div>

      <button className="tutorial-close" onClick={onClose} aria-label="Close tutorial">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <line x1="2" y1="2" x2="10" y2="10" />
          <line x1="10" y1="2" x2="2" y2="10" />
        </svg>
      </button>
    </div>
  )
}
