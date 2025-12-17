const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const Busboy = require("busboy");
const { google } = require("googleapis");

function getDriveClient() {
  // Service account JSON stored in Firebase config or Secret Manager
  // Placeholder: you will wire this up properly in the setup steps below.
  const sa = JSON.parse(process.env.GDRIVE_SA_JSON);

  const auth = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ["https://www.googleapis.com/auth/drive"]
  );

  return google.drive({ version: "v3", auth });
}

exports.uploadReceipt = functions.https.onRequest(async (req, res) => {
  // Basic CORS (tighten this later)
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

  const EXPECTED_PIN = process.env.UPLOAD_PIN; // set this in your env/secrets
  const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

  try {
    const bb = Busboy({ headers: req.headers });

    let fields = {};
    let fileBuffer = null;
    let fileInfo = { filename: "receipt.jpg", mimetype: "image/jpeg" };

    bb.on("field", (name, val) => {
      fields[name] = val;
    });

    bb.on("file", (name, file, info) => {
      fileInfo = info;
      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("finish", async () => {
      const pin = (fields.pin || "").trim();
      if (!EXPECTED_PIN || !FOLDER_ID) {
        return res.status(500).json({ ok: false, error: "Server not configured." });
      }
      if (pin !== EXPECTED_PIN) {
        return res.status(401).json({ ok: false, error: "Wrong PIN." });
      }
      if (!fileBuffer) {
        return res.status(400).json({ ok: false, error: "No file uploaded." });
      }

      // Create a nice filename
      const safeVendor = (fields.vendor || "receipt").replace(/[^a-z0-9\-_. ]/gi, "").trim();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const amount = (fields.amount || "").trim();
      const filename = `${ts} - ${safeVendor}${amount ? " - $" + amount : ""}`;

      const drive = getDriveClient();

      const uploadRes = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [FOLDER_ID],
        },
        media: {
          mimeType: fileInfo.mimeType || "application/octet-stream",
          body: fileBuffer,
        },
        fields: "id, webViewLink",
      });

      // Optional: store metadata to Firestore for accounting search later
      // await admin.firestore().collection("receiptUploads").add({ ...fields, driveFileId: uploadRes.data.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });

      return res.status(200).json({ ok: true, fileId: uploadRes.data.id, link: uploadRes.data.webViewLink });
    });

    req.pipe(bb);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Upload failed." });
  }
});
