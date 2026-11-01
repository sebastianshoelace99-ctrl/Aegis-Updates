import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HttpError } from "./errors";
import {
  authorizeUrl,
  emptyOAuthConfig,
  exchangeCode,
  isConfigured,
  providerInfos,
  PROVIDER_IDS,
  PROVIDER_LABEL,
  type OAuthConfig,
  type OAuthProfile,
  type ProviderId,
  type ProviderInfo,
} from "./oauth";

/**
 * Accounts, sessions and the OAuth handoff.
 *
 * There is no database driver here on purpose. The workspace may live in Supabase, but identity
 * is a handful of rows and a `json` file keeps `npm run server` working on a clean checkout with
 * nothing installed. The store is written atomically (temp file + rename), so a crash mid-write
 * cannot truncate every account.
 *
 * Passwords are scrypt, never SHA. Session tokens are random 256-bit values; only their SHA-256
 * digest is stored, so reading `data/auth.json` does not let you impersonate anyone.
 */

export type AccountProvider = ProviderId | "email";

export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
  handle: string;
  /** Index into the avatar palette, derived from the id so it never changes. */
  accent: number;
  provider: AccountProvider;
  createdAt: string;
};

export type StoredUser = PublicUser & {
  emailVerified: boolean;
  /** null for an account that only ever used a provider. */
  passwordHash: string | null;
  providers: { provider: ProviderId; id: string }[];
};

export type AuthSession = { token: string; user: PublicUser };

export type OAuthPoll =
  | { status: "pending" }
  | { status: "complete"; token: string; user: PublicUser }
  | { status: "error"; message: string };

export type AuthService = {
  readonly kind: "memory" | "file";
  providers(): ProviderInfo[];
  register(input: RegisterInput): Promise<AuthSession>;
  login(input: LoginInput): Promise<AuthSession>;
  signInWithProvider(profile: OAuthProfile): Promise<AuthSession>;
  resolve(token: string): Promise<PublicUser | null>;
  revoke(token: string): Promise<void>;
  startOAuth(provider: ProviderId): { attemptId: string; authorizeUrl: string };
  completeOAuth(input: CompleteOAuthInput): Promise<AuthSession>;
  pollOAuth(attemptId: string): OAuthPoll;
};

export type RegisterInput = {
  email: unknown;
  password: unknown;
  displayName: unknown;
  handle?: unknown;
};

export type LoginInput = { email: unknown; password: unknown };

export type CompleteOAuthInput = {
  state: string;
  code: string;
  idToken?: string;
  rawUser?: string;
};

export type AuthOptions = {
  /** Absolute path for the JSON file, or null for a memory-only store. */
  file?: string | null;
  oauth?: OAuthConfig;
};

/* ── Rules ───────────────────────────────────────────────────────────────── */

const MAX_EMAIL = 254;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const MAX_DISPLAY_NAME = 32;
const MAX_HANDLE = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HANDLE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function readEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Enter an email address.");
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > MAX_EMAIL || !EMAIL.test(email)) {
    throw new HttpError(400, "That does not look like an email address.");
  }
  return email;
}

function readNewPassword(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Choose a password.");
  // Count characters, not bytes: a passphrase in any script is still a passphrase.
  const length = [...value].length;
  if (length < MIN_PASSWORD) {
    throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters.`);
  }
  if (length > MAX_PASSWORD) {
    throw new HttpError(400, `Use at most ${MAX_PASSWORD} characters.`);
  }
  return value;
}

function readSecret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PASSWORD) {
    throw new HttpError(401, "Email or password is incorrect.");
  }
  return value;
}

function readDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "A display name is required.");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new HttpError(400, "A display name is required.");
  if ([...name].length > MAX_DISPLAY_NAME) {
    throw new HttpError(400, `Use at most ${MAX_DISPLAY_NAME} characters for the display name.`);
  }
  return name;
}

/** Lowercase, accent-stripped, and safe as a URL segment or a mention. */
export function slugifyHandle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, MAX_HANDLE);
}

function readHandle(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") {
    const derived = slugifyHandle(fallback);
    return derived.length >= 2 ? derived : "member";
  }
  if (typeof value !== "string") throw new HttpError(400, "That handle is not valid.");
  const handle = slugifyHandle(value);
  if (!HANDLE.test(handle)) {
    throw new HttpError(
      400,
      "Handles are 2-32 lowercase letters, numbers, dots, dashes or underscores.",
    );
  }
  return handle;
}

function uniqueHandle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  const candidate = `${base}-${suffix}`.slice(0, MAX_HANDLE);
  return taken.has(candidate) ? `${base.slice(0, MAX_HANDLE - 4)}-${suffix}` : candidate;
}

function accentFor(id: string): number {
  return Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 2), 16) % 8;
}

function newUserId(): string {
  // `u_` keeps the id inside the grammar `x-aegis-user` and the guard already accept.
  return `u_${randomBytes(9).toString("hex")}`;
}

/* ── Passwords ───────────────────────────────────────────────────────────── */

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;

function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** `scrypt$N$r$p$saltHex$keyHex` - the parameters travel with the hash, so they can be raised. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  const saltHex = parts[4] ?? "";
  const keyHex = parts[5] ?? "";

  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await derive(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A thrown-away hash for an address that has no account.
 *
 * Without it, "unknown email" returns in microseconds and "wrong password" takes ~50 ms, which is
 * a free account-enumeration oracle. Verifying against this makes both paths do the same work.
 */
let decoy: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(16).toString("hex"));
  return decoy;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ── Persisted shape ─────────────────────────────────────────────────────── */

type Data = { version: 1; users: StoredUser[]; sessions: SessionRecord[] };

type SessionRecord = {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
};

function emptyData(): Data {
  return { version: 1, users: [], sessions: [] };
}

function isUser(value: unknown): value is StoredUser {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.email === "string" &&
    typeof record.displayName === "string" &&
    typeof record.handle === "string" &&
    typeof record.createdAt === "string" &&
    (record.passwordHash === null || typeof record.passwordHash === "string") &&
    Array.isArray(record.providers)
  );
}

function isSession(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tokenHash === "string" &&
    typeof record.userId === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.expiresAt === "number"
  );
}

function normalizeData(raw: unknown): Data {
  if (!raw || typeof raw !== "object") return emptyData();
  const record = raw as Record<string, unknown>;
  return {
    version: 1,
    users: Array.isArray(record.users) ? record.users.filter(isUser) : [],
    sessions: Array.isArray(record.sessions) ? record.sessions.filter(isSession) : [],
  };
}

function publicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    handle: user.handle,
    accent: user.accent,
    provider: user.provider,
    createdAt: user.createdAt,
  };
}

/* ── The store ───────────────────────────────────────────────────────────── */

type OAuthAttempt = {
  provider: ProviderId;
  verifier: string;
  createdAt: number;
  status: "pending" | "working" | "complete" | "error";
  session?: AuthSession;
  message?: string;
};

export function createAuthStore(options: AuthOptions = {}): AuthService {
  const oauth = options.oauth ?? emptyOAuthConfig();
  const file = options.file ?? null;

  let data = emptyData();
  let loadPromise: Promise<void> | null = null;
  let warned = false;
  /** Everything that mutates `data` runs through this, so two logins cannot interleave writes. */
  let chain: Promise<unknown> = Promise.resolve();

  const attempts = new Map<string, OAuthAttempt>();

  async function load(): Promise<void> {
    if (!file) return;
    try {
      data = normalizeData(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(
          `[aegis] the account file could not be read (${file}): ` +
            `${error instanceof Error ? error.message : String(error)}. Starting empty.`,
        );
      }
    }
  }

  function ready(): Promise<void> {
    loadPromise ??= load();
    return loadPromise;
  }

  async function persist(): Promise<void> {
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2), "utf8");
      await rename(temp, file);
    } catch (error) {
      // A full disk must not take sign-in down with it; the session still works in memory.
      if (!warned) {
        warned = true;
        console.warn(
          `[aegis] accounts could not be saved to ${file}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = chain.then(run, run);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function pruneSessions(): void {
    const now = Date.now();
    const kept = data.sessions.filter((session) => session.expiresAt > now);
    if (kept.length !== data.sessions.length) data.sessions = kept;
  }

  function issue(user: StoredUser): AuthSession {
    pruneSessions();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    data.sessions.push({
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return { token, user: publicUser(user) };
  }

  function createUser(fields: {
    email: string;
    emailVerified: boolean;
    displayName: string;
    handleSeed: string;
    requestedHandle?: string | null;
    passwordHash: string | null;
    provider: AccountProvider;
    providers: { provider: ProviderId; id: string }[];
  }): StoredUser {
    const id = newUserId();
    const taken = new Set(data.users.map((user) => user.handle));
    const base = readHandle(fields.requestedHandle ?? undefined, fields.handleSeed);
    const user: StoredUser = {
      id,
      email: fields.email,
      emailVerified: fields.emailVerified,
      displayName: fields.displayName,
      handle: uniqueHandle(base, taken),
      accent: accentFor(id),
      passwordHash: fields.passwordHash,
      provider: fields.provider,
      providers: fields.providers,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    return user;
  }

  async function register(input: RegisterInput): Promise<AuthSession> {
    return exclusive(async () => {
      await ready();

      const email = readEmail(input.email);
      const password = readNewPassword(input.password);
      const displayName = readDisplayName(input.displayName);

      const conflict = data.users.find((user) => user.email === email);
      if (conflict) {
        if (conflict.passwordHash) {
          throw new HttpError(409, "An account with that email already exists. Log in instead.");
        }
        const provider = conflict.providers[0]?.provider;
        const label = provider ? PROVIDER_LABEL[provider] : "a connected account";
        throw new HttpError(409, `That email already signs in with ${label}. Use that button.`);
      }

      const passwordHash = await hashPassword(password);
      const user = createUser({
        email,
        // No email service ships with this build, so the address is not proven. That is also why
        // a password account is never silently merged into a provider identity below.
        emailVerified: false,
        displayName,
        handleSeed: displayName || email,
        requestedHandle: typeof input.handle === "string" ? input.handle : null,
        passwordHash,
        provider: "email",
        providers: [],
      });

      const session = issue(user);
      await persist();
      return session;
    });
  }

  async function login(input: LoginInput): Promise<AuthSession> {
    return exclusive(async () => {
      await ready();

      const email = readEmail(input.email);
      const password = readSecret(input.password);

      const user = data.users.find((entry) => entry.email === email);

      if (!user || !user.passwordHash) {
        // Same work as a wrong password, so the reply time does not reveal the address.
        await verifyPassword(password, await decoyHash());
        throw new HttpError(401, "Email or password is incorrect.");
      }

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) throw new HttpError(401, "Email or password is incorrect.");

      const session = issue(user);
      await persist();
      return session;
    });
  }

  async function signInWithProvider(profile: OAuthProfile): Promise<AuthSession> {
    return exclusive(async () => {
      await ready();

      const linked = data.users.find((user) =>
        user.providers.some(
          (entry) => entry.provider === profile.provider && entry.id === profile.providerId,
        ),
      );
      if (linked) {
        const session = issue(linked);
        await persist();
        return session;
      }

      /*
       * Linking is only safe when the provider *asserts* the address. A password account created
       * here has `emailVerified: false`, so it is never adopted by an OAuth identity: otherwise
       * whoever registered an address first would inherit the real owner's Google sign-in.
       */
      const email = profile.email ? normalizeEmail(profile.email) : "";
      if (email && profile.emailVerified) {
        const byEmail = data.users.find((user) => user.email === email && user.emailVerified);
        if (byEmail) {
          byEmail.providers.push({ provider: profile.provider, id: profile.providerId });
          const session = issue(byEmail);
          await persist();
          return session;
        }
      }

      const user = createUser({
        email,
        emailVerified: profile.emailVerified,
        displayName: profile.displayName,
        handleSeed: profile.displayName || email || profile.provider,
        passwordHash: null,
        provider: profile.provider,
        providers: [{ provider: profile.provider, id: profile.providerId }],
      });

      const session = issue(user);
      await persist();
      return session;
    });
  }

  async function resolve(token: string): Promise<PublicUser | null> {
    if (!token) return null;
    await ready();

    const digest = hashToken(token);
    const index = data.sessions.findIndex((session) => session.tokenHash === digest);
    if (index < 0) return null;

    const session = data.sessions[index];
    if (!session) return null;

    if (session.expiresAt <= Date.now()) {
      data.sessions.splice(index, 1);
      void persist();
      return null;
    }

    const user = data.users.find((entry) => entry.id === session.userId);
    return user ? publicUser(user) : null;
  }

  async function revoke(token: string): Promise<void> {
    if (!token) return;
    return exclusive(async () => {
      await ready();
      const digest = hashToken(token);
      const before = data.sessions.length;
      data.sessions = data.sessions.filter((session) => session.tokenHash !== digest);
      if (data.sessions.length !== before) await persist();
    });
  }


  function pruneAttempts(): void {
    const now = Date.now();
    for (const [key, attempt] of attempts) {
      if (attempt.status !== "working" && now - attempt.createdAt > OAUTH_TTL_MS) {
        attempts.delete(key);
      }
    }
  }

  function startOAuth(provider: ProviderId): { attemptId: string; authorizeUrl: string } {
    if (!isConfigured(oauth, provider)) {
      throw new HttpError(501, `${PROVIDER_LABEL[provider]} sign-in is not configured on this server.`);
    }

    pruneAttempts();

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");

    attempts.set(state, { provider, verifier, createdAt: Date.now(), status: "pending" });

    return { attemptId: state, authorizeUrl: authorizeUrl(oauth, provider, state, challenge) };
  }

  async function completeOAuth(input: CompleteOAuthInput): Promise<AuthSession> {
    pruneAttempts();

    const attempt = attempts.get(input.state);
    if (!attempt) {
      throw new HttpError(400, "That sign-in link has expired. Start again from the app.");
    }
    if (attempt.status === "complete" && attempt.session) return attempt.session;
    if (attempt.status === "working") {
      throw new HttpError(409, "That sign-in is already being completed.");
    }
    if (attempt.status === "error") {
      throw new HttpError(400, attempt.message ?? "That sign-in failed.");
    }
    if (!input.code) throw new HttpError(400, "The provider did not return an authorization code.");

    attempt.status = "working";

    try {
      const profile = await exchangeCode(oauth, attempt.provider, {
        code: input.code,
        verifier: attempt.verifier,
        ...(input.idToken ? { idToken: input.idToken } : {}),
        ...(input.rawUser ? { rawUser: input.rawUser } : {}),
      });

      const session = await signInWithProvider(profile);
      attempt.status = "complete";
      attempt.session = session;
      return session;
    } catch (error) {
      attempt.status = "error";
      attempt.message = error instanceof Error ? error.message : "That sign-in failed.";
      throw error;
    }
  }

  function pollOAuth(attemptId: string): OAuthPoll {
    pruneAttempts();

    const attempt = attempts.get(attemptId);
    if (!attempt) {
      return { status: "error", message: "That sign-in attempt expired. Try again." };
    }
    if (attempt.status === "complete" && attempt.session) {
      return {
        status: "complete",
        token: attempt.session.token,
        user: attempt.session.user,
      };
    }
    if (attempt.status === "error") {
      return { status: "error", message: attempt.message ?? "That sign-in failed." };
    }
    return { status: "pending" };
  }

  return {
    kind: file ? "file" : "memory",
    providers: () => providerInfos(oauth),
    register,
    login,
    signInWithProvider,
    resolve,
    revoke,
    startOAuth,
    completeOAuth,
    pollOAuth,
  };
}

