const targetUrl = process.env.CRON_TARGET_URL?.trim();
const cronSecret = process.env.CRON_SECRET?.trim();

if (!targetUrl) {
  console.error("[82ad-cron] Missing CRON_TARGET_URL.");
  process.exit(1);
}

const headers = {};
if (cronSecret) {
  headers.authorization = `Bearer ${cronSecret}`;
}

try {
  const response = await fetch(targetUrl, {
    method: "POST",
    headers,
  });
  const text = await response.text();

  if (!response.ok) {
    console.error(`[82ad-cron] ${response.status} ${text}`);
    process.exit(1);
  }

  console.log(`[82ad-cron] ${text}`);
} catch (error) {
  console.error("[82ad-cron] failed", error);
  process.exit(1);
}
