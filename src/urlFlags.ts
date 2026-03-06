export function shouldForceLeadCardNow(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("leadNow") === "1";
}
