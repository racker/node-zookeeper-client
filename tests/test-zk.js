var http = require('http');
var path = require('path');
var spawn = require('child_process').spawn;

var async = require('async');
var log = require('logmagic').local('test-zk');

var instruments = require('rackspace-shared-utils/lib/instruments');
var randstr = require('rackspace-shared-utils/lib/misc').randstr;
var wrapCallback = require('rackspace-shared-utils/lib/flow_control').wrapCallback;
var misc = require('rackspace-shared-utils/lib/misc');
var spawnChild = require('rackspace-shared-utils/lib/misc').spawnChild;

var spawnZookeeperElectionServer = require('./util').spawnZookeeperElectionServer;

var ZkClient = require('../lib/client').ZkClient;
var ZkPick = require('../lib/client').ZkPick;
var zkUtil = require('../lib/util');

var ZK_URL = '127.0.0.1:22181';
var BAD_ZK_URL = '127.0.0.1:22180';


exports['tearDown'] = function(test, assert) {
  zkUtil.shutdown();
  instruments.shutdown();

  test.finish();
};


exports['test_simple_connection'] = function(test, assert) {
  var zk = new ZkClient([ZK_URL]);
  zk.connect(function(err, sessionId) {
    assert.strictEqual(sessionId, zk.sessionId);
    zk.close(function() {
      test.finish();
    });
  });
};

exports['test_expected_timeout'] = function(test, assert) {
  var zk = new ZkClient([BAD_ZK_URL], {
    timeout: 20
  });
  zk.connect();
  zk.acquireLock('some_lock', randstr(10), function(err) {
    assert.ok(err);
    assert.ok(err instanceof Error);
    zk.close(function() {
      test.finish();
    });
  });
};

exports['test_close_unopened_connection'] = function(test, assert) {
  var zk = new ZkClient(['does not really matter']);
  zk.close(function() {
    test.finish();
  });
};

exports['test_two_clients_different_sessions'] = function(test, assert) {
  var zk1 = new ZkClient([ZK_URL]);
  var zk2 = new ZkClient([ZK_URL]);
  zk1.connect(function(err, sessionId1) {
    assert.ifError(err);
    zk2.connect(function(err, sessionId2) {
      assert.ifError(err);
      assert.ok(sessionId1);
      assert.ok(sessionId2);
      assert.ok(sessionId1 !== sessionId2);
      zk1.close(function() {
        zk2.close(function() {
          test.finish();
        });
      });
    });
  });
};

exports['test_already_connected'] = function(test, assert) {
  var zk = new ZkClient([ZK_URL]);
  zk.connect(function(err, sessionId) {
    assert.ifError(err);
    zk.connect(function(err, sessionId) {
      assert.ifError(err);
      zk.close(function() {
        test.finish();
      });
    });
  });
};

function lockIt(name, callback) {
  var zk = new ZkClient([ZK_URL]);
  var txn = randstr(10);
  zk.connect(function(err, sessionId) {
    zk.acquireLock(name, txn, function(err) {
      callback(err, zk);
    });
  });
}

exports['test_simple_lock'] = function(test, assert) {
  lockIt(randstr(5), function(err, zk) {
    assert.ifError(err);
    zk.close(function() {
      test.finish();
    });
  });
};

exports['test_simple_lock_with_unlock'] = function(test, assert) {
  var name = randstr(5);
  lockIt(name, function(err, zk) {
    assert.ifError(err);
    zk.unlock(name, function(err) {
      assert.ifError(err);
      zk.close(function() {
        test.finish();
      });
    });
  });
};

exports['test_cross_process_lock'] = function(test, assert) {
  var child1, child2, ts1, ts2, script = path.join(__dirname, 'zk-lock-process.js');

  child1 = spawnChild(script, ['lock1', 4000], null, 'zk-lock',
                      'started', true, true);

  child1.on('ready', function() {
    child2 = spawnChild(script, ['lock1', 2000], null, 'zk-lock',
                        'started', true, true);

    child1.on('exit', function(code) {
      ts1 = new Date().getTime();
    });

    child2.on('exit', function(code) {
      ts2 = new Date().getTime();
      assert.ok(ts1 && ts2 > ts1);
      test.finish();
    });
  });
};

exports['test_async_lock_with_unlock'] = function(test, assert) {
  var name = randstr(5);
  var txn = randstr(10);
  var zk1 = new ZkClient([ZK_URL]);
  zk1.connect(function(err, sessionId) {
    assert.ifError(err);
    zk1.acquireLock(name, txn, function(err) {
      assert.ifError(err);
      setTimeout(function() {
        zk1.unlock(name, function(err) {
          assert.ifError(err);
          zk1.close(function() {
            test.finish();
          });
        });
      }, 500);
    });
  });
};

exports['test_simple_lock_contention'] = function(test, assert) {
  var name = randstr(5);
  var txn = randstr(10);
  var zk1 = new ZkClient([ZK_URL]);
  var lockedByZk1 = false;
  zk1.connect(function(err, sessionId1) {
    assert.ifError(err);
    zk1.acquireLock(name, txn, function(err) {
      assert.ifError(err);
      lockedByZk1 = true;
      setTimeout(function() {
        zk1.unlock(name, function(err) {
          assert.ifError(err);
          lockedByZk1 = false;
        });
      }, 500);

      var zk2 = new ZkClient([ZK_URL]);
      zk2.connect(function(err, sessionId2) {
        assert.ok(sessionId1 != sessionId2);
        assert.ok(sessionId2);
        assert.ok(lockedByZk1);
        zk2.acquireLock(name, txn, function(err) {
          assert.ok(!lockedByZk1);
          assert.ifError(err);
          zk2.unlock(name, function(err) {
            assert.ifError(err);
            zk2.close(function() {
              zk1.close(function() {
                test.finish();
              });
            });
          });
        });
      });
    });
  });
};

exports['test_concurrent_locks_with_one_client'] = function(test, assert) {
  var locka = randstr(5);
  var lockb = randstr(6);
  var txn = randstr(10);
  var zk = new ZkClient([ZK_URL]);
  zk.connect(function(err, sessionId) {
    assert.ifError(err);
    zk.acquireLock(locka, txn, function(err) {
      assert.ifError(err);
      zk.acquireLock(lockb, txn, function(err) {
        assert.ifError(err);
        zk.unlock(locka, function(err) {
          assert.ifError(err);
          zk.unlock(lockb, function(err) {
            assert.ifError(err);
            zk.close(function() {
              test.finish();
            });
          });
        });
      });
    });
  });
};

exports['test_same_client_acquires_lock_twice_with_unlock'] = function(test, assert) {
  var lock = randstr(5);
  var txn = randstr(10);
  var zk = new ZkClient([ZK_URL]);
  var tsAcquiredLock1, tsAcquiredLock2;

  async.series([
    function connect(callback) {
      zk.connect(function(err, sessionId) {
        callback(err);
      });
    },

    function acuireLockWithTheSameName(callback) {
      async.parallel([
        function one(callback) {
          zk.acquireLock(lock, txn, function(err) {
            tsAcquiredLock1 = new Date().getTime();
            setTimeout(function() {
              zk.unlock(lock, callback);
            }, 500);
          });
        },

        function two(callback) {
          zk.acquireLock(lock, txn, function(err) {
            tsAcquiredLock2 = new Date().getTime();
            assert.ok((tsAcquiredLock2 - tsAcquiredLock1) >= 500);
            zk.unlock(lock, callback);
          });
        }
      ], callback);
    }
  ],

  function(err) {
    assert.ifError(err);
    zk.close(test.finish);
  });
};

exports['test_close_unlocks_so_others_can_lock'] = function(test, assert) {
  var lock = randstr(5);
  var txn = randstr(10);
  var zk1 = new ZkClient([ZK_URL]);
  zk1.connect(function(err, sessionId) {
    assert.ifError(err);
    zk1.acquireLock(lock, txn, function(err) {
      assert.ifError(err);
      zk1.close(function(err) {
        assert.ifError(err);

        // at this point, the lock should have been implicitly released.
        // note how it was never unlock()ed.
        var zk2 = new ZkClient([ZK_URL]);
        zk2.connect(function(err, sessionId) {
          assert.ifError(err);
          zk2.acquireLock(lock, txn, function(err) {
            assert.ifError(err);
            zk2.close(function() {
              test.finish();
            });
          });
        });
      });
    });
  });
};

exports['test_default_log_override'] = function(test, assert) {
  var testLogName = randstr(5);
  var testLog = require('logmagic').local(testLogName);
  var zk = new ZkClient([ZK_URL], { log: testLog});
  assert.strictEqual(testLogName, zk.options.log.modulename);
  assert.ok('ele.zk' !== zk.options.log.modulename);
  test.finish();
};

exports['test_reaping_with_single_client_reacquire'] = function(test, assert) {
  var name = randstr(5);
  var txn = randstr(10);
  var zk = new ZkClient([ZK_URL]);
  zk.connect(function(err, sessionId) {
    zk.acquireLock(name, txn, function(err) {
      assert.ifError(err);

      // go away for 1 second, then reap.
      setTimeout(function() {
        var pick = new ZkPick([ZK_URL]);
        pick.release(100, name, function(err, count) {
          assert.ifError(err);
          assert.strictEqual(count, 1);

          // should be able to reacquire lock.
          zk.acquireLock(name, txn, function(err) {
            assert.ifError(err);
            zk.close(function() {
              test.finish();
            });
          });
        });
      }, 1500);
    });
  });
};

exports['test_reaping_with_double_client_reacquire'] = function(test, assert) {
  var name = randstr(5);
  var txn = randstr(10);
  var zk = new ZkClient([ZK_URL]);
  var zk2 = new ZkClient([ZK_URL]);
  zk.connect(function(err, sessionId1) {
    zk.acquireLock(name, txn, function(err) {
      assert.ifError(err);

      // go away for 1 second, then reap.
      setTimeout(function() {
        var pick = new ZkPick([ZK_URL]);
        pick.release(100, name, function(err, count) {
          assert.ifError(err);
          assert.strictEqual(count, 1);

          // should be able to reacquire lock.
          zk2.connect(function(err, sessionId2) {
            assert.ifError(err);
            assert.ok(sessionId1 !== sessionId2);
            zk2.acquireLock(name, txn, function(err) {
              assert.ifError(err);
              zk2.close(function() {
                zk.close(function() {
                  test.finish();
                });
              });
            });
          });
        });
      }, 1500);
    });
  });
};

exports['test_no_reaping_before_right_time'] = function(test, assert) {
  var name = randstr(5);
  var txn = randstr(10);
  var zk = new ZkClient([ZK_URL]);
  zk.connect(function(err, sessionId) {
    zk.acquireLock(name, txn, function(err) {
      assert.ifError(err);

      // go away for 1 second, then reap.
      setTimeout(function() {
        var pick = new ZkPick([ZK_URL]);
        // reap any locks older than 15s. of course, there shouldn't be any.
        pick.release(15000, name, function(err, count) {
          assert.ifError(err);
          assert.strictEqual(count, 0);
          zk.close(function() {
            test.finish();
          });
        });
      }, 1000);
    });
  });
};

exports['test_election'] = function(test, assert) {
  var server;

  function killAllNodes(nodes) {
    nodes.forEach(function(node) {
      node.kill('SIGKILL');
    });
  }

  function getState(node, callback) {
    var options = {
      host: 'localhost',
      port: node.__port,
      path: '/',
      method: 'GET'
    };

    var req = http.request(options, function(res) {
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(d) {
        data += d;
      });
      res.on('end', function() {
        callback(null, JSON.parse(data));
      });
    });
    req.end();

    req.on('error', function(err) {
      callback(err);
    });
  }

  // spawn and wait ready signal from children
  function init(count, callback) {
    var nodes = [], firstPort = (misc.getRandomInt(60000, 65534) - count);
    for (i = 0; i < count; i++) {
      nodes.push(spawnZookeeperElectionServer(firstPort++));
    }
    async.forEach(nodes, function(node, callback) {
      node.on('ready', callback);
    }, function(err) {
      callback(err, nodes);
    });
  }

  function getAllState(nodes, callback) {
    async.map(nodes, getState, callback);
  }

  function indexOfMaster(states) {
    var i;
    for (i = 0; i < states.length; i++) {
      if (states[i].master) {
        return i;
      }
    }
    return -1;
  }

  async.waterfall([
    function(callback) {
      init(5, callback);
    },

    function(nodes, callback) {
      getAllState(nodes, function(err, states) {
        callback(err, nodes, states);
      });
    },

    // make sure the master is at the index we expect
    function(nodes, states, callback) {
      var masterIndex = indexOfMaster(states);
      getState(nodes[masterIndex], function(err, state) {
        assert.ifError(err);
        assert.ok(state.master === states[masterIndex].master);
        callback(err, nodes, states);
      });
    },

    // kill master
    function(nodes, states, callback) {
      var masterIndex = indexOfMaster(states);
      nodes[masterIndex].kill();
      nodes.splice(masterIndex, 1);
      callback(null, nodes);
    },

    // check for new master
    function(nodes, callback) {
      setTimeout(function() {
        getAllState(nodes, function(err, states) {
          // check for new master
          assert.ifError(err);
          assert.ok(indexOfMaster(states) >= 0);
          killAllNodes(nodes);
          callback();
        });
      }, 12000);
    }

  ], function(err) {
    assert.ifError(err);
    test.finish();
  });
};

exports['test_create_no_slash_in_path'] = function(test, assert) {
  var zk = new ZkClient([ZK_URL]);
  zk.connect();

  try {
    zk.create('INVALID_PATH', 'ponies', 0, function(err, stat) {
    });
  }
  catch (err) {
    zk.close(test.finish);
    return;
  }

  assert.fail('Invalid path provided, but exception was not thrown');
};

exports['test_createPaths'] = function(test, assert) {
  var pathToCreate = '/foo/bar/ponies/lulz',
      zk = new ZkClient([ZK_URL]);

  async.waterfall([
    zk.connect.bind(zk),

    function createPaths(_, callback) {
      zk.createPaths(pathToCreate, 'ponies', 0, callback);
    },

    function assertPathComponentsExist(createdPath, callback) {
      var components = ['/foo', '/foo/bar', '/foo/bar/ponies'];

      async.forEach(components, function(component, callback) {
        zk._exists(component, false, function(err, exists) {
          assert.ifError(err);
          assert.ok(exists);
          callback(err);
        });
      },

      function(err) {
        callback(err, createdPath);
      });
    },

    function assertFullPathExists(createdPath, callback) {
      assert.equal(createdPath, pathToCreate);
      zk._exists(pathToCreate, false, function(err, exists) {
        assert.ifError(err);
        assert.ok(exists);
        callback();
      });
    }
  ],

  function(err) {
    assert.ifError(err);
    zk.close(test.finish);
  });
};
