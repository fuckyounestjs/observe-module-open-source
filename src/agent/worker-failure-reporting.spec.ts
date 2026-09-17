import { Worker } from "worker_threads";
import { createServer, Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEGRADED_MESSAGE_PREFIX } from "./degraded-ingest.protocol.js";
import { detachedObserveWorker } from "./detached-observe-worker.js";
import { describeIngestRefusal } from "../utils/ingest-refusal.util.js";
import {
  createTelemetrySanitizer,
  SECTION_SHAPES,
} from "./telemetry-wire-contract.js";

/**
 * The worker as `ObserveAgentWorker.initializeWorker` assembles it.
 *
 * Built the same way here on purpose. The worker runs as eval'd source with no
 * module scope, so a value the real assembly forgets to pass is missing only in
 * the real assembly - a test that called `detachedObserveWorker` directly would
 * close over this module's imports and pass regardless.
 */
const workerSource = () =>
  `(${detachedObserveWorker.toString()})(${createTelemetrySanitizer.toString()}, ${describeIngestRefusal.toString()})`;

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

/** Runs the worker until it reports something, or the timeout lapses. */
const firstReport = async (source: string, endpoint: string) => {
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      sharedBuffer: bufferWithBatch(JSON.stringify({ traces: [] })),
      config: {
        endpoint,
        appKey: "k",
        appSecret: "s",
        wireShapes: SECTION_SHAPES,
        degradedPrefix: DEGRADED_MESSAGE_PREFIX,
      },
    },
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("worker reported nothing")),
        10_000,
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

describe("how the detached worker reports its own failures", () => {
  let collector: Server;
  let endpoint: string;

  beforeAll(async () => {
    collector = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ degraded: false }));
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, resolve));
    const address = collector.address();
    endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  it("names the transport cause when the collector really is unreachable", async () => {
    // A closed high port on loopback refuses the connection immediately, so
    // `fetch` fails with ECONNREFUSED on its cause. (Port 1 would be rejected
    // as a bad port before a connection was ever attempted.)
    const report = await firstReport(workerSource(), "http://127.0.0.1:34598");

    expect(report).toContain("Could not reach the collector");
    // The reason is the whole point of this branch: without it the operator is
    // told a URL failed and nothing about why.
    expect(report).toContain("ECONNREFUSED");
  }, 20_000);

  it("does not blame the network for a fault inside the worker", async () => {
    // Reintroduces the exact defect this branch exists for: a bare identifier
    // in the worker body that resolved at module scope but not in the eval'd
    // copy. It throws on the success path, after the batch has been sent.
    // Matched loosely because the source reaching this test is transpiled -
    // the type annotation is already gone.
    const declaration = /const degradedPrefix[^=]*= config\.degradedPrefix;/;
    expect(workerSource()).toMatch(declaration);
    const broken = workerSource().replace(declaration, "");

    // Sent to a collector that accepts it, so the throw happens where the real
    // one did: on the success path, after the batch is away.
    const report = await firstReport(broken, endpoint);

    // The old message claimed an unreachable collector for this, with an empty
    // reason - which is how it went unnoticed for a release.
    expect(report).not.toContain("Could not reach the collector");
    expect(report).toContain("ReferenceError");
    expect(report).toContain("degradedPrefix");
  }, 20_000);
});
