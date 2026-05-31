/**
 * middleware.js — Access control middleware for falconDB
 * 
 * Implements the spec's access control types:
 *   - Public (pub):  No restriction.
 *   - Private (prv): No restriction (admin endpoints, no IP check in spec).
 *   - RPt:           Only accepts requests from the RP's IP or test_client_ip.
 *   - DNp:           Only accepts requests from DN servers in the same group.
 */

'use strict';

const config = require('./config');
const { sendError } = require('./response');

/**
 * Normalize an IP address — strip IPv6-mapped IPv4 prefix.
 * e.g. "::ffff:127.0.0.1" → "127.0.0.1"
 * @param {string} ip
 * @returns {string}
 */
function normalizeIP(ip) {
  if (!ip) return '';
  // Strip IPv6-mapped IPv4 prefix
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  // Handle IPv6 loopback
  if (ip === '::1') {
    return '127.0.0.1';
  }
  return ip;
}

/**
 * Extract the client IP from an Express request.
 * @param {Object} req
 * @returns {string}
 */
function getClientIP(req) {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return normalizeIP(raw);
}

/**
 * RPt middleware — only allows requests from the RP or the test client.
 * Used on DN servers for /db/c, /db/r, /db/u, /db/d, /stop.
 */
function requireRPt(req, res, next) {
  const clientIP = getClientIP(req);
  const rpHost = config.getRP().host;
  const testClientIP = config.getTestClientIP();

  const allowed = [
    normalizeIP(rpHost),
    normalizeIP(testClientIP)
  ].filter(Boolean);

  if (allowed.includes(clientIP)) {
    return next();
  }

  return sendError(res, 'eDNMD001W', `Request from ${clientIP} rejected — not from RP or test client`);
}

/**
 * DNp middleware — only allows requests from DN servers in the same group.
 * Used on DN servers for /election, /maintenance.
 * @param {string} selfId - This server's ID (e.g. "dn1a")
 */
function requireDNp(selfId) {
  return function(req, res, next) {
    const clientIP = getClientIP(req);
    const groupServers = config.getGroupServers(selfId);
    const testClientIP = config.getTestClientIP();

    const allowed = groupServers
      .map(s => normalizeIP(s.host))
      .concat(normalizeIP(testClientIP))
      .filter(Boolean);

    if (allowed.includes(clientIP)) {
      return next();
    }

    return sendError(res, 'eDNMD001W', `Request from ${clientIP} rejected — not from DN group`);
  };
}

module.exports = {
  normalizeIP,
  getClientIP,
  requireRPt,
  requireDNp
};
