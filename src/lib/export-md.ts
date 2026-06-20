/**
 * export-md.ts — Markdown file generation for notes export
 *
 * Export strategy:
 *   Single video  → one .md file, downloaded immediately via Blob + anchor.
 *   All videos    → one combined .md file (H1 per video) OR a .zip (one file
 *                   per video, using JSZip).
 *
 * TRADEOFF comment:
 *   Combined file is simpler (no extra dependency at runtime, single download)
 *   but gets unwieldy once you have 50+ videos. A .zip keeps files tidy and
 *   matches how users would actually store them, at the cost of pulling in
 *   JSZip (~100 KB minified). The default here is combined; JSZip is used only
 *   when the caller explicitly requests zip mode — import it lazily so it
 *   doesn't bloat the content-script bundle (only the library page uses "export
 *   all", so the cost lands only there).
 */

import type { VideoRecord, NoteEntry } from './storage';

// ─── Per-video markdown renderer ────────────────────────────────────────────

/** Format seconds as MM:SS or HH:MM:SS */
function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

/** Build the YouTube deep-link URL for a given video + seek position */
function timestampUrl(videoId: string, seconds: number): string {
    return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}s`;
}

/**
 * Render a single NoteEntry to a markdown string fragment.
 * Timestamped notes get a clickable markdown link prefix so the exported .md
 * file is still useful outside the extension (clicking the link in any markdown
 * viewer opens YouTube at the right moment).
 */
function renderNote(note: NoteEntry, videoId: string): string {
    const lines: string[] = [];

    if (note.timestampEnabled && note.timestampSeconds !== null) {
        const label = formatTime(note.timestampSeconds);
        const url = timestampUrl(videoId, note.timestampSeconds);
        lines.push(`**[${label}](${url})**\n`);
    }

    lines.push(note.markdown.trim());
    lines.push(''); // blank line separator
    return lines.join('\n');
}

/**
 * Render a full VideoRecord to a self-contained markdown document.
 * @param videoId — the storage key, needed for deep-link URLs
 */
export function renderVideoToMarkdown(
    videoId: string,
    record: VideoRecord
): string {
    const parts: string[] = [];

    // Title as H1, URL as a subtitle link
    parts.push(`# ${record.title}`);
    parts.push(`**Channel:** ${record.channel}`);
    parts.push(`**Video:** [${record.url}](${record.url})`);
    parts.push(`**Last edited:** ${new Date(record.lastEdited).toLocaleString()}`);
    parts.push('');
    parts.push('---');
    parts.push('');

    // Notes in creation order
    const sorted = [...record.notes].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    for (const note of sorted) {
        parts.push(renderNote(note, videoId));
        parts.push('---');
        parts.push('');
    }

    return parts.join('\n');
}

// ─── Download helpers ────────────────────────────────────────────────────────

/** Slugify a video title into a safe filename */
function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}

/** Trigger a browser download of a text blob */
function downloadBlob(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Clean up after a short delay to let the download start
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 1000);
}

/** Export a single video's notes as a .md file */
export function exportSingleVideo(videoId: string, record: VideoRecord): void {
    const markdown = renderVideoToMarkdown(videoId, record);
    const filename = `noteyt-${slugify(record.title)}.md`;
    downloadBlob(filename, markdown);
}

/**
 * Export all videos as a single combined .md file.
 * One H1 section per video, separated by horizontal rules.
 *
 * For zip export (one file per video), call exportAllAsZip() instead —
 * it's defined in library/notes-library.ts to avoid importing JSZip into
 * the content-script bundle.
 */
export function exportAllCombined(
    videos: Record<string, VideoRecord>
): void {
    const entries = Object.entries(videos);
    if (entries.length === 0) return;

    const parts: string[] = ['# NoteYT — All Notes Export', ''];

    for (const [videoId, record] of entries) {
        parts.push(renderVideoToMarkdown(videoId, record));
        parts.push('\n\n');
    }

    const date = new Date().toISOString().split('T')[0];
    downloadBlob(`noteyt-all-notes-${date}.md`, parts.join('\n'));
}
