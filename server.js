import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { resolve4, resolve6 } from "dns/promises";
import { BlockList, isIP } from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = process.env.CLIENT_DIR ?? join(__dirname, "..", "client");
const PORT = process.env.PORT ?? 3000;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

const disallowedAddressRanges = new BlockList();
disallowedAddressRanges.addSubnet("0.0.0.0", 8, "ipv4");
disallowedAddressRanges.addSubnet("10.0.0.0", 8, "ipv4");
disallowedAddressRanges.addSubnet("100.64.0.0", 10, "ipv4");
disallowedAddressRanges.addSubnet("127.0.0.0", 8, "ipv4");
disallowedAddressRanges.addSubnet("169.254.0.0", 16, "ipv4");
disallowedAddressRanges.addSubnet("172.16.0.0", 12, "ipv4");
disallowedAddressRanges.addSubnet("192.168.0.0", 16, "ipv4");
disallowedAddressRanges.addSubnet("198.18.0.0", 15, "ipv4");
disallowedAddressRanges.addSubnet("224.0.0.0", 4, "ipv4");
disallowedAddressRanges.addSubnet("240.0.0.0", 4, "ipv4");
disallowedAddressRanges.addSubnet("::", 128, "ipv6");
disallowedAddressRanges.addSubnet("::1", 128, "ipv6");
disallowedAddressRanges.addSubnet("fc00::", 7, "ipv6");
disallowedAddressRanges.addSubnet("fe80::", 10, "ipv6");
disallowedAddressRanges.addSubnet("ff00::", 8, "ipv6");

const app = express();
app.use(express.static(CLIENT_DIR));

// Check if an IP address is in a private/internal range
function isPrivateIP(address) {
    const family = isIP(address);
    if (family === 0) return true;

    return disallowedAddressRanges.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Validate that the hostname resolves to a public IP
async function validateHostname(hostname) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

        try {
            // Try to resolve both IPv4 and IPv6
            const results = await Promise.allSettled([
                resolve4(hostname, { signal: controller.signal }),
                resolve6(hostname, { signal: controller.signal }),
            ]);

            const ips = [];
            results.forEach(result => {
                if (result.status === "fulfilled") {
                    ips.push(...result.value);
                }
            });

            if (ips.length === 0) {
                throw new Error("Hostname could not be resolved");
            }

            // Check if any resolved IP is private
            for (const ip of ips) {
                if (isPrivateIP(ip)) {
                    throw new Error(`Hostname resolves to private IP: ${ip}`);
                }
            }
        } finally {
            clearTimeout(timeout);
        }
    } catch (err) {
        if (err.name === "AbortError") {
            throw new Error("DNS resolution timed out");
        }
        throw new Error(`Invalid hostname: ${err.message}`);
    }
}

// Read response body with size limit
async function readResponseWithLimit(response, maxSize) {
    const contentLength = response.headers.get("content-length");

    // Check Content-Length header if available
    if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (!Number.isInteger(size) || size < 0 || size > maxSize) {
            throw new Error(`Response too large (${size} bytes, max ${maxSize})`);
        }
    }

    // Read the response body with size tracking
    let accumulated = 0;
    const decoder = new TextDecoder();
    let text = "";

    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            accumulated += value.length;
            if (accumulated > maxSize) {
                throw new Error(`Response exceeded maximum size of ${maxSize} bytes`);
            }

            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode(); // flush remaining
    } finally {
        reader.releaseLock();
    }

    return text;
}

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

    // Validate hostname to prevent SSRF
    try {
        await validateHostname(url.hostname);
    } catch (err) {
        return res.status(403).json({ error: "Access denied" });
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

        // Read response with size limit to prevent unbounded buffering
        const contents = await readResponseWithLimit(upstream, MAX_RESPONSE_SIZE);
        res.json({ contents });
    } catch (err) {
        let msg = err.message;
        if (err.name === "TimeoutError") msg = "Request timed out";
        res.status(502).json({ error: msg });
    }
});

app.listen(PORT, () => {
    console.log(`RSS Dashboard running at http://localhost:${PORT}`);
});