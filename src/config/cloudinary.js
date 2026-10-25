const cloudinary = require("cloudinary").v2;
const multer = require("multer");

// Credentials are applied by createApp() (src/app.js), not when this file is
// required, so importing it has no side effects.
function configureCloudinary({ cloudName, apiKey, apiSecret }) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
}

const UPLOAD_FOLDER = "dimora_DEV";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;
// Cloudinary refuses anything that is not one of these, whatever the browser
// said it was (defence in depth: src/services/images.js already checks the
// first bytes of every file before it is sent).
const ALLOWED_FORMATS = ["jpg", "png", "webp"];

// Files are held in memory, then streamed to Cloudinary. There is deliberately
// no fileFilter on the declared type: the browser chooses that, so it proves
// nothing. src/services/images.js looks at the file's real first bytes.
// Text fields of a multipart form are limited too (P17-T02): multer's default
// allows any number of fields of 1 MB each.
const limits = { fileSize: MAX_IMAGE_BYTES, fieldSize: 100 * 1024, fields: 100 };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { ...limits, files: 1 },
});
const uploadPhotos = multer({
  storage: multer.memoryStorage(),
  limits: { ...limits, files: MAX_UPLOAD_FILES },
});

function uploadBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: UPLOAD_FOLDER,
        resource_type: "image",
        allowed_formats: ALLOWED_FORMATS,
      },
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

// Best-effort removal of an image we uploaded (replaced image, or an upload
// whose listing could not be saved). Never throws: a leftover image is not worth
// failing the request. Ignores ids outside our folder (e.g. old seed data).
async function deleteImage(publicId, log) {
  if (typeof publicId !== "string" || !publicId.startsWith("dimora_")) {
    return false;
  }
  try {
    await cloudinary.uploader.destroy(publicId);
    return true;
  } catch (err) {
    if (log) log.warn({ err, publicId }, "could not delete image");
    return false;
  }
}

module.exports = {
  cloudinary,
  UPLOAD_FOLDER,
  deleteImage,
  configureCloudinary,
  upload,
  uploadPhotos,
  uploadBuffer,
  uploadToCloudinary,
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_FILES,
  ALLOWED_FORMATS,
};
