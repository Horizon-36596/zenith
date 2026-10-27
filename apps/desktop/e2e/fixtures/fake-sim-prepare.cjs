// A stand-in for a robot repository's `sim.server.prepare` command: it prints a few lines the way
// Gradle would and writes the server's argument file, one argument per line, as a Java @argfile.
//
//   node fake-sim-prepare.cjs <args file> [--fail] [--delay-ms <ms>] [--split-utf8] [--log <file>] [--write <file>] -- <the server's arguments...>
//
// `--fail` exits 1 as a failed build would; `--delay-ms` takes that long, as a slow build does, before
// it writes anything; `--split-utf8` prints a line with a character split across two writes; `--log`
// appends "prepare <epoch ms>" to a file, so a test can count how often the server was prepared, and when;
// `--write` also writes that file, as a build writes its class files, before the argument file.
"use strict";
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split === -1 ? argv : argv.slice(0, split);
const serverArgs = split === -1 ? [] : argv.slice(split + 1);
const argsFile = own[0];
const logAt = own.indexOf("--log");
if (logAt !== -1) appendFileSync(own[logAt + 1], `prepare ${Date.now()}\n`);
const delayAt = own.indexOf("--delay-ms");
const delayMs = delayAt === -1 ? 0 : Number(own[delayAt + 1]);

console.log("> Task :prepareSimServer");
if (own.includes("--split-utf8")) {
  // "Built café": the é's two bytes go in two writes, as a pipe can split them.
  const text = Buffer.from("Built café\n", "utf8");
  const at = text.indexOf(0xc3);
  process.stdout.write(text.subarray(0, at + 1));
  setTimeout(() => process.stdout.write(text.subarray(at + 1)), 50);
}
setTimeout(() => {
  if (own.includes("--fail")) {
    console.log("Compilation failed; see the compiler error output for details.");
    console.log("BUILD FAILED in 1s");
    process.exit(1);
  }
  const writeAt = own.indexOf("--write");
  if (writeAt !== -1) {
    const built = resolve(process.cwd(), own[writeAt + 1]);
    mkdirSync(dirname(built), { recursive: true });
    writeFileSync(built, `built ${Date.now()}
`);
  }
  const target = resolve(process.cwd(), argsFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${serverArgs.join("\n")}\n`);
  console.log("BUILD SUCCESSFUL in 1s");
}, delayMs + (own.includes("--split-utf8") ? 200 : 0));
