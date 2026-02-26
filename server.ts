import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Proxy /api/bustime to MTA bustime
app.get("/api/bustime", async (req, res) => {
  const query = req.query.q;
  if (!query) {
    res.status(400).send("Missing q parameter");
    return;
  }

  const url = `https://bustime.mta.info/m/?q=${encodeURIComponent(String(query))}`;
  const response = await fetch(url);
  const html = await response.text();
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html);
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
