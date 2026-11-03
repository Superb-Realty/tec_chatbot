// Offline check: the chatbot must answer only from the knowledge base and
// hand off to the Sales Team for anything it can't find there.
// Usage: OPENAI_API_KEY= SUPABASE_URL= node --no-warnings src/scripts/test-grounding.ts
import { ragEngine } from "../rag/engine.ts";
import { streamSalesChatResponse } from "../agent/sales-agent.ts";

const questions = [
  "How many lifts are there?",
  "date of possesion",
  "Is there a swimming pool?",
  "Who won the cricket world cup?",
  "What is the floor to floor height?",
];

await ragEngine.initialize();

for (const q of questions) {
  let out = "";
  await streamSalesChatResponse({
    sessionId: "grounding-test",
    userMessage: q,
    history: [],
    clientIp: "127.0.0.1",
    callbacks: {
      onToken: (t) => (out += t),
      onDone: () => {},
      onError: (e) => (out += `[ERROR] ${e}`),
    },
  });
  console.log(`\nQ: ${q}\nA: ${out.trim()}\n${"-".repeat(60)}`);
}
process.exit(0);
