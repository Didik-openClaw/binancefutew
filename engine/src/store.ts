import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Penyimpanan file sederhana: JSON untuk state, JSONL untuk log (trade, ekuitas).
// dir = null -> hanya di memori (dipakai pembuat snapshot demo & test).
export class Store {
  private mem = new Map<string, unknown>();

  constructor(public dir: string | null) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  readJson<T>(name: string, fallback: T): T {
    if (!this.dir) return (this.mem.get(name) as T) ?? fallback;
    const f = join(this.dir, `${name}.json`);
    if (!existsSync(f)) return fallback;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(name: string, data: unknown) {
    if (!this.dir) {
      this.mem.set(name, data);
      return;
    }
    const f = join(this.dir, `${name}.json`);
    writeFileSync(`${f}.tmp`, JSON.stringify(data));
    renameSync(`${f}.tmp`, f);
  }

  appendJsonl(name: string, row: unknown) {
    if (!this.dir) return;
    appendFileSync(join(this.dir, `${name}.jsonl`), `${JSON.stringify(row)}\n`);
  }

  readJsonl<T>(name: string, limit = Infinity): T[] {
    if (!this.dir) return [];
    const f = join(this.dir, `${name}.jsonl`);
    if (!existsSync(f)) return [];
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const out: T[] = [];
    for (const l of lines.slice(-Math.min(lines.length, limit))) {
      try {
        out.push(JSON.parse(l));
      } catch {
        // baris rusak (mis. crash saat menulis) dilewati
      }
    }
    return out;
  }
}
