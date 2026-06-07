import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = process.env.CLIENT_DIR ?? join(__dirname, "..", "client");
const PORT = process.env.PORT ?? 3000;

const app = express();

app.use(express.static(CLIENT_DIR));

app.get("/proxy", async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).json({ error: "Missing url parameter" });

    let url;
    try {
        url = new URL(raw);
    } catch {
        return res.status(400).json({ error: "Invalid URL" });
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return res.status(400).json({ error: "Only http/https URLs are allowed" });
    }

    try {
        const upstream = await fetch(url.toString(), {
            signal: AbortSignal.timeout(10000),
            headers: {
                "User-Agent": "RSS-Dashboard/1.0 (feed aggregator)",
                "Accept": "application/rss+xml, application/atom+xml, text/xml, */*",
            },
        });

        if (!upstream.ok) {
            return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
        }

        const contents = await upstream.text();
        res.json({ contents });
    } catch (err) {
        const msg = err.name === "TimeoutError" ? "Request timed out" : err.message;
        res.status(502).json({ error: msg });
    }
});

app.listen(PORT, () => {
    console.log(`RSS Dashboard running at http://localhost:${PORT}`);
});
