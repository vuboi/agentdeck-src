import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

const [, , mode, encoded] = process.argv;

function emit(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
        const secret = process.env[key];
        if (secret) message = message.replaceAll(secret, '[redacted]');
    }
    return message.slice(0, 4_000);
}

function options(config) {
    const result = {
        cwd: config.cwd,
        model: config.model,
        effort: config.effort,
        permissionMode: config.permissionMode,
        allowedTools: config.allowedTools,
        disallowedTools: config.disallowedTools,
        includePartialMessages: true,
        systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: config.systemPrompt,
        },
        tools: { type: 'preset', preset: 'claude_code' },
        mcpServers: config.mcpServers,
        allowDangerouslySkipPermissions:
            config.permissionMode === 'bypassPermissions',
        pathToClaudeCodeExecutable:
            process.env.AGENTDECK_CLAUDE_CODE_BINARY || undefined,
    };

    if (config.sessionId) result.sessionId = config.sessionId;
    if (config.resume) result.resume = config.resume;
    return result;
}

async function reportError(error, config) {
    emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: `Claude Agent SDK failed: ${errorMessage(error)}`,
        session_id: config.resume || config.sessionId,
    });
    process.exitCode = 1;
}

async function runOnce(config) {
    let prompt = '';
    for await (const chunk of process.stdin) prompt += chunk.toString('utf8');
    const session = query({ prompt, options: options(config) });
    try {
        for await (const message of session) emit(message);
    } catch (error) {
        await reportError(error, config);
    } finally {
        session.close();
    }
}

/**
 * A side question (`/btw`): the CLI answers a `side_question` control request written to its stdin. The SDK owns that
 * stdin, so the warm runner keeps the CLI process it spawns and writes the request there itself. The answer comes back
 * on the CLI's stdout (tapped here without taking it from the SDK) and is passed on as a `side_question_result` line.
 */
function sideQuestions() {
    const pending = new Map();
    let cli;
    return {
        adopt(child) {
            cli = child;
            let buffer = '';
            child.stdout.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let cut;
                while ((cut = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, cut);
                    buffer = buffer.slice(cut + 1);
                    if (!line.includes('"control_response"')) continue;
                    let message;
                    try {
                        message = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    const requestId =
                        message.response?.request_id ?? message.request_id;
                    if (!pending.has(requestId)) continue;
                    pending.delete(requestId);
                    emit({
                        type: 'side_question_result',
                        request_id: requestId,
                        response: message.response ?? null,
                        error: message.error ?? null,
                    });
                }
            });
            child.on('exit', () => {
                for (const requestId of pending.keys())
                    emit({
                        type: 'side_question_result',
                        request_id: requestId,
                        response: null,
                        error: {
                            message:
                                'the chat ended before the side question was answered',
                        },
                    });
                pending.clear();
            });
        },
        ask({ request_id: requestId, ...request }) {
            if (!cli || !cli.stdin.writable) {
                emit({
                    type: 'side_question_result',
                    request_id: requestId,
                    response: null,
                    error: {
                        message: 'no running Claude process for this chat',
                    },
                });
                return;
            }
            pending.set(requestId, true);
            cli.stdin.write(
                `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`,
            );
        },
    };
}

async function runWarm(config) {
    let controller;
    const prompt = new ReadableStream({
        start(value) {
            controller = value;
        },
    });
    const side = sideQuestions();
    const session = query({
        prompt,
        options: {
            ...options(config),
            spawnClaudeCodeProcess: (spawnOptions) => {
                const child = spawn(spawnOptions.command, spawnOptions.args, {
                    cwd: spawnOptions.cwd,
                    env: spawnOptions.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    signal: spawnOptions.signal,
                });
                side.adopt(child);
                return child;
            },
        },
    });
    const input = createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
    });
    const output = (async () => {
        try {
            for await (const message of session) emit(message);
        } catch (error) {
            await reportError(error, config);
        }
    })();

    input.on('line', (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            message = {
                type: 'user',
                message: { role: 'user', content: line },
            };
        }

        if (message.type === 'control_request') {
            const requestId = message.request_id;
            const request = message.request ?? {};
            if (request.subtype === 'interrupt') {
                void session.interrupt().catch(() => {});
            } else if (request.subtype === 'side_question') {
                side.ask({ ...request, request_id: requestId });
            } else if (request.subtype === 'set_model') {
                void session.setModel(request.model).then(
                    () =>
                        emit({
                            type: 'control_response',
                            request_id: requestId,
                            response: {},
                        }),
                    (error) =>
                        emit({
                            type: 'control_response',
                            request_id: requestId,
                            error: { message: errorMessage(error) },
                        }),
                );
            }
            return;
        }

        if (message.type === 'user' && message.message) {
            if (!message.uuid) message.uuid = crypto.randomUUID();
            if (message.parent_tool_use_id === undefined)
                message.parent_tool_use_id = null;
            controller.enqueue(message);
        }
    });

    input.on('close', () => controller.close());
    await output;
}

try {
    const config = JSON.parse(
        Buffer.from(encoded ?? '', 'base64').toString('utf8'),
    );
    if (mode === '--once') await runOnce(config);
    else if (mode === '--warm') await runWarm(config);
    else throw new Error('Unknown Claude SDK runner mode');
} catch (error) {
    await reportError(error, {});
}
