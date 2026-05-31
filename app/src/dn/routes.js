/**
 * routes.js — Express route definitions for falconDB Data Node
 * 
 * Route access types:
 *   Public:  /status, /stat
 *   Private: /admin/loglevel
 *   RPt:     /db/c, /db/r, /db/u, /db/d, /stop (only from RP or test client)
 *   DNp:     /election, /maintenance (only from DN peers in same group)
 */

'use strict';

const express = require('express');
const { requireRPt, requireDNp } = require('../shared/middleware');
const { sendSuccess, sendError } = require('../shared/response');
const { setLogLevel } = require('../shared/logger');

/**
 * Create the DN router.
 * @param {Object} ctx - Server context { serverId, storage, raft, coordinator, participant, logger }
 * @returns {express.Router}
 */
function createDNRoutes(ctx) {
  const router = express.Router();
  const { serverId, storage, raft, coordinator, participant, logger } = ctx;

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC ROUTES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * GET /status — Health check
   */
  router.get('/status', (req, res) => {
    sendSuccess(res, {
      server: serverId,
      status: 'alive',
      role: raft.state,
      uptime: process.uptime()
    });
  });

  /**
   * GET /stat — System statistics
   */
  router.get('/stat', (req, res) => {
    sendSuccess(res, {
      server: serverId,
      raft: raft.getStatus(),
      storage: {
        recordCount: storage.count()
      },
      memory: process.memoryUsage(),
      uptime: process.uptime()
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PRIVATE ROUTES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * GET /admin/loglevel — Get or set log level
   *   ?level=debug  → sets level
   *   no param      → returns current level
   */
  router.get('/admin/loglevel', (req, res) => {
    const { level } = req.query;
    if (level) {
      setLogLevel(logger, level);
      logger.info(`Log level changed to: ${level}`);
      sendSuccess(res, { level });
    } else {
      sendSuccess(res, { level: logger.level });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // RPt ROUTES — Only from RP or test client (Fix #4)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * POST /db/c — Create a key-value pair
   * Body: { "key": <key>, "value": <value> }
   * On Master: initiates 2PC. On replica: rejected (should go through Master).
   */
  router.post('/db/c', requireRPt, async (req, res) => {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return sendError(res, 'eDNRT001E', 'Missing key or value in request body');
    }

    if (raft.isLeader()) {
      // Master: coordinate 2PC
      try {
        const result = await coordinator.execute('create', key, value);
        if (result.success) {
          sendSuccess(res, result.data);
        } else {
          sendError(res, result.errorCode || 'eDNTC001E', result.message);
        }
      } catch (err) {
        logger.error(`2PC create error: ${err.message}`);
        sendError(res, 'eDNTC002E', err.message);
      }
    } else {
      // Not the leader — this shouldn't happen if RP routes correctly
      sendError(res, 'eDNRT002E', `${serverId} is not the master`);
    }
  });

  /**
   * GET /db/r — Read a key
   *   ?key=<key>
   */
  router.get('/db/r', requireRPt, (req, res) => {
    const { key } = req.query;

    if (!key) {
      return sendError(res, 'eDNRT001E', 'Missing key parameter');
    }

    const result = storage.read(key);
    if (result.success) {
      sendSuccess(res, result.data);
    } else {
      sendError(res, result.errorCode, result.message);
    }
  });

  /**
   * POST /db/u — Update a key's value (with --delete-- semantics)
   * Body: { "key": <key>, "value": <value> }
   */
  router.post('/db/u', requireRPt, async (req, res) => {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return sendError(res, 'eDNRT001E', 'Missing key or value in request body');
    }

    if (raft.isLeader()) {
      try {
        const result = await coordinator.execute('update', key, value);
        if (result.success) {
          sendSuccess(res, result.data);
        } else {
          sendError(res, result.errorCode || 'eDNTC001E', result.message);
        }
      } catch (err) {
        logger.error(`2PC update error: ${err.message}`);
        sendError(res, 'eDNTC002E', err.message);
      }
    } else {
      sendError(res, 'eDNRT002E', `${serverId} is not the master`);
    }
  });

  /**
   * GET /db/d — Delete a key
   *   ?key=<key>
   */
  router.get('/db/d', requireRPt, async (req, res) => {
    const { key } = req.query;

    if (!key) {
      return sendError(res, 'eDNRT001E', 'Missing key parameter');
    }

    if (raft.isLeader()) {
      try {
        const result = await coordinator.execute('delete', key, null);
        if (result.success) {
          sendSuccess(res, { deleted: key });
        } else {
          sendError(res, result.errorCode || 'eDNTC001E', result.message);
        }
      } catch (err) {
        logger.error(`2PC delete error: ${err.message}`);
        sendError(res, 'eDNTC002E', err.message);
      }
    } else {
      sendError(res, 'eDNRT002E', `${serverId} is not the master`);
    }
  });

  /**
   * GET /stop — Graceful shutdown (RPt access)
   */
  router.get('/stop', requireRPt, (req, res) => {
    logger.info(`${serverId} received stop command`);
    sendSuccess(res, { message: `${serverId} shutting down` });

    // Graceful shutdown
    setTimeout(() => {
      raft.stop();
      process.exit(0);
    }, 500);
  });

  // ═══════════════════════════════════════════════════════════════════
  // DNp ROUTES — Only from DN peers in same group
  // ═══════════════════════════════════════════════════════════════════

  /**
   * GET /election — Raft vote request and heartbeat handler
   *   ?action=request_vote&candidateId=<id>&term=<n>
   *   ?action=heartbeat&leaderId=<id>&term=<n>
   */
  router.get('/election', requireDNp(serverId), (req, res) => {
    const { action, candidateId, leaderId, term } = req.query;

    switch (action) {
      case 'request_vote': {
        const result = raft.handleVoteRequest(candidateId, term);
        sendSuccess(res, result);
        break;
      }

      case 'heartbeat': {
        const result = raft.handleHeartbeat(leaderId, term);
        sendSuccess(res, result);
        break;
      }

      default:
        sendError(res, 'eDNRT001E', `Unknown election action: ${action}`);
    }
  });

  /**
   * POST /maintenance — Two-Phase Commit participant handler
   *   ?action=prepare  Body: { txId, op, key, value }
   *   ?action=commit   Body: { txId, op, key, value }
   *   ?action=abort    Body: { txId }
   * 
   * NOTE: Spec lists /maintenance as GET, but 2PC requires sending payloads.
   * Using POST is a documented spec-divergence (see implementation plan).
   */
  router.post('/maintenance', requireDNp(serverId), (req, res) => {
    const { action } = req.query;

    switch (action) {
      case 'prepare': {
        const result = participant.prepare(req.body);
        sendSuccess(res, result);
        break;
      }

      case 'commit': {
        const result = participant.commit(req.body);
        if (result.success) {
          sendSuccess(res, result.data || { committed: true });
        } else {
          sendError(res, 'eDNTC002E', result.message);
        }
        break;
      }

      case 'abort': {
        const result = participant.abort(req.body);
        sendSuccess(res, result);
        break;
      }

      default:
        sendError(res, 'eDNRT001E', `Unknown maintenance action: ${action}`);
    }
  });

  return router;
}

module.exports = { createDNRoutes };
