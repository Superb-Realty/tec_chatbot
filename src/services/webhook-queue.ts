import { ENV } from "../config/env.ts";
import { type LeadRecord, updateLeadSyncStatus } from "./db.ts";

interface QueueItem {
  lead: LeadRecord;
  attempts: number;
}

/**
 * Non-blocking Background Webhook Queue
 * Ensures that even if 500 users submit leads at the exact same second,
 * the chat response returns in <5ms while Google Apps Script receives
 * serialized requests with automatic exponential backoff retries.
 */
class GoogleSheetWebhookQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;

  public enqueue(lead: LeadRecord): void {
    this.queue.push({ lead, attempts: 0 });
    void this.drain();
  }

  public getPendingCount(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const success = await this.sendToGoogleSheet(item.lead);

      if (!success && item.attempts < 3) {
        item.attempts += 1;
        const backoffMs = 1500 * Math.pow(2, item.attempts - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
        this.queue.push(item);
      }

      // Gentle 250ms pacing so Google Apps Script LockService never collides
      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    this.isProcessing = false;
  }

  private async sendToGoogleSheet(lead: LeadRecord): Promise<boolean> {
    const webhookUrl = ENV.GOOGLE_SHEET_WEBHOOK_URL;
    if (!webhookUrl || !webhookUrl.startsWith("http")) {
      updateLeadSyncStatus(lead.id, false, "Webhook URL not configured");
      return true;
    }

    try {
      const timestamp = new Date(lead.createdAt).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      });

      const payload = {
        timestamp,
        name: lead.name,
        phone: lead.phone,
        areaRequired: lead.areaRequired || "Via AI Sales Concierge",
        budget: lead.budget || "To be discussed",
        additionalEnquiry: `[AI Chatbot Lead | ${lead.source}] ${lead.additionalEnquiry}`.trim(),
        secretToken: ENV.ENQUIRY_SECRET_TOKEN,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Enquiry-Secret": ENV.ENQUIRY_SECRET_TOKEN,
        },
        body: JSON.stringify(payload),
        redirect: "follow",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        updateLeadSyncStatus(lead.id, false, `HTTP ${response.status}`);
        return false;
      }

      const resJson = (await response.json().catch(() => null)) as
        | { status?: string; message?: string }
        | null;

      if (resJson && resJson.status === "error") {
        updateLeadSyncStatus(lead.id, false, resJson.message || "Sheet rejected");
        return false;
      }

      updateLeadSyncStatus(lead.id, true, null);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Network error";
      updateLeadSyncStatus(lead.id, false, msg);
      return false;
    }
  }
}

export const webhookQueue = new GoogleSheetWebhookQueue();

