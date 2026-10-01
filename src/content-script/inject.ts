/**
 * inject.ts — Panel mounting and YouTube SPA navigation detection
 *
 * ─── SPA NAVIGATION NOTES ────────────────────────────────────────────────────
 * YouTube is a Single-Page Application built on its own "Polymer"-derived
 * framework. When a user clicks a recommended video:
 *
 *   1. The URL changes via History.pushState (no full page reload).
 *   2. YouTube fires a custom DOM event: `yt-navigate-finish` on `document`.
 *   3. The DOM is partially re-rendered — #secondary (suggested videos column)
 *      gets rebuilt, which DESTROYS our injected panel.
 *
 * We CANNOT rely on:
 *   - `DOMContentLoaded` — fires only once, on the initial page load.
 *   - `window.onpopstate` — fires on back/forward but not on link clicks.
 *   - MutationObserver on <body> — too noisy, fires hundreds of times.
 *
 * We CAN rely on:
 *   - `yt-navigate-finish` — YouTube's own internal signal that a navigation
 *     is complete and the new page's DOM is ready. This has been stable since
 *     ~2018 and is documented in third-party extension communities. If YouTube
 *     ever removes it, the fallback is a MutationObserver on `#secondary` with
 *     a debounce — see the FALLBACK comment below.
 *
 * HOW TO DEBUG IF THIS BREAKS:
 *   Open DevTools console on youtube.com/watch, run:
 *     document.addEventListener('yt-navigate-finish', () => console.log('nav!'))
 *   Then click a video. If it logs, the event still works.
 *   If it doesn't log, switch to the MutationObserver fallback below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createEditor, createToolbar, type NoteEditor } from './editor';
import { captureTimestamp, seekTo, formatTimestamp } from './player-bridge';
import {
    getVideoRecord,
    saveVideoRecord,
    upsertNote,
    deleteNote,
    addToWatchLater,
    removeFromWatchLater,
    isInWatchLater,
    type NoteEntry,
    type VideoRecord,
} from '../lib/storage';
import { exportSingleVideo } from '../lib/export-md';
import { v4 as uuidv4 } from 'uuid';

// ─── State ────────────────────────────────────────────────────────────────────

/** Currently displayed video context */
let currentVideoId: string | null = null;
let currentVideoRecord: VideoRecord | null = null;
let isWatchLater = false;

/** Draft text in-memory buffer — survives panel re-injection across SPA nav */
const draftBuffer: Map<string, string> = new Map(); // noteId → markdown draft

/** Active TipTap editor instances keyed by note ID */
const activeEditors: Map<string, NoteEditor> = new Map();

/** Debounce timer handle for auto-save */
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Video info extraction ────────────────────────────────────────────────────

function getVideoIdFromUrl(): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
}

function getVideoTitle(): string {
    // Primary: structured data in <yt-formatted-string> with the watch title
    const el =
        document.querySelector<HTMLElement>('h1.ytd-watch-metadata yt-formatted-string') ??
        document.querySelector<HTMLElement>('#title h1 yt-formatted-string') ??
        document.querySelector<HTMLElement>('h1.style-scope.ytd-watch-flexy');
    return el?.textContent?.trim() ?? document.title.replace(' - YouTube', '').trim();
}

function getChannelName(): string {
    const el =
        document.querySelector<HTMLElement>('ytd-channel-name a') ??
        document.querySelector<HTMLElement>('#channel-name a') ??
        document.querySelector<HTMLElement>('#owner-name a');
    return el?.textContent?.trim() ?? 'Unknown Channel';
}

// ─── Keyboard isolation ───────────────────────────────────────────────────────

/**
 * installKeyboardIsolation(panelRootEl)
 *
 * ─── THE PROBLEM (before this fix) ───────────────────────────────────────────
 *
 * DOM keyboard events bubble upward: target → ... → panel → #secondary →
 * body → document → window. YouTube attaches its hotkey handler at the
 * document (or window) level, so every keystroke the user types inside our
 * panel reaches YouTube's listener and triggers player actions:
 *
 *   User types "m" in editor
 *     ↓ keydown fires on the contenteditable
 *     ↓ bubbles up through our panel, #secondary, body...
 *     ↓ YouTube's document-level listener fires → video muted ✗
 *
 * ─── THE FIX (after this fix) ────────────────────────────────────────────────
 *
 * We attach our listener on the panel root in the CAPTURE phase. The capture
 * phase runs top-down BEFORE bubbling runs bottom-up. But crucially, calling
 * stopPropagation() / stopImmediatePropagation() inside a capture-phase
 * listener on an ANCESTOR prevents the event from reaching any further
 * capture-phase listeners on descendants AND prevents the bubble phase from
 * ever running — so YouTube's document-level listener (bubble or capture)
 * never fires:
 *
 *   User types "m" in editor
 *     ↓ capture phase descends: window → document → body → #secondary → panel
 *     ↓ OUR capture listener on panel fires → stopImmediatePropagation() ✓
 *     ✗ event never continues down to the contenteditable's own capture phase
 *
 * WAIT — that would also block TipTap from receiving the keystroke, which
 * is wrong. We must NOT stopPropagation on the capture phase going DOWN.
 * Instead we attach on the panel in the BUBBLE phase for the return trip:
 *
 *   User types "m" in editor
 *     ↓ capture phase: document → ... → panel (our listener checks: target
 *       is NOT inside panel? skip. IS inside panel? let it continue down.)
 *     ↓ event reaches contenteditable → TipTap handles it → "m" typed ✓
 *     ↑ bubble phase: contenteditable → editorWrap → noteCard → panelBody
 *     ↑ OUR bubble listener on panel fires → stopImmediatePropagation() ✓
 *     ✗ event never reaches #secondary → body → document → YouTube's handler
 *
 * So the correct combination is a BUBBLE-phase listener on the panel root
 * that calls stopImmediatePropagation(). NOT capture-phase-stop (which would
 * block our own editor), NOT bubble-phase-only stopPropagation (which still
 * allows other bubble listeners on the same element to fire).
 *
 * WHY stopImmediatePropagation AND NOT just stopPropagation?
 * stopPropagation prevents the event from moving to the NEXT element in the
 * chain, but still allows other listeners registered on THIS element (the
 * panel root) to fire. stopImmediatePropagation does both: stops travel AND
 * prevents any further listeners on the same element. Since we don't know
 * whether YouTube or another extension attaches a listener directly on our
 * panel element (unlikely but possible), stopImmediatePropagation is the
 * safer guarantee.
 *
 * WHY all three event types (keydown, keyup, keypress)?
 * YouTube's shortcuts are not uniformly on one event type. Most fire on
 * keydown, but some (older codepaths, accessibility handling) fire on keyup
 * or keypress. Covering all three costs nothing and closes the gap.
 *
 * ─── SCOPE: only when target is inside our panel ─────────────────────────────
 *
 * We check event.target before stopping. If the target is NOT a descendant
 * of our panel (e.g. the user clicked the video player and our panel just
 * happens to be in the DOM), we let the event pass through normally so
 * YouTube shortcuts keep working. Focus, not panel-existence, is the trigger.
 *
 * ─── ESCAPE key behaviour (documented decision) ──────────────────────────────
 *
 * Pressing Escape while inside the editor blurs the active element, returning
 * keyboard focus to the page. This gives YouTube hotkeys back immediately
 * without the user having to click elsewhere. We do NOT stopPropagation on
 * Escape so the browser's native blur-on-Escape behaviour can also fire.
 *
 * ─── What IS and IS NOT blocked ──────────────────────────────────────────────
 *
 * BLOCKED (good — these were firing YouTube actions while typing):
 *   Space, m, k, j, l, 0-9, f, c, t, i, ?, /,
 *   ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End
 *
 * NOT BLOCKED (intentional — these must work normally inside the editor):
 *   Ctrl+A  (select all)      — modifier keys are passed through
 *   Ctrl+Z  (undo)            — TipTap's History extension handles this
 *   Ctrl+B  (bold via TipTap) — TipTap intercepts before bubble reaches us
 *   Ctrl+V  (paste)           — browser paste event fires separately; not blocked
 *   Escape  (blur editor)     — explicitly allowed through (see above)
 *   Tab     (indent/focus)    — not a YouTube shortcut, but also not blocked
 *
 * ─── SPA navigation safety ───────────────────────────────────────────────────
 *
 * This function is called ONCE inside buildPanel(), which is called at most
 * once per panel mount (isPanelInjected() guards against double-mount).
 * When YouTube's SPA nav destroys #secondary and our panel goes with it,
 * the listeners are garbage-collected with the element — no accumulation.
 * The next injectPanel() call builds a fresh panel and calls this once again.
 */
function installKeyboardIsolation(panelRootEl: HTMLElement): void {
    /**
     * Returns true if the keyboard event's target is an interactive element
     * inside our panel that should receive keystrokes.
     *
     * Covers:
     *   - TipTap's contenteditable div (.ynx-editor-content)
     *   - Any <input> or <textarea> inside our panel (e.g. future search fields)
     *   - Any [contenteditable] we might add later
     *   - Any element explicitly marked [data-ynx-capture-keys] for flexibility
     */
    function isTypingTarget(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) return false;
        // Must be inside our panel
        if (!panelRootEl.contains(target)) return false;

        const el = target as HTMLElement;
        const tag = el.tagName.toLowerCase();

        return (
            tag === 'input' ||
            tag === 'textarea' ||
            el.isContentEditable ||
            el.hasAttribute('data-ynx-capture-keys')
        );
    }

    /**
     * The core handler — attached in the BUBBLE phase on the panel root.
     *
     * For every keyboard event whose target is a typing surface inside our
     * panel, we stop it here on the way up. The event has already been fully
     * handled by TipTap / the browser input at the target level; we're just
     * preventing the ghost copy that would have continued bubbling to YouTube.
     */
    function handleKeyEvent(e: KeyboardEvent): void {
        // Escape: let it through so the browser can blur the focused element,
        // handing keyboard control back to YouTube naturally.
        if (e.key === 'Escape') {
            (e.target as HTMLElement | null)?.blur();
            return; // do NOT stopPropagation — let native blur fire
        }

        if (!isTypingTarget(e.target)) return;

        // stopImmediatePropagation: stops travel to parent elements AND prevents
        // any other listeners on THIS element from firing (belt-and-suspenders).
        e.stopImmediatePropagation();
        // We do NOT call e.preventDefault() — that would suppress the character
        // from being inserted into the editor. We only want to stop YouTube from
        // ALSO seeing the event; the editor has already processed it.
    }

    // Register on all three event types in the bubble phase (useCapture = false).
    // Bubble phase is correct here — we want the editor to process the keystroke
    // FIRST (at the target), then we intercept it on the way back up.
    const opts = { capture: false } as const;
    panelRootEl.addEventListener('keydown', handleKeyEvent, opts);
    panelRootEl.addEventListener('keyup', handleKeyEvent, opts);
    panelRootEl.addEventListener('keypress', handleKeyEvent, opts);
}

// ─── Panel DOM construction ───────────────────────────────────────────────────

const PANEL_ID = 'ynx-panel';

function isPanelInjected(): boolean {
    return document.getElementById(PANEL_ID) !== null;
}

/**
 * Find YouTube's #secondary column (suggested videos sidebar).
 * Returns null if the layout isn't present yet — caller should retry.
 */
function getSecondaryColumn(): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>('#secondary') ??
        document.querySelector<HTMLElement>('#secondary-inner') ??
        null
    );
}

/** Build the top-level panel wrapper */
function buildPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'ynx-panel';

    // ── Header row ──────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'ynx-panel-header';

    const title = document.createElement('span');
    title.className = 'ynx-panel-title';
    title.textContent = '📝 NoteYT';

    const headerActions = document.createElement('div');
    headerActions.className = 'ynx-panel-header-actions';

    // Mark button (placeholder — original button from screenshot)
    const markBtn = document.createElement('button');
    markBtn.className = 'ynx-btn ynx-btn--ghost ynx-btn--sm';
    markBtn.textContent = '◎ Mark';
    markBtn.title = 'Mark current timestamp';
    markBtn.addEventListener('click', () => {
        const t = captureTimestamp();
        if (t !== null) {
            setSaveIndicator('saved');
            setTimeout(() => setSaveIndicator('idle'), 2000);
        }
    });
    headerActions.appendChild(markBtn);

    // Watch Later button
    const watchLaterBtn = document.createElement('button');
    watchLaterBtn.id = 'ynx-watch-later-btn';
    watchLaterBtn.className = 'ynx-btn ynx-btn--ghost ynx-btn--sm';
    watchLaterBtn.textContent = '🕐 Watch Later';
    watchLaterBtn.title = 'Save this video to Watch Later';
    watchLaterBtn.addEventListener('click', handleWatchLater);
    headerActions.appendChild(watchLaterBtn);

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'ynx-btn ynx-btn--ghost ynx-btn--sm';
    exportBtn.textContent = '⬇ Export .md';
    exportBtn.title = 'Export all notes for this video as a .md file';
    exportBtn.addEventListener('click', handleExport);
    headerActions.appendChild(exportBtn);

    // Library button
    const libraryBtn = document.createElement('button');
    libraryBtn.className = 'ynx-btn ynx-btn--ghost ynx-btn--sm';
    libraryBtn.textContent = '📚 Library';
    libraryBtn.title = 'Open notes library';
    libraryBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' });
    });
    headerActions.appendChild(libraryBtn);

    // Collapse toggle
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'ynx-btn ynx-btn--ghost ynx-btn--sm ynx-collapse-btn';
    collapseBtn.textContent = '▲';
    collapseBtn.title = 'Collapse panel';
    headerActions.appendChild(collapseBtn);

    header.appendChild(title);
    header.appendChild(headerActions);
    panel.appendChild(header);

    // ── Body (collapsible) ──────────────────────────────────────────────────
    const body = document.createElement('div');
    body.className = 'ynx-panel-body';

    // Save indicator
    const saveIndicator = document.createElement('div');
    saveIndicator.className = 'ynx-save-indicator';
    saveIndicator.id = 'ynx-save-indicator';
    body.appendChild(saveIndicator);

    // Notes list
    const notesList = document.createElement('div');
    notesList.className = 'ynx-notes-list';
    notesList.id = 'ynx-notes-list';
    body.appendChild(notesList);

    // ── Footer action row ───────────────────────────────────────────────────
    const footerRow = document.createElement('div');
    footerRow.className = 'ynx-panel-footer-row';

    // "Add note" button
    const addBtn = document.createElement('button');
    addBtn.className = 'ynx-btn ynx-btn--primary ynx-add-note-btn';
    addBtn.textContent = '+ Add Note';
    addBtn.addEventListener('click', handleAddNote);
    footerRow.appendChild(addBtn);

    // "+ Timestamp" button (adds a note pre-pinned to current timestamp)
    const tsNoteBtn = document.createElement('button');
    tsNoteBtn.className = 'ynx-btn ynx-btn--ghost ynx-add-ts-btn';
    tsNoteBtn.innerHTML = '+ ⏱ Timestamp';
    tsNoteBtn.title = 'Add a new note pinned to current timestamp';
    tsNoteBtn.addEventListener('click', handleAddTimestampNote);
    footerRow.appendChild(tsNoteBtn);

    body.appendChild(footerRow);
    panel.appendChild(body);

    // ── Collapse/expand logic ───────────────────────────────────────────────
    let collapsed = false;
    collapseBtn.addEventListener('click', () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : '';
        collapseBtn.textContent = collapsed ? '▼' : '▲';
        collapseBtn.title = collapsed ? 'Expand panel' : 'Collapse panel';
    });

    // Install keyboard isolation ONCE on this panel instance.
    installKeyboardIsolation(panel);

    return panel;
}

// ─── Note card rendering ──────────────────────────────────────────────────────

let noteCounter = 0; // increments per card so we can label "Note 1", "Note 2"...

/**
 * Render a single note card into the notes list.
 * Each card now has a compact header row (toggleable) + collapsible body.
 *
 * Collapsed state shows: chevron + note number + content preview + ts chip + delete
 * Expanded state shows: toolbar + full TipTap editor
 *
 * @param note        The NoteEntry data
 * @param container   The #ynx-notes-list element
 * @param startExpanded  If true, start expanded (default for new notes)
 */
function renderNoteCard(
    note: NoteEntry,
    container: HTMLElement,
    startExpanded = false
): void {
    noteCounter++;
    const cardIndex = noteCounter;

    const card = document.createElement('div');
    card.className = 'ynx-note-card';
    card.dataset.noteId = note.id;

    // ── Card Header (always visible) ─────────────────────────────────────────
    const cardHeader = document.createElement('div');
    cardHeader.className = 'ynx-note-card-header';

    // Toggle chevron
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'ynx-note-toggle-btn';
    toggleBtn.setAttribute('aria-label', 'Toggle note');

    // Note label
    const noteLabel = document.createElement('span');
    noteLabel.className = 'ynx-note-label';
    noteLabel.textContent = `Note ${cardIndex}`;

    // Timestamp chip (compact, in header)
    const tsChipHeader = document.createElement('button');
    tsChipHeader.type = 'button';
    tsChipHeader.className = 'ynx-ts-chip ynx-ts-chip--sm' + (note.timestampEnabled ? '' : ' ynx-hidden');
    tsChipHeader.title = 'Click to seek to this moment';
    updateTimestampChip(tsChipHeader, note.timestampSeconds);
    tsChipHeader.addEventListener('click', (e) => {
        e.stopPropagation(); // don't toggle the card
        if (note.timestampSeconds !== null) seekTo(note.timestampSeconds);
    });

    // Content preview (shown when collapsed)
    const preview = document.createElement('span');
    preview.className = 'ynx-note-preview';
    const previewText = note.markdown.replace(/[#*`>\-_~\[\]()]/g, '').trim();
    preview.textContent = previewText.slice(0, 60) || 'Empty note…';

    // Header right side
    const headerRight = document.createElement('div');
    headerRight.className = 'ynx-note-header-right';

    // Delete button (in header)
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ynx-btn ynx-btn--danger ynx-btn--xs ynx-note-delete-btn';
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete this note';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDeleteNote(note.id, card);
    });
    headerRight.appendChild(deleteBtn);

    cardHeader.appendChild(toggleBtn);
    cardHeader.appendChild(noteLabel);
    cardHeader.appendChild(tsChipHeader);
    cardHeader.appendChild(preview);
    cardHeader.appendChild(headerRight);

    card.appendChild(cardHeader);

    // ── Card Body (collapsible) ───────────────────────────────────────────────
    const cardBody = document.createElement('div');
    cardBody.className = 'ynx-note-card-body';

    // ── Timestamp row (inside body) ──────────────────────────────────────────
    const tsRow = document.createElement('div');
    tsRow.className = 'ynx-note-ts-row';

    const tsToggle = document.createElement('label');
    tsToggle.className = 'ynx-toggle-label';

    const tsCheckbox = document.createElement('input');
    tsCheckbox.type = 'checkbox';
    tsCheckbox.className = 'ynx-toggle-input';
    tsCheckbox.checked = note.timestampEnabled;

    const tsText = document.createElement('span');
    tsText.className = 'ynx-toggle-text';
    tsText.textContent = 'Pin to timestamp';

    tsToggle.appendChild(tsCheckbox);
    tsToggle.appendChild(tsText);
    tsRow.appendChild(tsToggle);

    // Re-capture timestamp button (re-pins to current time)
    const recaptureBtn = document.createElement('button');
    recaptureBtn.type = 'button';
    recaptureBtn.className =
        'ynx-btn ynx-btn--ghost ynx-btn--xs' + (note.timestampEnabled ? '' : ' ynx-hidden');
    recaptureBtn.textContent = '⟳ Recapture';
    recaptureBtn.title = 'Re-pin to current playback position';
    recaptureBtn.addEventListener('click', () => {
        const t = captureTimestamp();
        note.timestampSeconds = t;
        updateTimestampChip(tsChipHeader, t);
        scheduleSave(note.id);
    });
    tsRow.appendChild(recaptureBtn);

    // Checkbox toggle handler
    tsCheckbox.addEventListener('change', () => {
        note.timestampEnabled = tsCheckbox.checked;
        if (tsCheckbox.checked) {
            const t = captureTimestamp();
            note.timestampSeconds = t;
            updateTimestampChip(tsChipHeader, t);
            tsChipHeader.classList.remove('ynx-hidden');
            recaptureBtn.classList.remove('ynx-hidden');
        } else {
            note.timestampSeconds = null;
            updateTimestampChip(tsChipHeader, null);
            tsChipHeader.classList.add('ynx-hidden');
            recaptureBtn.classList.add('ynx-hidden');
        }
        scheduleSave(note.id);
    });

    cardBody.appendChild(tsRow);

    // ── Editor mount point ───────────────────────────────────────────────────
    const editorWrap = document.createElement('div');
    editorWrap.className = 'ynx-editor-wrap';

    // Toolbar placeholder
    const toolbarPlaceholder = document.createElement('div');
    toolbarPlaceholder.className = 'ynx-toolbar-wrap';
    editorWrap.appendChild(toolbarPlaceholder);

    const editorMount = document.createElement('div');
    editorMount.className = 'ynx-editor-mount';
    editorWrap.appendChild(editorMount);

    // Restore any unsaved draft from the buffer, otherwise use stored markdown
    const initialContent = draftBuffer.get(note.id) ?? note.markdown;

    const noteEditor = createEditor({
        element: editorMount,
        initialMarkdown: initialContent,
        placeholder: 'Write your note here…',
        onChange: (md) => {
            // Buffer the draft immediately
            draftBuffer.set(note.id, md);
            note.markdown = md;
            // Update preview text
            const rawPreview = md.replace(/[#*`>\-_~\[\]()]/g, '').trim();
            preview.textContent = rawPreview.slice(0, 60) || 'Empty note…';
            // Debounce the actual storage write
            scheduleSave(note.id);
        },
    });

    activeEditors.set(note.id, noteEditor);

    // Build toolbar with the live editor reference
    const toolbar = createToolbar(noteEditor);
    toolbarPlaceholder.appendChild(toolbar);

    cardBody.appendChild(editorWrap);
    card.appendChild(cardBody);

    // ── Collapse/expand toggle logic ─────────────────────────────────────────
    let expanded = startExpanded;

    function applyCollapseState(): void {
        if (expanded) {
            toggleBtn.textContent = '▼';
            cardBody.style.display = '';
            preview.style.display = 'none';
            card.classList.add('ynx-note-card--expanded');
        } else {
            toggleBtn.textContent = '▶';
            cardBody.style.display = 'none';
            preview.style.display = '';
            card.classList.remove('ynx-note-card--expanded');
        }
    }

    const toggleExpand = (): void => {
        expanded = !expanded;
        applyCollapseState();
    };

    // Clicking header toggles expand (but not the buttons inside headerRight or tsChip)
    cardHeader.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.ynx-note-header-right, .ynx-ts-chip')) return;
        toggleExpand();
    });
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExpand();
    });

    // Apply initial state
    applyCollapseState();

    container.appendChild(card);
}

function updateTimestampChip(
    chip: HTMLButtonElement,
    seconds: number | null
): void {
    chip.textContent = seconds !== null ? `⏱ ${formatTimestamp(seconds)}` : '⏱ --:--';
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleAddNote(): Promise<void> {
    if (!currentVideoId || !currentVideoRecord) return;

    const now = new Date().toISOString();
    const note: NoteEntry = {
        id: uuidv4(),
        markdown: '',
        timestampEnabled: false,
        timestampSeconds: null,
        createdAt: now,
        updatedAt: now,
    };

    currentVideoRecord.notes.push(note);

    const container = document.getElementById('ynx-notes-list');
    if (container) renderNoteCard(note, container, true /* startExpanded */);

    // Don't persist immediately — new empty note would be filtered out.
    // It'll be saved when the user types something (via scheduleSave).
}

async function handleAddTimestampNote(): Promise<void> {
    if (!currentVideoId || !currentVideoRecord) return;

    const t = captureTimestamp();
    const now = new Date().toISOString();
    const note: NoteEntry = {
        id: uuidv4(),
        markdown: '',
        timestampEnabled: true,
        timestampSeconds: t,
        createdAt: now,
        updatedAt: now,
    };

    currentVideoRecord.notes.push(note);

    const container = document.getElementById('ynx-notes-list');
    if (container) renderNoteCard(note, container, true /* startExpanded */);
}

async function handleDeleteNote(
    noteId: string,
    cardEl: HTMLElement
): Promise<void> {
    if (!currentVideoId || !currentVideoRecord) return;

    // Destroy TipTap instance
    const ed = activeEditors.get(noteId);
    if (ed) {
        ed.destroy();
        activeEditors.delete(noteId);
    }
    draftBuffer.delete(noteId);

    currentVideoRecord.notes = currentVideoRecord.notes.filter(
        (n) => n.id !== noteId
    );
    cardEl.remove();

    await deleteNote(currentVideoId, noteId);
}

function handleExport(): void {
    if (!currentVideoId || !currentVideoRecord) return;
    exportSingleVideo(currentVideoId, currentVideoRecord);
}

async function handleWatchLater(): Promise<void> {
    if (!currentVideoId) return;

    const btn = document.getElementById('ynx-watch-later-btn') as HTMLButtonElement | null;
    if (!btn) return;

    if (isWatchLater) {
        await removeFromWatchLater(currentVideoId);
        isWatchLater = false;
        btn.textContent = '🕐 Watch Later';
        btn.classList.remove('ynx-btn--wl-active');
        btn.title = 'Save this video to Watch Later';
    } else {
        await addToWatchLater(currentVideoId, {
            title: getVideoTitle(),
            channel: getChannelName(),
            url: window.location.href,
        });
        isWatchLater = true;
        btn.textContent = '✓ Saved';
        btn.classList.add('ynx-btn--wl-active');
        btn.title = 'Remove from Watch Later';
        // Revert label text after 2s but keep active state
        setTimeout(() => {
            if (isWatchLater && btn) btn.textContent = '🕐 Saved ✓';
        }, 2000);
    }
}

// ─── Auto-save / debounce ─────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 800;

function scheduleSave(_noteId: string): void {
    if (saveDebounceTimer !== null) clearTimeout(saveDebounceTimer);
    setSaveIndicator('saving');
    saveDebounceTimer = setTimeout(async () => {
        await saveCurrentRecord();
        setSaveIndicator('saved');
        // Hide "Saved" after 2s
        setTimeout(() => setSaveIndicator('idle'), 2000);
    }, SAVE_DEBOUNCE_MS);
}

async function saveCurrentRecord(): Promise<void> {
    if (!currentVideoId || !currentVideoRecord) return;

    // Only save if there is at least one non-empty note
    const hasContent = currentVideoRecord.notes.some(
        (n) => n.markdown.trim().length > 0
    );
    if (!hasContent) return; // nothing worth persisting

    // Stamp updatedAt on all notes before persisting
    for (const note of currentVideoRecord.notes) {
        note.updatedAt = new Date().toISOString();
    }
    await saveVideoRecord(currentVideoId, currentVideoRecord);
}

function setSaveIndicator(state: 'idle' | 'saving' | 'saved'): void {
    const el = document.getElementById('ynx-save-indicator');
    if (!el) return;
    if (state === 'idle') {
        el.textContent = '';
        el.className = 'ynx-save-indicator';
    } else if (state === 'saving') {
        el.textContent = '● Saving…';
        el.className = 'ynx-save-indicator ynx-save-indicator--saving';
    } else {
        el.textContent = '✓ Saved · Markdown synced';
        el.className = 'ynx-save-indicator ynx-save-indicator--saved';
    }
}

// ─── Panel lifecycle ──────────────────────────────────────────────────────────

/**
 * Load video data and (re)populate the notes list.
 * Called every time the video changes (SPA navigation).
 */
async function loadVideoData(videoId: string): Promise<void> {
    currentVideoId = videoId;

    const meta = {
        title: getVideoTitle(),
        channel: getChannelName(),
        url: window.location.href,
    };

    const stored = await getVideoRecord(videoId);
    currentVideoRecord = stored ?? {
        ...meta,
        lastEdited: new Date().toISOString(),
        notes: [],
    };

    // Update meta with freshly-scraped values (title/channel may have changed)
    currentVideoRecord.title = meta.title;
    currentVideoRecord.channel = meta.channel;
    currentVideoRecord.url = meta.url;

    // Load Watch Later state and update button
    isWatchLater = await isInWatchLater(videoId);
    const wlBtn = document.getElementById('ynx-watch-later-btn') as HTMLButtonElement | null;
    if (wlBtn) {
        if (isWatchLater) {
            wlBtn.textContent = '🕐 Saved ✓';
            wlBtn.classList.add('ynx-btn--wl-active');
            wlBtn.title = 'Remove from Watch Later';
        } else {
            wlBtn.textContent = '🕐 Watch Later';
            wlBtn.classList.remove('ynx-btn--wl-active');
            wlBtn.title = 'Save this video to Watch Later';
        }
    }

    // Re-render notes list
    const container = document.getElementById('ynx-notes-list');
    if (!container) return;

    // Destroy any existing TipTap editors before clearing DOM
    for (const [id, ed] of activeEditors) {
        ed.destroy();
        activeEditors.delete(id);
    }
    container.innerHTML = '';
    noteCounter = 0; // reset counter for this video

    // Always render the list (even if empty — shows "+ Add Note" button below)
    for (const note of currentVideoRecord.notes) {
        // Collapse already-saved notes that have content; expand empty ones
        const hasContent = note.markdown.trim().length > 0;
        renderNoteCard(note, container, !hasContent);
    }
}

/**
 * Inject the panel into #secondary above the suggested videos.
 * Safe to call multiple times — checks isPanelInjected() first.
 */
async function injectPanel(videoId: string): Promise<void> {
    const secondary = getSecondaryColumn();
    if (!secondary) {
        // #secondary not in DOM yet — retry in 500ms
        setTimeout(() => injectPanel(videoId), 500);
        return;
    }

    if (!isPanelInjected()) {
        const panel = buildPanel();
        secondary.insertBefore(panel, secondary.firstChild);
    }

    await loadVideoData(videoId);
}

// ─── SPA navigation detection ─────────────────────────────────────────────────

/**
 * Handle each YouTube navigation (initial load + SPA transitions).
 */
async function onYouTubeNavigate(): Promise<void> {
    // Only run on watch pages
    if (!window.location.pathname.startsWith('/watch')) return;

    const videoId = getVideoIdFromUrl();
    if (!videoId) return;
    if (videoId === currentVideoId && isPanelInjected()) return;

    // Save any pending draft before switching videos
    if (saveDebounceTimer !== null) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        await saveCurrentRecord();
    }

    await injectPanel(videoId);
}

/**
 * PRIMARY: Listen for YouTube's own `yt-navigate-finish` event.
 */
document.addEventListener('yt-navigate-finish', onYouTubeNavigate);

/**
 * FALLBACK: Also handle the initial page load.
 */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onYouTubeNavigate);
} else {
    onYouTubeNavigate();
}

/**
 * Re-injection guard: keeps panel present even if YouTube re-renders #secondary.
 */
setInterval(() => {
    if (
        window.location.pathname.startsWith('/watch') &&
        currentVideoId &&
        !isPanelInjected()
    ) {
        injectPanel(currentVideoId);
    }
}, 3000);
