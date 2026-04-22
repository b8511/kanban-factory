import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { projectsRouter } from './routes/projects.js';
import { tasksRouter } from './routes/tasks.js';
import { runRouter } from './routes/run.js';
import { ideasRouter } from './routes/ideas.js';
import { attachWebSocket } from './ws.js';

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/projects', projectsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/ideas', ideasRouter);
app.use('/api', runRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] unhandled', err);
  res.status(500).json({ error: err.message });
});

const server = http.createServer(app);
attachWebSocket(server);

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] websocket at ws://localhost:${PORT}/ws`);
});
