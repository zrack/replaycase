import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";

import { expect, it } from "vitest";

import { createHttpServerDrain } from "./http-server-drain.mjs";

async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP drain exceeded its test deadline.")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("flushes every pipelined response before draining an active connection", async () => {
  const responses = [];
  let requestsArrived;
  const requestsReady = new Promise((resolve) => { requestsArrived = resolve; });
  const server = createServer((_request, response) => {
    responses.push(response);
    if (responses.length === 2) requestsArrived();
  });
  const drain = createHttpServerDrain(server);
  let client;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test HTTP port.");
    client = createConnection({ host: "127.0.0.1", port: address.port });
    await once(client, "connect");
    let body = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => { body += chunk; });
    const received = once(client, "end");
    client.write("GET /first HTTP/1.1\r\nHost: localhost\r\n\r\nGET /second HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await within(requestsReady, 2_000);

    const closed = drain.close();
    expect(drain.close()).toBe(closed);
    // End the queued response first so a premature drain would truncate it.
    responses[1].end("second-response");
    responses[0].end("first-response");
    await within(Promise.all([closed, received]), 2_000);
    expect(body.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    expect(body).toContain("first-response");
    expect(body).toContain("second-response");
    expect(body.indexOf("first-response")).toBeLessThan(body.indexOf("second-response"));
  } finally {
    client?.destroy();
    for (const response of responses) response.destroy();
    await drain.close();
  }
});
