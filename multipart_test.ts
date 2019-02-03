import {assertEqual, runTests, test} from "./deps.ts";
import {MultipartReader, MultipartWriter} from "./multipart.ts";
import {Buffer, copy, open} from "deno";
import {stringsReader} from "https://deno.land/x/std@v0.2.8/io/util.ts";

test(async function testWriter () {
    const buf = new Buffer()
    const mw = new MultipartWriter(buf)
    await mw.writeField("foo", "foo")
    await mw.writeField("bar", "bar")
    const f = await open("./tsconfig.json", "r")
    await mw.writeFile("file", "tsconfig.json", f)
    await mw.close()
    const b = buf.toString()
})
test(async function testReader() {
  let buf = new Buffer()
  const mw = new MultipartWriter(buf)
  await mw.writeField("foo", "foo")
  await mw.writeField("bar", "bar")
  let f = await open("./tsconfig.json", "r")
  await mw.writeFile("file", "tsconfig.json", f)
  await mw.close()
  f.close()
  const b = buf.toString()
  const mr = new MultipartReader(stringsReader(b), mw.boundary)
  const form = await mr.readForm(10 << 20)
  assertEqual(form.get("foo"), "foo")
  assertEqual(form.get("bar"), "bar")
  const file = form.get("file") as domTypes.DomFile
  assertEqual(file.name, "./tsconfig.json")
})
runTests()