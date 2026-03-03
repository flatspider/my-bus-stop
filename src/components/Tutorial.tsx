import { useState, useEffect, useRef } from "react";

const STEPS = [
  {
    target: '[data-tutorial="default-stop"]',
    text: "This is the default bus stop. Enter your bus stop code in Settings to change it.",
    borderRadius: 16,
  },
  {
    target: '[data-tutorial="card"]',
    text: "Tap for route details on MTA BusTime.",
    borderRadius: 16,
  },
  {
    target: '[data-tutorial="stop-input"]',
    text: "Scan or enter your 6-digit stop code to track your stop.",
    borderRadius: 16,
    openSettings: true,
  },
];

interface Props {
  onClose: () => void;
  onOpenSettings: () => void;
}

function measureTarget(stepIndex: number): DOMRect | null {
  const el = document.querySelector(STEPS[stepIndex].target);
  return el ? el.getBoundingClientRect() : null;
}

export default function Tutorial({ onClose, onOpenSettings }: Props) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [visible, setVisible] = useState(true);

  // Stable ref so the effect never re-fires from prop identity changes
  const openSettingsRef = useRef(onOpenSettings);
  openSettingsRef.current = onOpenSettings;

  // Measure on mount
  useEffect(() => {
    setRect(measureTarget(0));
  }, []);

  // Handle step transitions — only depends on `step`
  useEffect(() => {
    if (step === 0) return;

    // Fade out first so spotlight/tooltip can move cleanly between targets.
    setVisible(false);

    const shouldOpenSettings = Boolean(STEPS[step].openSettings);
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    if (shouldOpenSettings) {
      // Small delay so fade-out finishes before opening the panel.
      openTimer = setTimeout(() => {
        openSettingsRef.current();
      }, 50);
    }

    const revealDelay = shouldOpenSettings ? 500 : 220;
    const revealTimer = setTimeout(() => {
      setRect(measureTarget(step));
      setVisible(true);
    }, revealDelay);

    return () => {
      if (openTimer) clearTimeout(openTimer);
      clearTimeout(revealTimer);
    };
  }, [step]);

  // Re-measure on resize
  useEffect(() => {
    function handleResize() {
      setRect(measureTarget(step));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [step]);

  function next() {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      onClose();
    }
  }

  if (!rect) return null;

  const pad = 8;
  const spotStyle: React.CSSProperties = {
    position: "fixed",
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
    borderRadius: STEPS[step].borderRadius,
  };

  const tooltipBelow = rect.bottom + pad + 16 + 120 < window.innerHeight;
  const tooltipStyle: React.CSSProperties = {
    position: "fixed",
    left: rect.left,
    width: Math.min(rect.width + pad * 2, 340),
    ...(tooltipBelow
      ? { top: rect.bottom + pad + 16 }
      : { bottom: window.innerHeight - rect.top + pad + 16 }),
  };

  return (
    <div
      className={`tutorial-overlay ${visible ? "" : "tutorial-overlay--hidden"}`}
    >
      <div className="tutorial-spotlight" style={spotStyle} />

      <div className="tutorial-tooltip" style={tooltipStyle}>
        <p className="tutorial-tooltip__text">{STEPS[step].text}</p>
        <button className="tutorial-tooltip__btn" onClick={next}>
          {step < STEPS.length - 1 ? "Next" : "Done"}
        </button>
      </div>

      <button
        className="tutorial-close"
        onClick={onClose}
        aria-label="Close tutorial"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="2" y1="2" x2="10" y2="10" />
          <line x1="10" y1="2" x2="2" y2="10" />
        </svg>
      </button>
    </div>
  );
}
