const cloudinary = require("cloudinary").v2;
const multer = require("multer");

const { ValidationError } = require("../utils/errors");

// Credentials are applied by createApp() (src/app.js), not when this file is
// required, so importing it has no side effects.
function configureCloudinary({ cloudName, apiKey, apiSecret }) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
}

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Files are held in memory, then streamed to Cloudinary by uploadToCloudinary.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new ValidationError("Only PNG and JPEG images are allowed"));
  },
});

function uploadBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "dimora_DEV" },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });
}

// Runs after upload.single(...). Sets req.file.path / req.file.filename to the
// same values multer-storage-cloudinary used to set, so controllers are unchanged.
async function uploadToCloudinary(req, res, next) {
  try {
    if (req.file) {
      const result = await uploadBuffer(req.file.buffer);
      req.file.path = result.secure_url;
      req.file.filename = result.public_id;
      delete req.file.buffer;
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  cloudinary,
  configureCloudinary,
  upload,
  uploadToCloudinary,
};
