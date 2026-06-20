/**
 * editor.ts — TipTap WYSIWYG editor setup
 *
 * WHY TIPTAP over alternatives?
 * ─────────────────────────────
 * 1. Milkdown: Also ProseMirror-based and markdown-native, but its plugin
 *    architecture is more opaque (effect system, ctx tokens) making it harder
 *    to integrate into a non-framework content script. TipTap's imperative
 *    API (editor.chain().focus().toggleBold().run()) is straightforward.
 *
 * 2. Plain contenteditable + marked/markdown-it: We'd have to hand-build the
 *    cursor-safe serialisation/deserialisation round-trip ourselves. ProseMirror
 *    (which TipTap wraps) already solves this correctly and handles edge cases
 *    like nested lists, cursor restoration, and IME input that are genuinely
 *    hard to get right from scratch.
 *
 * 3. CodeMirror: Excellent for code, not designed for rich-text prose with
 *    mixed block types (headings, task lists, blockquotes).
 *
 * 4. TipTap bundle size: ~70 KB minified+gzipped for the starter kit — acceptable
 *    given we're building a dev-tool extension, not a public webpage.
 *    We import individual extensions (not StarterKit) to tree-shake precisely.
 *
 * tiptap-markdown extension handles the Markdown ↔ ProseMirror roundtrip,
 * meaning we store raw `.md` text in storage (portable, exportable) rather
 * than TipTap's JSON (opaque, version-coupled).
 */

import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Heading from '@tiptap/extension-heading';
import BulletList from '@tiptap/extension-bullet-list';
import OrderedList from '@tiptap/extension-ordered-list';
import ListItem from '@tiptap/extension-list-item';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Blockquote from '@tiptap/extension-blockquote';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import HardBreak from '@tiptap/extension-hard-break';
import Link from '@tiptap/extension-link';
import History from '@tiptap/extension-history';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';

export interface EditorOptions {
    /** The DOM element TipTap should mount into */
    element: HTMLElement;
    /** Initial markdown content (empty string for a new note) */
    initialMarkdown: string;
    /** Called (debounced by the caller) whenever the document changes */
    onChange: (markdown: string) => void;
    /** Placeholder text shown when editor is empty */
    placeholder?: string;
}

export interface NoteEditor {
    /** Get the current content as a markdown string */
    getMarkdown(): string;
    /** Replace the entire content with new markdown */
    setMarkdown(markdown: string): void;
    /** Focus the editor */
    focus(): void;
    /** Clear the editor content */
    clear(): void;
    /** Destroy the editor and clean up ProseMirror listeners */
    destroy(): void;
    /** Raw TipTap instance — for toolbar commands */
    tiptap: Editor;
}

/** Create and mount a TipTap editor instance */
export function createEditor(options: EditorOptions): NoteEditor {
    const { element, initialMarkdown, onChange, placeholder } = options;

    const editor = new Editor({
        element,
        extensions: [
            Document,
            Paragraph,
            Text,
            Bold,
            Italic,
            Strike,
            Code,
            CodeBlock,
            Heading.configure({ levels: [1, 2, 3] }),
            BulletList,
            OrderedList,
            ListItem,
            TaskList,
            TaskItem.configure({ nested: true }),
            Blockquote,
            HorizontalRule,
            HardBreak,
            Link.configure({
                openOnClick: false, // we handle click-to-seek for timestamp chips
                autolink: true,
            }),
            History,
            Placeholder.configure({
                placeholder: placeholder ?? 'Start typing your note… (markdown supported)',
            }),
            // tiptap-markdown: enables editor.storage.markdown.getMarkdown()
            // and accepts markdown as initial content via setContent().
            Markdown.configure({
                html: false,          // Don't allow raw HTML — safer in a content script
                tightLists: true,     // Compact lists (no extra <p> wrappers)
                bulletListMarker: '-',
                transformCopiedText: true,  // Paste as markdown when copying
                transformPastedText: true,  // Accept pasted markdown and render it
            }),
        ],
        content: initialMarkdown
            ? editor_parseMarkdown(initialMarkdown)
            : '',
        editorProps: {
            attributes: {
                // Scoped class so panel.css can target the editor without leaking
                class: 'ynx-editor-content',
                spellcheck: 'true',
            },
        },
        onUpdate({ editor: e }) {
            const md = e.storage.markdown.getMarkdown() as string;
            onChange(md);
        },
    });

    return {
        getMarkdown() {
            return editor.storage.markdown.getMarkdown() as string;
        },
        setMarkdown(markdown: string) {
            // setContent accepts markdown when the Markdown extension is active
            editor.commands.setContent(markdown, false /* don't emit update */);
        },
        focus() {
            editor.commands.focus('end');
        },
        clear() {
            editor.commands.clearContent(true);
        },
        destroy() {
            editor.destroy();
        },
        tiptap: editor,
    };
}

/**
 * Tiny helper used only during construction: TipTap's setContent accepts
 * a markdown string when the Markdown extension is present, but the
 * constructor `content` field expects the same format.
 * We return the raw markdown string — TipTap's Markdown extension will
 * parse it on initialisation.
 */
function editor_parseMarkdown(md: string): string {
    return md;
}

// ─── Toolbar helpers ─────────────────────────────────────────────────────────

/**
 * Build the floating mini toolbar element and wire up buttons.
 * Returns the toolbar <div> so the caller can insert it above the editor.
 */
export function createToolbar(editor: NoteEditor): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'ynx-toolbar';

    const buttons: Array<{ label: string; title: string; action: () => void; isActive?: () => boolean }> = [
        {
            label: 'B',
            title: 'Bold (Ctrl+B)',
            action: () => editor.tiptap.chain().focus().toggleBold().run(),
            isActive: () => editor.tiptap.isActive('bold'),
        },
        {
            label: 'I',
            title: 'Italic (Ctrl+I)',
            action: () => editor.tiptap.chain().focus().toggleItalic().run(),
            isActive: () => editor.tiptap.isActive('italic'),
        },
        {
            label: 'S̶',
            title: 'Strikethrough',
            action: () => editor.tiptap.chain().focus().toggleStrike().run(),
            isActive: () => editor.tiptap.isActive('strike'),
        },
        {
            label: '</>',
            title: 'Inline code',
            action: () => editor.tiptap.chain().focus().toggleCode().run(),
            isActive: () => editor.tiptap.isActive('code'),
        },
        {
            label: 'H1',
            title: 'Heading 1',
            action: () => editor.tiptap.chain().focus().toggleHeading({ level: 1 }).run(),
            isActive: () => editor.tiptap.isActive('heading', { level: 1 }),
        },
        {
            label: 'H2',
            title: 'Heading 2',
            action: () => editor.tiptap.chain().focus().toggleHeading({ level: 2 }).run(),
            isActive: () => editor.tiptap.isActive('heading', { level: 2 }),
        },
        {
            label: 'H3',
            title: 'Heading 3',
            action: () => editor.tiptap.chain().focus().toggleHeading({ level: 3 }).run(),
            isActive: () => editor.tiptap.isActive('heading', { level: 3 }),
        },
        {
            label: '• List',
            title: 'Bullet list',
            action: () => editor.tiptap.chain().focus().toggleBulletList().run(),
            isActive: () => editor.tiptap.isActive('bulletList'),
        },
        {
            label: '1. List',
            title: 'Ordered list',
            action: () => editor.tiptap.chain().focus().toggleOrderedList().run(),
            isActive: () => editor.tiptap.isActive('orderedList'),
        },
        {
            label: '☑',
            title: 'Task list',
            action: () => editor.tiptap.chain().focus().toggleTaskList().run(),
            isActive: () => editor.tiptap.isActive('taskList'),
        },
        {
            label: '❝',
            title: 'Blockquote',
            action: () => editor.tiptap.chain().focus().toggleBlockquote().run(),
            isActive: () => editor.tiptap.isActive('blockquote'),
        },
    ];

    for (const btn of buttons) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'ynx-toolbar-btn';
        el.textContent = btn.label;
        el.title = btn.title;
        el.addEventListener('click', (e) => {
            e.preventDefault();
            btn.action();
            // Update active state visually after the command runs
            updateActiveStates();
        });
        bar.appendChild(el);
    }

    // Update active highlights when editor selection changes
    editor.tiptap.on('selectionUpdate', updateActiveStates);
    editor.tiptap.on('transaction', updateActiveStates);

    function updateActiveStates() {
        const btns = bar.querySelectorAll<HTMLButtonElement>('.ynx-toolbar-btn');
        btns.forEach((el, i) => {
            const isActive = buttons[i]?.isActive?.() ?? false;
            el.classList.toggle('ynx-toolbar-btn--active', isActive);
        });
    }

    return bar;
}
