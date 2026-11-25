/** Drain accepted HTTP sockets without cutting off queued responses. */
export function createHttpServerDrain(server) {
  const connections = new Map();
  let closing = false;
  let closePromise = null;

  function drainIfReady(socket, connection) {
    if (!closing || connection.draining || connection.responses.size > 0 || socket.destroyed) return;
    connection.draining = true;
    socket.destroySoon();
  }

  function trackConnection(socket) {
    let connection = connections.get(socket);
    if (!connection) {
      connection = { responses: new Set(), draining: false };
      connections.set(socket, connection);
      socket.once("close", () => connections.delete(socket));
    }
    return connection;
  }

  server.on("connection", (socket) => {
    const connection = trackConnection(socket);
    drainIfReady(socket, connection);
  });
  server.prependListener("request", (request, response) => {
    const connection = trackConnection(request.socket);
    connection.responses.add(response);
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      response.off("finish", release);
      response.off("close", release);
      connection.responses.delete(response);
      drainIfReady(request.socket, connection);
    };
    response.once("finish", release);
    response.once("close", release);
  });

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = server.listening
      ? new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        })
      : Promise.resolve();
    // Node does not classify preconnect/partial-header sockets as idle. Also
    // keep watching responses that finish after server.close()'s idle scan.
    for (const [socket, connection] of connections) drainIfReady(socket, connection);
    return closePromise;
  }

  return { close };
}
