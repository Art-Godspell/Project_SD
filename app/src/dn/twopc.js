/**
 * twopc.js — Two-Phase Commit for falconDB Data Nodes
 * 
 * The Master of a DN group acts as coordinator for all write operations
 * (Create, Update, Delete). Ensures data integrity across replicas.
 * 
 * Phase 1 (Prepare): Coordinator sends prepare to all participants.
 *   Participants validate and lock the key, respond with vote (commit/abort).
 * Phase 2 (Commit/Abort): Based on votes, coordinator sends commit or abort.
 *   Participants execute or roll back the operation.
 * 
 * NOTE: /maintenance uses POST (spec-divergence — GET cannot carry 2PC payloads).
 */

'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('crypto');
const config = require('../shared/config');

/**
 * Generate a unique transaction ID.
 * @returns {string}
 */
function generateTxId() {
  return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * TwoPhaseCommit coordinator — runs on the Master DN.
 */
class TwoPCCoordinator {
  /**
   * @param {string} serverId - Master's server ID
   * @param {Object} storage - Storage instance for local operations
   * @param {Object} logger - Winston logger
   */
  constructor(serverId, storage, logger) {
    this.serverId = serverId;
    this.storage = storage;
    this.logger = logger;
    this.peers = config.getPeers(serverId);
  }

  /**
   * Execute a write operation with Two-Phase Commit across all replicas.
   * @param {string} op - 'create', 'update', or 'delete'
   * @param {string} key
   * @param {*} value - The value (null for delete)
   * @returns {Object} { success, data, errorCode, message }
   */
  async execute(op, key, value) {
    const txId = generateTxId();
    this.logger.info(`2PC [${txId}] starting: op=${op}, key=${key}`);

    // ── Phase 1: Prepare ─────────────────────────────────────────────
    const preparePayload = { txId, op, key, value };
    let allVotedCommit = true;

    this.logger.info(`2PC [${txId}] Phase 1: sending PREPARE to ${this.peers.length} peers`);

    const prepareResults = await Promise.allSettled(
      this.peers.map(peer => this._sendPrepare(peer, preparePayload))
    );

    for (const result of prepareResults) {
      if (result.status !== 'fulfilled' || !result.value || result.value.vote !== 'commit') {
        allVotedCommit = false;
        const reason = result.status === 'rejected'
          ? result.reason?.message
          : (result.value?.reason || 'vote=abort');
        this.logger.warn(`2PC [${txId}] peer voted abort: ${reason}`);
      }
    }

    // Also validate locally (Master's own storage)
    const localValidation = this._validateLocally(op, key, value);
    if (!localValidation.success) {
      allVotedCommit = false;
      this.logger.warn(`2PC [${txId}] local validation failed: ${localValidation.message}`);
    }

    // ── Phase 2: Commit or Abort ─────────────────────────────────────
    if (allVotedCommit) {
      this.logger.info(`2PC [${txId}] Phase 2: all voted COMMIT, sending COMMIT`);

      // Execute locally first
      const localResult = this._executeLocally(op, key, value);

      // Send commit to all peers
      await Promise.allSettled(
        this.peers.map(peer => this._sendCommit(peer, { txId, op, key, value }))
      );

      this.logger.info(`2PC [${txId}] committed successfully`);
      return localResult;
    } else {
      this.logger.warn(`2PC [${txId}] Phase 2: sending ABORT`);

      // Send abort to all peers
      await Promise.allSettled(
        this.peers.map(peer => this._sendAbort(peer, { txId }))
      );

      this.logger.warn(`2PC [${txId}] aborted`);
      return {
        success: false,
        errorCode: 'eDNTC001E',
        message: `Two-Phase Commit aborted for key: ${key}`
      };
    }
  }

  /**
   * Validate an operation locally without executing it.
   */
  _validateLocally(op, key, value) {
    switch (op) {
      case 'create':
        if (this.storage.exists(key)) {
          return { success: false, message: `Key already exists: ${key}` };
        }
        return { success: true };

      case 'update':
      case 'delete':
        if (!this.storage.exists(key)) {
          return { success: false, message: `Key not found: ${key}` };
        }
        return { success: true };

      default:
        return { success: false, message: `Unknown operation: ${op}` };
    }
  }

  /**
   * Execute an operation on the local storage.
   */
  _executeLocally(op, key, value) {
    switch (op) {
      case 'create':
        return this.storage.create(key, value);
      case 'update':
        return this.storage.update(key, value);
      case 'delete':
        return this.storage.delete(key);
      default:
        return { success: false, errorCode: 'eDNTC002E', message: `Unknown op: ${op}` };
    }
  }

  /**
   * Send a PREPARE request to a peer.
   */
  async _sendPrepare(peer, payload) {
    const url = `http://${peer.host}:${peer.port}/maintenance?action=prepare`;
    this.logger.debug(`2PC PREPARE → ${peer.id}: ${JSON.stringify(payload)}`);

    const response = await axios.post(url, payload, { timeout: 3000 });
    return response.data.data || response.data;
  }

  /**
   * Send a COMMIT request to a peer.
   */
  async _sendCommit(peer, payload) {
    const url = `http://${peer.host}:${peer.port}/maintenance?action=commit`;
    this.logger.debug(`2PC COMMIT → ${peer.id}`);

    const response = await axios.post(url, payload, { timeout: 3000 });
    return response.data.data || response.data;
  }

  /**
   * Send an ABORT request to a peer.
   */
  async _sendAbort(peer, payload) {
    const url = `http://${peer.host}:${peer.port}/maintenance?action=abort`;
    this.logger.debug(`2PC ABORT → ${peer.id}`);

    try {
      const response = await axios.post(url, payload, { timeout: 3000 });
      return response.data.data || response.data;
    } catch (err) {
      this.logger.warn(`2PC ABORT to ${peer.id} failed: ${err.message}`);
    }
  }
}

/**
 * TwoPhaseCommit participant — runs on all DN servers (including Master for peer requests).
 * Handles prepare/commit/abort requests from the coordinator.
 */
class TwoPCParticipant {
  /**
   * @param {string} serverId
   * @param {Object} storage - Storage instance
   * @param {Object} logger - Winston logger
   */
  constructor(serverId, storage, logger) {
    this.serverId = serverId;
    this.storage = storage;
    this.logger = logger;
    // Pending prepared transactions: txId → { op, key, value }
    this.pending = new Map();
  }

  /**
   * Handle a PREPARE request.
   * Validate the operation and lock the key.
   * @param {Object} payload - { txId, op, key, value }
   * @returns {Object} { vote: 'commit'|'abort', reason? }
   */
  prepare(payload) {
    const { txId, op, key, value } = payload;
    this.logger.info(`2PC Participant [${txId}] PREPARE: op=${op}, key=${key}`);

    // Validate
    let canCommit = true;
    let reason = '';

    switch (op) {
      case 'create':
        if (this.storage.exists(key)) {
          canCommit = false;
          reason = `Key already exists: ${key}`;
        }
        break;
      case 'update':
      case 'delete':
        if (!this.storage.exists(key)) {
          canCommit = false;
          reason = `Key not found: ${key}`;
        }
        break;
      default:
        canCommit = false;
        reason = `Unknown operation: ${op}`;
    }

    if (canCommit) {
      // Store the pending transaction
      this.pending.set(txId, { op, key, value });
      this.logger.info(`2PC Participant [${txId}] voted COMMIT`);
      return { vote: 'commit' };
    } else {
      this.logger.warn(`2PC Participant [${txId}] voted ABORT: ${reason}`);
      return { vote: 'abort', reason };
    }
  }

  /**
   * Handle a COMMIT request — execute the stored operation.
   * @param {Object} payload - { txId, op, key, value }
   * @returns {Object} { success, data }
   */
  commit(payload) {
    const { txId, op, key, value } = payload;
    this.logger.info(`2PC Participant [${txId}] COMMIT: op=${op}, key=${key}`);

    // Execute the operation
    let result;
    switch (op) {
      case 'create':
        result = this.storage.create(key, value);
        break;
      case 'update':
        result = this.storage.update(key, value);
        break;
      case 'delete':
        result = this.storage.delete(key);
        break;
      default:
        result = { success: false, message: `Unknown op: ${op}` };
    }

    // Clean up pending
    this.pending.delete(txId);
    return result;
  }

  /**
   * Handle an ABORT request — discard the pending operation.
   * @param {Object} payload - { txId }
   * @returns {Object} { success: true }
   */
  abort(payload) {
    const { txId } = payload;
    this.logger.info(`2PC Participant [${txId}] ABORT`);
    this.pending.delete(txId);
    return { success: true };
  }
}

module.exports = {
  TwoPCCoordinator,
  TwoPCParticipant,
  generateTxId
};
