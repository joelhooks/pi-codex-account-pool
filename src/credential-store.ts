import { spawn } from "node:child_process";
import type { CredentialStore, ProfileId, StoredCredential } from "./types.js";

const SERVICE = "pi-codex-account-pool";

export class InMemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<ProfileId, StoredCredential>();
  async get(profileId: ProfileId) { return this.entries.get(profileId); }
  async set(profileId: ProfileId, credential: StoredCredential) { this.entries.set(profileId, { ...credential }); }
  async delete(profileId: ProfileId) { this.entries.delete(profileId); }
}

export type SecurityRunner = (args: string[], stdin?: string) => Promise<string>;

export class MacOSKeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly service = SERVICE,
    private readonly run: SecurityRunner = runSecurity,
  ) {}

  async get(profileId: ProfileId): Promise<StoredCredential | undefined> {
    try {
      const stdout = await this.run(["find-generic-password", "-s", this.service, "-a", profileId, "-w"]);
      return JSON.parse(stdout.trim()) as StoredCredential;
    } catch {
      return undefined;
    }
  }

  async set(profileId: ProfileId, credential: StoredCredential): Promise<void> {
    // `security` explicitly warns that `-w <password>` exposes the password in
    // argv. Supplying bare `-w` last makes it read the value from stdin instead.
    await this.run(
      ["add-generic-password", "-U", "-s", this.service, "-a", profileId, "-w"],
      `${JSON.stringify(credential)}\n`,
    );
  }

  async delete(profileId: ProfileId): Promise<void> {
    try {
      await this.run(["delete-generic-password", "-s", this.service, "-a", profileId]);
    } catch {
      // Deleting an absent profile is idempotent.
    }
  }
}

function runSecurity(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`security exited with code ${code}: ${stderr.trim() || "unknown error"}`));
    });

    child.stdin.end(stdin);
  });
}
