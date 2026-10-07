/**
 * `server.json` is what the official MCP Registry (and the directories
 * that mirror it) list. It must validate against the OFFICIAL schema, and it
 * must describe the package npm actually ships.
 *
 * The schema is vendored in `schema/server.schema.json` (source URL, fetch date
 * and hash in `schema/README.md`), so this runs offline. Each validation check
 * is paired with a known-bad control: a validator that accepts everything would
 * fail the controls, so a green here is not a vacuous one.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(PKG_DIR, rel), 'utf8');

const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
/** SHA-256 of the schema as served (LF). A checkout with CRLF is normalised first. */
const SCHEMA_SHA256 = '3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0';

const schemaText = read('schema/server.schema.json');
const schema = JSON.parse(schemaText) as {
  $id: string;
  definitions: Record<string, { properties?: Record<string, unknown> }>;
};

interface EnvVar {
  name: string;
  isRequired?: boolean;
  isSecret?: boolean;
  [k: string]: unknown;
}
interface ServerJson {
  $schema: string;
  name: string;
  description: string;
  version: string;
  repository: { url: string; source: string };
  packages: Array<{
    registryType: string;
    registryBaseUrl?: string;
    identifier: string;
    version: string;
    transport: { type: string };
    environmentVariables: EnvVar[];
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

const server = JSON.parse(read('server.json')) as ServerJson;
const pkg = JSON.parse(read('package.json')) as {
  name: string;
  version: string;
  mcpName: string;
  repository: { url: string };
};

function validator() {
  // strict: false — the schema carries `example`, an annotation draft-07 does
  // not define and Ajv's strict mode rejects. Formats ARE enforced (uri).
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

const validate = validator();
const clone = (): ServerJson => JSON.parse(JSON.stringify(server)) as ServerJson;

describe('the vendored schema is the official one, unmodified', () => {
  it('has the official $id, and server.json points at it', () => {
    expect(schema.$id).toBe(SCHEMA_URL);
    expect(server.$schema).toBe(SCHEMA_URL);
  });

  it('matches the recorded SHA-256 (schema/README.md)', () => {
    const lf = schemaText.replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(lf, 'utf8').digest('hex')).toBe(SCHEMA_SHA256);
  });
});

describe('server.json validates against the official schema', () => {
  it('is valid', () => {
    const ok = validate(server);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  // Controls: the same validator must reject each of these, or "valid" above means nothing.
  it.each([
    [
      'a description over 100 characters',
      (s: ServerJson) => {
        s.description = 'x'.repeat(101);
      },
    ],
    [
      'a name without the namespace slash',
      (s: ServerJson) => {
        s.name = 'rivalize-mcp';
      },
    ],
    [
      'a package with no transport',
      (s: ServerJson) => {
        delete (s.packages[0] as Record<string, unknown>).transport;
      },
    ],
    [
      'a package version of "latest"',
      (s: ServerJson) => {
        s.packages[0].version = 'latest';
      },
    ],
    [
      'a repository url that is not a URI',
      (s: ServerJson) => {
        s.repository.url = 'not a url';
      },
    ],
    [
      'an environment variable with no name',
      (s: ServerJson) => {
        delete (s.packages[0].environmentVariables[0] as Record<string, unknown>).name;
      },
    ],
  ])('control: rejects %s', (_label, mutate) => {
    const bad = clone();
    mutate(bad);
    expect(validate(bad)).toBe(false);
  });

  it('uses no key the schema does not define (additionalProperties is open, so a typo would pass)', () => {
    const known = (def: string) => Object.keys(schema.definitions[def].properties ?? {});
    const serverKeys = known('ServerDetail');
    const packageKeys = known('Package');
    const inputKeys = [...known('Input'), 'name', 'variables'];
    expect(Object.keys(server).filter((k) => !serverKeys.includes(k))).toEqual([]);
    for (const p of server.packages) {
      expect(Object.keys(p).filter((k) => !packageKeys.includes(k))).toEqual([]);
      for (const v of p.environmentVariables) {
        expect(Object.keys(v).filter((k) => !inputKeys.includes(k))).toEqual([]);
      }
    }
  });
});

describe('server.json describes the package npm ships', () => {
  const npm = server.packages.find((p) => p.registryType === 'npm');

  it('has exactly one npm package, from the public npm registry, over stdio', () => {
    expect(server.packages.map((p) => p.registryType)).toEqual(['npm']);
    expect(npm).toBeDefined();
    const p = npm as NonNullable<typeof npm>;
    expect(p.registryBaseUrl).toBe('https://registry.npmjs.org');
    expect(p.transport).toEqual({ type: 'stdio' });
  });

  it("name equals package.json mcpName (the registry's npm ownership check)", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toBe('ai.rivalize/rivalize-mcp');
  });

  it('identifier and both versions equal package.json name and version', () => {
    const p = npm as NonNullable<typeof npm>;
    expect(p.identifier).toBe(pkg.name);
    expect(p.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
  });

  it('repository is the package.json repository', () => {
    expect(server.repository.source).toBe('github');
    expect(pkg.repository.url).toBe(`git+${server.repository.url}.git`);
  });

  it('declares exactly the RIVALIZE_* variables the server reads, and marks only the key secret', () => {
    const src = path.join(PKG_DIR, 'src');
    const seen = new Set<string>();
    for (const f of readdirSync(src)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const text = readFileSync(path.join(src, f), 'utf8');
      for (const m of text.matchAll(/\benv\.(RIVALIZE_[A-Z_]+)/g)) seen.add(m[1]);
    }
    // Positive companion: the scan itself must find the variables config.ts reads.
    expect(seen.has('RIVALIZE_API_KEY')).toBe(true);

    const vars = (npm as NonNullable<typeof npm>).environmentVariables;
    expect(vars.map((v) => v.name).sort()).toEqual([...seen].sort());
    const key = vars.find((v) => v.name === 'RIVALIZE_API_KEY');
    expect(key?.isRequired).toBe(true);
    expect(key?.isSecret).toBe(true);
    expect(vars.filter((v) => v.isSecret).map((v) => v.name)).toEqual(['RIVALIZE_API_KEY']);
  });
});
