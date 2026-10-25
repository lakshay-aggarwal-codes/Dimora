// Stand-in for the `cloudinary` package in the e2e server (no network, no jest).
// upload_stream hands back a fake secure_url/public_id, like tests/mocks/cloudinary.js.
let counter = 0;

const uploader = {
  upload_stream: (options, callback) => ({
    end: () => {
      counter += 1;
      const folder = (options && options.folder) || "e2e";
      setImmediate(() =>
        callback(null, {
          secure_url: `https://res.cloudinary.test/${folder}/image${counter}.jpg`,
          public_id: `${folder}/image${counter}`,
        }),
      );
    },
  }),
  destroy: async () => ({ result: "ok" }),
};

module.exports = { v2: { config: () => {}, uploader } };
