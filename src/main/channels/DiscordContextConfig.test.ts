import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { resolveDiscordContextConfig } from './DiscordContextConfig'

describe('resolveDiscordContextConfig', () => {
  it('loads Discord runtime config from the documented user config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskwraith-discord-config-'))
    const userDataPath = join(dir, 'user-data')
    const configPath = join(userDataPath, 'discord-context.env')
    try {
      mkdirSync(userDataPath, { recursive: true })
      writeFileSync(
        configPath,
        [
          'TASKWRAITH_DISCORD_BOT_TOKEN="bot-token"',
          'TASKWRAITH_DISCORD_GUILD_IDS=123456789012345678, 234567890123456789',
          'TASKWRAITH_DISCORD_ACCOUNT_ID=team-discord'
        ].join('\n')
      )

      const config = resolveDiscordContextConfig({
        env: {},
        userDataPath,
        homeDir: join(dir, 'home')
      })

      expect(config.botToken).toBe('bot-token')
      expect(config.guildIds).toEqual(['123456789012345678', '234567890123456789'])
      expect(config.accountId).toBe('team-discord')
      expect(config.loadedConfigFilePath).toBe(configPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets process environment values override config-file values and supports singular guild id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskwraith-discord-config-'))
    const envPath = join(dir, 'discord-context.env')
    try {
      writeFileSync(
        envPath,
        [
          'TASKWRAITH_DISCORD_BOT_TOKEN=file-token',
          'TASKWRAITH_DISCORD_GUILD_IDS=123456789012345678'
        ].join('\n')
      )

      const config = resolveDiscordContextConfig({
        env: {
          TASKWRAITH_DISCORD_CONFIG_FILE: envPath,
          TASKWRAITH_DISCORD_BOT_TOKEN: 'env-token',
          TASKWRAITH_DISCORD_GUILD_ID: '345678901234567890'
        },
        homeDir: join(dir, 'home')
      })

      expect(config.botToken).toBe('env-token')
      expect(config.guildIds).toEqual(['345678901234567890'])
      expect(config.loadedConfigFilePath).toBe(envPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
