const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// ✅ IMPORTANT (you were missing this sometimes)
const youtubedl = require("yt-dlp-exec");

const app = express();

app.use(cors());
app.use(express.json());

app.post("/download", async (req, res) => {
  const url = req.body.url;

  if (!url) {
    return res.status(400).json({ 
      success: false,
      error: "No URL provided" 
    });
  }

  // 🔍 Detect platform
  let platform = "unknown";
  if (url.includes("tiktok")) platform = "tiktok";
  else if (url.includes("instagram")) platform = "instagram";
  else if (url.includes("youtube") || url.includes("youtu.be")) platform = "youtube";

  console.log("\n📥 Incoming request");
  console.log("URL:", url);
  console.log("Platform:", platform);

  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(__dirname, fileName);

  try {
    console.log("⚙️ Running yt-dlp...");

    await youtubedl(url, {
      output: filePath,
      format: "best",
      noPlaylist: true,
      socketTimeout: 15,
      addHeader: [
        "user-agent: Mozilla/5.0",
        "accept-language: en-US,en;q=0.9"
      ]
    });

    console.log("✅ Download completed");

    // ✅ Ensure file exists
    if (!fs.existsSync(filePath)) {
      console.log("❌ File not found after download");
      return res.status(500).json({
        success: false,
        error: "File not created"
      });
    }

    // ✅ Send file
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.log("❌ Send error:", err.message);
      }

      // 🧹 Cleanup
      try {
        fs.unlinkSync(filePath);
        console.log("🧹 File deleted");
      } catch (e) {
        console.log("Cleanup error:", e.message);
      }
    });

  } catch (err) {
    console.log("❌ yt-dlp failed:");
    console.log(err.message);

    return res.status(500).json({
      success: false,
      platform,
      error: "Download failed",
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
