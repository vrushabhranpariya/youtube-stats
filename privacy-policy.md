# Privacy Policy — YouTube Stats


## What this extension does

YouTube Stats adds like, dislike, and comment counts next to
videos on youtube.com. It runs entirely in your browser.

## What data is collected

**None.** This extension does not collect, store, sell, or transmit any
personal information, browsing history, or account data. It does not use
analytics or tracking of any kind.

## What network requests are made

To display stats, the extension sends a small number of requests, using
only the public YouTube video ID (an 11-character identifier, e.g.
`dQw4w9WgXcQ`) already visible in the page you're viewing:

| Request          | Sent to                    | Purpose                                                                                                 |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| Watch page fetch | `youtube.com`              | Read a video's public like/comment counts                                                               |
| Dislike lookup   | `returnyoutubedislike.com` | Read a video's community dislike count (via [Return YouTube Dislike](https://returnyoutubedislike.com)) |

No cookies, session tokens, search history, watch history, or identifying
information are included in these requests beyond the video ID itself.

## What is stored

Fetched stats are cached only in memory, only for the current browser tab
session, and expire automatically after 30 minutes. Nothing is written to
disk, synced, or shared across devices.

## Third parties

The only third party involved is **Return YouTube Dislike (RYD)**, used
solely to look up dislike counts. Its use is subject to RYD's own privacy
policy, available at returnyoutubedislike.com. This extension's developer
has no access to, and does not receive, any data from that request.

## Permissions

The extension requests the minimum permissions needed to run on
youtube.com and to contact the RYD API. It does not request access to
your Google account, passwords, or any site other than the two listed
above.

## Changes to this policy

If this extension's data practices change, this file will be updated
accordingly.

## Contact

For questions, open an issue in this project's repository.