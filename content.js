/**
 * YouTube Engagement Stats — content.js
 *
 * Adds like / dislike / comment counts under video cards, on the watch
 * page, and on Shorts.
 *
 * DATA SOURCES (see README for full detail):
 *  - Likes & comments: parsed from the same public "ytInitialData" JSON
 *    blob YouTube itself embeds in every watch page it serves. This is
 *    NOT a private/undocumented API — it is the data YouTube's own page
 *    renders from. It IS an unofficial reverse-engineered format that can
 *    change without notice.
 *  - Dislikes: YouTube stopped exposing this publicly in Dec 2021. We
 *    query the third-party "Return YouTube Dislike" (RYD) project via the
 *    background service worker. If RYD has no data, we show N/A — never
 *    an estimate.
 *
 * Architecture (see README "Architecture" section for the diagram):
 *   Config -> Logger -> NumberFormatter -> CacheManager -> RequestQueue
 *   -> DislikeProvider -> StatsFetcher -> StatsManager -> VideoIdExtractor
 *   -> StatsRenderer -> YouTubeDetector -> NavigationManager -> bootstrap
 */
(() => {
  "use strict";

  // ============================================================
  // A. CONFIG
  // ============================================================
  const Config = {
    DEBUG: false,
    ENABLE_LIKES: true,
    ENABLE_DISLIKES: true,
    ENABLE_COMMENTS: true,
    ENABLE_SHORTS: true,
    COMPACT_NUMBERS: true, // false => exact numbers e.g. 125,432
    CACHE_TTL_MS: 30 * 60 * 1000, // 30 minutes
    MAX_CONCURRENT_FETCHES: 3,
    FETCH_TIMEOUT_MS: 8000,
    MUTATION_DEBOUNCE_MS: 250,
    INTERSECTION_ROOT_MARGIN: "600px 0px 600px 0px", // prefetch a bit before entering view
    MARKER_ATTR: "data-yt-engagement-stats",
    CONTAINER_CLASS: "yt-engagement-stats",
  };

  // ============================================================
  // B. LOGGER
  // ============================================================
  const Logger = {
    log(...args) {
      if (Config.DEBUG) console.log("[YT Engagement]", ...args);
    },
    warn(...args) {
      if (Config.DEBUG) console.warn("[YT Engagement]", ...args);
    },
    error(...args) {
      if (Config.DEBUG) console.error("[YT Engagement]", ...args);
    },
  };

  // ============================================================
  // C. NUMBER FORMATTER
  // ============================================================
  const NumberFormatter = {
    /** Parses "1,234", "12.5K", "1.2M", "125K" etc. into an integer. */
    parseToNumber(raw) {
      if (raw == null) return null;
      if (typeof raw === "number") return raw;
      const s = String(raw).trim().toUpperCase();
      if (!s) return null;
      const m = s.match(/^([\d,.]+)\s*([KMB])?$/);
      if (!m) return null;
      let num = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isNaN(num)) return null;
      const suffix = m[2];
      if (suffix === "K") num *= 1e3;
      else if (suffix === "M") num *= 1e6;
      else if (suffix === "B") num *= 1e9;
      return Math.round(num);
    },
    compact(n) {
      if (n == null || Number.isNaN(n)) return "N/A";
      if (n < 1000) return String(n);
      const units = [
        { v: 1e9, s: "B" },
        { v: 1e6, s: "M" },
        { v: 1e3, s: "K" },
      ];
      for (const u of units) {
        if (n >= u.v) {
          const val = n / u.v;
          const rounded = val >= 100 ? Math.round(val) : Math.round(val * 10) / 10;
          return `${rounded}${u.s}`;
        }
      }
      return String(n);
    },
    exact(n) {
      if (n == null || Number.isNaN(n)) return "N/A";
      return n.toLocaleString("en-US");
    },
    display(n) {
      if (n == null || Number.isNaN(n)) return "N/A";
      return Config.COMPACT_NUMBERS ? this.compact(n) : this.exact(n);
    },
  };

  // ============================================================
  // D. CACHE MANAGER
  // ============================================================
  class CacheManager {
    constructor(ttlMs) {
      this.ttlMs = ttlMs;
      this.mem = new Map(); // videoId -> { data, timestamp }
    }

    get(videoId) {
      const entry = this.mem.get(videoId);
      if (!entry) return null;
      if (Date.now() - entry.timestamp > this.ttlMs) {
        this.mem.delete(videoId);
        return null;
      }
      return entry.data;
    }

    set(videoId, data) {
      this.mem.set(videoId, { data, timestamp: Date.now() });
    }

    merge(videoId, partial) {
      const existing = this.get(videoId) || {};
      const merged = { ...existing, ...partial };
      this.set(videoId, merged);
      return merged;
    }
  }

  const cache = new CacheManager(Config.CACHE_TTL_MS);

  // ============================================================
  // E. REQUEST QUEUE (concurrency limit + in-flight de-duplication)
  // ============================================================
  class RequestQueue {
    constructor(maxConcurrent) {
      this.maxConcurrent = maxConcurrent;
      this.active = 0;
      this.pending = [];
      this.inFlight = new Map(); // key -> Promise (dedup identical requests)
    }

    /** Runs fn() respecting concurrency; identical `key` calls share one Promise. */
    run(key, fn) {
      if (this.inFlight.has(key)) {
        return this.inFlight.get(key);
      }
      const promise = new Promise((resolve) => {
        const task = async () => {
          this.active++;
          try {
            const result = await fn();
            resolve(result);
          } catch (err) {
            Logger.warn("Queue task failed", key, err);
            resolve(null);
          } finally {
            this.active--;
            this.inFlight.delete(key);
            this._drain();
          }
        };
        if (this.active < this.maxConcurrent) {
          task();
        } else {
          this.pending.push(task);
        }
      });
      this.inFlight.set(key, promise);
      return promise;
    }

    _drain() {
      while (this.active < this.maxConcurrent && this.pending.length > 0) {
        const next = this.pending.shift();
        next();
      }
    }
  }

  const requestQueue = new RequestQueue(Config.MAX_CONCURRENT_FETCHES);

  // ============================================================
  // F. DISLIKE PROVIDER (swappable abstraction)
  // ============================================================
  class DislikeProvider {
    // eslint-disable-next-line no-unused-vars
    async getCount(videoId) {
      throw new Error("Not implemented");
    }
  }

  /**
   * Default implementation: Return YouTube Dislike (RYD).
   * The actual network call happens in background.js so this content
   * script needs no cross-origin host permission of its own.
   * To swap providers later, implement DislikeProvider and change the
   * `activeDislikeProvider` assignment near the bottom of this section.
   */
  class ReturnYouTubeDislikeProvider extends DislikeProvider {
    async getCount(videoId) {
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "FETCH_DISLIKES", videoId }, (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(res);
          });
        });
        if (response && response.ok) return response.dislikes;
        Logger.warn("Dislike lookup failed", videoId, response && response.error);
        return null;
      } catch (err) {
        Logger.warn("Dislike provider threw", err);
        return null;
      }
    }
  }

  const activeDislikeProvider = new ReturnYouTubeDislikeProvider();

  // ============================================================
  // G. STATS FETCHER — extracts likes/comments from a video's public
  //    watch-page HTML (the same markup any visitor's browser receives).
  // ============================================================
  const StatsFetcher = {
    /** Pulls the raw JSON text of `var ytInitialData = {...};` out of an HTML string. */
    extractInitialDataJson(html) {
      const marker = "ytInitialData";
      const idx = html.indexOf(marker);
      if (idx === -1) return null;
      const braceStart = html.indexOf("{", idx);
      if (braceStart === -1) return null;
      let depth = 0;
      for (let i = braceStart; i < html.length; i++) {
        const ch = html[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return html.slice(braceStart, i + 1);
          }
        }
      }
      return null;
    },

    /** Best-effort like-count extraction. Returns integer or null. */
    parseLikeCount(html) {
      // Primary: accessibility label on the like toggle button, e.g.
      // "accessibilityData":{"label":"125,432 likes"}
      const m1 = html.match(/"accessibilityData":\{"label":"([\d,]+) likes?"\}/i);
      if (m1) return NumberFormatter.parseToNumber(m1[1]);

      // Fallback: compact label sometimes rendered directly on the button,
      // e.g. "text":{"simpleText":"125K"} immediately following a like glyph
      // context. This is heuristic and may over/under-match; only used if
      // the primary pattern is absent.
      const m2 = html.match(/like this video along with ([\d,]+) other people/i);
      if (m2) return NumberFormatter.parseToNumber(m2[1]);

      return null;
    },

    /**
     * Best-effort comment-count extraction. Returns integer or null.
     * YouTube has moved this field around across redesigns, so several
     * independent patterns are tried, most-reliable first. If none match,
     * the caller correctly falls back to displaying N/A rather than
     * guessing.
     */
    parseCommentCount(html) {
      // Pattern 1: accessibility label, mirrors the like-count approach,
      // e.g. "accessibilityData":{"label":"12,431 Comments"}
      const m1 = html.match(/"accessibilityData":\{"label":"([\d,.]+[KMB]?) Comments?"\}/i);
      if (m1) return NumberFormatter.parseToNumber(m1[1]);

      // Pattern 2: comments header count text,
      // e.g. "commentsHeaderRenderer":{"countText":{"runs":[{"text":"12K Comments"}]}}
      const m2 = html.match(
        /"commentsHeaderRenderer":\{"countText":\{"runs":\[\{"text":"([\d,.]+[KMB]?)\s*Comments?"?\}\]/i
      );
      if (m2) return NumberFormatter.parseToNumber(m2[1]);

      // Pattern 3: contextual info runs, e.g.
      // "contextualInfo":{"runs":[{"text":"12,431 Comments"}]}
      const m3 = html.match(/"contextualInfo":\{"runs":\[\{"text":"([\d,.]+[KMB]?)\s*Comments?"\}\]/i);
      if (m3) return NumberFormatter.parseToNumber(m3[1]);

      // Pattern 4 (older/alternate structure): plain commentCount simpleText,
      // e.g. "commentCount":{"simpleText":"12,431"}
      const m4 = html.match(/"commentCount":\{"simpleText":"([\d,.]+[KMB]?)"\}/i);
      if (m4) return NumberFormatter.parseToNumber(m4[1]);

      return null;
    },

    /**
     * Fetches a video's watch page and extracts likes + comments.
     * Uses same-origin fetch (page is https://www.youtube.com/*, same as
     * the content script), so no extra host permission is required.
     */
    async fetchLikesAndComments(videoId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Config.FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
          credentials: "omit",
          signal: controller.signal,
        });
        if (!res.ok) return { likes: null, comments: null };
        const html = await res.text();
        const likes = Config.ENABLE_LIKES ? this.parseLikeCount(html) : null;
        const comments = Config.ENABLE_COMMENTS ? this.parseCommentCount(html) : null;
        if (Config.ENABLE_COMMENTS && comments == null) {
          Logger.warn("Comment count pattern did not match for", videoId, "— YouTube markup may have changed.");
        }
        return { likes, comments };
      } catch (err) {
        Logger.warn("fetchLikesAndComments failed", videoId, err);
        return { likes: null, comments: null };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  // ============================================================
  // H. STATS MANAGER — orchestrates cache -> queue -> fetchers
  // ============================================================
  const StatsManager = {
    /**
     * Returns { likes, dislikes, comments } (numbers or null) for a videoId,
     * using cache first, then de-duplicated network requests.
     */
    async getStats(videoId) {
      const cached = cache.get(videoId);
      if (cached && cached.complete) {
        Logger.log("Cache hit:", videoId);
        return cached;
      }

      Logger.log("Fetching stats:", videoId);
      const [likesComments, dislikes] = await Promise.all([
        requestQueue.run(`lc:${videoId}`, () => StatsFetcher.fetchLikesAndComments(videoId)),
        Config.ENABLE_DISLIKES
          ? requestQueue.run(`dl:${videoId}`, () => activeDislikeProvider.getCount(videoId))
          : Promise.resolve(null),
      ]);

      const data = {
        likes: likesComments ? likesComments.likes : null,
        comments: likesComments ? likesComments.comments : null,
        dislikes,
        complete: true,
      };
      cache.set(videoId, data);
      return data;
    },
  };

  // ============================================================
  // I. VIDEO ID EXTRACTOR
  // ============================================================
  const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

  const VideoIdExtractor = {
    fromUrl(url) {
      if (!url) return null;
      try {
        const u = new URL(url, location.origin);
        const path = u.pathname;

        if (path === "/watch") {
          const v = u.searchParams.get("v");
          if (v && VIDEO_ID_RE.test(v)) return v;
          return null;
        }
        const shortsMatch = path.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (shortsMatch) return shortsMatch[1];

        const liveMatch = path.match(/^\/live\/([a-zA-Z0-9_-]{11})/);
        if (liveMatch) return liveMatch[1];

        const embedMatch = path.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
        if (embedMatch) return embedMatch[1];

        return null;
      } catch {
        return null;
      }
    },

    /** Attempts several strategies to find a video ID belonging to a card element. */
    extractVideoId(element) {
      if (!element || !(element instanceof Element)) return null;

      // Strategy 1: element itself is/has a thumbnail or title anchor.
      const anchorSelectors = [
        "a#thumbnail",
        "a#video-title-link",
        "a#video-title",
        "a.ytd-thumbnail",
        "a[href*='/watch?v=']",
        "a[href*='/shorts/']",
        "a[href*='/live/']",
        "a[href*='/embed/']",
      ];
      for (const sel of anchorSelectors) {
        const a = element.matches(sel) ? element : element.querySelector(sel);
        if (a && a.getAttribute) {
          const id = this.fromUrl(a.getAttribute("href"));
          if (id) return id;
        }
      }

      // Strategy 2: any anchor at all inside the element.
      const anyAnchor = element.querySelectorAll ? element.querySelectorAll("a[href]") : [];
      for (const a of anyAnchor) {
        const id = this.fromUrl(a.getAttribute("href"));
        if (id) return id;
      }

      // Strategy 3: some custom elements expose a video-id-ish data attribute.
      const dataId =
        element.getAttribute && (element.getAttribute("video-id") || element.getAttribute("data-video-id"));
      if (dataId && VIDEO_ID_RE.test(dataId)) return dataId;

      return null;
    },
  };

  // ============================================================
  // J. STATS RENDERER
  // ============================================================
  const ICONS = {
    like:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>',
    dislike:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="transform:scaleY(-1)"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>',
    comment:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>',
  };

  const StatsRenderer = {
    buildLoadingElement() {
      return this._buildElement({ likes: "…", dislikes: "…", comments: "…" });
    },

    buildStatsElement(stats) {
      return this._buildElement({
        likes: Config.ENABLE_LIKES ? NumberFormatter.display(stats.likes) : null,
        dislikes: Config.ENABLE_DISLIKES ? NumberFormatter.display(stats.dislikes) : null,
        comments: Config.ENABLE_COMMENTS ? NumberFormatter.display(stats.comments) : null,
      });
    },

    _buildElement({ likes, dislikes, comments }) {
      const container = document.createElement("div");
      container.className = Config.CONTAINER_CLASS;
      container.setAttribute(Config.MARKER_ATTR, "true");

      const addItem = (iconSvg, value, label) => {
        if (value == null) return;
        const item = document.createElement("span");
        item.className = "yt-engagement-item";
        item.title = label;
        const icon = document.createElement("span");
        icon.className = "yt-engagement-icon";
        icon.innerHTML = iconSvg; // static, trusted, inline SVG constants only
        const text = document.createElement("span");
        text.className = "yt-engagement-value";
        text.textContent = String(value); // never innerHTML for API-derived text
        item.appendChild(icon);
        item.appendChild(text);
        container.appendChild(item);
      };

      addItem(ICONS.like, likes, "Likes");
      addItem(ICONS.dislike, dislikes, "Dislikes (via Return YouTube Dislike)");
      addItem(ICONS.comment, comments, "Comments");

      return container;
    },

    /**
     * Finds the element we should insert stats *after*. Preference order:
     *   1. The title's enclosing "#meta" block (title + channel + metadata
     *      line all together) — this naturally places stats below the
     *      title AND below the existing views/date line in one step, and
     *      is requested explicitly as the primary anchor since it's the
     *      most consistently-present element across card types.
     *   2. The title element's own parent, if no "#meta" wrapper exists.
     *   3. The classic metadata-line-based search (older/alternate markup).
     *   4. The closest generic content region, as a last resort.
     */
    findAnchorContainer(cardElement) {
      const titleSelectors = [
        "#video-title-link",
        "#video-title",
        "a#video-title-link",
        "yt-formatted-string#video-title",
      ];
      for (const sel of titleSelectors) {
        const titleEl = cardElement.querySelector(sel);
        if (titleEl) {
          const metaWrap = titleEl.closest("#meta");
          if (metaWrap) return metaWrap;
          if (titleEl.parentElement) return titleEl.parentElement;
        }
      }

      const metadataSelectors = [
        "#metadata-line",
        "ytd-video-meta-block #metadata",
        "#metadata",
        ".metadata-snippet-container",
        "#byline-container",
      ];
      for (const sel of metadataSelectors) {
        const el = cardElement.querySelector(sel);
        if (el) return el.closest("#meta") || el.parentElement || el;
      }

      return (
        cardElement.querySelector("#dismissible #details") ||
        cardElement.querySelector("#details") ||
        cardElement.querySelector("#meta") ||
        null // signals "append to cardElement itself" to caller
      );
    },

    /** Inserts (or replaces) the stats block right after the anchor container. */
    render(cardElement, node) {
      const existing = cardElement.querySelector(`[${Config.MARKER_ATTR}]`);
      if (existing) {
        existing.replaceWith(node);
        return;
      }
      const anchor = this.findAnchorContainer(cardElement);
      if (anchor && anchor.parentElement) {
        anchor.parentElement.insertBefore(node, anchor.nextSibling);
      } else {
        cardElement.appendChild(node);
      }
    },

    hasStats(cardElement) {
      return !!cardElement.querySelector(`[${Config.MARKER_ATTR}]`);
    },
  };

  // ============================================================
  // K. YOUTUBE DETECTOR — finds video-card containers
  // ============================================================
  // NOTE: intentionally excludes "ytd-rich-grid-media" — it is always nested
  // inside "ytd-rich-item-renderer" for the same video, and including both
  // caused the same card to be detected (and stats-inserted) twice.
  const KNOWN_CARD_SELECTORS = [
    "ytd-video-renderer",
    "ytd-rich-item-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-playlist-panel-video-renderer",
  ].join(",");

  // Comments contain auto-linked timestamps (and reply/heart controls) that
  // point back to the current video's /watch?v= URL. Without excluding this
  // region, those incidental links get mistaken for video cards and every
  // comment ends up "detected" as the currently playing video.
  const EXCLUDED_CONTAINER_SELECTOR =
    "ytd-comments, ytd-comment-thread-renderer, ytd-comment-renderer, ytd-comment-view-model, #comments";

  const YouTubeDetector = {
    /** Finds the nearest ancestor-or-self "stable" card root for any element. */
    normalizeToStableRoot(el) {
      if (!el) return el;
      const stable = el.closest(KNOWN_CARD_SELECTORS);
      return stable || el;
    },

    isInExcludedRegion(el) {
      return !!(el && el.closest && el.closest(EXCLUDED_CONTAINER_SELECTOR));
    },

    findCardElements(root = document) {
      if (this.isInExcludedRegion(root)) return [];

      let candidates = Array.from(root.querySelectorAll(KNOWN_CARD_SELECTORS)).filter(
        (el) => !this.isInExcludedRegion(el)
      );

      if (candidates.length === 0) {
        // Generic fallback: containers that hold a watch/shorts/live anchor.
        const anchors = Array.from(
          root.querySelectorAll("a[href*='/watch?v='], a[href*='/shorts/'], a[href*='/live/']")
        ).filter((a) => !this.isInExcludedRegion(a));
        const generic = new Set();
        anchors.forEach((a) => {
          const container =
            a.closest(KNOWN_CARD_SELECTORS) ||
            a.closest("[class*='renderer'], [class*='item'], li, div[role='article']");
          if (container && !this.isInExcludedRegion(container)) generic.add(container);
        });
        candidates = Array.from(generic);
      }

      // Safety net: if any remaining candidate is nested inside another
      // candidate (e.g. future YouTube markup re-introduces nesting), keep
      // only the outer-most one so a single video is never processed twice.
      return candidates.filter(
        (el) => !candidates.some((other) => other !== el && other.contains(el))
      );
    },

    isShortsCard(el) {
      return el.tagName === "YTD-REEL-ITEM-RENDERER" || !!el.closest("ytd-shorts, #shorts-container");
    },

    isWatchPage() {
      return location.pathname === "/watch";
    },
  };

  // ============================================================
  // L. PROCESSING PIPELINE (per-card): id -> cache -> render
  // ============================================================
  const processedCards = new WeakSet();

  async function processCard(rawElement) {
    // Always work against the stable outer card root, even if a nested or
    // transient element triggered this call. This is what prevents the
    // same visual card from ever getting two stats blocks.
    const cardElement = YouTubeDetector.normalizeToStableRoot(rawElement);

    if (StatsRenderer.hasStats(cardElement)) return; // already rendered on this exact root
    if (processedCards.has(cardElement)) return; // already in flight for this exact root
    if (YouTubeDetector.isShortsCard(cardElement) && !Config.ENABLE_SHORTS) return;

    const videoId = VideoIdExtractor.extractVideoId(cardElement);
    if (!videoId) return;

    processedCards.add(cardElement);
    Logger.log("Detected video:", videoId);

    // Loading state immediately so layout doesn't jump.
    StatsRenderer.render(cardElement, StatsRenderer.buildLoadingElement());

    const stats = await StatsManager.getStats(videoId);

    // The card may have been removed/re-rendered while we awaited, or may
    // have already received stats from a different trigger in the meantime.
    if (!document.contains(cardElement)) return;
    if (StatsRenderer.hasStats(cardElement) && cardElement.__ytStatsFinal) return;

    StatsRenderer.render(cardElement, StatsRenderer.buildStatsElement(stats));
    cardElement.__ytStatsFinal = true;
    Logger.log("Rendered stats:", videoId, stats);
  }

  // ============================================================
  // M. LAZY LOADING (IntersectionObserver)
  // ============================================================
  const observedCards = new WeakSet();

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          intersectionObserver.unobserve(entry.target);
          observedCards.delete(entry.target);
          processCard(entry.target);
        }
      }
    },
    { root: null, rootMargin: Config.INTERSECTION_ROOT_MARGIN, threshold: 0.01 }
  );

  function scheduleCard(cardElement) {
    if (observedCards.has(cardElement) || processedCards.has(cardElement)) return;
    observedCards.add(cardElement);
    intersectionObserver.observe(cardElement);
  }

  function scanForCards(root = document) {
    const cards = YouTubeDetector.findCardElements(root);
    cards.forEach(scheduleCard);
  }

  // ============================================================
  // N. WATCH PAGE HANDLING (currently playing video)
  // ============================================================
  let currentWatchVideoId = null;

  async function processWatchPage() {
    if (!YouTubeDetector.isWatchPage()) return;
    const params = new URLSearchParams(location.search);
    const videoId = params.get("v");
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return;
    if (videoId === currentWatchVideoId) return; // already handled, avoid duplicates
    currentWatchVideoId = videoId;

    const host =
      document.querySelector("ytd-watch-metadata #top-row") ||
      document.querySelector("ytd-watch-metadata") ||
      document.querySelector("#above-the-fold");
    if (!host) return;

    // Remove any stale block left from a previous video on this same page shell.
    const stale = host.querySelector(`[${Config.MARKER_ATTR}]`);
    if (stale) stale.remove();

    const loading = StatsRenderer.buildLoadingElement();
    host.appendChild(loading);

    const stats = await StatsManager.getStats(videoId);
    if (currentWatchVideoId !== videoId) return; // user navigated again mid-fetch
    if (!document.contains(loading)) return;
    loading.replaceWith(StatsRenderer.buildStatsElement(stats));
  }

  // ============================================================
  // O. NAVIGATION MANAGER (YouTube SPA route changes)
  // ============================================================
  function onNavigate() {
    Logger.log("Navigation detected:", location.href);
    currentWatchVideoId = null; // force re-check of watch page
    processWatchPage();
    scanForCards();
  }

  function initNavigationManager() {
    // YouTube fires this custom event on every internal SPA navigation.
    window.addEventListener("yt-navigate-finish", onNavigate);
    window.addEventListener("popstate", onNavigate);
  }

  // ============================================================
  // P. MUTATION OBSERVER (new/re-rendered cards)
  // ============================================================
  let mutationDebounceTimer = null;
  const pendingRoots = new Set();

  function scheduleScan(root) {
    if (YouTubeDetector.isInExcludedRegion(root)) return;
    pendingRoots.add(root);
    if (mutationDebounceTimer) return;
    mutationDebounceTimer = setTimeout(() => {
      mutationDebounceTimer = null;
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      roots.forEach((r) => scanForCards(r));
    }, Config.MUTATION_DEBOUNCE_MS);
  }

  function initMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          scheduleScan(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ============================================================
  // Q. BOOTSTRAP
  // ============================================================
  function init() {
    Logger.log("Initializing on", location.href);
    initNavigationManager();
    initMutationObserver();
    processWatchPage();
    scanForCards();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
