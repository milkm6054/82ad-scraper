const targetUrl = process.env.CRON_TARGET_URL?.trim();
const cronSecret = process.env.CRON_SECRET?.trim();

async function main() {
  if (!targetUrl) {
    console.error("Missing CRON_TARGET_URL.");
    process.exit(1);
  }

  const headers: Record<string, string> = {};
  if (cronSecret) {
    headers.Authorization = `Bearer ${cronSecret}`;
  }

  const response = await fetch(targetUrl, {
    method: "POST",
    headers,
  });

  const text = await response.text();

  if (!response.ok) {
    console.error(`Cron request failed with ${response.status}: ${text}`);
    process.exit(1);
  }

  console.log(text);
}

void main();
