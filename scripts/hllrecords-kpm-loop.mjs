const intervalMinutes = Number(process.env.HLLRECORDS_KPM_INTERVAL_MINUTES || 30);
const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
const port = process.env.PORT || "3000";
const refreshUrl =
  process.env.INTERNAL_HLLRECORDS_KPM_URL || `http://127.0.0.1:${port}/api/hllrecords/enrich?mode=pending`;

async function refreshPendingKpm() {
  try {
    const response = await fetch(refreshUrl, { method: "POST" });
    const text = await response.text();

    if (!response.ok) {
      console.error(`[hll-kpm] ${response.status} ${text}`);
      return;
    }

    console.log(`[hll-kpm] complete ${text}`);
  } catch (error) {
    console.error("[hll-kpm] failed", error);
  }
}

console.log(`[hll-kpm] scheduled every ${intervalMinutes} minutes via ${refreshUrl}`);
setTimeout(() => {
  void refreshPendingKpm();
}, 45000);
setInterval(() => {
  void refreshPendingKpm();
}, intervalMs);
