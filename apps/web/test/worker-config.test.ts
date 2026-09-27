import { describe, expect, it } from "vitest";
import { envOverride, parseWorkerRoles } from "@/worker/config";

/**
 * Worker / script configuration: an empty value in .env (`KEY=`) means "not set", never "nothing". An empty
 * WORKER_ROLES must not start a worker process that consumes no queue and runs no scheduler, and an empty
 * DEMO_QUEUE_DRIVER must not silently switch the demo script to the memory driver (it would exit mid-pass).
 */

describe("WORKER_ROLES", () => {
  it("unset, empty or blank means the default roles", () => {
    for (const raw of [undefined, "", "   ", ",", " , ,"]) expect([...parseWorkerRoles(raw)].sort()).toEqual(["scheduler", "worker"]);
  });

  it("an explicit list is honoured (trimmed, case-insensitive)", () => {
    expect([...parseWorkerRoles("worker")]).toEqual(["worker"]);
    expect([...parseWorkerRoles(" Scheduler ,")]).toEqual(["scheduler"]);
    expect([...parseWorkerRoles("worker,scheduler")].sort()).toEqual(["scheduler", "worker"]);
  });
});

describe("script overrides", () => {
  it("empty or blank overrides fall back to the default", () => {
    expect(envOverride(undefined, "inline")).toBe("inline");
    expect(envOverride("", "inline")).toBe("inline");
    expect(envOverride("  ", "demo@applywise.test")).toBe("demo@applywise.test");
    expect(envOverride(" memory ", "inline")).toBe("memory");
  });
});
