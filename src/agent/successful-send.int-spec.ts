import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { createServer, Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";

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
const logged: string[] = [];

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: "test-key",
      appSecret: "test-secret",
      serviceId: "accepted-app",
      endpoint: COLLECTOR_URL,
      // The agent's floor; anything lower is clamped to this with a warning.
      // The 2s waits below expect at least one flush at this cadence.
      flushInterval: 1000,
      runtimeMetrics: false,
      forwardLogs: false,
    }),
  ],
  controllers: [PingController],
})
class AppModule {}

let app: INestApplication;
let baseUrl: string;

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
  await new Promise<void>((resolve) =>
    collector.listen(COLLECTOR_PORT, resolve),
  );

  for (const level of ["error", "warn", "log", "info"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
      original(...(args as []));
    };
  }
  // Both streams: Nest's logger sends `error` to stderr and `warn` to stdout,
  // and this suite asserts on one of each.
  for (const stream of [process.stderr, process.stdout] as const) {
    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return originalWrite(chunk as string, ...(rest as []));
    }) as typeof stream.write;
  }

  app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

it("does not report an unreachable collector when the batch was accepted", async () => {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${baseUrl}/ping`);
    expect(res.status).toBe(200);
  }

  // Let the worker flush and be accepted.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(accepted).toBeGreaterThan(0);

  // The collector answered 200. Anything claiming it could not be reached is
  // the worker misreporting one of its own exceptions as a network failure.
  const unreachable = logged.filter((line) =>
    line.includes("Could not reach the collector"),
  );
  expect(unreachable).toEqual([]);
});

it("acts on the degraded flag the accepted response carried", async () => {
  for (let i = 0; i < 5; i++) {
    await fetch(`${baseUrl}/ping`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  // Proves the degraded line reached the parent at all: it travels on the same
  // postMessage that used to throw, so a silent pass here means the whole
  // withhold-spans path is dead.
  const notices = logged.filter((line) =>
    line.includes("monthly event allowance"),
  );
  expect(notices).toHaveLength(1);
});
