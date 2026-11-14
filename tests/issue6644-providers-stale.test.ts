import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { findRoute, loadOptions, refreshRoutesIfStale, type ProxyOptions } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #6644: per-route providers.* edits (incl. proxy) stayed inert in the running
// helper until POST /__bili/config/reload, while GET /__bili/config already
// echoed them. The routes table is a startup snapshot; refreshRoutesIfStale
// re-reads it at the request-path choke point when the file's routes differ.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6644-"));
const savedConfigEnv = process.env.BILI_CONFIG_FILE;
const configFile = path.join(root, "billion-context.json");

test.after(() => {
    setLogCapture(null);
    if (savedConfigEnv === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedConfigEnv;
    fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(content: string): void {
    fs.writeFileSync(configFile, content, "utf8");
}

function baseOpts(): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "https://relay.example",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("#6644: a providers.* file edit is picked up without an explicit reload", () => {
    process.env.BILI_CONFIG_FILE = configFile;
    writeConfig(JSON.stringify({ providers: {} }));
    const opts = loadOptions({ ACP_PORT: "8787" });
    assert.equal(findRoute(opts.routes, "https://relay.example/v1/responses"), undefined);
    writeConfig(JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:18080" } } }));
    refreshRoutesIfStale(opts);
    assert.equal(findRoute(opts.routes, "https://relay.example/v1/responses")?.proxy, "http://127.0.0.1:18080");
});

test("#6644: removing a providers.* entry drops the route again (negative direction)", () => {
    process.env.BILI_CONFIG_FILE = configFile;
    writeConfig(JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:18080" } } }));
    const opts = loadOptions({ ACP_PORT: "8787" });
    assert.equal(findRoute(opts.routes, "https://relay.example/v1/responses")?.proxy, "http://127.0.0.1:18080");
    writeConfig(JSON.stringify({ providers: {} }));
    refreshRoutesIfStale(opts);
    assert.equal(findRoute(opts.routes, "https://relay.example/v1/responses"), undefined);
});

test("#6644: an unchanged file never churns the routes object (no proxy-agent reset)", () => {
    process.env.BILI_CONFIG_FILE = configFile;
    writeConfig(JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:18080" } } }));
    const opts = loadOptions({ ACP_PORT: "8787" });
    const before = opts.routes["https://relay.example"];
    assert.ok(before);
    // Same content, rewritten (cp -p / rsync --times style restoration).
    writeConfig(JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:18080" } } }));
    refreshRoutesIfStale(opts);
    assert.equal(opts.routes["https://relay.example"], before, "identical routes keep the same object (no swap, no cache reset)");
});

test("#6644: an invalid providers edit keeps the last-good routes and never throws", () => {
    process.env.BILI_CONFIG_FILE = configFile;
    writeConfig(JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:18080" } } }));
    const opts = loadOptions({ ACP_PORT: "8787" });
    const seen: string[] = [];
    setLogCapture((_level, msg) => { if (msg.includes("providers table not reloaded")) seen.push(msg); });
    try {
        writeConfig(JSON.stringify({ providers: { "https://relay.example": { protocol: "bogus" } } }));
        assert.doesNotThrow(() => refreshRoutesIfStale(opts));
        assert.equal(findRoute(opts.routes, "https://relay.example/v1/responses")?.proxy, "http://127.0.0.1:18080");
        assert.equal(seen.length, 1, `bad edit logs once (got ${seen.length})`);
        assert.doesNotThrow(() => refreshRoutesIfStale(opts));
        assert.equal(seen.length, 1, "repeat refresh while still invalid stays silent");
        // A valid rewrite recovers and re-arms the once-per-error log.
        writeConfig(JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:18081" } } }));
        refreshRoutesIfStale(opts);
        assert.equal(findRoute(opts.routes, "https://relay.example/v1/responses")?.proxy, "http://127.0.0.1:18081");
    } finally {
        setLogCapture(null);
    }
});

test("#6644: GET /__bili/upstream follows a providers.* file edit with no reload call", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    process.env.BILI_CONFIG_FILE = configFile;
    writeConfig(JSON.stringify({ providers: {} }));
    const opts = baseOpts();
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
        const before = await (await fetch(`${base}/__bili/upstream`)).json() as { proxy: string | null; source: string };
        assert.equal(before.proxy, null, "no route yet: direct");
        // The exact repro shape from the issue: edit the FILE (not the API),
        // no POST /__bili/config/reload, no restart.
        writeConfig(JSON.stringify({ providers: { "https://relay.example": { proxy: "http://127.0.0.1:18080" } } }));
        const after = await (await fetch(`${base}/__bili/upstream`)).json() as { proxy: string | null; source: string };
        assert.equal(after.proxy, "http://127.0.0.1:18080/", "file edit reaches the running helper on the next request");
        assert.equal(after.source, "provider", "the proxy comes from the per-route table, not the global tier");
        // Negative direction through the same live path: removing the entry
        // drops the lane again.
        writeConfig(JSON.stringify({ providers: {} }));
        const removed = await (await fetch(`${base}/__bili/upstream`)).json() as { proxy: string | null; source: string };
        assert.equal(removed.proxy, null, "removing the entry drops the lane on the next request");
    } finally {
        await close(proxy);
        rmrf(root);
    }
});
