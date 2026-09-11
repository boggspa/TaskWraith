# TaskWraith CLI

TaskWraith's terminal client runs the same pure-Node Host and local profile from a regular shell. A
published package or release tarball installs the binary commands:

```sh
npm install --global taskwraith
taskwraith
# or
tw
# or
taskwraith-host
```

For a one-off run, use `npx taskwraith`. Node.js 22 or newer is required.

The package contains only the terminal client, its standalone Host, and an optional `node-pty`
helper used for one bounded provider probe. It does not install the Electron desktop application or
provider CLIs. Run `taskwraith --help` for interactive controls, snapshots, JSON output, and
`.twmission` export/replay options.

`taskwraith-host --profile /absolute/path` defaults to `serve --mode production` and starts the Host in the foreground;
`taskwraith-host stop --profile /absolute/path` is a special authenticated RPC shutdown that asks that profile's authenticated Host to shut down
cleanly. Ordinarily, `taskwraith` starts and reuses the default Host automatically.
