#!/usr/bin/env node
'use strict'

// Select the system-Node package profile before the compiled CLI parses argv.
// Desktop launchers never set this flag and retain their pinned bundled Node.
process.env.TASKWRAITH_CLI_PACKAGE = '1'
require('../dist/tui/tui/cli.js')
