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
  CLEANUP_INTERVAL: 60000,
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

// Rate limit
const requestCounts = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;

  const requests = requestCounts.get(ip) || [];
  const recent = requests.filter(t => t > windowStart);

  if (recent.length >= 10) {
    return res.status(429).json({ success: false, error: "Too many requests" });
  }

  recent.push(now);
  requestCounts.set(ip, recent);
  next();
});

// Concurrent limiter
const downloadLimiter = (req, res, next) => {
  if (activeDownloads >= CONFIG.MAX_CONCURRENT_DOWNLOADS) {
    return res.status(503).json({
      success: false,
      error: "Server busy, try again later"
    });
  }
  next();
};

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
  try {
    await unlinkAsync(filePath);
  } catch {}
}

// ==================== DOWNLOAD ====================
app.post("/download", downloadLimiter, async (req, res) => {
  const url = req.body?.url?.trim();

  if (!url) {
    return res.status(400).json({ success: false, error: "No URL provided" });
  }

  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  const { platform } = validation;
  console.log(`\n📥 [${platform}] ${url}`);

  const tmpDir = os.tmpdir();
  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(tmpDir, fileName);
  tempFiles.add(filePath);

  activeDownloads++;
  let downloadCompleted = false;

  let processRef;

  const timeoutId = setTimeout(async () => {
    if (!downloadCompleted) {
      console.log("⏱️ Timeout - killing process");
      if (processRef) processRef.kill("SIGKILL"); // 🔥 FIX
      await cleanupFile(filePath);
      activeDownloads--;
      if (!res.headersSent) {
        res.status(504).json({ success: false, error: "Download timeout" });
      }
    }
  }, CONFIG.DOWNLOAD_TIMEOUT);

  try {
    // ✅ FIXED yt-dlp OPTIONS
    processRef = youtubedl.exec(url, {
      output: filePath,
      format: "best[filesize<500M]/best",
      noPlaylist: true,
      retries: 3,
      fragmentRetries: 3,
      addHeader: [
        "User-Agent: Mozilla/5.0",
        "Accept-Language: en-US,en;q=0.9"
      ],
      preferFreeFormats: true,
      forceIpv4: true
    });

    await processRef;

    clearTimeout(timeoutId);
    downloadCompleted = true;

    if (!fs.existsSync(filePath)) {
      throw new Error("File not created");
    }

    const stats = await statAsync(filePath);

    if (stats.size > CONFIG.MAX_FILE_SIZE) {
      await cleanupFile(filePath);
      activeDownloads--;
      return res.status(413).json({ success: false, error: "File too large" });
    }

    console.log(`✅ ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

    // ✅ expose headers for frontend progress
    res.setHeader("Access-Control-Expose-Headers", "Content-Length");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="video_${platform}.mp4"`);

    const stream = fs.createReadStream(filePath);

    stream.on("error", async () => {
      activeDownloads--; // 🔥 FIX
      await cleanupFile(filePath);
    });

    stream.on("close", async () => {
      activeDownloads--; // 🔥 FIX
      await cleanupFile(filePath);
      console.log("✅ Done");
    });

    stream.pipe(res);

  } catch (err) {
    clearTimeout(timeoutId);
    downloadCompleted = true;
    activeDownloads--;

    await cleanupFile(filePath);

    console.error("❌", err.message);

    if (res.headersSent) return;

    res.status(500).json({
      success: false,
      platform,
      error: "Download failed"
    });
  }
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
