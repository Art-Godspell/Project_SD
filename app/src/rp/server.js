/**
 * server.js — Reverse Proxy entry point for falconDB
 * 
 * Usage: node app/src/rp/server.js
 * 
 * The RP is the public-facing entry point. It maintains a map of
 * elected DN masters and forwards CRUD requests to the appropriate master
 * based on key sharding.
 */

'use strict';

const express = require('express');
const config = require('../shared/config');
const { createSystemLogger } = require('../shared/logger');
const { createRPRoutes } = require('./routes');

// ── Initialize ──────────────────────────────────────────────────────
const rpConfig = config.getRP();
const logger = createSystemLogger('rp');

logger.info('Starting falconDB Reverse Proxy');
logger.info(`Listening on ${rpConfig.host}:${rpConfig.port}`);

// Master registry: Map<groupId, { id, host, port }>
const masters = new Map();

// ── Create Express app ──────────────────────────────────────────────
const app = express();

// Trust proxy for correct IP detection
app.set('trust proxy', true);

// Parse JSON bodies (for POST /db/c, /db/u)
app.use(express.json());

// Mount RP routes
const ctx = { masters, logger, config };
app.use('/', createRPRoutes(ctx));

// ── Start server ────────────────────────────────────────────────────
const server = app.listen(rpConfig.port, rpConfig.host, () => {
  logger.info(`RP listening on http://${rpConfig.host}:${rpConfig.port}`);

  // Log configured DN groups
  const groups = config.getDNGroups();
  groups.forEach(g => {
    logger.info(`DN group "${g.id}": ${g.servers.map(s => `${s.id}@${s.host}:${s.port}`).join(', ')}`);
  });

  logger.info('Waiting for DN masters to register via /set_master...');
});

// ── Graceful shutdown ───────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('RP received SIGTERM, shutting down');
  server.close(() => {
    logger.info('RP shut down gracefully');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('RP received SIGINT, shutting down');
  server.close(() => {
    logger.info('RP shut down gracefully');
    process.exit(0);
  });
});

module.exports = app;
