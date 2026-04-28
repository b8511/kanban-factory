/**
 * Detect a policy-refusal from an agent's final text output.
 *
 * Heuristic: match common Claude refusal phrases, but ONLY when no tool calls
 * happened. If the agent actually wrote files / ran commands, any "I can't help
 * with X" phrase in its summary is just an awkward preamble, not a refusal.
 */
export interface RefusalSignal {
  refused: boolean;
  matched?: string;
}

const REFUSAL_PATTERNS: string[] = [
  "i can't help with",
  "i cannot help with",
  "i won't",
  "i will not",
  "i'm unable to",
  "i am unable to",
  "i'm not able to",
  "i am not able to",
  "i decline to",
  "i cannot assist",
  "i can't assist",
  "unable to help",
  "policy grounds",
  "against my guidelines",
  "violates policy",
  "not comfortable",
  "won't write this",
  "can't write this",
  "cannot write this",
  "can't generate",
  "cannot generate",
  "i refuse",
];

export function detectRefusal(
  text: string,
  opts: { toolCount: number }
): RefusalSignal {
  if (opts.toolCount > 0) return { refused: false };
  if (!text) return { refused: false };
  const lower = text.toLowerCase();
  for (const p of REFUSAL_PATTERNS) {
    if (lower.includes(p)) return { refused: true, matched: p };
  }
  return { refused: false };
}

export class ArchitectRefusalError extends Error {
  matched: string;
  rawText: string;
  constructor(matched: string, rawText: string) {
    super(`Architect refused on policy grounds ("${matched}"): ${rawText.slice(0, 300)}`);
    this.name = 'ArchitectRefusalError';
    this.matched = matched;
    this.rawText = rawText;
  }
}
