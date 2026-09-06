# YouTube Engagement Stats

A Manifest V3 Chrome extension that shows **like**, **dislike**, and **comment**
counts under video cards on YouTube, on the watch page, and on Shorts.

```
👍 125K   👎 3.2K   💬 1.8K
```

No build step, no framework, no API key required from you.

---

## 1. What it does

Adds a small, YouTube-styled row of engagement stats directly beneath each
video's existing metadata (below "3.4K views • 2 days ago"), and beneath the
metadata on the watch page.

## 2. Features

- Works across YouTube's SPA navigation (no refresh needed)
- Lazy-loads stats only for cards near/in the viewport (`IntersectionObserver`)
- Caches results in memory with a 30-minute TTL
- De-duplicates requests — if the same video appears 10 times on a page,
  only one network request is made per data type
- Concurrency-limited request queue (max 3 in flight) — never floods the
  network
- Graceful `N/A` on any failure; a missing dislike count never blocks likes
  or comments
- Dark mode and light mode support
- Debug logging behind a single `DEBUG` flag

## 3. Supported YouTube locations

Homepage, search results, subscriptions feed, channel video lists/home,
playlists, watch history, watch-later, recommended/related/sidebar videos,
video grids, Shorts, trending/explore, and the watch page. Detection uses
known YouTube renderer element names first, then falls back to generic
anchor/URL scanning, so newly introduced card types are still picked up as
long as they link to a video.

## 4. Installation (unpacked)

1. Download/clone this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the `youtube-engagement-stats` folder.
6. Open or reload `youtube.com`.

## 5. How likes are obtained

YouTube does **not** include like counts on video-card feed data at all —
only on a video's own watch page. So, when a card scrolls near the
viewport, the extension fetches that video's public watch page
(`https://www.youtube.com/watch?v=ID`, same-origin, no extra permission
needed) and parses the like count out of the `ytInitialData` JSON blob
YouTube embeds in that page — specifically the accessibility label on the
Like button (e.g. `"125,432 likes"`). **This is public data any browser
receives**, but the exact JSON shape is unofficial/reverse-engineered and
can change without notice.

## 6. How dislikes are obtained

YouTube removed public dislike counts in December 2021. This extension
queries the third-party **Return YouTube Dislike (RYD)** project's public
API, via the extension's background service worker (so the content script
itself needs no cross-origin permission). RYD sources its numbers from
historical data plus its own userbase's votes — it is **not** YouTube's
own data and is not guaranteed complete or exact.

## 7. Why dislikes can show N/A

- RYD has no record for that video
- The RYD API is down, rate-limited, or times out (6s timeout)
- The video is new / very obscure

Likes and comments are unaffected — they are fetched independently.

## 8. How comments are obtained

Parsed from the same `ytInitialData` blob as likes, using the
`commentCount` field YouTube's own comments-section header renders from.
Same caveats as likes: public data, unofficial format.

## 9. Caching

In-memory `Map` keyed by video ID, 30-minute TTL (`Config.CACHE_TTL_MS`).
Combined with the request queue's in-flight de-duplication, this means a
video is fetched **at most once** per 30 minutes regardless of how many
times it appears on screen.

## 10. API limitations

- No official YouTube Data API is used, so **no API key is required** —
  but this also means data comes from scraping public HTML, which is
  inherently less stable than an official API.
- RYD is a volunteer-run third-party service with its own uptime and rate
  limits, outside this extension's control.
- Extremely fresh videos may not yet have propagated stats.

## 11. Troubleshooting

- **Nothing shows up:** confirm the extension is enabled and you're on
  `https://www.youtube.com/*`; check `chrome://extensions` for errors.
- **Everything shows N/A:** YouTube likely changed its internal markup;
  see "How to modify" below, or file an issue with a sample video ID.
- **Slow to appear:** stats only fetch once a card nears the viewport —
  scroll it into view, or wait a moment on the watch page.

## 12. Enabling DEBUG mode

Open `content.js`, find:

```js
const Config = {
  DEBUG: false,
  ...
```

Set `DEBUG: true`, reload the extension in `chrome://extensions`, and
reload YouTube. Console messages like `[YT Engagement] Fetching stats: ID`
will appear.

## 13. Modifying the dislike provider

`content.js` defines an abstract `DislikeProvider` class with a single
`getCount(videoId)` method, and a default `ReturnYouTubeDislikeProvider`
implementation. To use a different service:

1. Add a class extending `DislikeProvider` implementing `getCount`.
2. If it needs a cross-origin request, add its domain to `host_permissions`
   in `manifest.json` and proxy the call through `background.js` (same
   pattern as the RYD call), to keep the content script CORS-clean.
3. Change the `activeDislikeProvider` assignment near the bottom of
   Section F in `content.js`.

## 14. Privacy considerations

- No YouTube/Google credentials are ever requested or stored.
- The extension sends video IDs (11-character public identifiers) to
  `returnyoutubedislike.com` to look up dislike counts, and fetches
  YouTube's own watch pages for like/comment counts. No other browsing
  data, cookies, or personal information is transmitted anywhere.
- All processing/caching is in-memory for the life of the tab; nothing is
  written to disk.

## 15. Known limitations

- Like/comment scraping depends on YouTube's current unofficial page
  structure; it can break on YouTube redesigns until this extension is
  updated.
- Dislike counts reflect RYD's dataset, not YouTube's internal number.
- Age-restricted, private, or deleted videos will generally show `N/A`
  across the board, since their watch pages don't expose normal stats.
- Fetching each video's full watch page HTML (rather than a lightweight
  API) is heavier than an official API call would be; the lazy-loading,
  caching, and request-queue logic exist specifically to keep this
  reasonable, but very large pages with hundreds of unique videos will
  still generate a proportional number of background requests over time.
