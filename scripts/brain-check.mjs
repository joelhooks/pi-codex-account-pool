import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path));
    else if (entry.name.endsWith(".svx")) out.push(path);
  }
  return out;
}

const forbidden = [/access[_-]?token/i, /refresh[_-]?token/i, /bearer\s+[a-z0-9._-]+/i, /chatgpt-account-id:\s*[a-z0-9_-]+/i];
for (const file of await files(".brain")) {
  const text = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`${file} contains secret-shaped text: ${pattern}`);
  }
}
console.log("brain check passed: .brain docs contain no obvious token/account-id leaks");
