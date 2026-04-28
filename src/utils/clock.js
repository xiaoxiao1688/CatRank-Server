function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date(nowMs()).toISOString();
}

module.exports = {
  nowMs,
  isoNow
};
