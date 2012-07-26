var zkUtil = require('../util');
var zkConstants = require('../constants');
var ZK = require('zookeeper').ZooKeeper;



/**
 * @constructor
 * encapsulate the lock algorithm. I didn't want it exposed in the client.
 * @param {ZkClient} client client doing the locking.
 * @param {String} node name of lock.
 * @param {Function} callback gets executed when the lock is acquired or reaches an error. expects (error).
 */
function LockAlgorithm(client, node, callback) {
  this.client = client;
  this.node = node;
  this.callback = callback;
}


/**
 * given a sorted list of child paths, finds the one that precedes myPath.
 * @param {Array} children list of children nodes.
 * @param {String} myPath path to compare against.
 * @return {String} valid child path (doesn't contain parent) or null if none exists.
 */
LockAlgorithm.prototype.pathBeforeMe = function(children, myPath) {
  var i;

  for (i = 0; i < children.length - 1; i++) {
    if (children[i + 1] === myPath) {
      return children[i];
    }
  }
  return null;
};


/**
 * checks for the presence of path. it doesn't exist, it gets created.
 * @param {String} path node to ensure existence of.
 * @param {Function} callback expects (error, pathName).
 */
LockAlgorithm.prototype.ensureNode = function(path, callback) {
  var self = this;
  this.client.createPaths(path, 'lock node', 0, function(err, pathCreated) {
    if (err) {
      callback(err);
      return;
    }

    self.client.options.log.tracef('successful parent node creation: ${path}', {'path': pathCreated});
    // assert path === pathCreated
    callback(null, pathCreated);
  });
};


/**
 * creates an child node.
 * @param {String} path ephemeral child node (specified by path).
 * @param {String} txnId The transaction ID.
 * @param {Function} callback expects (error, pathName).
 */
LockAlgorithm.prototype.createChild = function(path, txnId, callback) {
  var self = this,
      lockValue = JSON.stringify([txnId, Date.now()]);

  self.client.create(path, lockValue, ZK.ZOO_SEQUENCE | ZK.ZOO_EPHEMERAL, function(err, pathCreated) {
    if (err) {
      self.client.options.log.error('node creation error', {err: err, pathCreated: pathCreated});
      callback(err);
      return;
    }
    // assert pathCreated === path.
    callback(null, pathCreated);
  });
};


/**
 * gets children of a particular node. errors if there are no children.
 * @param {String} path the parent of the children.
 * @param {Function} callback expects (error, sorted list of children). the children are not full paths, but names only.
 */
LockAlgorithm.prototype.getSortedChildren = function(path, callback) {
  // false because we don't want to watch.
  this.client._getChildren(path, false, '', function(err, children) {
    if (err) {
      callback(err);
      return;
    }
    if (children.length < 1) {
      // there should *always* be children since this method always gets called after the lock node is created.
      callback(new Error('Could not create lock node for ' + path), null);
      return;
    }
    children.sort(function(a, b) {
      // each child name is formatted like this: lock-00000000. so peel of chars before creating a number.
      return parseInt(a.substr(zkConstants.LOCK_PREFIX.length), 10) -
          parseInt(b.substr(zkConstants.LOCK_PREFIX.length), 10);
    });
    callback(null, children);
  });
};


/**
 * watches watchPath for deletion. parentPath is roughly equal to the name of the lock, lockPath is the child node
 * name for the lock that is to be acquired (e.g. '/this_lock/-lock000000121').
 * it is perfectly reasonable for this watch to execute without executing a callback (in the event we need to wait
 * for watchPath to be deleted).
 * @param {String} parentPath basically the name of the lock (which is the parent node).
 * @param {String} lockPath child lock that is basically a place in line.
 * @param {String} watchPath the child node that we are waiting on to go away. when that happens it is our turn (we
 * have the lock).
 * @param {Function} callback expects (error). only purposes is to catch and report problems.
 */
LockAlgorithm.prototype.watch = function(parentPath, lockPath, watchPath, callback) {
  var self = this;
  self.client.options.log.trace1('watching: ' + watchPath);
  self.client._exists(watchPath, true, function(err, exists) {
    self.client.options.log.trace('exists', {err: err, exists: exists});
    if (err) {
      callback(err);
      return;
    }

    if (!exists) {
      self.lockAlgorithm(parentPath, lockPath);
      return;
    }

    // wait for it to be deleted, then execute the callback.
    if (self.client.waitCallbacks[watchPath]) {
      callback(new Error('Already waiting on ' + watchPath));
      return;
    }

    // set a callback that gets invoked when watchPath is deleted.
    self.client.waitCallbacks[watchPath] = function() {
      self.client.options.log.trace('Invoked wait callback');
      self.lockAlgorithm(parentPath, lockPath);
    };
  });
};


/**
 * implements the lock algorithm.
 * @param {String} parentPath a decorated form of the lock name.
 * @param {String} lockPath a child of parentPath.
 */
LockAlgorithm.prototype.lockAlgorithm = function(parentPath, lockPath) {
  var self = this, absolutePath;
  self.getSortedChildren(parentPath, function(err, children) {
    if (err) {
      self.callback(err);
    } else {
      //log.trace1('PARENT:%s, LOCK:%s, CHILDREN: %j', parentPath, lockPath, children);
      if (zkUtil.lte(zkUtil.last(lockPath), children[0])) {
        // we've got the lock!!!!
        self.client.options.log.tracef('lock acquired on ${parentPath} by ${lockPath}',
            {parentPath: parentPath, lockPath: lockPath});
        self.client.locks[self.node] = lockPath;
        self.callback(null);
      } else {
        // watch the child path immediately preceeding lockPath. When it is deleted or no longer exists,
        // this process owns the lock.
        absolutePath = parentPath + '/' + self.pathBeforeMe(children, zkUtil.last(lockPath));
        self.watch(parentPath, lockPath, absolutePath, function(err) {
          if (err) {
            self.callback(err);
          } // else, a watch was set.
        });
      }
    }
  });
};


/** LockAlgorithm */
exports.LockAlgorithm = LockAlgorithm;
