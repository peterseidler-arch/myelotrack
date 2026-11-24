/**
 * Wrap an async route handler so rejected promises reach Express's error
 * middleware instead of hanging the request.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Throw a 400 with a machine code + message. */
export function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'bad_request';
  return err;
}

/** Build an HTTP error with a status, machine code and message. */
export function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
