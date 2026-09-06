#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectExternalBrain, enrichTaskWithExternalBrain, probeExternalBrain } from "../dist/externalBrainOps.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-external-brain-"));
const workspace = { id: "ws_external_brain_smoke", root, openedAt: new Date().toISOString() };
const executable = process.execPath;

try {
  let calls = 0;
  const absent = await detectExternalBrain(workspace, {
    executable,
    runner: async (_executable, args) => {
      calls += 1;
      assert.deepEqual(args, ["resolve", "--json"]);
      return {
        stdout: "",
        stderr: "Project is not enrolled in the configured ADR project registry.",
        exitCode: 1,
        timedOut: false
      };
    }
  });
  assert.equal(absent.status, "absent");
  assert.equal(absent.reasonCode, "binding-missing");
  assert.equal(calls, 1, "detection must delegate enrollment truth to adr resolve");

  const commands = [];
  const runner = async (_executable, args) => {
    calls += 1;
    commands.push([...args]);
    if (args[0] === "resolve") {
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          command: "resolve",
          context: {
            projectRoot: root,
            projectId: "example.product",
            projectDisplayName: "Example Product"
          }
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false
      };
    }
    if (args[0] === "context-plan") {
      assert.equal(args.includes("--project-config"), false, "CodexPro must not re-own ADR binding resolution");
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          command: "context-plan",
          request: { project: { id: "example.product" } },
          plan: {
            stages: [
              { stage: "knowledge-index", providerIds: ["builtin.knowledge-artifacts"] },
              { stage: "repo-map", providerIds: ["builtin.repo-map"] },
              { stage: "symbol-overview", providerIds: ["builtin.symbol-overview"] },
              { stage: "references", providerIds: [] }
            ]
          }
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false
      };
    }
    if (args[0] === "context-compile") {
      assert.equal(args.includes("--project-config"), false, "context compile must reuse ADR runtime resolution");
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          command: "context-compile",
          status: "exhausted",
          reason: "Concrete source still required",
          request: { project: { id: "example.product" } },
          plan: {
            stages: [
              { stage: "knowledge-index", providerIds: ["builtin.knowledge-artifacts"] },
              { stage: "repo-map", providerIds: ["builtin.repo-map"] },
              { stage: "symbol-overview", providerIds: ["builtin.symbol-overview"] }
            ]
          },
          pack: {
            materials: [
              {
                stage: "knowledge-index",
                providerId: "builtin.knowledge-artifacts",
                source: { kind: "knowledge-artifact", knowledgeId: "rules.root" },
                content: "Project rules: preserve the stable service boundary."
              },
              {
                stage: "repo-map",
                providerId: "builtin.repo-map",
                source: { kind: "derived" },
                content: "src/service.ts — class ServiceBoundary"
              }
            ]
          }
        }),
        stderr: "",
        exitCode: 1,
        timedOut: false
      };
    }
    throw new Error(`unexpected ADR command: ${args.join(" ")}`);
  };

  const detected = await detectExternalBrain(workspace, { executable, runner });
  assert.equal(detected.status, "detected");
  assert.equal(detected.projectId, "example.product");
  assert.equal(detected.binding, "central-registry");

  const ready = await probeExternalBrain(workspace, { executable, runner, cacheTtlMs: 0 });
  assert.equal(ready.status, "ready");
  assert.equal(ready.projectId, "example.product");
  assert.equal(ready.binding, "central-registry");
  assert.deepEqual(ready.capabilities, ["knowledge-index", "repo-map", "symbol-overview"]);

  const callsBeforeEnhancement = calls;
  const enhanced = await enrichTaskWithExternalBrain(workspace, "Refactor the service boundary", {
    executable,
    runner,
    cacheTtlMs: 0,
    maxContextChars: 4_000
  });
  assert.equal(calls, callsBeforeEnhancement + 2, "task enrichment should resolve once then execute context-compile");
  assert.equal(enhanced.used, true);
  assert.equal(enhanced.materialCount, 2);
  assert.deepEqual(enhanced.stages, ["knowledge-index", "repo-map"]);
  assert.match(enhanced.task, /ADR External Brain Context/);
  assert.match(enhanced.task, /preserve the stable service boundary/);
  assert.match(enhanced.task, /ServiceBoundary/);
  assert.equal(commands.some((args) => args.includes("--project-config")), false);

  const failed = await probeExternalBrain(workspace, {
    executable,
    cacheTtlMs: 0,
    runner: async (_executable, args) => {
      if (args[0] === "resolve") {
        return {
          stdout: JSON.stringify({ command: "resolve", context: { projectRoot: root, projectId: "example.product" } }),
          stderr: "",
          exitCode: 0,
          timedOut: false
        };
      }
      return { stdout: "", stderr: "runtime unavailable", exitCode: 1, timedOut: false };
    }
  });
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.reasonCode, "runtime-unavailable");

  const unchanged = await enrichTaskWithExternalBrain(workspace, "Keep working", {
    executable,
    cacheTtlMs: 0,
    runner: async (_executable, args) => {
      if (args[0] === "resolve") {
        return { stdout: "", stderr: "runtime unavailable", exitCode: 1, timedOut: false };
      }
      throw new Error("context compile must not run after failed resolve");
    }
  });
  assert.equal(unchanged.used, false);
  assert.equal(unchanged.task, "Keep working");

  console.log("external brain smoke: ok");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
