import type { BusRoute } from "./types";

export interface InitialStopData {
  stopCode: string;
  stopName: string;
  routes: BusRoute[];
  fetchedAt: number;
  error: string | null;
}

declare global {
  interface Window {
    __BUSWATCH_INITIAL_DATA__?: InitialStopData;
  }
}

export function readInitialStopData(): InitialStopData | null {
  const maybeWindow = globalThis as typeof globalThis & {
    window?: Window;
  };

  if (typeof maybeWindow.window === "undefined") return null;
  return maybeWindow.window.__BUSWATCH_INITIAL_DATA__ ?? null;
}

export function hasSsrBootstrap(): boolean {
  const maybeWindow = globalThis as typeof globalThis & {
    window?: Window;
  };

  return Boolean(maybeWindow.window && "__BUSWATCH_INITIAL_DATA__" in maybeWindow.window);
}
