/**
 * EXAMPLE SEAM — this file is OUTSIDE the boundary: copy it into your app
 * (e.g. src/email/welcome.ts) and edit freely. It is not attested.
 *
 * After copying, change the import to your alias (seams.md §2):
 *   import { send } from "@parts/email.transactional";
 */
import { send } from "../src/index.js";

export interface WelcomeUser {
  name: string;
  email: string;
}

/** Templates are plain functions in YOUR app — the part never owns copy. */
export function welcomeTemplate(user: WelcomeUser): {
  subject: string;
  html: string;
  text: string;
} {
  return {
    subject: `Welcome, ${user.name}!`,
    html: `<h1>Welcome, ${user.name}!</h1><p>We're glad you're here.</p>`,
    text: `Welcome, ${user.name}! We're glad you're here.`,
  };
}

export async function sendWelcomeEmail(user: WelcomeUser): Promise<void> {
  await send({
    to: { email: user.email, name: user.name },
    ...welcomeTemplate(user),
  });
}
