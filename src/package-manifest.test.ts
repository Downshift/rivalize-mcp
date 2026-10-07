/**
 * The published manifest must keep its bin.
 *
 * npm 11.6's `publish` normalises package.json and REMOVES a bin whose path
 * starts with "./" ("script name dist/index.js was invalid and removed"), while
 * `npm pack` keeps it. Published that way, `npx @rivalize/mcp` has no executable
 * for any user — and pack-based checks stay green. Pin the form publish keeps.
 *
 * The package also carries the registry and directory metadata a public
 * package needs: `mcpName` (the official MCP Registry's npm ownership check),
 * author, bugs, and a repository that is this repo's root.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from './version.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  mcpName?: string;
  author?: string;
  license?: string;
  homepage?: string;
  bugs?: { url?: string; email?: string };
  repository?: { type?: string; url?: string; directory?: string };
  bin: Record<string, string>;
  main: string;
  files: string[];
  publishConfig?: { access?: string };
  engines?: { node?: string };
};

describe('published manifest', () => {
  it('declares exactly one bin, rivalize-mcp, at a path npm publish keeps', () => {
    expect(Object.keys(pkg.bin)).toEqual(['rivalize-mcp']);
    const target = pkg.bin['rivalize-mcp'];
    expect(target).toBe('dist/index.js');
    expect(target.startsWith('./')).toBe(false);
  });

  it('ships only dist, publicly, with main and bin inside it', () => {
    expect(pkg.files).toEqual(['dist']);
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.main.startsWith('dist/')).toBe(true);
  });
});

describe('package identity', () => {
  it('is named @rivalize/mcp', () => {
    expect(pkg.name).toBe('@rivalize/mcp');
  });

  it('is version 0.3.1, and the VERSION constant (handshake + User-Agent) agrees', () => {
    expect(pkg.version).toBe('0.3.1');
    expect(VERSION).toBe(pkg.version);
  });

  it('carries the MCP Registry name in the ai.rivalize namespace', () => {
    expect(pkg.mcpName).toBe('ai.rivalize/rivalize-mcp');
  });

  it('names an author, a bug tracker and a support address', () => {
    expect(pkg.author).toMatch(/^Rivalize <support@rivalize\.ai>/);
    expect(pkg.bugs).toEqual({
      url: 'https://github.com/Downshift/rivalize-mcp/issues',
      email: 'support@rivalize.ai',
    });
  });

  it('points repository at the public repo root (no subdirectory) and homepage at the docs', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/Downshift/rivalize-mcp.git',
    });
    expect(pkg.homepage).toBe('https://rivalize.ai/developers');
  });

  it('is MIT and requires Node 22', () => {
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines?.node).toBe('>=22.0.0');
  });

  it('the README says what "Connection closed" means and how to fix each cause', () => {
    const readme = readFileSync(path.join(PKG_DIR, 'README.md'), 'utf8');
    const start = readme.indexOf('## Troubleshooting');
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
    expect(section).toContain('Connection closed');
    // The three causes, each with its fix.
    expect(section).toContain('RIVALIZE_API_KEY');
    expect(section).toContain('rk_live_');
    expect(section).toMatch(/Node\.js 22/);
    expect(section).toContain('node --version');
    expect(section).toMatch(/network|proxy/i);
    expect(section).toContain('HTTPS_PROXY');
    // How to see the server's own message.
    expect(section).toContain('stderr');
    expect(section).toContain('npx -y @rivalize/mcp');
  });

  it('ships a LICENSE whose text is MIT', () => {
    const text = readFileSync(path.join(PKG_DIR, 'LICENSE'), 'utf8');
    expect(text).toMatch(/^MIT License/);
    expect(text).toContain('Permission is hereby granted, free of charge');
  });
});
