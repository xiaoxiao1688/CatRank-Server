const crypto = require("crypto");
const {
  ADMIN_API_KEY,
  RECOVERY_REQUIRES_AUTH,
  RECOVERY_AUTH_HEADER
} = require("../config");
const { HttpError } = require("../utils/http-error");

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isAuthEnabled() {
  return RECOVERY_REQUIRES_AUTH && ADMIN_API_KEY !== null;
}

function validateRecoveryApiKey(apiKey) {
  if (!isAuthEnabled()) {
    return { valid: true, message: "Auth disabled or no API key configured" };
  }

  if (!apiKey) {
    return { valid: false, message: "Missing API key" };
  }

  if (!timingSafeEqual(apiKey, ADMIN_API_KEY)) {
    return { valid: false, message: "Invalid API key" };
  }

  return { valid: true, message: "Valid API key" };
}

function requireRecoveryAuth(req, _res, next) {
  if (!isAuthEnabled()) {
    return next();
  }

  const apiKey = req.headers[RECOVERY_AUTH_HEADER.toLowerCase()] || 
                  req.headers["x-api-key"] ||
                  req.query.api_key;

  const validation = validateRecoveryApiKey(apiKey);

  if (!validation.valid) {
    throw new HttpError(401, `Recovery API access denied: ${validation.message}`, {
      headerRequired: RECOVERY_AUTH_HEADER
    });
  }

  next();
}

function createRecoveryAuthMiddleware(options = {}) {
  const { requireAuth = RECOVERY_REQUIRES_AUTH } = options;
  
  if (!requireAuth || !isAuthEnabled()) {
    return (_req, _res, next) => next();
  }

  return requireRecoveryAuth;
}

module.exports = {
  validateRecoveryApiKey,
  requireRecoveryAuth,
  createRecoveryAuthMiddleware,
  timingSafeEqual,
  isAuthEnabled
};
