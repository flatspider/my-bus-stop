import { forwardRef } from "react";
import type { ReactNode } from "react";
import { formatStopName } from "../formatStopName";

interface StopTitleButtonProps {
  stopName: string;
  showStopTitle: boolean;
  statusNode: ReactNode;
  onOpenSearch: () => void;
}

function renderStopTitle(raw: string, className: string): ReactNode {
  const formatted = formatStopName(raw);
  const parts = formatted.split(" and ");
  const shouldStackWithAmpersand = parts.length === 2;

  if (!shouldStackWithAmpersand) {
    return <span className={className}>{formatted}</span>;
  }

  return (
    <span className={`${className} ${className}--stacked`}>
      {parts.map((part, index) => (
        <span className={`${className}__part`} key={`${part}-${index}`}>
          {index > 0 ? (
            <span className={`${className}__line`}>
              <span className={`${className}__joiner`} aria-hidden="true">
                &amp;
              </span>
              <span className={`${className}__text`}>{part}</span>
            </span>
          ) : (
            <span className={`${className}__text`}>{part}</span>
          )}
        </span>
      ))}
    </span>
  );
}

const StopTitleButton = forwardRef<HTMLButtonElement, StopTitleButtonProps>(
  function StopTitleButton(
    { stopName, showStopTitle, statusNode, onOpenSearch },
    ref,
  ) {
    return (
      <button
        type="button"
        className={`stop-search__trigger${!showStopTitle ? " stop-search__trigger--icon-only" : ""}`}
        onClick={onOpenSearch}
        aria-label="Search for a bus stop"
        data-tutorial="default-stop"
        ref={ref}
      >
        <>
          {showStopTitle && statusNode}
          {showStopTitle && stopName && (
            <span className="stop-search__title-wrap">
              <span className="stop-search__title-block">
                <span className="stop-search__title-accent" aria-hidden="true" />
                {renderStopTitle(stopName, "stop-name")}
              </span>
            </span>
          )}
          {showStopTitle && !stopName && (
            <span className="stop-search__fallback">
              <span className="stop-search__title-block">
                <span className="stop-search__title-accent" aria-hidden="true" />
                Search stop
              </span>
            </span>
          )}
          {!showStopTitle && (
            <span className="stop-search__icon-only">
              {statusNode}
              <svg
                className="stop-search__icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
          )}
        </>
        {showStopTitle && (
          <svg
            className="stop-search__chevron"
            width="8"
            height="16"
            viewBox="0 0 8 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M1.5 1.5l5 6.5-5 6.5" />
          </svg>
        )}
      </button>
    );
  },
);

export default StopTitleButton;
