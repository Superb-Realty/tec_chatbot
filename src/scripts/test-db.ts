import { ENV } from "../config/env.ts";
import { ragEngine } from "../rag/engine.ts";
import { getRecentLeads } from "../services/db.ts";

async function verifyDatabaseConnection() {
  console.log("==================================================================");
  console.log("🔍 TESTING SUPABASE CLOUD DB & PGVECTOR CONNECTION");
  console.log("==================================================================");

  if (!ENV.SUPABASE_ENABLED) {
    console.log("⚠️  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set yet in TEC-chatbot-backend/.env");
    console.log("   1. Open: TEC-chatbot-backend/.env");
    console.log("   2. Replace SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY with your keys from Supabase.");
    console.log("   3. Run: npm run test-db");
    process.exit(1);
  }

  console.log(`✅ Found SUPABASE_URL: ${ENV.SUPABASE_URL}`);
  console.log("🔄 Step 1: Syncing RAG Knowledge Base & FAQs to Supabase...");
  const status = await ragEngine.reloadIndex();
  console.log(`   • Indexed ${status.chunkCount} chunks (${status.faqCount} FAQs)`);

  console.log("🔄 Step 2: Testing Hybrid Search RPC (`match_tec_knowledge_hybrid`)...");
  const results = await ragEngine.retrieve("Is the project MahaRERA registered?", 2);
  console.log(`   • Top Match: "${results[0]?.title}" (Score: ${results[0]?.score})`);

  console.log("🔄 Step 3: Checking `tec_sales_leads` Table...");
  const leads = await getRecentLeads(5);
  console.log(`   • Connected to tec_sales_leads! Recent leads found: ${leads.length}`);

  console.log("==================================================================");
  console.log("🎉 SUCCESS! Your Supabase Database + pgvector is 100% connected!");
  console.log("==================================================================");
}

void verifyDatabaseConnection();

