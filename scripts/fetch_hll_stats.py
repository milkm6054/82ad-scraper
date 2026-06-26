import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

BASE_PROFILE_URL = "https://hllrecords.com/profiles"
COMMON_EXECUTABLES = [
    Path("/usr/bin/chromium"),
    Path("/usr/bin/chromium-browser"),
    Path("/usr/bin/google-chrome"),
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
]


def build_profile_url(steam_id64: str) -> str:
    return f"{BASE_PROFILE_URL}/{steam_id64}?period=180d&comp="


def detect_browser_executable() -> str | None:
    configured = os.environ.get("BROWSER_EXECUTABLE_PATH", "").strip()
    if configured and Path(configured).exists():
        return configured

    for candidate in COMMON_EXECUTABLES:
        if candidate.exists():
            return str(candidate)
    return None


def extract_area_raw_value(raw_text: str, area_name: str) -> float | None:
    quote = r'(?:\\"|")'
    pattern = (
        rf"{quote}area{quote}\s*:\s*{quote}{re.escape(area_name)}{quote}"
        rf"\s*,\s*{quote}rawValue{quote}\s*:\s*([-+]?\d+(?:\.\d+)?)"
    )
    match = re.search(pattern, raw_text)
    if not match:
        return None
    return float(match.group(1))


def stats_are_present(page_html: str) -> bool:
    return extract_area_raw_value(page_html, "KPM") is not None


def wait_for_stats_payload(page) -> tuple[str, str]:
    last_html = ""
    last_title = ""

    try:
        page.wait_for_load_state("networkidle", timeout=4000)
    except Exception:
        pass

    for _ in range(18):
        try:
            last_title = page.title()
            last_html = page.content()
        except Exception:
            page.wait_for_timeout(300)
            continue

        if stats_are_present(last_html):
            return last_title, last_html

        page.wait_for_timeout(500)

    return last_title, last_html


def build_launch_kwargs(executable_path: str | None) -> dict[str, Any]:
    launch_kwargs: dict[str, Any] = {
        "headless": True,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
        ],
        "chromium_sandbox": False,
    }

    if executable_path:
        launch_kwargs["executable_path"] = executable_path
        if "chrome.exe" in executable_path.lower():
            launch_kwargs["channel"] = "chrome"

    return launch_kwargs


def create_context(playwright):
    executable_path = detect_browser_executable()
    browser = playwright.chromium.launch(**build_launch_kwargs(executable_path))
    context = browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/137.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1366, "height": 900},
        locale="en-US",
    )

    page = context.new_page()
    page.add_init_script(
        """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
window.chrome = { runtime: {} };
"""
    )

    return browser, context, page


def fetch_stats_batch(steam_ids: list[str]) -> list[dict[str, object]]:
    if not steam_ids:
        return []

    with sync_playwright() as playwright:
        browser = None
        context = None
        page = None

        try:
            browser, context, page = create_context(playwright)
            results: list[dict[str, object]] = []

            for steam_id64 in steam_ids:
                source_url = build_profile_url(steam_id64)

                try:
                    page.goto(source_url, wait_until="domcontentloaded", timeout=60000)
                    title, html = wait_for_stats_payload(page)
                    kpm_180 = extract_area_raw_value(html, "KPM")
                    duel_strength_180 = extract_area_raw_value(html, "Duel strength")

                    if kpm_180 is None:
                        raise RuntimeError(f"Unable to extract KPM. Page title was: {title}")

                    results.append(
                        {
                            "steamId64": steam_id64,
                            "sourceUrl": source_url,
                            "pageTitle": title,
                            "kpm180": kpm_180,
                            "duelStrength180": duel_strength_180,
                        }
                    )
                except Exception as exc:
                    results.append(
                        {
                            "steamId64": steam_id64,
                            "sourceUrl": source_url,
                            "kpm180": None,
                            "duelStrength180": None,
                            "error": str(exc),
                        }
                    )

            return results
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass
            if browser is not None:
                try:
                    browser.close()
                except Exception:
                    pass


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "At least one Steam ID is required."}))
        return 1

    steam_ids = [value.strip() for value in sys.argv[1:] if value.strip()]

    try:
        result = fetch_stats_batch(steam_ids)
        print(json.dumps(result[0] if len(result) == 1 else result))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
