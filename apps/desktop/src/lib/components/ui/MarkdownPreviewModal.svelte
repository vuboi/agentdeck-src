<script lang="ts">
    import { ZButton, ZIcon, ZModal } from '@shival99/z-ui-svelte';
    import type { ZIconName } from '@shival99/z-ui-svelte';
    import Markdown from './Markdown.svelte';
    import { inTauri } from '../../app/platform/history';
    import { toast } from '../../app/platform/toast';
    import {
        activeSession,
        draftFiles,
        drafts,
    } from '../../chat/sessions.svelte';
    import { saveFileAttachment } from '../../chat/agent';

    // A markdown document in a modal, as the activity log shows an entry: read, add to the chat, attach, copy, download.
    // `text` is the whole document; a leading front matter block is hidden in the preview only.
    let {
        open = $bindable(false),
        title,
        text,
        name,
        note,
    }: {
        open?: boolean;
        title: string;
        text: string;
        /** File name without extension, for attach and download. */
        name: string;
        /** What the attached file is called in the chat's draft. */
        note: string;
    } = $props();

    const shown = $derived(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''));
    const fileName = $derived(
        `${
            name
                .trim()
                .replace(/[^\p{L}\p{N}_-]+/gu, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 60) || 'document'
        }.md`,
    );

    function copy() {
        void navigator.clipboard
            .writeText(text)
            .then(() => toast.success('Copied'))
            .catch(() => toast.error('Could not access the clipboard'));
    }

    function addToChat() {
        const session = activeSession();
        if (!session) return toast.error('Open a chat first');
        const fence = '`'.repeat(
            Math.max(
                3,
                ...(text.match(/`+/g) ?? []).map((run) => run.length + 1),
            ),
        );
        drafts[session.id] = [
            drafts[session.id]?.trimEnd(),
            `${title}\n${fence}markdown\n${text}\n${fence}`,
        ]
            .filter(Boolean)
            .join('\n\n');
        toast.success('Added to chat');
        open = false;
    }

    async function attach() {
        const session = activeSession();
        if (!session) return toast.error('Open a chat first');
        if (!inTauri()) return toast.error('Attaching needs the desktop app');
        try {
            const bytes = new TextEncoder().encode(text);
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const path = await saveFileAttachment(fileName, btoa(binary));
            draftFiles[session.id] = [
                ...(draftFiles[session.id] ?? []),
                {
                    id: crypto.randomUUID(),
                    name: fileName,
                    path,
                    size: bytes.length,
                    note,
                },
            ];
            toast.success('Attached to chat');
        } catch (error) {
            toast.error(`Could not attach file: ${String(error)}`);
        }
    }

    async function download() {
        try {
            if (inTauri()) {
                const { invoke } = await import('@tauri-apps/api/core');
                const path = await invoke<string | null>(
                    'project_activity_save',
                    { name: fileName, text },
                );
                if (path) toast.success(`Saved to ${path}`);
                open = false;
                return;
            }
            const url = URL.createObjectURL(
                new Blob([text], { type: 'text/markdown;charset=utf-8' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.click();
            URL.revokeObjectURL(url);
            open = false;
        } catch (error) {
            toast.error(`Could not save file: ${String(error)}`);
        }
    }

    const BUTTON = 'h-8 gap-1.5 px-3 text-sm max-sm:px-2';
</script>

<ZModal
    bind:open
    zTitle={title}
    zWidth="min(900px, calc(100vw - 24px))"
    zBodyClass="min-h-0! py-3"
    onCancel={() => (open = false)}
    ><Markdown text={shown} />{#snippet footer()}<div
            class="flex items-center justify-end gap-2"
        >
            <ZButton
                zWave={false}
                zType="outline"
                zSize="sm"
                class={BUTTON}
                aria-label="Add to chat"
                title="Add to chat"
                onclick={addToChat}
                ><ZIcon
                    zType={'lucidePlus' as ZIconName}
                    class="size-3.5"
                /><span class="max-sm:hidden">Add to chat</span></ZButton
            ><ZButton
                zWave={false}
                zType="outline"
                zSize="sm"
                class={BUTTON}
                aria-label="Attach file"
                title="Attach file"
                onclick={() => void attach()}
                ><ZIcon
                    zType={'lucidePaperclip' as ZIconName}
                    class="size-3.5"
                /><span class="max-sm:hidden">Attach file</span></ZButton
            ><ZButton
                zWave={false}
                zType="outline"
                zSize="sm"
                class={BUTTON}
                aria-label="Copy"
                title="Copy"
                onclick={copy}
                ><ZIcon
                    zType={'lucideCopy' as ZIconName}
                    class="size-3.5"
                /><span class="max-sm:hidden">Copy</span></ZButton
            ><ZButton
                zWave={false}
                zType="outline"
                zSize="sm"
                class={BUTTON}
                aria-label="Download"
                title="Download"
                onclick={() => void download()}
                ><ZIcon
                    zType={'lucideDownload' as ZIconName}
                    class="size-3.5"
                /><span class="max-sm:hidden">Download</span></ZButton
            ><ZButton
                zWave={false}
                zSize="sm"
                class={BUTTON}
                aria-label="Close"
                title="Close"
                onclick={() => (open = false)}
                ><ZIcon
                    zType={'lucideX' as ZIconName}
                    class="size-3.5 sm:hidden"
                /><span class="max-sm:hidden">Close</span></ZButton
            >
        </div>{/snippet}</ZModal
>
