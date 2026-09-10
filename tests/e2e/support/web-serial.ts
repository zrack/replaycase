import type { Page } from "@playwright/test";

export interface MockWebSerialSnapshot {
  requestedPorts: number;
  openedWith: Array<{
    baudRate: number;
    bufferSize: number;
    dataBits: number;
    flowControl: string;
    parity: string;
    stopBits: number;
  }>;
  emittedReads: number;
  emittedBytes: number;
  readerCancellations: number;
  portCloses: number;
}

interface MockWebSerialHarness {
  emit(bytes: number[]): void;
  snapshot(): MockWebSerialSnapshot;
}

type MockWebSerialGlobal = typeof globalThis & {
  __narrowslinkSerialMock?: MockWebSerialHarness;
};

export interface MockWebSerialController {
  emit(bytes: Uint8Array): Promise<void>;
  snapshot(): Promise<MockWebSerialSnapshot>;
}

/**
 * Installs the smallest browser-facing Web Serial surface used by ReplayCase.
 * The stream intentionally remains open until the application cancels its
 * reader so a clean operator stop is not mistaken for a device disconnect.
 */
export async function installMockWebSerial(page: Page): Promise<MockWebSerialController> {
  await page.addInitScript(() => {
    const state: MockWebSerialSnapshot = {
      requestedPorts: 0,
      openedWith: [],
      emittedReads: 0,
      emittedBytes: 0,
      readerCancellations: 0,
      portCloses: 0,
    };
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let cancelled = false;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
        state.readerCancellations += 1;
      },
    });
    const port = {
      readable,
      async open(options: MockWebSerialSnapshot["openedWith"][number]) {
        state.openedWith.push({ ...options });
      },
      async close() {
        state.portCloses += 1;
      },
      getInfo() {
        return { usbVendorId: 0x1209, usbProductId: 0x0001 };
      },
    };
    const serial = {
      async requestPort() {
        state.requestedPorts += 1;
        return port;
      },
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      enumerable: true,
      value: serial,
    });
    (globalThis as MockWebSerialGlobal).__narrowslinkSerialMock = {
      emit(bytes) {
        if (!streamController || cancelled) throw new Error("The mock serial stream is not writable.");
        const chunk = Uint8Array.from(bytes);
        state.emittedReads += 1;
        state.emittedBytes += chunk.byteLength;
        streamController.enqueue(chunk);
      },
      snapshot() {
        return structuredClone(state);
      },
    };
  });

  return {
    async emit(bytes) {
      await page.evaluate((values) => {
        const harness = (globalThis as MockWebSerialGlobal).__narrowslinkSerialMock;
        if (!harness) throw new Error("The mock Web Serial harness was not installed.");
        harness.emit(values);
      }, [...bytes]);
    },
    async snapshot() {
      return page.evaluate(() => {
        const harness = (globalThis as MockWebSerialGlobal).__narrowslinkSerialMock;
        if (!harness) throw new Error("The mock Web Serial harness was not installed.");
        return harness.snapshot();
      });
    },
  };
}
