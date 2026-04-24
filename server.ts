import express from "express";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { config } from "./server/config.ts";
import { fetchSiri } from "./server/parseSiri.ts";
import { fetchGtfsRtForStop, fetchVehiclePositions } from "./server/parseGtfsRt.ts";
import { compareAndLog, CORRIDOR_JSONL_PATH, JSONL_PATH, logCorridorSnapshot } from "./server/compare.ts";
import { readFile } from "node:fs/promises";
import { computeUnhappiestStop, loadGapIndex } from "./server/unhappy.ts";
import { getAllStops, getStopByCode, getStopsIndexCount, loadStopsIndex, nearbyStops, searchStops, searchStopsWithDebug, stopCodeExists } from "./server/stopsIndex.ts";
import { DEFAULT_STOP_CODE, STOP_CODE_PATTERN } from "./src/stopConfig.ts";
import type { InitialStopData } from "./src/initialStopData.ts";
import { applyMetadataToHtmlDocument, buildNotFoundMetadata, buildStopMetadata, buildUnhappyMetadata, type PageMetadata } from "./server/seo.ts";

const app = express();
const PORT = process.env.PORT || 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const DIST_DIR = path.join(__dirname, "dist");
const CLIENT_INDEX_PATH = path.join(DIST_DIR, "index.html");
const CLIENT_MANIFEST_PATH = path.join(DIST_DIR, ".vite", "manifest.json");
const SERVER_ENTRY_PATH = path.join(DIST_DIR, "server", "entry-server.js");
const SSR_UPSTREAM_BUDGET_MS = 350;

console.log(`BusWatch mode: ${config.mode}`);

interface ViteManifestEntry {
  file: string;
  css?: string[];
}

interface RenderServerModule {
  render: (url: string, initialStopData: InitialStopData | null) => string;
}

let cachedHtmlTemplate: string | null = null;
let cachedClientEntry: ViteManifestEntry | null = null;
let cachedRenderModule: RenderServerModule | null = null;

function serializeBootstrap(initialStopData: InitialStopData | null): string {
  return JSON.stringify(initialStopData).replace(/</g, "\\u003c");
}

async function loadClientTemplate(): Promise<string> {
  if (cachedHtmlTemplate) return cachedHtmlTemplate;
  cachedHtmlTemplate = await readFile(CLIENT_INDEX_PATH, "utf-8");
  return cachedHtmlTemplate;
}

async function loadClientEntry(): Promise<ViteManifestEntry> {
  if (cachedClientEntry) return cachedClientEntry;

  const raw = await readFile(CLIENT_MANIFEST_PATH, "utf-8");
  const manifest = JSON.parse(raw) as Record<string, ViteManifestEntry>;
  const entry = manifest["index.html"];
  if (!entry) {
    throw new Error("Could not find index.html in Vite manifest");
  }

  cachedClientEntry = entry;
  return entry;
}

async function loadRenderModule(): Promise<RenderServerModule> {
  if (cachedRenderModule) return cachedRenderModule;

  const moduleUrl = `${pathToFileURL(SERVER_ENTRY_PATH).href}?t=${Date.now()}`;
  const imported = await import(moduleUrl) as RenderServerModule;
  cachedRenderModule = imported;
  return imported;
}

async function buildSsrDocument(
  url: string,
  initialStopData: InitialStopData | null,
  metadata: PageMetadata,
): Promise<string> {
  const [template, entry, renderModule] = await Promise.all([
    loadClientTemplate(),
    loadClientEntry(),
    loadRenderModule(),
  ]);

  const appHtml = renderModule.render(url, initialStopData);
  const cssLinks = (entry.css ?? [])
    .map((href) => `    <link rel="stylesheet" crossorigin href="/${href}">`)
    .join("\n");
  const bootstrapScript = [
    "    <script>",
    `      window.__BUSWATCH_INITIAL_DATA__ = ${serializeBootstrap(initialStopData)};`,
    "    </script>",
  ].join("\n");

  let html = template;
  html = html.replace(
    /<link rel="stylesheet" crossorigin href="\/assets\/[^"]+">/,
    cssLinks || "",
  );
  html = html.replace(
    /<script type="module" crossorigin src="\/assets\/[^"]+"><\/script>/,
    `${bootstrapScript}\n    <script type="module" crossorigin src="/${entry.file}"></script>`,
  );
  html = html.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`);
  return applyMetadataToHtmlDocument(html, metadata);
}

async function buildPlainDocument(
  bodyHtml: string,
  metadata: PageMetadata,
): Promise<string> {
  const template = await loadClientTemplate();
  let html = template;
  html = html.replace(
    /<link rel="stylesheet" crossorigin href="\/assets\/[^"]+">/,
    "",
  );
  html = html.replace(
    /<script type="module" crossorigin src="\/assets\/[^"]+"><\/script>/,
    "",
  );
  html = html.replace('<div id="root"></div>', `<main style="padding:24px;font-family:system-ui,sans-serif">${bodyHtml}</main>`);
  return applyMetadataToHtmlDocument(html, metadata);
}

async function fetchInitialStopData(stopCode: string): Promise<InitialStopData> {
  const indexedStopName = getStopByCode(stopCode)?.name ?? "";

  const shellData: InitialStopData = {
    stopCode,
    stopName: indexedStopName,
    routes: [],
    fetchedAt: 0,
    error: null,
    isPartial: true,
  };

  try {
    const data = await Promise.race([
      fetchSiri(stopCode),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("SSR_BUSTIME_TIMEOUT")), SSR_UPSTREAM_BUDGET_MS);
      }),
    ]);

    return {
      stopCode,
      stopName: data.stopName || indexedStopName,
      routes: data.routes,
      fetchedAt: Date.now(),
      error: null,
      isPartial: false,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "SSR_BUSTIME_TIMEOUT") {
      console.warn(
        `[ssr] Bustime fetch for ${stopCode} exceeded ${SSR_UPSTREAM_BUDGET_MS}ms; rendering stop shell.`,
      );
      return shellData;
    }

    console.error("[ssr] Failed to fetch stop data:", err);
    return shellData;
  }
}

function parseNumberParam(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const limit = Number.parseInt(raw, 10);
  if (Number.isNaN(limit)) return undefined;
  return limit;
}

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

app.get("/api/stops/nearby", (req, res) => {
  const lat = parseNumberParam(req.query.lat);
  const lon = parseNumberParam(req.query.lon);
  if (lat === null || lon === null) {
    res.status(400).json({ error: "Missing or invalid lat/lon parameters" });
    return;
  }

  const radius = parseNumberParam(req.query.radius) ?? undefined;
  const limit = parseLimit(req.query.limit);
  const results = nearbyStops(lat, lon, { radius, limit });

  res.setHeader("Cache-Control", "public, max-age=30");
  res.json(results);
});

app.get("/api/stops/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "Missing q parameter" });
    return;
  }

  const lat = parseNumberParam(req.query.lat) ?? undefined;
  const lon = parseNumberParam(req.query.lon) ?? undefined;
  const limit = parseLimit(req.query.limit);
  const recentCodes = typeof req.query.recents === "string"
    ? req.query.recents
      .split(",")
      .map((code) => code.trim())
      .filter((code) => /^\d{6}$/.test(code))
    : undefined;
  const debug = !isProduction && (req.query.debug === "1" || req.query.debug === "true");

  if (debug) {
    const payload = searchStopsWithDebug(q, { lat, lon, limit, recentCodes });
    res.setHeader("Cache-Control", "no-store");
    res.json(payload);
    return;
  }

  const results = searchStops(q, { lat, lon, limit, recentCodes });

  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(results);
});

app.get("/api/stops/exists", (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Missing or invalid code parameter" });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ exists: stopCodeExists(code) });
});

app.get("/", async (req, res, next) => {
  if (!isProduction) {
    next();
    return;
  }

  try {
    const html = await buildSsrDocument(req.originalUrl, null, buildStopMetadata(config.siteUrl, req.originalUrl, getStopByCode(DEFAULT_STOP_CODE)!));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(html);
  } catch (err) {
    console.error("[ssr] Root page render failed:", err);
    next(err);
  }
});

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(`User-agent: *\nAllow: /\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (_req, res) => {
  const urls = [
    config.siteUrl,
    `${config.siteUrl}/unhappy`,
    ...getAllStops().map((stop) => `${config.siteUrl}/stop/${stop.code}`),
  ];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${url}</loc></url>`),
    "</urlset>",
  ].join("\n");

  res.type("application/xml");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(xml);
});

app.get("/unhappy", async (req, res, next) => {
  if (!isProduction) {
    next();
    return;
  }

  try {
    const html = await buildSsrDocument(
      req.originalUrl,
      null,
      buildUnhappyMetadata(config.siteUrl, req.originalUrl),
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(html);
  } catch (err) {
    console.error("[ssr] Unhappy page render failed:", err);
    next(err);
  }
});

app.get("/stop/:stopCode", async (req, res, next) => {
  if (!isProduction) {
    next();
    return;
  }

  const stopCode = typeof req.params.stopCode === "string"
    ? req.params.stopCode.trim()
    : "";

  if (!STOP_CODE_PATTERN.test(stopCode)) {
    res.redirect(302, `/stop/${DEFAULT_STOP_CODE}`);
    return;
  }

  const indexedStop = getStopByCode(stopCode);
  if (!indexedStop) {
    const html = await buildPlainDocument(
      `<h1>Stop not found</h1><p>We couldn&apos;t find stop ${stopCode}.</p>`,
      buildNotFoundMetadata(config.siteUrl, req.originalUrl),
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(404).send(html);
    return;
  }

  try {
    const initialStopData = await fetchInitialStopData(stopCode);
    const html = await buildSsrDocument(
      req.originalUrl,
      initialStopData,
      buildStopMetadata(config.siteUrl, req.originalUrl, indexedStop),
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(initialStopData.error ? 502 : 200).send(html);
  } catch (err) {
    console.error("[ssr] Document render failed:", err);
    next(err);
  }
});

app.get("/api/unhappy", async (_req, res) => {
  try {
    const result = await computeUnhappiestStop();
    if (!result) {
      res.status(404).json({ error: "No active unhappy stop found" });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error("[unhappy] Error:", err);
    res.status(500).json({ error: "Failed to compute unhappiest stop" });
  }
});

if (!isProduction) {
  app.post("/api/stops/reload", async (_req, res) => {
    await loadStopsIndex();
    res.json({ ok: true, count: getStopsIndexCount() });
  });
}

// --- Snapshots API ---
async function readJsonLinesFile(filePath: string): Promise<unknown[]> {
  const raw = await readFile(filePath, "utf-8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

app.get("/api/snapshots", async (_req, res) => {
  try {
    const snapshots = await readJsonLinesFile(JSONL_PATH);
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

app.get("/api/snapshots/download", async (_req, res) => {
  try {
    const snapshots = await readJsonLinesFile(JSONL_PATH);
    const filename = `snapshots-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.json(snapshots);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: "No snapshots file found" });
    } else {
      console.error("Error reading snapshots:", err);
      res.status(500).json({ error: "Failed to read snapshots" });
    }
  }
});

app.get("/api/corridor-snapshots", async (_req, res) => {
  try {
    const snapshots = await readJsonLinesFile(CORRIDOR_JSONL_PATH);
    res.json(snapshots);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      res.json([]);
    } else {
      console.error("Error reading corridor snapshots:", err);
      res.status(500).json({ error: "Failed to read corridor snapshots" });
    }
  }
});

app.get("/api/corridor-snapshots/download", async (_req, res) => {
  try {
    const snapshots = await readJsonLinesFile(CORRIDOR_JSONL_PATH);
    const filename = `corridor-snapshots-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.json(snapshots);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: "No corridor snapshots file found" });
    } else {
      console.error("Error reading corridor snapshots:", err);
      res.status(500).json({ error: "Failed to read corridor snapshots" });
    }
  }
});

// Serve static files from dist/
app.use(express.static(DIST_DIR));

// SPA fallback — serve index.html for client-side routes
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// --- Background Polling ---
// Corridor: stop before → primary stop → stop after (southbound 3rd Ave)
const CORRIDOR = {
  before: "402853",   // E 24 St / Lexington Ave
  primary: "402854",  // 3 Av / E 23 St (Conor's stop)
  after: "403772",    // 3 Av / E 20 St
};
const POLL_INTERVAL_MS = 60_000; // 1 minute
let pollInterval: NodeJS.Timeout | null = null;

async function pollOnce() {
  if (!config.apiKey) return;

  try {
    const snapshotTimestamp = new Date().toISOString()

    // Fetch SIRI for all 3 corridor stops in parallel
    const [siriBefore, siriPrimary, siriAfter] = await Promise.all([
      fetchSiri(CORRIDOR.before),
      fetchSiri(CORRIDOR.primary),
      fetchSiri(CORRIDOR.after),
    ]);

    // GTFS-RT data is route-wide, only need to fetch once using primary stop's routes
    const [primaryArrivals, vehiclePositions] = await Promise.all([
      fetchGtfsRtForStop(CORRIDOR.primary),
      fetchVehiclePositions(),
    ]);

    // Write legacy single-stop snapshot (keeps existing analysis working)
    await compareAndLog(snapshotTimestamp, CORRIDOR.primary, siriPrimary, primaryArrivals, vehiclePositions);

    // Write new corridor snapshot
    await logCorridorSnapshot(
      snapshotTimestamp,
      CORRIDOR,
      [
        { stopCode: CORRIDOR.before, role: "before", data: siriBefore },
        { stopCode: CORRIDOR.primary, role: "primary", data: siriPrimary },
        { stopCode: CORRIDOR.after, role: "after", data: siriAfter },
      ],
      primaryArrivals,
      vehiclePositions,
    );

    console.log(`[poll] Corridor snapshot logged at ${new Date().toISOString()}`);
  } catch (err) {
    console.error("[poll] Error:", err);
  }
}

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  loadStopsIndex()
    .then(() => {
      console.log(`[stops] Search engine: V2-only (${getStopsIndexCount()} indexed stops loaded)`);
    })
    .catch((err) => {
      console.error("[stops] Startup load failed:", err);
    });
  loadGapIndex().catch((err) => {
    console.error("[unhappy] Gap index startup load failed:", err);
  });

  if (config.mode === "compare") {
    console.log(`[poll] Starting corridor polling every ${POLL_INTERVAL_MS / 1000}s — stops ${CORRIDOR.before} → ${CORRIDOR.primary} → ${CORRIDOR.after}`);
    pollOnce(); // immediate first poll
    pollInterval = setInterval(pollOnce, POLL_INTERVAL_MS);
  }
});

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[shutdown] Received ${signal}; stopping server...`);

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  const forceExitTimer = setTimeout(() => {
    console.error("[shutdown] Timed out waiting for server close; forcing exit.");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close((err) => {
    clearTimeout(forceExitTimer);
    if (err) {
      console.error("[shutdown] Error closing server:", err);
      process.exit(1);
      return;
    }
    console.log("[shutdown] Server closed cleanly.");
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
