<script module lang="ts">
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { preloadHighlighter as preload } from '../../files/highlight';
    // shiki and its grammars load in the highlighter's worker as soon as the app is idle after start (they took about
    // 0.4 s plus 0.5 s for the Svelte grammar on the first file opened); in the worker this costs the page nothing.
    if (typeof window !== 'undefined') {
        const idle =
            globalThis.requestIdleCallback ??
            ((run: () => void) => setTimeout(run, 300));
        setTimeout(() => idle(preload, { timeout: 1500 }), 600);
    }

    // Coloured code by language, theme and text, shared by every answer: a row the virtual list mounts again gets its
    // colours at once, with no second pass through shiki (it was kept per component, so every remount coloured again:
    // profiled at hundreds of ms in the middle of a scroll). Very long blocks stay plain.
    const COLOUR_MAX_CHARS = 20_000;
    const coloured = new SvelteMap<string, string>();
    const COLOURED_MAX = 600;

    // Which paths exist (path_links.rs), kept for the session: a row that mounts again is marked at once, with no second
    // look at the disk. A path the agent is about to create is looked at again after a while (CHECK_AGAIN_MS).
    type Found = { exists: boolean; dir: boolean; path: string; at: number };
    const found = new SvelteMap<string, Found>();
    const FOUND_MAX = 3000;
    const CHECK_AGAIN_MS = 15_000;
    // Pictures from the web as data URLs (image_fetch), or null when they could not be had.
    // Kept by total size, not by count: one picture can be 15 MB, and a data URL is a third larger than its bytes.
    const pictures = new SvelteMap<string, string | null>();
    const PICTURES_MAX_CHARS = 40_000_000;
    let picturesChars = 0;
    function rememberPicture(url: string, data: string | null) {
        pictures.set(url, data);
        picturesChars += data?.length ?? 0;
        // The oldest go first; the newest stays even when it alone is over the limit (it is on screen).
        for (const [key, value] of pictures) {
            if (picturesChars <= PICTURES_MAX_CHARS || pictures.size <= 1)
                break;
            pictures.delete(key);
            picturesChars -= value?.length ?? 0;
        }
    }
</script>

<script lang="ts">
    import { untrack } from 'svelte';
    import { highlightHtml } from '../../files/highlight';
    import {
        isLocalUrl,
        linkMenu,
        openExternal,
        openInPreview,
        terminalCommand,
    } from '../../browser/browser.svelte';
    import { inTauri } from '../../app/platform/history';
    import { openTablePreview } from '../../browser/preview.svelte';
    import {
        gripAt,
        layoutTable,
        startResize,
    } from '../../app/text/table-layout';
    import {
        colourFinished,
        colourStarted,
        eagerColour,
        markdownBlocks,
        renderMarkdown,
    } from '../../app/text/markdown';
    import { runInTerminal } from '../../terminal/terminal.svelte';
    import { theme } from '../../app/ui/theme.svelte';
    import {
        displayPath,
        fileRootOf,
        isAbsolutePath,
        resolveInProject,
    } from '../../files/paths';
    import { normalizePath } from '../../files/path-links';
    import { openInViewer } from '../../files/file-viewer.svelte';
    import { activeSession, workspace } from '../../chat/sessions.svelte';

    const IMAGE_NOT_FOUND_SRC = '/assets/image-not-found.png';

    // An answer as rich text: headings, lists, tables, quotes, links and code cards with a copy button.
    // Code is coloured once the answer has stopped streaming, so nothing flickers while text arrives.
    let {
        text,
        streaming = false,
        onrendered,
        flush = false,
    }: {
        text: string;
        streaming?: boolean;
        onrendered?: () => void;
        /** Show the rest at once (a newer message came after this one). */ flush?: boolean;
    } = $props();

    // Text arrives in bursts. It is revealed at a steady, time-based pace instead (faster when more is waiting),
    // whole words at a time, and each new word fades in, as in Claude and ChatGPT. A finished answer that was
    // never streamed shows at once.
    // The pace is held by lag, as assistant-ui's useSmooth does: what is waiting is shown over DRAIN_SECONDS, never slower
    // than MIN_CPS. There is no top speed, so a fast model is never left seconds behind; a burst spreads over a quarter
    // second and the speed falls off smoothly as the backlog empties. A newer message shows the rest at once (`flush`).
    const DRAIN_SECONDS = 0.25;
    const MIN_CPS = 200;
    const FADE_MS = 220;
    const STAGGER_MS = 18;
    // Past FADE_LIMIT words in flight, new ones simply appear: fading dozens at once costs frames.
    const FADE_LIMIT = 80;
    // Each shown word re-parses the block being written; doing it every frame made a long block drop frames. The reveal
    // keeps its own pace every frame, but the text on screen moves on at most every COMMIT_MS (the fades hide the step).
    const COMMIT_MS = 32;

    let live = untrack(() => streaming);
    // What has arrived before this block was put on screen shows at once: coming back to a chat that is still writing must
    // not type its answer out again from the start. Only text that arrives from now on is revealed.
    let shown = $state(untrack(() => text.length));
    const catching = $derived(shown < text.length);
    // Where the even reveal really is (may sit inside a word): kept across text updates, so each new burst does not
    // restart it from the end of the last shown word.
    let pace = untrack(() => shown);
    const reducedMotion =
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;

    /** The end of the word that `at` falls in, so a word never shows half typed. */
    function wordEnd(source: string, at: number, limit: number) {
        let end = at;
        while (end < limit && end - at < 24 && !/\s/.test(source[end])) end++;
        return graphemeEnd(source, end, limit);
    }

    /** Never cut inside a character drawn as one: the second half of a surrogate pair, a combining accent, an emoji joined
     *  with a zero-width joiner or a variation selector would otherwise show broken for a frame. */
    function graphemeEnd(source: string, at: number, limit: number) {
        let end = at;
        while (end < limit) {
            const code = source.charCodeAt(end);
            const joined = end > 0 && source.charCodeAt(end - 1) === 0x200d;
            if (
                (code >= 0xdc00 && code <= 0xdfff) ||
                joined ||
                /\u200d|\ufe0e|\ufe0f|\p{M}/u.test(source[end])
            )
                end++;
            else break;
        }
        return end;
    }

    /** A link `[name](path)` is never shown half typed: its raw text (with the whole path) would show and then shrink to
     *  the name. When `at` falls inside one, the reveal waits before it, or takes the whole link at once when it has arrived. */
    function linkSafe(source: string, at: number, limit: number) {
        const open = source.lastIndexOf('[', at - 1);
        if (open < 0 || at - open > 800) return at;
        const head = source.slice(open, at);
        if (!/^\[[^\]\n]*$|^\[[^\]\n]*\]$|^\[[^\]\n]*\]\([^)\n]*$/.test(head))
            return at;
        const whole = /^\[[^\]\n]*\]\([^)\n]*\)/.exec(
            source.slice(open, limit),
        );
        return whole ? open + whole[0].length : open;
    }

    $effect(() => {
        const source = text;
        const target = source.length;
        if (streaming) live = true;
        if (!live || reducedMotion || (flush && !streaming)) {
            shown = pace = target;
            return;
        }
        if (untrack(() => shown) > target) shown = target;
        goal = { source, target };
        if (frame) return;
        last = performance.now();
        frame = requestAnimationFrame(step);
    });
    $effect(() => () => {
        cancelAnimationFrame(frame);
        frame = 0;
    });

    // One reveal loop runs while text is waiting. A new piece only moves its goal: restarting the loop on every piece (a
    // fast model sends one every frame) reset the commit throttle and lost part of each frame, so the pace stuttered.
    let goal = { source: '', target: 0 };
    let frame = 0;
    let last = 0;
    let committedAt = 0;
    function step(now: number) {
        const { source, target } = goal;
        const dt = Math.max(0, Math.min(64, now - last)) / 1000;
        last = now;
        let progress = Math.min(pace, target);
        const backlog = target - progress;
        if (backlog <= 0) {
            frame = 0;
            return;
        }
        const rate = Math.max(MIN_CPS, backlog / DRAIN_SECONDS);
        progress = pace = Math.min(target, progress + rate * dt);
        const next = linkSafe(
            source,
            wordEnd(source, Math.floor(progress), target),
            target,
        );
        // `progress` keeps its own pace: pulling it to the end of each shown word would double the real speed.
        if (
            next > shown &&
            (next >= target || now - committedAt >= COMMIT_MS)
        ) {
            shown = next;
            committedAt = now;
        }
        frame = requestAnimationFrame(step);
    }

    // The answer is drawn block by block (markdown.ts `markdownBlocks`). While it streams, the blocks already complete
    // keep their HTML string, so their DOM is left alone; only the block being written is parsed and replaced. Parsing
    // and replacing the whole answer on every frame made a long answer stutter as it grew.
    let lastRaw: string[] = [];
    let lastHtml: string[] = [];
    const html = $derived.by(() => {
        const raw = markdownBlocks(text.slice(0, shown), lastRaw);
        const growing = streaming || shown < text.length;
        const next = raw.map((block, index) =>
            lastRaw[index] === block
                ? lastHtml[index]
                : renderMarkdown(block, !(growing && index === raw.length - 1)),
        );
        lastRaw = raw;
        lastHtml = next;
        return next;
    });
    let root: HTMLDivElement | undefined = $state();

    // Notify the chat only after the completed response has been revealed and this DOM update has landed.
    $effect(() => {
        if (!streaming && text.length > 0 && shown >= text.length)
            onrendered?.();
    });

    // Each step replaces the HTML of the blocks that changed, so the fade is kept by offset in a block's visible text: a
    // word seen before keeps its start time (a negative delay resumes its fade), a new word starts now.
    const fadeStarts = new SvelteMap<string, number>();
    let seen: number[] = [];
    let fadedHtml: string[] = [];

    function fadeTail(blocks: HTMLElement[], from: number) {
        const now = performance.now();
        for (const [key, start] of fadeStarts)
            if (now - start > FADE_MS) fadeStarts.delete(key);
        let fresh = 0;
        for (let index = from; index < blocks.length; index++) {
            const block = blocks[index];
            const before = seen[index] ?? 0;
            const walker = document.createTreeWalker(
                block,
                NodeFilter.SHOW_TEXT,
            );
            const tail: [Text, number][] = [];
            let offset = 0;
            for (
                let node = walker.nextNode() as Text | null;
                node;
                node = walker.nextNode() as Text | null
            ) {
                // Svelte owns the top-level nodes of {@html}; only text inside elements is split. Code stays plain.
                const parent = node.parentElement;
                if (parent && parent !== block && !parent.closest('pre'))
                    tail.push([node, offset]);
                offset += node.data.length;
            }
            for (const [node, base] of tail) {
                const out = document.createDocumentFragment();
                let at = base;
                let split = false;
                for (const piece of node.data.split(/(\s+)/)) {
                    if (!piece) continue;
                    const key = `${index}:${at}`;
                    const known = fadeStarts.get(key);
                    // A word shown before with no fade in progress stays plain. (When the markdown of the earlier text changes,
                    // offsets shift by a character or two; without this check those words would fade in again.)
                    if (
                        /^\s+$/.test(piece) ||
                        (known === undefined && at < before) ||
                        (known === undefined && fadeStarts.size >= FADE_LIMIT)
                    ) {
                        out.append(piece);
                    } else {
                        let start = known;
                        if (start === undefined)
                            fadeStarts.set(
                                key,
                                (start =
                                    now + Math.min(fresh++, 6) * STAGGER_MS),
                            );
                        const word = document.createElement('span');
                        word.className = 'md-fade';
                        word.style.animationDelay = `${Math.round(start - now)}ms`;
                        word.textContent = piece;
                        out.append(word);
                        split = true;
                    }
                    at += piece.length;
                }
                if (split) node.replaceWith(out);
            }
            seen[index] = offset;
        }
        seen.length = blocks.length;
    }

    $effect(() => {
        const current = html;
        if (!root || !live || reducedMotion) return;
        const container = root;
        untrack(() => {
            // Only the blocks whose HTML changed since the last step are walked: the others still hold their fades.
            let from = 0;
            while (from < current.length && fadedHtml[from] === current[from])
                from++;
            fadedHtml = current;
            const blocks = [...container.children].filter(
                (child): child is HTMLElement =>
                    child instanceof HTMLElement &&
                    child.classList.contains('md-block'),
            );
            fadeTail(blocks, from);
        });
    });

    // A code block or table that is shown in the moment its answer is read reveals itself (rows one after another). The
    // same block mounted again later (a scroll back into view) carries an old time and does not replay.
    const REVEAL_MS = 2000;
    function reveal(container: HTMLElement) {
        for (const block of container.querySelectorAll<HTMLElement>(
            '.md-code[data-at], .md-table[data-at]',
        )) {
            if (
                block.classList.contains('md-reveal') ||
                Date.now() - Number(block.dataset.at) > REVEAL_MS
            )
                continue;
            block.classList.add('md-reveal');
            [...block.querySelectorAll<HTMLElement>('tbody tr')].forEach(
                (row, index) =>
                    row.style.setProperty('--row', String(Math.min(index, 12))),
            );
        }
    }

    // The newest full colouring of this reply. An older one still waiting on shiki (a theme switch, a re-render) must not
    // write its colours after the newer one: its late answer would put the old theme's colours back on a block that is
    // marked for the new theme, and nothing would correct it until the text changed (no error, the colours just stay wrong).
    let colourRun = 0;

    async function colour(
        container: HTMLElement,
        dark: boolean,
        staleOnly = false,
    ) {
        if (!staleOnly) reveal(container);
        // A block coloured for the other theme (the theme changed, or the app was still settling) is coloured again.
        // `staleOnly` leaves the blocks never coloured yet alone (a streaming reply's new code waits for its end).
        const run = staleOnly ? colourRun : ++colourRun;
        const mine = dark ? 'dark' : 'light';
        const selector = staleOnly
            ? `.md-code[data-coloured]:not([data-coloured="${mine}"])`
            : `.md-code:not([data-coloured="${mine}"])`;
        const blocks = [...container.querySelectorAll<HTMLElement>(selector)];
        if (blocks.length === 0) return;
        colourStarted();
        try {
            await colourBlocks(container, dark, blocks, run);
        } finally {
            colourFinished();
        }
    }

    async function colourBlocks(
        container: HTMLElement,
        dark: boolean,
        blocks: HTMLElement[],
        run: number,
    ) {
        const mine = dark ? 'dark' : 'light';
        for (const block of blocks) {
            if (run !== colourRun) return;
            const code = block.querySelector('code');
            const pre = block.querySelector('pre');
            if (!code || !pre) continue;
            block.dataset.coloured = mine;
            const source = code.textContent ?? '';
            if (source.length > COLOUR_MAX_CHARS) continue;
            const language = block.dataset.lang || 'text';
            const key = `${dark ? 'd' : 'l'}|${language}|${source}`;
            const hit = coloured.get(key);
            if (hit !== undefined) {
                code.innerHTML = hit;
                continue;
            }
            try {
                // shiki works in its own thread (highlight.ts): the page only puts the colours in.
                const inner = await highlightHtml(source, language, dark);
                if (inner === null) continue;
                coloured.set(key, inner);
                if (coloured.size > COLOURED_MAX)
                    coloured.delete(coloured.keys().next().value as string);
                if (run === colourRun && container.contains(block))
                    code.innerHTML = inner;
            } catch {
                // An unknown language stays plain.
            }
        }
    }

    $effect(() => {
        void html;
        const dark = theme.dark;
        if (!root) return;
        const container = root;
        // A reply still streaming (or revealing) gets its colours at the end. Code already coloured for the other theme is
        // redone now, so a theme switch during a run does not leave the old theme's token colours on the new background.
        if (streaming || catching) {
            untrack(() => void colour(container, dark, true));
            return;
        }
        // Right away, not when the page is idle: a chat is kept hidden until it sits at its end, and colouring in that
        // window means code never shows plain first and then changes colour in front of the reader (a visible blink).
        // Colours already worked out come from the cache synchronously; shiki itself is loaded ahead (see above).
        if (eagerColour()) {
            untrack(() => void colour(container, dark));
            return;
        }
        const run = () => void colour(container, dark);
        if (typeof requestIdleCallback === 'function') {
            const id = requestIdleCallback(run, { timeout: 800 });
            return () => cancelIdleCallback(id);
        }
        const id = setTimeout(run, 50);
        return () => clearTimeout(id);
    });

    const NOT_FOUND = 'Không tìm thấy';

    function mark(link: HTMLAnchorElement, result: Found | undefined) {
        link.classList.toggle('md-path-ok', Boolean(result?.exists));
        link.classList.toggle(
            'md-path-missing',
            result !== undefined && !result.exists,
        );
        // A folder gets a folder icon, and a click opens it in the file manager.
        link.classList.toggle(
            'md-path-dir',
            Boolean(result?.exists && result.dir),
        );
        if (result && !result.exists) link.title = NOT_FOUND;
        else if (link.title === NOT_FOUND) link.removeAttribute('title');
    }

    /** Marks the links to files: one that exists is bold, one that does not is faded with a tooltip (no error). A path
     *  found in plain text comes with several guesses of where it ends (a name with spaces): the longest that exists wins,
     *  and the words after it go back to plain text. */
    async function checkPaths(container: HTMLElement) {
        const links = [
            ...container.querySelectorAll<HTMLAnchorElement>('a[data-file]'),
        ].filter((link) => link.dataset.checked !== '1');
        if (!links.length) return;
        const projectRoot =
            workspace.projects.find(
                (project) => project.id === activeSession()?.projectId,
            )?.path ?? '';
        const guessesOf = (
            link: HTMLAnchorElement,
        ): [string, number, string][] => {
            try {
                const parsed = link.dataset.cands
                    ? (JSON.parse(link.dataset.cands) as [
                          string,
                          number,
                          string,
                      ][])
                    : [];
                if (parsed.length)
                    return parsed.map(([path, length, line]) => [
                        resolveInProject(path, projectRoot),
                        length,
                        line,
                    ]);
            } catch {
                // Falls to the single path below.
            }
            const file = filePathOf(link.dataset.file ?? '', projectRoot);
            return file ? [[file, 0, '']] : [];
        };
        const now = Date.now();
        const asked = new SvelteSet<string>();
        for (const link of links) {
            for (const [path] of guessesOf(link)) {
                const known = found.get(path);
                if (
                    !known ||
                    (!known.exists && now - known.at > CHECK_AGAIN_MS)
                )
                    asked.add(path);
            }
        }
        if (asked.size && inTauri()) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const list = [...asked];
                const results = await invoke<
                    { exists: boolean; dir: boolean; path: string }[]
                >('path_resolve', { paths: list });
                results.forEach((result, index) =>
                    found.set(list[index], { ...result, at: Date.now() }),
                );
                while (found.size > FOUND_MAX)
                    found.delete(found.keys().next().value as string);
            } catch {
                return;
            }
        }
        for (const link of links) {
            if (!container.contains(link)) continue;
            const guesses = guessesOf(link);
            const hit = guesses.find(([path]) => found.get(path)?.exists);
            const pick = hit ?? guesses[guesses.length - 1];
            if (!pick) continue;
            const result = found.get(pick[0]);
            if (link.dataset.cands) {
                const rest = link.nextElementSibling;
                // The label is the file's own name (with the line it points at), never the path.
                const fullPath = result?.exists ? result.path : pick[0];
                link.textContent = `${displayPath(projectRoot, fullPath)}${pick[2]}`;
                link.dataset.file = `${fullPath}${pick[2]}`;
                link.title = fullPath;
                if (rest?.classList.contains('md-path-rest'))
                    rest.textContent = (link.dataset.raw ?? '').slice(pick[1]);
            } else if (result?.exists) {
                const raw = link.dataset.file ?? '';
                const resolved = filePathOf(raw, projectRoot);
                if (!isAbsolutePath(raw)) link.dataset.file = result.path;
                if (resolved && link.textContent?.trim() === raw)
                    link.textContent = displayPath(projectRoot, result.path);
            }
            mark(link, result);
            // A path that is not there yet stays open to a later look (the agent may be about to write it).
            if (result?.exists) link.dataset.checked = '1';
        }
    }

    /** A picture from the web (`data-remote`): fetched by the app, shown from its copy; when it cannot be had, a
     *  placeholder with a button that opens the address in the Preview. */
    async function loadPictures(container: HTMLElement) {
        const images = [
            ...container.querySelectorAll<HTMLImageElement>(
                'img[data-remote]:not([data-loading])',
            ),
        ];
        for (const image of images) {
            const url = image.dataset.remote ?? '';
            image.dataset.loading = '1';
            let data = pictures.get(url);
            if (data === undefined) {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    data = await invoke<string>('image_fetch', { url });
                } catch {
                    data = null;
                }
                rememberPicture(url, data);
            }
            if (!container.contains(image)) continue;
            if (data) {
                image.src = data;
                image.removeAttribute('data-remote');
                continue;
            }
            const holder = document.createElement('span');
            holder.className = 'md-image-missing';
            const label = document.createElement('span');
            label.textContent = image.alt || 'Picture not loaded';
            const open = document.createElement('a');
            open.href = url;
            open.textContent = 'Open in Preview';
            open.dataset.previewImage = '1';
            holder.append(label, open);
            image.replaceWith(holder);
        }
    }

    function installImageFallbacks(container: HTMLElement) {
        for (const image of container.querySelectorAll<HTMLImageElement>(
            'img:not([data-fallback-installed])',
        )) {
            image.dataset.fallbackInstalled = '1';
            image.addEventListener('error', () => {
                if (image.dataset.fallback) return;
                image.dataset.fallback = '1';
                image.alt = 'Image not found';
                image.src = IMAGE_NOT_FOUND_SRC;
            });
        }
    }

    // After each render (and whenever the text settles): mark the file links and fetch the pictures. Blocks that were
    // already marked are skipped (`data-checked`), so only the block being written is looked at again.
    $effect(() => {
        void html;
        const container = root;
        if (!container) return;
        installImageFallbacks(container);
        if (!inTauri()) return;
        const id = setTimeout(
            () => {
                void checkPaths(container);
                void loadPictures(container);
            },
            streaming || catching ? 400 : 0,
        );
        return () => clearTimeout(id);
    });

    // Tables: column widths by formula (re-worked when the card's width changes), and drag a header edge to resize.
    $effect(() => {
        void html;
        const container = root;
        if (!container || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries)
                if (entry.target.isConnected)
                    layoutTable(entry.target as HTMLElement);
        });
        for (const card of container.querySelectorAll('.md-table'))
            observer.observe(card);
        return () => observer.disconnect();
    });

    function gripHover(event: PointerEvent) {
        if (event.buttons) return;
        for (const th of root?.querySelectorAll<HTMLElement>('th[data-grip]') ??
            [])
            th.removeAttribute('data-grip');
        const th = gripAt(event);
        if (th) th.setAttribute('data-grip', '');
    }

    function gripDown(event: PointerEvent) {
        if (event.button !== 0) return;
        const th = gripAt(event);
        if (th) startResize(th, event);
    }

    const linkOf = (event: Event) =>
        (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');

    // Running a command opens the terminal, but clicking its button must not steal focus from a prompt being written.
    function onmousedown(event: MouseEvent) {
        const run = (event.target as HTMLElement).closest<HTMLButtonElement>(
            '[data-run]',
        );
        if (
            run &&
            document.activeElement instanceof HTMLElement &&
            document.activeElement.matches('[data-composer-editor]')
        )
            event.preventDefault();
    }

    /** A link the agent wrote to a file: `E:/repo/a.txt`, `/home/me/a.txt`, `file:///…`, or `src/a.ts:42` inside the
     *  project. Answers the file's absolute path, or null for a web address. */
    function filePathOf(href: string, projectRoot: string): string | null {
        const source = /^file:\/\//i.test(href)
            ? href.replace(/#.*$/, '')
            : href;
        const raw = normalizePath(source);
        // `path:12` or `path:12:3` points at a line; the viewer opens the file.
        const path = raw
            .replace(/^\/([a-z]:[\\/])/i, '$1')
            .replace(/:\d+(:\d+)?$/, '');
        if (isAbsolutePath(path) || /^~[\\/]/.test(path)) return path;
        if (
            projectRoot &&
            path &&
            !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
            !path.startsWith('#')
        )
            return resolveInProject(path, projectRoot);
        return null;
    }

    // The viewer reads only inside a root folder: the project when the file is in it, else the file's own folder.
    function openFile(path: string, projectRoot: string) {
        openInViewer(path, fileRootOf(path, projectRoot));
    }

    // Right click on a link: open it in the AgentDeck browser, the system browser, or copy it.
    function oncontextmenu(event: MouseEvent) {
        const link = linkOf(event);
        if (!link || !inTauri()) return;
        event.preventDefault();
        const projectRoot =
            workspace.projects.find(
                (project) => project.id === activeSession()?.projectId,
            )?.path ?? '';
        const file = filePathOf(
            link.dataset.file ?? link.getAttribute('href') ?? '',
            projectRoot,
        );
        Object.assign(linkMenu, {
            open: true,
            url: link.href,
            x: event.clientX,
            y: event.clientY,
            file: file ?? '',
            root: file ? fileRootOf(file, projectRoot) : '',
            dir: link.classList.contains('md-path-dir'),
        });
    }

    const copiedTimers = new WeakMap<
        HTMLElement,
        ReturnType<typeof setTimeout>
    >();

    function onclick(event: MouseEvent) {
        // A link to a local dev server opens in the AgentDeck browser; any other address in the system browser.
        const link = linkOf(event);
        if (link && inTauri()) {
            event.preventDefault();
            if (link.classList.contains('md-path-dir') && link.dataset.file) {
                void import('@tauri-apps/api/core').then(({ invoke }) =>
                    invoke('path_open', { path: link.dataset.file }),
                );
                return;
            }
            if (link.dataset.previewImage) {
                openInPreview(link.href);
                return;
            }
            if (
                link.dataset.file === undefined &&
                link.getAttribute('href') === '#'
            )
                return;
            // A file the agent linked to opens in a tab of its own, like a file picked in Explore.
            const projectRoot =
                workspace.projects.find(
                    (project) => project.id === activeSession()?.projectId,
                )?.path ?? '';
            const file = filePathOf(
                link.dataset.file ?? link.getAttribute('href') ?? '',
                projectRoot,
            );
            if (file) openFile(file, projectRoot);
            else if (isLocalUrl(link.href)) openInPreview(link.href);
            else void openExternal(link.href);
            return;
        }
        const run = (event.target as HTMLElement).closest<HTMLButtonElement>(
            '[data-run]',
        );
        if (run) {
            const command = run
                .closest('.md-code')
                ?.querySelector('code')?.textContent;
            // Run in the folder of the chat's project, not wherever that shell happens to be (often the home folder).
            const folder =
                workspace.projects.find(
                    (project) => project.id === activeSession()?.projectId,
                )?.path ?? '';
            if (command?.trim())
                runInTerminal(terminalCommand(command, folder));
            return;
        }
        const preview = (
            event.target as HTMLElement
        ).closest<HTMLButtonElement>('[data-preview-table]');
        if (preview) {
            // The table as Markdown, in the lightbox (wide, with its own scroll).
            const lines = [
                ...(preview.closest('.md-table')?.querySelectorAll('tr') ?? []),
            ].map(
                (row) =>
                    `| ${[...row.children].map((cell) => (cell.textContent ?? '').trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`,
            );
            if (lines.length > 1)
                lines.splice(
                    1,
                    0,
                    `|${lines[0]
                        .split('|')
                        .slice(1, -1)
                        .map(() => ' --- ')
                        .join('|')}|`,
                );
            openTablePreview(lines.join('\n'));
            return;
        }
        const table = (event.target as HTMLElement).closest<HTMLButtonElement>(
            '[data-copy-table]',
        );
        if (table) {
            // Tab-separated rows: a paste into a spreadsheet or a document keeps the columns.
            const rows = [
                ...(table.closest('.md-table')?.querySelectorAll('tr') ?? []),
            ].map((row) =>
                [...row.children]
                    .map((cell) => (cell.textContent ?? '').trim())
                    .join('\t'),
            );
            void navigator.clipboard.writeText(rows.join('\n')).then(() => {
                table.setAttribute('data-copied', '');
                clearTimeout(copiedTimers.get(table));
                copiedTimers.set(
                    table,
                    setTimeout(
                        () => table.removeAttribute('data-copied'),
                        1800,
                    ),
                );
            });
            return;
        }
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
            '[data-copy]',
        );
        const code = button?.closest('.md-code')?.querySelector('code');
        if (!button || !code) return;
        void navigator.clipboard.writeText(code.textContent ?? '').then(() => {
            button.setAttribute('data-copied', '');
            clearTimeout(copiedTimers.get(button));
            copiedTimers.set(
                button,
                setTimeout(() => button.removeAttribute('data-copied'), 1800),
            );
        });
    }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- every block is sanitised by DOMPurify in renderMarkdown (app/text/markdown.ts) -->
<!-- eslint-disable svelte/no-unused-svelte-ignore -->
<!-- svelte-ignore a11y_click_events_have_key_events,a11y_no_static_element_interactions,a11y_no_noninteractive_element_interactions -->
<div
    bind:this={root}
    class="md"
    {onclick}
    {oncontextmenu}
    {onmousedown}
    onpointermove={gripHover}
    onpointerdown={gripDown}
>
    {#each html as block, index (index)}<div class="md-block">
            {@html block}
        </div>{/each}
</div>

<!-- eslint-enable svelte/no-at-html-tags -->

<style>
    /* A word that has just arrived fades in, quickly and without blur, as in Claude Code: fast text never smears. */
    .md :global(.md-fade) {
        animation: md-appear 220ms ease-out both;
    }
    @keyframes md-appear {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
</style>
