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
  MAX_FILE_SIZE: 500 * 1024 * 1024, // 500MB
  DOWNLOAD_TIMEOUT: 120000, // 2 minutes
  CLEANUP_INTERVAL: 60000,
  MAX_CONCURRENT_DOWNLOADS: 3,
  ALLOWED_PLATFORMS: [
    { name: "youtube", domains: ["youtube.com", "youtu.be"] },
    { name: "tiktok", domains: ["tiktok.com", "vt.tiktok.com"] },
    { name: "instagram", domains: ["instagram.com"] },
    { name: "facebook", domains: ["facebook.com", "fb.watch", "fb.gg"] }
  ],
  COOKIES_PATH: path.join(__dirname, "cookies.txt")
};

// ==================== STATE ====================
let activeDownloads = 0;
const tempFiles = new Set();

// ==================== MIDDLEWARE ====================
// CORS - Allow frontend to connect
app.use(cors({
  origin: [
    'http://localhost:3000', 
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://flashvidz.vercel.app', // Add your frontend domain
    'https://flashvidz.netlify.app'  // Add your frontend domain
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const requestCounts = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000; // 15 min window

  const requests = requestCounts.get(ip) || [];
  const recent = requests.filter(t => t > windowStart);

  if (recent.length >= 10) {
    return res.status(429).json({ error: "Too many requests. Please wait." });
  }

  recent.push(now);
  requestCounts.set(ip, recent);
  
  // Cleanup old entries periodically
  if (Math.random() < 0.01) {
    for (const [key, value] of requestCounts.entries()) {
      const valid = value.filter(t => t > windowStart);
      if (valid.length === 0) requestCounts.delete(key);
      else requestCounts.set(key, valid);
    }
  }
  
  next();
});

// Concurrent download limiter
const downloadLimiter = (req, res, next) => {
  if (activeDownloads >= CONFIG.MAX_CONCURRENT_DOWNLOADS) {
    return res.status(503).json({
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
    console.log(`🗑️ Cleaned up: ${path.basename(filePath)}`);
  } catch (err) {
    // File might already be deleted
  }
}

// Periodic cleanup of orphaned temp files
setInterval(async () => {
  for (const filePath of tempFiles) {
    try {
      const stats = await statAsync(filePath);
      const age = Date.now() - stats.mtime.getTime();
      if (age > 300000) { // 5 minutes old
        await cleanupFile(filePath);
      }
    } catch {
      tempFiles.delete(filePath);
    }
  }
}, CONFIG.CLEANUP_INTERVAL);

// ==================== COOKIES CHECK ====================
function hasCookies() {
  return fs.existsSync(CONFIG.COOKIES_PATH);
}

// ==================== DOWNLOAD ENDPOINT ====================
app.post("/download", downloadLimiter, async (req, res) => {
  const url = req.body?.url?.trim();
  const clientPlatform = req.body?.platform; // Frontend detected platform

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { platform } = validation;
  console.log(`\n📥 [${platform}] ${url}`);
  console.log(`🌐 Client platform hint: ${clientPlatform || 'none'}`);

  const tmpDir = os.tmpdir();
  const fileName = `flashvidz_${platform}_${Date.now()}.mp4`;
  const filePath = path.join(tmpDir, fileName);
  tempFiles.add(filePath);

  activeDownloads++;
  let downloadCompleted = false;
  let processRef;
  let timeoutId;

  // Timeout handler
  const cleanup = async () => {
    if (processRef && !downloadCompleted) {
      try {
        processRef.kill("SIGKILL");
      } catch {}
    }
    await cleanupFile(filePath);
    activeDownloads--;
  };

  timeoutId = setTimeout(async () => {
    if (!downloadCompleted) {
      console.log("⏱️ Timeout - killing process");
      await cleanup();
      if (!res.headersSent) {
        res.status(504).json({ error: "Download timeout" });
      }
    }
  }, CONFIG.DOWNLOAD_TIMEOUT);

  try {
    // Build yt-dlp options
    const options = {
      output: filePath,
      format: "best[filesize<500M][ext=mp4]/best[filesize<500M]/best",
      noPlaylist: true,
      retries: 3,
      fragmentRetries: 3,
      addHeader: [
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language: en-US,en;q=0.9"
      ],
      preferFreeFormats: true,
      forceIpv4: true,
      noWarnings: true,
      // Progress hook for logging
      onProgress: (progress) => {
        if (progress.percent) {
          console.log(`⏳ ${platform}: ${progress.percent.toFixed(1)}%`);
        }
      }
    };

    // Use cookies for Instagram and Facebook (required for private content)
    if ((platform === "instagram" || platform === "facebook") && hasCookies()) {
      options.cookies = CONFIG.COOKIES_PATH;
      console.log(`🍪 Using cookies for ${platform}`);
    } else if (hasCookies()) {
      // Optional: use cookies for all platforms for better quality
      options.cookies = CONFIG.COOKIES_PATH;
    }

    // Platform-specific warnings
    if ((platform === "facebook" || platform === "instagram") && !hasCookies()) {
      console.log(`⚠️ No cookies - only public ${platform} videos will work`);
    }

    // Execute download
    processRef = youtubedl.exec(url, options);
    await processRef;

    clearTimeout(timeoutId);
    downloadCompleted = true;

    // Verify file exists
    if (!fs.existsSync(filePath)) {
      throw new Error("Download failed - file not created");
    }

    const stats = await statAsync(filePath);

    // Check file size
    if (stats.size === 0) {
      throw new Error("Download failed - empty file");
    }

    if (stats.size > CONFIG.MAX_FILE_SIZE) {
      await cleanupFile(filePath);
      activeDownloads--;
      return res.status(413).json({ error: "File too large (max 500MB)" });
    }

    console.log(`✅ Downloaded: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

    // Set headers for frontend compatibility
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition");
    
    // Add custom headers for frontend tracking
    res.setHeader("X-Download-Platform", platform);
    res.setHeader("X-File-Size", stats.size);

    // Stream file to client
    const stream = fs.createReadStream(filePath);

    stream.on("open", () => {
      console.log(`📤 Streaming to client...`);
    });

    stream.on("error", async (err) => {
      console.error("❌ Stream error:", err.message);
      await cleanupFile(filePath);
      activeDownloads--;
      if (!res.headersSent) {
        res.status(500).json({ error: "Streaming failed" });
      }
    });

    stream.on("close", async () => {
      console.log("✅ Stream complete");
      activeDownloads--;
      await cleanupFile(filePath);
    });

    // Handle client disconnect
    res.on("close", async () => {
      if (!res.writableEnded) {
        console.log("⚠️ Client disconnected early");
        stream.destroy();
        await cleanupFile(filePath);
        activeDownloads--;
      }
    });

    stream.pipe(res);

  } catch (err) {
    clearTimeout(timeoutId);
    downloadCompleted = true;
    activeDownloads--;
    await cleanupFile(filePath);

    console.error("❌ Download error:", err.message);

    // Don't send error if headers already sent
    if (res.headersSent) return;

    // Smart error messages
    let errorMessage = "Download failed";
    let statusCode = 500;

    const errMsg = err.message?.toLowerCase() || "";

    // Platform-specific error handling
    if (errMsg.includes("login") || errMsg.includes("cookie") || errMsg.includes("sign in")) {
      errorMessage = platform === "youtube" 
        ? "This video requires login. Try a different video."
        : `This ${platform} content requires authentication. Please check cookies.`;
      statusCode = 403;
    } else if (errMsg.includes("private") || errMsg.includes("restricted")) {
      errorMessage = `This ${platform} content is private or restricted`;
      statusCode = 403;
    } else if (errMsg.includes("not available") || errMsg.includes("unavailable")) {
      errorMessage = "Video not available or may have been removed";
      statusCode = 404;
    } else if (errMsg.includes("copyright") || errMsg.includes("blocked")) {
      errorMessage = "Video blocked due to copyright or regional restrictions";
      statusCode = 451;
    } else if (errMsg.includes("unsupported url") || errMsg.includes("no video")) {
      errorMessage = "No video found at this URL";
      statusCode = 400;
    } else if (errMsg.includes("timeout") || errMsg.includes("etimedout")) {
      errorMessage = "Download timed out. Try again.";
      statusCode = 504;
    } else if (errMsg.includes("rate limit") || errMsg.includes("too many requests")) {
      errorMessage = "Rate limited by platform. Please wait a moment.";
      statusCode = 429;
    }

    res.status(statusCode).json({ 
      error: errorMessage,
      platform,
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    cookies_configured: hasCookies(),
    cookies_path: CONFIG.COOKIES_PATH,
    active_downloads: activeDownloads,
    max_concurrent: CONFIG.MAX_CONCURRENT_DOWNLOADS,
    uptime: process.uptime()
  });
});

// ==================== INFO ENDPOINT ====================
app.get("/info", (req, res) => {
  res.json({
    name: "FlashVidz API",
    version: "1.0.0",
    platforms: CONFIG.ALLOWED_PLATFORMS.map(p => p.name),
    max_file_size: CONFIG.MAX_FILE_SIZE,
    features: {
      cookies_support: hasCookies(),
      concurrent_downloads: CONFIG.MAX_CONCURRENT_DOWNLOADS
    }
  });
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // Cleanup temp files before exit
  Promise.all([...tempFiles].map(cleanupFile)).then(() => {
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FlashVidz Server running on port ${PORT}`);
  console.log(`🍪 Cookies: ${hasCookies() ? "✅ Found" : "❌ Not found"} at ${CONFIG.COOKIES_PATH}`);
  console.log(`📱 Supported platforms: ${CONFIG.ALLOWED_PLATFORMS.map(p => p.name).join(", ")}`);
  console.log(`⚡ Max concurrent downloads: ${CONFIG.MAX_CONCURRENT_DOWNLOADS}`);
});
