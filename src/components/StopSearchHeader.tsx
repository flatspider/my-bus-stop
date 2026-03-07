import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import StopTitleButton from "./StopTitleButton";

interface StopSearchHeaderProps {
  stopName: string;
  showStopTitle: boolean;
  statusNode: ReactNode;
  onSelectStop: (code: string) => void;
  onExpandedChange?: (isExpanded: boolean) => void;
}

const StopSearchPanel = lazy(() => import("./StopSearchPanel"));

export default function StopSearchHeader({
  stopName,
  showStopTitle,
  statusNode,
  onSelectStop,
  onExpandedChange,
}: StopSearchHeaderProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const shouldRestoreFocusRef = useRef(false);

  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  useEffect(() => {
    if (!isExpanded && shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded) return;

    function onPointerDown(event: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        shouldRestoreFocusRef.current = true;
        setIsExpanded(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      shouldRestoreFocusRef.current = true;
      setIsExpanded(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isExpanded]);

  function handleOpenSearch() {
    setIsExpanded(true);
  }

  function closeSearch() {
    shouldRestoreFocusRef.current = true;
    setIsExpanded(false);
  }

  return (
    <div
      className={`stop-search${!showStopTitle ? " stop-search--icon-only" : ""}`}
      ref={wrapperRef}
    >
      {!isExpanded ? (
        <StopTitleButton
          stopName={stopName}
          showStopTitle={showStopTitle}
          statusNode={statusNode}
          onOpenSearch={handleOpenSearch}
          ref={triggerRef}
        />
      ) : (
        <Suspense
          fallback={
            <div className="stop-search__input-shell">
              <input
                className="stop-search__input"
                type="text"
                placeholder="Search stop or street"
                aria-label="Search stop or street"
                disabled
              />
              <button
                type="button"
                className="stop-search__close-inline"
                onClick={closeSearch}
                aria-label="Close stop search"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          }
        >
          <StopSearchPanel onClose={closeSearch} onSelectStop={onSelectStop} />
        </Suspense>
      )}
    </div>
  );
}
