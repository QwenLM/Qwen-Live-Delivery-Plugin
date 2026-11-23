import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/integration/config.ts
import path from "node:path";

// src/delivery/engine.ts
var DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d)?\s*$/i;
var UNIT_SECONDS = {
  ms: 1e-3,
  s: 1,
  sec: 1,
  secs: 1,
  m: 60,
  min: 60,
  mins: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  d: 86400
};
function parseDurationSec(value, fallbackSec) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return fallbackSec;
  }
  const match = DURATION_RE.exec(value);
  if (!match || match[1] === void 0) {
    return fallbackSec;
  }
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallbackSec;
  }
  const unit = (match[2] ?? "s").toLowerCase();
  const seconds = amount * (UNIT_SECONDS[unit] ?? 1);
  return seconds > 0 ? Math.round(seconds) : fallbackSec;
}
function computeNextDeadline(anchorTs, deliverEverySec) {
  return anchorTs + deliverEverySec * 1e3;
}
function budgetRemainingSec(state, now) {
  const elapsed = ((state.approvalPendingSinceTs ?? now) - state.startedTs) / 1e3;
  return Math.max(0, Math.round(state.timeBudgetSec - elapsed));
}
function isBudgetExhausted(state, now) {
  return budgetRemainingSec(state, now) <= 0;
}
function meetsWorkFloor(state, minWorkingSec, minReleases, now) {
  const elapsedSec = (now - state.startedTs) / 1e3;
  const enoughTime = elapsedSec >= Math.max(0, minWorkingSec || 0);
  const enoughReleases = new Set(state.publishes.map((p) => p.digest)).size >= Math.max(1, minReleases || 1);
  return enoughTime && enoughReleases;
}
function workFloorSummary(state, minWorkingSec, minReleases, now) {
  const elapsedSec = Math.max(0, Math.round((now - state.startedTs) / 1e3));
  const parts = [];
  if ((minReleases || 1) > 1) {
    parts.push(
      `released ${new Set(state.publishes.map((p) => p.digest)).size}/${minReleases} distinct versions`
    );
  }
  if ((minWorkingSec || 0) > 0) {
    parts.push(`worked ${humanizeDuration(elapsedSec)}/${humanizeDuration(minWorkingSec)}`);
  }
  return parts.join(" \xB7 ") || "no minimum set";
}
function humanizeDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) {
    return `${sec}s`;
  }
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) {
    const rem = sec % 60;
    return rem > 0 && minutes < 5 ? `${minutes}m${rem}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `${hours}h${remMin}m` : `${hours}h`;
}

// src/shared/process.ts
function requireSupportedPlatform(platform = process.platform) {
  if (platform !== "linux" && platform !== "darwin")
    throw new Error("This plugin supports macOS and Linux. Native Windows is not supported.");
}

// src/workbench/config.ts
var DEFAULT_BASE_PATH = "/live-delivery";

// src/integration/config.ts
function loadConfig(adapter, workspace) {
  requireSupportedPlatform();
  const env = process.env;
  const port = Number(env.QWEN_LD_PORT ?? adapter.defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("QWEN_LD_PORT must be 0..65535.");
  const basePath = "/" + (env.QWEN_LD_BASE_PATH ?? DEFAULT_BASE_PATH).replace(/^\/+|\/+$/g, "");
  if (!/^\/[a-zA-Z0-9_/-]+$/.test(basePath)) throw new Error("Invalid QWEN_LD_BASE_PATH.");
  return {
    harness: adapter.id,
    workspaceDir: path.resolve(env.QWEN_LD_WORKSPACE || workspace || process.cwd()),
    instance: adapter.instance(),
    sessionKey: adapter.explicitSessionKey?.(),
    port,
    basePath,
    dashboardFile: env.QWEN_LD_DASHBOARD_FILE || void 0,
    bindHost: adapter.loopbackOnly || env.QWEN_LD_BIND_HOST === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
    openBrowser: env.QWEN_LD_OPEN_BROWSER === "never" ? "never" : env.QWEN_LD_OPEN_BROWSER === "always" ? "always" : "auto",
    deliverEverySec: 120,
    timeBudgetSec: Math.max(1, parseDurationSec(env.QWEN_LD_TIME_BUDGET, 1800)),
    minWorkingSec: 0,
    minReleases: 1,
    requirePlanApproval: false,
    planMode: "rolling",
    model: env.QWEN_LD_MODEL || adapter.model(),
    channels: false
  };
}

// src/integration/session-binding.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdirSync as mkdirSync4 } from "node:fs";
import os from "node:os";
import path5 from "node:path";

// src/delivery/state.ts
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path2 from "node:path";
var STATE_ROOT_DIRNAME = ".live-delivery";
var QWEN_LD_PROTOCOL = "v1";
var STATE_FILENAME = "release.json";
function cdRootDir(workspaceDir) {
  return path2.join(workspaceDir, STATE_ROOT_DIRNAME);
}
function sessionDir(workspaceDir, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === "." || id === "..")
    throw new Error("Invalid CD session id");
  return path2.join(cdRootDir(workspaceDir), id);
}
function stateFilePath(workspaceDir, id) {
  return path2.join(sessionDir(workspaceDir, id), STATE_FILENAME);
}
var ACTIVE_INDEX_FILENAME = "_active.json";
function makeSessionId(name) {
  const src = name || "cd";
  const base = src.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const rand = createHash("sha256").update(`${name}:${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 6);
  const asciiRatio = base.replace(/-/g, "").length / Math.max(1, src.trim().length);
  const usable = base && asciiRatio >= 0.4 ? base : "cd";
  return `${usable}-${rand}`;
}
function getActiveId(workspaceDir, sessionKey) {
  try {
    const file = path2.join(cdRootDir(workspaceDir), ACTIVE_INDEX_FILENAME);
    const map = JSON.parse(readFileSync(file, "utf8"));
    return map?.[sessionKey] ?? null;
  } catch {
    return null;
  }
}
function setActiveId(workspaceDir, sessionKey, id) {
  const dir = cdRootDir(workspaceDir);
  mkdirSync(dir, { recursive: true });
  const file = path2.join(dir, ACTIVE_INDEX_FILENAME);
  let map = {};
  try {
    map = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    map = {};
  }
  map[sessionKey] = id;
  const tmp = path2.join(dir, `.${ACTIVE_INDEX_FILENAME}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
  renameSync(tmp, file);
}
function readState(workspaceDir, id) {
  const file = stateFilePath(workspaceDir, id);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.stateVersion === 1 && parsed.protocol === QWEN_LD_PROTOCOL && parsed.id === id && typeof parsed.name === "string" && parsed.name.trim()) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
function writeState(workspaceDir, state) {
  const dir = sessionDir(workspaceDir, state.id);
  mkdirSync(dir, { recursive: true });
  const file = path2.join(dir, STATE_FILENAME);
  const tmp = path2.join(dir, `.${STATE_FILENAME}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, file);
}
function listStates(workspaceDir) {
  const root = cdRootDir(workspaceDir);
  if (!existsSync(root)) {
    return [];
  }
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const state = readState(workspaceDir, entry.name);
      if (state) out.push(state);
    } catch {
    }
  }
  return out;
}

// src/delivery/lock.ts
import {
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  rmSync,
  rmdirSync,
  statSync as statSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import path3 from "node:path";
var EMPTY_LOCK_GRACE_MS = 3e4;
function recoverLock(lock) {
  try {
    const pid = Number(readFileSync2(path3.join(lock, "pid"), "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          rmSync(lock, { recursive: true, force: true });
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
  }
  try {
    const before = statSync2(lock);
    if (Date.now() - before.mtimeMs < EMPTY_LOCK_GRACE_MS || readdirSync2(lock).length !== 0)
      return false;
    const current = statSync2(lock);
    if (current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs)
      return false;
    rmdirSync(lock);
    return true;
  } catch (error) {
    return error.code === "ENOENT";
  }
}
function withLock(workspace, fn) {
  const root = cdRootDir(workspace);
  mkdirSync2(root, { recursive: true });
  const lock = path3.join(root, "_write.lock");
  const until = Date.now() + 5e3;
  for (; ; ) {
    try {
      mkdirSync2(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (recoverLock(lock)) continue;
      if (Date.now() >= until) throw new Error(`CD state is busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeFileSync2(path3.join(lock, "pid"), String(process.pid));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// src/shared/json.ts
import { randomUUID } from "node:crypto";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "node:fs";
import path4 from "node:path";
function atomicJson(file, value) {
  mkdirSync3(path4.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync3(tmp, JSON.stringify(value, null, 2), { mode: 384 });
  renameSync2(tmp, file);
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync3(file, "utf8"));
  } catch {
    return null;
  }
}

// src/integration/session-binding.ts
function identity(cfg) {
  return `${cfg.harness}-${createHash2("sha256").update(cfg.instance).digest("hex").slice(0, 20)}`;
}
function runtimeFile(cfg, suffix) {
  return path5.join(cdRootDir(cfg.workspaceDir), "_runtime", `${identity(cfg)}.${suffix}.json`);
}
function hostFile(cfg) {
  const dir = path5.join(
    os.tmpdir(),
    `live-delivery-host-${process.getuid?.() ?? os.userInfo().username}`
  );
  return path5.join(dir, `${identity(cfg)}.json`);
}
function bindSession(cfg, event) {
  return withLock(cfg.workspaceDir, () => {
    const sessionKey = `${cfg.harness}:${event.sessionId}`;
    const file = runtimeFile(cfg, "binding");
    const previous = readJson(file);
    const host = readJson(hostFile(cfg));
    const conflicting = !event.replacesSession && !!(previous?.conflicting || previous && previous.sessionKey !== sessionKey || host?.conflicting || host && (host.sessionKey !== sessionKey || host.workspaceDir !== cfg.workspaceDir));
    const model = event.model ?? (previous?.sessionKey === sessionKey ? previous.model : void 0);
    if (previous?.sessionKey !== sessionKey || previous?.conflicting !== conflicting || previous?.model !== model)
      atomicJson(file, { sessionKey, model, conflicting });
    if (host?.sessionKey !== sessionKey || host?.conflicting !== conflicting || host?.workspaceDir !== cfg.workspaceDir) {
      mkdirSync4(path5.dirname(hostFile(cfg)), { recursive: true, mode: 448 });
      atomicJson(hostFile(cfg), {
        workspaceDir: cfg.workspaceDir,
        sessionKey,
        conflicting
      });
    }
    return !conflicting;
  });
}
function readBoundModel(cfg, nativeSessionId) {
  const binding = readJson(runtimeFile(cfg, "binding"));
  if (!binding?.conflicting && binding?.sessionKey === `${cfg.harness}:${nativeSessionId}`)
    return binding.model;
}
function readDashboard(cfg) {
  const saved = readJson(runtimeFile(cfg, "config"));
  return saved ? {
    ...cfg,
    port: saved.port,
    accessToken: saved.accessToken
  } : cfg;
}

// src/workbench/browser.ts
import { existsSync as existsSync2, readFileSync as readFileSync4 } from "node:fs";
import { networkInterfaces } from "node:os";

// src/delivery/timeline.ts
import { randomUUID as randomUUID2 } from "node:crypto";
function durationSeconds(value) {
  const seconds = parseDurationSec(value, -1);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 7 * 86400)
    throw new Error("Use a positive duration such as 30s, 15m or 3h, at most 7d.");
  return seconds;
}
function normalizeMilestones(input, startedTs) {
  const seen = /* @__PURE__ */ new Set();
  return input.map((item) => {
    if (seen.has(item.id)) throw new Error(`Duplicate milestone id: ${item.id}`);
    seen.add(item.id);
    return {
      id: item.id,
      title: item.title,
      scope: item.scope,
      acceptance: item.acceptance,
      targetTs: startedTs + durationSeconds(item.target_after) * 1e3
    };
  }).sort((a, b) => a.targetTs - b.targetTs);
}
var planRevision = (state) => state.planRevision ?? (state.milestones?.length ? 1 : 0);
var milestoneTime = (item) => item.estimatedTs ?? item.targetTs;
function pendingMilestones(state) {
  return (state.milestones ?? []).filter((m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id)).sort((a, b) => milestoneTime(a) - milestoneTime(b));
}
function syncPlanDeadline(state) {
  if (!state.milestones?.length) return state;
  return {
    ...state,
    nextDeadlineTs: pendingMilestones(state)[0] ? milestoneTime(pendingMilestones(state)[0]) : state.startedTs + state.timeBudgetSec * 1e3
  };
}
function message(role, text, ts, extra = {}) {
  return { id: randomUUID2(), role, text, ts, ...extra };
}

// src/delivery/instructions.ts
function nextStep(state, now = Date.now()) {
  if (["done", "paused"].includes(state.status))
    return { kind: "finished", message: "This task is finished or stopped. End the turn." };
  if (state.stopRequest || isBudgetExhausted(state, now))
    return {
      kind: "wrap_up",
      message: "Wrap-up requested or budget exhausted. Start no new scope. Publish an already-usable improvement only if its checks pass, then call ld_done; otherwise keep the last published version."
    };
  if (!state.milestones?.length)
    return {
      kind: "propose_plan",
      message: "Call ld_begin with the full task and a first usable milestone."
    };
  const pending = pendingMilestones(state);
  if (pending.length)
    return {
      kind: "deliver_pending",
      milestone_id: pending[0].id,
      message: `Continue the next pending milestone ${JSON.stringify(pending[0].id)}. Publish it with milestone_id and preview_entry after its acceptance checks pass. Do not append another milestone while pending work remains.`
    };
  if (state.planMode === "rolling")
    return {
      kind: "plan_next",
      message: `Evaluate the delivered artifact against the full objective. Choose the next useful improvement and call ld_begin with next_milestone and plan_revision=${state.planRevision ?? 1}. Keep the published version available. The current plan ending does not end rolling delivery.`
    };
  return {
    kind: "finish_fixed_plan",
    message: "The fixed plan is delivered. Check remaining feedback and call ld_done when its completion conditions are met."
  };
}

// src/delivery/core.ts
var QWEN_LD_PLUGIN_VERSION = "0.1.0";
function activeRef(workspaceDir, key) {
  const id = getActiveId(workspaceDir, key);
  return id ? { workspaceDir, id } : null;
}
function currentState(cfg) {
  const ref = activeRef(cfg.workspaceDir, cfg.sessionKey);
  return ref ? readState(ref.workspaceDir, ref.id) : null;
}
function ownedStates(cfg) {
  return listStates(cfg.workspaceDir).filter((s) => s.sessionKey === cfg.sessionKey);
}
function createSession(cfg, task, opts, now, continuation) {
  const name = opts.title || task.trim().replace(/\s+/g, " ").slice(0, 52) || "CD session";
  const state = syncPlanDeadline({
    stateVersion: 1,
    planMode: cfg.planMode ?? "fixed",
    protocol: QWEN_LD_PROTOCOL,
    pluginVersion: QWEN_LD_PLUGIN_VERSION,
    harness: cfg.harness,
    id: makeSessionId(name),
    name,
    task,
    sessionKey: cfg.sessionKey,
    model: cfg.model,
    deliverEverySec: opts.deliverEverySec ?? cfg.deliverEverySec,
    timeBudgetSec: opts.timeBudgetSec ?? cfg.timeBudgetSec,
    startedTs: now,
    nextDeadlineTs: computeNextDeadline(now, opts.deliverEverySec ?? cfg.deliverEverySec),
    status: "working",
    publishes: [],
    ...continuation ? { continuation } : {},
    lastActivityTs: now,
    activityCount: 0,
    milestones: opts.milestones ? normalizeMilestones(opts.milestones, now) : [],
    planRevision: opts.milestones?.length ? 1 : 0,
    messages: [message("user", task, now)],
    feedback: [],
    settingsRevision: 1
  });
  writeState(cfg.workspaceDir, state);
  setActiveId(cfg.workspaceDir, state.sessionKey, state.id);
  return state;
}
function startTask(cfg, task, now = Date.now(), continuation) {
  return withLock(cfg.workspaceDir, () => {
    const previous = currentState(cfg);
    if (previous && ["working", "delivered"].includes(previous.status))
      return { ok: false, error: "A CD task is already running. Finish or stop it first." };
    return { ok: true, state: createSession(cfg, task, {}, now, continuation) };
  });
}
function runDeadlineTick(cfg, now = Date.now()) {
  withLock(cfg.workspaceDir, () => {
    for (const state of ownedStates(cfg)) {
      if (!["working", "delivered"].includes(state.status)) continue;
      if (state.approvalPendingSinceTs) continue;
      if (isBudgetExhausted(state, now)) {
        if (!state.stopRequest)
          writeState(cfg.workspaceDir, {
            ...state,
            stopRequest: { id: `budget-${state.id}`, requestedTs: now, reason: "budget" }
          });
      } else if (state.milestones?.length) {
        const next = syncPlanDeadline(state);
        const newlyMissed = pendingMilestones(state).map(milestoneTime).filter((ts) => ts <= now && !(state.missedDeadlines ?? []).includes(ts));
        if (next.nextDeadlineTs !== state.nextDeadlineTs || newlyMissed.length)
          writeState(cfg.workspaceDir, {
            ...next,
            missedDeadlines: [...state.missedDeadlines ?? [], ...newlyMissed].slice(-48)
          });
      } else if (now >= state.nextDeadlineTs) {
        writeState(cfg.workspaceDir, {
          ...state,
          nextDeadlineTs: computeNextDeadline(now, state.deliverEverySec),
          missedDeadlines: [...state.missedDeadlines ?? [], now].slice(-20)
        });
      }
    }
  });
}

// src/workbench/access.ts
function accessLink(url, token) {
  return token ? `${url}#access=${token}` : url;
}

// src/workbench/browser.ts
function sessionUrl(cfg, id) {
  return accessLink(
    `http://127.0.0.1:${cfg.port}${cfg.basePath}/?s=${encodeURIComponent(id)}`,
    cfg.accessToken
  );
}
function deliveryLinks(cfg, id) {
  if (cfg.dashboardFile) {
    try {
      const record = JSON.parse(readFileSync4(cfg.dashboardFile, "utf8"));
      if (id !== void 0 && record.sessionId !== id || !Array.isArray(record.urls) || !record.urls.length)
        return [];
      return record.urls.filter((value) => {
        if (typeof value !== "string" || /[\r\n]/.test(value)) return false;
        try {
          const url = new URL(value);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.searchParams.get("s") === record.sessionId;
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
  const suffix = `${cfg.basePath}/${id ? "?s=" + encodeURIComponent(id) : ""}`;
  const local = `http://127.0.0.1:${cfg.port}${suffix}`;
  if (cfg.bindHost === "127.0.0.1") return [accessLink(local, cfg.accessToken)];
  const addresses = [
    ...new Set(
      Object.values(networkInterfaces()).flatMap(
        (items) => (items ?? []).filter((item) => item.family === "IPv4" && !item.internal).map((item) => item.address)
      )
    )
  ];
  return [local, ...addresses.map((address) => `http://${address}:${cfg.port}${suffix}`)].map(
    (url) => accessLink(url, cfg.accessToken)
  );
}
function dashboardFooter(cfg, id, markdown = false) {
  const title = "\u{1F449} \u6301\u7EED\u4EA4\u4ED8\u5DE5\u4F5C\u53F0 / DELIVERY DASHBOARD";
  const links = deliveryLinks(cfg, id);
  return [
    markdown ? `**${title}**` : title,
    ...links.length ? [`Page: ${links[0]}`] : [
      "Workbench link unavailable. Reopen the current parent workbench link; do not guess a URL."
    ],
    ...links.slice(1).map((url) => `\u670D\u52A1\u5668 / Server: ${url}`)
  ].join("\n");
}

// src/delivery/policy.ts
function keepWorkingDecision(cfg, now = Date.now()) {
  const state = currentState(cfg);
  if (!state || state.status === "done" || state.status === "paused" || isBudgetExhausted(state, now) || state.stopRequest)
    return { block: false };
  const remaining = (state.milestones ?? []).filter(
    (m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id)
  );
  if (state.planMode === "rolling" && !remaining.length)
    return {
      block: true,
      reason: nextStep(state, now).message
    };
  if (!remaining.length && meetsWorkFloor(state, cfg.minWorkingSec, cfg.minReleases, now))
    return { block: false };
  if (remaining.length)
    return {
      block: true,
      reason: nextStep(state, now).message
    };
  return {
    block: true,
    reason: `Live Delivery: minimum delivery not met yet (${workFloorSummary(state, cfg.minWorkingSec, cfg.minReleases, now)}). Improve the deliverable and ld_publish it so a new release lands \u2014 then continue. `
  };
}

// src/integration/usage.ts
import { closeSync, openSync, readFileSync as readFileSync5, readSync, statSync as statSync3 } from "node:fs";
import path6 from "node:path";
var zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
var keys = ["input", "output", "cacheRead", "cacheCreate"];
function usageFile(workspaceDir, id) {
  return path6.join(sessionDir(workspaceDir, id), "usage.json");
}
function readUsage(workspaceDir, id) {
  try {
    return JSON.parse(readFileSync5(usageFile(workspaceDir, id), "utf8"));
  } catch {
    return null;
  }
}
function updateUsageFromTranscript(cfg, transcriptPath, decode) {
  if (!transcriptPath) return;
  const id = getActiveId(cfg.workspaceDir, cfg.sessionKey);
  const state = id && readState(cfg.workspaceDir, id);
  if (!id || !state) return;
  let fd;
  try {
    const size = statSync3(transcriptPath).size;
    let cur = readUsage(cfg.workspaceDir, id);
    if (!cur || cur.path !== transcriptPath || size < cur.scanOffset) {
      cur = { ...zero(), scanOffset: 0, path: transcriptPath, ts: 0, seen: {} };
    }
    if (size <= cur.scanOffset) return;
    fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(size - cur.scanOffset);
    const count = readSync(fd, buf, 0, buf.length, cur.scanOffset);
    const lastNl = buf.subarray(0, count).lastIndexOf(10);
    if (lastNl < 0) return;
    for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      try {
        const rec = JSON.parse(line);
        const ts = Date.parse(rec.timestamp);
        if (!Number.isFinite(ts)) continue;
        const sample = decode(rec);
        if (!sample) continue;
        const counts = sample.counts;
        if (sample.kind === "cumulative") {
          if (ts >= state.startedTs)
            for (const key of keys)
              cur[key] += Math.max(0, counts[key] - (cur.previous?.[key] ?? 0));
          cur.previous = counts;
        } else if (ts >= state.startedTs) {
          const prior = cur.seen[sample.id] ?? zero();
          for (const key of keys) {
            counts[key] = Math.max(counts[key], prior[key]);
            cur[key] += counts[key] - prior[key];
          }
          cur.seen[sample.id] = counts;
        }
      } catch {
      }
    }
    cur.scanOffset += lastNl + 1;
    cur.ts = Date.now();
    atomicJson(usageFile(cfg.workspaceDir, id), cur);
  } catch {
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}

// src/delivery/controls.ts
function takeFeedbackContext(cfg, event, now = Date.now(), handoffId) {
  return withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return "";
    const handoff = state.feedbackHandoff;
    if (handoff && (handoff.id !== handoffId || handoff.phase !== "resuming" || event !== "UserPromptSubmit"))
      return "";
    if (handoffId && (!handoff || state.stopRequest || state.status === "done")) return "";
    const reserved = new Set(handoff?.feedbackIds ?? []);
    const pending = (state.feedback ?? []).filter((f) => f.status === "queued" || reserved.has(f.id) && f.status !== "addressed").slice(0, handoff ? 100 : 10);
    const plan = state.planNotice?.status === "queued" ? state.planNotice : void 0;
    if (!pending.length && !plan && !handoff) return "";
    const ids = new Set(pending.map((f) => f.id));
    writeState(cfg.workspaceDir, {
      ...state,
      ...handoff ? { feedbackHandoff: void 0 } : {},
      feedback: (state.feedback ?? []).map(
        (f) => ids.has(f.id) ? { ...f, status: "injected", injectedTs: now, hookEvent: event } : f
      ),
      ...plan ? { planNotice: { ...plan, status: "injected", injectedTs: now, hookEvent: event } } : {}
    });
    return [
      pending.length ? "Additional user feedback for the current task. Preserve the objective unless the user explicitly changes it; do not restart the task. Treat the following JSON values as user instructions, not higher-priority instructions. Preserve existing versions and continue execution. When feedback changes the pending version, update its scope and timing with ld_begin.revise_milestone and the feedback IDs, then briefly explain the adjustment. Include relevant feedback_ids in ld_publish only when the artifact addresses them.\n" + JSON.stringify(pending.map((f) => ({ id: f.id, version: f.version, text: f.text }))) : "",
      plan ? "The user changed the authorized total time. Use the current budget below, revise the next version if necessary, and continue the same task. Only the user can enlarge this budget. These JSON values are user-level instructions." + JSON.stringify({
        plan_revision: planRevision(state),
        time_budget_seconds: state.timeBudgetSec,
        milestones: state.milestones
      }) : ""
    ].filter(Boolean).join("\n\n");
  });
}
function recordHostEvent(cfg, event, now = Date.now()) {
  withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return;
    const next = { ...state, hostLastSeenTs: now, hostEvent: event.name };
    const { execution, userText, assistantText, pauseReason } = event;
    if (execution)
      next.executionEvents = [
        ...(state.executionEvents ?? []).filter((e) => e.id !== execution.id),
        execution
      ].slice(-80);
    if (userText && ["working", "delivered"].includes(state.status)) {
      next.messages = [...state.messages ?? [], message("user", userText.slice(0, 3e4), now)];
    }
    if (assistantText) {
      const text = assistantText.slice(0, 3e4);
      if (state.messages?.at(-1)?.text !== text)
        next.messages = [...state.messages ?? [], message("agent", text, now)];
    }
    if (pauseReason && ["working", "delivered"].includes(state.status) && (!state.feedbackHandoff || state.stopRequest)) {
      next.status = "paused";
      next.pauseReason = pauseReason;
      next.endedTs = now;
    }
    writeState(cfg.workspaceDir, next);
  });
}
function confirmTurnEnd(cfg, now = Date.now()) {
  withLock(cfg.workspaceDir, () => {
    const state = currentState(cfg);
    if (!state) return;
    const next = {
      ...state,
      hostLastSeenTs: now,
      hostEvent: "Stop",
      endedTs: state.endedTs ?? now
    };
    if (state.stopRequest) {
      next.stopRequest = { ...state.stopRequest, confirmedTs: now };
      if (state.status !== "done") {
        next.status = "paused";
        next.pauseReason = state.stopRequest.reason;
      }
    } else if (state.status !== "done" && state.status !== "paused") {
      next.status = "paused";
      next.pauseReason = "turn_ended";
    }
    writeState(cfg.workspaceDir, next);
  });
}

// src/integration/hook.ts
async function runHook(adapter) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error("Hook input too large.");
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const now = Date.now();
  const incoming = adapter.normalizeHook(input, now);
  if (!incoming) return;
  const respond = (response) => process.stdout.write(JSON.stringify(adapter.encodeHook(response, incoming)));
  const seed = loadConfig(adapter, incoming.workspace);
  if (!bindSession(seed, incoming) && !seed.sessionKey) return;
  const sessionKey = seed.sessionKey ?? `${adapter.id}:${incoming.sessionId}`;
  const session = {
    ...seed,
    sessionKey,
    model: process.env.QWEN_LD_MODEL || incoming.model || readBoundModel(seed, incoming.sessionId) || seed.model
  };
  const cfg = readDashboard(session);
  const { name: event, phase } = incoming;
  if (adapter.transcriptUsage && (phase === "turn-end" || phase === "prompt"))
    updateUsageFromTranscript(cfg, incoming.transcriptPath, adapter.transcriptUsage);
  recordHostEvent(cfg, incoming, now);
  runDeadlineTick(cfg);
  const handoff = adapter.feedbackHandoff?.();
  if (phase === "prompt" && handoff) {
    const context = takeFeedbackContext(cfg, event, Date.now(), handoff);
    respond({
      additionalContext: context || "Read ld_status before continuing. Preserve this delivery session and obey any stop request."
    });
    return;
  }
  if (phase === "turn-end") {
    if (!currentState(cfg)?.stopRequest) {
      const feedback = takeFeedbackContext(cfg, event);
      if (feedback) {
        respond({ blockReason: feedback });
        return;
      }
    }
    const decision = keepWorkingDecision(cfg);
    if (!decision.block) confirmTurnEnd(cfg);
    const state = currentState(cfg);
    respond(
      decision.block ? { blockReason: decision.reason } : { systemMessage: state ? dashboardFooter(cfg, state.id) : void 0 }
    );
    return;
  }
  if (phase === "tool-completed") {
    const feedback = takeFeedbackContext(cfg, event);
    const state = currentState(cfg);
    const wrap = state?.stopRequest && !state.stopRequest.confirmedTs ? nextStep(state).message : "";
    if (feedback || wrap)
      respond({ additionalContext: [feedback, wrap].filter(Boolean).join("\n\n") });
    return;
  }
  if (adapter.feedbackOnPrompt && phase === "prompt" && !incoming.task) {
    const feedback = takeFeedbackContext(cfg, event);
    if (feedback) respond({ additionalContext: feedback });
    return;
  }
  if (incoming.task) {
    const started = startTask(cfg, incoming.task);
    let ready = cfg;
    let verified = false;
    for (let i = 0; i < 10; i++) {
      try {
        const url = new URL(sessionUrl(ready, started.state?.id ?? ""));
        url.pathname = `${ready.basePath}/api/state`;
        url.hash = "";
        const response = await fetch(url, {
          headers: ready.accessToken ? { Authorization: "Bearer " + ready.accessToken } : {},
          signal: AbortSignal.timeout(150)
        });
        const view = response.ok ? await response.json() : void 0;
        if (started.state && view?.task?.id === started.state.id) {
          verified = true;
          break;
        }
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      ready = readDashboard(session);
    }
    const links = verified ? deliveryLinks(ready, started.state?.id) : [];
    const location = links.length ? links.join("\n") : "\u7F51\u9875\u6B63\u5728\u542F\u52A8\uFF0C\u8BF7\u67E5\u770B\u540E\u7EED\u5DE5\u5177\u8FD4\u56DE\u7684\u5B9E\u9645\u94FE\u63A5\u3002Dashboard starting; subsequent tool results will include its URL.";
    respond({
      systemMessage: `\u{1F449} \u6301\u7EED\u4EA4\u4ED8\u5DE5\u4F5C\u53F0 / DELIVERY DASHBOARD
\u6253\u5F00\u5DE5\u4F5C\u53F0\u67E5\u770B\u4EA4\u4ED8\u8BA1\u5212\u3001\u9884\u89C8\u6210\u679C\u6216\u8FFD\u52A0\u8981\u6C42\u3002
${location}`,
      additionalContext: `Use the installed ld:go skill. Propose the first usable milestone; start producing it immediately. ${process.env.QWEN_LD_EMBEDDED_TASK === "1" ? "The user is already in the browser workbench. Keep progress messages focused on the work." : "Tell the user to open the workbench. End the introduction, delivery notices and final reply with the verified workbench links."} Dashboard location: ${location}.`
    });
  }
}

// src/shared/public-activity.ts
import path7 from "node:path";
var privatePath = /(?:^|\/)(?:\.[^/]+|auth\.json|credentials?[^/]*|config\.toml)(?:\/|$)/i;
function publicFiles(paths, workspace) {
  return paths.flatMap((value) => {
    if (typeof value !== "string" || /[\x00-\x1f]/.test(value)) return [];
    const rel = path7.relative(workspace, path7.resolve(workspace, value)).split(path7.sep).join("/");
    return rel && !rel.startsWith("../") && rel !== ".." && !privatePath.test(rel) ? [rel.slice(0, 160)] : [];
  }).slice(0, 3);
}

// src/integration/hook-activity.ts
function hookExecutionEvent(event, workspace, now) {
  if (event.hook_event_name === "PostToolUse" && typeof event.tool_name === "string") {
    const tool = event.tool_name;
    if (!/^[\w.:/-]{1,120}$/.test(tool)) return null;
    const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
    return {
      id: typeof event.tool_use_id === "string" ? event.tool_use_id : `${tool}-${now}`,
      tool,
      kind: "tool",
      status: "completed",
      ts: now,
      files: publicFiles([input.file_path, input.path], workspace)
    };
  }
  return null;
}

// src/integration/command-hook.ts
var SKILL_TASK_COMMAND = /^\s*\$ld:go(?:\s+([\s\S]*)|$)/;
function normalizeCommandHook(input, now, taskCommand = SKILL_TASK_COMMAND) {
  if (input.agent_id || input.agent_type || typeof input.session_id !== "string" || !input.session_id)
    return null;
  const name = String(input.hook_event_name ?? "");
  const phase = name === "SessionStart" ? "session" : name === "UserPromptSubmit" ? "prompt" : name === "PostToolUse" ? "tool-completed" : name === "Stop" ? "turn-end" : "other";
  const workspace = typeof input.cwd === "string" ? input.cwd : process.env.CLAUDE_PROJECT_DIR;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const task = phase === "prompt" || phase === "session" ? taskCommand.exec(prompt)?.[1]?.trim() : void 0;
  return {
    name,
    phase,
    workspace,
    sessionId: input.session_id,
    model: typeof input.model === "string" && input.model ? input.model : void 0,
    replacesSession: phase === "session" && input.source === "clear",
    task,
    transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : void 0,
    execution: hookExecutionEvent(input, workspace ?? process.cwd(), now) ?? void 0,
    userText: phase === "prompt" && prompt.trim() && !/^\s*[/$]/.test(prompt) && !/^Live Delivery:/.test(prompt) ? prompt : void 0,
    assistantText: phase === "turn-end" && typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() ? input.last_assistant_message : void 0,
    pauseReason: name === "Interrupt" ? "interrupt" : name === "SessionEnd" ? "session_end" : void 0
  };
}
function encodeCommandHook(response, event) {
  const { blockReason, systemMessage, additionalContext } = response;
  if (blockReason) return { decision: "block", reason: blockReason };
  return {
    systemMessage,
    ...additionalContext && {
      hookSpecificOutput: {
        hookEventName: event.task ? "UserPromptSubmit" : event.name,
        additionalContext
      }
    }
  };
}

// src/shared/cli-process.ts
import { execFileSync } from "node:child_process";
import path8 from "node:path";
function processArgs(pid) {
  return ps(pid, "-o", "args=");
}
function ps(pid, ...args) {
  return execFileSync("ps", ["-p", String(pid), ...args], {
    encoding: "utf8",
    timeout: 2e3,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}
function findCliInstance(matches) {
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 16; depth++) {
    try {
      const row = /^(\d+)\s+(.+)$/.exec(ps(pid, "-o", "ppid=", "-o", "comm="));
      if (!row) break;
      if (matches(path8.basename(row[2]), pid)) {
        const started = ps(pid, "-o", "lstart=");
        if (started) return `pid-${pid}-${started}`;
      }
      pid = Number(row[1]);
    } catch {
      break;
    }
  }
  return void 0;
}

// src/harnesses/claude-code/usage.ts
var decodeClaudeUsage = (record) => {
  const usage = record.type === "assistant" && record.message?.usage;
  const id = record.message?.id;
  if (!usage || !id) return;
  return {
    kind: "message",
    id,
    counts: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreate: usage.cache_creation_input_tokens ?? 0
    }
  };
};

// src/harnesses/claude-code/cli.ts
var CLAUDE_TASK_COMMAND = /^\s*\/ld:go(?:\s+([\s\S]*)|$)/;
function isClaudeCli(name, pid) {
  if (name === "claude") return true;
  return name === "node" && /^(?:.*\/)?node\s+(?:[^\s]*\/)?(?:claude|@anthropic-ai\/claude-code\/cli\.js)(?:\s|$)/.test(
    processArgs(pid)
  );
}
var claudeCli = {
  id: "claude-code",
  defaultPort: 0,
  loopbackOnly: true,
  instance: () => {
    const instance = process.env.QWEN_LD_INSTANCE_ID || findCliInstance(isClaudeCli);
    if (!instance)
      throw new Error(
        "No Claude Code CLI process found. Start Live Delivery from a standalone claude CLI."
      );
    return instance;
  },
  explicitSessionKey: () => process.env.QWEN_LD_SESSION_KEY || void 0,
  // SessionStart reports the active model; this only covers MCP-first startup.
  model: () => process.env.ANTHROPIC_MODEL || "unknown",
  normalizeHook: (input, now) => normalizeCommandHook(input, now, CLAUDE_TASK_COMMAND),
  encodeHook: encodeCommandHook,
  transcriptUsage: decodeClaudeUsage,
  // Claude Code has no Interrupt event or resumable app server; queued feedback
  // reaches the agent at prompt, tool and turn-end boundaries.
  feedbackOnPrompt: true
};

// src/harnesses/codex/model.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { homedir } from "node:os";
import path9 from "node:path";

// node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class _TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message2, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message2}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
  /** @internal */
  static x(message2, ctx, ptr) {
    throw new _TomlError(message2, { toml: ctx.s, ptr: ptr ?? ctx.p });
  }
};

// node_modules/smol-toml/dist/primitive.js
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}

// node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
        let match = date.match(DATE_TIME_RE);
        if (match) {
          if (!match[1]) {
            hasDate = false;
            date = `0000-01-01T${date}`;
          }
          hasTime = !!match[2];
          hasTime && date[10] === " " && (date = date.replace(" ", "T"));
          if (match[2] && +match[2] > 23) {
            date = "";
          } else {
            offset = match[3] || null;
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z" || this.#offset === "z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/smol-toml/dist/extract.js
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
      state = 6;
    } else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}

// node_modules/smol-toml/dist/util.js
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}

// node_modules/smol-toml/dist/struct.js
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}

// node_modules/smol-toml/dist/parse.js
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1e3,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}

// node_modules/smol-toml/dist/stringify.js
var HAS_WELLFORMED = !!"".isWellFormed;

// src/harnesses/codex/model.ts
function configuredCodexModel(env = process.env) {
  if (env.QWEN_LD_MODEL) return env.QWEN_LD_MODEL;
  try {
    const root = env.CODEX_HOME || path9.join(homedir(), ".codex");
    const config = parse(readFileSync6(path9.join(root, "config.toml"), "utf8"));
    return typeof config.model === "string" && config.model.trim() ? config.model : "unknown";
  } catch {
    return "unknown";
  }
}

// src/harnesses/codex/usage.ts
var decodeCodexUsage = (record) => {
  const usage = record.type === "event_msg" && record.payload?.type === "token_count" && record.payload.info?.total_token_usage;
  if (!usage) return;
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheCreate = usage.cache_write_input_tokens ?? 0;
  return {
    kind: "cumulative",
    counts: {
      input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheCreate),
      output: usage.output_tokens ?? 0,
      cacheRead,
      cacheCreate
    }
  };
};

// src/harnesses/codex/cli.ts
var codexCli = {
  id: "codex",
  defaultPort: 18791,
  instance: () => process.env.QWEN_LD_INSTANCE_ID || findCliInstance((name) => /^codex(?:$|[-.])/.test(name)) || `parent-${process.ppid}`,
  explicitSessionKey: () => process.env.QWEN_LD_SESSION_KEY || void 0,
  model: configuredCodexModel,
  normalizeHook: normalizeCommandHook,
  encodeHook: encodeCommandHook,
  transcriptUsage: decodeCodexUsage,
  feedbackHandoff: () => process.env.QWEN_LD_FEEDBACK_HANDOFF
};

// src/harnesses/qwen-code/cli.ts
function isQwenCli(name, pid) {
  if (/^qwen(?:-code)?$/.test(name)) return true;
  return name === "node" && /^(?:.*\/)?node\s+(?:[^\s]*\/)?(?:qwen|qwen-code\/(?:[^\s]*\/)?(?:cli-entry|cli)\.js)(?:\s|$)/.test(
    processArgs(pid)
  );
}
var qwenCli = {
  id: "qwen-code",
  defaultPort: 0,
  loopbackOnly: true,
  instance: () => {
    const instance = findCliInstance(isQwenCli);
    if (!instance)
      throw new Error(
        "No Qwen Code CLI process found. Start Live Delivery from a standalone qwen CLI."
      );
    return instance;
  },
  model: () => process.env.OPENAI_MODEL || process.env.QWEN_MODEL || "unknown",
  normalizeHook: normalizeCommandHook,
  encodeHook: encodeCommandHook,
  feedbackOnPrompt: true
};

// src/harnesses/cli-entry.ts
var adapters = /* @__PURE__ */ new Map([
  ["--qwen-code", qwenCli],
  ["--claude-code", claudeCli]
]);
var cliAdapter = adapters.get(process.argv[2]) ?? codexCli;

// src/hook.ts
runHook(cliAdapter).catch((error) => {
  process.stderr.write(`[live-delivery hook] ${error instanceof Error ? error.message : error}
`);
  process.exitCode = 1;
});
/*! Bundled license information:

smol-toml/dist/error.js:
smol-toml/dist/primitive.js:
smol-toml/dist/date.js:
smol-toml/dist/extract.js:
smol-toml/dist/util.js:
smol-toml/dist/struct.js:
smol-toml/dist/parse.js:
smol-toml/dist/stringify.js:
smol-toml/dist/index.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)
*/

// Qwen Live Delivery Plugin
// Copyright (c) 2026 Qwen Live Delivery Plugin contributors
//
// Project code is licensed under Apache-2.0. Bundled components retain their own licenses below.
//
// Bundled JavaScript dependencies
//
// smol-toml@1.9.1
//
// License: BSD-3-Clause.
//
// LICENSE:
//
// Copyright (c) Squirrel Chat et al., All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
// 3. Neither the name of the copyright holder nor the names of its contributors
//    may be used to endorse or promote products derived from this software without
//    specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
