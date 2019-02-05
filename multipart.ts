import { Buffer, Closer, copy, Reader, ReadResult, remove, Writer } from "deno";
import { copyN, MultiReader, StringWriter, tempfile } from "./ioutil.ts";
import { FileHeader, FormFile } from "./formfile.ts";
import {
  bytesFindIndex,
  bytesFindLastIndex,
  bytesHasPrefix,
  bytesEqual
} from "./bytes.ts";
import { BufReader, BufState, BufWriter, TextProtoReader } from "./deps.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function randomBoundary() {
  let boundary = "--------------------------";
  for (let i = 0; i < 24; i++) {
    boundary += Math.floor(Math.random() * 10).toString(16);
  }
  return boundary;
}

function println(...s: any) {
  console.log(...s, "\n");
}

export class MultipartReader {
  readonly newLine = encoder.encode("\r\n");
  readonly newLineDashBoundary = encoder.encode(`\r\n--${this.boundary}`);
  readonly dashBoundaryDash = encoder.encode(`--${this.boundary}--`);
  readonly dashBoundary = encoder.encode(`--${this.boundary}`);
  readonly bufReader: BufReader;

  constructor(private reader: Reader, private boundary: string) {
    this.bufReader = new BufReader(reader);
  }

  async readForm(maxMemory: number): Promise<FormData> {
    const form = new FormData();
    let maxValueBytes = maxMemory + (10 << 20);
    const buf = new Buffer(new Uint8Array(maxValueBytes));
    for (;;) {
      const p = await this.nextPart();
      if (!p) {
        break;
      }
      if (p.formName === "") {
        continue;
      }
      buf.reset();
      if (!p.fileName) {
        // value
        const n = await copyN(buf, p, maxValueBytes);
        maxValueBytes -= n;
        if (maxValueBytes < 0) {
          throw new RangeError("message too large");
        }
        const value = buf.toString();
        form.set(p.formName, value);
        continue;
      }
      // file
      const fileHeader: FileHeader = {
        filename: p.fileName,
        headers: p.headers
      };
      const n = await copy(buf, p);
      if (n > maxMemory) {
        // too big, write to disk and flush buffer
        const { file, filepath } = await tempfile("", "multipart-");
        try {
          const size = await copyN(
            file,
            new MultiReader(buf, p),
            maxValueBytes
          );
          file.close();
          fileHeader.tempfile = filepath;
          fileHeader.size = size;
        } catch (e) {
          await remove(filepath);
        }
      } else {
        fileHeader.content = buf.bytes();
        fileHeader.size = fileHeader.content.byteLength;
        maxMemory -= n;
        maxValueBytes -= n;
      }
      form.set(p.formName, new FormFile(fileHeader), p.fileName);
    }
    return form;
  }

  currentPart: PartReader;
  partsRead: number;

  async nextPart(): Promise<PartReader> {
    if (this.currentPart) {
      this.currentPart.close();
    }
    if (bytesEqual(this.dashBoundary, encoder.encode("--"))) {
      throw new Error("boundary is empty");
    }
    let expectNewPart = false;
    for (;;) {
      const [line, state] = await this.bufReader.readSlice("\n".charCodeAt(0));
      if (state === "EOF" && this.isFinalBoundary(line)) {
        break;
      }
      if (state) {
        throw new Error("aa" + state.toString());
      }
      if (this.isBoundaryDelimiterLine(line)) {
        this.partsRead++;
        const r = new TextProtoReader(this.bufReader);
        const [headers, state] = await r.readMIMEHeader();
        if (state) {
          throw state;
        }
        const np = new PartReader(this, headers);
        this.currentPart = np;
        return np;
      }
      if (this.isFinalBoundary(line)) {
        break;
      }
      if (expectNewPart) {
        throw new Error(`expecting a new Part; got line ${line}`);
      }
      if (this.partsRead === 0) {
        continue;
      }
      if (bytesEqual(line, this.newLine)) {
        expectNewPart = true;
        continue;
      }
      throw new Error(`unexpected line in next(): ${line}`);
    }
  }

  private isFinalBoundary(line: Uint8Array) {
    if (!bytesHasPrefix(line, this.dashBoundaryDash)) {
      return false;
    }
    let rest = line.slice(this.dashBoundaryDash.length, line.length);
    return rest.length === 0 || bytesEqual(skipLWSPChar(rest), this.newLine);
  }

  private isBoundaryDelimiterLine(line: Uint8Array) {
    if (!bytesHasPrefix(line, this.dashBoundary)) {
      return false;
    }
    const rest = line.slice(this.dashBoundary.length);
    return bytesEqual(skipLWSPChar(rest), this.newLine);
  }
}

function skipLWSPChar(u: Uint8Array): Uint8Array {
  const ret = new Uint8Array(u.length);
  const sp = " ".charCodeAt(0);
  const ht = "\t".charCodeAt(0);
  let j = 0;
  for (let i = 0; i < u.length; i++) {
    if (u[i] === sp || u[i] === ht) continue;
    ret[j++] = u[i];
  }
  return ret.slice(0, j);
}

let i = 0;
class PartReader implements Reader, Closer {
  n: number = 0;
  total: number = 0;
  bufState: BufState = null;
  index = i++;
  constructor(private mr: MultipartReader, public readonly headers: Headers) {}

  async read(p: Uint8Array): Promise<ReadResult> {
    const br = this.mr.bufReader;
    const returnResult = (nread: number, bufState: BufState): ReadResult => {
      if (bufState && bufState !== "EOF") {
        throw bufState;
      }
      return { nread, eof: bufState === "EOF" };
    };
    if (this.n === 0 && !this.bufState) {
      const [peek] = await br.peek(br.buffered());
      const [n, state] = scanUntilBoundary(
        peek,
        this.mr.dashBoundary,
        this.mr.newLineDashBoundary,
        this.total,
        this.bufState
      );
      this.n = n;
      this.bufState = state;
      if (this.n === 0 && !this.bufState) {
        const [_, state] = await br.peek(peek.length + 1);
        this.bufState = state;
        if (this.bufState === "EOF") {
          this.bufState = new RangeError("unexpected eof");
        }
      }
    }
    if (this.n === 0) {
      return returnResult(0, this.bufState);
    }

    let n = 0;
    if (p.byteLength > this.n) {
      n = this.n;
    }
    const buf = p.slice(0, n);
    const [nread] = await this.mr.bufReader.readFull(buf);
    p.set(buf);
    this.total += nread;
    this.n -= nread;
    if (this.n === 0) {
      return returnResult(n, this.bufState);
    }
    return returnResult(n, null);
  }

  close(): void {}

  private contentDisposition: string;
  private contentDispositionParams: { [key: string]: string };

  private getContentDispositionParams() {
    if (this.contentDispositionParams) return this.contentDispositionParams;
    const cd = this.headers.get("content-disposition");
    const params = {};
    const comps = cd.split(";");
    this.contentDisposition = comps[0];
    comps
      .slice(1)
      .map(v => v.trim())
      .map(kv => {
        const [k, v] = kv.split("=");
        if (v) {
          const s = v.charAt(0);
          const e = v.charAt(v.length - 1);
          if ((s === e && s === '"') || s === "'") {
            params[k] = v.substr(1, v.length - 2);
          } else {
            params[k] = v;
          }
        }
      });
    return (this.contentDispositionParams = params);
  }

  get fileName(): string {
    return this.getContentDispositionParams()["filename"];
  }

  get formName(): string {
    const p = this.getContentDispositionParams();
    if (this.contentDisposition === "form-data") {
      return p["name"];
    }
    return "";
  }
}

export function scanUntilBoundary(
  buf: Uint8Array,
  dashBoundary: Uint8Array,
  newLineDashBoundary: Uint8Array,
  total: number,
  state: BufState
): [number, BufState] {
  if (total === 0) {
    if (bytesHasPrefix(buf, dashBoundary)) {
      switch (matchAfterPrefix(buf, dashBoundary, state)) {
        case -1:
          return [dashBoundary.length, null];
        case 0:
          return [0, null];
        case 1:
          return [0, "EOF"];
      }
      if (bytesHasPrefix(dashBoundary, buf)) {
        return [0, state];
      }
    }
  }
  const i = bytesFindIndex(buf, newLineDashBoundary);
  if (i >= 0) {
    switch (matchAfterPrefix(buf.slice(i), newLineDashBoundary, state)) {
      case -1:
        return [i + newLineDashBoundary.length, null];
      case 0:
        return [i, null];
      case 1:
        return [i, "EOF"];
    }
  }
  if (bytesHasPrefix(newLineDashBoundary, buf)) {
    return [0, state];
  }
  const j = bytesFindLastIndex(buf, newLineDashBoundary.slice(0, 1));
  if (j >= 0 && bytesHasPrefix(newLineDashBoundary, buf.slice(j))) {
    return [j, null];
  }
  return [buf.length, state];
}

export function matchAfterPrefix(
  a: Uint8Array,
  prefix: Uint8Array,
  bufState: BufState
): number {
  if (a.length === prefix.length) {
    if (bufState) {
      return 1;
    }
    return 0;
  }
  const c = a[prefix.length];
  if (
    c === " ".charCodeAt(0) ||
    c === "\t".charCodeAt(0) ||
    c === "\r".charCodeAt(0) ||
    c === "\n".charCodeAt(0) ||
    c === "-".charCodeAt(0)
  ) {
    return 1;
  }
  return -1;
}

class PartWriter implements Writer {
  closed = false;
  private readonly partHeader: string;
  private headersWritten: boolean = false;

  constructor(
    private writer: Writer,
    readonly boundary: string,
    public headers: Headers,
    isFirstBoundary: boolean
  ) {
    let buf = "";
    if (isFirstBoundary) {
      buf += `--${boundary}\r\n`;
    } else {
      buf += `\r\n--${boundary}\r\n`;
    }
    for (const [key, value] of headers.entries()) {
      buf += `${key}: ${value}\r\n`;
    }
    buf += `\r\n`;
    this.partHeader = buf;
  }

  close(): void {
    this.closed = true;
  }

  async write(p: Uint8Array): Promise<number> {
    if (this.closed) {
      throw new Error("part is closed");
    }
    if (!this.headersWritten) {
      await this.writer.write(encoder.encode(this.partHeader));
      this.headersWritten = true;
    }
    return this.writer.write(p);
  }
}

export class MultipartWriter {
  private _boundary: string;

  setBoundary(b: string) {
    if (this.lastPart) {
      throw new Error("setBoundary called after write");
    }
    if (b.length < 1 || b.length > 70) {
      throw new TypeError("invalid boundary length: " + b.length);
    }
    const end = b.length - 1;
    for (let i = 0; i < end; i++) {
      if (
        !b.charAt(i).match(/[a-zA-Z0-9'()+_,\-./:=?]/) ||
        (b.charAt(i) === " " && i != end)
      ) {
        throw new Error("invalid boundary character: " + b.charAt(i));
      }
    }
    this._boundary = b;
  }

  get boundary() {
    return this._boundary;
  }

  private lastPart: PartWriter;
  bufWriter: BufWriter;

  constructor(readonly writer: Writer) {
    this._boundary = randomBoundary();
    this.bufWriter = new BufWriter(writer);
  }

  flush(): Promise<BufState> {
    return this.bufWriter.flush();
  }

  formDataContentType(): string {
    if (this.boundary.match(/[()<>@,;:"/\[\]?= ]/)) {
      this._boundary = `"${this.boundary}"`;
    }
    return `multipart/form-data; boundary=${this.boundary}`;
  }

  createPart(headers: Headers): Writer {
    if (this.lastPart) {
      this.lastPart.close();
    }
    const part = new PartWriter(
      this.writer,
      this.boundary,
      headers,
      !this.lastPart
    );
    this.lastPart = part;
    return part;
  }

  createFormFile(field: string, filename: string): Writer {
    const h = new Headers();
    h.set(
      "Content-Disposition",
      `form-data; name="${field}"; filename="${filename}"`
    );
    h.set("Content-Type", "application/octet-stream");
    return this.createPart(h);
  }

  createFormField(field: string): Writer {
    const h = new Headers();
    h.set("Content-Disposition", `form-data; name="${field}"`);
    h.set("Content-Type", "application/octet-stream");
    return this.createPart(h);
  }

  async writeField(field: string, value: string) {
    const f = await this.createFormField(field);
    await f.write(encoder.encode(value));
  }

  async writeFile(field: string, filename: string, file: Reader) {
    const f = await this.createFormFile(field, filename);
    await copy(f, file);
  }

  async close() {
    if (this.lastPart) {
      this.lastPart.close();
      this.lastPart = void 0;
    }
    await this.writer.write(encoder.encode(`\r\n--${this.boundary}--\r\n`));
    await this.flush();
  }
}
