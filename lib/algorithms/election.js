var async = require('async');
var ZK = require('zookeeper').ZooKeeper;

var constants = require('../constants');
var zkUtil = require('../util');



/**
 * @constructor
 * encapsulate the Election algorithm.
 * @param {ZkClient} client client doing the locking.
 * @param {String} node name of lock.
 * @param {Function} callback gets executed when the lock is acquired or reaches an error. expects (error).
 */
function ElectionAlgorithm(client, node, callback) {
  this.client = client;
  this.node = node;
  this.callback = callback;
  this.watchPath = {};
  this.isMaster = false;
}


/** Generate a root node path, ie: /elections.
 * @return {String} Root Node Path.
 */
ElectionAlgorithm.prototype._rootNodePath = function() {
  return '/' + this.node;
};


/** Generate a child node path.
 * @return {String} a Child Node Path.
 */
ElectionAlgorithm.prototype._childNodePath = function() {
  return this._rootNodePath() + '/' + constants.ELECTION_PREFIX;
};


/** Create a proposal for an election.
 * @param {Function} callback completion callback.
 */
ElectionAlgorithm.prototype.createProposal = function(callback) {
  var self = this;

  async.waterfall([
    function checkForRoot(callback) {
      self.client._exists(self._rootNodePath(), false, function(err, exists) {
        if (err || exists) {
          callback(err);
          return;
        }
        self.client.create(self._rootNodePath(), 'An election root path', 0, function(err, path) {
          if (err) {
            if (err.rc === ZK.ZNODEEXISTS) {
              callback();
            } else {
              callback(err);
            }
          } else {
            callback();
          }
        });
      });
    },

    function createEphemeralNode(callback) {
      self.client.create(self._childNodePath(), Date.now(), ZK.ZOO_EPHEMERAL | ZK.ZOO_SEQUENCE, function(err, path) {
        if (err) {
          callback(err);
          return;
        }
        callback(null, path);
      });
    }
  ], callback);
};

/*
 * Each client participating in this process has to:
 * 1. Create an ephemeral-sequential node to participate under the election path
 * 2. Find its leader and follow (watch) it
 * 3. Upon leader removal go to election and find a new leader, or become the leader if no leader is to be found
 * 4. Upon session expiration check the election state and go to election if needed
 *
 */


/** follow the node right before me.
 * @param {String} ephemeralNodePath the nodePath of the current process.
 */
ElectionAlgorithm.prototype.followLeader = function(ephemeralNodePath) {
  var self = this,
      ephemeralNode = self.client._pathToNode(ephemeralNodePath);

  self.client._getChildren(self._rootNodePath(), false, constants.ELECTION_PREFIX, function(err, children) {
    var nodeBeforeMe;

    if (err) {
      self.callback(err);
      return;
    }

    nodeBeforeMe = self.client._pathBeforeMe(children, ephemeralNode);

    if (!nodeBeforeMe) {
      // I am _not_ following a leader, so I will be master.
      self.isMaster = true;
      self.callback(null, { master: self.isMaster });
    } else {
      self.isMaster = false;
      self.callback(null, { master: self.isMaster });
      self.client._watch(self._rootNodePath() + '/' + nodeBeforeMe, function(err) {
        if (err) {
          self.callback(err);
          return;
        }
        self.followLeader(ephemeralNodePath);
      });
    }
  });
};


/** Start the election
 */
ElectionAlgorithm.prototype.perform = function() {
  var self = this;
  self.createProposal(function(err, ephemeralNode) {
    if (err) {
      self.callback(err);
      return;
    }
    self.followLeader(ephemeralNode);
  });
};


/** ElectionAlgorithm */
exports.ElectionAlgorithm = ElectionAlgorithm;
