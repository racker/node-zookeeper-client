var events = require('events');
var util = require('util');

var async = require('async');
var ZK = require('zookeeper').ZooKeeper;
var merge = require('rackspace-shared-utils/lib/misc').merge;
var instruments = require('rackspace-shared-utils/lib/instruments');

var constants = require('./constants');

var zkLock = require('./algorithms/lock');
var zkElection = require('./algorithms/election');
var zerr = require('./errors');


var DEFAULT_OPTIONS = {
  timeout: constants.DEFAULT_TIMEOUT,
  deathTimeout: constants.DEFAULT_TIMEOUT,
  log: require('logmagic').local('zookeeper-client.client')
};



/**
 * @constructor
 * @param {Array} urls list of ZK (host:port) urls.
 * @param {Hash} options optional options. see DEFAULT_OPTIONS for a list of possible options.
 */
function ZkClient(urls, options) {
  this.options = merge(DEFAULT_OPTIONS, options || {});
  this.log = this.options.log;
  this.urls = urls.join(',');
  this.zk = null;
  this.isConnected = false;   // Are we currently connected?
  this.isDead = false;          // Have we been disconnected long enough we consider ourself dead?
  this.sessionId = -1;
  this.locks = {};
  this.waitCallbacks = {};
  this.master = false;
  this._timerId = null;
  this._pending = [];
  this._reallyClosed = false;
  this._resetting = false;
  this._reconnect = this.options.reconnect;
}

util.inherits(ZkClient, events.EventEmitter);


/**
 * Mark the ZK client dead and notify any pending calls.
 */
ZkClient.prototype._markDead = function() {
  var pending = this._pending;

  if (!this._resetting) {
    this._pending = [];
    this.options.log.warn('zk marked dead.');
    this.isDead = true;

    pending.forEach(function(fn) {
      fn(new Error('zk client is dead'));
    });

    this.close();
    if (this._reconnect) {
      this.options.log.debug('zk died, session closed, reinitializing.');
      this.connect();
    }
  }
};


/**
 * Mark the ZK client as live and notify any pending calls.
 */
ZkClient.prototype._markLive = function() {
  clearTimeout(this._timerId);
  var pending = this._pending;
  this._pending = [];
  this.options.log.info('zk marked live.');
  this.isDead = false;

  pending.forEach(function(fn) {
    fn();
  });
};


/**
 * Start the "death timer".
 */
ZkClient.prototype._startTimer = function() {
  this.log.debug('zk death timer started.');
  this._timerId = setTimeout(this._markDead.bind(this), this.options.deathTimeout);
};


/**
 * Wait for the zk client to be connected or marked dead.
 * @param {Function} callback A callback fired with (err).
 */
ZkClient.prototype.whenConnected = function(callback) {
  if (this.isConnected) {
    callback();
  } else if (this.isDead) {
    this.log.warn('client attempted to use dead zk client');
    callback(new Error('zk client is dead.'));
  } else {
    this.log.trace('zk call queued pending connection.');
    this._pending.push(callback);
  }
};


/**
 * connects to zookeeper.
 * @param {Function} callback expects (error, sessionId).
 */
ZkClient.prototype.connect = function(callback) {
  var self = this;
  callback = callback || function() {};

  // already connected/connecting
  if (this.zk) {
    if (this.zk.isConnected) {
      callback(null, self.sessionId);
    } else {
      this.whenConnected(function() {
        callback(null, self.sessionId);
      });
    }
  } else {
    self.options.log.debug('zk connecting', {urls: this.urls});

    this.zk = new ZK();

    this.zk.on(ZK.on_yield, function() {
      self.options.log.debug('zk yield.');
    });

    // handle the connection
    this.zk.on(ZK.on_connected, function(zk_client) {
      self.isConnected = true;
      self.sessionId = zk_client.client_id;
      self.options.log.debug('zk connected, session opened.', {clientId: zk_client.client_id});
      self._markLive();
      self.emit('connected');
      callback(null, self.sessionId);
      callback = function() {};
    });

    this.zk.on(ZK.on_connecting, function(zk_client) {
      self._startTimer();
      self.isConnected = false;
      self.sessionId = -1;
      self.options.log.debug('zk reconnecting.');
    });

    this.zk.on(ZK.on_closed, function(zk_client) {
      // todo: not sure what do do here.
      self.isConnected = false;
      clearTimeout(self._timerId);

      // Note: It is possible (and common, given identical timeout values), for
      // this callback to be fired in the same tick as the death timer
      // callback. This has the unexpected side effect of making clearTimeout()
      // not actually cancel the callback. So we set _resetting for the
      // duration of this tick in order to avoid weird race conditions.
      self._resetting = true;
      process.nextTick(function() {
        self._resetting = false;
      });

      if (!self._reallyClosed) {
        self.options.log.debug('zk closed, session closed, reinitializing.', {clientId: zk_client.client_id});
        self.zk = null;
        self.connect();
      }
    });

    this.zk.on(ZK.on_event_created, function(zk_client) {
      self.options.log.trace('ON_EVENT_CREATED');
    });

    this.zk.on(ZK.on_event_deleted, function(client, lockPath) {
      self.options.log.trace('ON_EVENT_DELETED');
      if (self.waitCallbacks[lockPath]) {
        self.options.log.trace('Executing watch callback');
        var fn = self.waitCallbacks[lockPath];
        delete self.waitCallbacks[lockPath];
        fn();
      }
    });

    this.zk.on(ZK.on_event_changed, function(zk_client) {
      self.options.log.trace('ON_EVENT_CHANGED');
    });

    this.zk.on(ZK.on_event_child, function(zk_client) {
      self.options.log.trace('ON_EVENT_CHILD');
    });

    this.zk.on(ZK.on_event_notwatching, function(zk_client) {
      self.options.log.trace('ON_EVENT_NOTWATCHING');
    });

    // everything is set up. try to connect.
    this.zk.init({
      connect: self.urls,
      timeout: self.options.timeout,
      debug_level: ZK.ZOO_LOG_LEVEL_WARN,
      host_order_deterministic: false
    });

    self._startTimer();
  }
};


/**
 * close connection to zookeeper.
 * @param {Function} callback expects no parameters.
 */
ZkClient.prototype.close = function(callback) {
  callback = callback || function() {};
  if (this.zk) {
    this._reallyClosed = true;
    this.zk.close();
    this.zk = null;
    this.isConnected = false;
    this.sessionId = -1;
    this.locks = {};
    this._markDead();
  }
  clearTimeout(this._timerId);
  callback();
};


/** Return the node name, ie: /elections/el_1234, returns el_1234.
 * @param {String} path The Path.
 * @return {String} node name.
 */
ZkClient.prototype._pathToNode = function(path) {
  var index = path.lastIndexOf('/');
  if (index === -1) {
    return null;
  }
  return path.substr(index + 1);
};


/**
 * given a sorted list of child paths, finds the one that precedes myPath.
 * @param {Array} children list of children nodes.
 * @param {String} myPath path to compare against.
 * @return {String} valid child path (doesn't contain parent) or null if none exists.
 */
ZkClient.prototype._pathBeforeMe = function(children, myPath) {
  var i;

  for (i = 0; i < children.length - 1; i++) {
    if (children[i + 1] === myPath) {
      return children[i];
    }
  }
  return null;
};


/**
 * Create a ZK node
 * @param {String} path The Path.
 * @param {String} value The Value.
 * @param {Number} flags Bitmask of flags.
 * @param {Function} callback Completion callback.
 */
ZkClient.prototype.create = function(path, value, flags, callback) {
  var self = this, err;

  if (path.indexOf('/') !== 0) {
    throw new Error('Path must start with a slash!');
  }

  self.log.trace('zk create issued.', { path: path, value: value, flags: flags });
  self.zk.a_create(path, value, flags, function(rc, error, stat) {
    if (rc !== ZK.ZOK && rc !== ZK.ZNODEEXISTS) {
      err = zerr.zkToEleErrors(rc, error);
      self.log.debug('zk create error.', { error: err });
      callback(err);
    }
    if (rc === ZK.ZNODEEXISTS) {
      // There is a possible condition between when we check for node existence
      // and when we try to create it.
      // In case the node already exists, we just want to continue.
      // Note: This condition can only occur if we aren't using SEQUENCE flag.
      self.log.trace('zk create node already exists.', { stat: stat });
      callback(null, path);
    } else {
      self.log.trace('zk create success.', { stat: stat });
      callback(null, stat);
    }
  });
};


/**
 * Create a ZK node hierarchy.
 *
 * @param {String} path The Path to create - e.g. /foo/bar/ponies.
 * @param {String} value The Value.
 * @param {Number} flags Bitmask of flags.
 * @param {Function} callback Callback called with (err, createdPath).
 */
ZkClient.prototype.createPaths = function(path, value, flags, callback) {
  var self = this, pathsToCreate = path, components = [];

  if (path.indexOf('/') === 0) {
    pathsToCreate = path.substring(1);
  }

  pathsToCreate = pathsToCreate.split('/');

  this.log.trace('zk createPaths issued.', {path: path, value: value, flags: flags});
  async.forEachSeries(pathsToCreate, function(path, callback) {
    var pathToCreate;

    components.push(path);
    pathToCreate = '/' + components.join('/');

    self.log.trace('zk createPaths, creating node.', {path: pathToCreate});
    self.create(pathToCreate, value, flags, function(err, stat) {
      if (err) {
        self.log.error('zk createPaths: node error.', {error: err, path: pathToCreate});
        callback(err);
        return;
      }

      self.log.trace('zk createPaths: node created.', {stat: stat, path: pathToCreate});
      callback(null);
    });
  },

  function(err) {
    if (!err) {
      self.log.trace('zk createPaths: success.', {path: path});
    }

    callback(err, path);
  });
};


/** Get sorted children
 * @param {String} path The Path.
 * @param {Boolean} watch Place a watch on this path.
 * @param {String} prefix The node prefix (used for sorting).
 * @param {Function} callback Completion Callback.
 */
ZkClient.prototype._getChildren = function(path, watch, prefix, callback) {
  var self = this;

  self.log.trace('getChildren', {path: path, watch: watch, prefix: prefix});
  self.zk.a_get_children(path, watch, function(rc, error, children) {
    if (rc !== ZK.ZOK) {
      callback(zerr.zkToEleErrors(rc, error));
      return;
    }

    children.sort(function(a, b) {
      return parseInt(a.substr(prefix.length), 10) - parseInt(b.substr(prefix.length), 10);
    });

    self.log.trace('getChildren results', {path: path, children: children});

    callback(null, children);
  });
};


/**
 * Get data from a node.
 * @param {String} path The Path.
 * @param {Boolean} watch Place a watch on this path.
 * @param {Function} callback Completion Callback.
 */
ZkClient.prototype._get = function(path, watch, callback) {
  this.log.trace('get', {path: path});
  this.zk.a_get(path, false, function(rc, error, stat, data) {
    if (rc !== ZK.ZOK) {
      callback(zerr.zkToEleErrors(rc, error));
    } else {
      // data is always going to be JSON for this client.
      callback(null, data);
    }
  });
};


/** Watch a path
 * @param {String} path The Path.
 * @param {Function} callback Completion Callback.
 */
ZkClient.prototype._watch = function(path, callback) {
  var self = this;
  self.log.trace('watch', {path: path});
  self._exists(path, true, function(err, exists) {
    if (err) {
      callback(err);
      return;
    }
    self.waitCallbacks[path] = function() {
      callback();
    };
  });
};


/** Does a path exist?
 * @param {String} path The path.
 * @param {Boolean} watch Add a watch for this path.
 * @param {Function} callback Completion callback.
 */
ZkClient.prototype._exists = function(path, watch, callback) {
  this.log.trace('exists', {path: path, watch: watch});
  this.zk.a_exists(path, watch, function(rc, error, stat) {
    if (rc === ZK.ZNONODE) {
      callback(null, false);
    } else if (rc === ZK.ZOK) {
      callback(null, true);
    } else {
      callback(zerr.zkToEleErrors(rc, error), null);
    }
  });
};


/**
 * unlocks a particular [locked] node.
 * @param {String} node name of the lock to release.
 * @param {Function} callback invoked when unlocked. parameters are (error).
 */
ZkClient.prototype.unlock = function(node, callback) {
  var self = this;

  self.whenConnected(function(err) {
    if (err) {
      callback(err);
    } else if (!self.locks[node]) {
      callback(new Error('Lock for ' + node + ' not acquired.'));
    } else {
      self.options.log.trace1('deleting', {lockId: self.locks[node]});
      // todo: not sure what version should be.
      self.zk.a_delete_(self.locks[node], 0, function(rc, error) {
        if (rc !== ZK.ZOK) {
          callback(zerr.zkToEleErrors(rc, error));
        } else {
          delete self.locks[node];
          callback(null);
        }
      });
    }
  });
};


/**
 * Returns back a function that wraps the original callback.
 * @param {Work} work object that needs to be stopped.
 * @param {Function} callback invoked in lock acquistion.
 * @return {Function} wrapper function that encompasses original callback.
 */
function wrapWorkAndCallback(work, callback) {
  return function(err) {
    work.stop(err);
    callback.apply(this, arguments);
  };
}


/**
 * This method will probably get pushed down and replaced with specific methods (lockCheck, lockEntity, etc.) when
 * we know what we want to lock.
 * @param {String} node name of lock.
 * @param {String} txnId transaction identifier.
 * @param {Function} callback invoked on lock acquisition. parameters are (error).
 */
ZkClient.prototype.acquireLock = function(node, txnId, callback) {
  var self = this,
      algo,
      nodePath = node,
      work = new instruments.Work('zookeeper_acquire_lock_event');

  work.start();
  callback = wrapWorkAndCallback(work, callback);
  algo = new zkLock.LockAlgorithm(this, node, callback);

  if (nodePath.charAt(0) !== '/') {
    nodePath = '/' + nodePath;
  }

  self.whenConnected(function(err) {
    if (err) {
      callback(err);
    } else {
      if (self.locks[node]) {
        self.options.log.debug('This client already holds lock for this node', {'node': node});
      }

      // starts the lock process off (ensuring a parent, create the lock node), and then enters the lock algorithm.
      algo.ensureNode(nodePath, function(err, parentPath) {
        if (err) {
          callback(err, null);
        } else {
          algo.createChild(parentPath + '/' + constants.LOCK_PREFIX, txnId, function(err, childPath) {
            if (err) {
              callback(err, null);
            } else {
              algo.lockAlgorithm(parentPath, childPath);
            }
          });
        }
      });
    }
  });
};


//
// Elections
//


/** Volunteer for an election
 * @param {String} node Shared node for an election.
 * @param {Function} callback A callback for an election change.
 */
ZkClient.prototype.volunteer = function(node, callback) {
  var self = this,
      algo;

  if (!this.isConnected) {
    callback(new Error('Not connected'));
    return;
  }

  algo = new zkElection.ElectionAlgorithm(this, node, function(err, stats) {
    if (err) {
      callback(err);
      return;
    }
    self.master = stats.master;
    callback(null, stats);
  });
  algo.perform();
};



/**
 * @constructor Releases old locks.
 * @param {Array} urls list of ZK host:port urls.
 * @param {Hash} options optional options. see DEFAULT_OPTIONS for a list of possible options.
 */
function ZkPick(urls, options) {
  this.options = merge(DEFAULT_OPTIONS, options || {});
  this.urls = urls.join(',');
}


/**
 * Forcefully release a lock.
 * @param {long} age maximum age of locks to allow.
 * @param {String} name name of lock to examine .
 * @param {Function} callback invoked when release is complate.
 */
ZkPick.prototype.release = function(age, name, callback) {
  var self = this,
      zk = new ZK(),
      cbWrapper = function(fn) {
        zk.close();
        fn();
      };

  // set up the event handler that runs the release on connect.
  zk.on(ZK.on_connected, function(zk_client) {
    self.options.log.trace('ZkPick connected');
    // get children on name.
    // this.client.zk.a_get_children(path, false, function(rc, error, children) {
    zk.a_get_children('/' + name, false, function(rc, error, children) {
      if (rc !== ZK.ZOK) {
        cbWrapper(function() {
          callback(new Error(error));
        });
      } else {
        // for each child, do a get.
        var now = Date.now(),
            reapCount = 0,
            childCount = 0,
            reapCb = function(reaped) {
              childCount += 1;
              if (reaped) {
                self.options.log.trace1('Incrementing reapCount', {current: reapCount});
                reapCount += 1;
              }
              if (childCount >= children.length) {
                cbWrapper(function() {
                  callback(null, reapCount);
                });
              }
            };

        children.forEach(function(child) {
          var lockPath = '/' + name + '/' + child;
          zk.a_get(lockPath, false, function(rc, error, stat, data) {
            if (rc !== ZK.ZOK) {
              self.options.log.warn('error retrieving path', {err: error});
              reapCb(false);
            } else {
              // data is a json encoded list of [txnId, timestamp]. we want to compare against the timestamp.
              var lockCreated = JSON.parse(data)[1];
              if (now - lockCreated >= age) {
                self.options.log.debug('Reaping lock', {lockPath: lockPath});
                zk.a_delete_(lockPath, stat.version, function(rc, error) {
                  if (rc !== ZK.ZOK) {
                    self.options.log.warn('error deleting path', {err: error});
                    reapCb(false);
                  } else {
                    reapCb(true);
                  }
                });
              } else {
                reapCb(false);
              }
            }
          });
        });
      }
    });
  }); // end of the on(ZK.on_connected

  // now do the connect.
  zk.init({
    connect: self.urls,
    timeout: constants.ZOOKEEPER_TIMEOUT,
    debug_level: ZK.ZOO_LOG_LEVEL_ERROR,
    host_order_deterministic: false
  });
};


/** Zookeeper client constructor */
exports.ZkClient = ZkClient;


/** Zookeeper lock reaper */
exports.ZkPick = ZkPick;
