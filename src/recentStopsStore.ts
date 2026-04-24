import { useSyncExternalStore } from "react";
import { DEFAULT_STOP_CODE, STOP_CODE_PATTERN } from "./stopConfig";
import type { StopSearchResult } from "./types";

const RECENT_STOPS_KEY = "buswatch-stop-search-recents";
const RECENTS_EVENT = "buswatch-stop-search-recents-change";

let cachedRecentsRaw: string | null | undefined;
let cachedRecentsSnapshot: StopSearchResult[] = [];

export function loadRecents(): StopSearchResult[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(RECENT_STOPS_KEY);
    if (raw === cachedRecentsRaw) return cachedRecentsSnapshot;
    if (!raw) {
      cachedRecentsRaw = null;
      cachedRecentsSnapshot = [];
      return cachedRecentsSnapshot;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      cachedRecentsRaw = raw;
      cachedRecentsSnapshot = [];
      return cachedRecentsSnapshot;
    }

    cachedRecentsRaw = raw;
    cachedRecentsSnapshot = parsed
      .filter((item): item is StopSearchResult => {
        if (!item || typeof item !== "object") return false;
        const maybe = item as Partial<StopSearchResult>;
        return typeof maybe.code === "string" && typeof maybe.name === "string";
      })
      .slice(0, 3);
    return cachedRecentsSnapshot;
  } catch {
    cachedRecentsRaw = null;
    cachedRecentsSnapshot = [];
    return cachedRecentsSnapshot;
  }
}

export function saveRecents(recents: StopSearchResult[]): void {
  if (typeof window === "undefined") return;
  const nextRecents = recents.slice(0, 3);
  const raw = JSON.stringify(nextRecents);
  cachedRecentsRaw = raw;
  cachedRecentsSnapshot = nextRecents;
  localStorage.setItem(RECENT_STOPS_KEY, raw);
  window.dispatchEvent(new Event(RECENTS_EVENT));
}

function subscribeToRecents(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key !== RECENT_STOPS_KEY) return;
    onStoreChange();
  };
  const handleCustomEvent = () => onStoreChange();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(RECENTS_EVENT, handleCustomEvent);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(RECENTS_EVENT, handleCustomEvent);
  };
}

export function useRecents(): StopSearchResult[] {
  return useSyncExternalStore(subscribeToRecents, loadRecents, () => []);
}

export function getLastStopCode(): string {
  const recents = loadRecents();
  const code = recents[0]?.code;
  if (code && STOP_CODE_PATTERN.test(code)) return code;
  return DEFAULT_STOP_CODE;
}
