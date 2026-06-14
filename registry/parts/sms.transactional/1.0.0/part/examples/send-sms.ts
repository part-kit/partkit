/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * After copying, change the import to your alias (seams.md §1):
 *   import { send } from "@parts/sms.transactional";
 */
import { send } from "../src/index";

/** Send a one-time verification code. Returns the vendor message id (for logs). */
export async function sendVerificationCode(phone: string, code: string): Promise<string> {
  const { id } = await send({ to: phone, body: `Your code is ${code}` });
  return id;
}

/** Send an alert from a specific sender (a number or, on Twilio, a Messaging Service SID). */
export async function sendAlert(phone: string, text: string, from?: string): Promise<void> {
  await send({ to: phone, body: text, ...(from !== undefined ? { from } : {}) });
}
