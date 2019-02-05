# deno-multipart

multipart reader/writer for deno

# Usage

## Writer

```ts
import { MultipartWriter } from "https://denopkg.com/keroxp/deno-multipart/multipart.ts";

const buf = new Buffer();
const mw = new MultipartWriter(buf);
await mw.WriteField("field1", "deno");
await mw.WriteField("deno", "land");
const file = await open("file.txt");
await mw.WriteFile("file", "file.txt", file);
await mw.close(); // important!
buf.toString(); // => ...
```

## Reader

```ts
import { MultipartReader } from "https://denopkg.com/keroxp/deno-multipart/multipart.ts";

const f = await open("multipart.txt");
const boundary = "----boundary";
const mr = new MultipartReader(f, boundary);
const form = await mr.readForm();
form.get("deno"); // => land
```
