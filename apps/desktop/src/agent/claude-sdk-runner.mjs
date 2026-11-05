import { createInterface } from 'node:readline';
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
        promptSuggestions: config.promptSuggestions === true,
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

async function runWarm(config) {
    let controller;
    const prompt = new ReadableStream({
        start(value) {
            controller = value;
        },
    });
    const session = query({ prompt, options: options(config) });
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
