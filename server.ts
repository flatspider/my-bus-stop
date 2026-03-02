import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./server/config.ts";
import { parseHtml } from "./server/parseHtml.ts";
import { fetchSiri } from "./server/parseSiri.ts";
import { compareAndLog } from "./server/compare.ts";

const app = express();
const PORT = process.env.PORT || 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(`BusWatch mode: ${config.mode}`);

// Proxy /api/bustime to MTA bustime
app.get("/api/bustime", async (req, res) => {
  const query = req.query.q;
  if (!query) {
    res.status(400).send("Missing q parameter");
    return;
  }

  const stopCode = String(query);

  try {
    if (config.mode === "api") {
      // SIRI only — return JSON directly
      const siriData = await fetchSiri(stopCode);
      res.set("Content-Type", "application/json");
      res.json(siriData);
      return;
    }

    // Scrape HTML (used in both "scrape" and "compare" modes)
    const url = `https://bustime.mta.info/m/?q=${encodeURIComponent(stopCode)}`;
    const response = await fetch(url);
    const html = await response.text();

    if (config.mode === "compare") {
      // Fire-and-forget: fetch SIRI, compare, log — don't block the response
      (async () => {
        try {
          const htmlData = parseHtml(html);
          const siriData = await fetchSiri(stopCode);
          await compareAndLog(stopCode, htmlData, siriData);
        } catch (err) {
          console.error("Comparison error:", err);
        }
      })();
    }

    // Return HTML to client (same as before)
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
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
