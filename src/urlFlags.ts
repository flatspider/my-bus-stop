export function isMiniMapUrlEnabled(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("mapOn") === "1";
}
