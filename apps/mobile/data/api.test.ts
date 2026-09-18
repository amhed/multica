// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";
import { invalidateSessionEpoch } from "./session-epoch";

// api.ts refuses to load without a base URL; set it before the import runs.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
});

// The real store pulls in expo-secure-store; the client only needs the slug.
vi.mock("@/data/workspace-store", () => ({ getCurrentSlug: () => null }));

describe("api.deleteComment", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // #8296: servers that keep a deleted comment's replies also route
  // /keep-replies; older servers do not, so a keep-replies delete that reaches
  // one fails instead of deleting the replies too.
  it.each([
    [{ keepReplies: true }, "https://api.example.test/api/comments/comment-1/keep-replies"],
    [{ keepReplies: false }, "https://api.example.test/api/comments/comment-1"],
    [undefined, "https://api.example.test/api/comments/comment-1"],
  ])("with %j sends DELETE %s", async (opts, url) => {
    await api.deleteComment("comment-1", opts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "DELETE" }));
  });
});


describe.each([
  ["session renewal", () => api.refreshSession()],
  ["profile", () => api.getMe()],
  ["upload", () => api.uploadFile({ uri: "file:///test.png", name: "test.png", type: "image/png" })],
] as const)("%s unauthorized responses", (_name, request) => {
  const onUnauthorized = vi.fn(() => api.setToken(null));
  let respond: (response: Response) => void;

  beforeEach(() => {
    onUnauthorized.mockClear();
    api.setToken("old-token");
    api.setOptions({ onUnauthorized });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      respond = resolve;
    })));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    api.setToken(null);
    api.setOptions({ onUnauthorized: undefined });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["logout followed by login", () => {
      invalidateSessionEpoch();
      api.setToken(null);
      invalidateSessionEpoch();
      api.setToken("new-token");
    }, "new-token"],
    ["credential rotation", () => api.setToken("renewed-token"), "renewed-token"],
    ["logout before asynchronous cleanup", () => invalidateSessionEpoch(), "old-token"],
  ] as const)("ignores stale teardown after %s", async (_transition, transition, token) => {
    const pending = request();
    transition();
    respond(new Response(null, { status: 401 }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(api.getToken()).toBe(token);
  });

  it("tears down the session when its current credential is rejected", async () => {
    const pending = request();
    respond(new Response(null, { status: 401 }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(api.getToken()).toBeNull();
  });
});
