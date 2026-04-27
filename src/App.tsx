import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  StaticRouter,
} from "react-router-dom";
import StopPage from "./StopPage";
import UnhappyPage from "./UnhappyPage";
import { getLastStopCode } from "./recentStopsStore";
import type { InitialStopData } from "./initialStopData";
import { useSettings } from "./useSettings";

interface AppProps {
  initialStopData?: InitialStopData | null;
  location?: string;
}

function AppRoutes({
  initialStopData,
}: {
  initialStopData?: InitialStopData | null;
}) {
  return (
    <Routes>
      <Route
        path="/"
        element={<Navigate to={`/stop/${getLastStopCode()}`} replace />}
      />
      <Route path="/unhappy" element={<UnhappyPage />} />
      <Route
        path="/stop/:stopCode"
        element={<StopPage initialData={initialStopData ?? null} />}
      />
    </Routes>
  );
}

const FEEDBACK_FORM_URL = "https://forms.gle/2d4VscFjUocr7RE18";

function FeedbackCard() {
  const [collapsed, setCollapsed] = useState(true);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // Slide in after a brief delay
    const enterTimer = setTimeout(() => setEntered(true), 400);
    return () => clearTimeout(enterTimer);
  }, []);

  // Expand/collapse based on tutorial feedback step events
  useEffect(() => {
    function handleExpand() {
      setCollapsed(false);
    }
    function handleCollapse() {
      setCollapsed(true);
    }
    window.addEventListener("tutorial-feedback-step", handleExpand);
    window.addEventListener("tutorial-feedback-done", handleCollapse);
    return () => {
      window.removeEventListener("tutorial-feedback-step", handleExpand);
      window.removeEventListener("tutorial-feedback-done", handleCollapse);
    };
  }, []);

  return (
    <div
      data-tutorial="feedback"
      className={`feedback-card ${entered ? "feedback-card--entered" : ""} ${collapsed ? "feedback-card--collapsed" : ""}`}
    >
      {/* Collapsed tab with + icon */}
      <button
        type="button"
        className="feedback-card__tab"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Show feedback card" : "Hide feedback card"}
      >
        <svg width="25" height="25" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          {collapsed ? (
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          ) : (
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          )}
        </svg>
      </button>

      {/* The card itself */}
      <a
        href={FEEDBACK_FORM_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="feedback-card__body"
        aria-label="Send feedback"
        onClick={() => setCollapsed(true)}
      >
        <div className="feedback-card__accent" />
        <div className="feedback-card__content">
          <svg
            className="feedback-card__icon"
            width="25"
            height="25"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 3a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6l-4 4V3Z"
              fill="currentColor"
            />
          </svg>
          <span className="feedback-card__label">Feedback</span>
        </div>
      </a>
    </div>
  );
}

function FeedbackCardWrapper() {
  const { settings } = useSettings();
  if (!settings.showFeedback) return null;
  return <FeedbackCard />;
}

export default function App({ initialStopData = null, location }: AppProps) {
  if (location) {
    return (
      <StaticRouter location={location}>
        <AppRoutes initialStopData={initialStopData} />
      </StaticRouter>
    );
  }

  return (
    <BrowserRouter>
      <AppRoutes initialStopData={initialStopData} />
      <FeedbackCardWrapper />
    </BrowserRouter>
  );
}
