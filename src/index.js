import 'dotenv/config'

import importFresh from './utils/importFresh.js'
import * as baileys from '@whiskeysockets/baileys'
import { defineCommand, runMain } from 'citty'
import { apiKey } from './config/api.js'
import { dotCase } from 'change-case'
import bot from './config/bot.js'
import logger from './logger.js'
import * as db from './db.js'
import fs from 'fs/promises'
import pino from 'pino'

let globalArgs = {}

const main = defineCommand({
  meta: {
    name: 'deadbyte',
    version: '3.0.0',
    description: 'DeadByte - Bot de Figurinhas para Whatsapp'
  },
  args: {
    name: {
      type: 'positional',
      description: 'Bot name unique per session'
    },
    sticker: {
      type: 'boolean',
      description: 'Deactivate all commands and only listen to stickers'
    },
    'no-store': {
      type: 'boolean',
      description: 'Do not store session data'
    },
    'no-reply': {
      type: 'boolean',
      description: 'Do not reply to messages'
    },
    'use-pairing-code': {
      type: 'boolean',
      description: 'Use pairing code instead of QR code'
    },
    mobile: {
      type: 'boolean',
      description: 'Use mobile user agent'
    }
  },
  run ({ args }) {
    globalArgs = args
    bot.name = args.name
    logger.info(`Starting bot "${args.name}"`)
    bot.useStore = !args['no-store']
    logger.info(`Store mode: ${bot.useStore ? 'on' : 'off'}`)
    bot.doReplies = !args['no-reply']
    logger.info(`Reply messages: ${bot.doReplies ? 'on' : 'off'}`)

    bot.usePairingCode = args['use-pairing-code']
    bot.useMobile = args.mobile
    bot.mode = 'qr'
    if (bot.usePairingCode) bot.mode = 'pairing'
    if (bot.useMobile) bot.mode = 'mobile'
    logger.info(`Mode: ${bot.mode}`)

    bot.stickerOnly = args.stickerOnly
    logger.info(`Sticker only mode: ${bot.stickerOnly ? 'on' : 'off'}`)

    const store = bot.useStore
      ? baileys.makeInMemoryStore({ logger: pino().child({ level: 'fatal', stream: 'store' }) })
      : undefined

    const storePath = `./src/temp/${bot.name}.json`
    store.readFromFile(storePath)
    // save every 10s
    setInterval(() => {
      store.writeToFile(storePath)
    }, 10_000)

    connectToWhatsApp()
  }
})

const store = undefined
runMain(main)

/**
 * Grabs CLI args
 * @returns {object}
 */
export function getArgs () {
  return globalArgs
}

/**
 * Baileys socket or null if not connected
*/
// @type {import('@whiskeysockets/baileys').WSocket | null}
let socket = null

/**
 * Grabs the socket
 * @returns {import('./types').WSocket}
 */
export function getSocket () {
  return socket
}

export async function connectToWhatsApp () {
  // if no API KEY, kill the process
  if (!apiKey) {
    logger.fatal('API_KEY not found! Grab one at https://api.deadbyte.com.br')
    process.exit(1)
  }

  logger.info('Connecting to WhatsApp...')

  const { state, saveCreds } = await baileys.useMultiFileAuthState(`./src/temp/${bot.name}`)

  socket = baileys.makeWASocket({
    printQRInTerminal: true,
    logger: pino({ level: 'fatal' }),
    auth: state,
    browser: ['DeadByte', 'Safari', '3.0'],
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: jid => baileys.isJidBroadcast(jid), // TODO: make a stories downloader
    getMessage: async key => { return { } }
  })

  store?.bind(socket.ev)

  logger.info('Loading events...', bot)

  const events = await fs.readdir('./src/services/events')
  events.forEach(async event => {
    if (!bot.doReplies) {
      const ignoreEvents = ['call.js', 'messagesUpsert.js']
      if (ignoreEvents.includes(event)) return
    }
    const eventPath = `services/events/${event}`
    const eventName = dotCase(event.split('.')[0])
    logger.trace(`Loading event ${eventName} from file ${event}`)
    socket.ev.on(eventName, async (event) => {
      const module = await importFresh(eventPath)
      module.default(event)
    })
  })
  socket.ev.on('creds.update', saveCreds)

  logger.info('Client initialized!')
  await db.findCurrentBot(socket) // find the current bot on the database
  return socket
}

// clear terminal
process.stdout.write('\x1B[2J\x1B[0f')

// catch unhandled rejections and errors to avoid crashing
process.on('unhandledRejection', (err) => {
  console.log('unhandledRejection')
  logger.fatal(err)
})
process.on('uncaughtException', (err) => {
  console.log('uncaughtException')
  // Connection Closed try connectToWhatsApp
  if (err.message.includes('Connection Closed')) {
    logger.fatal('Connection Closed AAAAAAAAAAA')
    connectToWhatsApp()
  } else {
    logger.fatal(err)
  }
})
