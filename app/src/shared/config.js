/**
 * config.js — Configuration loader for falconDB
 * 
 * Loads /app/etc/configure.json (or project-relative app/etc/configure.json
 * for local development). Provides helper methods to look up server info
 * by ID, find peers within a DN group, and resolve the RP address.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Resolve project root: walk up from this file's location (app/src/shared/)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'app', 'etc', 'configure.json');

let _config = null;

/**
 * Load and cache the configuration file.
 * @returns {Object} The parsed configuration object.
 */
function load() {
  if (_config) return _config;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Configuration file not found: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  _config = JSON.parse(raw);
  return _config;
}

/**
 * Get the full config object.
 */
function getConfig() {
  return load();
}

/**
 * Find a server definition by its ID across RP and all DN groups.
 * @param {string} serverId - e.g. "rp", "dn1a", "dn2b"
 * @returns {Object|null} { id, host, port } or null
 */
function getServerById(serverId) {
  const cfg = load();

  if (cfg.rp.id === serverId) {
    return cfg.rp;
  }

  for (const group of cfg.dn_groups) {
    for (const server of group.servers) {
      if (server.id === serverId) {
        return server;
      }
    }
  }

  return null;
}

/**
 * Find which DN group a server belongs to, and return the group config.
 * @param {string} serverId - e.g. "dn1a"
 * @returns {Object|null} The dn_group object { id, servers: [...] } or null
 */
function getGroupByServerId(serverId) {
  const cfg = load();

  for (const group of cfg.dn_groups) {
    for (const server of group.servers) {
      if (server.id === serverId) {
        return group;
      }
    }
  }

  return null;
}

/**
 * Get the peer servers for a given DN server (same group, excluding self).
 * @param {string} serverId - e.g. "dn1a"
 * @returns {Array} Array of { id, host, port } for peers
 */
function getPeers(serverId) {
  const group = getGroupByServerId(serverId);
  if (!group) return [];
  return group.servers.filter(s => s.id !== serverId);
}

/**
 * Get all servers in the same DN group (including self).
 * @param {string} serverId
 * @returns {Array}
 */
function getGroupServers(serverId) {
  const group = getGroupByServerId(serverId);
  if (!group) return [];
  return group.servers;
}

/**
 * Get the RP connection info.
 * @returns {Object} { id, host, port }
 */
function getRP() {
  return load().rp;
}

/**
 * Get all DN group definitions.
 * @returns {Array}
 */
function getDNGroups() {
  return load().dn_groups;
}

/**
 * Get the test client IP.
 * @returns {string}
 */
function getTestClientIP() {
  return load().test_client_ip;
}

/**
 * Get the configured log level.
 * @returns {string}
 */
function getLogLevel() {
  return load().log_level || 'info';
}

/**
 * Build a base URL for a server.
 * @param {Object} server - { host, port }
 * @returns {string} e.g. "http://127.0.0.1:4001"
 */
function serverUrl(server) {
  return `http://${server.host}:${server.port}`;
}

module.exports = {
  getConfig,
  getServerById,
  getGroupByServerId,
  getPeers,
  getGroupServers,
  getRP,
  getDNGroups,
  getTestClientIP,
  getLogLevel,
  serverUrl,
  PROJECT_ROOT
};
