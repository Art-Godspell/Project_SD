/**
 * server.js — Data Node entry point for falconDB
 * 
 * Usage: node app/src/dn/server.js <serverId>
 *   e.g. node app/src/dn/server.js dn1a
 * 
 * Starts the Express server, initializes storage, Raft election,
 * and Two-Phase Commit coordinator/participant.
 */

'use strict';

const express = require('express');
const config = require('../shared/config');
const { createSystemLogger, createRaftLogger } = require('../shared/logger');
const Storage = require('./storage');
const { RaftNode } = require('./raft');
const { TwoPCCoordinator, TwoPCParticipant } = require('./twopc');
const { createDNRoutes } = require('./routes');

// ── Get server ID from command line ──────────────────────────────────
const serverId = process.argv[2];

if (!serverId) {
  console.error('Usage: node app/src/dn/server.js <serverId>');
  console.error('  e.g. node app/src/dn/server.js dn1a');
  process.exit(1);
}

const serverConfig = config.getServerById(serverId);
if (!serverConfig) {
  console.error(`Server ID "${serverId}" not found in configure.json`);
  process.exit(1);
}

// ── Initialize loggers ──────────────────────────────────────────────
const logger = createSystemLogger(serverId);
const raftLogger = createRaftLogger(serverId);

logger.info(`Starting falconDB Data Node: ${serverId}`);
logger.info(`Listening on ${serverConfig.host}:${serverConfig.port}`);

// ── Initialize storage ──────────────────────────────────────────────
const storage = new Storage(serverId, logger);

// ── Initialize Raft ─────────────────────────────────────────────────
const raft = new RaftNode(serverId, raftLogger, logger);

// ── Initialize Two-Phase Commit ─────────────────────────────────────
const coordinator = new TwoPCCoordinator(serverId, storage, logger);
const participant = new TwoPCParticipant(serverId, storage, logger);

// ── Create Express app ──────────────────────────────────────────────
const app = express();

// Trust proxy for correct IP detection
app.set('trust proxy', true);

// Parse JSON bodies (for POST /db/c, /db/u, /maintenance)
app.use(express.json());

// Mount DN routes
const ctx = { serverId, storage, raft, coordinator, participant, logger };
app.use('/', createDNRoutes(ctx));

// ── Start server ────────────────────────────────────────────────────
const server = app.listen(serverConfig.port, serverConfig.host, () => {
  logger.info(`${serverId} listening on http://${serverConfig.host}:${serverConfig.port}`);

  // Start Raft election after server is up
  setTimeout(() => {
    logger.info(`${serverId} starting Raft election`);
    raft.start();
  }, 500); // Small delay to let all servers in the group start
});

// ── Graceful shutdown ───────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info(`${serverId} received SIGTERM, shutting down`);
  raft.stop();
  server.close(() => {
    logger.info(`${serverId} shut down gracefully`);
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info(`${serverId} received SIGINT, shutting down`);
  raft.stop();
  server.close(() => {
    logger.info(`${serverId} shut down gracefully`);
    process.exit(0);
  });
});

module.exports = app;
