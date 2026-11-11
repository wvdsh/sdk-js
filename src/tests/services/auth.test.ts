import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WavedashSDK } from "../../index";
import { AuthManager } from "../../services/auth";

type Fetcher = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

function jwt(iat: number): string {
  const payload = btoa(JSON.stringify({ iat }));
  return `header.${payload}.signature`;
}

function setup() {
  const responses: { resolve: (response: Response) => void }[] = [];
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        responses.push({ resolve });
      })
  );
  vi.stubGlobal("fetch", fetchMock);

  let fetcher: Fetcher | null = null;
  const postToParent = vi.fn();
  const endExpiredSession = vi.fn();
  const sdk = {
    convexClient: {
      setAuth: vi.fn((f: Fetcher) => {
        fetcher = f;
      })
    },
    iframeMessenger: { postToParent },
    _endExpiredSession: endExpiredSession
  } as unknown as WavedashSDK;
  const manager = new AuthManager(sdk);

  const posted = (type: string) =>
    postToParent.mock.calls.filter(([messageType]) => messageType === type);

  return {
    manager,
    fetchMock,
    posted,
    endExpiredSession,
    fetcher: () => fetcher!,
    respond: async (status: number, body = "") => {
      responses.shift()!.resolve(new Response(body, { status }));
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

let current: ReturnType<typeof setup>;

beforeEach(() => {
  vi.useFakeTimers();
  current = setup();
});

afterEach(() => {
  current.manager.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AuthManager session expiry", () => {
  it("tells the host and cuts server calls once when the session is rejected", async () => {
    const { fetcher, fetchMock, posted, endExpiredSession, respond } = current;

    void fetcher()({ forceRefreshToken: false });
    await respond(401);

    expect(posted(IFRAME_MESSAGE_TYPE.SESSION_EXPIRED)).toHaveLength(1);
    expect(endExpiredSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted(IFRAME_MESSAGE_TYPE.SESSION_EXPIRED)).toHaveLength(1);
    expect(endExpiredSession).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a refresh queued behind the 401 revives the session", async () => {
    const { manager, posted, endExpiredSession, respond } = current;

    const first = manager.getToken();
    const queued = manager.getToken(true);
    first.catch(() => {});
    await respond(401);
    await respond(200, jwt(1));

    await expect(queued).resolves.toBe(jwt(1));
    expect(posted(IFRAME_MESSAGE_TYPE.SESSION_EXPIRED)).toHaveLength(0);
    expect(posted(IFRAME_MESSAGE_TYPE.GAMEPLAY_JWT_READY)).toHaveLength(1);
    expect(endExpiredSession).not.toHaveBeenCalled();
  });

  it("does not treat a transient failure as an expired session", async () => {
    const { fetcher, fetchMock, posted, endExpiredSession, respond } = current;

    void fetcher()({ forceRefreshToken: false });
    await respond(503);

    expect(posted(IFRAME_MESSAGE_TYPE.SESSION_EXPIRED)).toHaveLength(0);
    expect(endExpiredSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
