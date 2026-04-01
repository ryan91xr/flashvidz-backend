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

 const tmpDir = os.tmpdir();
 const timestamp = Date.now();
 const extension = format === "audio" ? "mp3" : "mp4";
 const fileName = `download_${timestamp}.${extension}`;
 const filePath = path.join(tmpDir, fileName);
 tempFiles.add(filePath);

 activeDownloads++;
 let downloadCompleted = false;
 let processRef;

 const timeoutId = setTimeout(async () => {
   if (!downloadCompleted) {
     console.log("⏱️ Timeout - killing process");
     if (processRef) processRef.kill("SIGKILL");
     await cleanupFile(filePath);
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

   processRef = youtubedl.exec(url, options);

   await processRef;

   clearTimeout(timeoutId);
   downloadCompleted = true;

   // Find the actual downloaded file (yt-dlp may change extension)
   const actualFilePath = fs.existsSync(filePath) ? filePath : 
     fs.existsSync(filePath.replace(`.${extension}`, ".m4a")) ? filePath.replace(`.${extension}`, ".m4a") :
     fs.existsSync(filePath.replace(`.${extension}`, ".webm")) ? filePath.replace(`.${extension}`, ".webm") :
     fs.existsSync(filePath.replace(`.${extension}`, ".mp4")) ? filePath.replace(`.${extension}`, ".mp4") : null;

   if (!actualFilePath || !fs.existsSync(actualFilePath)) {
     throw new Error("File not created");
   }

   const stats = await statAsync(actualFilePath);

   if (stats.size > CONFIG.MAX_FILE_SIZE) {
     await cleanupFile(actualFilePath);
     activeDownloads--;
     return res.status(413).json({ success: false, error: "File too large" });
   }

   console.log(`✅ ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

   // Set proper content type and headers
   const contentType = format === "audio" ? "audio/mpeg" : "video/mp4";
   const downloadFileName = `flashvidz_${platform}_${timestamp}.${extension}`;

   res.setHeader("Access-Control-Expose-Headers", "Content-Length");
   res.setHeader("Content-Length", stats.size);
   res.setHeader("Content-Type", contentType);
   res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName}"`);

   const stream = fs.createReadStream(actualFilePath);

   stream.on("error", async () => {
     activeDownloads--;
     await cleanupFile(actualFilePath);
   });

   stream.on("close", async () => {
     activeDownloads--;
     await cleanupFile(actualFilePath);
     console.log("✅ Done");
   });

   stream.pipe(res);

 } catch (err) {
   clearTimeout(timeoutId);
   downloadCompleted = true;
   activeDownloads--;

   await cleanupFile(filePath);

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
   timestamp: new Date().toISOString()
 });
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
 console.log(`🚀 Server running on port ${PORT}`);
 console.log(`🍪 Cookies: ${hasCookies() ? "✅ Found" : "❌ Not found"} at ${CONFIG.COOKIES_PATH}`);
});
     
