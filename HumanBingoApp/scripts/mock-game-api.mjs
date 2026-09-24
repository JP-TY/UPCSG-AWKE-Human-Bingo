import { createServer } from 'node:http';
import { createGameSnapshot, gameId } from '../tests/fixtures/game-snapshot.mjs';

let snapshot = createGameSnapshot();
let lastCommand = null;

const sendJson = (response, status, value) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (url.pathname === '/test/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (url.pathname === '/test/reset' && request.method === 'POST') {
    snapshot = createGameSnapshot();
    lastCommand = null;
    sendJson(response, 200, { status: 'reset' });
    return;
  }
  if (url.pathname === '/test/last-command') {
    sendJson(response, 200, { command: lastCommand });
    return;
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    sendJson(response, 200, { csrfToken: 'mock-csrf-token' });
    return;
  }
  if (url.pathname === `/api/games/${gameId}/snapshot` && request.method === 'GET') {
    sendJson(response, 200, { snapshot });
    return;
  }
  if (url.pathname === `/api/games/${gameId}/verification-requests` && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    lastCommand = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const square = snapshot.grid.squares[lastCommand.squareIndex];
    if (square) square.status = 'pending';
    snapshot.game.stateVersion += 1;
    snapshot.grid.stateVersion += 1;
    snapshot.stateVersion += 1;
    sendJson(response, 201, { stateVersion: snapshot.stateVersion });
    return;
  }
  sendJson(response, 404, { error: { message: 'Mock route not found' } });
});

server.listen(3013, '127.0.0.1');
server.on('error', (error) => {
  console.error('[mock-game-api] failed to listen', error);
  process.exitCode = 1;
});
