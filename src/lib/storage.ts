/**
 * storage.ts — Typed chrome.storage.local helpers
 *
 * WHY typed wrappers?
 * chrome.storage.local.get/set accept `any`, so schema drift is silently
 * swallowed by the runtime. Wrapping with explicit generics means TS will
 * flag mismatches at compile time when the schema evolves.
 */

// ─── Schema ────────────────────────────────────────────────────────────────

export interface NoteEntry {
    id: string;                  // UUIDv4 — stable identifier across edits
    markdown: string;            // Raw markdown text (via tiptap-markdown's getMarkdown())
    timestampEnabled: boolean;
    timestampSeconds: number | null; // null when timestampEnabled is false
    createdAt: string;           // ISO 8601
    updatedAt: string;           // ISO 8601
}

export interface VideoRecord {
    title: string;
    channel: string;
    url: string;                 // Full watch URL at time of last edit
    lastEdited: string;          // ISO 8601 — updated on every save
    notes: NoteEntry[];
}

/** An entry in the Watch Later list */
export interface WatchLaterEntry {
    videoId: string;
    title: string;
    channel: string;
    url: string;
    addedAt: string;             // ISO 8601
}

/** Root shape stored under key "videos" in chrome.storage.local */
export type VideosMap = Record<string, VideoRecord>;

/** Full storage root — extend this if you add top-level keys later */
export interface StorageRoot {
    videos: VideosMap;
    watchLater: WatchLaterEntry[];
}

// ─── Low-level helpers ──────────────────────────────────────────────────────

/** Promisified chrome.storage.local.get */
function storageGet<K extends keyof StorageRoot>(
    keys: K[]
): Promise<Pick<StorageRoot, K>> {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result as Pick<StorageRoot, K>);
            }
        });
    });
}

/** Promisified chrome.storage.local.set */
function storageSet<K extends keyof StorageRoot>(
    items: Pick<StorageRoot, K>
): Promise<void> {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve();
            }
        });
    });
}

// ─── Public API — Videos ─────────────────────────────────────────────────────

/** Load the full videos map. Returns {} if storage is empty. */
export async function getAllVideos(): Promise<VideosMap> {
    const result = await storageGet(['videos']);
    return result.videos ?? {};
}

/** Load the record for a single video ID. Returns null if not found. */
export async function getVideoRecord(
    videoId: string
): Promise<VideoRecord | null> {
    const videos = await getAllVideos();
    return videos[videoId] ?? null;
}

/**
 * Save (upsert) a video record.
 * If the record has zero non-empty notes, the entry is REMOVED from storage
 * to keep the library clean — no ghost entries for videos with no real content.
 *
 * Reads the current map, merges the new record, writes back.
 * This is safe because all writes go through the debounced content-script
 * path — there's no concurrent writer risk in normal usage.
 */
export async function saveVideoRecord(
    videoId: string,
    record: VideoRecord
): Promise<void> {
    const videos = await getAllVideos();

    // Only count notes that have actual content
    const nonEmptyNotes = record.notes.filter((n) => n.markdown.trim().length > 0);

    if (nonEmptyNotes.length === 0) {
        // Nothing worth saving — remove the entry if it exists
        if (videos[videoId]) {
            delete videos[videoId];
            await storageSet({ videos });
        }
        return;
    }

    videos[videoId] = {
        ...record,
        notes: nonEmptyNotes,
        lastEdited: new Date().toISOString(),
    };
    await storageSet({ videos });
}

/** Delete a video record and all its notes. */
export async function deleteVideoRecord(videoId: string): Promise<void> {
    const videos = await getAllVideos();
    delete videos[videoId];
    await storageSet({ videos });
}

/**
 * Add or update a single note within a video record.
 * Creates the video record skeleton if it doesn't exist yet.
 */
export async function upsertNote(
    videoId: string,
    meta: Pick<VideoRecord, 'title' | 'channel' | 'url'>,
    note: NoteEntry
): Promise<void> {
    const videos = await getAllVideos();
    const existing = videos[videoId];

    if (!existing) {
        videos[videoId] = {
            ...meta,
            lastEdited: new Date().toISOString(),
            notes: [note],
        };
    } else {
        const idx = existing.notes.findIndex((n) => n.id === note.id);
        if (idx === -1) {
            existing.notes.push(note);
        } else {
            existing.notes[idx] = note;
        }
        existing.lastEdited = new Date().toISOString();
        // Update meta in case title/channel changed (SPA nav can alter these)
        existing.title = meta.title;
        existing.channel = meta.channel;
        existing.url = meta.url;
        videos[videoId] = existing;
    }

    await storageSet({ videos });
}

/** Delete a single note from a video record. */
export async function deleteNote(
    videoId: string,
    noteId: string
): Promise<void> {
    const videos = await getAllVideos();
    const record = videos[videoId];
    if (!record) return;

    record.notes = record.notes.filter((n) => n.id !== noteId);
    record.lastEdited = new Date().toISOString();

    // If the video has no notes left, remove the record entirely to keep
    // the library clean — don't leave ghost entries.
    if (record.notes.length === 0) {
        delete videos[videoId];
    } else {
        videos[videoId] = record;
    }

    await storageSet({ videos });
}

// ─── Public API — Watch Later ─────────────────────────────────────────────────

/** Load the Watch Later list. Returns [] if storage is empty. */
export async function getWatchLater(): Promise<WatchLaterEntry[]> {
    const result = await storageGet(['watchLater']);
    return result.watchLater ?? [];
}

/** Check if a video is in the Watch Later list. */
export async function isInWatchLater(videoId: string): Promise<boolean> {
    const list = await getWatchLater();
    return list.some((e) => e.videoId === videoId);
}

/**
 * Add a video to Watch Later.
 * No-op if already present.
 */
export async function addToWatchLater(
    videoId: string,
    meta: Pick<WatchLaterEntry, 'title' | 'channel' | 'url'>
): Promise<void> {
    const list = await getWatchLater();
    if (list.some((e) => e.videoId === videoId)) return; // already in list

    list.unshift({
        videoId,
        title: meta.title,
        channel: meta.channel,
        url: meta.url,
        addedAt: new Date().toISOString(),
    });
    await storageSet({ watchLater: list });
}

/**
 * Remove a video from Watch Later.
 * No-op if not present.
 */
export async function removeFromWatchLater(videoId: string): Promise<void> {
    const list = await getWatchLater();
    const filtered = list.filter((e) => e.videoId !== videoId);
    if (filtered.length === list.length) return; // nothing changed
    await storageSet({ watchLater: filtered });
}
