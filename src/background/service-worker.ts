/**
 * service-worker.ts — MV3 background service worker
 *
 * Responsibilities:
 *   1. Handle toolbar icon click → open library in a new tab
 *   2. Route OPEN_LIBRARY messages from the content script
 *   3. Future: handle SAVE_VIDEO messages if we ever move storage writes here
 *      (for now, content script writes directly via chrome.storage.local)
 */

// ─── Toolbar click → open library ────────────────────────────────────────────

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({
        url: chrome.runtime.getURL('library/notes-library.html'),
    });
});

// ─── Message routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
    (message: { type: string; payload?: unknown }, _sender, sendResponse) => {
        if (message.type === 'OPEN_LIBRARY') {
            chrome.tabs.create({
                url: chrome.runtime.getURL('library/notes-library.html'),
            });
            sendResponse({ ok: true });
            return false; // synchronous response, no need to keep channel open
        }

        // Unhandled message types — log in development, ignore in production
        if (process.env.NODE_ENV === 'development') {
            console.log('[NoteYT service worker] unhandled message:', message);
        }

        return false;
    }
);

// ─── Install / startup ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') {
        // Open library on first install so the user sees it exists
        chrome.tabs.create({
            url: chrome.runtime.getURL('library/notes-library.html'),
        });
    }
});
