const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();

// ✅ MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/download", async (req, res) => {
  const url = req.body.url;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: "No URL provided"
    });
  }

  console.log("\n📥 Streaming request");
  console.log("URL:", url);

  try {
    res.setHeader("Content-Disposition", "attachment; filename=flashvidz.mp4");
    res.setHeader("Content-Type", "video/mp4");

    console.log("⚡ Starting yt-dlp stream...");

    const yt = spawn("npx", [
      "yt-dlp-exec",
      "-f", "bv*+ba/best",
      "--no-playlist",
      "--merge-output-format", "mp4",
      "-o", "-",
      url
    ]);

    yt.stdout.pipe(res);

    yt.stderr.on("data", (data) => {
      console.log("yt-dlp:", data.toString());
    });

    yt.on("close", (code) => {
      console.log("✅ Stream finished:", code);

      if (!res.headersSent) {
        res.status(500).end("Download failed");
      } else {
        res.end();
      }
    });

    yt.on("error", (err) => {
      console.log("❌ Spawn error:", err.message);

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Streaming failed"
        });
      }
    });

    // ✅ Kill process if user leaves
    req.on("close", () => {
      console.log("⚠️ Client disconnected");
      yt.kill("SIGKILL");
    });

  } catch (err) {
    console.log("❌ Server error:", err.message);

    return res.status(500).json({
      success: false,
      error: "Streaming failed"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
