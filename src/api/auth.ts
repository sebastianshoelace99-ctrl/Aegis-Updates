import { z } from "zod";
import { request } from "./http";

/**
 * The account surface, typed once.
 *
 * Every reply is parsed with a schema, for the same reason `backend.ts` does it: a stale backend
 * or a hand-edited response must fail here rather than half-populate the signed-in state.
 */

export const providerIdSchema = z.enum(["discord", "google", "apple"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  displayName: z.string().min(1),
  handle: z.string().min(1),
  accent: z.number().int().min(0).max(7),
  provider: z.enum(["email", "discord", "google", "apple"]),
  createdAt: z.string(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authSessionSchema = z.object({
  token: z.string().min(20),
  user: authUserSchema,
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** Environment variables the operator still has to set, so the UI can be specific. */
  missing: string[];
};

const providersReplySchema = z.object({
  providers: z.array(
    z.object({
      id: providerIdSchema,
      label: z.string(),
      configured: z.boolean(),
      missing: z.array(z.string()),
    }),
  ),
});

const sessionReplySchema = z.object({ user: authUserSchema });

const pollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("complete"), token: z.string().min(20), user: authUserSchema }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type OAuthPoll = z.infer<typeof pollSchema>;

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function fetchProviders(): Promise<ProviderStatus[]> {
  const reply = providersReplySchema.parse(await request<unknown>("/api/auth/providers"));
  return reply.providers;
}

export async function registerAccount(input: {
  email: string;
  password: string;
  displayName: string;
  handle?: string;
}): Promise<AuthSession> {
  return authSessionSchema.parse(
    await request<unknown>("/api/auth/register", postJson(input)),
  );
}

export async function loginWithPassword(input: {
  email: string;
  password: string;
}): Promise<AuthSession> {
  return authSessionSchema.parse(await request<unknown>("/api/auth/login", postJson(input)));
}

export async function fetchSession(): Promise<AuthUser> {
  const reply = sessionReplySchema.parse(await request<unknown>("/api/auth/session"));
  return reply.user;
}

export async function signOut(): Promise<void> {
  await request<void>("/api/auth/logout", { method: "POST" });
}

export async function startOAuth(
  provider: ProviderId,
): Promise<{ attemptId: string; authorizeUrl: string }> {
  return z
    .object({ attemptId: z.string().min(20), authorizeUrl: z.url() })
    .parse(await request<unknown>("/api/auth/oauth/start", postJson({ provider })));
}

export async function pollOAuth(attemptId: string): Promise<OAuthPoll> {
  return pollSchema.parse(
    await request<unknown>(`/api/auth/oauth/attempt/${encodeURIComponent(attemptId)}`),
  );
}
