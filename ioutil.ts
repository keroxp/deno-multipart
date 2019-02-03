import { open, Reader, ReadResult, stat, Writer, File } from "deno";
import {BufReader} from "./deps.ts";

export async function copyN(
  dest: Writer,
  r: Reader,
  size: number
): Promise<number> {
  let bytesRead = 0;
  const buf = new Uint8Array(1024);
  while (bytesRead < size) {
    if (size - bytesRead < 1024) {
      const p = new Uint8Array(size - bytesRead);
      const [nread] = await new BufReader(r).readFull(p);
      bytesRead += nread;
      break;
    }
    const { nread, eof } = await r.read(buf);
    bytesRead += nread;
    if (eof) {
      break;
    }
  }
  return bytesRead;
}

export async function tempfile(
  dir: string,
  prefix: string = "",
  postfix: string = ""
): Promise<{ file: File; filepath: string }> {
  const r = Math.random() * 1000000;
  const filepath = `${dir}/${prefix}${r}${postfix}`;
  const st = await stat(filepath);
  if (st.isFile()) {
    return tempfile(dir, prefix, postfix);
  }
  const file = await open(filepath);
  return { file, filepath };
}

export class MultiReader implements Reader {
  readers: Reader[];

  constructor(...readers: Reader[]) {
    this.readers = readers;
  }

  private currentIndex = 0;

  async read(p: Uint8Array): Promise<ReadResult> {
    const r = this.readers[this.currentIndex];
    if (!r) return { nread: 0, eof: true };
    const { nread, eof } = await r.read(p);
    if (eof) {
      this.currentIndex++;
    }
    return { nread, eof };
  }
}

export class BinaryReader implements Reader {
  private offs = 0;

  constructor(readonly bytes: Uint8Array) {}

  async read(p: Uint8Array): Promise<ReadResult> {
    const len = Math.min(p.byteLength, this.bytes.byteLength - this.offs);
    p.set(this.bytes.slice(this.offs, this.offs + len));
    this.offs += p.byteLength;
    return { nread: len, eof: this.offs === this.bytes.byteLength };
  }
}
