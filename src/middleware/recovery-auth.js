const { RECOVERY_API_KEY, RECOVERY_REQUIRE_AUTH } = require("../config");
const { HttpError } = require("../utils/http-error");

function requireRecoveryAuth(req, res, next) {
  if (!RECOVERY_REQUIRE_AUTH) {
    return next();
  }

  const authHeader = req.headers["authorization"];
  const apiKey = req.query.api_key || req.body?.apiKey;

  let providedKey = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  } else if (apiKey) {
    providedKey = apiKey;
  }

  if (!providedKey) {
    throw new HttpError(401, "Recovery API key required", {
      hint: "Provide API key via Authorization: Bearer <key> header, ?api_key query param, or apiKey body field"
    });
  }

  if (providedKey !== RECOVERY_API_KEY) {
    throw new HttpError(403, "Invalid recovery API key");
  }

  next();
}

function createRecoveryAuthMiddleware() {
  return requireRecoveryAuth;
}

function validateApiKey(key) {
  if (!RECOVERY_REQUIRE_AUTH) {
    return { valid: true, reason: "auth_disabled" };
  }

  if (!key) {
    return { valid: false, reason: "missing_key" };
  }

  if (key !== RECOVERY_API_KEY) {
    return { valid: false, reason: "invalid_key" };
  }

  return { valid: true, reason: "valid" };
}

module.exports = {
  createRecoveryAuthMiddleware,
  requireRecoveryAuth,
  validateApiKey
};
