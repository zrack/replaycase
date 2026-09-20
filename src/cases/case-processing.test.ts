import { describe, expect, it, vi } from "vitest";
import { newCaseContent } from "../domain/case";
import { processCase, type CaseResponse } from "./case-processing";

function fakeWorker() {
  return {
    terminate: vi.fn(),
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent<CaseResponse>) => void) | null,
    onerror: null,
    onmessageerror: null,
  };
}
const request = () => ({
  kind: "build" as const,
  content: newCaseContent(
    "Test",
    "155a668b-e850-4bfc-9bd8-95a83f53c280",
    "2026-09-19T12:00:00.000Z",
  ),
  bundles: [],
});
describe("case worker client", () => {
  it("cancels before starting without touching the worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const factory = vi.fn();
    await expect(
      processCase(request(), { signal: controller.signal }, factory),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
  });
  it("terminates on cancellation and ignores late results", async () => {
    const worker = fakeWorker();
    const controller = new AbortController();
    const promise = processCase(
      request(),
      { signal: controller.signal },
      () => worker as unknown as Worker,
    );
    controller.abort();
    worker.onmessage?.({
      data: { type: "error", message: "late failure" },
    } as MessageEvent<CaseResponse>);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("rejects nonmonotonic progress and out-of-order chunks", async () => {
    const worker = fakeWorker();
    const promise = processCase(
      request(),
      {},
      () => worker as unknown as Worker,
    );
    worker.onmessage?.({
      data: { type: "progress", percent: 50, message: "Verifying" },
    } as MessageEvent<CaseResponse>);
    worker.onmessage?.({
      data: { type: "progress", percent: 5, message: "Backwards" },
    } as MessageEvent<CaseResponse>);
    await expect(promise).rejects.toThrow(/progress/);
    const next = fakeWorker();
    const failed = processCase(request(), {}, () => next as unknown as Worker);
    next.onmessage?.(
      new MessageEvent<CaseResponse>("message", {
        data: {
          type: "chunk",
          index: 0,
          key: "rawRecords",
          offset: 1,
          values: [],
        },
      }),
    );
    await expect(failed).rejects.toThrow(/out of order/);
  });
});
