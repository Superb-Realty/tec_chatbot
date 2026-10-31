import { ENV } from "../config/env.ts";

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Concurrency & Rate-Limiting Guardrails designed for 500+ Simultaneous Users
 * 1. Global Active Stream Semaphore (protects server memory under extreme spikes)
 * 2. Per-Session / Per-IP Token Bucket (prevents automated spam bots)
 * 3. Prompt Injection & Payload Sanitizer
 */
class ConcurrencyAndRateGuard {
  private buckets = new Map<string, RateBucket>();
  private activeStreams = 0;
  private totalRequestsServed = 0;
  private peakConcurrentStreams = 0;

  constructor() {
    // Periodic cleanup of expired rate-limit buckets every 60s
    setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets.entries()) {
        if (now > bucket.resetAt) {
          this.buckets.delete(key);
        }
      }
    }, 60_000).unref();
  }

  public checkRateLimit(identifier: string): {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds?: number;
  } {
    const now = Date.now();
    const windowMs = ENV.RATE_LIMIT_WINDOW_MS;
    const maxReqs = ENV.RATE_LIMIT_MAX_MESSAGES_PER_IP;

    const bucket = this.buckets.get(identifier);
    if (!bucket || now > bucket.resetAt) {
      this.buckets.set(identifier, {
        count: 1,
        resetAt: now + windowMs,
      });
      return { allowed: true, remaining: maxReqs - 1 };
    }

    if (bucket.count >= maxReqs) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000)
      );
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.count += 1;
    return { allowed: true, remaining: maxReqs - bucket.count };
  }

  public acquireStreamSlot(): boolean {
    if (this.activeStreams >= ENV.MAX_CONCURRENT_STREAMS) {
      return false;
    }
    this.activeStreams += 1;
    this.totalRequestsServed += 1;
    if (this.activeStreams > this.peakConcurrentStreams) {
      this.peakConcurrentStreams = this.activeStreams;
    }
    return true;
  }

  public releaseStreamSlot(): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
  }

  public getMetrics() {
    return {
      activeStreams: this.activeStreams,
      peakConcurrentStreams: this.peakConcurrentStreams,
      maxConcurrentCapacity: ENV.MAX_CONCURRENT_STREAMS,
      totalRequestsServed: this.totalRequestsServed,
      trackedSessions: this.buckets.size,
    };
  }
}

export const concurrencyGuard = new ConcurrencyAndRateGuard();

/**
 * Sanitizes user chat messages and neutralizes prompt-injection attempts
 */
export function sanitizeUserMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let clean = raw.trim().slice(0, 1200);

  // Strip control characters except newlines
  clean = clean.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "");

  // Neutralize common prompt-override patterns
  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/gi,
    /system\s*prompt/gi,
    /you\s+are\s+now\s+a\s+different/gi,
  ];
  for (const pattern of injectionPatterns) {
    clean = clean.replace(pattern, "[filtered]");
  }

  return clean;
}

