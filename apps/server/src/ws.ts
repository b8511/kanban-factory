import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { AgentEvent } from './types.js';

let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
  });
}

export function broadcast(event: Omit<AgentEvent, 'at'> & { at?: string }): void {
  if (!wss) return;
  const message = JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
