# TaskWraith CLI

TaskWraith's terminal client runs the same pure-Node Host and local profile from a regular shell.
Install it globally to make both the long and short commands available:

```sh
npm install --global taskwraith
taskwraith
# or
tw
```

For a one-off run, use `npx taskwraith`. Node.js 22 or newer is required.

The package contains only the terminal client, its standalone Host, and an optional `node-pty`
helper used for one bounded provider probe. It does not install the Electron desktop application or
provider CLIs. Run `taskwraith --help` for interactive controls, snapshots, JSON output, and
`.twmission` export/replay options.

`taskwraith-host --profile /absolute/path` starts the Host in the foreground;
`taskwraith-host stop --profile /absolute/path` asks that profile's authenticated Host to shut down
cleanly. Ordinarily, `taskwraith` starts and reuses the default Host automatically.
