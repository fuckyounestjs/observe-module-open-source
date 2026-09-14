import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import {
  collapseRepeatedSpans,
  DEFAULT_SPAN_COLLAPSE,
  resolveSpanCollapseSettings,
  SPAN_COLLAPSED_TAG,
  SpanCollapseSettings,
} from "./collapse-repeated-spans.util.js";

/**
 * Repeated siblings collapse into one counted node. The property that matters
 * most is invisible in any single assertion: the collector derives a method's
 * self time from the tree, and collapsing must not move a millisecond between
 * classes. `selfTime` below is a port of that derivation, and the equivalence
 * cases hold the collapsed tree to it.
 */
describe("collapseRepeatedSpans", () => {
  const settings: SpanCollapseSettings = { threshold: 5, keepSlowest: 2 };

  let nextOffset = 0;
  beforeEach(() => {
    nextOffset = 0;
  });

  const span = (
    className: string,
    methodKey: string,
    duration: number,
    extra: Partial<CompleteTraceEventNode> = {},
  ): CompleteTraceEventNode => {
    const node: CompleteTraceEventNode = {
      origin: "auto",
      className,
      methodKey,
      duration,
      startOffset: nextOffset++,
      spanId: `${className}.${methodKey}@${nextOffset}`,
      ...extra,
    } as CompleteTraceEventNode;
    if (!node.children) {
      delete (node as Partial<CompleteTraceEventNode>).children;
    }
    return node;
  };

  const pipe = (
    duration: number,
    extra: Partial<CompleteTraceEventNode> = {},
  ) => span("ValidationPipe", "transform", duration, extra);

  const ofFrame = (
    nodes: CompleteTraceEventNode[],
    className: string,
    methodKey: string,
  ) =>
    nodes.filter(
      (node) => node.className === className && node.methodKey === methodKey,
    );

  /** The count a collapsed node carries; `undefined` on an ordinary span. */
  const countOf = (node: CompleteTraceEventNode) =>
    node.tags?.[SPAN_COLLAPSED_TAG];

  const collapsedOf = (nodes: CompleteTraceEventNode[]) =>
    nodes.filter((node) => countOf(node) !== undefined);

  /**
   * The collector's self-time derivation (`trace-ingestion.processor.ts` in
   * whisprr-api): a node's duration minus its children's attributed duration,
   * where a manual child is transparent and contributes only the auto spans
   * beneath it.
   */
  const attributed = (child: CompleteTraceEventNode): number =>
    child.origin === "manual"
      ? (child.children ?? []).reduce((sum, c) => sum + attributed(c), 0)
      : child.duration;

  const selfTime = (node: CompleteTraceEventNode): number =>
    node.duration -
    (node.children ?? []).reduce((sum, c) => sum + attributed(c), 0);

  const total = (nodes: CompleteTraceEventNode[]) =>
    nodes.reduce((sum, node) => sum + node.duration, 0);

  const collapse = (nodes: CompleteTraceEventNode[], s = settings) =>
    collapseRepeatedSpans(nodes, s) as CompleteTraceEventNode[];

  describe("threshold", () => {
    it("leaves exactly `threshold` siblings alone", () => {
      const siblings = Array.from({ length: 5 }, (_, i) => pipe(i + 1));

      const result = collapse(siblings);

      expect(result).toHaveLength(5);
      expect(collapsedOf(result)).toHaveLength(0);
    });

    it("collapses at `threshold + 1`", () => {
      const siblings = Array.from({ length: 6 }, (_, i) => pipe(i + 1));

      const result = collapse(siblings);

      // Two slowest kept whole, four folded into one node.
      expect(result).toHaveLength(3);
      const [collapsed] = collapsedOf(result);
      expect(countOf(collapsed)).toBe(4);
      expect(collapsed.duration).toBe(1 + 2 + 3 + 4);
    });

    it("judges each frame on its own, not the sibling list as a whole", () => {
      // Twelve siblings, but no frame exceeds the threshold.
      const siblings = [
        ...Array.from({ length: 4 }, () => span("A", "a", 1)),
        ...Array.from({ length: 4 }, () => span("B", "b", 1)),
        ...Array.from({ length: 4 }, () => span("C", "c", 1)),
      ];

      expect(collapse(siblings)).toHaveLength(12);
    });

    it("does not produce a node standing for a single call", () => {
      // Six siblings, two kept, three errored: one would be left to collapse.
      const siblings = [
        pipe(9),
        pipe(8),
        pipe(1, { error: true }),
        pipe(1, { error: true }),
        pipe(1, { error: true }),
        pipe(1),
      ];

      const result = collapse(siblings);

      expect(result).toHaveLength(6);
      expect(collapsedOf(result)).toHaveLength(0);
    });
  });

  describe("what survives", () => {
    it("keeps the slowest instances whole", () => {
      const siblings = [
        pipe(1),
        pipe(50),
        pipe(2),
        pipe(3),
        pipe(700),
        pipe(4),
        pipe(5),
      ];

      const result = collapse(siblings);

      const kept = ofFrame(result, "ValidationPipe", "transform").filter(
        (node) => countOf(node) === undefined,
      );
      expect(kept.map((node) => node.duration).sort((a, b) => a - b)).toEqual([
        50, 700,
      ]);
    });

    it("keeps an errored instance regardless of duration", () => {
      const failed = pipe(0.01, { error: true });
      const siblings = [pipe(10), pipe(9), pipe(8), failed, pipe(7), pipe(6)];

      const result = collapse(siblings);

      expect(result).toContain(failed);
      const [collapsed] = collapsedOf(result);
      // The errored call is neither counted nor summed into the aggregate.
      expect(countOf(collapsed)).toBe(3);
      expect(collapsed.duration).toBe(8 + 7 + 6);
    });

    it("keeps an errored instance carrying a payload, too", () => {
      const failed = pipe(0.01, {
        error: { message: "boom", cls: "BadRequestException" },
      });
      const siblings = [failed, ...Array.from({ length: 6 }, () => pipe(1))];

      expect(collapse(siblings)).toContain(failed);
    });

    it("never collapses manual spans", () => {
      const siblings = Array.from({ length: 8 }, () =>
        span("Svc", "run", 1, { origin: "manual", name: "step" }),
      );

      expect(collapse(siblings)).toHaveLength(8);
    });

    it("leaves a node that is still ongoing alone", () => {
      const siblings = Array.from({ length: 8 }, () => pipe(1));
      const ongoing = {
        ...pipe(1),
        type: "start",
        startTime: 1,
        children: [],
      } as never;

      const result = collapseRepeatedSpans([...siblings, ongoing], settings);

      expect(result).toContain(ongoing);
    });
  });

  describe("non-adjacent siblings", () => {
    it("collapses instances interleaved with other frames", () => {
      const siblings: CompleteTraceEventNode[] = [];
      for (let i = 0; i < 8; i++) {
        siblings.push(span("OrdersResolver", "total", 5));
        siblings.push(pipe(1));
        siblings.push(span("PricingService", "quote", 2));
      }

      const result = collapse(siblings);

      const pipes = ofFrame(result, "ValidationPipe", "transform");
      expect(pipes).toHaveLength(3);
      expect(countOf(collapsedOf(pipes)[0])).toBe(6);
      // The other frames each exceeded the threshold too, on their own terms.
      expect(ofFrame(result, "OrdersResolver", "total")).toHaveLength(3);
      expect(ofFrame(result, "PricingService", "quote")).toHaveLength(3);
    });

    it("places the collapsed node where the earliest collapsed call was", () => {
      const first = span("Svc", "before", 1);
      const siblings = [first, pipe(1), span("Svc", "between", 1)];
      for (let i = 0; i < 6; i++) {
        siblings.push(pipe(i + 2));
      }
      const last = span("Svc", "after", 1);
      siblings.push(last);

      const result = collapse(siblings);

      expect(result[0]).toBe(first);
      // The very first pipe call - the cheapest, so collapsed - sat at index 1.
      expect(countOf(result[1])).toBe(5);
      expect(result[result.length - 1]).toBe(last);
    });

    it("takes the earliest start offset", () => {
      // The two slowest are last; offsets were assigned in construction
      // order, so the earliest collapsed call is the first sibling.
      const siblings = [pipe(1), pipe(1), pipe(1), pipe(1), pipe(8), pipe(9)];
      const earliest = siblings[0].startOffset;

      const [collapsed] = collapsedOf(collapse(siblings));

      expect(collapsed.startOffset).toBe(earliest);
      expect(collapsed.spanId).toBe(siblings[0].spanId);
    });

    it("falls back to list order when offsets are absent", () => {
      const siblings = [1, 1, 1, 1, 8, 9].map((duration) =>
        pipe(duration, { startOffset: undefined }),
      );

      const [collapsed] = collapsedOf(collapse(siblings));

      expect(collapsed.startOffset).toBeUndefined();
      expect(collapsed.spanId).toBe(siblings[0].spanId);
    });
  });

  describe("the collapsed node", () => {
    it("is named as an aggregate and carries the frame identity", () => {
      const siblings = Array.from({ length: 7 }, () => pipe(1));

      const [collapsed] = collapsedOf(collapse(siblings));

      expect(collapsed).toMatchObject({
        origin: "auto",
        className: "ValidationPipe",
        methodKey: "transform",
        name: "ValidationPipe.transform ×5",
        tags: { [SPAN_COLLAPSED_TAG]: 5 },
        duration: 5,
      });
      expect(collapsed.error).toBeUndefined();
      expect(collapsed).not.toHaveProperty("children");
    });

    it("drops the tags of the calls it replaces, keeping only the count", () => {
      const siblings = Array.from({ length: 7 }, () =>
        pipe(1, { tags: { arg: "id" } }),
      );

      const [collapsed] = collapsedOf(collapse(siblings));

      expect(collapsed.tags).toEqual({ [SPAN_COLLAPSED_TAG]: 5 });
    });
  });

  describe("self-time equivalence", () => {
    it("leaves the parent's self time and total unchanged", () => {
      const children = [
        span("OrdersResolver", "orders", 40),
        ...Array.from({ length: 30 }, (_, i) => pipe(1 + (i % 3))),
        span("Svc", "step", 3, {
          origin: "manual",
          name: "step",
          children: [span("Repo", "find", 2)],
        }),
      ];
      const parent = span("Operation", "run", 200, { children });
      const before = selfTime(parent);
      const beforeTotal = parent.duration;

      const [after] = collapse([parent], DEFAULT_SPAN_COLLAPSE);

      expect(after.children.length).toBeLessThan(children.length);
      expect(selfTime(after)).toBe(before);
      expect(after.duration).toBe(beforeTotal);
      expect(total(after.children)).toBe(total(children));
    });

    it("carries the collapsed calls' children across and preserves their attribution", () => {
      // Every pipe call invokes a validator; the validator's time must still be
      // attributed to the validator, not swallowed into the pipe.
      const children = Array.from({ length: 10 }, (_, i) =>
        pipe(4, { children: [span("Validator", "validate", 1 + (i % 2))] }),
      );
      const parent = span("Operation", "run", 100, { children });
      const pipeSelfBefore = children.reduce((sum, c) => sum + selfTime(c), 0);
      const validatorBefore = total(children.flatMap((c) => c.children ?? []));
      const parentSelfBefore = selfTime(parent);

      const [after] = collapse([parent]);
      const pipesAfter = ofFrame(after.children, "ValidationPipe", "transform");
      const validatorsAfter = pipesAfter.flatMap((c) =>
        ofFrame(c.children ?? [], "Validator", "validate"),
      );

      expect(selfTime(after)).toBe(parentSelfBefore);
      expect(pipesAfter.reduce((sum, c) => sum + selfTime(c), 0)).toBe(
        pipeSelfBefore,
      );
      expect(total(validatorsAfter)).toBe(validatorBefore);
      // The carried-across validators - eight of them under one node - then
      // collapse among themselves.
      const [collapsedPipe] = collapsedOf(pipesAfter);
      expect(countOf(collapsedPipe)).toBe(8);
      expect(collapsedOf(collapsedPipe.children)).toHaveLength(1);
    });

    it("treats a manual span as transparent on both sides", () => {
      // Repeated calls *inside* a manual span collapse there, and the manual
      // span's parent still sees the same attributed time through it.
      const inner = Array.from({ length: 12 }, () => span("Repo", "find", 2));
      const manual = span("Svc", "handle", 30, {
        origin: "manual",
        name: "load",
        children: inner,
      });
      const parent = span("Svc", "handle", 100, { children: [manual] });
      const before = selfTime(parent);

      const [after] = collapse([parent]);

      expect(selfTime(after)).toBe(before);
      expect(after.children[0].children.length).toBeLessThan(inner.length);
    });

    it("collapses at the root level as well", () => {
      // A caller that completed before its callees pushes them to the root.
      const roots = [
        span("Ctrl", "handle", 10),
        ...Array.from({ length: 9 }, () => pipe(1)),
      ];

      const result = collapse(roots);

      expect(result.length).toBe(1 + 2 + 1);
      expect(total(result)).toBe(total(roots));
    });
  });

  describe("settings", () => {
    it("honours a custom threshold and keep count", () => {
      const siblings = Array.from({ length: 4 }, (_, i) => pipe(i + 1));

      const result = collapse(siblings, { threshold: 2, keepSlowest: 0 });

      expect(result).toHaveLength(1);
      expect(countOf(result[0])).toBe(4);
    });
  });
});

describe("resolveSpanCollapseSettings", () => {
  it("applies the defaults when nothing is configured", () => {
    expect(resolveSpanCollapseSettings(undefined)).toEqual(
      DEFAULT_SPAN_COLLAPSE,
    );
    expect(resolveSpanCollapseSettings({})).toEqual(DEFAULT_SPAN_COLLAPSE);
  });

  it("switches collapsing off with `false`", () => {
    expect(resolveSpanCollapseSettings(false)).toBeUndefined();
  });

  it("takes the configured values", () => {
    expect(
      resolveSpanCollapseSettings({ threshold: 50, keepSlowest: 0 }),
    ).toEqual({ threshold: 50, keepSlowest: 0 });
  });

  it("falls back per field on an unusable value rather than disabling", () => {
    expect(
      resolveSpanCollapseSettings({ threshold: 0, keepSlowest: 1.5 }),
    ).toEqual(DEFAULT_SPAN_COLLAPSE);
    expect(
      resolveSpanCollapseSettings({ threshold: -1, keepSlowest: NaN }),
    ).toEqual(DEFAULT_SPAN_COLLAPSE);
  });
});
