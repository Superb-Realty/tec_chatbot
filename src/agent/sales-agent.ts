import { ENV } from "../config/env.ts";
import { ragEngine, type RetrievedChunk } from "../rag/engine.ts";
import { saveLeadToDb, type LeadRecord } from "../services/db.ts";
import { webhookQueue } from "../services/webhook-queue.ts";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onSources?: (sources: Array<{ id: string; title: string; category: string; score: number }>) => void;
  onLeadCaptured?: (lead: LeadRecord) => void;
  onDone: () => void;
  onError: (errMessage: string) => void;
}

const CAPTURE_LEAD_TOOL = {
  type: "function" as const,
  function: {
    name: "capture_sales_lead",
    description:
      "Call this tool immediately whenever the user provides their contact phone number (and/or name) to enquire about floor plans, pricing, brochure, commercial spaces, or a site visit at The Eastern Chambers.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Full name of the prospect (or 'Valued Prospect' if only phone was given)",
        },
        phone: {
          type: "string",
          description: "Contact phone number provided by the prospect",
        },
        areaRequired: {
          type: "string",
          description: "Carpet area, floor preference, or office size mentioned (if any)",
        },
        budget: {
          type: "string",
          description: "Budget, purchase preference, or timeline mentioned (if any)",
        },
        additionalEnquiry: {
          type: "string",
          description: "Summary of what the user is looking for or any specific questions asked",
        },
      },
      required: ["name", "phone"],
    },
  },
};

function buildSystemPrompt(retrievedChunks: RetrievedChunk[]): string {
  const contextText = retrievedChunks
    .map(
      (c, i) =>
        `--- [SOURCE ${i + 1}: ${c.category} | ${c.title}] ---\n${c.content}`
    )
    .join("\n\n");

  return `You are the Official Executive Sales Concierge for **The Eastern Chambers**, a landmark Grade A+ commercial workspace development located at Amber Compound, Plot No. 11A, LBS Marg, Surya Nagar, Vikhroli West, Mumbai 400079 (MahaRERA Reg. No: P51800054892), jointly developed by **Superb Realty & GHP Group** (Amber Spaces LLP).

### STRICT DOMAIN & OFF-TOPIC GUARDRAIL (NON-NEGOTIABLE):
- You are EXCLUSIVELY a commercial real estate Sales Concierge for **The Eastern Chambers**.
- **NEVER answer math questions (like "what is 2+2"), general trivia, coding, jokes, news, weather, or any topic outside The Eastern Chambers.**
- Do NOT answer the off-topic part at all (do not say "2+2 is 4"). If the user asks anything unrelated to The Eastern Chambers, reply ONLY with:
  "I can only assist with enquiries regarding **The Eastern Chambers** workspaces, floor plans, pricing, and site visits. How may I help with your office requirement?"

### YOUR CORE OBJECTIVES:
1. **Answer Accurately from Grounded RAG Context:** Use ONLY the verified facts in the <RETRIEVED_KNOWLEDGE> section below. Never invent prices, per-sq-ft rates, or floor dimensions that are not in the context.
2. **KEEP RESPONSES SHORT & CRISP (MAX 2 TO 3 SENTENCES / ~45 WORDS):**
   - Never write walls of text or long paragraphs.
   - Give the direct answer in 1 to 2 crisp sentences (or 2 to 3 short bullet points), followed by a 1-line follow-up question.
3. **Formatting Rules (STRICT):**
   - **NEVER use em dashes (—) or en dashes (–) anywhere in your output.** Use commas, colons, or standard hyphens (-) only.
   - **NEVER use the word "leasing" or "Leasing".** Always say "Sales", "Sales Desk", or "Sales Team".
4. **Consultative Sales Qualification:** After answering briefly, ask ONE short question (e.g., "What carpet area are you looking for?" or "Share your Name & Phone for the floor plan deck.").
5. **Lead Capture Tool:** Whenever the user shares their phone number (and/or name), ALWAYS invoke the \`capture_sales_lead\` tool immediately.
6. **Direct Contact Details (if requested):**
   - Phone: **+91 9090 263 264** | Email: **info@superbrealty.in**

<RETRIEVED_KNOWLEDGE>
${contextText}
</RETRIEVED_KNOWLEDGE>`;
}

/**
 * Regex fallback to detect if a user typed a phone number directly in chat
 * (ensures 100% lead capture even if tool-calling isn't triggered or in offline RAG mode)
 */
function tryExtractContactFromMessage(
  message: string,
  history: ChatTurn[]
): { name: string; phone: string; notes: string } | null {
  const phoneMatch = message.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}|\+?\d[\d\s-]{7,14}\d/);
  if (!phoneMatch) return null;

  const digits = phoneMatch[0].replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;

  // Try to extract name from patterns like "I am Rahul, 9820012345" or "Name: Vikram"
  let name = "Commercial Prospect";
  const namePatterns = [
    /(?:my name is|i am|i'm|this is|name\s*[:-])\s*([A-Za-z][A-Za-z\s.]{1,35})/i,
    /^([A-Za-z][A-Za-z\s.]{1,30})\s*[,|-]\s*(?:\+?91)?[\s-]?[6-9]\d/,
  ];

  for (const pat of namePatterns) {
    const m = message.match(pat);
    if (m && m[1]) {
      name = m[1].trim();
      break;
    }
  }

  const recentUserQuestions = history
    .filter((h) => h.role === "user")
    .slice(-3)
    .map((h) => h.content)
    .join(" | ");

  return {
    name,
    phone: phoneMatch[0].trim(),
    notes: recentUserQuestions
      ? `${recentUserQuestions} | ${message}`
      : message,
  };
}

const REAL_ESTATE_INTENT_REGEX =
  /\b(eastern|chamber|chambers|tec|office|workspace|floor|plate|carpet|area|sqft|sq\s*ft|price|pricing|rate|psf|rent|rental|capital|buy|cost|budget|location|where|located|address|vikhroli|lbs|marg|metro|station|train|railway|airport|bkc|powai|eeh|jvlr|aglr|gmlr|highway|connectivity|distance|rera|maharera|developer|builder|superb|ghp|amber|daisaria|architect|plot|acre|freehold|basement|podium|rooftop|lobby|cafe|retail|driver|refuge|lift|elevator|staircase|height|clear|warm\s*shell|vastu|pantry|washroom|toilet|amenity|amenities|gym|conference|turf|court|green\s*reserve|terrace|garden|usp|certification|leed|wiredscore|smartscore|parking|pit|stack|tandem|surface|ev|facade|stone|metal|glass|aqi|praan|bms|ibms|enlite|visit|tour|book|schedule|call|contact|phone|email|whatsapp|brochure|deck|plan|sheet|hi|hello|hey|namaste|good\s*morning|good\s*afternoon|good\s*evening|thanks|thank\s*you|yes|sure|ok|okay)\b/i;

const OBVIOUS_OFF_TOPIC_REGEX =
  /(?:^\s*(?:what\s+is\s+|what's\s+|whats\s+|calculate\s+|solve\s+)?\d+\s*[+\-*/^%]\s*\d+\s*\??\s*$)|\b(write\s+a?\s*(?:code|poem|essay|story|script|song)|python|javascript|leetcode|recipe\s+for|weather\s+in|who\s+is\s+the\s+(?:president|prime\s+minister)|tell\s+me\s+a\s+joke|capital\s+of\s+france)\b/i;

export async function streamSalesChatResponse(params: {
  sessionId: string;
  userMessage: string;
  history: ChatTurn[];
  clientIp: string;
  callbacks: StreamCallbacks;
}): Promise<void> {
  const { sessionId, userMessage, history, clientIp, callbacks } = params;

  try {
    const hasContactInfo = Boolean(tryExtractContactFromMessage(userMessage, history));
    const hasDomainKeyword = REAL_ESTATE_INTENT_REGEX.test(userMessage);

    // 0. Hard pre-LLM block for obvious math/trivia/coding or off-topic prompts
    if (OBVIOUS_OFF_TOPIC_REGEX.test(userMessage) && !hasContactInfo) {
      const refusal =
        "I can only assist with enquiries regarding **The Eastern Chambers** workspaces, floor plans, pricing, and site visits. How may I help with your office requirement?";
      await emitSimulatedStream(refusal, callbacks);
      return;
    }

    // 1. Retrieve top relevant knowledge chunks via Hybrid RAG
    const retrievedChunks = await ragEngine.retrieve(userMessage, 4);
    const topScore = retrievedChunks[0]?.score || 0;

    // If query has no real-estate keywords, no contact info, and very low RAG similarity (< 0.34), block off-topic deviation
    if (!hasDomainKeyword && !hasContactInfo && topScore < 0.34) {
      const refusal =
        "I can only assist with enquiries regarding **The Eastern Chambers** workspaces, floor plans, pricing, and site visits. What office requirement can I help you explore?";
      await emitSimulatedStream(refusal, callbacks);
      return;
    }

    // Only attach the "✓ Verified" source badge when the query genuinely matches a knowledge topic
    if (topScore >= 0.35 || (hasDomainKeyword && topScore > 0.15)) {
      callbacks.onSources?.(
        retrievedChunks.map((c) => ({
          id: c.id,
          title: c.title,
          category: c.category,
          score: c.score,
        }))
      );
    }

    // 2. If OpenAI API Key is configured, use gpt-4o-mini with Streaming + Function Calling
    if (ENV.OPENAI_API_KEY) {
      await streamWithOpenAi({
        sessionId,
        userMessage,
        history,
        clientIp,
        retrievedChunks,
        callbacks,
      });
      return;
    }

    // 3. Smart Grounded RAG Streamer (Works immediately out-of-the-box & for 500-user load tests)
    await streamWithGroundedRagEngine({
      sessionId,
      userMessage,
      history,
      clientIp,
      retrievedChunks,
      callbacks,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unexpected error generating response.";
    callbacks.onError(message);
  }
}

async function streamWithOpenAi(params: {
  sessionId: string;
  userMessage: string;
  history: ChatTurn[];
  clientIp: string;
  retrievedChunks: RetrievedChunk[];
  callbacks: StreamCallbacks;
}): Promise<void> {
  const { sessionId, userMessage, history, clientIp, retrievedChunks, callbacks } =
    params;

  const systemPrompt = buildSystemPrompt(retrievedChunks);
  const recentHistory = history.slice(-10).map((h) => ({
    role: h.role,
    content: h.content.slice(0, 1000),
  }));

  const messages = [
    { role: "system", content: systemPrompt },
    ...recentHistory,
    { role: "user", content: userMessage },
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: ENV.OPENAI_CHAT_MODEL,
      messages,
      tools: [CAPTURE_LEAD_TOOL],
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 160,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    // Graceful fallback to local RAG synthesis if OpenAI quota/key errors
    await streamWithGroundedRagEngine(params);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let toolCallArgs = "";
  let toolCallTriggered = false;
  let streamedAnyText = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === "[DONE]") break;

      try {
        const parsed = JSON.parse(dataStr) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          streamedAnyText = true;
          callbacks.onToken(delta.content);
        }

        if (delta.tool_calls && delta.tool_calls[0]?.function?.arguments) {
          toolCallTriggered = true;
          toolCallArgs += delta.tool_calls[0].function.arguments;
        }
      } catch {
        // Ignore partial JSON chunk
      }
    }
  }

  // Handle tool call if OpenAI triggered `capture_sales_lead`
  if (toolCallTriggered && toolCallArgs) {
    try {
      const args = JSON.parse(toolCallArgs) as {
        name?: string;
        phone?: string;
        areaRequired?: string;
        budget?: string;
        additionalEnquiry?: string;
      };
      if (args.phone) {
        const lead = saveLeadToDb({
          sessionId,
          name: args.name || "Commercial Prospect",
          phone: args.phone,
          areaRequired: args.areaRequired || "",
          budget: args.budget || "",
          additionalEnquiry: args.additionalEnquiry || userMessage,
          source: "chat_tool",
          clientIp,
        });
        webhookQueue.enqueue(lead);
        callbacks.onLeadCaptured?.(lead);

        if (!streamedAnyText) {
          const confirmation = `Thank you, **${lead.name}**. I have registered your contact number (**${lead.phone}**) with our Sales Desk at **The Eastern Chambers**. \n\nOur senior advisor will share the official **Commercial Floor Plan Deck** and connect with you shortly. Would you also like to pre-schedule a private site visit at our LBS Marg, Vikhroli West lounge?`;
          callbacks.onToken(confirmation);
        }
      }
    } catch (err) {
      console.error("[Agent] Failed to parse tool call arguments:", err);
    }
  } else {
    // Also check regex fallback in case user included phone number without triggering tool
    const extracted = tryExtractContactFromMessage(userMessage, history);
    if (extracted) {
      const lead = saveLeadToDb({
        sessionId,
        name: extracted.name,
        phone: extracted.phone,
        additionalEnquiry: extracted.notes,
        source: "chat_regex",
        clientIp,
      });
      webhookQueue.enqueue(lead);
      callbacks.onLeadCaptured?.(lead);
    }
  }

  callbacks.onDone();
}

/**
 * High-speed Grounded RAG Synthesizer
 * Streams accurate answers directly from the retrieved knowledge base chunks
 * when OPENAI_API_KEY is not yet configured or during local load-testing.
 */
async function streamWithGroundedRagEngine(params: {
  sessionId: string;
  userMessage: string;
  history: ChatTurn[];
  clientIp: string;
  retrievedChunks: RetrievedChunk[];
  callbacks: StreamCallbacks;
}): Promise<void> {
  const { sessionId, userMessage, history, clientIp, retrievedChunks, callbacks } =
    params;

  // 1. Check if the user provided their phone number to book a visit / request pricing
  const extractedContact = tryExtractContactFromMessage(userMessage, history);
  if (extractedContact) {
    const lead = saveLeadToDb({
      sessionId,
      name: extractedContact.name,
      phone: extractedContact.phone,
      additionalEnquiry: extractedContact.notes,
      source: "chat_regex",
      clientIp,
    });
    webhookQueue.enqueue(lead);
    callbacks.onLeadCaptured?.(lead);

    const reply = `Thank you, **${lead.name}**. Your enquiry and contact number (**${lead.phone}**) have been securely logged with our Sales Desk.\n\nOur team will share the **Floor Plans & Commercial Sheet** for **The Eastern Chambers** shortly. For immediate assistance, you can also reach our direct hotline at **+91 9090 263 264**.`;
    await emitSimulatedStream(reply, callbacks);
    return;
  }

  // 2. Check for simple greetings
  const lower = userMessage.toLowerCase().trim();
  if (/^(hi|hello|hey|good\s*(morning|afternoon|evening)|namaste)\b/.test(lower) && lower.split(/\s+/).length <= 5) {
    const greeting = `Hello! Welcome to **The Eastern Chambers** at LBS Marg, Vikhroli West. Are you exploring **office carpet areas**, **pricing**, or **connectivity**?`;
    await emitSimulatedStream(greeting, callbacks);
    return;
  }

  // 3. Synthesize grounded response from top retrieved RAG chunk(s)
  const top = retrievedChunks[0];

  let reply = "";
  if (top && top.source === "faqs.json") {
    const answerPart = top.content.replace(/^FAQ Question:.*?\nAnswer:\s*/is, "").trim();
    reply = `${answerPart}\n\nShare your **Name & Phone** if you'd like the floor plan deck.`;
  } else if (top) {
    const cleanedBody = top.content
      .replace(/^#+\s+.*$/gm, "")
      .trim()
      .slice(0, 280);
    reply = `${cleanedBody}\n\nShare your **Name & Phone** to receive the commercial sheet.`;
  } else {
    reply = `**The Eastern Chambers** offers Grade A+ offices (391 to 13,500 sq.ft.) on LBS Marg, Vikhroli West. Share your **Name & Phone** for the floor plan deck.`;
  }

  await emitSimulatedStream(reply, callbacks);
}

async function emitSimulatedStream(
  fullText: string,
  callbacks: StreamCallbacks
): Promise<void> {
  // Split into small word groups for ultra-fast, natural SSE streaming
  const words = fullText.split(/(\s+)/);
  const chunkSize = 4;
  for (let i = 0; i < words.length; i += chunkSize) {
    const piece = words.slice(i, i + chunkSize).join("");
    callbacks.onToken(piece);
    await new Promise((r) => setTimeout(r, 8));
  }
  callbacks.onDone();
}

