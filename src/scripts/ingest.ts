import { ragEngine } from "../rag/engine.ts";

async function runIngestion() {
  console.log("🔄 Indexing knowledge/ folder (FAQs + Markdown documents)...");
  const start = performance.now();
  const status = await ragEngine.reloadIndex();
  const elapsed = (performance.now() - start).toFixed(1);

  console.log("✅ RAG Ingestion Complete!");
  console.log(`   • Total Indexed Chunks : ${status.chunkCount}`);
  console.log(`   • Indexed FAQs         : ${status.faqCount}`);
  console.log(`   • OpenAI Vectors Ready : ${status.vectorsReady}/${status.chunkCount}`);
  console.log(`   • Time Elapsed         : ${elapsed} ms`);
}

void runIngestion();

