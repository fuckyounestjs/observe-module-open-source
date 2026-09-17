import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { createServer, Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";
import {
  CapturedOutput,
  captureOutput,
  waitFor,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

// Fixed port: the decorator below is evaluated at import time, so the URL has
// to exist before any hook runs.
const COLLECTOR_PORT = 34519;
const COLLECTOR_URL = `http://127.0.0.1:${COLLECTOR_PORT}`;

@Controller()
class PingController {
  @Get("ping")
  ping() {
    return { ok: true };
  }
}

let collector: Server;
let accepted = 0;
let output: CapturedOutput;

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: "test-key",
      appSecret: "test-secret",
      serviceId: "accepted-app",
      endpoint: COLLECTOR_URL,
      // The agent's floor; anything lower is clamped to this with a warning.
      // The waits in `beforeAll` allow several flushes at this cadence.
      flushInterval: 1000,
      runtimeMetrics: false,
      forwardLogs: false,
    }),
  ],
  controllers: [PingController],
})
class AppModule {}

let app: INestApplication;

const DEGRADED_NOTICE = "monthly event allowance";

beforeAll(async () => {
  // Answers exactly as the real collector does for an account past its event
  // allowance: the batch is accepted, and the body says the spans in it were
  // discarded.
  collector = createServer((req, res) => {
    accepted += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ degraded: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    collector.once("error", reject);
    collector.listen(COLLECTOR_PORT, resolve);
  });

  output = captureOutput();

  app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  await app.listen(0);
  const baseUrl = await app.getUrl();

  // Traffic, the collector's answer to it, and the parent's reaction to that
  // answer - each awaited rather than slept for, so the suite runs at the
  // speed of the flush and says what never arrived when something does not.
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${baseUrl}/ping`);
    expect(res.status).toBe(200);
  }
  await waitFor(() => accepted > 0, 5_000, "the collector to accept a batch");
  await waitFor(
    () => output.lines.some((line) => line.includes(DEGRADED_NOTICE)),
    5_000,
    "the degraded notice to be logged",
  );
});

afterAll(async () => {
  await app?.close();
  output?.restore();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

it("does not report an unreachable collector when the batch was accepted", () => {
  // The collector answered 200. Anything claiming it could not be reached is
  // the worker misreporting one of its own exceptions as a network failure.
  const unreachable = output.lines.filter((line) =>
    line.includes("Could not reach the collector"),
  );
  expect(unreachable).toEqual([]);
});

it("acts on the degraded flag the accepted response carried", () => {
  // Proves the degraded line reached the parent at all: it travels on the
  // same postMessage that used to throw, so a silent pass here means the
  // whole withhold-spans path is dead. Once, however many degraded batches
  // follow - the account sits in this state for days, and a line per flush
  // would bury the one worth reading.
  const notices = output.lines.filter((line) => line.includes(DEGRADED_NOTICE));
  expect(notices).toHaveLength(1);
});
