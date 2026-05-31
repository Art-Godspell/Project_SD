/**
 * errors.js — Normalized error code catalog for falconDB
 * 
 * Convention:  e<COMPONENT><MODULE><NNN><SEVERITY>
 *   COMPONENT: RP | DN
 *   MODULE:    RT (Route), ST (Storage), RF (Raft), TC (TwoPC), MD (Middleware), CF (Config)
 *   NNN:       Zero-padded 3-digit number
 *   SEVERITY:  E (Error), W (Warning), I (Info)
 */

'use strict';

const ERROR_CODES = {
  // ── Reverse Proxy — Route errors ──────────────────────────────────────
  eRPRT001E: { code: 'eRPRT001E', errno: 400, message: 'Missing or invalid request body' },
  eRPRT002E: { code: 'eRPRT002E', errno: 404, message: 'Key not found' },
  eRPRT003E: { code: 'eRPRT003E', errno: 409, message: 'Key already exists' },
  eRPRT004E: { code: 'eRPRT004E', errno: 500, message: 'Data node unreachable' },
  eRPRT005E: { code: 'eRPRT005E', errno: 503, message: 'No master known for DN group' },

  // ── Reverse Proxy — Middleware warnings ───────────────────────────────
  eRPMD001W: { code: 'eRPMD001W', errno: 403, message: 'Unauthorized access' },

  // ── Data Node — Storage errors ────────────────────────────────────────
  eDNST001E: { code: 'eDNST001E', errno: 500, message: 'File system error' },
  eDNST002E: { code: 'eDNST002E', errno: 404, message: 'Key not found in storage' },
  eDNST003E: { code: 'eDNST003E', errno: 409, message: 'Key already exists in storage' },

  // ── Data Node — Raft info/errors ──────────────────────────────────────
  eDNRF001I: { code: 'eDNRF001I', errno: 0,   message: 'Election started' },
  eDNRF002I: { code: 'eDNRF002I', errno: 0,   message: 'Vote requested / granted / denied' },
  eDNRF003I: { code: 'eDNRF003I', errno: 0,   message: 'Leader elected' },
  eDNRF004E: { code: 'eDNRF004E', errno: 500, message: 'Election timeout or failure' },

  // ── Data Node — Two-Phase Commit errors ───────────────────────────────
  eDNTC001E: { code: 'eDNTC001E', errno: 500, message: 'Two-Phase Commit prepare failed' },
  eDNTC002E: { code: 'eDNTC002E', errno: 500, message: 'Two-Phase Commit commit/abort failed' },

  // ── Data Node — Middleware warnings ───────────────────────────────────
  eDNMD001W: { code: 'eDNMD001W', errno: 403, message: 'Request rejected — not from RP or test client' },

  // ── Data Node — Route errors ──────────────────────────────────────────
  eDNRT001E: { code: 'eDNRT001E', errno: 400, message: 'Missing or invalid request body' },
  eDNRT002E: { code: 'eDNRT002E', errno: 500, message: 'Internal server error' },

  // ── Config errors ─────────────────────────────────────────────────────
  eCFCF001E: { code: 'eCFCF001E', errno: 500, message: 'Configuration file not found or invalid' }
};

/**
 * Build a standardized error object, optionally overriding the default message.
 * @param {string} code - Error code key, e.g. 'eRPRT001E'
 * @param {string} [customMessage] - Optional override for the default message
 * @returns {Object} { code, errno, message }
 */
function makeError(code, customMessage) {
  const template = ERROR_CODES[code];
  if (!template) {
    return { code: 'eUNKN000E', errno: 500, message: customMessage || 'Unknown error' };
  }
  return {
    code: template.code,
    errno: template.errno,
    message: customMessage || template.message
  };
}

module.exports = {
  ERROR_CODES,
  makeError
};
