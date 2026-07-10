import { mkdir, readFile, rename, chmod, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PoolMetadata } from "./types.js";

export const EMPTY_METADATA: PoolMetadata = { version: 1, profiles: [], updatedAt: new Date(0).toISOString() };

export async function readMetadata(path: string): Promise<PoolMetadata> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as Partial<PoolMetadata>;
    return { ...EMPTY_METADATA, ...parsed, version: 1, profiles: parsed.profiles ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_METADATA;
    throw error;
  }
}

export async function writeMetadata(path: string, metadata: PoolMetadata): Promise<void> {
  assertSecretFree(metadata);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export async function metadataMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

export function assertSecretFree(value: unknown): void {
  const text = JSON.stringify(value).toLowerCase();
  for (const needle of ["accesstoken", "access_token", "refreshtoken", "refresh_token", "bearer ", "jwt"]) {
    if (text.includes(needle)) throw new Error(`metadata contains forbidden secret-shaped key/value: ${needle}`);
  }
}
