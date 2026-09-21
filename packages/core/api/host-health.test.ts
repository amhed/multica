// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const host = {
  daemon_id: "d1",
  device_name: "droplet",
  ncpu: 8,
  load1: 65,
  load5: 64,
  load15: 60,
  mem_total_kb: 16_000_000,
  mem_available_kb: 1_000_000,
  swap_total_kb: 4_000_000,
  swap_free_kb: 0,
};

afterEach(() => vi.unstubAllGlobals());

async function read(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
  return new ApiClient("https://api.example.test").getHostHealth();
}

describe("host health API", () => {
  it("passes a well-formed host through", async () => {
    expect(await read({ hosts: [host] })).toEqual({ hosts: [host] });
  });

  it("defaults a missing hosts field to an empty list", async () => {
    expect(await read({})).toEqual({ hosts: [] });
  });

  it("falls back to empty hosts on a malformed response", async () => {
    expect(await read("nonsense")).toEqual({ hosts: [] });
  });

  it("fills numeric defaults for a partial host rather than dropping it", async () => {
    const result = await read({ hosts: [{ daemon_id: "d2", device_name: "x" }] });
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({
      daemon_id: "d2",
      ncpu: 0,
      load15: 0,
      swap_total_kb: 0,
    });
  });
});
