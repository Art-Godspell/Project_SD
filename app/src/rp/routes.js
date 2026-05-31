/**
 * routes.js — Express route definitions for falconDB Reverse Proxy
 * 
 * The RP is the public entry point. It shards keys to DN groups and
 * forwards requests to the elected Master of each group.
 * 
 * Route access types:
 *   Public: /status, /stat, /db/c, /db/r, /db/u, /db/d
 *   Private: /admin/loglevel
 *   DNp: /set_master (only from DN servers)
 *   RPt: /stop
 */

'use strict';

const express = require('express');
const axios = require('axios');
const { sendSuccess, sendError } = require('../shared/response');
const { setLogLevel } = require('../shared/logger');
const { getGroupForKey } = require('./sharding');

/**
 * Create the RP router.
 * @param {Object} ctx - { masters, logger, config }
 *   masters: Map<groupId, { id, host, port }>  — tracks elected masters per group
 * @returns {express.Router}
 */
function createRPRoutes(ctx) {
  const router = express.Router();
  const { masters, logger } = ctx;

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC ROUTES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * GET /status — Health check
   */
  router.get('/status', (req, res) => {
    sendSuccess(res, {
      server: 'rp',
      status: 'alive',
      uptime: process.uptime(),
      masters: Object.fromEntries(masters)
    });
  });

  /**
   * GET /stat — System statistics
   */
  router.get('/stat', async (req, res) => {
    const stats = {
      server: 'rp',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      masters: Object.fromEntries(masters),
      dn_groups: {}
    };

    // Optionally fetch stats from all known masters
    for (const [groupId, master] of masters) {
      try {
        const resp = await axios.get(`http://${master.host}:${master.port}/stat`, { timeout: 2000 });
        stats.dn_groups[groupId] = resp.data.data;
      } catch (err) {
        stats.dn_groups[groupId] = { error: `Unreachable: ${err.message}` };
      }
    }

    sendSuccess(res, stats);
  });

  // ═══════════════════════════════════════════════════════════════════
  // PRIVATE ROUTES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * GET /admin/loglevel — Get or set log level
   */
  router.get('/admin/loglevel', (req, res) => {
    const { level } = req.query;
    if (level) {
      setLogLevel(logger, level);
      logger.info(`RP log level changed to: ${level}`);
      sendSuccess(res, { level });
    } else {
      sendSuccess(res, { level: logger.level });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // DB ROUTES — Public, shard & forward to DN Master
  // ═══════════════════════════════════════════════════════════════════

  /**
   * POST /db/c — Create
   * Body: { "key": <key>, "value": <value> }
   */
  router.post('/db/c', async (req, res) => {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return sendError(res, 'eRPRT001E', 'Missing key or value in request body');
    }

    const master = _getMasterForKey(key, masters);
    if (!master) {
      return sendError(res, 'eRPRT005E');
    }

    try {
      const resp = await axios.post(`http://${master.host}:${master.port}/db/c`, { key, value }, { timeout: 5000 });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      return _handleForwardError(res, err, 'create', key);
    }
  });

  /**
   * GET /db/r — Read
   *   ?key=<key>
   */
  router.get('/db/r', async (req, res) => {
    const { key } = req.query;

    if (!key) {
      return sendError(res, 'eRPRT001E', 'Missing key parameter');
    }

    const master = _getMasterForKey(key, masters);
    if (!master) {
      return sendError(res, 'eRPRT005E');
    }

    try {
      const resp = await axios.get(`http://${master.host}:${master.port}/db/r`, {
        params: { key },
        timeout: 5000
      });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      return _handleForwardError(res, err, 'read', key);
    }
  });

  /**
   * POST /db/u — Update
   * Body: { "key": <key>, "value": <value> }
   */
  router.post('/db/u', async (req, res) => {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return sendError(res, 'eRPRT001E', 'Missing key or value in request body');
    }

    const master = _getMasterForKey(key, masters);
    if (!master) {
      return sendError(res, 'eRPRT005E');
    }

    try {
      const resp = await axios.post(`http://${master.host}:${master.port}/db/u`, { key, value }, { timeout: 5000 });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      return _handleForwardError(res, err, 'update', key);
    }
  });

  /**
   * GET /db/d — Delete
   *   ?key=<key>
   */
  router.get('/db/d', async (req, res) => {
    const { key } = req.query;

    if (!key) {
      return sendError(res, 'eRPRT001E', 'Missing key parameter');
    }

    const master = _getMasterForKey(key, masters);
    if (!master) {
      return sendError(res, 'eRPRT005E');
    }

    try {
      const resp = await axios.get(`http://${master.host}:${master.port}/db/d`, {
        params: { key },
        timeout: 5000
      });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      return _handleForwardError(res, err, 'delete', key);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // DNp ROUTES — Only from DN servers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * GET /set_master — DN Master registers itself with the RP
   *   ?group=<groupId>&id=<serverId>&host=<host>&port=<port>
   */
  router.get('/set_master', (req, res) => {
    const { group, id, host, port } = req.query;

    if (!group || !id || !host || !port) {
      return sendError(res, 'eRPRT001E', 'Missing group, id, host, or port');
    }

    masters.set(group, { id, host, port: parseInt(port, 10) });
    logger.info(`Master registered: group=${group}, id=${id}, host=${host}:${port}`);

    sendSuccess(res, { group, master: { id, host, port } });
  });

  // ═══════════════════════════════════════════════════════════════════
  // RPt ROUTES
  // ═══════════════════════════════════════════════════════════════════

  /**
   * GET /stop — Graceful shutdown. Cascades stop to all DN masters.
   */
  router.get('/stop', async (req, res) => {
    logger.info('RP received stop command, cascading to DN masters');

    // Send stop to all known masters
    for (const [groupId, master] of masters) {
      try {
        await axios.get(`http://${master.host}:${master.port}/stop`, { timeout: 2000 });
        logger.info(`Stop sent to ${groupId} master (${master.id})`);
      } catch (err) {
        logger.warn(`Failed to stop ${groupId} master: ${err.message}`);
      }
    }

    sendSuccess(res, { message: 'RP shutting down' });

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });

  return router;
}

// ── Helper functions ─────────────────────────────────────────────────

/**
 * Get the master server for a given key (based on sharding).
 * @param {string} key
 * @param {Map} masters
 * @returns {Object|null} { id, host, port } or null
 */
function _getMasterForKey(key, masters) {
  const group = getGroupForKey(key);
  return masters.get(group.id) || null;
}

/**
 * Handle errors when forwarding requests to DN masters.
 */
function _handleForwardError(res, err, op, key) {
  if (err.response) {
    // DN responded with an error — pass it through
    return res.status(err.response.status).json(err.response.data);
  }
  // Network error — DN unreachable
  return sendError(res, 'eRPRT004E', `DN unreachable for ${op} on key "${key}": ${err.message}`);
}

module.exports = { createRPRoutes };
