import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    applyClaudeAgentProviderEntry,
    applyOpencodePluginEntry,
    claudeAgentRouting,
    claudeAgentRoutingWarning,
    isNpmInstallForm,
    OPENCODE_NPM_ENTRY,
    pluginInstall,
    pluginRemove,
    pluginStatusAll,
    removeClaudeAgentProviderEntry,
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

// #6816: the built-in Claude Agent provider (claude-agent/*) drives a local
// Claude Code binary and makes NO HTTP request from OpenCode, so the native
// plugin's http.request rewrite never sees its traffic. Install routes it
// via providers.claude-agent.settings.baseURL; remove takes it back.

const CLAUDE_BILI_URL = "http://127.0.0.1:18787/bili/https://api.anthropic.com";
const CLAUDE_STALE_URL = "http://127.0.0.1:19999/bili/https://api.anthropic.com";

type ProvidersCfg = {
    providers?: Record<string, { settings?: Record<string, unknown> } & Record<string, unknown>> & Record<string, unknown>;
};

function claudeBaseUrl(data: Record<string, unknown>): unknown {
    const providers = (data as ProvidersCfg).providers;
    if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return undefined;
    const entry = providers["claude-agent"];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const settings = entry.settings;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return undefined;
    return settings.baseURL;
}

test("#6816 applyClaudeAgentProviderEntry: writes the provider baseURL on an empty config", () => {
    const data: Record<string, unknown> = {};
    const notes = applyClaudeAgentProviderEntry(data, CLAUDE_BILI_URL);
    assert.equal(claudeBaseUrl(data), CLAUDE_BILI_URL);
    assert.ok(notes.some((n) => n.includes("claude-agent") && n.includes(CLAUDE_BILI_URL)), `notes: ${notes.join("; ")}`);
});

test("#6816 applyClaudeAgentProviderEntry: preserves other providers and other settings keys", () => {
    const data: Record<string, unknown> = { providers: { openai: { settings: { apiKey: "k", baseURL: "https://example.com/v1" } }, "claude-agent": { settings: { apiKey: "user-key" } } } };
    applyClaudeAgentProviderEntry(data, CLAUDE_BILI_URL);
    const providers = data.providers as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(providers.openai.settings.apiKey, "k");
    assert.equal(providers.openai.settings.baseURL, "https://example.com/v1");
    assert.equal(providers["claude-agent"].settings.apiKey, "user-key");
    assert.equal(providers["claude-agent"].settings.baseURL, CLAUDE_BILI_URL);
});

test("#6816 applyClaudeAgentProviderEntry: idempotent when already routed", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CLAUDE_BILI_URL } } } };
    const before = JSON.stringify(data);
    const notes = applyClaudeAgentProviderEntry(data, CLAUDE_BILI_URL);
    assert.equal(JSON.stringify(data), before);
    assert.ok(notes.some((n) => /already routed/.test(n)), `notes: ${notes.join("; ")}`);
});

test("#6816 applyClaudeAgentProviderEntry: re-pins a stale bili URL to the live port", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CLAUDE_STALE_URL } } } };
    const notes = applyClaudeAgentProviderEntry(data, CLAUDE_BILI_URL);
    assert.equal(claudeBaseUrl(data), CLAUDE_BILI_URL);
    assert.ok(notes.some((n) => /re-pinned/.test(n) && n.includes("19999")), `notes: ${notes.join("; ")}`);
});

test("#6816 applyClaudeAgentProviderEntry: never clobbers a user-set non-bili baseURL", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: "https://api.anthropic.com" } } } };
    const notes = applyClaudeAgentProviderEntry(data, CLAUDE_BILI_URL);
    assert.equal(claudeBaseUrl(data), "https://api.anthropic.com");
    assert.ok(notes.some((n) => /left alone/.test(n)), `notes: ${notes.join("; ")}`);
});

test("#6816 applyClaudeAgentProviderEntry: skips a non-object providers value instead of destroying it", () => {
    const data: Record<string, unknown> = { providers: "not-an-object" };
    const notes = applyClaudeAgentProviderEntry(data, CLAUDE_BILI_URL);
    assert.equal(data.providers, "not-an-object");
    assert.ok(notes.some((n) => /skipped/.test(n)), `notes: ${notes.join("; ")}`);
});

test("#6816 removeClaudeAgentProviderEntry: removes a bili baseURL and prunes the empty keys", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: CLAUDE_BILI_URL } } }, model: "anthropic/claude" };
    const notes = removeClaudeAgentProviderEntry(data);
    assert.equal(data.providers, undefined);
    assert.equal(data.model, "anthropic/claude");
    assert.ok(notes.some((n) => n.includes("claude-agent")), `notes: ${notes.join("; ")}`);
});

test("#6816 removeClaudeAgentProviderEntry: keeps sibling providers and sibling settings", () => {
    const data: Record<string, unknown> = { providers: { openai: { settings: { baseURL: "https://example.com/v1" } }, "claude-agent": { settings: { apiKey: "k", baseURL: CLAUDE_BILI_URL } } } };
    removeClaudeAgentProviderEntry(data);
    const providers = data.providers as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(providers["claude-agent"].settings.apiKey, "k");
    assert.equal(providers["claude-agent"].settings.baseURL, undefined);
    assert.equal(providers.openai.settings.baseURL, "https://example.com/v1");
});

test("#6816 removeClaudeAgentProviderEntry: never touches a user-set non-bili baseURL", () => {
    const data: Record<string, unknown> = { providers: { "claude-agent": { settings: { baseURL: "https://api.anthropic.com" } } } };
    assert.deepEqual(removeClaudeAgentProviderEntry(data), []);
    assert.equal(claudeBaseUrl(data), "https://api.anthropic.com");
});

test("#6816 removeClaudeAgentProviderEntry: no-op on a config without the entry", () => {
    const data: Record<string, unknown> = { model: "anthropic/claude" };
    assert.deepEqual(removeClaudeAgentProviderEntry(data), []);
});

test("#6816 claudeAgentRouting: routed on a live port or the preferred port, stale on a dead bili port, unrouted otherwise", () => {
    const live = new Set([18788]);
    assert.equal(claudeAgentRouting({ providers: { "claude-agent": { settings: { baseURL: "http://127.0.0.1:18788/bili/https://api.anthropic.com" } } } }, live, 18787).state, "routed");
    assert.equal(claudeAgentRouting({ providers: { "claude-agent": { settings: { baseURL: CLAUDE_BILI_URL } } } }, live, 18787).state, "routed");
    assert.equal(claudeAgentRouting({ providers: { "claude-agent": { settings: { baseURL: CLAUDE_STALE_URL } } } }, live, 18787).state, "stale");
    assert.equal(claudeAgentRouting({}, live, 18787).state, "unrouted");
    assert.equal(claudeAgentRouting({ providers: { "claude-agent": { settings: { baseURL: "https://api.anthropic.com" } } } }, live, 18787).state, "unrouted");
});

test("#6816 claudeAgentRoutingWarning: advisory text for unrouted and stale, silence when routed", () => {
    const live = new Set<number>();
    const unrouted = claudeAgentRoutingWarning({}, live, 18787);
    assert.ok(unrouted !== undefined && unrouted.includes("claude-agent") && unrouted.includes("#6816"), `warning: ${unrouted}`);
    const stale = claudeAgentRoutingWarning({ providers: { "claude-agent": { settings: { baseURL: CLAUDE_STALE_URL } } } }, live, 18787);
    assert.ok(stale !== undefined && stale.includes("stale") && stale.includes("19999"), `warning: ${stale}`);
    assert.equal(claudeAgentRoutingWarning({ providers: { "claude-agent": { settings: { baseURL: CLAUDE_BILI_URL } } } }, live, 18787), undefined);
});

test("#6816 pluginInstall opencode under a 2.x host writes the claude-agent provider baseURL, remove takes it back", (t) => {
    if (process.platform === "win32") {
        t.skip("probe stub is a POSIX shell script");
        return;
    }
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: "anthropic/claude" }, null, 2));
    const read = (): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

    const out = pluginInstall("opencode");
    assert.match(out, /claude-agent/);
    assert.equal(claudeBaseUrl(read()), CLAUDE_BILI_URL);

    // Reinstall is idempotent — the entry survives untouched.
    pluginInstall("opencode");
    assert.equal(claudeBaseUrl(read()), CLAUDE_BILI_URL);

    const rem = pluginRemove("opencode");
    assert.match(rem, /claude-agent/);
    const after = read();
    assert.equal(after.providers, undefined, "remove prunes the providers key it created");
});

test("#6816 pluginInstall prefers a live opencode-lane instance's port over the sticky record", (t) => {
    if (process.platform === "win32") {
        t.skip("probe stub is a POSIX shell script");
        return;
    }
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    const prevBin = process.env.BILI_CLIENT_BIN;
    delete process.env.OPENCODE_CONFIG;
    const xdg = tempDir("bili-oc-6816-live-xdg-");
    const state = tempDir("bili-oc-6816-live-state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    const bin = path.join(xdg, "fake-opencode-6816-live");
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

    // A live opencode-lane proxy drifted to 18788; the sticky record (absent
    // here) would say 18787. The install must pin the live port.
    const instancesDir = path.join(state, "billion-context", "instances");
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.writeFileSync(path.join(instancesDir, "live-opencode.json"), JSON.stringify({ instanceId: "live-opencode", pid: process.pid, port: 18788, origin: "http://127.0.0.1:18788", startedAt: Date.now(), lane: "opencode" }));

    const file = path.join(xdg, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: "anthropic/claude" }, null, 2));

    pluginInstall("opencode");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(claudeBaseUrl(cfg), "http://127.0.0.1:18788/bili/https://api.anthropic.com");
});
