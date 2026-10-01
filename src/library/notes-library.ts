/**
 * notes-library.ts — Library page script
 *
 * Client-side "routing":
 *   - Default view: grid of video cards (with Watch Later section above)
 *   - Detail view: all notes for a selected video (push state to avoid full reload)
 *
 * Zip export strategy (all videos / selected videos):
 *   JSZip is imported here (not in the content script) so it only lands in
 *   the library bundle, keeping the content-script bundle lean.
 */

import JSZip from 'jszip';
import {
    getAllVideos,
    deleteVideoRecord,
    getWatchLater,
    removeFromWatchLater,
    type VideosMap,
    type VideoRecord,
    type WatchLaterEntry,
} from '../lib/storage';
import { renderVideoToMarkdown, exportSingleVideo } from '../lib/export-md';

// ─── State ────────────────────────────────────────────────────────────────────

let allVideos: VideosMap = {};
let watchLaterList: WatchLaterEntry[] = [];
let searchQuery = '';
type SortKey = 'lastEdited' | 'noteCount' | 'title';
let sortKey: SortKey = 'lastEdited';
let currentDetailVideoId: string | null = null;

/** IDs currently selected in the grid (Fix #5) */
const selectedIds = new Set<string>();

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
    [allVideos, watchLaterList] = await Promise.all([getAllVideos(), getWatchLater()]);

    // Check URL hash for direct detail link (e.g. #video=dQw4w9WgXcQ)
    const hash = window.location.hash;
    const hashMatch = hash.match(/^#video=(.+)$/);
    if (hashMatch && allVideos[hashMatch[1]]) {
        renderDetailView(hashMatch[1]);
    } else {
        renderLibraryView();
    }

    window.addEventListener('hashchange', () => {
        const h = window.location.hash;
        const m = h.match(/^#video=(.+)$/);
        if (m && allVideos[m[1]]) {
            renderDetailView(m[1]);
        } else {
            renderLibraryView();
        }
    });
}

// ─── Library view ─────────────────────────────────────────────────────────────

function renderLibraryView(): void {
    currentDetailVideoId = null;
    selectedIds.clear();
    const app = document.getElementById('app')!;
    app.innerHTML = '';

    // Header
    const header = createElement('header', 'lib-header', `
    <div class="lib-header-brand">
      <span class="lib-logo">📝</span>
      <h1>NoteYT Library</h1>
    </div>
  `);

    // Controls row
    const controls = createElement('div', 'lib-controls');

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.id = 'lib-search';
    searchInput.className = 'lib-search';
    searchInput.placeholder = 'Search by title or channel…';
    searchInput.value = searchQuery;
    searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        renderGrid(gridContainer);
        updateSelectionBar();
    });

    const sortSelect = document.createElement('select');
    sortSelect.className = 'lib-sort';
    const sortOptions: Array<{ value: SortKey; label: string }> = [
        { value: 'lastEdited', label: 'Last edited' },
        { value: 'noteCount', label: 'Note count' },
        { value: 'title', label: 'Alphabetical' },
    ];
    for (const opt of sortOptions) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        o.selected = opt.value === sortKey;
        sortSelect.appendChild(o);
    }
    sortSelect.addEventListener('change', () => {
        sortKey = sortSelect.value as SortKey;
        renderGrid(gridContainer);
    });

    const exportAllBtn = document.createElement('button');
    exportAllBtn.className = 'lib-btn lib-btn--ghost';
    exportAllBtn.textContent = '⬇ Export All (.zip)';
    exportAllBtn.addEventListener('click', handleExportAll);

    controls.appendChild(searchInput);
    controls.appendChild(sortSelect);
    controls.appendChild(exportAllBtn);

    const videoCount = Object.keys(allVideos).length;
    const stats = createElement(
        'div',
        'lib-stats',
        `${videoCount} video${videoCount !== 1 ? 's' : ''} with notes`
    );

    // ── Watch Later section ──────────────────────────────────────────────────
    let watchLaterSection: HTMLElement | null = null;
    if (watchLaterList.length > 0) {
        watchLaterSection = buildWatchLaterSection();
    }

    // ── Selection toolbar (Fix #5) ───────────────────────────────────────────
    const selectionBar = createElement('div', 'lib-selection-bar lib-selection-bar--hidden');
    selectionBar.id = 'lib-selection-bar';

    const selectAllChk = document.createElement('input');
    selectAllChk.type = 'checkbox';
    selectAllChk.id = 'lib-select-all';
    selectAllChk.className = 'lib-select-all-chk';
    selectAllChk.title = 'Select all';
    selectAllChk.addEventListener('change', () => {
        const entries = getFilteredEntries();
        if (selectAllChk.checked) {
            entries.forEach(([id]) => selectedIds.add(id));
        } else {
            selectedIds.clear();
        }
        renderGrid(gridContainer);
        updateSelectionBar();
    });

    const selectAllLabel = document.createElement('label');
    selectAllLabel.htmlFor = 'lib-select-all';
    selectAllLabel.textContent = 'Select all';
    selectAllLabel.className = 'lib-selection-label';

    const selCountSpan = createElement('span', 'lib-sel-count', '0 selected');
    selCountSpan.id = 'lib-sel-count';

    const exportSelBtn = createElement('button', 'lib-btn lib-btn--ghost lib-btn--sm', '⬇ Export Selected');
    exportSelBtn.addEventListener('click', handleExportSelected);

    const deleteSelBtn = createElement('button', 'lib-btn lib-btn--danger lib-btn--sm', '🗑 Delete Selected');
    deleteSelBtn.addEventListener('click', () => handleDeleteSelected(gridContainer));

    const clearSelBtn = createElement('button', 'lib-btn lib-btn--ghost lib-btn--sm lib-sel-clear', '✕ Clear');
    clearSelBtn.addEventListener('click', () => {
        selectedIds.clear();
        (document.getElementById('lib-select-all') as HTMLInputElement | null)!.checked = false;
        renderGrid(gridContainer);
        updateSelectionBar();
    });

    selectionBar.appendChild(selectAllChk);
    selectionBar.appendChild(selectAllLabel);
    selectionBar.appendChild(selCountSpan);
    selectionBar.appendChild(exportSelBtn);
    selectionBar.appendChild(deleteSelBtn);
    selectionBar.appendChild(clearSelBtn);

    const gridContainer = createElement('div', 'lib-grid');

    app.appendChild(header);
    app.appendChild(controls);
    app.appendChild(stats);
    if (watchLaterSection) app.appendChild(watchLaterSection);
    app.appendChild(selectionBar);
    app.appendChild(gridContainer);

    renderGrid(gridContainer);
}

function getFilteredEntries(): Array<[string, VideoRecord]> {
    const query = searchQuery.toLowerCase();
    let entries = Object.entries(allVideos).filter(([, record]) => {
        if (!query) return true;
        return (
            record.title.toLowerCase().includes(query) ||
            record.channel.toLowerCase().includes(query)
        );
    });

    entries = entries.sort(([, a], [, b]) => {
        if (sortKey === 'lastEdited') {
            return new Date(b.lastEdited).getTime() - new Date(a.lastEdited).getTime();
        }
        if (sortKey === 'noteCount') {
            return b.notes.length - a.notes.length;
        }
        return a.title.localeCompare(b.title);
    });

    return entries;
}

function updateSelectionBar(): void {
    const bar = document.getElementById('lib-selection-bar');
    const countSpan = document.getElementById('lib-sel-count');
    const selectAllChk = document.getElementById('lib-select-all') as HTMLInputElement | null;
    if (!bar || !countSpan) return;

    const count = selectedIds.size;
    const totalEntries = getFilteredEntries().length;

    if (count > 0) {
        bar.classList.remove('lib-selection-bar--hidden');
    } else {
        bar.classList.add('lib-selection-bar--hidden');
    }

    countSpan.textContent = `${count} selected`;

    if (selectAllChk) {
        selectAllChk.indeterminate = count > 0 && count < totalEntries;
        selectAllChk.checked = count > 0 && count === totalEntries;
    }
}

function renderGrid(container: HTMLElement): void {
    container.innerHTML = '';

    const entries = getFilteredEntries();

    if (entries.length === 0) {
        const empty = createElement('div', 'lib-empty', searchQuery
            ? `No videos matching "${searchQuery}"`
            : 'No notes yet. Head to a YouTube video and start writing!'
        );
        container.appendChild(empty);
        return;
    }

    for (const [videoId, record] of entries) {
        container.appendChild(buildVideoCard(videoId, record));
    }
}

function buildVideoCard(videoId: string, record: VideoRecord): HTMLElement {
    const card = createElement('div', 'lib-card' + (selectedIds.has(videoId) ? ' lib-card--selected' : ''));
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `View notes for ${record.title}`);
    card.dataset.videoId = videoId;

    // Selection checkbox (Fix #5)
    const chkWrapper = createElement('div', 'lib-card-chk-wrap');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'lib-card-chk';
    chk.checked = selectedIds.has(videoId);
    chk.setAttribute('aria-label', `Select ${record.title}`);
    chk.addEventListener('change', (e) => {
        e.stopPropagation();
        if (chk.checked) {
            selectedIds.add(videoId);
            card.classList.add('lib-card--selected');
        } else {
            selectedIds.delete(videoId);
            card.classList.remove('lib-card--selected');
        }
        updateSelectionBar();
    });
    chkWrapper.appendChild(chk);
    card.appendChild(chkWrapper);

    const thumb = createElement('div', 'lib-card-thumb');
    const img = document.createElement('img');
    img.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    img.alt = record.title;
    img.loading = 'lazy';
    img.className = 'lib-card-img';
    thumb.appendChild(img);

    const body = createElement('div', 'lib-card-body');

    const title = createElement('h2', 'lib-card-title', record.title);
    const channel = createElement('p', 'lib-card-channel', record.channel);

    const meta = createElement('div', 'lib-card-meta');
    meta.innerHTML = `
    <span class="lib-badge">${record.notes.length} note${record.notes.length !== 1 ? 's' : ''}</span>
    <span class="lib-card-date">${formatRelativeDate(record.lastEdited)}</span>
  `;

    body.appendChild(title);
    body.appendChild(channel);
    body.appendChild(meta);
    card.appendChild(thumb);
    card.appendChild(body);

    const openDetail = () => {
        window.location.hash = `#video=${videoId}`;
    };
    card.addEventListener('click', (e) => {
        // Don't navigate if clicking the checkbox area
        if ((e.target as HTMLElement).closest('.lib-card-chk-wrap')) return;
        openDetail();
    });
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') openDetail();
    });

    return card;
}

// ─── Watch Later section ──────────────────────────────────────────────────────

function buildWatchLaterSection(): HTMLElement {
    const section = createElement('div', 'lib-wl-section');

    const sectionHeader = createElement('div', 'lib-wl-header');
    const sectionTitle = createElement('h2', 'lib-wl-title', '🕐 Watch Later');
    const sectionCount = createElement('span', 'lib-wl-count', `${watchLaterList.length}`);
    sectionHeader.appendChild(sectionTitle);
    sectionHeader.appendChild(sectionCount);
    section.appendChild(sectionHeader);

    const grid = createElement('div', 'lib-wl-grid');

    for (const entry of watchLaterList) {
        grid.appendChild(buildWatchLaterCard(entry, grid, section));
    }

    section.appendChild(grid);
    return section;
}

function buildWatchLaterCard(
    entry: WatchLaterEntry,
    grid: HTMLElement,
    section: HTMLElement
): HTMLElement {
    const card = createElement('div', 'lib-wl-card');

    const thumb = createElement('div', 'lib-wl-thumb');
    const img = document.createElement('img');
    img.src = `https://img.youtube.com/vi/${entry.videoId}/hqdefault.jpg`;
    img.alt = entry.title;
    img.loading = 'lazy';
    img.className = 'lib-wl-img';
    thumb.appendChild(img);
    card.appendChild(thumb);

    const body = createElement('div', 'lib-wl-body');
    const titleEl = createElement('p', 'lib-wl-card-title', entry.title);
    const channelEl = createElement('p', 'lib-wl-card-channel', entry.channel);
    const addedEl = createElement('p', 'lib-wl-added', `Added ${formatRelativeDate(entry.addedAt)}`);
    body.appendChild(titleEl);
    body.appendChild(channelEl);
    body.appendChild(addedEl);
    card.appendChild(body);

    const actions = createElement('div', 'lib-wl-actions');

    const openBtn = createElement('a', 'lib-btn lib-btn--primary lib-btn--sm', '▶ Watch');
    (openBtn as HTMLAnchorElement).href = entry.url;
    (openBtn as HTMLAnchorElement).target = '_blank';
    (openBtn as HTMLAnchorElement).rel = 'noopener';
    actions.appendChild(openBtn);

    const removeBtn = createElement('button', 'lib-btn lib-btn--ghost lib-btn--sm', '✕ Remove');
    removeBtn.addEventListener('click', async () => {
        await removeFromWatchLater(entry.videoId);
        watchLaterList = watchLaterList.filter((e) => e.videoId !== entry.videoId);
        card.remove();
        // Update count
        const countEl = section.querySelector('.lib-wl-count');
        if (countEl) countEl.textContent = `${watchLaterList.length}`;
        // Hide section if empty
        if (watchLaterList.length === 0) section.remove();
    });
    actions.appendChild(removeBtn);

    card.appendChild(actions);
    return card;
}

// ─── Detail view ──────────────────────────────────────────────────────────────

function renderDetailView(videoId: string): void {
    currentDetailVideoId = videoId;
    const record = allVideos[videoId];
    if (!record) {
        renderLibraryView();
        return;
    }

    const app = document.getElementById('app')!;
    app.innerHTML = '';

    // Back button
    const backBtn = createElement('button', 'lib-back-btn', '← Back to Library');
    backBtn.setAttribute('aria-label', 'Back to library');
    backBtn.addEventListener('click', () => {
        window.location.hash = '';
        renderLibraryView();
    });

    // Video header
    const videoHeader = createElement('div', 'lib-detail-header');
    const thumbImg = document.createElement('img');
    thumbImg.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    thumbImg.alt = record.title;
    thumbImg.className = 'lib-detail-thumb';

    const videoMeta = createElement('div', 'lib-detail-meta');
    videoMeta.innerHTML = `
    <h1 class="lib-detail-title">${escapeHtml(record.title)}</h1>
    <p class="lib-detail-channel">${escapeHtml(record.channel)}</p>
    <a class="lib-detail-link" href="${escapeHtml(record.url)}" target="_blank" rel="noopener">
      Open on YouTube ↗
    </a>
    <p class="lib-detail-stats">
      ${record.notes.length} note${record.notes.length !== 1 ? 's' : ''} · 
      Last edited ${formatRelativeDate(record.lastEdited)}
    </p>
  `;

    const actions = createElement('div', 'lib-detail-actions');

    const exportBtn = createElement('button', 'lib-btn lib-btn--ghost', '⬇ Export .md');
    exportBtn.addEventListener('click', () => exportSingleVideo(videoId, record));

    const openVideoBtn = createElement('button', 'lib-btn lib-btn--primary', '▶ Open & Edit on YouTube');
    openVideoBtn.addEventListener('click', () => {
        window.open(record.url, '_blank', 'noopener');
    });

    const deleteVideoBtn = createElement('button', 'lib-btn lib-btn--danger', '🗑 Delete all notes');
    deleteVideoBtn.addEventListener('click', async () => {
        if (!confirm(`Delete all notes for "${record.title}"? This cannot be undone.`)) return;
        await deleteVideoRecord(videoId);
        delete allVideos[videoId];
        window.location.hash = '';
        renderLibraryView();
    });

    actions.appendChild(exportBtn);
    actions.appendChild(openVideoBtn);
    actions.appendChild(deleteVideoBtn);

    videoHeader.appendChild(thumbImg);
    videoHeader.appendChild(videoMeta);

    // Notes list (read-only rendered markdown)
    const notesList = createElement('div', 'lib-notes-list');

    const sorted = [...record.notes].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    if (sorted.length === 0) {
        notesList.appendChild(createElement('p', 'lib-empty', 'No notes for this video yet.'));
    }

    for (const note of sorted) {
        notesList.appendChild(buildNoteCard(note, videoId));
    }

    app.appendChild(backBtn);
    app.appendChild(videoHeader);
    app.appendChild(actions);
    app.appendChild(notesList);
}

function buildNoteCard(
    note: import('../lib/storage').NoteEntry,
    videoId: string
): HTMLElement {
    const card = createElement('div', 'lib-note-card');

    if (note.timestampEnabled && note.timestampSeconds !== null) {
        const ts = formatTimestamp(note.timestampSeconds);
        const url = `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(note.timestampSeconds)}s`;
        const chip = createElement('a', 'lib-ts-chip', `⏱ ${ts}`);
        (chip as HTMLAnchorElement).href = url;
        (chip as HTMLAnchorElement).target = '_blank';
        (chip as HTMLAnchorElement).rel = 'noopener';
        chip.title = `Seek to ${ts} on YouTube`;
        card.appendChild(chip);
    }

    // Render markdown as HTML using a simple parser
    const content = createElement('div', 'lib-note-content');
    content.innerHTML = renderMarkdownToHtml(note.markdown);
    card.appendChild(content);

    const meta = createElement('p', 'lib-note-meta',
        `Added ${formatRelativeDate(note.createdAt)}`
    );
    card.appendChild(meta);

    return card;
}

// ─── Export handlers ──────────────────────────────────────────────────────────

async function handleExportAll(): Promise<void> {
    const entries = Object.entries(allVideos);
    if (entries.length === 0) return;

    const zip = new JSZip();

    for (const [videoId, record] of entries) {
        const md = renderVideoToMarkdown(videoId, record);
        const filename = slugify(record.title) + '.md';
        zip.file(filename, md);
    }

    await downloadZip(zip, 'noteyt-export-all');
}

async function handleExportSelected(): Promise<void> {
    if (selectedIds.size === 0) return;

    const zip = new JSZip();

    for (const videoId of selectedIds) {
        const record = allVideos[videoId];
        if (!record) continue;
        const md = renderVideoToMarkdown(videoId, record);
        const filename = slugify(record.title) + '.md';
        zip.file(filename, md);
    }

    await downloadZip(zip, `noteyt-export-${selectedIds.size}-videos`);
}

async function handleDeleteSelected(gridContainer: HTMLElement): Promise<void> {
    if (selectedIds.size === 0) return;

    const count = selectedIds.size;
    if (!confirm(`Delete all notes for ${count} selected video${count !== 1 ? 's' : ''}? This cannot be undone.`)) return;

    for (const videoId of selectedIds) {
        await deleteVideoRecord(videoId);
        delete allVideos[videoId];
    }
    selectedIds.clear();
    renderGrid(gridContainer);
    updateSelectionBar();

    // Update stats
    const statsEl = document.querySelector('.lib-stats');
    if (statsEl) {
        const vc = Object.keys(allVideos).length;
        statsEl.textContent = `${vc} video${vc !== 1 ? 's' : ''} with notes`;
    }
}

async function downloadZip(zip: JSZip, baseName: string): Promise<void> {
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().split('T')[0];
    a.href = url;
    a.download = `${baseName}-${date}.zip`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function createElement(
    tag: string,
    className: string,
    text?: string
): HTMLElement {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatRelativeDate(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
}

function formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function slugify(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * Minimal markdown → HTML renderer for read-only display in the library.
 */
function renderMarkdownToHtml(markdown: string): string {
    let html = escapeHtml(markdown);

    // Code blocks (must come before inline code)
    html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
        `<pre class="lib-code-block"><code>${code.trim()}</code></pre>`
    );

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr />');

    // Bold + italic (order matters)
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Inline code
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');

    // Links
    html = html.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );

    // Task lists (before regular lists)
    html = html.replace(/^- \[x\] (.+)$/gm, '<li class="lib-task-done"><input type="checkbox" checked disabled /> $1</li>');
    html = html.replace(/^- \[ \] (.+)$/gm, '<li class="lib-task"><input type="checkbox" disabled /> $1</li>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Paragraphs (double newline)
    html = html
        .split(/\n{2,}/)
        .map((block) => {
            if (/^<(h[1-3]|ul|ol|li|pre|blockquote|hr)/.test(block.trim())) return block;
            return `<p>${block.replace(/\n/g, '<br />')}</p>`;
        })
        .join('\n');

    return html;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

init();
