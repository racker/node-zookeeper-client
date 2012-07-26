var ZK = require('zookeeper').ZooKeeper;
var async = require('async');
var log = require('logmagic').local('zookeeper-client.util');

var constants = require('./constants');
var zclient = require('./client');

var zkClients = {};


/** determines is the integers wrapped in two lock names are less-than or equal to one another.
  * input e.g.: '-lock0000001234'.
  * @param {String} a first string.
  * @param {String} b second string.
  * @return {Bool} is a <= b.
  */
exports.lte = function(a, b) {
  return parseInt(a.substr(constants.LOCK_PREFIX.length), 10) <= parseInt(b.substr(constants.LOCK_PREFIX.length), 10);
};


/** grabs the last portion of a slash-delimited path.
 * @param {String} path The path.
 * @return {String} the last portion of a path.
 */
exports.last = function(path) {
  var parts = path.split('/');
  return parts[parts.length - 1];
};


/**
 * Wrap a callback and make sure the lock gets unlocked before the original
 * callback is called.
 *
 * @param {DbOperationContext} ctx The context for this operation.
 * @param {Object} client ZooKepeer client.
 * @param {String} lockName Lock name.
 * @param {Function} callback Callback to wrap.
 * @return {Function} Wrapped callback.
 */
exports.wrapCallbackWithUnlock = function(ctx, client, lockName, callback) {
  return function wrappedCallback() {
    var args = arguments;

    if (!client.locks.hasOwnProperty(lockName)) {
      log.info('Lock not acquired, skipping unlock...', {'ctx': ctx, 'lockName': lockName});
      callback.apply(null, args);
      return;
    }

    log.info('Unlocking lock...', {'ctx': ctx, 'lockName': lockName});
    client.unlock(lockName, function(err) {
      if (err) {
        log.error('Failed to unlock a lock', {'ctx': ctx, 'err': err, 'lockName': lockName});
      }
      else {
        log.info('Lock unlocked', {'ctx': ctx, 'lockName': lockName});
      }

      callback.apply(null, args);
    });
  };
};


/**
 * Get a Zookeeper client.
 * @param {Array} urls A list of URLs.
 * @return {ZkClient} A Zookeeper Client.
 */
exports.getClient = function getClient(urls) {
  var joined = urls.join(',');

  if (!zkClients[joined]) {
    zkClients[joined] = new zclient.ZkClient(urls, {'reconnect': true});
    zkClients[joined].connect();
  }

  return zkClients[joined];
};


/**
 * Shutdown any connected Zookeeper clients.
 *
 * @param {Function} callback Callback called when all the clients have been
 * shut down.
 */
exports.shutdown = function shutdown(callback) {
  var key;

  callback = callback || function() {};

  async.forEach(Object.keys(zkClients), function(key, callback) {
    var client = zkClients[key];
    client.close(callback);
  }, callback);
};
