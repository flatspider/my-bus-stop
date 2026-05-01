export function shouldForceLeadCardNow(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("leadNow") === "1";
}

export function shouldUseFilmCursor(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("filmCursor") === "1";
}

export function buildFilmCursorSearch(search: string): string {
  return shouldUseFilmCursor(search) ? "?filmCursor=1" : "";
}
