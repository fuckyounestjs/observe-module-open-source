import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileUploader } from "./profile-uploader.js";
import { ProfileWindow } from "./cpu-profiler.service.js";

const makeWindow = (start = "2026-08-25T00:00:00.000Z"): ProfileWindow => ({
  start,
  stacks: [{ frames: ["main", "work"], samples: 10 }],
});

const jsonResponse = (
  status: number,
  headers: Record<string, string> = {},
  body: unknown = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers,
  });

describe("ProfileUploader rate limiting", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const makeUploader = (onError?: (message: string) => void) =>
    new ProfileUploader({
      endpoint: "http://collector",
      serviceNode: "node-1",
      onError,
    });

  it("stops uploading after a 429 until the pause lapses", async () => {
    const errors: string[] = [];
    const uploader = makeUploader((message) => errors.push(message));

    fetchMock.mockResolvedValue(jsonResponse(429));
    uploader.enqueue(makeWindow(), 100);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain("rate-limited (429)");

    // Windows arriving during the pause are queued, not sent.
    uploader.enqueue(makeWindow("2026-08-25T00:01:00.000Z"), 100);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After the default five-minute pause, the next window drains the queue.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    fetchMock.mockResolvedValue(jsonResponse(200));
    uploader.enqueue(makeWindow("2026-08-25T00:06:00.000Z"), 100);
    await vi.runAllTimersAsync();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(uploader.pendingCount()).toBe(0);
  });

  it("names a declined payment when the collector says so", async () => {
    const errors: string[] = [];
    const uploader = makeUploader((message) => errors.push(message));

    fetchMock.mockResolvedValue(
      jsonResponse(
        429,
        {},
        {
          code: "USAGE_LIMIT_REACHED",
          limit: "observability_events",
          plan: "pro",
          reason: "payment_failed",
        },
      ),
    );
    uploader.enqueue(makeWindow(), 100);
    await vi.runAllTimersAsync();

    // The operator has to be sent to their payment method, not the pricing
    // page - the plan is intact and paying lifts the pause at once.
    expect(errors[0]).toContain("rate-limited (429)");
    expect(errors[0]).toContain("payment on the account was declined");
    expect(errors[0]).toContain("5 minute(s)");
  });

  it("honours a delta-seconds Retry-After header", async () => {
    const errors: string[] = [];
    const uploader = makeUploader((message) => errors.push(message));

    fetchMock.mockResolvedValue(jsonResponse(429, { "retry-after": "120" }));
    uploader.enqueue(makeWindow(), 100);
    await vi.runAllTimersAsync();
    expect(errors[0]).toContain("2 minute(s)");

    vi.advanceTimersByTime(120 * 1000 + 1);
    fetchMock.mockResolvedValue(jsonResponse(200));
    uploader.enqueue(makeWindow("2026-08-25T00:03:00.000Z"), 100);
    await vi.runAllTimersAsync();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("falls back to the default pause on a malformed Retry-After", async () => {
    const errors: string[] = [];
    const uploader = makeUploader((message) => errors.push(message));

    fetchMock.mockResolvedValue(jsonResponse(429, { "retry-after": "soon" }));
    uploader.enqueue(makeWindow(), 100);
    await vi.runAllTimersAsync();
    expect(errors[0]).toContain("5 minute(s)");
  });
});
