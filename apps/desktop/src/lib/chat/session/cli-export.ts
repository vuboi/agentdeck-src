// "Continue in CLI": sends a chat's turns to the Rust writer, which creates a NEW Claude Code or Codex session and returns
// the command that resumes it. Runs only when the user picks the menu entry. Native files that exist are never changed.
// Tool calls and file edits go across as text summaries (see export.rs), never as replayable tool records.

import { invoke } from '@tauri-apps/api/core';
import type { Block, Message } from '../mock';

export type CliTarget = 'claude' | 'codex';

/** What the writer created: the new session id, its file, and the command that resumes it. */
export type CliExport = {
    nativeId: string;
    path: string;
    resumeCommand: string;
};

/** The parts of a turn the writer keeps. Thinking, delegation, images and the like are not written. */
type ExportBlock =
    | { kind: 'response'; text: string }
    | {
          kind: 'command';
          command: string;
          status: string;
          output: string;
          change?: { path: string; added: number; removed: number };
      };

export type ExportTurn = {
    role: 'user' | 'assistant';
    time: string;
    blocks: ExportBlock[];
};

function exportBlock(block: Block): ExportBlock | null {
    if (block.kind === 'response')
        return { kind: 'response', text: block.text };
    if (block.kind === 'command') {
        const { change } = block;
        return {
            kind: 'command',
            command: block.command,
            status: block.status,
            output: block.output,
            change: change && {
                path: change.path,
                added: change.added,
                removed: change.removed,
            },
        };
    }
    return null;
}

/** The chat's user and assistant turns, in order, with only the parts the writer keeps. */
export function exportTurns(messages: Message[]): ExportTurn[] {
    return messages
        .filter(
            (message) =>
                message.role === 'user' || message.role === 'assistant',
        )
        .map((message) => ({
            role: message.role as 'user' | 'assistant',
            time: message.at ?? '',
            blocks: message.blocks
                .map(exportBlock)
                .filter((block): block is ExportBlock => block !== null),
        }));
}

/** Writes the chat as a new native session of `target`. `cwd` is the folder the session resumes in. */
export function continueInCli(args: {
    chatId: string;
    target: CliTarget;
    title: string;
    cwd: string;
    messages: Message[];
}): Promise<CliExport> {
    return invoke<CliExport>('export_chat', {
        chatId: args.chatId,
        target: args.target,
        chat: {
            title: args.title,
            cwd: args.cwd,
            turns: exportTurns(args.messages),
        },
    });
}
