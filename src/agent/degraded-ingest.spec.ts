import { describe, expect, it, vi } from "vitest";
import {
  countTraceNodes,
  DEGRADED_MESSAGE_PREFIX,
  DEGRADED_TTL_MS,
  isNotableSnapshot,
  NOTABLE_DURATION_MS,
  parseDegradedMessage,
} from "./degraded-ingest.protocol.js";

describe("the degraded-ingest protocol", () => {
  it("reads the worker's verdict for a batch", () => {
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}true`)).toBe(true);
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}false`)).toBe(false);
  });

  it("ignores every other line the worker posts", () => {
    // The channel carries prose the parent logs; only this one line is a
    // protocol, and mistaking a log for one would silently stop spans.
    expect(
      parseDegradedMessage(
        "Tracing and instrumentation data sent successfully",
      ),
    ).toBeNull();
    expect(parseDegradedMessage("Error: Failed to send data.")).toBeNull();
  });
});

describe("what survives truncation", () => {
  it("keeps a server error's waterfall", () => {
    // Withholding one the collector would have stored loses the customer the
    // waterfall they came for, silently.
    expect(isNotableSnapshot({ a: { sc: 503 } })).toBe(true);
  });

  it("keeps a slow execution, which is the whole reason to open a trace", () => {
    expect(
      isNotableSnapshot({ a: { sc: 200 }, d: NOTABLE_DURATION_MS + 1 }),
    ).toBe(true);
    expect(isNotableSnapshot({ d: NOTABLE_DURATION_MS + 1 })).toBe(true);
  });

  it("keeps an errored execution that carries no status code", () => {
    // A job, or a non-HTTP entry point: nothing grades these but the error.
    expect(isNotableSnapshot({ e: { message: "boom" } })).toBe(true);
  });

  it("lets a status code decide alone where there is one", () => {
    /*
     * The part of the collector's rule that looks wrong and is not: an
     * expected 401 carries an error object exactly like a 500 does, and those
     * plus 429s are most of the daily error count. Consulting the error first
     * would ship a tree for every unauthenticated probe - the traffic this
     * exists to stop shipping.
     */
    expect(isNotableSnapshot({ a: { sc: 401 }, e: { message: "no" } })).toBe(
      false,
    );
    expect(isNotableSnapshot({ a: { sc: 404 }, e: { message: "no" } })).toBe(
      false,
    );
  });

  it("truncates ordinary, fast traffic", () => {
    expect(isNotableSnapshot({ a: { sc: 200 }, d: 12 })).toBe(false);
    expect(isNotableSnapshot({})).toBe(false);
  });

  it("agrees with the collector on the boundary", () => {
    // Strictly greater, like the server's `duration > NOTABLE_TRACE_DURATION_MS`.
    expect(isNotableSnapshot({ d: NOTABLE_DURATION_MS })).toBe(false);
    expect(isNotableSnapshot({ a: { sc: 499 } })).toBe(false);
    expect(isNotableSnapshot({ a: { sc: 500 } })).toBe(true);
  });
});

describe("the shared buffer's degraded window", () => {
  /** The two methods under test, without booting the whole agent. */
  const windowOf = () => {
    let degradedUntil = 0;
    return {
      setDegraded: (degraded: boolean) => {
        degradedUntil = degraded ? Date.now() + DEGRADED_TTL_MS : 0;
      },
      isDegraded: () => degradedUntil > Date.now(),
    };
  };

  it("starts clear, so the first batch after start-up carries its spans", () => {
    expect(windowOf().isDegraded()).toBe(false);
  });

  it("lapses on its own rather than needing a restart", () => {
    // The collector cannot announce the end of degradation - an upgrade or the
    // turn of the period simply starts keeping spans again - so the window has
    // to expire by itself.
    vi.useFakeTimers();
    try {
      const window = windowOf();
      window.setDegraded(true);
      expect(window.isDegraded()).toBe(true);

      vi.advanceTimersByTime(DEGRADED_TTL_MS + 1);
      expect(window.isDegraded()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears immediately when a batch comes back undegraded", () => {
    const window = windowOf();
    window.setDegraded(true);
    window.setDegraded(false);

    expect(window.isDegraded()).toBe(false);
  });
});

describe("counting what was withheld", () => {
  it("counts every node, not every root", () => {
    /*
     * The meter bills a trace by its node count. On an auto-instrumented
     * request a single root routinely carries eighty-odd children, so counting
     * roots would report a fraction of what was withheld and measure the
     * account against the wrong volume.
     */
    const tree = [{ ch: [{ ch: [{}] }, {}] }, { ch: [] }];

    expect(countTraceNodes(tree)).toBe(5);
  });

  it("treats a missing or malformed tree as nothing", () => {
    expect(countTraceNodes(undefined)).toBe(0);
    expect(countTraceNodes(null)).toBe(0);
    expect(countTraceNodes({})).toBe(0);
    expect(countTraceNodes([])).toBe(0);
  });
});
