import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { stopCodeExists } from "../stopSearchApi";
import type { Settings } from "../useSettings";

const QrScanner = lazy(() => import("./QrScanner"));

interface SettingsPanelProps {
  onRefresh: () => void;
  refreshLocked: boolean;
  isRefreshing: boolean;
  refreshCooldownSeconds: number;
  settings: Settings;
  tutorialHighlightsStopInput?: boolean;
  inline?: boolean;
  onNavigateToStop?: () => void;
  onUpdateSetting: <K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) => void;
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="settings-toggle__track" />
    </label>
  );
}

export default function SettingsPanel({
  onRefresh,
  refreshLocked,
  isRefreshing,
  refreshCooldownSeconds,
  settings,
  tutorialHighlightsStopInput = false,
  inline = false,
  onNavigateToStop,
  onUpdateSetting,
}: SettingsPanelProps) {
  const [stopCode, setStopCode] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [isValidatingStop, setIsValidatingStop] = useState(false);
  const [isInputShaking, setIsInputShaking] = useState(false);
  const [hasFocusedStopInput, setHasFocusedStopInput] = useState(false);
  const [canUseQrScan, setCanUseQrScan] = useState(false);
  const shakeResetTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const coarsePointerMedia = window.matchMedia("(pointer: coarse)");
    const smallViewportMedia = window.matchMedia("(max-width: 900px)");

    const update = () => {
      const touchCapable =
        coarsePointerMedia.matches || navigator.maxTouchPoints > 0;
      setCanUseQrScan(touchCapable && smallViewportMedia.matches);
    };

    update();
    coarsePointerMedia.addEventListener("change", update);
    smallViewportMedia.addEventListener("change", update);
    return () => {
      coarsePointerMedia.removeEventListener("change", update);
      smallViewportMedia.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if (!canUseQrScan && scannerOpen) {
      setScannerOpen(false);
    }
  }, [canUseQrScan, scannerOpen]);

  useEffect(() => {
    return () => {
      if (shakeResetTimerRef.current !== null) {
        window.clearTimeout(shakeResetTimerRef.current);
      }
    };
  }, []);

  function triggerInputShake() {
    if (shakeResetTimerRef.current !== null) {
      window.clearTimeout(shakeResetTimerRef.current);
      shakeResetTimerRef.current = null;
    }

    setIsInputShaking(false);
    window.requestAnimationFrame(() => {
      setIsInputShaking(true);
      shakeResetTimerRef.current = window.setTimeout(() => {
        setIsInputShaking(false);
        shakeResetTimerRef.current = null;
      }, 420);
    });
  }

  function navigateToStop(code: string) {
    const targetPath = `/stop/${code}`;
    if (location.pathname === targetPath) {
      onRefresh();
    } else {
      navigate(targetPath);
    }
    onNavigateToStop?.();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function validateStopAndNavigate(code: string) {
    setIsValidatingStop(true);
    setScanError("");
    try {
      const exists = await stopCodeExists(code);
      if (!exists) {
        setScanError(
          "Stop code not found. Check the 6-digit code and try again.",
        );
        triggerInputShake();
        return;
      }
      navigateToStop(code);
    } catch {
      setScanError("Could not verify this stop code. Try again.");
      triggerInputShake();
    } finally {
      setIsValidatingStop(false);
    }
  }

  function handleScan(code: string) {
    setScannerOpen(false);
    setScanError("");
    setStopCode(code);
    void validateStopAndNavigate(code);
  }

  function handleScanError(msg: string) {
    setScanError(msg);
  }

  const normalizedStopCode = stopCode.trim();
  const canGo = /^\d{6}$/.test(normalizedStopCode);
  const showStopHelp = hasFocusedStopInput;

  function handleGo() {
    if (!canGo) return;
    void validateStopAndNavigate(normalizedStopCode);
  }

  return (
    <div
      className={`bus-card bus-card--settings${inline ? " bus-card--settings-inline" : ""}`}
    >
      <div className="bus-card__accent bus-card__accent--gray" />
      <div className="settings-panel__content">
        <button
          className="settings-panel__refresh"
          onClick={onRefresh}
          disabled={refreshLocked}
        >
          {isRefreshing
            ? "Refreshing..."
            : refreshCooldownSeconds > 0
              ? `Refresh (${refreshCooldownSeconds}s)`
              : "Refresh"}
        </button>
        <div className="settings-toggles">
          <ToggleRow
            label="Show 'min' suffix"
            checked={settings.showMinSuffix}
            onChange={(v) => onUpdateSetting("showMinSuffix", v)}
          />
          <ToggleRow
            label="Show bus number"
            checked={settings.showRouteName}
            onChange={(v) => onUpdateSetting("showRouteName", v)}
          />
          <ToggleRow
            label="Show stops away"
            checked={settings.showStopsAway}
            onChange={(v) => onUpdateSetting("showStopsAway", v)}
          />
          <ToggleRow
            label="Show stop title"
            checked={settings.showStopTitle}
            onChange={(v) => onUpdateSetting("showStopTitle", v)}
          />
          <ToggleRow
            label="Dark mode"
            checked={settings.darkMode}
            onChange={(v) => onUpdateSetting("darkMode", v)}
          />
        </div>

        <div>
          <form
            data-tutorial="stop-input"
            className="settings-panel__form"
            onSubmit={(e) => {
              e.preventDefault();
              handleGo();
            }}
          >
            <div className="settings-panel__input-wrap">
              <input
                className={`settings-panel__input${isInputShaking ? " settings-panel__input--shake" : ""}`}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="Bus stop code"
                value={stopCode}
                onChange={(e) => {
                  setStopCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  if (scanError) setScanError("");
                }}
                onFocus={() => {
                  setHasFocusedStopInput(true);
                }}
              />
              {canUseQrScan && (
                <button
                  className="settings-panel__scan-btn"
                  type="button"
                  onClick={() => {
                    setScannerOpen(true);
                    setScanError("");
                  }}
                  aria-label="Scan QR code"
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
              )}
            </div>
            <button
              className={`settings-panel__go${tutorialHighlightsStopInput ? " settings-panel__go--tutorial-active" : ""}`}
              type="submit"
              disabled={!canGo || isValidatingStop}
            >
              {isValidatingStop ? "Checking..." : "Go"}
            </button>
          </form>
          {showStopHelp && (
            <div className="settings-stop-help">
              <span className="settings-stop-help__text">
                Find this 6-digit code at your bus stop.
              </span>
              <a
                className="settings-stop-help__link"
                href="https://bustime.mta.info"
                target="_blank"
                rel="noopener noreferrer"
              >
                Learn where to find it
              </a>
            </div>
          )}
          {scanError && (
            <p className="settings-panel__scan-error">{scanError}</p>
          )}
        </div>
      </div>

      {scannerOpen &&
        createPortal(
          <Suspense fallback={null}>
            <QrScanner
              onScan={handleScan}
              onClose={() => setScannerOpen(false)}
              onError={handleScanError}
            />
          </Suspense>,
          document.body,
        )}
    </div>
  );
}
