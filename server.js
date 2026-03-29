const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const youtubedl = require("yt-dlp-exec");

const app = express();

// ==================== CONFIG ====================
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

// Ensure downloads folder exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== SERVE FILES ====================
app.use("/file", express.static(DOWNLOAD_DIR));

// ==================== PREPARE DOWNLOAD ====================
app.post("/prepare", async (req, res) => {
  const url = req.body.url;

  if (!url) {
    return res.status(400).json({ 
      success: false,
      error: "No URL provided"
    });
  }

  console.log("\n📥 Preparing download");
  console.log("URL:", url);

  const fileName = `video_${Date.now()}_${Math.floor(Math.random()*1000)}.mp4`;
  const filePath = path.join(DOWNLOAD_DIR, fileName);

  try {
    console.log("⚙️ Running yt-dlp...");

    await youtubedl(url, {
      output: filePath,
      format: "best",
      noPlaylist: true,
      socketTimeout: 30,
      retries: 3,
      fragmentRetries: 3,
      addHeader: [
        "user-agent: Mozilla/5.0",
        "accept-language: en-US,en;q=0.9"
      ]
    });

    console.log("✅ File ready:", fileName);

    return res.json({
      success: true,
      downloadUrl: `/file/${fileName}`,
      fileName
    });

  } catch (err) {
    console.log("❌ Download failed:", err.message);

    return res.status(500).json({
      success: false,
      error: "Failed to process video",
      details: err.message
    });
  }
});

// ==================== OPTIONAL CLEANUP ====================
// Delete old files every 10 minutes
setInterval(() => {
  fs.readdir(DOWNLOAD_DIR, (err, files) => {
    if (err) return;

    files.forEach(file => {
      const filePath = path.join(DOWNLOAD_DIR, file);

      fs.stat(filePath, (err, stats) => {
        if (err) return;

        // delete if older than 15 minutes
        if (Date.now() - stats.mtimeMs > 15 * 60 * 1000) {
          fs.unlink(filePath, () => {
            console.log("🧹 Deleted:", file);
          });
        }
      });
    });
  });
}, 10 * 60 * 1000);

// ==================== HEALTH ====================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
