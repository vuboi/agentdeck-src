export type McpConnectorPreset = {
    id: string;
    name: string;
    description: string;
    transport: 'stdio' | 'http';
    target: string;
    args: string[];
    auth: 'none' | 'env' | 'oauth2';
    requiredScopes: string[];
    oauthClientSpec: 'available' | 'missing';
    setupUrl?: string;
};

/** Safe catalog entries until a vendor-approved OAuth client specification is available. */
export const MCP_CONNECTOR_PRESETS: readonly McpConnectorPreset[] = [
    {
        id: 'google-sheets',
        name: 'Google Sheets',
        description: 'MCP connector blueprint for spreadsheet access.',
        transport: 'stdio',
        target: 'npx',
        args: [],
        auth: 'oauth2',
        requiredScopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.readonly',
        ],
        oauthClientSpec: 'missing',
        setupUrl: 'https://console.cloud.google.com/apis/credentials',
    },
];

export function mcpConnectorPreset(id: string): McpConnectorPreset | undefined {
    return MCP_CONNECTOR_PRESETS.find((preset) => preset.id === id);
}
