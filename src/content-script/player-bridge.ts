/**
 * player-bridge.ts — Timestamp capture and seek logic
 *
 * YouTube's player is a <video> element inside the page. We don't need
 * YouTube's internal JS API — the HTMLVideoElement interface is enough:
 *   - Read `video.currentTime` to capture the current playback position
 *   - Write `video.currentTime = seconds` to seek
 *
 * The element selector 'video.html5-main-video' is the stable one YouTube
 * has used since HTML5 player launch. If it ever changes, this is the one
 * line to update.
 */

const VIDEO_SELECTOR = 'video.html5-main-video';

/** Return the YouTube <video> element, or null if not found */
function getVideoElement(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
}

/**
 * Capture the player's current position in seconds.
 * Returns null if the video element isn't present (e.g. on a non-video page).
 */
export function captureTimestamp(): number | null {
    const video = getVideoElement();
    if (!video) return null;
    return video.currentTime;
}

/**
 * Seek the player to a given position in seconds.
 * Silently no-ops if the video element isn't present.
 */
export function seekTo(seconds: number): void {
    const video = getVideoElement();
    if (!video) return;
    video.currentTime = seconds;

    // If the video is paused, don't auto-play — just move the position.
    // Users can press play themselves. This avoids jarring behavior when
    // they're reviewing notes after stopping the video.
}

/** Format seconds as MM:SS or HH:MM:SS for display */
export function formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}
