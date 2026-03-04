import { useState, useEffect, useLayoutEffect, useRef } from "react";

const MOBILE_BREAKPOINT_PX = 600;
const VIEWPORT_GUTTER_PX = 12;
const REGULAR_STEP_REVEAL_DELAY_MS = 220;
const SETTINGS_STEP_MAX_WAIT_MS = 900;
const SETTINGS_STEP_STABLE_FRAMES = 3;
const RECT_STABLE_DELTA_PX = 0.75;
const SECONDARY_SPOT_INSET_PX = 6;
const DEFAULT_SPOT_INSETS = { top: 8, right: 8, bottom: 8, left: 8 };
const STOP_INPUT_SPOT_INSETS_DESKTOP = {
  top: 14,
  right: 10,
  bottom: 10,
  left: 10,
};
const STOP_INPUT_SPOT_INSETS_MOBILE = {
  top: 10,
  right: 8,
  bottom: 10,
  left: 8,
};

const STEPS = [
  {
    target: '[data-tutorial="default-stop"]',
    text: "Tap to search for your bus stop.",
    borderRadius: 16,
  },
  {
    target: '[data-tutorial="card"]',
    text: "Each card is one arriving bus. Click for route details on MTA BusTime.",
    borderRadius: 16,
  },
  {
    target: '[data-tutorial="stop-input"]',
    text: "In settings, scan or enter your 6-digit stop code to track your stop.",
    borderRadius: 16,
    openSettings: true,
    secondaryTarget: '[data-tutorial="settings-gear"]',
  },
];

interface Props {
  onClose: () => void;
  onOpenSettings: () => void;
  onStepChange?: (step: number) => void;
}

interface SpotInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.min(Math.max(value, min), max);
}

function rectsAreClose(a: DOMRect, b: DOMRect, delta: number): boolean {
  return (
    Math.abs(a.top - b.top) <= delta &&
    Math.abs(a.left - b.left) <= delta &&
    Math.abs(a.width - b.width) <= delta &&
    Math.abs(a.height - b.height) <= delta
  );
}

function measureElement(selector: string): DOMRect | null {
  const el = document.querySelector(selector);
  return el ? el.getBoundingClientRect() : null;
}

function measureTarget(stepIndex: number): DOMRect | null {
  return measureElement(STEPS[stepIndex].target);
}

function measureSecondaryTarget(stepIndex: number): DOMRect | null {
  const secondaryTarget = STEPS[stepIndex].secondaryTarget;
  return secondaryTarget ? measureElement(secondaryTarget) : null;
}

function getSpotInsets(stepIndex: number, isMobile: boolean): SpotInsets {
  if (STEPS[stepIndex].target === '[data-tutorial="stop-input"]') {
    return isMobile
      ? STOP_INPUT_SPOT_INSETS_MOBILE
      : STOP_INPUT_SPOT_INSETS_DESKTOP;
  }
  return DEFAULT_SPOT_INSETS;
}

export default function Tutorial({
  onClose,
  onOpenSettings,
  onStepChange,
}: Props) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [secondaryRect, setSecondaryRect] = useState<DOMRect | null>(null);
  const [visible, setVisible] = useState(true);
  const [instantHide, setInstantHide] = useState(false);

  // Stable ref so the effect never re-fires from prop identity changes
  const openSettingsRef = useRef(onOpenSettings);
  openSettingsRef.current = onOpenSettings;

  // Measure on mount
  useEffect(() => {
    setRect(measureTarget(0));
    setSecondaryRect(measureSecondaryTarget(0));
  }, []);

  // Handle step transitions — only depends on `step`
  useEffect(() => {
    onStepChange?.(step);
  }, [onStepChange, step]);

  // Handle step transitions — only depends on `step`
  useLayoutEffect(() => {
    if (step === 0) return;

    const shouldOpenSettings = Boolean(STEPS[step].openSettings);
    setInstantHide(true);

    // Hide first so spotlight/tooltip can move cleanly between targets.
    setVisible(false);

    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let rafId: number | undefined;
    let cancelled = false;

    if (shouldOpenSettings) {
      openTimer = setTimeout(() => {
        openSettingsRef.current();
      }, 0);

      const startedAt = performance.now();
      let previousRect: DOMRect | null = null;
      let stableFrames = 0;

      const pollUntilStable = () => {
        if (cancelled) return;

        const nextRect = measureTarget(step);
        const nextSecondaryRect = measureSecondaryTarget(step);
        setSecondaryRect(nextSecondaryRect);
        const hasTimedOut =
          performance.now() - startedAt >= SETTINGS_STEP_MAX_WAIT_MS;

        if (nextRect) {
          setRect(nextRect);
          if (
            previousRect &&
            rectsAreClose(previousRect, nextRect, RECT_STABLE_DELTA_PX)
          ) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
          }
          previousRect = nextRect;

          if (stableFrames >= SETTINGS_STEP_STABLE_FRAMES || hasTimedOut) {
            setVisible(true);
            setInstantHide(false);
            return;
          }
        } else if (hasTimedOut) {
          setVisible(true);
          setInstantHide(false);
          return;
        }

        rafId = window.requestAnimationFrame(pollUntilStable);
      };

      rafId = window.requestAnimationFrame(pollUntilStable);
    } else {
      revealTimer = setTimeout(() => {
        setRect(measureTarget(step));
        setSecondaryRect(measureSecondaryTarget(step));
        setVisible(true);
        setInstantHide(false);
      }, REGULAR_STEP_REVEAL_DELAY_MS);
    }

    return () => {
      cancelled = true;
      if (openTimer) clearTimeout(openTimer);
      if (revealTimer) clearTimeout(revealTimer);
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
    };
  }, [step]);

  // Re-measure on resize
  useEffect(() => {
    function handleResize() {
      setRect(measureTarget(step));
      setSecondaryRect(measureSecondaryTarget(step));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [step]);

  function next() {
    if (step < STEPS.length - 1) {
      setInstantHide(true);
      setVisible(false);
      setStep(step + 1);
    } else {
      onClose();
    }
  }

  if (!rect) return null;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const isMobile = viewportWidth <= MOBILE_BREAKPOINT_PX;
  const isFirstStep = step === 0;
  const hasSecondaryTarget = Boolean(STEPS[step].secondaryTarget);
  const insets = getSpotInsets(step, isMobile);

  const spotWidth = Math.min(
    rect.width + insets.left + insets.right,
    viewportWidth - VIEWPORT_GUTTER_PX * 2,
  );
  const spotHeight = Math.min(
    rect.height + insets.top + insets.bottom,
    viewportHeight - VIEWPORT_GUTTER_PX * 2,
  );
  const spotLeft = clamp(
    rect.left - insets.left,
    VIEWPORT_GUTTER_PX,
    viewportWidth - VIEWPORT_GUTTER_PX - spotWidth,
  );
  const spotTop = clamp(
    rect.top - insets.top,
    VIEWPORT_GUTTER_PX,
    viewportHeight - VIEWPORT_GUTTER_PX - spotHeight,
  );

  const spotStyle: React.CSSProperties = {
    position: "fixed",
    top: spotTop,
    left: spotLeft,
    width: spotWidth,
    height: spotHeight,
    borderRadius: STEPS[step].borderRadius,
  };

  const secondarySpot = secondaryRect
    ? {
        top: clamp(
          secondaryRect.top - SECONDARY_SPOT_INSET_PX,
          VIEWPORT_GUTTER_PX,
          viewportHeight -
            VIEWPORT_GUTTER_PX -
            (secondaryRect.height + SECONDARY_SPOT_INSET_PX * 2),
        ),
        left: clamp(
          secondaryRect.left - SECONDARY_SPOT_INSET_PX,
          VIEWPORT_GUTTER_PX,
          viewportWidth -
            VIEWPORT_GUTTER_PX -
            (secondaryRect.width + SECONDARY_SPOT_INSET_PX * 2),
        ),
        width: Math.min(
          secondaryRect.width + SECONDARY_SPOT_INSET_PX * 2,
          viewportWidth - VIEWPORT_GUTTER_PX * 2,
        ),
        height: Math.min(
          secondaryRect.height + SECONDARY_SPOT_INSET_PX * 2,
          viewportHeight - VIEWPORT_GUTTER_PX * 2,
        ),
        borderRadius: 999,
      }
    : null;
  const secondarySpotStyle: React.CSSProperties | null = secondarySpot
    ? {
        position: "fixed",
        ...secondarySpot,
      }
    : null;

  const maxTooltipWidth = viewportWidth - VIEWPORT_GUTTER_PX * 2;
  const mobileTooltipWidth = isFirstStep
    ? clamp(spotWidth * 2, 220, maxTooltipWidth)
    : clamp(spotWidth, 220, maxTooltipWidth);
  const desktopTooltipWidth = isFirstStep
    ? clamp(spotWidth * 2, 260, Math.min(420, maxTooltipWidth))
    : Math.min(spotWidth, 340);
  const tooltipWidth = isMobile ? mobileTooltipWidth : desktopTooltipWidth;
  const tooltipLeft = clamp(
    spotLeft,
    VIEWPORT_GUTTER_PX,
    viewportWidth - VIEWPORT_GUTTER_PX - tooltipWidth,
  );
  const tooltipBottomIfAbove = viewportHeight - spotTop + 16;
  const tooltipTopIfBelow = spotTop + spotHeight + 16;
  const tooltipBelow =
    tooltipTopIfBelow + 120 < viewportHeight - VIEWPORT_GUTTER_PX;

  const tooltipStyle: React.CSSProperties = {
    position: "fixed",
    left: tooltipLeft,
    width: tooltipWidth,
    maxWidth: tooltipWidth,
    ...(tooltipBelow
      ? { top: tooltipTopIfBelow }
      : { bottom: tooltipBottomIfAbove }),
  };

  const overlayClasses = [
    "tutorial-overlay",
    visible ? "" : "tutorial-overlay--hidden",
    instantHide ? "tutorial-overlay--instant" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const maskId = `tutorial-cutout-mask-${step}`;

  return (
    <div className={overlayClasses}>
      {hasSecondaryTarget && secondarySpot ? (
        <>
          <svg
            className="tutorial-cutout-overlay"
            width={viewportWidth}
            height={viewportHeight}
            viewBox={`0 0 ${viewportWidth} ${viewportHeight}`}
            aria-hidden="true"
          >
            <defs>
              <mask id={maskId} maskUnits="userSpaceOnUse">
                <rect
                  x="0"
                  y="0"
                  width={viewportWidth}
                  height={viewportHeight}
                  fill="white"
                />
                <rect
                  x={spotLeft}
                  y={spotTop}
                  width={spotWidth}
                  height={spotHeight}
                  rx={STEPS[step].borderRadius}
                  fill="black"
                />
                <rect
                  x={secondarySpot.left}
                  y={secondarySpot.top}
                  width={secondarySpot.width}
                  height={secondarySpot.height}
                  rx={secondarySpot.borderRadius}
                  fill="black"
                />
              </mask>
            </defs>
            <rect
              x="0"
              y="0"
              width={viewportWidth}
              height={viewportHeight}
              fill="var(--tutorial-dim)"
              mask={`url(#${maskId})`}
            />
          </svg>
          {secondarySpotStyle && (
            <div
              className="tutorial-spotlight--secondary"
              style={secondarySpotStyle}
            />
          )}
        </>
      ) : (
        <div className="tutorial-spotlight" style={spotStyle} />
      )}

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
