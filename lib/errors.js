var util = require('util');

var ZK = require('zookeeper').ZooKeeper;

/**
 * Zookeeper error.
 * @constructor
 *
 * @param {String} rc A return code.
 * @param {String} error The error message.
 */
function ZookeeperError(rc, error) {
  Error.call(this, error);
  Error.captureStackTrace(this, this.constructor);
  this.rc = rc;
  this.message = error;
}

util.inherits(ZookeeperError, Error);

/** Convert a zookeeper return code to an ELE return object.
 * @param {Number} rc ZooKeeper error.
 * @param {?String} error ZooKeeper string representation.
 * @return {Object} Ele error object.
 */
exports.zkToEleErrors = function(rc, error) {
  switch (rc) {
    case ZK.ZOPERATIONTIMEOUT:
      return new ZookeeperError(rc, error);
    case ZK.ZAPIERROR:
      return new ZookeeperError(rc, error);
    default:
      return new ZookeeperError(rc, error);
  }
};

exports.ZookeeperError = ZookeeperError;
