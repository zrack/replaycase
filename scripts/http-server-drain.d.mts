import type { Server } from "node:http";

export interface HttpServerDrain {
  close(): Promise<void>;
}

export function createHttpServerDrain(server: Server): HttpServerDrain;
