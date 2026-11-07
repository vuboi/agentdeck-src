import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_CONNECTOR_PRESETS, mcpConnectorPreset } from './mcp-connectors.ts';

test('Google Sheets blueprint records OAuth requirements without credentials', () => {
    const preset = mcpConnectorPreset('google-sheets');
    assert.ok(preset);
    assert.equal(preset.auth, 'oauth2');
    assert.equal(preset.oauthClientSpec, 'missing');
    assert.ok(
        preset.requiredScopes.includes(
            'https://www.googleapis.com/auth/spreadsheets',
        ),
    );
    assert.equal(MCP_CONNECTOR_PRESETS.length, 1);
});

test('unknown connector blueprint is absent', () => {
    assert.equal(mcpConnectorPreset('unknown'), undefined);
});
