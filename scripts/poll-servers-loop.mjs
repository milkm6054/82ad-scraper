const intervalMinutes = Number(process.env.POLL_INTERVAL_MINUTES || 120);
const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
const port = process.env.PORT || "3000";
const pollUrl = process.env.INTERNAL_POLL_URL || `http://127.0.0.1:${port}/api/poll`;

async function runPoll() {
  try {
    const response = await fetch(pollUrl, { method: "POST" });
    const text = await response.text();

    if (!response.ok) {
      console.error(`[poll] ${response.status} ${text}`);
      return;
    }

    console.log(`[poll] complete ${text}`);
  } catch (error) {
    console.error("[poll] failed", error);
  }
}

console.log(`[poll] scheduled every ${intervalMinutes} minutes via ${pollUrl}`);
setTimeout(() => {
  void runPoll();
}, 30000);
setInterval(() => {
  void runPoll();
}, intervalMs);
