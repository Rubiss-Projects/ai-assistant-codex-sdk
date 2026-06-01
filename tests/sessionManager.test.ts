import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "../src/codex.js";

type TurnLike = { finalResponse: string; items: unknown[]; usage: null };

type ThreadLike = {
  id: string | null;
  run: (input: unknown, options?: unknown) => Promise<TurnLike>;
};

type StoreLike = {
  get: (key: string) => string | undefined;
  set: (key: string, threadId: string) => void;
  delete: (key: string) => void;
};

type ClientLike = {
  startThread: (config?: unknown) => ThreadLike;
  resumeThread: (threadId: string, config?: unknown) => ThreadLike;
};

type TestableSessionManager = {
  sendMessage: SessionManager["sendMessage"];
  getHistory: SessionManager["getHistory"];
  listModels: SessionManager["listModels"];
  setModel: SessionManager["setModel"];
  getCurrentModel: SessionManager["getCurrentModel"];
  sessions: Map<string, ThreadLike>;
  store: StoreLike;
  client: ClientLike;
};

function createTestManager(storedThreads: Record<string, string> = {}): TestableSessionManager {
  const manager = new SessionManager() as unknown as TestableSessionManager;
  manager.store = {
    get: (key) => storedThreads[key],
    set: (key, threadId) => {
      storedThreads[key] = threadId;
    },
    delete: (key) => {
      delete storedThreads[key];
    },
  };
  return manager;
}

test("sendMessage resumes a stored Codex thread", async () => {
  const storedThreads: Record<string, string> = { "user-1": "stored-thread" };
  const manager = createTestManager(storedThreads);
  let resumeCalls = 0;
  let startCalls = 0;

  const resumedThread: ThreadLike = {
    id: "stored-thread",
    run: async (input, options) => {
      assert.equal(input, "hello");
      assert.ok(options && typeof options === "object" && "signal" in options);
      return { finalResponse: "resume ok", items: [], usage: null };
    },
  };

  manager.client = {
    startThread: () => {
      startCalls += 1;
      throw new Error("should not start");
    },
    resumeThread: (threadId) => {
      resumeCalls += 1;
      assert.equal(threadId, "stored-thread");
      return resumedThread;
    },
  };

  const response = await manager.sendMessage("user-1", "hello");

  assert.equal(response, "resume ok");
  assert.equal(resumeCalls, 1);
  assert.equal(startCalls, 0);
  assert.equal(storedThreads["user-1"], "stored-thread");
  assert.equal(manager.sessions.get("user-1"), resumedThread);
});

test("sendMessage starts a fresh thread when cached thread is missing from Codex", async () => {
  const storedThreads: Record<string, string> = { "user-1": "stale-thread" };
  const manager = createTestManager(storedThreads);
  let staleRunCalls = 0;
  let freshRunCalls = 0;
  let startCalls = 0;

  const staleThread: ThreadLike = {
    id: "stale-thread",
    run: async () => {
      staleRunCalls += 1;
      throw new Error("Thread not found: stale-thread");
    },
  };

  const freshThread: ThreadLike = {
    id: "fresh-thread",
    run: async (input) => {
      freshRunCalls += 1;
      assert.equal(input, "hello");
      return { finalResponse: "retry ok", items: [], usage: null };
    },
  };

  manager.sessions.set("user-1", staleThread);
  manager.client = {
    startThread: () => {
      startCalls += 1;
      return freshThread;
    },
    resumeThread: () => {
      throw new Error("should not resume");
    },
  };

  const response = await manager.sendMessage("user-1", "hello");

  assert.equal(response, "retry ok");
  assert.equal(staleRunCalls, 1);
  assert.equal(freshRunCalls, 1);
  assert.equal(startCalls, 1);
  assert.equal(storedThreads["user-1"], "fresh-thread");
  assert.equal(manager.sessions.get("user-1"), freshThread);
});

test("sendMessage does not evict or retry non-stale-thread errors", async () => {
  const storedThreads: Record<string, string> = { "user-1": "cached-thread" };
  const manager = createTestManager(storedThreads);
  let startCalls = 0;

  const cachedThread: ThreadLike = {
    id: "cached-thread",
    run: async () => {
      throw new Error("rate limited");
    },
  };

  manager.sessions.set("user-1", cachedThread);
  manager.client = {
    startThread: () => {
      startCalls += 1;
      throw new Error("should not start");
    },
    resumeThread: () => {
      throw new Error("should not resume");
    },
  };

  await assert.rejects(() => manager.sendMessage("user-1", "hello"), /rate limited/);

  assert.equal(startCalls, 0);
  assert.equal(storedThreads["user-1"], "cached-thread");
  assert.equal(manager.sessions.get("user-1"), cachedThread);
});

test("getHistory returns null without resuming a stored thread", async () => {
  const storedThreads: Record<string, string> = { "user-1": "stored-thread" };
  const manager = createTestManager(storedThreads);
  let startCalls = 0;
  let resumeCalls = 0;

  manager.client = {
    startThread: () => {
      startCalls += 1;
      throw new Error("should not start");
    },
    resumeThread: () => {
      resumeCalls += 1;
      throw new Error("should not resume");
    },
  };

  const history = await manager.getHistory("user-1");

  assert.equal(history, null);
  assert.equal(startCalls, 0);
  assert.equal(resumeCalls, 0);
  assert.equal(storedThreads["user-1"], "stored-thread");
});

test("setModel records a per-session model and evicts the live thread", async () => {
  const manager = createTestManager();
  const thread: ThreadLike = {
    id: "thread-1",
    run: async () => ({ finalResponse: "ok", items: [], usage: null }),
  };
  manager.sessions.set("user-1", thread);

  await manager.setModel("user-1", "gpt-5.1-codex-max");

  assert.equal(await manager.getCurrentModel("user-1"), "gpt-5.1-codex-max");
  assert.equal(manager.sessions.has("user-1"), false);
});

test("listModels reads the Codex CLI model cache", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexModel = process.env.CODEX_MODEL;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-codex-home-"));
  try {
    process.env.CODEX_HOME = codexHome;
    delete process.env.CODEX_MODEL;
    fs.writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          null,
          "bad-entry",
          42,
          { slug: "hidden-model", display_name: "Hidden Model", visibility: "hide", priority: 1 },
          { slug: "gpt-later", display_name: "GPT Later", visibility: "list", priority: 20 },
          { slug: "gpt-first", display_name: "GPT First", visibility: "list", priority: 10 },
        ],
      })
    );

    const manager = createTestManager();

    assert.deepEqual(await manager.listModels(), [
      { id: "gpt-first", name: "GPT First" },
      { id: "gpt-later", name: "GPT Later" },
    ]);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousCodexModel === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previousCodexModel;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("listModels includes configured model IDs missing from the cache", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexModel = process.env.CODEX_MODEL;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-assistant-codex-home-"));
  try {
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_MODEL = "configured-model";
    fs.writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [{ slug: "cached-model", display_name: "Cached Model", visibility: "list", priority: 1 }],
      })
    );

    const manager = createTestManager();
    await manager.setModel("user-1", "override-model");

    assert.deepEqual(await manager.listModels(), [
      { id: "cached-model", name: "Cached Model" },
      { id: "configured-model", name: "configured-model" },
      { id: "override-model", name: "override-model" },
    ]);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousCodexModel === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previousCodexModel;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
