## Bus Watch

This is an app that monitors a single bus stop in Manhattan.

If you want to see your bus stop, input the Bus Stop Number in the bottom of the page to view your own simplified update page.

## Stop search index

Header stop search uses a server-side JSON index (`data/stops-index.json`) loaded into memory at server startup.

Rebuild the index from GTFS `stops.txt`:

```bash
bun run data:build-stop-index -- /path/to/stops.txt
```

Suggested daily refresh (example cron at 2:10 AM local time):

```cron
10 2 * * * cd /path/to/buswatch && bun run data:build-stop-index -- /path/to/stops.txt
```
