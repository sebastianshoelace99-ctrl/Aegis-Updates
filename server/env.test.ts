import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "./env";

const ENV_KEYS = [
  "NODE_ENV",
  "AEGIS_REQUIRE_AUTH",
  "AEGIS_API_KEY",
  "AEGIS_STORE",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AEGIS_AUTH_FILE",
  "AEGIS_UPLOAD_DIR",
  "AEGIS_PUBLIC_URL",
  "AEGIS_ICE_SERVERS",
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const authFile = resolve(tmpdir(), "aegis-production", "auth.json");
const uploadDir = resolve(tmpdir(), "aegis-production", "uploads");

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureProduction(): void {
  process.env.NODE_ENV = "production";
  process.env.AEGIS_REQUIRE_AUTH = "1";
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "server-only-test-key";
  process.env.AEGIS_AUTH_FILE = authFile;
  process.env.AEGIS_UPLOAD_DIR = uploadDir;
  process.env.AEGIS_PUBLIC_URL = "https://api.example.com";
}

describe("production backend configuration", () => {
  it("uses the default STUN server or validates deployment ICE servers", () => {
    expect(readConfig().iceServers).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
    process.env.AEGIS_ICE_SERVERS = JSON.stringify([
      { urls: "turn:turn.example.com:3478", username: "test-user", credential: "test-pass" },
    ]);
    expect(readConfig().iceServers).toEqual([
      { urls: "turn:turn.example.com:3478", username: "test-user", credential: "test-pass" },
    ]);

    process.env.AEGIS_ICE_SERVERS = "[{}]";
    expect(() => readConfig()).toThrow(/AEGIS_ICE_SERVERS is invalid/);
  });

  it("rejects production startup when session authentication is disabled", () => {
    configureProduction();
    delete process.env.AEGIS_REQUIRE_AUTH;

    expect(() => readConfig()).toThrow(/set AEGIS_REQUIRE_AUTH=1/);
  });

  it("rejects a client-shared API key in production", () => {
    configureProduction();
    process.env.AEGIS_API_KEY = "shared-key";

    expect(() => readConfig()).toThrow(/unset AEGIS_API_KEY/);
  });

  it("rejects ephemeral in-memory production storage", () => {
    configureProduction();
    process.env.AEGIS_STORE = "memory";

    expect(() => readConfig()).toThrow(/in-memory store is not durable/);
  });

  it("accepts authenticated production configuration with durable paths", () => {
    configureProduction();

    expect(readConfig()).toMatchObject({
      store: "supabase",
      apiKey: "",
      auth: {
        file: authFile,
        requireAuth: true,
        oauth: { publicUrl: "https://api.example.com" },
      },
      uploadDir,
    });
  });
});
