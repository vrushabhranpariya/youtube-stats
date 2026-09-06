/**
 * background.js
 *
 * Minimal service worker. Its ONLY job is to make the cross-origin request
 * to the (optional, third-party) dislike-count provider on behalf of the
 * content script, so that:
 *   - the content script itself needs no cross-origin host permission
 *   - a single place exists to swap/disable the dislike provider
 *
 * No YouTube page data ever passes through this file except a bare videoId.
 */

const RYD_API_BASE = "https://returnyoutubedislike.com/api/v1/votes";
const FETCH_TIMEOUT_MS = 6000;

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "FETCH_DISLIKES") {
    return false; // not for us
  }

  const videoId = String(message.videoId || "").trim();
  // Only ever accept a strict 11-char YouTube video ID shape.
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    sendResponse({ ok: false, error: "invalid_video_id" });
    return false;
  }

  const url = `${RYD_API_BASE}?videoId=${encodeURIComponent(videoId)}`;

  fetchWithTimeout(url, FETCH_TIMEOUT_MS)
    .then(async (res) => {
      if (!res.ok) {
        sendResponse({ ok: false, error: `http_${res.status}` });
        return;
      }
      const data = await res.json();
      // Expected shape from RYD: { dislikes, likes, viewCount, ... }
      if (data && typeof data.dislikes === "number") {
        sendResponse({ ok: true, dislikes: data.dislikes });
      } else {
        sendResponse({ ok: false, error: "malformed_response" });
      }
    })
    .catch((err) => {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    });

  return true; // keep the message channel open for the async sendResponse
});
