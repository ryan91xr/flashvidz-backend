const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// âœ… yt-dlp wrapper
const youtubedl = require("yt-dlp-exec");

const app = express();

// âœ… MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// âœ… NEW: prevent multiple downloads
let isProcessing = false;

app.post("/download", async (req, res) => {

  // ðŸš« Block if busy
  if (isProcessing) {
    return res.status(429).json({
      success: false,
      error: "Server busy, try again"
    });
  }

  isProcessing = true;

  const url = req.body.url;

  if (!url) {
    isProcessing = false;
    return res.status(400).json({ 
      success: false,
      error: "No URL provided" 
    });
  }

  // ðŸ” Detect platform
  let platform = "unknown";
  if (url.includes("tiktok")) platform = "tiktok";
  else if (url.includes("instagram")) platform = "instagram";
  else if (url.includes("youtube") || url.includes("youtu.be")) platform = "youtube";

  console.log("\nðŸ“¥ Incoming request");
  console.log("URL:", url);
  console.log("Platform:", platform);

  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(__dirname, fileName);

  try {
    console.log("âš™ï¸ Running yt-dlp...");

    // âœ… ðŸ”¥ UPDATED PLAN B CONFIG
    await youtubedl(url, {
      output: filePath,

      format: "bv*+ba/best",

      noPlaylist: true,

      socketTimeout: 30,
      retries: 5,
      fragmentRetries: 5,
      forceIpv4: true,

      addHeader: [
        "user-agent: Mozilla/5.0 (Linux; Android 10; Mobile)",
        "accept-language: en-US,en;q=0.9",
        "referer: https://www.instagram.com/",
        "origin: https://www.instagram.com"
      ],

      extractorArgs: "instagram:api=mobile"
    });

    console.log("âœ… Download completed");

    if (!fs.existsSync(filePath)) {
      isProcessing = false;
      console.log("âŒ File not found after download");
      return res.status(500).json({
        success: false,
        error: "File not created"
      });
    }

    res.download(filePath, fileName, (err) => {

      isProcessing = false;

      if (err) {
        console.log("âŒ Send error:", err.message);
      }

      try {
        fs.unlinkSync(filePath);
        console.log("ðŸ§¹ File deleted");
      } catch (e) {
        console.log("Cleanup error:", e.message);
      }
    });

  } catch (err) {
    isProcessing = false;

    console.log("âŒ yt-dlp failed:");
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
