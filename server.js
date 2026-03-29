const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const youtubedl = require("yt-dlp-exec");
const os = require("os");

const app = express();
const unlinkAsync = promisify(fs.unlink);
const statAsync = promisify(fs.stat);

// ==================== CONFIG ====================
const CONFIG = {
  MAX_FILE_SIZE: 500 * 1024 * 1024,
  DOWNLOAD_TIMEOUT: 120000,
  MAX_CONCURRENT_DOWNLOADS: 3,
  ALLOWED_PLATFORMS: [
    { name: "youtube", domains: ["youtube.com", "youtu.be"] },
    { name: "tiktok", domains: ["tiktok.com"] },
    { name: "instagram", domains: ["instagram.com"] }
  ]
};

// ==================== STATE ====================
let activeDownloads = 0;
const tempFiles = new Set();

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== VALIDATION ====================
function validateUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

    const platform = CONFIG.ALLOWED_PLATFORMS.find(p =>
      p.domains.some(d => hostname === d || hostname.endsWith("." + d))
    );

    if (!platform) return { valid: false, error: "Unsupported platform" };

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { valid: false, error: "Invalid protocol" };
    }

    return { valid: true, platform: platform.name };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

// ==================== CLEANUP ====================
async function cleanupFile(filePath) {
  if (!filePath) return;
  tempFiles.delete(filePath);
  try { await unlinkAsync(filePath); } catch {}
}

// ==================== CORE DOWNLOAD HANDLER ====================
async function handleDownload(req, res, url) {
  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  if (activeDownloads >= CONFIG.MAX_CONCURRENT_DOWNLOADS) {
    return res.status(503).send("Server busy");
  }

  const { platform } = validation;
  console.log(`\n📥 [${platform}] ${url}`);

  const tmpDir = os.tmpdir();
  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(tmpDir, fileName);
  tempFiles.add(filePath);

  activeDownloads++;
  let processRef;
  let finished = false;

  const timeout = setTimeout(async () => {
    if (!finished) {
      console.log("⏱️ Timeout killing process");
      if (processRef) processRef.kill("SIGKILL");
      await cleanupFile(filePath);
      activeDownloads--;
      if (!res.headersSent) res.status(504).end("Timeout");
    }
  }, CONFIG.DOWNLOAD_TIMEOUT);

  try {
    // 🔥 FAST + RELIABLE OPTIONS
    processRef = youtubedl.exec(url, {
      output: filePath,
      format: "best",
      noPlaylist: true,
      retries: 2,
      fragmentRetries: 2,
      addHeader: [
        "User-Agent: Mozilla/5.0",
        "Accept-Language: en-US,en;q=0.9"
      ],
      forceIpv4: true
    });

    await processRef;

    clearTimeout(timeout);
    finished = true;

    if (!fs.existsSync(filePath)) throw new Error("No file");

    const stats = await statAsync(filePath);

    // 🔥 HEADERS FOR DIRECT DOWNLOAD
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Disposition", `attachment; filename="flashvidz.mp4"`);

    const stream = fs.createReadStream(filePath);

    stream.on("close", async () => {
      activeDownloads--;
      await cleanupFile(filePath);
      console.log("✅ Done");
    });

    stream.on("error", async () => {
      activeDownloads--;
      await cleanupFile(filePath);
    });

    stream.pipe(res);

  } catch (err) {
    clearTimeout(timeout);
    finished = true;
    activeDownloads--;

    await cleanupFile(filePath);

    console.log("❌", err.message);
    if (!res.headersSent) res.status(500).end("Download failed");
  }
}

// ==================== ROUTES ====================

// 🔥 NEW: GET (for iframe auto download)
app.get("/download", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("No URL");
  handleDownload(req, res, url);
});

// (Optional) keep POST for future use
app.post("/download", (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: "No URL" });
  handleDownload(req, res, url);
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
