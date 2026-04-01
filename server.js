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
    { name: "instagram", domains: ["instagram.com"] },
    { name: "facebook", domains: ["facebook.com", "fb.watch"] }
  ],
  COOKIES_PATH: path.join(__dirname, "cookies.txt")
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
      p.domains.some(d => hostname === d || hostname.endsWith(`.${d}`))
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

function normalizeFormat(format) {
  if (typeof format !== "string") return "video";
  const normalized = format.trim().toLowerCase();
  return normalized === "audio" ? "audio" : "video";
}

function getDownloadPlan(format, platform) {
  const baseName = `${platform}_${Date.now()}`;

  if (format === "audio") {
    return {
      format,
      ytDlpFormat: "bestaudio/best",
      extractAudio: true,
      audioFormat: "mp3",
      extension: "mp3",
      contentType: "audio/mpeg",
      downloadName: `${baseName}.mp3`
    };
  }

  return {
    format: "video",
    ytDlpFormat: "bestvideo+bestaudio/best",
    extension: "mp4",
    contentType: "video/mp4",
    downloadName: `${baseName}.mp4`
  };
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function mapYtDlpError(err) {
  const message = err?.stderr || err?.message || "Unknown error";
  const lower = String(message).toLowerCase();

  if (lower.includes("unsupported url")) {
    return { status: 400, error: "Unsupported or invalid URL", details: message };
  }

  if (lower.includes("private") || lower.includes("login") || lower.includes("sign in")) {
    return { status: 403, error: "This media requires authentication", details: message };
  }

  if (lower.includes("copyright") || lower.includes("unavailable") || lower.includes("not available")) {
    return { status: 404, error: "Media is unavailable", details: message };
  }

  return { status: 500, error: "Download failed", details: message };
}

async function resolveOutputFile(tmpDir, outputTemplate, extension) {
  const expected = outputTemplate.replace("%(ext)s", extension);
  if (fs.existsSync(expected)) return expected;

  const prefix = path.basename(outputTemplate).replace(".%(ext)s", "");
  const entries = await fs.promises.readdir(tmpDir);

  const match = entries
    .filter(name => name.startsWith(prefix + "."))
    .map(name => path.join(tmpDir, name))
    .find(fullPath => fs.existsSync(fullPath));

  if (match) return match;
  throw new Error("Downloaded file not found");
}

// ==================== CLEANUP ====================
async function cleanupFile(filePath) {
  if (!filePath) return;
  tempFiles.delete(filePath);
  try {
    await unlinkAsync(filePath);
  } catch {
    // ignore cleanup failures
  }
}

// ==================== COOKIES CHECK ====================
function hasCookies() {
  return fs.existsSync(CONFIG.COOKIES_PATH);
}

// ==================== DOWNLOAD ====================
app.post("/download", downloadLimiter, async (req, res) => {
  const url = req.body?.url?.trim();
  const requestedFormat = normalizeFormat(req.body?.format);

  if (!url) {
    return res.status(400).json({ success: false, error: "No URL provided" });
  }

  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  const { platform } = validation;
  const plan = getDownloadPlan(requestedFormat, platform);

  console.log(`\n📥 [${platform}] ${url} (${plan.format})`);

  const tmpDir = os.tmpdir();
  const tempBase = `flashvidz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(tmpDir, `${tempBase}.%(ext)s`);

  activeDownloads++;
  let downloadCompleted = false;
  let finalized = false;
  let filePath;
  let processRef;

  const finishRequest = async () => {
    if (finalized) return;
    finalized = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    await cleanupFile(filePath);
  };

  const timeoutId = setTimeout(async () => {
    if (downloadCompleted) return;

    console.log("⏱️ Timeout - killing process");
    if (processRef && typeof processRef.kill === "function") {
      processRef.kill("SIGKILL");
    }

    await finishRequest();

    if (!res.headersSent) {
      res.status(504).json({ success: false, error: "Download timeout" });
    }
  }, CONFIG.DOWNLOAD_TIMEOUT);

  try {
    const options = {
      output: outputTemplate,
      format: plan.ytDlpFormat,
      noPlaylist: true,
      retries: 3,
      fragmentRetries: 3,
      addHeader: [
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language: en-US,en;q=0.9"
      ],
      preferFreeFormats: true,
      forceIpv4: true,
      noCheckCertificates: true
    };

    if (plan.extractAudio) {
      options.extractAudio = true;
      options.audioFormat = plan.audioFormat;
      options.audioQuality = 0;
    }

    if (hasCookies()) {
      options.cookies = CONFIG.COOKIES_PATH;
      if (platform === "instagram" || platform === "facebook") {
        console.log(`🍪 Using cookies for ${platform}`);
      }
    } else if (platform === "facebook") {
      console.log("⚠️ No cookies - public Facebook videos only");
    }

    processRef = youtubedl.exec(url, options);
    await processRef;

    clearTimeout(timeoutId);
    downloadCompleted = true;

    filePath = await resolveOutputFile(tmpDir, outputTemplate, plan.extension);
    tempFiles.add(filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error("File not created");
    }

    const stats = await statAsync(filePath);

    if (stats.size > CONFIG.MAX_FILE_SIZE) {
      await finishRequest();
      return res.status(413).json({ success: false, error: "File too large" });
    }

    console.log(`✅ ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

    const safeName = sanitizeFileName(plan.downloadName);

    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, Content-Type");
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Type", plan.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

    const stream = fs.createReadStream(filePath);

    stream.on("error", async () => {
      await finishRequest();
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: "Failed to stream file" });
      }
    });

    res.on("close", async () => {
      await finishRequest();
      console.log("✅ Done");
    });

    stream.pipe(res);
  } catch (err) {
    clearTimeout(timeoutId);
    downloadCompleted = true;

    const mapped = mapYtDlpError(err);

    console.error("❌", mapped.details);

    await finishRequest();

    if (res.headersSent) return;

    res.status(mapped.status).json({
      success: false,
      platform,
      format: plan.format,
      error: mapped.error,
      details: mapped.details
    });
  }
});

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    cookies_configured: hasCookies(),
    cookies_path: CONFIG.COOKIES_PATH,
    timestamp: new Date().toISOString()
  });
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🍪 Cookies: ${hasCookies() ? "✅ Found" : "❌ Not found"} at ${CONFIG.COOKIES_PATH}`);
});
