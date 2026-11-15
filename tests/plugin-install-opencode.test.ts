import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
    applyClaudeAgentProviderRoute,
    applyOpencodePluginEntry,
    claudeAgentProxyBaseUrl,
    isNpmInstallForm,
    OPENCODE_NPM_ENTRY,
    pluginInstall,
    pluginRemove,
    pluginStatusAll,
    removeClaudeAgentProviderRoute,
    selfPackageRoot,
} from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

const NPM_ROOT = "/usr/local/lib/node_modules/billion-context";

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function entryArgs(root: string, base: string): { data: Record<string, unknown>; root: string; shimDir: string; agentJs: string } {
    const shimDir = path.join(base, "opencode", "plugins", "billion-context");
    return { data: {}, root, shimDir, agentJs: path.join(root, "dist", "agent", "opencode-native.js") };
}

test("isNpmInstallForm: npm/pnpm/yarn roots are npm form, checkouts are not", () => {
    assert.equal(isNpmInstallForm("/usr/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/usr/local/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/.npm-global/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/proj/node_modules/.pnpm/billion-context@0.1.118/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/checkouts/billion-context"), false);
    assert.equal(isNpmInstallForm("/opt/bili"), false);
    assert.equal(isNpmInstallForm("/srv/node_modules"), false);
});

test("applyOpencodePluginEntry: npm form writes the bare package name only", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-npm-"));
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [OPENCODE_NPM_ENTRY]);
    assert.deepEqual(notes, [`plugin -> ${OPENCODE_NPM_ENTRY}`]);
    assert.equal(fs.existsSync(args.shimDir), false);
});

test("applyOpencodePluginEntry: npm form migrates a legacy dev shim to the bare name and deletes the dir", () => {
    const base = tempDir("bili-oc-migrate-");
    const args = entryArgs(NPM_ROOT, base);
    fs.mkdirSync(args.shimDir, { recursive: true });
    fs.writeFileSync(path.join(args.shimDir, "index.js"), 'export { default } from "/opt/old/dist/agent/opencode-native.js";\n');
    args.data.plugin = ["other-pkg", args.shimDir];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, ["other-pkg", OPENCODE_NPM_ENTRY]);
    assert.equal(notes[0], `plugin -> ${OPENCODE_NPM_ENTRY} (replaced ${args.shimDir})`);
    assert.equal(fs.existsSync(args.shimDir), false);
});

test("applyOpencodePluginEntry: npm form is idempotent", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-idem-"));
    args.data.plugin = [OPENCODE_NPM_ENTRY];
    assert.deepEqual(applyOpencodePluginEntry(args), ["plugin present"]);
    assert.deepEqual(args.data.plugin, [OPENCODE_NPM_ENTRY]);
});

test("applyOpencodePluginEntry: 2.x host (plugins key) writes the shim dir even for npm form (#3976)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-v2npm-"));
    const notes = applyOpencodePluginEntry({ ...args, key: "plugins" });
    assert.deepEqual(args.data.plugins, [args.shimDir]);
    assert.equal(notes[0], `plugins -> ${args.shimDir}`);
    assert.match(notes[1], /#3976/);
    const shim = fs.readFileSync(path.join(args.shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(args.agentJs)};\n`);
});

test("applyOpencodePluginEntry: 2.x host migrates a legacy bare-name entry to the shim dir (#3976)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-v2migrate-"));
    args.data.plugins = ["other-pkg", OPENCODE_NPM_ENTRY];
    const notes = applyOpencodePluginEntry({ ...args, key: "plugins" });
    assert.deepEqual(args.data.plugins, ["other-pkg", args.shimDir]);
    assert.equal(notes[0], `plugins -> ${args.shimDir} (replaced ${OPENCODE_NPM_ENTRY})`);
    assert.match(notes[1], /#3976/);
    assert.ok(fs.existsSync(path.join(args.shimDir, "index.js")), "shim written");
});

test("applyOpencodePluginEntry: 2.x shim entry is idempotent", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-v2idem-"));
    args.data.plugins = [args.shimDir];
    fs.mkdirSync(args.shimDir, { recursive: true });
    fs.writeFileSync(path.join(args.shimDir, "index.js"), `export { default } from ${JSON.stringify(args.agentJs)};\n`);
    const touched = new Set<string>();
    assert.deepEqual(applyOpencodePluginEntry({ ...args, key: "plugins", touched }), ["plugins present"]);
    assert.equal(touched.size, 0, "no key touched — no rewrite");
});

test("applyOpencodePluginEntry: a stale shim is healed even when the config entry is already present", () => {
    const base = tempDir("bili-oc-stale-");
    const args = entryArgs(NPM_ROOT, base);
    const staleAgentJs = "/opt/old-bili/dist/agent/opencode-native.js";
    fs.mkdirSync(args.shimDir, { recursive: true });
    fs.writeFileSync(path.join(args.shimDir, "index.js"), `export { default } from ${JSON.stringify(staleAgentJs)};\n`);
    args.data.plugins = [args.shimDir];
    assert.deepEqual(applyOpencodePluginEntry({ ...args, key: "plugins" }), ["plugins present"]);
    const shim = fs.readFileSync(path.join(args.shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(args.agentJs)};\n`, "shim re-export follows the current root");
});

test("applyOpencodePluginEntry: dev form writes a local shim and warns it is not portable", () => {
    const args = entryArgs("/opt/checkout-bili", tempDir("bili-oc-dev-"));
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [args.shimDir]);
    assert.equal(notes[0], `plugin -> ${args.shimDir}`);
    assert.match(notes[1], /not portable across machines/);
    const shim = fs.readFileSync(path.join(args.shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(args.agentJs)};\n`);
});

test("applyOpencodePluginEntry: dev form replaces an existing bare-name entry with the shim", () => {
    const args = entryArgs("/opt/checkout-bili", tempDir("bili-oc-dev-replace-"));
    args.data.plugin = [OPENCODE_NPM_ENTRY];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [args.shimDir]);
    assert.equal(notes[0], `plugin -> ${args.shimDir} (replaced ${OPENCODE_NPM_ENTRY})`);
    assert.match(notes[1], /not portable across machines/);
});

test("applyOpencodePluginEntry: non-string plugin entries are preserved verbatim (#1002)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-nonstr-"));
    const objs = [{ package: "@org/x" }, { package: "y", options: { z: 1 } }];
    args.data.plugin = [42, null, ...objs, "other-pkg"];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [42, null, ...objs, "other-pkg", OPENCODE_NPM_ENTRY]);
    assert.deepEqual(notes, [`plugin -> ${OPENCODE_NPM_ENTRY}`]);
});

test("applyOpencodePluginEntry: idempotent run with foreign objects leaves the key untouched (#1002)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-idem-obj-"));
    const objs = [{ package: "@org/x" }];
    args.data.plugin = [...objs, OPENCODE_NPM_ENTRY];
    const touched = new Set<string>();
    const before = args.data.plugin;
    assert.deepEqual(applyOpencodePluginEntry({ ...args, touched }), ["plugin present"]);
    assert.equal(touched.size, 0, "no key touched — no rewrite");
    assert.equal(args.data.plugin, before, "same array reference, untouched");
});

test("applyOpencodePluginEntry: map-form plugins keep foreign options and stay a map (#1002)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-map-"));
    args.data.plugins = { "@org/x": { options: { z: 1 } }, "plain-y": true };
    applyOpencodePluginEntry({ ...args, key: "plugins" });
    // #3976: the `plugins` key means a 2.x host — even an npm-form install
    // lands as the shim dir there, so the map carries the dir, not the name.
    assert.deepEqual(args.data.plugins, { "@org/x": { options: { z: 1 } }, "plain-y": true, [args.shimDir]: true });
    assert.ok(!Array.isArray(args.data.plugins), "map form preserved");
});

type OcCfg = { plugin?: unknown; plugins?: unknown; compaction?: { auto?: boolean } & Record<string, unknown>; mcp?: unknown };

test("pluginInstall/remove/status opencode end-to-end (dev form under tsx)", (t) => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    const prevMcp = process.env.BILI_MCP_PROXY;
    const prevBin = process.env.BILI_CLIENT_BIN;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.BILI_MCP_PROXY;
    // Hermetic probe: an unresolvable bin fails soft to major 1, so the test
    // never depends on whatever `opencode` the host PATH (or an npm test
    // node_modules/.bin walk) happens to shadow in.
    process.env.BILI_CLIENT_BIN = "/nonexistent/bili-oc-probe-pin";
    const xdg = tempDir("bili-oc-xdg-");
    const state = tempDir("bili-oc-state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        if (prevOpen === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOpen;
        if (prevMcp === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevMcp;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        rmrf(xdg);
        rmrf(state);
    });

    const file = path.join(xdg, "opencode", "opencode.json");
    const shimDir = path.join(xdg, "opencode", "plugins", "billion-context");
    const readCfg = (): OcCfg => JSON.parse(fs.readFileSync(file, "utf8")) as OcCfg;
    const ocStatus = () => pluginStatusAll().find((r) => r.agent === "opencode")?.status;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude", plugin: ["some-other"], compaction: { auto: true } }, null, 2));

    assert.equal(ocStatus(), "not installed");

    const out = pluginInstall("opencode");
    assert.ok(out.startsWith(`opencode: installed -> ${file}`), out);
    assert.match(out, /plugin -> .+plugins[\\/]billion-context/);
    assert.match(out, /machine-local shim, not portable across machines/);
    let cfg = readCfg();
    assert.deepEqual(cfg.plugin, ["some-other", shimDir]);
    assert.equal(cfg.compaction?.auto, false);
    assert.equal(cfg.mcp, undefined);
    const shim = fs.readFileSync(path.join(shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(path.join(selfPackageRoot(), "dist", "agent", "opencode-native.js"))};\n`);
    assert.equal(ocStatus(), "installed");

    const again = pluginInstall("opencode");
    assert.match(again, /plugin present/);
    assert.deepEqual(readCfg().plugin, ["some-other", shimDir]);

    const rem = pluginRemove("opencode");
    assert.match(rem, /^opencode: removed from /);
    assert.match(rem, /plugin removed \(/);
    cfg = readCfg();
    assert.deepEqual(cfg.plugin, ["some-other"]);
    assert.equal(cfg.compaction?.auto, true);
    assert.equal(fs.existsSync(shimDir), false);
    assert.equal(ocStatus(), "not installed");

    assert.match(pluginRemove("opencode"), /not installed/);
});

test("pluginInstall opencode under a 2.x host writes the plugins key + shim dir (#3976)", (t) => {
    if (process.platform === "win32") {
        t.skip("probe stub is a POSIX shell script");
        return;
    }
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    const prevBin = process.env.BILI_CLIENT_BIN;
    delete process.env.OPENCODE_CONFIG;
    const xdg = tempDir("bili-oc-v2xdg-");
    const state = tempDir("bili-oc-v2state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    const bin = path.join(xdg, "fake-opencode");
    fs.writeFileSync(bin, "#!/bin/sh\necho 'opencode 2.1.0'\n");
    fs.chmodSync(bin, 0o755);
    process.env.BILI_CLIENT_BIN = bin;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        if (prevOpen === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOpen;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        rmrf(xdg);
        rmrf(state);
    });

    const file = path.join(xdg, "opencode", "opencode.json");
    const shimDir = path.join(xdg, "opencode", "plugins", "billion-context");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: "anthropic/claude" }, null, 2));

    const out = pluginInstall("opencode");
    assert.ok(out.startsWith(`opencode: installed -> ${file}`), out);
    assert.match(out, /plugins -> .+plugins[\\/]billion-context/);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as OcCfg;
    assert.deepEqual(cfg.plugins, [shimDir]);
    assert.equal(cfg.plugin, undefined, "no singular-key entry on a 2.x host");
    assert.equal(cfg.compaction?.auto, false);
    assert.ok(fs.existsSync(path.join(shimDir, "index.js")), "shim written");
    assert.equal(pluginStatusAll().find((r) => r.agent === "opencode")?.status, "installed");

    const rem = pluginRemove("opencode");
    assert.match(rem, /plugin removed \(/);
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as OcCfg;
    assert.equal(after.plugins, undefined);
    assert.equal(fs.existsSync(shimDir), false);
});

const MCP_PINNED = { type: "local", command: ["/usr/bin/node", "/opt/old/dist/mcp.js"], environment: { BILI_MCP_PROXY: "http://127.0.0.1:18787" }, enabled: true };

type OcMcpCfg = { plugin?: unknown; mcp?: { bili?: Record<string, unknown> } & Record<string, unknown> };

function withOcConfig(t: import("node:test").TestContext, initial: OcMcpCfg): { file: string; read: () => OcMcpCfg } {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG;
    const xdg = tempDir("bili-oc-mcp-");
    const state = tempDir("bili-oc-mcp-state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        if (prevOpen === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOpen;
        rmrf(xdg);
        rmrf(state);
    });
    const file = path.join(xdg, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(initial, null, 2));
    return { file, read: () => JSON.parse(fs.readFileSync(file, "utf8")) as OcMcpCfg };
}

test("#926 default install never writes mcp.bili, even with BILI_MCP_PROXY set", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    process.env.BILI_MCP_PROXY = "http://127.0.0.1:18787";
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, {});
    const out = pluginInstall("opencode");
    assert.match(out, /mcp\.bili not written/);
    assert.equal(read().mcp, undefined);
});

test("#926 default install heals a stale pinned mcp.bili from an older install", (t) => {
    const { read } = withOcConfig(t, { mcp: { bili: MCP_PINNED } });
    const out = pluginInstall("opencode");
    assert.match(out, /mcp\.bili removed \(stale second tool face/);
    assert.equal(read().mcp, undefined);
});

test("#926 --with-mcp writes mcp.bili without an origin pin (live discovery)", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    delete process.env.BILI_MCP_PROXY;
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, {});
    const out = pluginInstall("opencode", { withMcp: true });
    assert.match(out, /mcp\.bili written \(no origin pin/);
    const bili = read().mcp?.bili;
    assert.ok(bili, "mcp.bili written");
    assert.equal(bili!.environment, undefined);
    assert.equal(bili!.enabled, true);
});

test("#926 --with-mcp pins the origin only when BILI_MCP_PROXY is explicit", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    process.env.BILI_MCP_PROXY = "http://127.0.0.1:8787";
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, {});
    const out = pluginInstall("opencode", { withMcp: true });
    assert.match(out, /mcp\.bili written \(BILI_MCP_PROXY=http:\/\/127\.0\.0\.1:8787\)/);
    const bili = read().mcp?.bili;
    assert.deepEqual(bili!.environment, { BILI_MCP_PROXY: "http://127.0.0.1:8787" });
});

test("#926 --with-mcp strips a stale pin from an existing entry but keeps the entry", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    delete process.env.BILI_MCP_PROXY;
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, { mcp: { bili: MCP_PINNED } });
    const out = pluginInstall("opencode", { withMcp: true });
    assert.match(out, /mcp\.bili present \(stale BILI_MCP_PROXY pin removed/);
    const bili = read().mcp?.bili;
    assert.ok(bili, "entry kept");
    assert.equal(bili!.environment, undefined);
    assert.deepEqual(bili!.command, ["/usr/bin/node", "/opt/old/dist/mcp.js"]);
    assert.equal(bili!.enabled, true);
});

// — #6816: claude-agent provider routing ————————————————————————————
// OpenCode v2's built-in claude-agent provider drives a local Claude Code
// binary and makes no HTTP request from OpenCode, so the native plugin's
// HTTP-hook routing never sees its traffic. Install points the provider at
// the proxy via providers."claude-agent".settings.baseURL (the v2 schema
// shape); remove takes it back out. Gate discipline (#3617): every case
// below asserts BOTH directions — routes when it should, leaves alone when
// it should not.

const CA_BILI_18787 = "http://127.0.0.1:18787/bili/https://api.anthropic.com";
const CA_BILI_18789 = "http://127.0.0.1:18789/bili/https://api.anthropic.com";

function caBaseUrl(data: Record<string, unknown>): unknown {
    const p = data.providers as Record<string, unknown> | undefined;
    const e = p?.["claude-agent"] as Record<string, unknown> | undefined;
    const s = e?.settings as Record<string, unknown> | undefined;
    return s?.baseURL;
}

test("#6816 claudeAgentProxyBaseUrl: loopback origin + /bili/ + anthropic upstream", () => {
    assert.equal(claudeAgentProxyBaseUrl(18787), CA_BILI_18787);
    assert.equal(claudeAgentProxyBaseUrl(18789), CA_BILI_18789);
});

test("#6816 applyClaudeAgentProviderRoute: writes providers.claude-agent.settings.baseURL on an empty config", () => {
    const data: Record<string, unknown> = {};
    const touched = new Set<string>();
    const notes = applyClaudeAgentProviderRoute({ data, baseUrl: CA_BILI_18789, touched });
    assert.equal(caBaseUrl(data), CA_BILI_18789);
    assert.ok(touched.has("providers"));
    assert.match(notes.join("; "), /providers\.claude-agent\.settings\.baseURL written/);
});

test("#6816 applyClaudeAgentProviderRoute: preserves sibling providers and sibling settings keys", () => {
    const data: Record<string, unknown> = {
        providers: {
            anthropic: { settings: { baseURL: "https://api.anthropic.com" } },
            "claude-agent": { settings: { timeout: 30 } },
        },
    };
    const touched = new Set<string>();
    applyClaudeAgentProviderRoute({ data, baseUrl: CA_BILI_18789, touched });
    assert.equal(caBaseUrl(data), CA_BILI_18789);
    const providers = data.providers as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(providers.anthropic.settings.baseURL, "https://api.anthropic.com");
    assert.equal(providers["claude-agent"].settings.timeout, 30);
    assert.ok(touched.has("providers"));
});

test("#6816 applyClaudeAgentProviderRoute: already routed at the live port is a no-op", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CA_BILI_18789 } } } };
    const before = JSON.stringify(data);
    const touched = new Set<string>();
    const notes = applyClaudeAgentProviderRoute({ data, baseUrl: CA_BILI_18789, touched });
    assert.equal(JSON.stringify(data), before);
    assert.equal(touched.size, 0, "no key touched — no rewrite");
    assert.match(notes.join("; "), /already routed/);
});

test("#6816 applyClaudeAgentProviderRoute: a drifted bili port is healed to the live lane port", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CA_BILI_18787 } } } };
    const touched = new Set<string>();
    const notes = applyClaudeAgentProviderRoute({ data, baseUrl: CA_BILI_18789, touched });
    assert.equal(caBaseUrl(data), CA_BILI_18789);
    assert.ok(touched.has("providers"));
    assert.match(notes.join("; "), /updated to the live lane port/);
});

test("#6816 applyClaudeAgentProviderRoute: a foreign baseURL is left untouched, never clobbered", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: "https://custom.example.com" } } } };
    const before = JSON.stringify(data);
    const touched = new Set<string>();
    const notes = applyClaudeAgentProviderRoute({ data, baseUrl: CA_BILI_18789, touched });
    assert.equal(JSON.stringify(data), before);
    assert.equal(touched.size, 0);
    assert.match(notes.join("; "), /left untouched \(foreign value/);
});

test("#6816 applyClaudeAgentProviderRoute: non-object providers / entry / settings are skipped, never crash", () => {
    for (const data of [
        { providers: "not-an-object" },
        { providers: { "claude-agent": "not-an-object" } },
        { providers: { "claude-agent": { settings: "not-an-object" } } },
    ] as Record<string, unknown>[]) {
        const before = JSON.stringify(data);
        const touched = new Set<string>();
        const notes = applyClaudeAgentProviderRoute({ data, baseUrl: CA_BILI_18789, touched });
        assert.equal(JSON.stringify(data), before);
        assert.equal(touched.size, 0);
        assert.match(notes.join("; "), /routing skipped/);
    }
});

test("#6816 removeClaudeAgentProviderRoute: removes a bili baseURL and prunes empty parents", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CA_BILI_18789 } } } };
    const touched = new Set<string>();
    const notes = removeClaudeAgentProviderRoute({ data, touched });
    assert.equal(data.providers, undefined);
    assert.ok(touched.has("providers"));
    assert.match(notes.join("; "), /providers\.claude-agent\.settings\.baseURL removed/);
});

test("#6816 removeClaudeAgentProviderRoute: keeps sibling settings and sibling providers", () => {
    const data: Record<string, unknown> = {
        providers: {
            anthropic: { settings: { baseURL: "https://api.anthropic.com" } },
            "claude-agent": { settings: { baseURL: CA_BILI_18789, timeout: 30 } },
        },
    };
    const touched = new Set<string>();
    removeClaudeAgentProviderRoute({ data, touched });
    const providers = data.providers as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(providers["claude-agent"].settings.baseURL, undefined);
    assert.equal(providers["claude-agent"].settings.timeout, 30);
    assert.equal(providers.anthropic.settings.baseURL, "https://api.anthropic.com");
    assert.ok(touched.has("providers"));
});

test("#6816 removeClaudeAgentProviderRoute: a foreign baseURL is never ours to remove", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: "https://custom.example.com" } } } };
    const before = JSON.stringify(data);
    const touched = new Set<string>();
    assert.deepEqual(removeClaudeAgentProviderRoute({ data, touched }), []);
    assert.equal(JSON.stringify(data), before);
    assert.equal(touched.size, 0);
});

test("#6816 removeClaudeAgentProviderRoute: absent entry is a no-op", () => {
    const data: Record<string, unknown> = { providers: { anthropic: { settings: {} } } };
    const before = JSON.stringify(data);
    const touched = new Set<string>();
    assert.deepEqual(removeClaudeAgentProviderRoute({ data, touched }), []);
    assert.equal(JSON.stringify(data), before);
    assert.equal(touched.size, 0);
});

test("#6816 removeClaudeAgentProviderRoute: restores a hand-written bili URL from the backup", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CA_BILI_18789 } } } };
    const backup: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CA_BILI_18787 } } } };
    const touched = new Set<string>();
    const notes = removeClaudeAgentProviderRoute({ data, backup, touched });
    assert.equal(caBaseUrl(data), CA_BILI_18787);
    assert.ok(touched.has("providers"));
    assert.match(notes.join("; "), /restored from backup/);
});

// 2.x end-to-end: fake `opencode --version` stub (POSIX only — same probe
// trick as the #3976 test above) + a drifted sticky port in port-zone.json
// proves install writes the LIVE lane port, not the 18787 base.
function oc2xOrSkip(t: import("node:test").TestContext): boolean {
    if (process.platform === "win32") {
        t.skip("probe stub is a POSIX shell script");
        return true;
    }
    return false;
}

type Oc6816Ctx = { file: string; read: () => Record<string, unknown> };

function withOc6816(t: import("node:test").TestContext, initial: Record<string, unknown>, portZone?: number): Oc6816Ctx {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    const prevBin = process.env.BILI_CLIENT_BIN;
    delete process.env.OPENCODE_CONFIG;
    const xdg = tempDir("bili-oc-6816-xdg-");
    const state = tempDir("bili-oc-6816-state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    const bin = path.join(xdg, "fake-opencode-6816");
    fs.writeFileSync(bin, "#!/bin/sh\necho 'opencode 2.3.1'\n");
    fs.chmodSync(bin, 0o755);
    process.env.BILI_CLIENT_BIN = bin;
    if (portZone !== undefined) {
        const zoneDir = path.join(state, "billion-context");
        fs.mkdirSync(zoneDir, { recursive: true });
        fs.writeFileSync(path.join(zoneDir, "port-zone.json"), JSON.stringify({ lanes: { opencode: portZone } }));
    }
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        if (prevOpen === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOpen;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        rmrf(xdg);
        rmrf(state);
    });
    const file = path.join(xdg, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(initial, null, 2));
    return { file, read: () => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> };
}

test("#6816 pluginInstall opencode on a 2.x host writes the live lane port, not the hardcoded base", (t) => {
    if (oc2xOrSkip(t)) return;
    const { read } = withOc6816(t, { model: "anthropic/claude" }, 18789);
    const out = pluginInstall("opencode");
    assert.match(out, /providers\.claude-agent\.settings\.baseURL written/);
    assert.equal(caBaseUrl(read()), CA_BILI_18789);

    const again = pluginInstall("opencode");
    assert.match(again, /already routed/);
    assert.equal(caBaseUrl(read()), CA_BILI_18789);

    const rem = pluginRemove("opencode");
    assert.match(rem, /providers\.claude-agent\.settings\.baseURL removed/);
    assert.equal(read().providers, undefined);
});

test("#6816 pluginInstall opencode on a 1.x host writes no providers key", (t) => {
    const prevBin = process.env.BILI_CLIENT_BIN;
    process.env.BILI_CLIENT_BIN = "/nonexistent/bili-oc-probe-pin";
    t.after(() => {
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
    });
    const { read } = withOcConfig(t, {});
    const out = pluginInstall("opencode");
    assert.match(out, /providers\.claude-agent routing skipped \(OpenCode 1\.x/);
    assert.equal((read() as Record<string, unknown>).providers, undefined);
});

test("#6816 pluginInstall opencode preserves a foreign claude-agent baseURL", (t) => {
    if (oc2xOrSkip(t)) return;
    const { read } = withOc6816(t, { providers: { "claude-agent": { settings: { baseURL: "https://custom.example.com" } } } }, 18789);
    const out = pluginInstall("opencode");
    assert.match(out, /left untouched \(foreign value/);
    assert.equal(caBaseUrl(read()), "https://custom.example.com");
});

test("#6816 pluginInstall opencode heals a drifted bili baseURL to the live lane port", (t) => {
    if (oc2xOrSkip(t)) return;
    const { read } = withOc6816(t, { providers: { "claude-agent": { settings: { baseURL: CA_BILI_18787 } } } }, 18789);
    const out = pluginInstall("opencode");
    assert.match(out, /updated to the live lane port/);
    assert.equal(caBaseUrl(read()), CA_BILI_18789);
});

test("#6816 pluginRemove opencode restores a hand-written bili baseURL from the backup", (t) => {
    if (oc2xOrSkip(t)) return;
    const { read } = withOc6816(t, { providers: { "claude-agent": { settings: { baseURL: CA_BILI_18787 } } } }, 18789);
    pluginInstall("opencode");
    assert.equal(caBaseUrl(read()), CA_BILI_18789, "install heals the stale port");
    const rem = pluginRemove("opencode");
    assert.match(rem, /restored from backup/);
    assert.equal(caBaseUrl(read()), CA_BILI_18787, "remove restores the user's own pre-install URL");
});

test("#6816 pluginInstall opencode heals a drifted bili baseURL inside a JSONC config, comments elsewhere survive", (t) => {
    if (oc2xOrSkip(t)) return;
    const { file } = withOc6816(t, {}, 18789);
    // JSONC target: comments + a pre-seeded drifted bili URL (not strict JSON,
    // so the write path is the surgical jsoncModify one, not whole-file
    // stringify — same mechanism as the compaction key). The strict-JSON
    // `read()` helper cannot parse this file; read it JSONC-tolerantly.
    const readJsonc = (): Record<string, unknown> => {
        const errors: import("jsonc-parser").ParseError[] = [];
        return parseJsonc(fs.readFileSync(file, "utf8"), errors) as Record<string, unknown>;
    };
    fs.writeFileSync(
        file,
        `{\n  // user comment — must survive install + remove\n  "model": "anthropic/claude",\n  "providers": {\n    "claude-agent": { "settings": { "baseURL": "${CA_BILI_18787}" } }\n  }\n}\n`,
    );
    const out = pluginInstall("opencode");
    assert.match(out, /updated to the live lane port/);
    assert.equal(caBaseUrl(readJsonc()), CA_BILI_18789);
    assert.match(fs.readFileSync(file, "utf8"), /user comment — must survive/);
    const rem = pluginRemove("opencode");
    assert.match(rem, /restored from backup/);
    assert.equal(caBaseUrl(readJsonc()), CA_BILI_18787);
    assert.match(fs.readFileSync(file, "utf8"), /user comment — must survive/);
});
