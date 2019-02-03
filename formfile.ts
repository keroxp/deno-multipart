import { Closer, Reader, ReadResult, open } from "deno";
import { BinaryReader } from "./ioutil.ts";

export type FileHeader = {
  filename: string;
  headers: Headers;
  size?: number;
  content?: Uint8Array;
  tempfile?: string;
};

export class FormFile implements domTypes.DomFile, Reader, Closer {
  reader: Reader;
  closer: Closer;

  constructor(private header: FileHeader) {
    this.lastModified = Date.now();
  }

  opened: boolean = false;

  async open() {
    if (this.opened) return;
    if (this.header.content) {
      this.reader = new BinaryReader(this.header.content);
    } else if (this.header.tempfile) {
      const f = await open(this.header.tempfile);
      this.reader = f;
      this.closer = f;
    }
    this.opened = !!this.reader;
  }

  async read(p: Uint8Array): Promise<ReadResult> {
    if (!this.opened) {
      throw new Error("no opened");
    }
    return this.reader.read(p);
  }

  close(): void {
    this.closer && this.closer.close();
  }

  readonly lastModified: number;

  get name(): string {
    return this.header.filename;
  }

  get size(): number {
    return this.header.size;
  }

  get type(): string {
    return this.header.headers.get("content-type");
  }

  slice(start?: number, end?: number, contentType?: string): domTypes.Blob {
    return undefined;
  }
}
