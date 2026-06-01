import fs from "fs";
import { createRequire } from "node:module";
import os from "os";
import path from "path";
import { Codex } from "@openai/codex-sdk";
const require = createRequire(import.meta.url);
const DISCORD_MAX = 1990; // Leave headroom for code-fence close/reopen overhead
function isThreadNotFoundError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /(thread|session).*(not found|missing|unknown)/i.test(message);
}
function unsupported(feature) {
    throw new Error(`${feature} is not exposed by @openai/codex-sdk.`);
}
/**
 * Splits text into chunks that each fit within Discord's 2000-char message limit.
 * Splits at paragraph -> newline -> word boundaries to avoid mid-word splits.
 * Tracks open code fences: closes the fence at the split point and reopens it
 * at the start of the next chunk.
 */
export function chunkForDiscord(text, maxLen = DISCORD_MAX) {
    if (text.length <= maxLen)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        const half = Math.floor(maxLen / 2);
        let splitAt = maxLen;
        const paraBreak = remaining.lastIndexOf("\n\n", maxLen);
        if (paraBreak >= half) {
            splitAt = paraBreak + 2;
        }
        else {
            const lineBreak = remaining.lastIndexOf("\n", maxLen);
            if (lineBreak >= half) {
                splitAt = lineBreak + 1;
            }
            else {
                const wordBreak = remaining.lastIndexOf(" ", maxLen);
                if (wordBreak >= half)
                    splitAt = wordBreak + 1;
            }
        }
        let chunk = remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt);
        let openFenceLang = null;
        for (const line of chunk.split("\n")) {
            const match = line.match(/^```(\S*)\s*$/);
            if (!match)
                continue;
            const lang = match[1];
            if (openFenceLang === null)
                openFenceLang = lang;
            else if (lang === "")
                openFenceLang = null;
        }
        if (openFenceLang !== null) {
            chunk += "\n```";
            remaining = "```" + openFenceLang + "\n" + remaining;
        }
        chunks.push(chunk);
    }
    if (remaining.length > 0)
        chunks.push(remaining);
    return chunks;
}
/**
 * Persists the mapping of Discord session keys (user ID or thread ID) to
 * Codex thread IDs so threads can be resumed after a bot restart.
 */
class SessionStore {
    filePath;
    data = {};
    constructor() {
        this.filePath = path.join(os.homedir(), ".config", "ai-assistant", "sessions.json");
        this.load();
    }
    load() {
        try {
            this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        }
        catch {
            this.data = {};
        }
    }
    get(key) {
        return this.data[key];
    }
    set(key, threadId) {
        if (this.data[key] === threadId)
            return;
        this.data[key] = threadId;
        this.persist();
    }
    delete(key) {
        delete this.data[key];
        this.persist();
    }
    persist() {
        try {
            const dir = path.dirname(this.filePath);
            fs.mkdirSync(dir, { recursive: true });
            const tmp = this.filePath + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            fs.renameSync(tmp, this.filePath);
        }
        catch (err) {
            console.error("[SessionStore] Failed to persist sessions:", err);
        }
    }
}
/**
 * Loads MCP server configs from VS Code-style files for visibility in `/mcp`.
 * Codex itself reads MCP configuration from its own CLI config, so this loader is
 * status-only until the SDK exposes per-thread MCP server injection.
 */
export class McpConfigLoader {
    static GLOBAL_PATH = process.env.MCP_CONFIG_PATH ??
        path.join(os.homedir(), ".config", "Code", "User", "mcp.json");
    static load(workingDir) {
        const global = this.readFile(this.GLOBAL_PATH, "mcpServers");
        const workspace = workingDir
            ? this.readFile(path.join(workingDir, ".vscode", "mcp.json"), "servers")
            : {};
        return this.resolveAndFilter({ ...global, ...workspace });
    }
    static readFile(filePath, key) {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const servers = parsed[key];
            if (servers && typeof servers === "object" && !Array.isArray(servers)) {
                return servers;
            }
        }
        catch {
            // Missing or malformed config is not fatal.
        }
        return {};
    }
    static resolveAndFilter(raw) {
        const result = {};
        for (const [name, cfg] of Object.entries(raw)) {
            try {
                const resolved = this.resolveInputs(JSON.stringify(cfg));
                if (resolved === null) {
                    console.warn(`[McpConfigLoader] Skipping "${name}": unresolved \${input:...} values`);
                    continue;
                }
                const server = JSON.parse(resolved);
                if (!Array.isArray(server.tools))
                    server.tools = ["*"];
                result[name] = server;
            }
            catch {
                console.warn(`[McpConfigLoader] Skipping "${name}": invalid config`);
            }
        }
        return result;
    }
    static resolveInputs(json) {
        const resolved = json.replace(/\$\{input:([\w-]+)\}/g, (match, id) => {
            const envKey = "MCP_INPUT_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
            return process.env[envKey] ?? match;
        });
        return /\$\{input:[\w-]+\}/.test(resolved) ? null : resolved;
    }
    static status(workingDir) {
        const globalRaw = this.readFile(this.GLOBAL_PATH, "mcpServers");
        const workspaceRaw = workingDir
            ? this.readFile(path.join(workingDir, ".vscode", "mcp.json"), "servers")
            : {};
        const merged = { ...globalRaw, ...workspaceRaw };
        return Object.keys(merged).map((name) => {
            const source = name in workspaceRaw ? "workspace" : "global";
            const resolved = this.resolveInputs(JSON.stringify(merged[name]));
            return { name, source, enabled: resolved !== null };
        });
    }
}
export class SessionManager {
    client;
    sessions = new Map();
    pending = new Map();
    sessionOperationQueues = new Map();
    messageQueues = new Map();
    store = new SessionStore();
    histories = new Map();
    workingDirOverrides = new Map();
    modelOverrides = new Map();
    mcpToolOverrides = new Map();
    constructor() {
        this.client = new Codex({
            ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
        });
    }
    threadOptions(key) {
        const workingDirectory = this.workingDirOverrides.get(key) ?? process.cwd();
        return {
            ...(this.modelOverrides.get(key) ?? process.env.CODEX_MODEL
                ? { model: this.modelOverrides.get(key) ?? process.env.CODEX_MODEL }
                : {}),
            workingDirectory,
            skipGitRepoCheck: true,
            approvalPolicy: "never",
            sandboxMode: "danger-full-access",
            networkAccessEnabled: true,
        };
    }
    async getOrCreateSession(key) {
        const existing = this.sessions.get(key);
        if (existing)
            return existing;
        const inFlight = this.pending.get(key);
        if (inFlight)
            return inFlight;
        const storedThreadId = this.store.get(key);
        const creation = Promise.resolve(storedThreadId
            ? this.client.resumeThread(storedThreadId, this.threadOptions(key))
            : this.client.startThread(this.threadOptions(key)))
            .then((thread) => {
            if (this.pending.get(key) !== creation)
                return thread;
            this.sessions.set(key, thread);
            this.pending.delete(key);
            if (thread.id)
                this.store.set(key, thread.id);
            return thread;
        })
            .catch((err) => {
            if (this.pending.get(key) === creation)
                this.pending.delete(key);
            if (!storedThreadId)
                throw err;
            console.warn(`[SessionManager] Resume failed for ${key} (${storedThreadId}), starting a new Codex thread:`, err);
            this.store.delete(key);
            const fresh = this.client.startThread(this.threadOptions(key));
            this.sessions.set(key, fresh);
            return fresh;
        });
        this.pending.set(key, creation);
        return creation;
    }
    evictCachedSession(key, thread) {
        if (this.sessions.get(key) === thread)
            this.sessions.delete(key);
    }
    async withLiveSession(key, operation) {
        return this.enqueueSessionOperation(key, async () => {
            const thread = await this.getOrCreateSession(key);
            return this.runWithSessionRecovery(key, thread, operation);
        });
    }
    async withExistingLiveSession(key, operation) {
        return this.enqueueSessionOperation(key, async () => {
            const thread = this.sessions.get(key);
            if (!thread)
                return null;
            return this.runWithSessionRecovery(key, thread, operation);
        });
    }
    enqueueSessionOperation(key, operation) {
        const tail = this.sessionOperationQueues.get(key) ?? Promise.resolve();
        const next = tail.catch(() => { }).then(operation);
        const queueTail = next.catch(() => { });
        this.sessionOperationQueues.set(key, queueTail);
        queueTail.finally(() => {
            if (this.sessionOperationQueues.get(key) === queueTail) {
                this.sessionOperationQueues.delete(key);
            }
        });
        return next;
    }
    async runWithSessionRecovery(key, thread, operation) {
        try {
            return await operation(thread);
        }
        catch (err) {
            if (!isThreadNotFoundError(err))
                throw err;
            console.warn(`[SessionManager] Cached Codex thread for ${key} was not found; starting a new thread.`);
            this.evictCachedSession(key, thread);
            this.store.delete(key);
            const fresh = await this.getOrCreateSession(key);
            return operation(fresh);
        }
    }
    async sendMessage(userId, prompt, imagePaths) {
        const tail = this.messageQueues.get(userId) ?? Promise.resolve();
        const next = tail.then(async () => {
            const input = imagePaths && imagePaths.length > 0
                ? [
                    { type: "text", text: prompt },
                    ...imagePaths.map((a) => ({ type: "local_image", path: a.path })),
                ]
                : prompt;
            this.appendHistory(userId, { type: "user.message", data: { content: prompt } });
            const timeoutMs = parseInt(process.env.CODEX_TIMEOUT_MS ?? "", 10) || 10 * 60 * 1000;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            const result = await this.withLiveSession(userId, (thread) => thread.run(input, { signal: controller.signal })).finally(() => clearTimeout(timeout));
            if (result && this.sessions.get(userId)?.id) {
                this.store.set(userId, this.sessions.get(userId).id);
            }
            const response = result.finalResponse || this.extractFinalResponse(result.items) || "(no response)";
            this.appendHistory(userId, { type: "assistant.message", data: { content: response } });
            return response;
        });
        this.messageQueues.set(userId, next.catch(() => { }));
        return next;
    }
    appendHistory(key, event) {
        const history = this.histories.get(key) ?? [];
        history.push(event);
        this.histories.set(key, history.slice(-100));
    }
    extractFinalResponse(items) {
        const agentMessages = items
            .filter((item) => item.type === "agent_message")
            .map((item) => item.text)
            .filter(Boolean);
        return agentMessages.at(-1) ?? null;
    }
    async getStatus() {
        let version = "unknown";
        try {
            const pkg = require("@openai/codex/package.json");
            version = pkg.version ? `@openai/codex ${pkg.version}` : version;
        }
        catch (err) {
            console.warn("[SessionManager] Failed to read Codex package version:", err);
        }
        return {
            status: { version },
            authStatus: {
                isAuthenticated: Boolean(process.env.OPENAI_API_KEY),
                login: process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : undefined,
                authType: process.env.OPENAI_API_KEY ? "api-key" : "Codex CLI login or OPENAI_API_KEY",
                host: process.env.OPENAI_BASE_URL ?? "api.openai.com",
                statusMessage: process.env.OPENAI_API_KEY
                    ? undefined
                    : "Codex may still use an existing CLI login; no OPENAI_API_KEY is set in this process.",
            },
        };
    }
    async getHistory(userId) {
        return this.withExistingLiveSession(userId, async () => this.histories.get(userId) ?? []);
    }
    async listModels() {
        const modelsById = new Map();
        for (const model of this.readCachedCodexModels()) {
            modelsById.set(model.id, model);
        }
        const configured = [process.env.CODEX_MODEL, ...this.modelOverrides.values()].filter((model) => Boolean(model));
        for (const id of configured) {
            if (!modelsById.has(id))
                modelsById.set(id, { id, name: id });
        }
        return Array.from(modelsById.values());
    }
    readCachedCodexModels() {
        const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
        const cachePath = path.join(codexHome, "models_cache.json");
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        }
        catch {
            return [];
        }
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) {
            return [];
        }
        const models = parsed.models
            .filter((model) => typeof model.slug === "string")
            .filter((model) => model.visibility !== "hide")
            .sort((a, b) => {
            const aPriority = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
            const bPriority = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
            return aPriority - bPriority;
        });
        return models.map((model) => {
            const id = model.slug;
            return {
                id,
                name: typeof model.display_name === "string" ? model.display_name : id,
            };
        });
    }
    async setModel(userId, model) {
        this.modelOverrides.set(userId, model);
        this.sessions.delete(userId);
    }
    async getCurrentModel(key) {
        return this.modelOverrides.get(key) ?? process.env.CODEX_MODEL;
    }
    async listAgents(..._args) {
        unsupported("Agent listing");
    }
    async getCurrentAgent(..._args) {
        unsupported("Agent selection");
    }
    async selectAgent(..._args) {
        unsupported("Agent selection");
    }
    async deselectAgent(..._args) {
        unsupported("Agent selection");
    }
    async getMode(..._args) {
        unsupported("Mode switching");
    }
    async setMode(..._args) {
        unsupported("Mode switching");
    }
    async compact(..._args) {
        unsupported("History compaction");
    }
    async startFleet(..._args) {
        unsupported("Fleet mode");
    }
    async readPlan(..._args) {
        unsupported("Plan management");
    }
    async updatePlan(..._args) {
        unsupported("Plan management");
    }
    async deletePlan(..._args) {
        unsupported("Plan management");
    }
    async listWorkspaceFiles(..._args) {
        unsupported("Workspace file listing");
    }
    async readWorkspaceFile(..._args) {
        unsupported("Workspace file reading");
    }
    async createWorkspaceFile(..._args) {
        unsupported("Workspace file creation");
    }
    async resetSession(key) {
        this.sessions.delete(key);
        this.pending.delete(key);
        this.sessionOperationQueues.delete(key);
        this.messageQueues.delete(key);
        this.histories.delete(key);
        this.store.delete(key);
    }
    setSessionWorkingDir(key, dir) {
        if (!dir || dir.includes("\0")) {
            throw new Error("Invalid workspace path.");
        }
        let canonical;
        try {
            canonical = fs.realpathSync.native(path.resolve(dir));
        }
        catch {
            throw new Error(`Workspace path does not exist: ${path.resolve(dir)}`);
        }
        if (!fs.statSync(canonical).isDirectory()) {
            throw new Error(`Workspace path is not a directory: ${canonical}`);
        }
        this.workingDirOverrides.set(key, canonical);
        this.sessions.delete(key);
    }
    getSessionWorkingDir(key) {
        return this.workingDirOverrides.get(key);
    }
    setSessionMcpEnabled(key, serverName, enabled) {
        const overrides = this.mcpToolOverrides.get(key) ?? {};
        overrides[serverName] = enabled ? ["*"] : [];
        this.mcpToolOverrides.set(key, overrides);
    }
    getMcpStatus(key) {
        const workingDir = this.workingDirOverrides.get(key);
        const overrides = this.mcpToolOverrides.get(key) ?? {};
        const statusList = McpConfigLoader.status(workingDir);
        return statusList.map((s) => {
            const skipped = !s.enabled;
            if (skipped)
                return { ...s, enabled: false, skipped: true };
            if (s.name in overrides)
                return { ...s, enabled: overrides[s.name].length > 0, skipped: false };
            return { ...s, skipped: false };
        });
    }
    async shutdown() {
        this.sessions.clear();
        this.pending.clear();
        this.sessionOperationQueues.clear();
        this.messageQueues.clear();
    }
}
