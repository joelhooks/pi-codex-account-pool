import { Entry } from "@napi-rs/keyring";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialStore, ProfileId, StoredCredential } from "./types.js";

const SERVICE = "pi-codex-account-pool";

export class InMemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<ProfileId, StoredCredential>();
  async get(profileId: ProfileId) { return this.entries.get(profileId); }
  async set(profileId: ProfileId, credential: StoredCredential) { this.entries.set(profileId, { ...credential }); }
  async delete(profileId: ProfileId) { this.entries.delete(profileId); }
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export class MacOSKeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly service = SERVICE,
    private readonly createEntry: KeyringEntryFactory = (service, account) => new Entry(service, account),
  ) {}

  async get(profileId: ProfileId): Promise<StoredCredential | undefined> {
    try {
      const password = this.createEntry(this.service, profileId).getPassword();
      return password ? JSON.parse(password) as StoredCredential : undefined;
    } catch {
      return undefined;
    }
  }

  async set(profileId: ProfileId, credential: StoredCredential): Promise<void> {
    // Native Security.framework binding: the credential never appears in shell
    // source, process argv, or environment variables.
    this.createEntry(this.service, profileId).setPassword(JSON.stringify(credential));
  }

  async delete(profileId: ProfileId): Promise<void> {
    try {
      this.createEntry(this.service, profileId).deletePassword();
    } catch {
      // Deleting an absent or inaccessible profile is idempotent.
    }
  }
}

/**
 * A 0600 fallback matching Pi's own auth.json threat model. This is used when
 * macOS denies Keychain interaction to background launchd sessions.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly directory: string) {}

  async get(profileId: ProfileId): Promise<StoredCredential | undefined> {
    try {
      return JSON.parse(await readFile(this.path(profileId), "utf8")) as StoredCredential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(profileId: ProfileId, credential: StoredCredential): Promise<void> {
    const path = this.path(profileId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  }

  async delete(profileId: ProfileId): Promise<void> {
    await rm(this.path(profileId), { force: true });
  }

  private path(profileId: ProfileId): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) throw new Error("Invalid credential profile id");
    return join(this.directory, `${profileId}.json`);
  }
}

export class FallbackCredentialStore implements CredentialStore {
  constructor(
    private readonly primary: CredentialStore,
    private readonly fallback: CredentialStore,
  ) {}

  async get(profileId: ProfileId): Promise<StoredCredential | undefined> {
    // Prefer an existing fallback file so background sessions do not trigger a
    // denied Keychain interaction on every request. Successful primary writes
    // delete the fallback, so Keychain remains authoritative when available.
    return (await this.fallback.get(profileId)) ?? this.primary.get(profileId);
  }

  async set(profileId: ProfileId, credential: StoredCredential): Promise<void> {
    try {
      await this.primary.set(profileId, credential);
      await this.fallback.delete(profileId);
    } catch {
      await this.fallback.set(profileId, credential);
    }
  }

  async delete(profileId: ProfileId): Promise<void> {
    await Promise.allSettled([this.primary.delete(profileId), this.fallback.delete(profileId)]);
  }
}
