/**
 * logger.js — Winston logger factory for falconDB
 * 
 * Creates per-server system loggers and per-DN raft loggers.
 * Each DN server gets its own raft.log under logs/<server_id>/raft.log.
 * Supports runtime log level changes via /admin/loglevel.
 */

'use strict';

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const LOGS_DIR = path.join(config.PROJECT_ROOT, 'app', 'logs');

/**
 * Ensure a directory exists (recursive).
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Custom log format: timestamp [level] component: message
 */
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);

/**
 * Create the system logger for a server.
 * @param {string} serverId - e.g. "rp", "dn1a"
 * @returns {winston.Logger}
 */
function createSystemLogger(serverId) {
  const serverLogDir = path.join(LOGS_DIR, serverId);
  ensureDir(serverLogDir);

  const logger = winston.createLogger({
    level: config.getLogLevel(),
    format: logFormat,
    defaultMeta: { component: serverId },
    transports: [
      new winston.transports.File({
        filename: path.join(serverLogDir, `${serverId}.log`)
      }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          logFormat
        )
      })
    ]
  });

  return logger;
}

/**
 * Create the Raft-specific logger for a DN server.
 * Writes to logs/<serverId>/raft.log at trace level.
 * @param {string} serverId - e.g. "dn1a"
 * @returns {winston.Logger}
 */
function createRaftLogger(serverId) {
  const serverLogDir = path.join(LOGS_DIR, serverId);
  ensureDir(serverLogDir);

  // Winston doesn't have 'trace' by default; add custom level
  const customLevels = {
    levels: {
      error: 0,
      warn: 1,
      info: 2,
      http: 3,
      verbose: 4,
      debug: 5,
      trace: 6
    },
    colors: {
      error: 'red',
      warn: 'yellow',
      info: 'green',
      http: 'magenta',
      verbose: 'cyan',
      debug: 'blue',
      trace: 'gray'
    }
  };

  winston.addColors(customLevels.colors);

  const raftLogger = winston.createLogger({
    levels: customLevels.levels,
    level: 'trace',
    format: logFormat,
    defaultMeta: { component: `${serverId}/raft` },
    transports: [
      new winston.transports.File({
        filename: path.join(serverLogDir, 'raft.log')
      }),
      new winston.transports.Console({
        level: 'info',
        format: winston.format.combine(
          winston.format.colorize(),
          logFormat
        )
      })
    ]
  });

  return raftLogger;
}

/**
 * Change the runtime log level for a logger.
 * @param {winston.Logger} logger
 * @param {string} level - new level (e.g. 'debug', 'info', 'trace')
 */
function setLogLevel(logger, level) {
  logger.level = level;
  logger.transports.forEach(t => {
    // Only change file transport levels; keep console at its own level
    if (t instanceof winston.transports.File) {
      t.level = level;
    }
  });
}

module.exports = {
  createSystemLogger,
  createRaftLogger,
  setLogLevel
};
