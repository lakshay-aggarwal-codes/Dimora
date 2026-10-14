// Stand-in for the `cloudinary` package (mapped in jest.config.js).
// upload_stream calls back with a fake secure_url/public_id; destroy records
// the public id. Override per test with e.g.
//   cloudinary.v2.uploader.upload_stream.mockImplementationOnce(...)
let counter = 0;

const uploader = {
  upload_stream: jest.fn((options, callback) => ({
    end: () => {
      counter += 1;
      const folder = (options && options.folder) || "test";
      setImmediate(() =>
        callback(null, {
          secure_url: `https://res.cloudinary.test/${folder}/image${counter}.jpg`,
          public_id: `${folder}/image${counter}`,
        }),
      );
    },
  })),
  destroy: jest.fn(async () => ({ result: "ok" })),
};

module.exports = {
  v2: { config: jest.fn(), uploader },
  __resetCounter: () => {
    counter = 0;
  },
};
