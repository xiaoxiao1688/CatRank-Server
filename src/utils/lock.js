const fsp = require("fs/promises");

const { LOCK_RETRY_MS, LOCK_TIMEOUT_MS } = require("../config");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFileLock(targetPath, callback) {
  const lockPath = `${targetPath}.lock`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      const handle = await fsp.open(lockPath, "wx");
      try {
        return await callback();
      } finally {
        await handle.close();
        await fsp.unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      await delay(LOCK_RETRY_MS);
    }
  }

  throw new Error(`Timed out waiting for lock: ${lockPath}`);
}

module.exports = {
  withFileLock
};
