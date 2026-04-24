import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchNearbyStops, searchStops } from "../stopSearchApi";
import { formatStopName } from "../formatStopName";
import { saveRecents, useRecents } from "../recentStopsStore";
import type { StopSearchResult } from "../types";

const SEARCH_LIMIT = 5;
const NEARBY_LIMIT = 10;
const MAX_VISIBLE_RESULTS = 10;

interface StopSearchPanelProps {
  onClose: () => void;
  onSelectStop: (code: string) => void;
}

interface GeoState {
  lat: number;
  lon: number;
}

type LocationState =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "unavailable";

function formatDistance(distanceMeters: number | undefined): string {
  if (distanceMeters === undefined) return "";

  const miles = distanceMeters / 1609.344;
  if (miles >= 0.95) {
    return `${miles.toFixed(1)} mi`;
  }

  return `${Math.max(0.05, miles).toFixed(2)} mi`;
}

function dedupeResults(
  primary: StopSearchResult[],
  secondary: StopSearchResult[],
): StopSearchResult[] {
  const seen = new Set(primary.map((item) => item.code));
  const merged = [...primary];
  for (const item of secondary) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    merged.push(item);
  }
  return merged;
}

function extractDirectionLabel(raw: string): string | null {
  const text = raw.toUpperCase();
  if (text.includes("NORTHBOUND") || /\bNB\b/.test(text)) return "Northbound";
  if (text.includes("SOUTHBOUND") || /\bSB\b/.test(text)) return "Southbound";
  if (text.includes("EASTBOUND") || /\bEB\b/.test(text)) return "Eastbound";
  if (text.includes("WESTBOUND") || /\bWB\b/.test(text)) return "Westbound";
  if (text.includes("UPTOWN")) return "Uptown";
  if (text.includes("DOWNTOWN")) return "Downtown";
  return null;
}

function displayDirection(item: StopSearchResult): string | null {
  const direction = item.directionLabel ?? extractDirectionLabel(item.name);
  if (!direction || direction === "Unknown direction") return null;
  return direction;
}

export default function StopSearchPanel({
  onClose,
  onSelectStop,
}: StopSearchPanelProps) {
  const supportsGeolocation =
    typeof navigator !== "undefined" && "geolocation" in navigator;
  const [query, setQuery] = useState("");
  const [geo, setGeo] = useState<GeoState | null>(null);
  const [locationState, setLocationState] = useState<LocationState>(
    supportsGeolocation ? "idle" : "unavailable",
  );
  const [nearestStops, setNearestStops] = useState<StopSearchResult[]>([]);
  const [searchResults, setSearchResults] = useState<StopSearchResult[]>([]);
  const [statusMessage, setStatusMessage] = useState("");

  const recents = useRecents();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const nearbyAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      nearbyAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!geo) return;

    nearbyAbortRef.current?.abort();
    const controller = new AbortController();
    nearbyAbortRef.current = controller;

    void fetchNearbyStops(geo.lat, geo.lon, {
      limit: NEARBY_LIMIT,
      signal: controller.signal,
    })
      .then((results) => {
        setNearestStops(results);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatusMessage("Unable to load nearby stops right now.");
      });

    return () => controller.abort();
  }, [geo]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    searchAbortRef.current?.abort();

    if (!normalizedQuery) return;

    const controller = new AbortController();
    searchAbortRef.current = controller;

    const timer = window.setTimeout(() => {
      void searchStops(normalizedQuery, {
        lat: geo?.lat,
        lon: geo?.lon,
        limit: SEARCH_LIMIT,
        signal: controller.signal,
      })
        .then((results) => {
          setSearchResults(results);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setStatusMessage("Search unavailable right now.");
        });
    }, 100);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [geo?.lat, geo?.lon, query]);

  const dropdownResults = useMemo(() => {
    const normalizedQuery = query.trim();
    if (normalizedQuery) return searchResults.slice(0, MAX_VISIBLE_RESULTS);
    return dedupeResults(nearestStops, recents).slice(0, MAX_VISIBLE_RESULTS);
  }, [nearestStops, query, recents, searchResults]);
  const liveStatusMessage = useMemo(() => {
    if (statusMessage) return statusMessage;
    if (query.trim()) {
      if (dropdownResults.length === 0) return `No stop results for ${query.trim()}.`;
      return `${dropdownResults.length} stop result${dropdownResults.length === 1 ? "" : "s"} available.`;
    }
    if (nearestStops.length > 0) {
      return `${nearestStops.length} nearby stop${nearestStops.length === 1 ? "" : "s"} available.`;
    }
    if (recents.length > 0) {
      return `${recents.length} recent stop${recents.length === 1 ? "" : "s"} available.`;
    }
    return "";
  }, [dropdownResults.length, nearestStops.length, query, recents.length, statusMessage]);

  function handleSelect(stop: StopSearchResult) {
    saveRecents([
      stop,
      ...recents.filter((entry) => entry.code !== stop.code),
    ]);

    onSelectStop(stop.code);
    onClose();
  }

  function requestLocationManually() {
    if (!supportsGeolocation) {
      setLocationState("unavailable");
      setStatusMessage("Location unavailable on this device.");
      return;
    }

    setLocationState("requesting");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeo({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        });
        setLocationState("granted");
        setStatusMessage("");
      },
      () => {
        setLocationState("denied");
        setStatusMessage("Location not enabled. You can still search any stop.");
      },
      {
        enableHighAccuracy: false,
        maximumAge: 120_000,
        timeout: 10_000,
      },
    );
  }

  return (
    <>
      <div className="stop-search__input-shell">
        <input
          ref={inputRef}
          className="stop-search__input"
          type="text"
          placeholder="Search stop or street"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search stop or street"
          aria-describedby={statusId}
          aria-autocomplete="list"
        />
        <button
          type="button"
          className="stop-search__close-inline"
          onClick={onClose}
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

      <div
        className="stop-search__dropdown"
        aria-label="Stop search results"
      >
        {!query.trim() && locationState !== "granted" && (
          <button
            type="button"
            className="stop-search__location-cta"
            onClick={requestLocationManually}
            disabled={locationState === "requesting"}
          >
            <span className="stop-search__location-cta-icon" aria-hidden="true">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2v4" />
                <path d="M12 18v4" />
                <path d="M2 12h4" />
                <path d="M18 12h4" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            </span>
            <span className="stop-search__location-cta-copy">
              <span className="stop-search__location-cta-label">
                {locationState === "requesting" ? "Locating..." : "Use my location"}
              </span>
              <span className="stop-search__location-cta-meta">
                Find the nearest stop automatically
              </span>
            </span>
          </button>
        )}

        {!query.trim() && nearestStops.length > 0 && (
          <div className="stop-search__section">
            <p className="stop-search__section-label">Nearest</p>
            {nearestStops.map((item) => (
              <button
                type="button"
                className="stop-search__result"
                key={`near-${item.code}`}
                onClick={() => handleSelect(item)}
              >
                <span className="stop-search__result-main">
                  <span className="stop-search__result-line">
                    <span className="stop-search__result-name">
                      {formatStopName(item.name)}
                    </span>
                    {displayDirection(item) && (
                      <span className="stop-search__result-direction">
                        {displayDirection(item)}
                      </span>
                    )}
                  </span>
                </span>
                <span className="stop-search__result-meta">
                  {formatDistance(item.distanceMeters)}
                </span>
              </button>
            ))}
          </div>
        )}

        {!query.trim() && recents.length > 0 && (
          <div className="stop-search__section">
            <p className="stop-search__section-label">Recent</p>
            {recents.map((item) => (
              <button
                type="button"
                className="stop-search__result"
                key={`recent-${item.code}`}
                onClick={() => handleSelect(item)}
              >
                <span className="stop-search__result-main">
                  <span className="stop-search__result-line">
                    <span className="stop-search__result-name">
                      {formatStopName(item.name)}
                    </span>
                    {displayDirection(item) && (
                      <span className="stop-search__result-direction">
                        {displayDirection(item)}
                      </span>
                    )}
                  </span>
                </span>
                <span className="stop-search__result-meta" />
              </button>
            ))}
          </div>
        )}

        {query.trim() && dropdownResults.length > 0 && (
          <div className="stop-search__section">
            {dropdownResults.map((item) => (
              <button
                type="button"
                className="stop-search__result"
                key={`search-${item.code}`}
                onClick={() => handleSelect(item)}
              >
                <span className="stop-search__result-main">
                  <span className="stop-search__result-line">
                    <span className="stop-search__result-name">
                      {formatStopName(item.name)}
                    </span>
                    {displayDirection(item) && (
                      <span className="stop-search__result-direction">
                        {displayDirection(item)}
                      </span>
                    )}
                  </span>
                </span>
                <span className="stop-search__result-meta">
                  {item.distanceMeters !== undefined
                    ? formatDistance(item.distanceMeters)
                    : ""}
                </span>
              </button>
            ))}
          </div>
        )}

        {query.trim() && dropdownResults.length === 0 && (
          <p className="stop-search__empty">No stops found.</p>
        )}

        {!query.trim() &&
          nearestStops.length === 0 &&
          recents.length === 0 &&
          locationState === "granted" && (
            <p className="stop-search__empty">No nearby stops found.</p>
          )}

        {statusMessage && <p className="stop-search__status">{statusMessage}</p>}
        {!statusMessage && locationState === "unavailable" && (
          <p className="stop-search__status">
            Location unavailable on this device.
          </p>
        )}
      </div>
      <p className="sr-only" id={statusId} role="status" aria-live="polite">
        {liveStatusMessage}
      </p>
    </>
  );
}
