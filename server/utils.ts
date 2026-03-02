export function normalizeVehicleId(id: string): string {
  const underscoreIdx = id.lastIndexOf("_")
  if (underscoreIdx !== -1) return id.slice(underscoreIdx + 1)
  const spaceIdx = id.lastIndexOf(" ")
  if (spaceIdx !== -1) return id.slice(spaceIdx + 1)
  return id
}
