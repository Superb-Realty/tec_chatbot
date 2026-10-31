# How to Add or Update FAQs & Knowledge Documents

The RAG (Retrieval-Augmented Generation) engine automatically indexes everything in this `knowledge/` folder:

## 1. Adding FAQs (`knowledge/faqs.json`)
Simply open `knowledge/faqs.json` and add a new object to the JSON array:
```json
{
  "id": "faq-custom-topic",
  "category": "Pricing & Payment Plans",
  "question": "What are the payment terms or possession timelines?",
  "answer": "Write the official answer here...",
  "tags": ["payment", "possession", "timeline", "handover"]
}
```

## 2. Adding Markdown Documents (`knowledge/*.md`)
Drop any `.md` or `.txt` file (such as a floor-plate table, pricing sheet, or brochure transcript) into `knowledge/`. The chunker splits by `##` headings and indexes each section automatically.

## 3. Re-indexing
- **Automatic in Dev / Live Watch:** While the backend is running, editing any file inside `knowledge/` automatically triggers a hot re-index within 1 second.
- **Manual CLI Command:** Run `npm run ingest` inside `TEC-chatbot-backend` to pre-compute OpenAI vector embeddings (`text-embedding-3-small`) and save them to `data/vector-index.json`.
- **Admin API Endpoint:** Send `POST http://localhost:4000/api/rag/reload` to force an instant re-index without restarting the server.

