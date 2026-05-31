/**
 * sharding.js — Key-to-DN-group routing for falconDB Reverse Proxy
 * 
 * Simple consistent hashing: MD5(key) → first hex char → DN group index.
 * With 2 groups: chars 0–7 → dn1, 8–f → dn2.
 * Extensible to N groups by dividing the hex range evenly.
 */

'use strict';

const md5 = require('md5');
const config = require('../shared/config');

/**
 * Determine which DN group a key belongs to.
 * @param {string} key - The data key
 * @returns {Object} The DN group config { id, servers: [...] }
 */
function getGroupForKey(key) {
  const groups = config.getDNGroups();
  const hash = md5(key);
  const firstChar = hash.charAt(0);
  const hexVal = parseInt(firstChar, 16); // 0–15

  // Divide the hex range evenly across groups
  const groupCount = groups.length;
  const rangeSize = Math.ceil(16 / groupCount);
  const groupIndex = Math.min(Math.floor(hexVal / rangeSize), groupCount - 1);

  return groups[groupIndex];
}

/**
 * Get the group ID for a key (convenience wrapper).
 * @param {string} key
 * @returns {string} e.g. "dn1" or "dn2"
 */
function getGroupIdForKey(key) {
  return getGroupForKey(key).id;
}

module.exports = {
  getGroupForKey,
  getGroupIdForKey
};
