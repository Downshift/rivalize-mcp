/**
 * The package version, in one place. The MCP handshake (`serverInfo.version`)
 * and the HTTP User-Agent both read it, and package-manifest.test.ts pins it to
 * package.json so a bump cannot leave one of them behind.
 */
export const VERSION = '0.3.2';
