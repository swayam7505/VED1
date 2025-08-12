require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const playwright = require("playwright");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: "50mb" })); // bigger payload for safety

const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017";
const dbName = "reportUploaderDB";
const bucketName = "reports";

let db, bucket;

MongoClient.connect(mongoURI)
  .then(client => {
    db = client.db(dbName);
    bucket = new GridFSBucket(db, { bucketName });
    console.log("✅ MongoDB connected");
  })
  .catch(err => {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  });

// === Mapping of reportType keys to folder numbers (1..15) ===
// This must match the admin panel folder ordering.
const reportTypeToFolder = {
  liquid_ir: 1,
  draining_dry_ir: 2,
  final_dimension_ir: 3,
  hydrostatic_ir: 4,
  penetrating_oil_ir: 5,
  pickling_pass_ir: 6,
  raw_material_ir: 7,
  rf_pad_ir: 8,
  stage_ir: 9,
  surface_prep_paint_ir: 10,
  vacuum_ir: 11,
  visual_exam_ir: 12,
  extra1: 13,
  extra2: 14,
  extra3: 15
};

const users = [{ id: 1, username: "admin", password: "admin123" }];

function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET || "secretkey", {
    expiresIn: "1h",
  });
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  jwt.verify(token, process.env.JWT_SECRET || "secretkey", (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });
    req.user = decoded;
    next();
  });
}
app.get("/", (req, res) => {
  res.send("Welcome to the Report Uploader API!");});

app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || password !== user.password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json({ token: generateToken(user) });
});

app.post("/submit-report", authMiddleware, async (req, res) => {
  // Accept either:
  // - reportType (string key like 'liquid_ir') OR
  // - folder (numeric 1..15)
  // If reportType provided, it determines the folder number using mapping.
  const { html, reportType, folder, reportTitle } = req.body;

  if (!html) return res.status(400).json({ error: "Missing HTML" });

  // resolve folder number
  let folderNumber = null;
  if (reportType && reportTypeToFolder[reportType]) {
    folderNumber = reportTypeToFolder[reportType];
  } else if (typeof folder === "number" || (typeof folder === "string" && folder.trim() !== "")) {
    const f = parseInt(folder, 10);
    if (!isNaN(f) && f >= 1 && f <= 15) folderNumber = f;
  }

  if (!folderNumber) {
    return res.status(400).json({ error: "Missing or invalid reportType/folder (must map to 1-15)" });
  }

  try {
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const resolvedTitle = (reportTitle || reportType || "Report").toString().replace(/</g, "").slice(0, 150);

    const fullHtml = html.includes("<html") ? html : `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>${resolvedTitle}</title>
          <style>
            html, body {
              margin: 0;
              padding: 0;
              font-family: 'Segoe UI', Arial, sans-serif;
              font-size: 12pt;
              color: #000;
            }
            input, textarea, select {
              font-family: 'Segoe UI', Arial, sans-serif;
              font-size: 12pt;
              color: #000;
              border: none;
            }
            table { border-collapse: collapse; width: 100%; }
            td, th { border: 1px solid #000; padding: 8px; word-wrap: break-word; white-space: pre-wrap; }
          </style>
        </head>
        <body>${html}</body>
      </html>
    `;

    await page.setContent(fullHtml, { waitUntil: "networkidle" });
    await page.emulateMedia({ media: 'screen' });
    await page.waitForTimeout(500);

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });

    await browser.close();

    // Choose filename — prefer the reportType key (if available), else fallback to sanitized title.
    const safeNameBase = (reportType && typeof reportType === "string" ? reportType : resolvedTitle.replace(/\s+/g, "_")).replace(/[^\w\-_.]/g, "");
    const filename = `${safeNameBase}-${Date.now()}.pdf`;

    const uploadStream = bucket.openUploadStream(filename, {
      metadata: { folder: folderNumber }
    });

    uploadStream.end(pdfBuffer, err => {
      if (err) {
        console.error("❌ Upload error:", err);
        return res.status(500).json({ error: "Failed to upload PDF" });
      }
      console.log(`✅ PDF uploaded in Folder ${folderNumber}: ${filename}`);
      res.json({ fileId: uploadStream.id });
    });

  } catch (err) {
    console.error("❌ PDF generation error:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// Updated to support optional folder filter
app.get("/all-reports", authMiddleware, async (req, res) => {
  try {
    const folder = parseInt(req.query.folder);
    const filter = !isNaN(folder) ? { "metadata.folder": folder } : {};

    const files = await db.collection(`${bucketName}.files`)
      .find(filter)
      .sort({ uploadDate: -1 })
      .toArray();

    const reportList = files.map(file => ({
      fileId: file._id,
      filename: file.filename,
      folder: file.metadata?.folder || null,
      uploadDate: file.uploadDate,
    }));

    res.json(reportList);
  } catch (err) {
    console.error("❌ Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

app.get("/get-pdf/:fileId", async (req, res) => {
  try {
    const fileId = new ObjectId(req.params.fileId);
    const downloadStream = bucket.openDownloadStream(fileId);

    res.set("Content-Type", "application/pdf");
    downloadStream.pipe(res);
  } catch (err) {
    console.error("❌ PDF retrieval error:", err);
    res.status(500).json({ error: "Failed to retrieve PDF" });
  }
});

app.delete("/delete-report/:fileId", authMiddleware, async (req, res) => {
  try {
    const fileId = new ObjectId(req.params.fileId);
    await bucket.delete(fileId);
    console.log(`🗑️ Deleted report ID: ${fileId}`);
    res.json({ message: "Report deleted successfully" });
  } catch (err) {
    console.error("❌ Delete error:", err);
    res.status(500).json({ error: "Failed to delete report" });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
