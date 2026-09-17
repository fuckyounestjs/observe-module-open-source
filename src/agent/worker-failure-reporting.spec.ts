import { Worker } from "worker_threads";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detachedWorkerData,
  detachedWorkerSource,
} from "./detached-observe-worker.assembly.js";
import { freePort } from "../testing/observe-harness.js";

/** A shared buffer holding one batch, laid out as the agent lays it out. */
const bufferWithBatch = (json: string) => {
  const sharedBuffer = new SharedArrayBuffer(64 * 1024);
  const bytes = new Uint8Array(sharedBuffer);
  const length = new DataView(sharedBuffer, 4, 4);
  const encoded = new TextEncoder().encode(json);
  bytes.set(encoded, 8);
  length.setUint32(0, encoded.length);
  return sharedBuffer;
};

/**
 * Runs the worker until it reports a problem, or the timeout lapses.
 *
 * Assembled from the same source and data as `ObserveAgentWorker` uses, on
 * purpose. The worker runs as eval'd source with no module scope, so a value
 * the real assembly forgets to pass is missing only in the real assembly - a
 * test that called `detachedObserveWorker` directly, or built a copy of the
 * assembly here, would close over this module's imports and pass regardless.
 */
const firstReport = async (
  source: string,
  endpoint: string,
  batch: unknown = { traces: [] },
) => {
  const worker = new Worker(source, {
    eval: true,
    workerData: detachedWorkerData({
      sharedBuffer: bufferWithBatch(JSON.stringify(batch)),
      endpoint,
      appKey: "k",
      appSecret: "s",
    }),
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("worker reported nothing")),
        5_000,
      );
      worker.on("message", (msg: string) => {
        if (msg.startsWith("Error:")) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await worker.terminate();
  }
};

type Respond = (req: IncomingMessage, res: ServerResponse) => void;

/** Reads the request, then answers with the given status and JSON body. */
const answer =
  (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Respond =>
  (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    });
  };

describe("how the detached worker reports its own failures", () => {
  let collector: Server;
  let endpoint: string;
  let respond: Respond = answer(200, { degraded: false });

  beforeAll(async () => {
    collector = createServer((req, res) => respond(req, res));
    await new Promise<void>((resolve) => collector.listen(0, resolve));
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  it("names the transport cause when the collector really is unreachable", async () => {
    // A port that was bound and released a moment ago: nothing listens there,
    // so the connection is refused at once and `fetch` fails with ECONNREFUSED
    // on its cause. Asked for rather than hard-coded, so a stray listener on a
    // busy machine cannot turn this into a ten-second timeout.
    const port = await freePort();
    const report = await firstReport(
      detachedWorkerSource(),
      `http://127.0.0.1:${port}`,
    );

    expect(report).toContain("Could not reach the collector");
    // The reason is the whole point of this branch: without it the operator is
    // told a URL failed and nothing about why.
    expect(report).toContain("ECONNREFUSED");
  }, 20_000);

  it("blames the endpoint option, not the network, when the endpoint is malformed", async () => {
    // Scheme-less, which `new URL` accepts with "localhost" as the scheme and
    // `fetch` then refuses with a cause - the same shape as a refused
    // connection, and the reason a URL check alone is not enough.
    const report = await firstReport(detachedWorkerSource(), "localhost:4000");

    expect(report).not.toContain("Could not reach the collector");
    expect(report).toContain('`endpoint` is set to "localhost:4000"');
    expect(report).toContain("http: or https:");
  }, 20_000);

  it("does not blame the network for a fault inside the worker", async () => {
    // Reintroduces the exact defect this branch exists for: a bare identifier
    // in the worker body that resolved at module scope but not in the eval'd
    // copy. It throws on the success path, after the batch has been sent.
    // Matched loosely because the source reaching this test is transpiled.
    const declaration = /const degradedPrefix[^=]*= config\.degradedPrefix;/;
    expect(detachedWorkerSource()).toMatch(declaration);
    const broken = detachedWorkerSource().replace(declaration, "");

    // Sent to a collector that accepts it, so the throw happens where the real
    // one did: on the success path, after the batch is away.
    respond = answer(200, { degraded: false });
    const report = await firstReport(broken, endpoint);

    // The old message claimed an unreachable collector for this, with an empty
    // reason - which is how it went unnoticed for a release.
    expect(report).not.toContain("Could not reach the collector");
    expect(report).toContain("ReferenceError");
    expect(report).toContain("degradedPrefix");
  }, 20_000);

  // The two cases below exist to execute the other two function bodies that
  // travel into the worker as source - the sanitizer and the refusal describer
  // - in the eval'd scope, on every run. The lint rule that forbids value
  // imports covers only the worker's own file; those two live in ordinary
  // modules beside helpers they must not touch, and a slip there would be
  // swallowed by the repair path's catch and surface as a plain 400.

  it("repairs and re-sends a batch the collector refused as out of contract", async () => {
    let requests = 0;
    respond = (req, res) => {
      requests += 1;
      answer(requests === 1 ? 400 : 200, { degraded: false })(req, res);
    };

    // `d` is a number in the contract; a string is stripped, which makes the
    // batch worth re-sending.
    const report = await firstReport(detachedWorkerSource(), endpoint, {
      snapshots: [{ ti: "trace-1", d: "slow" }],
    });

    expect(requests).toBe(2);
    expect(report).toContain("rejected (400) and repaired");
    expect(report).toContain("The repaired batch was sent");
  }, 20_000);

  it("explains a 429 in the operator's terms and pauses", async () => {
    respond = answer(
      429,
      { code: "USAGE_LIMIT_REACHED", used: 12, included: 10, plan: "hobby" },
      { "retry-after": "60" },
    );

    const report = await firstReport(detachedWorkerSource(), endpoint);

    expect(report).toContain("rate-limited (429)");
    expect(report).toContain("12 of 10 included events used on the hobby plan");
    expect(report).toContain("Pausing sends for 1 minute(s)");
  }, 20_000);
});
