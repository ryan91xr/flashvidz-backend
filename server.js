const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const youtubedl = require("yt-dlp-exec");

const app = express();
const statAsync = promisify(fs.stat);

function isPublicHostname(hostname) {
 if (!hostname) return false;

 const host = hostname.toLowerCase();
 if (host === "localhost" || host.endsWith(".local")) return false;

 // Basic private/loopback/link-local IPv4 checks
 if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
   if (host.startsWith("10.") || host.startsWith("127.") || host.startsWith("192.168.")) return false;
   const secondOctet = Number(host.split(".")[1] || 0);
   if (host.startsWith("172.") && secondOctet >= 16 && secondOctet <= 31) return false;
   if (host.startsWith("169.254.")) return false;
 }

 // Basic IPv6 local checks
 if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
   return false;
 }

 return true;
}

function normalizeThumbnailUrl(rawUrl) {
 if (!rawUrl || typeof rawUrl !== "string") return null;

 const trimmed = rawUrl.trim();
 const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;

 try {
   const parsed = new URL(normalized);
   if (!["https:", "http:"].includes(parsed.protocol)) return null;
   if (!isPublicHostname(parsed.hostname)) return null;

   // Enforce HTTPS in response payload
   parsed.protocol = "https:";
   return parsed.toString();
 } catch {
   return null;
 }
}

async function fetchMediaMetadata(url, platform, sharedOptions = {}) {
 try {
   const metadataOptions = {
     ...sharedOptions,
     skipDownload: true,
     dumpSingleJson: true,
     noPlaylist: true,
     quiet: true,
     noWarnings: true
   };

   const output = await youtubedl(url, metadataOptions);
   const metadata = JSON.parse(output);
   const candidates = [
     metadata?.thumbnail,
     ...(Array.isArray(metadata?.thumbnails) ? metadata.thumbnails.map(item => item?.url) : [])
   ];

   let thumbnail = null;
   for (let i = candidates.length - 1; i >= 0; i--) {
     const normalized = normalizeThumbnailUrl(candidates[i]);
     if (normalized) {
       thumbnail = normalized;
       break;
     }
   }

   return {
     thumbnail,
     duration: metadata?.duration_string || null
   };
 } catch (error) {
   console.warn(`⚠️ Unable to fetch thumbnail metadata for ${platform}: ${error.message}`);
 }

 return { thumbnail: null, duration: null };
}

function formatFileSize(bytes) {
 if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
 if (bytes < 1024) return `${bytes} B`;

 const units = ["KB", "MB", "GB", "TB"];
 let size = bytes / 1024;
 let unitIndex = 0;

 while (size >= 1024 && unitIndex < units.length - 1) {
   size /= 1024;
   unitIndex++;
 }

 return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// ==================== CONFIG ====================
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
 fs.mkdirSync(downloadsDir, { recursive: true });
}

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

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/files", express.static(downloadsDir));

app.get("/files/:fileName/download", (req, res) => {
 const safeFileName = path.basename(req.params.fileName);
 const targetPath = path.join(downloadsDir, safeFileName);

 if (!fs.existsSync(targetPath)) {
   return res.status(404).json({ success: false, error: "File not found" });
 }

 return res.download(targetPath, safeFileName);
});

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

// ==================== COOKIES CHECK ====================
function hasCookies() {
 return fs.existsSync(CONFIG.COOKIES_PATH);
}

// ==================== DOWNLOAD ====================
app.post("/download", downloadLimiter, async (req, res) => {
 const url = req.body?.url?.trim();
 const format = req.body?.format?.toLowerCase() || "video";

 if (!url) {
   return res.status(400).json({ success: false, error: "No URL provided" });
 }

 if (!["video", "audio"].includes(format)) {
   return res.status(400).json({ success: false, error: "Invalid format. Use 'video' or 'audio'" });
 }

 const validation = validateUrl(url);
 if (!validation.valid) {
   return res.status(400).json({ success: false, error: validation.error });
 }

 const { platform } = validation;
 console.log(`\n📥 [${platform}] [${format}] ${url}`);

 const timestamp = Date.now();
 const extension = format === "audio" ? "mp3" : "mp4";
 const fileName = `download_${platform}_${timestamp}.${extension}`;
 const filePath = path.join(downloadsDir, fileName);

 activeDownloads++;
 let downloadCompleted = false;
 let processRef;

 const timeoutId = setTimeout(async () => {
   if (!downloadCompleted) {
     console.log("⏱️ Timeout - killing process");
     if (processRef) processRef.kill("SIGKILL");
     activeDownloads--;
     if (!res.headersSent) {
       res.status(504).json({ success: false, error: "Download timeout" });
     }
   }
 }, CONFIG.DOWNLOAD_TIMEOUT);

 try {
   // Build yt-dlp options based on format
   const options = {
     output: filePath.replace(`.${extension}`, ".%(ext)s"),
     noPlaylist: true,
     retries: 3,
     fragmentRetries: 3,
     addHeader: [
       "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
       "Accept-Language: en-US,en;q=0.9"
     ],
     preferFreeFormats: true,
     forceIpv4: true
   };

   if (format === "audio") {
     // Audio format: best audio, convert to mp3
     options.format = "bestaudio[filesize<500M]/bestaudio";
     options.extractAudio = true;
     options.audioFormat = "mp3";
     options.audioQuality = "192K";
   } else {
     // Video format: best video+audio under 500MB
     options.format = "best[filesize<500M]/best";
   }

   // Add cookies for Instagram, Facebook if available
   if ((platform === "instagram" || platform === "facebook") && hasCookies()) {
     options.cookies = CONFIG.COOKIES_PATH;
     console.log(`🍪 Using cookies for ${platform}`);
   } else if (hasCookies()) {
     options.cookies = CONFIG.COOKIES_PATH;
   }

   if (platform === "facebook" && !hasCookies()) {
     console.log("⚠️ No cookies - public Facebook videos only");
   }

   // Thumbnail is optional and must never block downloads.
   const mediaMetadata = await fetchMediaMetadata(url, platform, options);

   processRef = youtubedl.exec(url, options);

   await processRef;

   clearTimeout(timeoutId);
   downloadCompleted = true;

   // Find the actual downloaded file (yt-dlp may change extension)
   const actualFilePath = fs.existsSync(filePath)
     ? filePath
     : fs.existsSync(filePath.replace(`.${extension}`, ".m4a"))
       ? filePath.replace(`.${extension}`, ".m4a")
       : fs.existsSync(filePath.replace(`.${extension}`, ".webm"))
         ? filePath.replace(`.${extension}`, ".webm")
         : fs.existsSync(filePath.replace(`.${extension}`, ".mp4"))
           ? filePath.replace(`.${extension}`, ".mp4")
           : null;

   if (!actualFilePath || !fs.existsSync(actualFilePath)) {
     throw new Error("File not created");
   }

   const stats = await statAsync(actualFilePath);

   if (stats.size > CONFIG.MAX_FILE_SIZE) {
     activeDownloads--;
     return res.status(413).json({ success: false, error: "File too large" });
   }

   console.log(`✅ ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

   const publicFileName = path.basename(actualFilePath);
   const forwardedProto = req.get("x-forwarded-proto");
   const protocol = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
   const baseUrl = `${protocol}://${req.get("host")}`;
   const fileUrl = `${baseUrl}/files/${encodeURIComponent(publicFileName)}`;
   const autoDownloadUrl = `${baseUrl}/files/${encodeURIComponent(publicFileName)}/download`;
   let thumbnail = mediaMetadata.thumbnail || null;

   if (thumbnail && thumbnail.startsWith("//")) {
     thumbnail = `https:${thumbnail}`;
   }

  if (!thumbnail) {
    thumbnail = `https://dummyimage.com/300x400/1c2b33/00d4aa&text=${platform}`;
  }

   activeDownloads--;
   return res.json({
     success: true,
     url: fileUrl,
     fileUrl: fileUrl,
     downloadUrl: autoDownloadUrl,
     format,
     thumbnail,
     duration: mediaMetadata.duration || null,
     fileName: publicFileName,
     fileSize: formatFileSize(stats.size),
     fileSizeBytes: stats.size,
     autoDownload: true
   });
 } catch (err) {
   clearTimeout(timeoutId);
   downloadCompleted = true;
   activeDownloads--;

   console.error("❌", err.message);

   // Handle specific error cases
   let errorMessage = "Download failed";

   if (err.message?.includes("login") || err.message?.includes("cookie") || err.message?.includes("private")) {
     errorMessage = platform === "instagram" || platform === "facebook"
       ? `${platform} login required. Please check cookies configuration.`
       : "Authentication required for this content";
     console.log("💡 Tip: Update your cookies.txt file");
   } else if (err.message?.includes("unavailable") || err.message?.includes("not found")) {
     errorMessage = "Video not found or unavailable";
   } else if (err.message?.includes("copyright") || err.message?.includes("blocked")) {
     errorMessage = "Content blocked due to copyright or restrictions";
   } else if (err.message?.includes("age")) {
     errorMessage = "Age-restricted content";
   } else if (err.message?.includes("network") || err.message?.includes("timeout")) {
     errorMessage = "Network error, please try again";
   } else if (err.message?.includes("ffmpeg") || err.message?.includes("convert")) {
     errorMessage = "Audio conversion failed. Video may not have audio track.";
   }

   if (res.headersSent) return;

   res.status(500).json({
     success: false,
     platform,
     format,
     error: errorMessage,
     details: err.message
   });
 }
});

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
 res.json({
   status: "ok",
   cookies_configured: hasCookies(),
   cookies_path: CONFIG.COOKIES_PATH,
   downloads_path: downloadsDir,
   timestamp: new Date().toISOString()
 });
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
 console.log(`🚀 Server running on port ${PORT}`);
 console.log(`📁 Downloads: ${downloadsDir}`);
 console.log(`🍪 Cookies: ${hasCookies() ? "✅ Found" : "❌ Not found"} at ${CONFIG.COOKIES_PATH}`);
});
