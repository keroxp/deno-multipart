import { Closer, File, open, Reader, ReadResult, stat, Writer } from "deno";
import { BufReader, BufWriter } from "./deps.ts";

export async function copyN(
  dest: Writer,
  r: Reader,
  size: number
): Promise<number> {
  let bytesRead = 0;
  const buf = new Uint8Array(1024);
  const bw = new BufWriter(dest);
  while (bytesRead < size) {
    if (size - bytesRead < 1024) {
      const p = new Uint8Array(size - bytesRead);
      const { nread, eof } = await r.read(p);
      if (nread > 0) {
        await dest.write(p.slice(0, nread));
      }
      bytesRead += nread;
      if (eof) {
        break;
      }
    } else {
      const { nread, eof } = await r.read(buf);
      bytesRead += nread;
      if (nread > 0) {
        await dest.write(buf.slice(0, nread));
      }
      if (eof) {
        break;
      }
    }
  }
  await bw.flush();
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

export class StringWriter implements Writer, Closer {
  chunks: Uint8Array[] = [];
  byteLength: number = 0;

  async write(p: Uint8Array): Promise<number> {
    this.chunks.push(p);
    this.byteLength += p.byteLength;
    return p.byteLength;
  }

  private str: string;
  private closed = false;

  toString(): string {
    if (this.closed) {
      return this.str;
    }
    this.close();
    return this.str;
  }

  close(): void {
    if (this.closed) return;
    const buf = new Uint8Array(this.byteLength);
    let offs = 0;
    for (const chunk of this.chunks) {
      buf.set(chunk, offs);
      offs += chunk.byteLength;
    }
    this.chunks = [];
    try {
      this.str = new TextDecoder().decode(buf);
    } finally {
      this.closed = true;
    }
  }
}
