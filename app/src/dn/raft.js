/**
 * raft.js — Raft leader election for falconDB Data Nodes
 * 
 * Simplified Raft with 3 states: Follower → Candidate → Leader.
 * Each DN group has 3 servers, majority = 2.
 * 
 * On startup all DNs are Followers with a random election timeout (150–300ms).
 * If a Follower doesn't receive a heartbeat in time, it becomes a Candidate,
 * increments its term, votes for itself, and requests votes from peers.
 * A Candidate that receives majority votes becomes Leader and notifies the RP.
 * 
 * All phases are logged at trace level to the per-server raft.log.
 */

'use strict';

const axios = require('axios');
const config = require('../shared/config');

// Raft states
const STATE = {
  FOLLOWER: 'follower',
  CANDIDATE: 'candidate',
  LEADER: 'leader'
};

class RaftNode {
  /**
   * @param {string} serverId - This server's ID (e.g. "dn1a")
   * @param {Object} raftLogger - Winston raft logger
   * @param {Object} systemLogger - Winston system logger
   */
  constructor(serverId, raftLogger, systemLogger) {
    this.serverId = serverId;
    this.raftLogger = raftLogger;
    this.systemLogger = systemLogger;

    // Raft state
    this.state = STATE.FOLLOWER;
    this.currentTerm = 0;
    this.votedFor = null;          // Who we voted for in current term
    this.leaderId = null;          // Who is the current leader

    // Timing (ms)
    this.electionTimeoutMin = 150;
    this.electionTimeoutMax = 300;
    this.heartbeatInterval = 75;   // Leader sends heartbeats at half the min timeout

    // Timers
    this._electionTimer = null;
    this._heartbeatTimer = null;

    // Server config
    this.self = config.getServerById(serverId);
    this.peers = config.getPeers(serverId);
    this.group = config.getGroupByServerId(serverId);

    this.raftLogger.trace(`RaftNode initialized: ${serverId}, peers: [${this.peers.map(p => p.id).join(', ')}]`);
  }

  /**
   * Start the Raft election process.
   */
  start() {
    this.raftLogger.trace(`${this.serverId} starting as FOLLOWER in term ${this.currentTerm}`);
    this.state = STATE.FOLLOWER;
    this._resetElectionTimer();
  }

  /**
   * Stop all timers (for graceful shutdown).
   */
  stop() {
    this.raftLogger.trace(`${this.serverId} stopping Raft`);
    clearTimeout(this._electionTimer);
    clearInterval(this._heartbeatTimer);
  }

  /**
   * Generate a random election timeout.
   * @returns {number} Timeout in ms
   */
  _randomElectionTimeout() {
    return Math.floor(
      Math.random() * (this.electionTimeoutMax - this.electionTimeoutMin) + this.electionTimeoutMin
    );
  }

  /**
   * Reset the election timer. If it fires, this node starts an election.
   */
  _resetElectionTimer() {
    clearTimeout(this._electionTimer);
    const timeout = this._randomElectionTimeout();
    this.raftLogger.trace(`${this.serverId} election timer set: ${timeout}ms`);

    this._electionTimer = setTimeout(() => {
      this._startElection();
    }, timeout);
  }

  /**
   * Start an election: become Candidate, increment term, vote for self, request votes.
   */
  async _startElection() {
    this.state = STATE.CANDIDATE;
    this.currentTerm++;
    this.votedFor = this.serverId;
    this.leaderId = null;

    this.raftLogger.trace(
      `${this.serverId} starting election for term ${this.currentTerm} [eDNRF001I]`
    );

    let votesReceived = 1; // vote for self
    const majority = Math.floor(this.peers.length / 2) + 1; // With 2 peers + self = 3 total, majority = 2

    this.raftLogger.trace(
      `${this.serverId} voted for self, need ${majority} votes total (have ${votesReceived})`
    );

    // Request votes from all peers in parallel
    const votePromises = this.peers.map(peer => this._requestVote(peer));
    const results = await Promise.allSettled(votePromises);

    // Count granted votes
    for (const result of results) {
      if (this.state !== STATE.CANDIDATE) {
        // We may have stepped down if we received a higher term
        this.raftLogger.trace(`${this.serverId} no longer candidate, aborting election`);
        return;
      }

      if (result.status === 'fulfilled' && result.value && result.value.voteGranted) {
        votesReceived++;
        this.raftLogger.trace(
          `${this.serverId} received vote from ${result.value.from}, total: ${votesReceived}/${majority} [eDNRF002I]`
        );
      }
    }

    // Check if we won
    if (this.state === STATE.CANDIDATE && votesReceived >= majority) {
      this._becomeLeader();
    } else if (this.state === STATE.CANDIDATE) {
      // Election failed, restart as follower
      this.raftLogger.trace(
        `${this.serverId} election failed for term ${this.currentTerm} (got ${votesReceived}/${majority}) [eDNRF004E]`
      );
      this.state = STATE.FOLLOWER;
      this._resetElectionTimer();
    }
  }

  /**
   * Request a vote from a peer server.
   * @param {Object} peer - { id, host, port }
   * @returns {Object|null} { voteGranted, from, term }
   */
  async _requestVote(peer) {
    const url = `http://${peer.host}:${peer.port}/election`;
    this.raftLogger.trace(
      `${this.serverId} requesting vote from ${peer.id} for term ${this.currentTerm}`
    );

    try {
      const response = await axios.get(url, {
        params: {
          action: 'request_vote',
          candidateId: this.serverId,
          term: this.currentTerm
        },
        timeout: 200
      });

      const data = response.data.data || response.data;
      this.raftLogger.trace(
        `${this.serverId} vote response from ${peer.id}: granted=${data.voteGranted}, term=${data.term}`
      );

      // If the peer has a higher term, step down
      if (data.term > this.currentTerm) {
        this.raftLogger.trace(
          `${this.serverId} discovered higher term ${data.term} from ${peer.id}, stepping down`
        );
        this.currentTerm = data.term;
        this.state = STATE.FOLLOWER;
        this.votedFor = null;
      }

      return { voteGranted: data.voteGranted, from: peer.id, term: data.term };
    } catch (err) {
      this.raftLogger.trace(
        `${this.serverId} vote request to ${peer.id} failed: ${err.message}`
      );
      return { voteGranted: false, from: peer.id, term: this.currentTerm };
    }
  }

  /**
   * Handle an incoming vote request from a candidate.
   * @param {string} candidateId
   * @param {number} candidateTerm
   * @returns {Object} { voteGranted, term }
   */
  handleVoteRequest(candidateId, candidateTerm) {
    const term = parseInt(candidateTerm, 10);

    this.raftLogger.trace(
      `${this.serverId} received vote request from ${candidateId} for term ${term} (my term: ${this.currentTerm})`
    );

    // If candidate's term is higher, update our term and revert to follower
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.state = STATE.FOLLOWER;
      this.votedFor = null;
      this.leaderId = null;
      this._resetElectionTimer();
    }

    // Grant vote if: candidate's term >= ours AND we haven't voted yet (or voted for this candidate)
    let voteGranted = false;
    if (term >= this.currentTerm && (this.votedFor === null || this.votedFor === candidateId)) {
      voteGranted = true;
      this.votedFor = candidateId;
      this._resetElectionTimer(); // Reset timer since we got a valid request
      this.raftLogger.trace(
        `${this.serverId} granted vote to ${candidateId} for term ${term} [eDNRF002I]`
      );
    } else {
      this.raftLogger.trace(
        `${this.serverId} denied vote to ${candidateId} for term ${term} (already voted for ${this.votedFor}) [eDNRF002I]`
      );
    }

    return { voteGranted, term: this.currentTerm };
  }

  /**
   * Become the leader: start heartbeats and notify the RP.
   */
  _becomeLeader() {
    this.state = STATE.LEADER;
    this.leaderId = this.serverId;

    this.raftLogger.trace(
      `${this.serverId} elected LEADER for term ${this.currentTerm} [eDNRF003I]`
    );
    this.systemLogger.info(
      `${this.serverId} is now the LEADER of group ${this.group.id} (term ${this.currentTerm})`
    );

    // Stop election timer, start heartbeats
    clearTimeout(this._electionTimer);
    this._startHeartbeat();

    // Notify RP of new master
    this._notifyRP();
  }

  /**
   * Start sending periodic heartbeats to peers.
   */
  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      this._sendHeartbeats();
    }, this.heartbeatInterval);
  }

  /**
   * Send heartbeat to all peers.
   */
  async _sendHeartbeats() {
    if (this.state !== STATE.LEADER) return;

    for (const peer of this.peers) {
      try {
        await axios.get(`http://${peer.host}:${peer.port}/election`, {
          params: {
            action: 'heartbeat',
            leaderId: this.serverId,
            term: this.currentTerm
          },
          timeout: 100
        });
      } catch (err) {
        this.raftLogger.trace(
          `${this.serverId} heartbeat to ${peer.id} failed: ${err.message}`
        );
      }
    }
  }

  /**
   * Handle an incoming heartbeat from a leader.
   * @param {string} leaderId
   * @param {number} leaderTerm
   * @returns {Object} { success, term }
   */
  handleHeartbeat(leaderId, leaderTerm) {
    const term = parseInt(leaderTerm, 10);

    if (term >= this.currentTerm) {
      // Accept this leader
      if (this.state !== STATE.FOLLOWER || this.leaderId !== leaderId) {
        this.raftLogger.trace(
          `${this.serverId} accepting ${leaderId} as leader for term ${term}`
        );
      }
      this.currentTerm = term;
      this.state = STATE.FOLLOWER;
      this.leaderId = leaderId;
      this._resetElectionTimer();
      return { success: true, term: this.currentTerm };
    }

    // Our term is higher — reject
    this.raftLogger.trace(
      `${this.serverId} rejecting heartbeat from ${leaderId} (their term ${term} < my term ${this.currentTerm})`
    );
    return { success: false, term: this.currentTerm };
  }

  /**
   * Notify the RP that this server is the new master.
   */
  async _notifyRP() {
    const rp = config.getRP();
    const url = `http://${rp.host}:${rp.port}/set_master`;

    this.raftLogger.trace(
      `${this.serverId} notifying RP of master identity: group=${this.group.id}, id=${this.serverId}`
    );

    try {
      await axios.get(url, {
        params: {
          group: this.group.id,
          id: this.serverId,
          host: this.self.host,
          port: this.self.port
        },
        timeout: 2000
      });

      this.raftLogger.trace(
        `${this.serverId} successfully notified RP of master status`
      );
    } catch (err) {
      this.raftLogger.trace(
        `${this.serverId} failed to notify RP: ${err.message} — will retry on next heartbeat cycle`
      );

      // Retry notification after a short delay
      setTimeout(() => {
        if (this.state === STATE.LEADER) {
          this._notifyRP();
        }
      }, 1000);
    }
  }

  /**
   * Check if this node is the leader.
   * @returns {boolean}
   */
  isLeader() {
    return this.state === STATE.LEADER;
  }

  /**
   * Get current Raft status for /stat endpoint.
   * @returns {Object}
   */
  getStatus() {
    return {
      serverId: this.serverId,
      state: this.state,
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      leaderId: this.leaderId,
      groupId: this.group ? this.group.id : null
    };
  }
}

module.exports = { RaftNode, STATE };
