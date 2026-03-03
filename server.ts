import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./server/config.ts";
import { fetchSiri } from "./server/parseSiri.ts";
import { fetchGtfsRtForStop, fetchGtfsRtTripSummaries, fetchVehiclePositions } from "./server/parseGtfsRt.ts";
import { compareAndLog, JSONL_PATH } from "./server/compare.ts";
import { readFile } from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(`BusWatch mode: ${config.mode}`);

app.get("/api/bustime", async (req, res) => {
  if (!config.apiKey) {
    res.status(503).json({ error: "Server is not configured with an API key" });
    return;
  }

  const query = req.query.q;
  if (!query) {
    res.status(400).send("Missing q parameter");
    return;
  }

  const stopCode = String(query);

  try {
    const siriData = await fetchSiri(stopCode);
    res.json(siriData);
  } catch (err) {
    console.error("Request error:", err);
    res.status(502).send("Failed to fetch bus data");
  }
});

// --- Snapshots API ---
app.get("/api/snapshots", async (_req, res) => {
  try {
    const raw = await readFile(JSONL_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const snapshots = lines.map((line) => JSON.parse(line));
    res.json(snapshots);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      res.json([]);
    } else {
      console.error("Error reading snapshots:", err);
      res.status(500).json({ error: "Failed to read snapshots" });
    }
  }
});

// Serve static files from dist/
app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback — serve index.html for client-side routes
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// --- Background Polling ---
const POLL_STOP = "402854";
const POLL_INTERVAL_MS = 60_000; // 1 minute

async function pollOnce() {
  if (!config.apiKey) return;

  try {
    const siriData = await fetchSiri(POLL_STOP);
    const routeNames = siriData.routes.map((r) => r.route);
    const [stopArrivals, tripSummaries, vehiclePositions] = await Promise.all([
      fetchGtfsRtForStop(POLL_STOP),
      fetchGtfsRtTripSummaries(routeNames),
      fetchVehiclePositions(),
    ]);
    await compareAndLog(POLL_STOP, siriData, stopArrivals, tripSummaries, vehiclePositions);
    console.log(`[poll] Snapshot logged at ${new Date().toISOString()}`);
  } catch (err) {
    console.error("[poll] Error:", err);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  if (config.mode === "compare") {
    console.log(`[poll] Starting background polling every ${POLL_INTERVAL_MS / 1000}s for stop ${POLL_STOP}`);
    pollOnce(); // immediate first poll
    setInterval(pollOnce, POLL_INTERVAL_MS);
  }
});
