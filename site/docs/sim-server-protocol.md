# The sim server protocol

A sim server runs autos for the desktop app's [Full sim speed](full-sim-simloop.md#full-sim-speed)
without a Gradle build per run. It is one JVM that stays up, started by the desktop app from the
`sim.server` section of `zenith.json` ([File format](file-format.md#sim)). This page is the contract
between the app and a server: protocol 1.

SimLoop's `v0.2.0-alpha.1` has no sim server. The server comes with a later SimLoop version. Any
other server that speaks this protocol works too.

## Starting

The app runs `sim.server.prepare` in the folder `zenith.json` is in, and waits for it to exit with 0.
Prepare builds what the server needs and writes the `args` file. The app then starts
`java @<args>`, with the same Java it uses for `sim.command`, in `sim.server.cwd`.

The `args` file is a Java argument file. It holds the class path, any `-D` or `-X` options, the
server's main class and that class's own arguments.

## Transport

The server reads its standard input and writes its standard output. Each message is one JSON object
on one line (UTF-8, ended by `\n`). Nothing listens on a network port.

Standard output carries the protocol and nothing else. Anything the robot code prints must go to
standard error; the app shows those lines in the sim panel's log.

Every message has a `type`. Both sides ignore a type they do not know, and fields they do not know.

## From the server

**`ready`**, once, when the server can take runs:

```json
{"type":"ready","protocol":1,"simloop":"<version>","runner":"<runner name>","pid":1234}
```

The app refuses a server whose `protocol` is not 1, and that run falls back to Basic. `pid` is the
JVM's own process id.

**`start`**, once per run, before any rows:

```json
{"type":"start","id":"r1","trace":{"formatVersion":1,"auto":"my-auto","sha":null,"tickS":0.02,"capabilities":[]}}
```

`trace` holds the [trace](simulation.md#the-trace) file's header keys: everything except the arrays
and `simTimeS`, which comes in `done`.

**`rows`**, as the run goes:

```json
{"type":"rows","id":"r1","poses":[[0.02,12.0,60.0,0.0]],"truthPoses":[],"steps":[],"structureContacts":[],"ledger":[],"events":[]}
```

Each array is appended to the trace's array of the same name, with the same row shapes as the trace
file. An array that is missing has nothing new. A batch goes out at least every 50 ms of wall time
or every 25 ticks, whichever comes first, and always before `done`. A step is sent once it has ended.

**`done`**, when the run finished:

```json
{"type":"done","id":"r1","simTimeS":30.0,"elapsedS":3.2,"tracePath":"build/sim/my-auto.trace.json"}
```

The server has also written the whole trace file, at `tracePath` relative to its working folder, so
the CLI and reports keep working. The `start` header and every `rows` batch, put together, must equal
that file: the same arrays, in the same order.

**`failed`**, when the run threw or the auto could not be loaded:

```json
{"type":"failed","id":"r1","message":"<one sentence for a person>","tail":["<last log lines>"]}
```

The server stays up.

**`cancelled`**, once a cancel took effect, at the next tick:

```json
{"type":"cancelled","id":"r1"}
```

**`fatal`**, when the server itself cannot go on. It exits after sending it:

```json
{"type":"fatal","message":"<why>"}
```

## From the app

**`run`** asks for one run:

```json
{"type":"run","id":"r1","auto":"my-auto"}
```

The app chooses `id`, unique for the server's lifetime. `auto` is an auto's name, which only has
letters, digits, `.`, `_` and `-`; the server answers anything else with `failed`. The server runs one
auto at a time and answers a `run` while one is going with `failed`. The app cancels first.

**`cancel`** stops a run:

```json
{"type":"cancel","id":"r1"}
```

If no `cancelled` comes within 3 s, the app stops the server.

**`shutdown`** asks the server to exit with 0 within about a second:

```json
{"type":"shutdown"}
```

The app kills the server's process tree if it has not gone 2 s later. It stops the server when you
quit, close the project or choose Basic, when Fast's 10 minutes with no run are up, when a watched
path changes, and when `sim.server` in `zenith.json` changes.

## Each run as if the JVM were new

Robot code keeps state in static fields. Each run on a warm server must behave exactly like a run in
a fresh JVM. One way: load the robot code in a new class loader for each run, while the JDK and
third-party libraries stay in the parent loader and stay warm.

A server should test this: run the same auto three times on one server. Each trace must equal the
trace a fresh JVM writes for that auto, after both are read as JSON.
