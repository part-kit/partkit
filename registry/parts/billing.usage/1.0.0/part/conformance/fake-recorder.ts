/**
 * A protocol-faithful fake biller — the in-process analogue of webhooks.dispatch's
 * FakeReceiver. It records every report() call and can be scripted to fail a
 * specific eventId, so the gated real-Postgres block can prove the reportDue
 * drain's exactly-once / mark / retry-on-failure state machine WITHOUT the real
 * Stripe adapter (which the separate live block exercises).
 */
import type { ReportableEvent, UsageAdapter } from "../src/internal/types";

export class FakeRecorder implements UsageAdapter {
  readonly name = "fake";
  readonly calls: ReportableEvent[] = [];
  /** eventIds whose report() should throw, simulating a biller failure. */
  readonly failFor = new Set<string>();

  async report(event: ReportableEvent): Promise<{ reportedId?: string }> {
    this.calls.push(event);
    if (this.failFor.has(event.eventId)) throw new Error("simulated biller failure");
    return { reportedId: `rep_${event.eventId}` };
  }
}
