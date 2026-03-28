const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const youtubedl = require("yt-dlp-exec");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Prevent overload
let isProcessing = false;

app.post("/download", async (req, res) => {

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

  console.log("\n📥 Request:", url);

  const fileName = `video_${Date.now()}.mp4`;
  const filePath = path.join(__dirname, fileName);

  try {
    console.log("⚙️ Running yt-dlp...");

    await youtubedl(url, {
      output: filePath,
      format: "bv*+ba/best", // 🔥 better format
      noPlaylist: true,
      socketTimeout: 15,
      retries: 3,
      addHeader: [
        "user-agent: Mozilla/5.0",
        "accept-language: en-US,en;q=0.9"
      ]
    });

    console.log("✅ Download completed");

    if (!fs.existsSync(filePath)) {
      isProcessing = false;
      return res.status(500).json({
        success: false,
        error: "File not created"
      });
    }

    res.download(filePath, fileName, (err) => {

      isProcessing = false;

      if (err) {
        console.log("❌ Send error:", err.message);
      }

      try {
        fs.unlinkSync(filePath);
      } catch {}
    });

  } catch (err) {
    isProcessing = false;

    console.log("❌ Error:", err.message);

    return res.status(500).json({
      success: false,
      error: "Download failed"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
