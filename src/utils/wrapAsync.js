module.exports = (fn) => {
  return (req, res, next) => {
    // Also fine for a plain (non-async) handler: its return value is not a promise.
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
