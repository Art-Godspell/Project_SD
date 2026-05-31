/**
 * response.js — Standardized response formatter for falconDB
 * 
 * All server responses must strictly be: { "data": <payload>, "error": <0 | errorObj> }
 * Success: "data" holds the payload, "error" is 0.
 * Error:   "data" is 0, "error" is { code, errno, message }.
 */

'use strict';

const { makeError } = require('./errors');

/**
 * Send a success response.
 * @param {Object} res - Express response object
 * @param {*} data - The payload to return
 * @param {number} [statusCode=200] - HTTP status code
 */
function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    data: data,
    error: 0
  });
}

/**
 * Send an error response using a predefined error code.
 * @param {Object} res - Express response object
 * @param {string} errorCode - Error code key, e.g. 'eRPRT001E'
 * @param {string} [customMessage] - Optional override message
 */
function sendError(res, errorCode, customMessage) {
  const err = makeError(errorCode, customMessage);
  return res.status(err.errno || 500).json({
    data: 0,
    error: err
  });
}

/**
 * Send an error response from a raw error object.
 * @param {Object} res - Express response object
 * @param {Object} errorObj - { code, errno, message }
 */
function sendErrorRaw(res, errorObj) {
  return res.status(errorObj.errno || 500).json({
    data: 0,
    error: errorObj
  });
}

module.exports = {
  sendSuccess,
  sendError,
  sendErrorRaw
};
