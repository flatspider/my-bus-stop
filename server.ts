import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./server/config.ts";
import { fetchSiri } from "./server/parseSiri.ts";
import { fetchGtfsRtForStop, fetchGtfsRtTripSummaries, fetchVehiclePositions } from "./server/parseGtfsRt.ts";
import { compareAndLog } from "./server/compare.ts";

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

    if (config.mode === "compare") {
      (async () => {
        try {
          const routeNames = siriData.routes.map((r) => r.route);
          const [stopArrivals, tripSummaries, vehiclePositions] = await Promise.all([
            fetchGtfsRtForStop(stopCode),
            fetchGtfsRtTripSummaries(routeNames),
            fetchVehiclePositions(),
          ]);
          await compareAndLog(stopCode, siriData, stopArrivals, tripSummaries, vehiclePositions);
        } catch (err) {
          console.error("Comparison error:", err);
        }
      })();
    }
  } catch (err) {
    console.error("Request error:", err);
    res.status(502).send("Failed to fetch bus data");
  }
});

// Serve static files from dist/
app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback — serve index.html for client-side routes
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
