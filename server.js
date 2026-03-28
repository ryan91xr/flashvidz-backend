const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const ytdlp = require("yt-dlp-exec");

const app = express();

app.use(cors());
app.use(express.json());

app.post("/download", async (req, res) => {
  try {
    const url = req.body.url;

    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }

    const filename = `video_${Date.now()}.mp4`;
    const filePath = path.join(__dirname, filename);

    console.log("Downloading:", url);

    await ytdlp(url, {
      output: filePath,
      format: "mp4",
      noPlaylist: true,
    });

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "File not created" });
    }

    res.download(filePath, () => {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    });

  } catch (err) {
    console.log("ERROR:", err.message);
    res.status(500).json({ error: "Download failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running..."));