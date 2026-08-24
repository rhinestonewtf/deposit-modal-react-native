import { describe, expect, it, vi } from "vitest";

import { createDepositWatch, isTerminal, type DepositRow } from "./deposit-watch";
import { VERSION_HEADER } from "./version";

const BACKEND = "https://proxy.example/deposit";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

function row(txHash: string, status: string): DepositRow {
  return { txHash, status };
}

/** Answers each poll from a queue, so a test reads as a sequence of backends. */
function stubFetch(pages: DepositRow[][]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (url: unknown, init?: unknown) => {
    calls.push({
      url: String(url),
      headers: ((init as { headers?: Record<string, string> })?.headers ??
        {}) as Record<string, string>,
    });
    const deposits = pages[Math.min(index, pages.length - 1)] ?? [];
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ deposits }),
    } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function watchOver(pages: DepositRow[][], onSettled: (d: DepositRow) => void) {
  const { fetchImpl, calls } = stubFetch(pages);
  const watch = createDepositWatch({
    backendUrl: BACKEND,
    recipient: RECIPIENT,
    versionHeader: "0.13.0 (ios; Acme/2.1.0)",
    onSettled,
    fetchImpl,
  });
  return { watch, calls };
}

describe("the baseline pass", () => {
  it("says nothing about deposits that were already finished", async () => {
    const settled: DepositRow[] = [];
    const { watch } = watchOver([[row("0xaa", "completed")]], (d) =>
      settled.push(d),
    );

    await watch.poll();
    await watch.poll();

    expect(settled).toEqual([]);
  });

  it("still reports one that was in flight when the watch started", async () => {
    const settled: DepositRow[] = [];
    const { watch } = watchOver(
      [[row("0xbb", "processing")], [row("0xbb", "completed")]],
      (d) => settled.push(d),
    );

    await watch.poll();
    expect(settled).toEqual([]);

    await watch.poll();
    expect(settled.map((d) => d.txHash)).toEqual(["0xbb"]);
  });
});

describe("a deposit the page never saw finish", () => {
  it("reports one that both started and settled while the web view was dead", async () => {
    const settled: DepositRow[] = [];
    const { watch } = watchOver(
      [[], [row("0xcc", "completed")]],
      (d) => settled.push(d),
    );

    await watch.poll();
    await watch.poll();

    expect(settled.map((d) => d.txHash)).toEqual(["0xcc"]);
  });

  it("reports it once, however many polls see it", async () => {
    const settled: DepositRow[] = [];
    const { watch } = watchOver(
      [[], [row("0xdd", "completed")], [row("0xdd", "completed")]],
      (d) => settled.push(d),
    );

    await watch.poll();
    await watch.poll();
    await watch.poll();

    expect(settled).toHaveLength(1);
  });

  it("counts a refund and a failure as finished too", async () => {
    const settled: DepositRow[] = [];
    const { watch } = watchOver(
      [[], [row("0xee", "failed"), row("0xff", "refunded")]],
      (d) => settled.push(d),
    );

    await watch.poll();
    await watch.poll();

    expect(settled.map((d) => d.txHash).sort()).toEqual(["0xee", "0xff"]);
  });
});

describe("a status nobody has seen before", () => {
  it("is treated as in flight rather than as a completion", () => {
    expect(isTerminal("settling-on-a-new-rail")).toBe(false);
    expect(isTerminal("COMPLETED")).toBe(true);
  });
});

describe("the request itself", () => {
  it("carries the version header the page's own calls carry", async () => {
    const { watch, calls } = watchOver([[]], () => undefined);
    await watch.poll();

    expect(calls[0]?.headers[VERSION_HEADER]).toBe("0.13.0 (ios; Acme/2.1.0)");
    expect(calls[0]?.url).toContain(`recipient=${RECIPIENT}`);
  });

  it("reports a failure and keeps going", async () => {
    const errors: unknown[] = [];
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 502 }) as unknown as Response,
    );
    const watch = createDepositWatch({
      backendUrl: BACKEND,
      recipient: RECIPIENT,
      versionHeader: "0.13.0 (ios)",
      onSettled: () => expect.unreachable("nothing settled"),
      onError: (error) => errors.push(error),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await watch.poll();
    await watch.poll();

    expect(errors).toHaveLength(2);
  });
});
