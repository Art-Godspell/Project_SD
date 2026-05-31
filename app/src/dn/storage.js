/**
 * storage.js — File-based CRUD storage engine for falconDB
 * 
 * Data lives in app/DBdata/<server_id>/. Each record is a JSON file named
 * using the MD5 hash of the key. File content: {"key": <key>, "value": <value>}.
 * 
 * Update implements --delete-- member semantics:
 *   - value === "--delete--"         → remove that member
 *   - value === "\\-\\-delete\\-\\-" → set member to literal "--delete--"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const md5 = require('md5');
const config = require('../shared/config');

/**
 * Create a Storage instance for a specific DN server.
 * @param {string} serverId - e.g. "dn1a"
 * @param {Object} logger - Winston logger instance
 */
class Storage {
  constructor(serverId, logger) {
    this.serverId = serverId;
    this.logger = logger;
    this.dataDir = path.join(config.PROJECT_ROOT, 'app', 'DBdata', serverId);
    this._ensureDir();
  }

  /**
   * Ensure the data directory exists.
   */
  _ensureDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.logger.info(`Created data directory: ${this.dataDir}`);
    }
  }

  /**
   * Get the file path for a key.
   * @param {string} key
   * @returns {string} Absolute path to the JSON file
   */
  _filePath(key) {
    const hash = md5(key);
    return path.join(this.dataDir, `${hash}.json`);
  }

  /**
   * Create a new record. Fails if key already exists.
   * @param {string} key
   * @param {*} value
   * @returns {Object} { success: true, data } or { success: false, errorCode, message }
   */
  create(key, value) {
    const filePath = this._filePath(key);

    if (fs.existsSync(filePath)) {
      this.logger.warn(`Create failed — key already exists: ${key}`);
      return { success: false, errorCode: 'eDNST003E', message: `Key already exists: ${key}` };
    }

    try {
      const record = { key, value };
      fs.writeFileSync(filePath, JSON.stringify(record), 'utf-8');
      this.logger.info(`Created key: ${key}`);
      return { success: true, data: record };
    } catch (err) {
      this.logger.error(`FS write error on create: ${err.message}`);
      return { success: false, errorCode: 'eDNST001E', message: err.message };
    }
  }

  /**
   * Read a record by key. Fails if key not found.
   * @param {string} key
   * @returns {Object} { success: true, data } or { success: false, errorCode, message }
   */
  read(key) {
    const filePath = this._filePath(key);

    if (!fs.existsSync(filePath)) {
      this.logger.warn(`Read failed — key not found: ${key}`);
      return { success: false, errorCode: 'eDNST002E', message: `Key not found: ${key}` };
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw);
      this.logger.info(`Read key: ${key}`);
      return { success: true, data: record };
    } catch (err) {
      this.logger.error(`FS read error: ${err.message}`);
      return { success: false, errorCode: 'eDNST001E', message: err.message };
    }
  }

  /**
   * Update a record with --delete-- member semantics.
   * 
   * Merge incoming fields into the stored value:
   *   - value === "--delete--"           → remove that member
   *   - value === "\\-\\-delete\\-\\-"   → set to literal "--delete--"
   *   - otherwise                        → overwrite the member
   * 
   * @param {string} key
   * @param {Object} newValue - Object with fields to merge/delete
   * @returns {Object} { success: true, data } or { success: false, errorCode, message }
   */
  update(key, newValue) {
    const filePath = this._filePath(key);

    if (!fs.existsSync(filePath)) {
      this.logger.warn(`Update failed — key not found: ${key}`);
      return { success: false, errorCode: 'eDNST002E', message: `Key not found: ${key}` };
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw);
      let storedValue = record.value;

      // If stored value is an object and incoming is an object, apply merge semantics
      if (typeof storedValue === 'object' && storedValue !== null &&
          typeof newValue === 'object' && newValue !== null) {
        for (const [field, val] of Object.entries(newValue)) {
          if (val === '--delete--') {
            // Remove the member
            delete storedValue[field];
            this.logger.debug(`Update: deleted member "${field}" from key "${key}"`);
          } else if (val === '\\-\\-delete\\-\\-') {
            // Set to literal "--delete--"
            storedValue[field] = '--delete--';
            this.logger.debug(`Update: set member "${field}" to literal "--delete--" in key "${key}"`);
          } else {
            storedValue[field] = val;
          }
        }
      } else {
        // If not objects, just overwrite the value entirely
        storedValue = newValue;
      }

      record.value = storedValue;
      fs.writeFileSync(filePath, JSON.stringify(record), 'utf-8');
      this.logger.info(`Updated key: ${key}`);
      return { success: true, data: record };
    } catch (err) {
      this.logger.error(`FS update error: ${err.message}`);
      return { success: false, errorCode: 'eDNST001E', message: err.message };
    }
  }

  /**
   * Delete a record by key. Fails if key not found.
   * @param {string} key
   * @returns {Object} { success: true } or { success: false, errorCode, message }
   */
  delete(key) {
    const filePath = this._filePath(key);

    if (!fs.existsSync(filePath)) {
      this.logger.warn(`Delete failed — key not found: ${key}`);
      return { success: false, errorCode: 'eDNST002E', message: `Key not found: ${key}` };
    }

    try {
      fs.unlinkSync(filePath);
      this.logger.info(`Deleted key: ${key}`);
      return { success: true };
    } catch (err) {
      this.logger.error(`FS delete error: ${err.message}`);
      return { success: false, errorCode: 'eDNST001E', message: err.message };
    }
  }

  /**
   * Check if a key exists without reading the full record.
   * @param {string} key
   * @returns {boolean}
   */
  exists(key) {
    return fs.existsSync(this._filePath(key));
  }

  /**
   * List all stored keys (for stat purposes).
   * @returns {number} Count of stored records
   */
  count() {
    try {
      const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
      return files.length;
    } catch {
      return 0;
    }
  }
}

module.exports = Storage;
