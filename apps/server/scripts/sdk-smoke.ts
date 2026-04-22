import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is not set. Put it in .env');
    process.exit(1);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-smoke-'));
  console.log(`→ scratch folder: ${scratch}`);

  const stream = query({
    prompt:
      "Create a file named hello.txt in the current directory containing exactly the text 'hello world' (no newline). Then reply with the single word DONE.",
    options: {
      cwd: scratch,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      persistSession: false,
      settingSources: [],
    },
  });

  let lastText = '';
  let turns = 0;
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      turns++;
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text') lastText = block.text;
          if (block?.type === 'tool_use') {
            console.log(`  tool_use: ${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
          }
        }
      }
    } else if (msg.type === 'result') {
      const r = msg as any;
      if (r.result) lastText = r.result;
      console.log(`← result (is_error=${r.is_error}):`, String(r.result).slice(0, 200));
    } else {
      console.log(`  [${msg.type}]`);
    }
  }

  const filePath = path.join(scratch, 'hello.txt');
  const exists = fs.existsSync(filePath);
  const contents = exists ? fs.readFileSync(filePath, 'utf8') : '(missing)';

  console.log('—');
  console.log(`turns: ${turns}`);
  console.log(`final text: ${lastText.slice(0, 200)}`);
  console.log(`hello.txt exists: ${exists}`);
  console.log(`hello.txt contents: ${JSON.stringify(contents)}`);

  if (!exists) {
    console.error('❌ SDK did not create the file');
    process.exit(2);
  }
  console.log('✓ SDK smoke passed');
}

main().catch((err) => {
  console.error('❌ smoke failed:', err);
  process.exit(1);
});
