#!/usr/bin/env node
'use strict'

// Root bins only ever run under a system Node (dev checkout / npm link), so
// they select the system-Node package profile before the compiled CLI parses
// argv — the same flag the published CLI wrapper sets. Desktop launchers use
// the packaged payload directly and never set this flag, retaining their
// pinned bundled Node.
process.env.TASKWRAITH_CLI_PACKAGE = '1'
require('../out/tui/tui/cli.js')
